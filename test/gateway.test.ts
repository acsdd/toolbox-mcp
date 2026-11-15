import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createServices } from '../dist/services.js'
import type { ExecFileLike } from '@toolbox/widgets'

let home = ''

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-gateway-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

const SERVICES = {
  items: [
    {
      id: 'service_claude',
      name: 'Claude Code',
      kind: 'claude_subscription',
      enabled: true,
      models: [],
      capabilities: [],
      subscription: { provider: 'claude_code', status: 'disconnected', last_error: { code: 'claude_login_failed', message: 'Invalid code.' } }
    }
  ]
}
const ROUTING = { strategy: 'failover_only', max_attempts: 6, codex_identity_enforcement: true }
const AUDIT = { request_body_enabled: true, response_content_enabled: false, content_retention_days: 7, metadata_retention_days: 30 }
const PRIVACY = { items: [{ id: 'policy_privacy_default', enabled: true, enabled_kinds: ['common_secret'], request_action: 'warn' }] }
const REQUESTS = {
  items: [
    {
      id: 'request_1',
      started_at: '2026-11-10T12:59:27Z',
      status: 'succeeded',
      input_protocol: 'openai.responses',
      requested_model: 'gpt-6-luna',
      service_id: 'service_codex',
      latency_ms: 8282,
      usage: { total_tokens: 8824 },
      input_preview: 'a private prompt'
    }
  ]
}

function cliExec(
  routes: Record<string, unknown>,
  failures: Record<string, string> = {},
  calls: string[][] = []
): ExecFileLike {
  return (_file, args, _options, cb) => {
    calls.push(args)
    const key = args[0]
    if (failures[key]) {
      cb(new Error(failures[key]), '')
      return
    }
    cb(null, JSON.stringify(routes[key] ?? {}))
  }
}

const ROUTES = { services: SERVICES, routing: ROUTING, 'audit-settings': AUDIT, privacy: PRIVACY, requests: REQUESTS }

describe('gateway service', () => {
  it('reports provider health and posture alerts', async () => {
    const services = createServices({ execFileImpl: cliExec(ROUTES) })
    await services.init()
    const status = await services.gatewayStatus()
    assert.equal(status.availability, 'ready')
    assert.equal(status.services[0].name, 'Claude Code')
    assert.equal(status.audit?.contentRetentionDays, 7)
    assert.ok(status.alerts.some((alert) => alert.code === 'subscription-disconnected'))
    assert.ok(status.alerts.some((alert) => alert.code === 'body-capture-on'))
  })

  it('caches the report briefly and refetches on demand', async () => {
    const calls: string[][] = []
    const services = createServices({ execFileImpl: cliExec(ROUTES, {}, calls) })
    await services.init()
    await services.gatewayStatus()
    assert.equal(calls.length, 4)
    await services.gatewayStatus()
    assert.equal(calls.length, 4, 'a second read inside the TTL reuse the report')
    await services.gatewayStatus(true)
    assert.equal(calls.length, 8)
  })

  it('reads request metadata with a bounded page', async () => {
    const calls: string[][] = []
    const services = createServices({ execFileImpl: cliExec(ROUTES, {}, calls) })
    await services.init()
    const result = await services.gatewayRequests({ limit: 5, status: 'failed' })
    assert.deepEqual(calls[0], ['requests', '--limit', '5', '--status', 'failed'])
    assert.equal(result.requests.length, 1)
    assert.equal(result.summary.totalTokens, 8824)
    assert.ok(!JSON.stringify(result).includes('a private prompt'), 'no prompt previews reach the caller')
  })

  it('degrades gracefully when AstrLink is not installed', async () => {
    const services = createServices({ execFileImpl: cliExec({}, { services: 'spawn astrlink ENOENT', requests: 'spawn astrlink ENOENT' }) })
    await services.init()
    const status = await services.gatewayStatus()
    assert.equal(status.availability, 'not-installed')
    assert.deepEqual(status.services, [])
    const requests = await services.gatewayRequests()
    assert.equal(requests.availability, 'not-installed')
    assert.deepEqual(requests.requests, [])
  })
})

describe('gateway panel api', () => {
  it('serves the report, the request log and the nav entry', async () => {
    const { startPanel } = await import('../dist/panel.js')
    const services = createServices({ execFileImpl: cliExec(ROUTES) })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    const base = `http://127.0.0.1:${panel.port}`
    try {
      const page = await (await fetch(`${base}/`)).text()
      assert.ok(page.includes('data-nav="gateway"'), 'the panel has a Gateway section')
      assert.ok(page.includes('astrlink-gateway'), 'the section is gated on the marketplace install')

      const status = await (await fetch(`${base}/api/gateway/status`)).json() as { availability: string; services: unknown[] }
      assert.equal(status.availability, 'ready')
      assert.equal(status.services.length, 1)

      const log = await (await fetch(`${base}/api/gateway/requests?limit=3`)).json() as { requests: unknown[]; summary: { count: number } }
      assert.equal(log.requests.length, 1)
      assert.equal(log.summary.count, 1)

      const refreshed = await (await fetch(`${base}/api/gateway/refresh`, { method: 'POST' })).json() as { availability: string }
      assert.equal(refreshed.availability, 'ready')
    } finally {
      panel.close()
    }
  })
})