import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { after, describe, it } from 'node:test'
import { createServices } from '../dist/services.js'
import { startPanel } from '../dist/panel.js'

const DEFAULT_PREFS = {
  scenario: 'now',
  taskFilter: '',
  minParams: null,
  maxParams: null,
  showReds: false
}

const homes: string[] = []

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-mfprefs-'))
  homes.push(home)
  process.env.TOOLBOX_MCP_HOME = home
  return home
}

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

function fakeFetch(payload: unknown) {
  return async () => new Response(JSON.stringify(payload), { status: 200 })
}

async function writeSettings(home: string, settings: unknown): Promise<void> {
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'settings.json'), JSON.stringify(settings, null, 2), 'utf8')
}

async function readSettings(home: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')) as Record<string, unknown>
}

/** Settings as written before Model Farm preferences existed. */
function legacySettings(): Record<string, unknown> {
  return {
    version: 2,
    cryptoWatchlist: ['bitcoin'],
    gmail: null,
    resource: { showProcesses: true },
    marketplace: { installed: ['crypto-watch'] },
    runtimes: { active: null }
  }
}

describe('Model Farm preferences: storage validation', () => {
  it('loads validated defaults when settings predate the preferences', async () => {
    const home = await freshHome()
    await writeSettings(home, legacySettings())
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()

    const snapshot = await services.settingsSnapshot()
    assert.deepEqual(snapshot.modelFarm, DEFAULT_PREFS)
  })

  it('sanitizes invalid stored preferences back to defaults', async () => {
    const home = await freshHome()
    await writeSettings(home, {
      ...legacySettings(),
      modelFarm: { scenario: 'bogus', taskFilter: 42, minParams: 999, maxParams: '7', showReds: 'yes' }
    })
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()

    const snapshot = await services.settingsSnapshot()
    assert.deepEqual(snapshot.modelFarm, DEFAULT_PREFS)
  })

  it('keeps valid stored preferences and trims the purpose filter', async () => {
    const home = await freshHome()
    await writeSettings(home, {
      ...legacySettings(),
      modelFarm: { scenario: 'total', taskFilter: '  text-generation  ', minParams: 7, maxParams: 33, showReds: true }
    })
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()

    const snapshot = await services.settingsSnapshot()
    assert.deepEqual(snapshot.modelFarm, {
      scenario: 'total',
      taskFilter: 'text-generation',
      minParams: 7,
      maxParams: 33,
      showReds: true
    })
  })

  it('rejects parameter bounds outside the options the panel offers', async () => {
    const home = await freshHome()
    await writeSettings(home, {
      ...legacySettings(),
      // 2 is not a min option; 1 is not a max option; 70 is valid for both.
      modelFarm: { scenario: 'now', taskFilter: '', minParams: 2, maxParams: 1, showReds: false }
    })
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()
    assert.deepEqual((await services.settingsSnapshot()).modelFarm, DEFAULT_PREFS)

    await writeSettings(home, {
      ...legacySettings(),
      modelFarm: { scenario: 'now', taskFilter: '', minParams: 70, maxParams: 70, showReds: false }
    })
    const restarted = createServices({ fetchImpl: fakeFetch([]) })
    await restarted.init()
    const prefs = (await restarted.settingsSnapshot()).modelFarm
    assert.equal(prefs.minParams, 70)
    assert.equal(prefs.maxParams, 70)
  })

  it('drops an overlong purpose filter instead of restoring it', async () => {
    const home = await freshHome()
    await writeSettings(home, {
      ...legacySettings(),
      modelFarm: { ...DEFAULT_PREFS, taskFilter: 'x'.repeat(300) }
    })
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()

    assert.equal((await services.settingsSnapshot()).modelFarm.taskFilter, '')
  })
})

describe('Model Farm preferences: service lifecycle', () => {
  it('persists preferences and remembers them across a restart', async () => {
    const home = await freshHome()
    const first = createServices({ fetchImpl: fakeFetch([]) })
    await first.init()

    const saved = await first.modelFarmSetPrefs({
      scenario: 'total',
      taskFilter: 'text-generation',
      minParams: 7,
      maxParams: 33,
      showReds: true
    })
    assert.deepEqual(saved.modelFarm, {
      scenario: 'total',
      taskFilter: 'text-generation',
      minParams: 7,
      maxParams: 33,
      showReds: true
    })

    const onDisk = await readSettings(home)
    assert.deepEqual(onDisk.modelFarm, saved.modelFarm)

    // A brand-new service instance over the same home is a panel restart.
    const second = createServices({ fetchImpl: fakeFetch([]) })
    await second.init()
    assert.deepEqual((await second.settingsSnapshot()).modelFarm, saved.modelFarm)
  })

  it('sanitizes invalid input instead of storing it', async () => {
    await freshHome()
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()

    const saved = await services.modelFarmSetPrefs({ scenario: 'bogus', taskFilter: 42, minParams: 999, showReds: 'yes' })
    assert.deepEqual(saved.modelFarm, DEFAULT_PREFS)
  })

  it('keeps unrelated settings intact when preferences change', async () => {
    const home = await freshHome()
    await writeSettings(home, { ...legacySettings(), cryptoWatchlist: ['solana'] })
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()

    await services.modelFarmSetPrefs({ scenario: 'total' })
    const onDisk = await readSettings(home)
    assert.deepEqual(onDisk.cryptoWatchlist, ['solana'])
    assert.equal((onDisk.modelFarm as { scenario: string }).scenario, 'total')
  })
})

describe('Model Farm preferences: panel API', () => {
  interface Reply { status: number; body: string }

  function ask(port: number, options: { path: string; method?: string; body?: string }): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: options.path,
          method: options.method ?? 'GET',
          headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined
        },
        (res) => {
          let body = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => { body += chunk })
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
        }
      )
      req.on('error', reject)
      if (options.body !== undefined) req.write(options.body)
      req.end()
    })
  }

  it('serves defaults, persists updates and sanitizes bad input', async () => {
    await freshHome()
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    try {
      const initial = await ask(panel.port, { path: '/api/settings' })
      assert.equal(initial.status, 200)
      assert.deepEqual(JSON.parse(initial.body).modelFarm, DEFAULT_PREFS)

      const update = await ask(panel.port, {
        path: '/api/settings/modelfarm',
        method: 'POST',
        body: JSON.stringify({ scenario: 'total', taskFilter: 'text-generation', minParams: 7, maxParams: 33, showReds: true })
      })
      assert.equal(update.status, 200)
      assert.deepEqual(JSON.parse(update.body).modelFarm, {
        scenario: 'total',
        taskFilter: 'text-generation',
        minParams: 7,
        maxParams: 33,
        showReds: true
      })

      const reread = await ask(panel.port, { path: '/api/settings' })
      assert.deepEqual(JSON.parse(reread.body).modelFarm, JSON.parse(update.body).modelFarm)

      const bad = await ask(panel.port, {
        path: '/api/settings/modelfarm',
        method: 'POST',
        body: JSON.stringify({ scenario: 'bogus', minParams: 999 })
      })
      assert.equal(bad.status, 200)
      assert.deepEqual(JSON.parse(bad.body).modelFarm, DEFAULT_PREFS)
    } finally {
      await panel.close()
      await services.close()
    }
  })

  it('wires the Model Farm UI to restore and save preferences', async () => {
    await freshHome()
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    try {
      const page = await ask(panel.port, { path: '/' })
      assert.equal(page.status, 200)
      // The client must restore stored options and persist changes through the API.
      assert.match(page.body, /mfRestorePrefs/)
      assert.match(page.body, /\/api\/settings\/modelfarm/)
    } finally {
      await panel.close()
      await services.close()
    }
  })
})