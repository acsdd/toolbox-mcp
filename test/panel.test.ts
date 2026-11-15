import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { startPanel } from '../dist/panel.js'
import { createServices } from '../dist/services.js'

let home = ''
let services: ReturnType<typeof createServices>
let panel: { port: number; close: () => void }

interface Reply {
  status: number
  headers: Record<string, unknown>
  body: string
}

function ask(options: {
  path?: string
  method?: string
  headers?: Record<string, string>
  body?: string
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: panel.port,
        path: options.path ?? '/',
        method: options.method ?? 'GET',
        headers: options.headers
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          body += chunk
        })
        res.on('end', () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body })
        })
      }
    )
    req.on('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-panel-'))
  process.env.TOOLBOX_MCP_HOME = home
  services = createServices({
    fetchImpl: async () => new Response(JSON.stringify([]), { status: 200 })
  })
  await services.init()
  panel = await startPanel(services, { port: 0 })
})

after(async () => {
  panel.close()
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

describe('panel security headers', () => {
  it('serves the page with a strict content security policy', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    const csp = String(reply.headers['content-security-policy'] ?? '')
    assert.match(csp, /default-src 'none'/)
    assert.equal(reply.headers['x-content-type-options'], 'nosniff')
    assert.equal(reply.headers['x-frame-options'], 'DENY')
    assert.equal(reply.headers['referrer-policy'], 'no-referrer')
  })

  it('does not load anything from the network', async () => {
    const reply = await ask({ path: '/' })
    assert.doesNotMatch(reply.body, /fonts\.googleapis|https?:\/\/[^"']*\.(js|css)/i)
  })
})

describe('panel origin checks', () => {
  it('refuses a request with a foreign host header', async () => {
    const reply = await ask({ path: '/api/overview', headers: { Host: 'attacker.example.com' } })
    assert.equal(reply.status, 403)
  })

  it('refuses a request with a foreign origin', async () => {
    const reply = await ask({ path: '/api/overview', headers: { Origin: 'https://evil.example.com' } })
    assert.equal(reply.status, 403)
  })

  it('accepts the panel origin', async () => {
    const reply = await ask({
      path: '/api/overview',
      headers: { Origin: `http://127.0.0.1:${panel.port}` }
    })
    assert.equal(reply.status, 200)
  })
})

describe('panel body handling', () => {
  it('answers 400 for malformed JSON', async () => {
    const reply = await ask({
      path: '/api/settings/watchlist',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json'
    })
    assert.equal(reply.status, 400)
    assert.match(reply.body, /invalid json/i)
  })

  it('answers 413 for an oversized body', async () => {
    const reply = await ask({
      path: '/api/settings/watchlist',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchlist: ['bitcoin'], padding: 'x'.repeat(1_200_000) })
    })
    assert.equal(reply.status, 413)
  })
})

describe('panel settings editing', () => {
  it('reads the current settings', async () => {
    const reply = await ask({ path: '/api/settings' })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { watchlist: string[]; diskPath: string; showProcesses: boolean }
    assert.ok(Array.isArray(data.watchlist))
    assert.equal(typeof data.diskPath, 'string')
    assert.equal(typeof data.showProcesses, 'boolean')
  })

  it('stores a new watchlist', async () => {
    const reply = await ask({
      path: '/api/settings/watchlist',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchlist: ['bitcoin', 'ethereum'] })
    })
    assert.equal(reply.status, 200)
    assert.deepEqual(services.crypto.watchlist, ['bitcoin', 'ethereum'])
  })

  it('rejects an empty watchlist with 400', async () => {
    const reply = await ask({
      path: '/api/settings/watchlist',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchlist: [] })
    })
    assert.equal(reply.status, 400)
  })

  it('stores the resource monitor preferences', async () => {
    const reply = await ask({
      path: '/api/settings/resource',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diskPath: '  ', showProcesses: false })
    })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { diskPath: string; showProcesses: boolean }
    assert.equal(data.diskPath, '')
    assert.equal(data.showProcesses, false)
    assert.deepEqual(await services.resourceProcesses(), [])
  })
})
