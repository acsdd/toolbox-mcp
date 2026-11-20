import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'
import { TOOL_CATALOG, TOOL_GROUPS } from '../dist/catalog.js'

const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
const documented = new Set(readme.match(/`[a-z0-9]+_[a-z0-9_]+`/g)?.map((match) => match.slice(1, -1)))

it('lists every catalog tool in the README tool table', () => {
  const missing = TOOL_CATALOG.map((tool) => tool.name).filter((name) => !documented.has(name))
  assert.deepEqual(missing, [], `README does not mention: ${missing.join(', ')}`)
})

it('does not document tool names the server does not expose', () => {
  const known = new Set(TOOL_CATALOG.map((tool) => tool.name))
  const groups = new Set(TOOL_CATALOG.map((tool) => tool.group))
  const unknown = [...documented].filter((name) => {
    const prefix = name.split('_')[0]
    return groups.has(prefix as never) && !known.has(name)
  })
  assert.deepEqual(unknown, [], `README mentions unknown tools: ${unknown.join(', ')}`)
})

it('names every panel feature group in the README', () => {
  const missing = TOOL_GROUPS.map((group) => group.label).filter((label) => !readme.includes(label))
  assert.deepEqual(missing, [], `README does not name these groups: ${missing.join(', ')}`)
})
