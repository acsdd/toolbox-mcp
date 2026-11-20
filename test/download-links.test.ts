import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'node:test'

const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
const pages = ['README.md', 'docs/index.html']

it('points every download link at the version in package.json', () => {
  for (const page of pages) {
    const text = readFileSync(join(process.cwd(), page), 'utf8')
    const versions = [...new Set([...text.matchAll(/releases\/download\/v([^/"]+)\//g)].map((match) => match[1]))]
    assert.deepEqual(versions, [manifest.version], `${page} links ${versions.join(', ') || 'no release'} instead of ${manifest.version}`)
  }
})
