import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { cleanStaleTempFiles, saveSettings, type StoredSettings } from '../dist/config.js'
import { createServices } from '../dist/services.js'

let home = ''

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-atomic-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

function baseSettings(): StoredSettings {
  return {
    version: 2,
    cryptoWatchlist: ['bitcoin'],
    gmail: null,
    resource: { showProcesses: true },
    marketplace: { installed: ['crypto-watch'] },
    runtimes: { active: null },
    modelFarm: { scenario: 'now', taskFilter: '', minParams: null, maxParams: null, showReds: false }
  }
}

describe('atomic settings writes', () => {
  it('never exposes a partially written settings file to a concurrent reader', async () => {
    const target = join(home, 'settings.json')
    await writeFile(target, JSON.stringify(baseSettings()), 'utf8')

    // A multi-megabyte payload widens the write window so a truncating
    // (non-atomic) writer is reliably caught mid-write by the readers.
    const big: StoredSettings = {
      ...baseSettings(),
      cryptoWatchlist: Array.from({ length: 300000 }, (_, i) => `coin-${i}`)
    }

    let done = false
    let badReads = 0
    let goodReads = 0
    const pause = () => new Promise((resolve) => setTimeout(resolve, 1))

    async function reader(): Promise<void> {
      while (!done) {
        let txt: string
        try {
          txt = await readFile(target, 'utf8')
        } catch {
          // A transient open error during an atomic replace is acceptable;
          // the invariant is about the bytes we actually manage to read.
          await pause()
          continue
        }
        try {
          const parsed = JSON.parse(txt) as { version?: unknown }
          assert.equal(parsed.version, 2)
          goodReads++
        } catch {
          badReads++
        }
        // Release the handle between samples so a replacing writer can win
        // the file, as it would against real (non-hot-loop) readers.
        await pause()
      }
    }

    const readers = Promise.all([reader(), reader(), reader()])
    try {
      await saveSettings(big)
    } finally {
      done = true
    }
    await readers

    assert.equal(badReads, 0, `a concurrent reader saw ${badReads} partial/invalid settings writes`)
    assert.ok(goodReads > 0, 'expected at least one successful concurrent read')

    const final = JSON.parse(await readFile(target, 'utf8')) as StoredSettings
    assert.equal(final.cryptoWatchlist.length, 300000)
  })

  it('leaves no stray temporary files behind after a successful save', async () => {
    await saveSettings(baseSettings())
    const entries = await readdir(home)
    const strays = entries.filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(strays, [])
    assert.ok(entries.includes('settings.json'))
  })

  it('removes orphaned temp files from a crashed write but keeps real files', async () => {
    await saveSettings(baseSettings())
    // Debris a crash between write and rename would leave behind, plus an
    // unrelated user file that must never be touched by the sweep.
    const straySettings = '.settings.json.999.deadbeef.tmp'
    const strayCache = '.llamafarm-cache.json.999.cafebabe.tmp'
    await writeFile(join(home, straySettings), 'partial', 'utf8')
    await writeFile(join(home, strayCache), 'partial', 'utf8')
    await writeFile(join(home, 'notes.txt'), 'keep me', 'utf8')

    await cleanStaleTempFiles()

    const entries = await readdir(home)
    assert.ok(!entries.includes(straySettings), 'orphaned settings temp should be removed')
    assert.ok(!entries.includes(strayCache), 'orphaned cache temp should be removed')
    assert.ok(entries.includes('settings.json'), 'real settings must survive')
    assert.ok(entries.includes('notes.txt'), 'unrelated user files must survive')
    assert.equal(await readFile(join(home, 'notes.txt'), 'utf8'), 'keep me')
  })
})

describe('startup temp-file cleanup', () => {
  it('sweeps orphaned temp files when services initialize', async () => {
    await saveSettings(baseSettings())
    const stray = '.settings.json.4242.abcdef.tmp'
    await writeFile(join(home, stray), 'partial', 'utf8')

    const services = createServices({ fetchImpl: async () => new Response('[]', { status: 200 }) })
    await services.init()

    const entries = await readdir(home)
    assert.ok(!entries.includes(stray), 'init should remove orphaned temp files')
    assert.ok(entries.includes('settings.json'), 'real settings must survive init')
  })
})