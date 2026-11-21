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

it('gives the landing page a real icon and a social preview', () => {
  const html = readFileSync(join(process.cwd(), 'docs/index.html'), 'utf8')
  assert.match(html, /<link rel="canonical" href="https:\/\/acsdd\.github\.io\/toolbox-mcp\/" \/>/)
  assert.match(html, /<meta property="og:image" content="https:\/\/acsdd\.github\.io\/toolbox-mcp\/panel-overview\.png" \/>/)
  assert.match(html, /<meta name="twitter:card" content="summary_large_image" \/>/)
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/)
})

it('shows the ops panel in the readme', () => {
  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
  assert.match(readme, /!\[[^\]]+\]\(docs\/panel-overview\.png\)/)
})
