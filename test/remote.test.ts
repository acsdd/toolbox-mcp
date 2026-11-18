import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FetchLike } from '@toolbox/widgets'
import { createServices } from '../dist/services.js'
import { jsonSchemaToZodShape, proxiedToolAnnotations, proxiedToolName, type ProxiedTool, type RemoteConnect } from '../dist/remote.js'

let home = ''

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-remote-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

const REGISTRY = {
  format: 'toolbox-marketplace',
  formatVersion: 1,
  updated: '2026-11-10T00:00:00.000Z',
  modules: [
    {
      id: 'cve-now',
      type: 'remote-server',
      name: 'cve.now',
      description: 'Vulnerability feed',
      version: '1.0.0',
      author: 'Sazabi',
      categories: ['security'],
      tags: ['cve'],
      homepage: 'https://example.com',
      endpoint: 'https://mcp.cve.now/mcp'
    }
  ]
}

function registryFetch(): FetchLike {
  return (async () => new Response(JSON.stringify(REGISTRY), { status: 200 })) as FetchLike
}

function fakeConnect(log: { closed: number; calls: Array<{ name: string; args: unknown }> }): RemoteConnect {
  return async (endpoint) => {
    assert.equal(endpoint, 'https://mcp.cve.now/mcp')
    return {
      listTools: async () => [
        {
          name: 'list_feed',
          description: 'Newest vulnerabilities',
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
          inputSchema: {
            type: 'object',
            properties: { name: { type: 'string', description: 'Feed name' } },
            required: []
          }
        }
      ],
      callTool: async (name, args) => {
        log.calls.push({ name, args })
        return { content: [{ type: 'text', text: `remote:${name}` }] }
      },
      close: async () => {
        log.closed++
      }
    }
  }
}

describe('jsonSchemaToZodShape', () => {
  it('converts primitives, enums, optionality and descriptions', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Some text' },
        count: { type: 'integer' },
        flag: { type: 'boolean' },
        mode: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array' },
        meta: { type: 'object' },
        weird: { $ref: '#/defs/thing' }
      },
      required: ['text', 'count']
    })
    assert.ok(shape.text && shape.count && shape.flag && shape.mode && shape.tags && shape.meta && shape.weird)
    assert.equal(shape.text.description, 'Some text')
    assert.equal(shape.text.safeParse('hi').success, true)
    assert.equal(shape.text.safeParse(undefined).success, false) // required
    assert.equal(shape.flag.safeParse(undefined).success, true) // optional
    assert.equal(shape.mode.safeParse('c').success, false)
    assert.equal(shape.count.safeParse('no').success, false)
  })

  it('returns an empty shape for missing/invalid schemas', () => {
    assert.deepEqual(jsonSchemaToZodShape(undefined), {})
    assert.deepEqual(jsonSchemaToZodShape({ type: 'string' }), {})
  })
})

describe('proxiedToolName', () => {
  it('sanitizes the module id into a tool prefix', () => {
    assert.equal(proxiedToolName('cve-now', 'list_feed'), 'cve_now_list_feed')
    assert.equal(proxiedToolName('liquidvision', 'get_funding_rates'), 'liquidvision_get_funding_rates')
  })
})

describe('remote-server marketplace flow', () => {
  it('installs a remote server, registers proxied tools and proxies calls', async () => {
    const log = { closed: 0, calls: [] as Array<{ name: string; args: unknown }> }
    let registered: ProxiedTool[] = []
    const services = createServices({
      fetchImpl: registryFetch(),
      remoteConnect: fakeConnect(log),
      onRemoteTools: (_id, tools) => {
        registered = tools
      }
    })
    await services.init()

    const result = await services.marketplaceInstall('cve-now')
    assert.ok(result.installed.includes('cve-now'))
    assert.deepEqual(result.remoteTools, ['cve_now_list_feed'])
    assert.match(result.note ?? '', /leave this machine/)
    assert.equal(registered.length, 1)
    assert.equal(registered[0]?.name, 'cve_now_list_feed')
    assert.match(registered[0]?.description ?? '', /cve\.now/)
    assert.deepEqual(registered[0]?.annotations, {
      readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true
    })

    const response = await registered[0]?.call({ name: 'critical' }) as { content: Array<{ text: string }> }
    assert.equal(response.content[0]?.text, 'remote:list_feed')
    assert.deepEqual(log.calls, [{ name: 'list_feed', args: { name: 'critical' } }])
    assert.deepEqual(services.remoteStatus(), [{ id: 'cve-now', tools: 1 }])
  })

  it('uninstall closes the connection and removes the tools', async () => {
    const log = { closed: 0, calls: [] as Array<{ name: string; args: unknown }> }
    let removed = ''
    const services = createServices({
      fetchImpl: registryFetch(),
      remoteConnect: fakeConnect(log),
      onRemoteRemoved: (id) => {
        removed = id
      }
    })
    await services.init()
    await services.marketplaceInstall('cve-now')
    const result = await services.marketplaceUninstall('cve-now')
    assert.ok(!result.installed.includes('cve-now'))
    assert.equal(removed, 'cve-now')
    assert.equal(log.closed, 1)
    assert.deepEqual(services.remoteStatus(), [])
  })

  it('restores installed remotes on startup and reports failures', async () => {
    const log = { closed: 0, calls: [] as Array<{ name: string; args: unknown }> }
    const first = createServices({ fetchImpl: registryFetch(), remoteConnect: fakeConnect(log) })
    await first.init()
    await first.marketplaceInstall('cve-now')

    let restoredTools = 0
    const second = createServices({
      fetchImpl: registryFetch(),
      remoteConnect: fakeConnect(log),
      onRemoteTools: (_id, tools) => {
        restoredTools = tools.length
      }
    })
    await second.init()
    const restored = await second.remoteRestore()
    assert.deepEqual(restored.connected, [{ id: 'cve-now', tools: 1 }])
    assert.deepEqual(restored.failed, [])
    assert.equal(restoredTools, 1)

    const broken = createServices({
      fetchImpl: registryFetch(),
      remoteConnect: async () => {
        throw new Error('connection refused')
      }
    })
    await broken.init()
    const failedRestore = await broken.remoteRestore()
    assert.equal(failedRestore.connected.length, 0)
    assert.equal(failedRestore.failed[0]?.id, 'cve-now')
    assert.match(failedRestore.failed[0]?.error ?? '', /connection refused/)
  })

  it('does not mark a remote installed when the connection fails', async () => {
    const services = createServices({
      fetchImpl: registryFetch(),
      remoteConnect: async () => {
        throw new Error('handshake failed')
      }
    })
    await services.init()
    await services.marketplaceUninstall('cve-now') // earlier tests persisted an install
    await assert.rejects(() => services.marketplaceInstall('cve-now'), /handshake failed/)
    assert.ok(!services.installedWidgets().includes('cve-now'))
  })
})
