import assert from 'node:assert/strict'
import http, { request as httpRequest } from 'node:http'
import { syncBuiltinESMExports } from 'node:module'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it, mock } from 'node:test'
import { clientLaunch, startPanel } from '../dist/panel.js'
import { createServices } from '../dist/services.js'
import type { Terminal } from '../dist/terminal.js'

let home = ''
let services: ReturnType<typeof createServices>
let panel: { port: number; close: () => Promise<void> }

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
  port?: number
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port ?? panel.port,
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

/** A stand-in shell session: it records what the panel asked of it. */
function fakeTerminal(overrides: Partial<Terminal> = {}): { terminal: Terminal; completions: { line: string; cursor: number }[]; inputs: string[] } {
  const completions: { line: string; cursor: number }[] = []
  const inputs: string[] = []
  const terminal: Terminal = {
    start: () => ({ running: true, pid: 4242, startedAt: 0 }),
    stop: () => ({ running: false, pid: null, startedAt: null }),
    close: async () => {},
    state: () => ({ running: false, pid: null, startedAt: null }),
    input: (data: string) => {
      inputs.push(data)
      return { running: false, pid: null, startedAt: null }
    },
    complete: async (line: string, cursor: number) => {
      completions.push({ line, cursor })
      return { supported: true, candidates: ['Get-ChildItem', 'Get-ChildItemProperty'], replacementIndex: 0, replacementLength: 7 }
    },
    subscribe: () => () => {},
    snapshot: () => '',
    ...overrides
  }
  return { terminal, completions, inputs }
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
  await panel.close()
  await services.close()
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

describe('panel widget-host pattern', () => {
  it('injects the shared portable pattern CSS', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    assert.match(reply.body, /--wh-rail-width/)
    assert.match(reply.body, /\.mode-full > \.player-page/)
  })

  it('puts the primary navigation on the left of the stage', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    // The nav rail takes the fixed first column; the stage the flexible one.
    assert.match(reply.body, /grid-template: 62px 1fr \/ 232px minmax\(0, 1fr\)/)
    assert.match(reply.body, /\.sidebar \{ grid-row: 2; grid-column: 1;[^}]*border-right/)
    // The glued stage is the shared host-screen, keeping panel spacing.
    assert.match(reply.body, /<main class="host-screen">/)
    assert.match(reply.body, /main\.host-screen \{ padding: 28px 30px 48px; \}/)
    // Active nav accent sits on the rail's inner (left) edge.
    assert.match(reply.body, /inset 2px 0 0 var\(--accent\)/)
    // The stage takes the second column, and on narrow screens the rail
    // folds into a strip above it instead of disappearing.
    assert.match(reply.body, /main \{ grid-column: 2; grid-row: 2;/)
    const narrow = reply.body.slice(reply.body.indexOf('@media (max-width: 860px)'))
    assert.match(narrow, /\.sidebar \{[^}]*flex-direction: row/)
    assert.match(narrow, /\.sidebar nav \{ flex-direction: row;/)
    assert.match(narrow, /main \{ grid-column: 1; grid-row: 3; \}/)
    assert.doesNotMatch(narrow, /\.sidebar \{ display: none/)
  })
})

describe('panel accessibility', () => {
  it('marks the rail as navigation and the active section as current', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    assert.match(reply.body, /<nav aria-label="Panel sections">/)
    assert.match(reply.body, /data-nav="overview" aria-current="page"/)
    // Rail glyphs and ordering numbers are decoration, not names.
    assert.match(reply.body, /data-nav="models"><i aria-hidden="true">/)
    assert.match(reply.body, /<small aria-hidden="true">02<\/small>/)
    // Switching sections keeps aria-current in step with the accent state.
    assert.match(reply.body, /if \(active\) b\.setAttribute\('aria-current', 'page'\)/)
    // The new section's heading takes focus so a screen reader announces it.
    assert.match(reply.body, /heading\.focus\(\{ preventScroll: true \}\)/)
    // Links get the same visible ring as controls; the browser default is
    // near-black and disappears against the dark panel.
    assert.match(reply.body, /a:focus-visible \{ outline: 2px solid var\(--accent\); outline-offset: 3px; \}/)
  })

  it('keeps a visible keyboard focus ring on the terminal prompt', async () => {
    const reply = await ask({ path: '/' })
    assert.doesNotMatch(reply.body, /\.term-line input:focus \{[^}]*outline:\s*none/)
    assert.match(reply.body, /\.term-line input:focus-visible \{[^}]*outline:\s*2px solid var\(--accent\);[^}]*outline-offset:\s*3px/)
  })

  it('labels search fields and keeps toggle state on the scenario buttons', async () => {
    const reply = await ask({ path: '/' })
    assert.match(reply.body, /id="ov-tool-search" aria-label="Search MCP tools"/)
    assert.match(reply.body, /id="f-search" aria-label="Search models"/)
    assert.match(reply.body, /id="term-in"[^>]*aria-label="Terminal command"/)
    assert.match(reply.body, /id="sc-now" class="on" aria-pressed="true"/)
    assert.match(reply.body, /id="sc-total" aria-pressed="false"/)
    assert.match(reply.body, /b\.setAttribute\('aria-pressed', String\(on\)\)/)
  })

  it('names the tool-group filter and exposes which chip is picked', async () => {
    const reply = await ask({ path: '/' })
    assert.match(reply.body, /id="ov-groups" role="group" aria-label="Filter tools by group"/)
    // The picked chip carries aria-pressed so the state is not colour-only.
    assert.match(reply.body, /class="grp-chip' \+ \(ov\.group === '' \? ' on' : ''\) \+ '" aria-pressed="' \+ \(ov\.group === '' \? 'true' : 'false'\)/)
    assert.match(reply.body, /class="grp-chip' \+ \(ov\.group === g\.id \? ' on' : ''\) \+ '" aria-pressed="' \+ \(ov\.group === g\.id \? 'true' : 'false'\)/)
    // Chip glyphs are decoration; the accessible name is the group label.
    assert.match(reply.body, /<span aria-hidden="true">' \+ esc\(g\.icon\) \+ '<\/span> /)
    // The match count is announced as the filter changes.
    assert.match(reply.body, /id="ov-tool-count" aria-live="polite"/)
  })

  it('labels the remaining fields and gives the tool filter a working clear control', async () => {
    const reply = await ask({ path: '/' })
    // The button next to the search now resets instead of re-running the filter.
    assert.match(reply.body, /onclick="ovClearFilter\(\)">Clear<\/button>/)
    assert.match(reply.body, /function ovClearFilter\(\)/)
    assert.match(reply.body, /id="mp-search" aria-label="Search modules"/)
    assert.match(reply.body, /id="set-watchlist" type="text" spellcheck="false" aria-label="Crypto watchlist coin ids"/)
    assert.match(reply.body, /id="set-diskpath" type="text" spellcheck="false" aria-label="Disk path for the resource monitor"/)
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

  for (const origin of ['http://127.0.0.1:9999', 'http://localhost:9999', 'null']) {
    it(`refuses mutation from origin ${origin}`, async () => {
      const before = [...services.crypto.watchlist]
      const reply = await ask({ path: '/api/settings/watchlist', method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'text/plain' }, body: JSON.stringify({ watchlist: ['solana'] }) })
      assert.equal(reply.status, 403)
      assert.deepEqual(services.crypto.watchlist, before)
    })
  }

  it('rejects a browser cross-site request even without Origin', async () => {
    const reply = await ask({ path: '/api/terminal/stop', method: 'POST', headers: { 'Sec-Fetch-Site': 'cross-site' } })
    assert.equal(reply.status, 403)
  })

  it('rejects a same-site request from a different application', async () => {
    const reply = await ask({ path: '/api/terminal/stop', method: 'POST', headers: { 'Sec-Fetch-Site': 'same-site' } })
    assert.equal(reply.status, 403)
  })

  it('accepts same-origin JSON writes and bodyless local CLI requests', async () => {
    const reply = await ask({ path: '/api/settings/resource', method: 'POST',
      headers: { Origin: `http://127.0.0.1:${panel.port}`, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ showProcesses: false }) })
    assert.equal(reply.status, 200)
    assert.equal((await ask({ path: '/api/terminal/stop', method: 'POST' })).status, 200)
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
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', '']) {
    it(`rejects a JSON mutation disguised as ${contentType || 'no content type'}`, async () => {
      const before = [...services.crypto.watchlist]
      const reply = await ask({ path: '/api/settings/watchlist', method: 'POST',
        headers: contentType ? { 'Content-Type': contentType } : {}, body: JSON.stringify({ watchlist: ['solana'] }) })
      assert.equal(reply.status, 415)
      assert.deepEqual(services.crypto.watchlist, before)
    })
  }

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

describe('panel shutdown', () => {
  it('aggregates listener and terminal cleanup failures', async (t) => {
    const realCreateServer = http.createServer
    const createServerMock = mock.method(http, 'createServer', ((...args: unknown[]) => {
      const server = Reflect.apply(realCreateServer, http, args) as http.Server
      const close = server.close.bind(server)
      server.close = ((callback?: (error?: Error) => void) => {
        close(() => callback?.(new Error('listener cleanup failed')))
        return server
      }) as http.Server['close']
      return server
    }) as never)
    syncBuiltinESMExports()
    t.after(() => {
      createServerMock.mock.restore()
      syncBuiltinESMExports()
    })
    const fake = fakeTerminal({ close: async () => { throw new Error('terminal cleanup failed') } })
    const scoped = await startPanel(services, { port: 0, terminal: fake.terminal })

    await assert.rejects(() => scoped.close(), (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.equal(error.errors.length, 2)
      const messages = error.errors.map((cause) => String(cause))
      assert.ok(messages.some((message) => message.includes('listener cleanup failed')))
      assert.ok(messages.some((message) => message.includes('terminal cleanup failed')))
      return true
    })
  })

  it('close is shared, waits for terminal cleanup, and releases its listener', async () => {
    let release: () => void = () => {}
    const terminalClosed = new Promise<void>((resolve) => { release = resolve })
    const fake = fakeTerminal({ close: () => terminalClosed })
    const scoped = await startPanel(services, { port: 0, terminal: fake.terminal })

    const first = scoped.close()
    const second = scoped.close()
    assert.ok(first instanceof Promise)
    assert.equal(first, second)

    let closed = false
    void first.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'panel close must await the owned terminal')

    release()
    await first
    const rebound = await startPanel(services, { port: scoped.port })
    await rebound.close()
  })

  it('unsubscribes the terminal event stream when the panel closes', async () => {
    let unsubscribed = 0
    const fake = fakeTerminal({ subscribe: () => () => { unsubscribed += 1 } })
    const scoped = await startPanel(services, { port: 0, terminal: fake.terminal })
    let ready: () => void = () => {}
    const responseReady = new Promise<void>((resolve) => { ready = resolve })
    const responseClosed = new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: scoped.port, path: '/api/terminal/events', method: 'GET' },
        (res) => {
          res.on('data', () => {})
          res.once('close', resolve)
          res.once('error', reject)
          res.once('data', ready)
        }
      )
      req.on('error', reject)
      req.end()
    })

    await responseReady
    const closing = scoped.close()
    await responseClosed
    await closing
    assert.equal(unsubscribed, 1)
  })

  it('cleans up its terminal before rejecting a listener startup failure', async () => {
    let release: () => void = () => {}
    const terminalClosed = new Promise<void>((resolve) => { release = resolve })
    const fake = fakeTerminal({ close: () => terminalClosed })
    let settled = false
    const outcome = startPanel(services, { port: -1, terminal: fake.terminal }).then(
      () => null,
      (cause: unknown) => {
        settled = true
        return cause
      }
    )

    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeCleanup = settled
    release()
    const cause = await outcome

    assert.equal(settledBeforeCleanup, false, 'startup failure must wait for owned cleanup')
    assert.ok(cause instanceof Error)
    assert.match(cause.message, /port|range/i)
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

describe('panel tool catalog', () => {
  it('publishes the tool surface the MCP server registers', async () => {
    const reply = await ask({ path: '/api/catalog' })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as {
      server: { name: string; version: string; transport: string; panel: string; repo: string }
      groups: { id: string; label: string; icon: string; hint: string }[]
      tools: { name: string; group: string; description: string; params: { name: string; required: boolean }[]; annotations?: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }[]
    }
    assert.equal(data.server.name, 'toolbox-mcp')
    assert.match(data.server.version, /^\d+\.\d+\.\d+/)
    assert.equal(data.server.transport, 'stdio')
    assert.match(data.server.panel, /http:\/\/127\.0\.0\.1:\d+/)
    assert.match(data.server.repo, /github\.com/)
    assert.ok(data.tools.length >= 20)
    // Every tool belongs to a group the panel knows how to label.
    const groupIds = data.groups.map((group) => group.id)
    for (const tool of data.tools) {
      assert.ok(groupIds.includes(tool.group), `${tool.name} has an unknown group`)
      assert.ok(tool.description.length > 0)
    }
    // The catalog and the registered server must agree.
    const { TOOL_CATALOG } = await import('../dist/catalog.js')
    assert.deepEqual(
      data.tools.map((tool) => tool.name).sort(),
      TOOL_CATALOG.map((tool) => tool.name).sort()
    )
    const system = data.tools.find((tool) => tool.name === 'system_stats')
    assert.deepEqual(system?.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false })
  })

  it('serves the deterministic tool contract for local diagnostics', async () => {
    const reply = await ask({ path: '/api/tool-contract' })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { schemaVersion: number; service: string; tools: { name: string }[] }
    assert.equal(data.schemaVersion, 1)
    assert.equal(data.service, 'toolbox-mcp')
    const { TOOL_CATALOG } = await import('../dist/catalog.js')
    assert.deepEqual(data.tools.map((tool) => tool.name).sort(), TOOL_CATALOG.map((tool) => tool.name).sort())
  })

  it('adds connected remote tools with their real names and parameters, then removes them', async () => {
    const registry = {
      format: 'toolbox-marketplace',
      formatVersion: 1,
      updated: '2026-11-24T00:00:00.000Z',
      modules: [{
        id: 'cve-now', type: 'remote-server', name: 'cve.now', description: 'Vulnerability feed',
        version: '1.0.0', author: 'Sazabi', categories: ['security'], tags: ['cve'],
        homepage: 'https://example.com', endpoint: 'https://mcp.cve.now/mcp'
      }]
    }
    const remoteServices = createServices({
      fetchImpl: async (url) => Response.json(String(url).includes('/registry.json') ? registry : []),
      remoteConnect: async (endpoint) => {
        assert.equal(endpoint, 'https://mcp.cve.now/mcp')
        return {
          listTools: async () => [{
            name: 'list_feed', description: 'Newest vulnerabilities',
            inputSchema: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Feed name' },
                limit: { type: 'integer', description: 'Maximum results' }
              },
              required: ['name']
            }
          }],
          callTool: async () => ({ content: [{ type: 'text', text: 'unused' }] }),
          close: async () => {}
        }
      }
    })
    await remoteServices.init()
    const remotePanel = await startPanel(remoteServices, { port: 0 })
    const catalog = async () => {
      const reply = await ask({ path: '/api/catalog', port: remotePanel.port })
      assert.equal(reply.status, 200)
      return JSON.parse(reply.body).tools as Array<{
        name: string; group: string; description: string
        params: Array<{ name: string; type: string; required: boolean; description: string }>
        annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }
      }>
    }
    try {
      assert.equal((await catalog()).some((tool) => tool.name === 'cve_now_list_feed'), false)
      await remoteServices.marketplaceInstall('cve-now')
      const remote = (await catalog()).find((tool) => tool.name === 'cve_now_list_feed')
      assert.deepEqual(remote, {
        name: 'cve_now_list_feed',
        group: 'remote',
        description: '[cve.now] Newest vulnerabilities',
        params: [
          { name: 'name', type: 'string', required: true, description: 'Feed name' },
          { name: 'limit', type: 'integer', required: false, description: 'Maximum results' }
        ],
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      })
      await remoteServices.marketplaceUninstall('cve-now')
      assert.equal((await catalog()).some((tool) => tool.name === 'cve_now_list_feed'), false)
    } finally {
      await remotePanel.close()
      await remoteServices.marketplaceUninstall('cve-now').catch(() => {})
      await remoteServices.close()
    }
  })

  it('describes the parameters of a tool that takes some', async () => {
    const reply = await ask({ path: '/api/catalog' })
    const data = JSON.parse(reply.body) as {
      tools: { name: string; params: { name: string; type: string; required: boolean; description: string }[] }[]
    }
    const score = data.tools.find((tool) => tool.name === 'llamafarm_score')
    assert.ok(score)
    const names = score.params.map((param) => param.name)
    assert.deepEqual(names.sort(), ['maxParams', 'minParams', 'onlyReachable', 'scenario', 'search'])
    assert.equal(score.params.find((param) => param.name === 'scenario')?.required, true)
    assert.equal(score.params.find((param) => param.name === 'search')?.required, false)
  })

  it('reports an unattached activity recorder when no server feeds it', async () => {
    const reply = await ask({ path: '/api/activity' })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as {
      attached: boolean
      calls: unknown[]
      total: number
      failed: number
      perTool: unknown[]
    }
    assert.equal(data.attached, false)
    assert.equal(data.total, 0)
    assert.deepEqual(data.calls, [])
  })
})

describe('panel error sanitization', () => {
  it('does not leak internal error messages from generic panel faults', async () => {
    const broken = { ...services, resourceStats: async () => { throw new Error('secret internal path D:/private') } }
    const scoped = await startPanel(broken as typeof services, { port: 0 })
    try {
      const reply = await ask({ port: scoped.port, path: '/api/overview' })
      assert.equal(reply.status, 500)
      const data = JSON.parse(reply.body) as { error: string }
      assert.equal(data.error, 'Internal panel error.')
      assert.equal(reply.body.includes('secret internal path'), false)
      assert.equal(reply.body.includes('D:/private'), false)
    } finally {
      await scoped.close()
    }
  })
})

describe('panel activity recorder', () => {
  it('records the tool calls an attached server reports', async () => {
    const { createActivity } = await import('../dist/activity.js')
    const activity = createActivity(true)
    activity.record('crypto_status', true, 12)
    activity.record('llamafarm_score', false, 340, 'catalog unavailable')
    const attached = await startPanel(services, { port: 0, activity })
    try {
      const body = await new Promise<string>((resolve, reject) => {
        const req = httpRequest(
          { host: '127.0.0.1', port: attached.port, path: '/api/activity', method: 'GET' },
          (res) => {
            let text = ''
            res.setEncoding('utf8')
            res.on('data', (chunk: string) => { text += chunk })
            res.on('end', () => resolve(text))
          }
        )
        req.on('error', reject)
        req.end()
      })
      const data = JSON.parse(body) as {
        attached: boolean
        total: number
        failed: number
        calls: { tool: string; ok: boolean; ms: number; error: string | null }[]
        perTool: { tool: string; calls: number; failed: number }[]
      }
      assert.equal(data.attached, true)
      assert.equal(data.total, 2)
      assert.equal(data.failed, 1)
      assert.equal(data.calls[0].tool, 'llamafarm_score')
      assert.equal(data.calls[0].ok, false)
      assert.equal(data.calls[0].error, 'catalog unavailable')
      assert.deepEqual(data.calls[1].tool, 'crypto_status')
      assert.deepEqual(data.perTool.map((tool) => tool.tool).sort(), ['crypto_status', 'llamafarm_score'])
    } finally {
      await attached.close()
    }
  })

  it('reports lifetime totals beyond the ring buffer and bounds error text', async () => {
    const { createActivity } = await import('../dist/activity.js')
    const activity = createActivity(true)
    for (let i = 0; i < 70; i += 1) activity.record('system_stats', true, 1)
    activity.record('gmail_check', false, 2, 'Bearer secret-token-value ' + 'x'.repeat(400))
    const snapshot = activity.snapshot()
    assert.equal(snapshot.total, 71)
    assert.equal(snapshot.failed, 1)
    assert.equal(snapshot.recent, 60)
    const failed = snapshot.calls.find((call) => !call.ok)
    assert.ok(failed)
    assert.ok(failed.error!.length <= 201)
    assert.equal(failed.error!.includes('secret-token-value'), false)
    assert.equal(failed.error!.includes('Bearer [redacted]'), true)
  })
})

describe('panel terminal completion route', () => {
  it('returns bounded shell completion candidates without executing the typed command', async () => {
    const fake = fakeTerminal()
    const scoped = await startPanel(services, { port: 0, terminal: fake.terminal })
    try {
      const reply = await ask({ port: scoped.port, path: '/api/terminal/complete', method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'Get-Chi', cursor: 7 }) })
      assert.equal(reply.status, 200)
      const data = JSON.parse(reply.body) as { supported: boolean; candidates: string[]; replacementIndex: number; replacementLength: number }
      assert.equal(data.supported, true)
      assert.deepEqual(data.candidates, ['Get-ChildItem', 'Get-ChildItemProperty'])
      assert.equal(data.replacementIndex, 0)
      assert.equal(data.replacementLength, 7)
      // The completion request is a question about the line, never a command
      // to run: the shell must not receive the typed text as input.
      assert.deepEqual(fake.completions, [{ line: 'Get-Chi', cursor: 7 }])
      assert.deepEqual(fake.inputs, [], 'the typed command must not be executed')
    } finally {
      await scoped.close()
    }
  })

  it('reports completion as unsupported when the host shell cannot complete', async () => {
    const fake = fakeTerminal({
      complete: async () => ({ supported: false, candidates: [], replacementIndex: 0, replacementLength: 0 })
    })
    const scoped = await startPanel(services, { port: 0, terminal: fake.terminal })
    try {
      const reply = await ask({ port: scoped.port, path: '/api/terminal/complete', method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ line: 'Get-Chi', cursor: 7 }) })
      assert.equal(reply.status, 200)
      const data = JSON.parse(reply.body) as { supported: boolean; candidates: string[] }
      assert.equal(data.supported, false)
      assert.deepEqual(data.candidates, [])
    } finally {
      await scoped.close()
    }
  })
})

describe('panel model farm feature routes', () => {
  it('honors the explicit runtime on a removal request', async () => {
    const reply = await ask({ path: '/api/llamafarm/remove', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'anything', runtime: 'lmstudio' }) })
    assert.equal(reply.status, 200)
    assert.equal(JSON.parse(reply.body).reason, 'unsupported-runtime')
  })
  it('publishes the five new farm tools in the catalog', async () => {
    const reply = await ask({ path: '/api/catalog' })
    const data = JSON.parse(reply.body) as { tools: { name: string }[] }
    const names = data.tools.map((tool) => tool.name)
    for (const expected of [
      'llamafarm_search',
      'llamafarm_quants',
      'llamafarm_remove',
      'llamafarm_run_now',
      'llamafarm_progress'
    ]) {
      assert.ok(names.includes(expected), `${expected} missing from catalog`)
    }
  })

  it('searches HuggingFace through /api/llamafarm/search', async () => {
    const reply = await ask({
      path: '/api/llamafarm/search',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'qwen', scenario: 'now' })
    })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { query: string; total: number; groups: unknown[] }
    assert.equal(data.query, 'qwen')
    assert.equal(typeof data.total, 'number')
    assert.ok(Array.isArray(data.groups))
  })

  it('lists quantizations through /api/llamafarm/quants', async () => {
    const reply = await ask({
      path: '/api/llamafarm/quants',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo: 'acme/model-GGUF' })
    })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { repo: string; quants: unknown[]; error: string | null }
    assert.equal(data.repo, 'acme/model-GGUF')
    assert.ok(Array.isArray(data.quants))
    assert.equal(data.error, null)
  })

  it('reports not-found when removing an uninstalled model', async () => {
    const reply = await ask({
      path: '/api/llamafarm/remove',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'no-such-model' })
    })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { ok: boolean; reason: string }
    assert.equal(data.ok, false)
    assert.equal(data.reason, 'not-found')
  })

  it('serves run-now picks through /api/llamafarm/run-now', async () => {
    const reply = await ask({ path: '/api/llamafarm/run-now' })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { scenario: string; picks: unknown[] }
    assert.equal(data.scenario, 'now')
    assert.ok(Array.isArray(data.picks))
  })

  it('serves download progress through /api/llamafarm/progress', async () => {
    const reply = await ask({ path: '/api/llamafarm/progress' })
    assert.equal(reply.status, 200)
    const data = JSON.parse(reply.body) as { downloads: unknown[] }
    assert.deepEqual(data.downloads, [])
  })
})

describe('panel model farm feature UI', () => {
  it('provides inline purpose filters and visible horizontal list navigation', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    for (const hook of [
      'id="mf-purpose-filters"',
      'mfSetTaskFilter',
      'id="mf-list-position"',
      'mfScrollColumns(-1)',
      'mfScrollColumns(1)',
      'aria-label="Model purpose lists"'
    ]) {
      assert.ok(reply.body.includes(hook), `page missing ${hook}`)
    }
  })

  it('scales panel text by ten percent and keeps purpose colors text-only', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    assert.match(reply.body, /html\s*\{[^}]*font-size:\s*110%/)
    assert.match(reply.body, /\.mf-col h3\s*\{[^}]*font-weight:\s*600/)
    assert.match(reply.body, /\.mf-purpose-[a-z-]+\s*\{\s*color:/)
    assert.doesNotMatch(reply.body, /\.mf-purpose-(?:coding|art|edit|speech|transcribe|video|understand|multimodal)\s*\{[^}]*background:/)
  })

  it('wires search, run-now, remove, quants and progress into the page', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    for (const hook of [
      'mfSearch',
      'mfRunNow',
      'mfRemove',
      'mfQuants',
      'id="mf-runnow"',
      'id="mf-progress"',
      'Search HuggingFace',
      'Run now',
      'Tab to complete',
      '/api/terminal/complete'
    ]) {
      assert.ok(reply.body.includes(hook), `page missing ${hook}`)
    }
  })

  it('offers a retry after a failed install and shows download rate and time left', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    assert.ok(reply.body.includes('Retry install'), 'page missing the failed-install retry')
    assert.ok(reply.body.includes('MB/s') && reply.body.includes('left'), 'page missing download rate or time estimate')
    assert.ok(reply.body.includes('private, loopback and local addresses are refused'), 'page missing the remote endpoint policy note')
  })

  it('names the size bounds, the module category and the gateway status', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    assert.match(reply.body, /id="f-min"[^>]*aria-label="Minimum parameters \(billions\)"/)
    assert.match(reply.body, /id="f-max"[^>]*aria-label="Maximum parameters \(billions\)"/)
    assert.match(reply.body, /id="mp-category"[^>]*aria-label="Module category"/)
    assert.match(reply.body, /id="gw-filter"[^>]*aria-label="Request status"/)
  })

  it('offers a reset for the model filters and a clear view for the terminal', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    for (const hook of [
      'onclick="mfResetFilters()">Reset filters</button>',
      'onclick="termClear()">Clear view</button>',
      'function mfResetFilters()',
      'function termClear()',
      'var TERM_MAX_CHARS = 200000'
    ]) {
      assert.ok(reply.body.includes(hook), `page missing ${hook}`)
    }
    // The scrollback is trimmed from the front as output accumulates, so a
    // long-running shell cannot grow the page without bound.
    assert.match(reply.body, /slice\(-TERM_MAX_CHARS\)/)
  })

  it('lets the install pick a runtime when more than one is found', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    for (const hook of [
      'function rtInstallTargets()',
      'function rtInstallTarget()',
      'function mfPickTarget(select)',
      'class="mf-target"',
      'aria-label="Runtime to install ',
      'onchange="mfPickTarget(this)"',
      "var payload = { repo: id, runtime: target }",
      'function mfInstallMessage',
      'runtime: ok ? body.runtime : null',
      '" role="status" aria-live="polite">'
    ]) {
      assert.ok(reply.body.includes(hook), `page missing ${hook}`)
    }
    // One runtime keeps the plain "Install in <label>" button; the picker only
    // appears when there is a choice to make.
    assert.match(reply.body, /targets\.length > 1 \? '' : ' in '/)
    // The AstrLink note names the runtime that actually received the model,
    // so it must not claim the address is always Ollama's.
    assert.doesNotMatch(reply.body, /default local Ollama address/)
    assert.ok(reply.body.includes("'’s local address ('"), 'AstrLink note names the runtime address')
  })

  it('names the runtime and the model in repeated controls', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    for (const hook of [
      'function mfRecentHtml(history)',
      'function mfRenderRecent()',
      'if (mf.recent && mf.recent.length) mfRenderRecent()',
      'function mfDownloadRow(d)',
      'active.map(mfDownloadRow)',
      'class="mf-cancel-note"',
      'id="rt-log" role="status" aria-live="polite"',
      'aria-label="Use ',
      'aria-label="Get ',
      'aria-label="Choose quantization for ',
      'aria-label="Install ',
      'aria-label="Retry install of ',
      'aria-label="Remove ',
      'aria-label="Save note for ',
      'aria-label="Copy AstrLink setup for '
    ]) {
      assert.ok(reply.body.includes(hook), `page missing ${hook}`)
    }
    // Progress rows and the recent strip show the runtime's name, not its id.
    assert.doesNotMatch(reply.body, /esc\(d\.runtime\) \+ '<\/span>'/)
    assert.doesNotMatch(reply.body, /esc\(entry\.runtime\)/)
  })

  it('gives every section an address and follows the rail in the URL', async () => {
    const reply = await ask({ path: '/' })
    assert.equal(reply.status, 200)
    for (const hook of [
      "var SECTIONS = ['overview', 'models', 'terminal', 'marketplace', 'gateway', 'settings']",
      'function sectionFromHash(hash)',
      'function setSectionHash(name)',
      'function resolveSection(hash)',
      "history.replaceState(null, '', '#' + name)",
      "addEventListener('hashchange'",
      'setSectionHash(b.dataset.nav)'
    ]) {
      assert.ok(reply.body.includes(hook), `page missing ${hook}`)
    }
  })
})

describe('MCP client configuration', () => {
  it('builds an exact mcpServers entry for a source checkout', () => {
    const execPath = 'C:/Program Files/nodejs/node.exe'
    const distDir = 'D:/toolbox-mcp/dist'
    const entry = join(distDir, 'index.js')
    const launch = clientLaunch({
      execPath,
      distDir,
      packaged: false,
      portable: false,
      home: null
    })
    assert.equal(launch.command, execPath)
    assert.deepEqual(launch.args, [entry])
    assert.equal(launch.env, undefined)
    assert.ok(launch.config)
    assert.deepEqual(JSON.parse(launch.config), {
      mcpServers: { toolbox: { command: execPath, args: [entry] } }
    })
  })

  it('runs the installed app as Node and keeps its settings folder', () => {
    const execPath = 'C:/Program Files/Model Farm/Model Farm.exe'
    const distDir = 'C:/Program Files/Model Farm/resources/app.asar/dist'
    const home = 'C:/Users/you/AppData/Roaming/Model Farm/settings'
    const launch = clientLaunch({ execPath, distDir, packaged: true, portable: false, home })
    assert.deepEqual(launch.env, { ELECTRON_RUN_AS_NODE: '1', TOOLBOX_MCP_HOME: home })
    assert.deepEqual(JSON.parse(launch.config!), {
      mcpServers: {
        toolbox: {
          command: execPath,
          args: [join(distDir, 'index.js')],
          env: { ELECTRON_RUN_AS_NODE: '1', TOOLBOX_MCP_HOME: home }
        }
      }
    })
  })

  it('does not hand a client a temporary path from the portable build', () => {
    const launch = clientLaunch({
      execPath: 'C:/Users/you/AppData/Local/Temp/abc/Model Farm.exe',
      distDir: 'C:/Users/you/AppData/Local/Temp/abc/resources/app.asar/dist',
      portable: true
    })
    assert.equal(launch.config, undefined)
    assert.match(launch.reason ?? '', /portable/i)
    assert.match(launch.reason ?? '', /install|source/i)
  })

  it('serves the configuration through the catalog API', async () => {
    const reply = await ask({ path: '/api/catalog' })
    assert.equal(reply.status, 200)
    const body = JSON.parse(reply.body)
    assert.equal(body.server.client.command, process.execPath)
    assert.ok(body.server.client.args[0].endsWith('index.js'))
    assert.deepEqual(JSON.parse(body.server.client.config).mcpServers.toolbox.command, process.execPath)
  })
})

describe('panel port conflicts', () => {
  it('moves to a free port when another panel already holds the requested one', async () => {
    const second = await startPanel(services, { port: panel.port })
    try {
      assert.notEqual(second.port, panel.port)
      assert.ok(second.port > 0)
    } finally {
      await second.close()
    }
  })
})
