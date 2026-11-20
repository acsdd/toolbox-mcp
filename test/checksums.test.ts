import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { writeChecksums } from '../scripts/checksums.mjs'

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

it('writes sha256sum-compatible lines for each artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toolbox-checksums-'))
  try {
    const first = join(dir, 'ModelFarm-Portable-9.9.9.exe')
    const second = join(dir, 'ModelFarm-Setup-9.9.9.exe')
    writeFileSync(first, 'portable')
    writeFileSync(second, 'setup')

    const target = await writeChecksums([first, second], dir)

    assert.equal(target, join(dir, 'SHA256SUMS.txt'))
    assert.deepEqual(readFileSync(target, 'utf8'), [
      `${sha256('portable')}  ModelFarm-Portable-9.9.9.exe`,
      `${sha256('setup')}  ModelFarm-Setup-9.9.9.exe`,
      ''
    ].join('\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
