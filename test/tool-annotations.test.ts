import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { catalogEntries, TOOL_CATALOG } from '../dist/catalog.js'
import { proxiedToolAnnotations } from '../dist/remote.js'

describe('MCP tool annotations', () => {
  it('provides every standard hint for every static tool', () => {
    for (const tool of TOOL_CATALOG) {
      assert.deepEqual(
        Object.keys(tool.annotations).sort(),
        ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'].sort(),
        `${tool.name} has a complete annotation set`
      )
      for (const [hint, value] of Object.entries(tool.annotations)) {
        assert.equal(typeof value, 'boolean', `${tool.name}.${hint} is boolean`)
      }
    }
  })

  it('marks destructive and read-only operations distinctly', () => {
    const byName = new Map(TOOL_CATALOG.map((tool) => [tool.name, tool.annotations]))
    assert.equal(byName.get('llamafarm_remove')?.destructiveHint, true)
    assert.equal(byName.get('llamafarm_remove')?.readOnlyHint, false)
    assert.equal(byName.get('gmail_disconnect')?.destructiveHint, true)
    assert.equal(byName.get('gateway_requests')?.readOnlyHint, true)
    assert.equal(byName.get('gateway_requests')?.destructiveHint, false)
    assert.equal(byName.get('runtimes_download')?.openWorldHint, true)
    assert.equal(byName.get('crypto_set_watchlist')?.openWorldHint, true)
    assert.equal(byName.get('llamafarm_status')?.openWorldHint, true)
    assert.equal(byName.get('gmail_disconnect')?.openWorldHint, false)
  })

  it('continues exposing MCP input parameters from the Zod shapes', () => {
    const install = catalogEntries().find((tool) => tool.name === 'llamafarm_install')
    assert.deepEqual(install?.params.map((param) => param.name), ['repo', 'quant', 'offload', 'runtime'])
    assert.equal(install?.params.find((param) => param.name === 'repo')?.required, true)
    const series = catalogEntries().find((tool) => tool.name === 'crypto_series')
    assert.equal(series?.params.find((param) => param.name === 'days')?.type, 'number')
  })

  it('preserves declared remote hints and defaults unknown proxies conservatively', () => {
    assert.deepEqual(proxiedToolAnnotations({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }), {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true
    })
    assert.deepEqual(proxiedToolAnnotations(), {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true
    })
  })
})
