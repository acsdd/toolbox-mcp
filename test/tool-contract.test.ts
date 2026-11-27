import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildToolContract } from '../dist/tool-contract.js'
import { TOOL_CATALOG, TOOL_GROUPS } from '../dist/catalog.js'

describe('MCP tool contract', () => {
  it('is a deterministic complete projection of the registered catalog', () => {
    const contract = buildToolContract('0.9.26')
    assert.equal(contract.schemaVersion, 1)
    assert.equal(contract.service, 'toolbox-mcp')
    assert.equal(contract.version, '0.9.26')
    assert.deepEqual(contract.groups, TOOL_GROUPS)
    assert.deepEqual(contract.tools.map((tool) => tool.name), TOOL_CATALOG.map((tool) => tool.name))
    assert.equal(new Set(contract.tools.map((tool) => tool.name)).size, TOOL_CATALOG.length)
    assert.deepEqual(contract, buildToolContract('0.9.26'))
  })

  it('includes real JSON Schemas groups and annotations', () => {
    const contract = buildToolContract('test')
    const series = contract.tools.find((tool) => tool.name === 'crypto_series')
    const install = contract.tools.find((tool) => tool.name === 'llamafarm_install')
    assert.equal(series?.group, 'crypto')
    assert.equal(series?.inputSchema.type, 'object')
    assert.deepEqual(series?.inputSchema.required, ['id', 'days'])
    assert.equal(series?.annotations.readOnlyHint, true)
    assert.equal(install?.annotations.destructiveHint, false)
    assert.equal(install?.annotations.openWorldHint, true)
    assert.deepEqual(Object.keys(install?.annotations ?? {}).sort(),
      ['destructiveHint', 'idempotentHint', 'openWorldHint', 'readOnlyHint'])
  })

  it('exports the exact input schemas the MCP server advertises', async () => {
    const { z } = await import('zod')
    const { toJsonSchemaCompat } = await import('@modelcontextprotocol/sdk/server/zod-json-schema-compat.js')
    const contract = buildToolContract('test')
    for (const spec of TOOL_CATALOG) {
      const advertised = toJsonSchemaCompat(z.object(spec.shape), { strictUnions: true, pipeStrategy: 'input' })
      const entry = contract.tools.find((tool) => tool.name === spec.name)
      assert.deepEqual(entry?.inputSchema, advertised, `${spec.name} contract schema must match discovery`)
    }
  })
})
