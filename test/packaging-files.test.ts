import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(import.meta.dirname, '..')

test('both packaging paths include the desktop lifecycle helper', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { files: string[] }
  assert.ok(manifest.files.includes('scripts') || manifest.files.includes('scripts/desktop-main.cjs'))
  const portablePackager = await readFile(join(ROOT, 'scripts', 'pack-portable.mjs'), 'utf8')
  assert.match(portablePackager, /copyFile\([^\n]*desktop-main\.cjs/)
  assert.match(portablePackager, /files: \[[\s\S]*?['"]scripts\/desktop-main\.cjs['"][\s\S]*?\]/)
})

test('both MCP packaging paths include the generated tool contract', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as { files: string[] }
  assert.ok(manifest.files.includes('dist/tool-contract.json'))
  const portablePackager = await readFile(join(ROOT, 'scripts', 'pack-portable.mjs'), 'utf8')
  assert.match(portablePackager, /run\(join\(root, 'scripts\/export-tool-contract\.mjs'\)\)/)
  assert.match(portablePackager, /files: \[[\s\S]*?['"]dist\/tool-contract\.json['"][\s\S]*?\]/)
})
