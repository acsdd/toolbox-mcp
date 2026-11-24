import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { FetchLike } from '@toolbox/widgets'
import type { StoredSettings } from '../dist/config.js'
import type { CredentialStore } from '../dist/credentials.js'
import type { RemoteConnection } from '../dist/remote.js'
import { createServices } from '../dist/services.js'
import type { RuntimeFetchResponse } from '../dist/runtimes.js'

const homes: string[] = []
const noExec = {
  execFileImpl: (
    _file: string,
    _args: string[],
    _options: unknown,
    cb: (error: Error | null, stdout: string, stderr: string) => void
  ): void => cb(new Error('not found'), '', '')
} as never

const runtimeFetchImpl = async (): Promise<RuntimeFetchResponse> => ({
  ok: true,
  status: 200,
  json: async () => ({ siblings: [] }),
  text: async () => JSON.stringify({ siblings: [] })
})

const emptyFetch = (async () => new Response('[]', { status: 200 })) as FetchLike

type SaveSettings = (settings: StoredSettings) => Promise<void>

function servicesWithSave(saveSettingsImpl: SaveSettings, fetchImpl: FetchLike = emptyFetch) {
  return createServices({
    fetchImpl,
    saveSettingsImpl,
    runtimeFetchImpl,
    homeDir: process.env.TOOLBOX_MCP_HOME,
    ...noExec
  })
}

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-settings-consistency-'))
  homes.push(home)
  process.env.TOOLBOX_MCP_HOME = home
  return home
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

describe('settings commit consistency', () => {
  it('serializes overlapping commits so an older save cannot overwrite a newer one', async () => {
    await freshHome()
    const firstSaveStarted = deferred()
    const releaseFirstSave = deferred()
    const saves: StoredSettings[] = []
    let activeSaves = 0
    let maxActiveSaves = 0
    let persisted: StoredSettings | null = null

    const services = servicesWithSave(async (candidate) => {
      activeSaves++
      maxActiveSaves = Math.max(maxActiveSaves, activeSaves)
      const snapshot = structuredClone(candidate)
      saves.push(snapshot)
      if (saves.length === 1) {
        firstSaveStarted.resolve()
        await releaseFirstSave.promise
      }
      persisted = snapshot
      activeSaves--
    })
    await services.init()

    const first = services.modelFarmSetPrefs({ scenario: 'total' })
    await firstSaveStarted.promise
    const second = services.resourceSetSettings({ diskPath: 'R:\\models', showProcesses: false })

    // The first persistence is paused. No candidate may become visible or
    // start a second write until that commit succeeds.
    await Promise.resolve()
    const pending = await services.settingsSnapshot()
    assert.equal(pending.modelFarm.scenario, 'now')
    assert.equal(pending.diskPath, '')
    assert.equal(pending.showProcesses, true)

    releaseFirstSave.resolve()
    await Promise.all([first, second])

    assert.equal(maxActiveSaves, 1, 'settings writes must not overlap')
    assert.equal(saves.length, 2)
    assert.ok(persisted)
    assert.equal(persisted.modelFarm.scenario, 'total')
    assert.deepEqual(persisted.resource, { diskPath: 'R:\\models', showProcesses: false })
    const visible = await services.settingsSnapshot()
    assert.equal(visible.modelFarm.scenario, 'total')
    assert.equal(visible.diskPath, 'R:\\models')
    assert.equal(visible.showProcesses, false)
  })

  it('leaves watchlist and price state unchanged when persistence fails', async () => {
    await freshHome()
    const services = servicesWithSave(async () => { throw new Error('disk full') })
    await services.init()
    const before = await services.settingsSnapshot()

    await assert.rejects(() => services.cryptoSetWatchlist(['solana']), /disk full/)

    assert.deepEqual((await services.settingsSnapshot()).watchlist, before.watchlist)
    assert.deepEqual(services.crypto.watchlist, before.watchlist)
    assert.deepEqual(services.crypto.coins, [])
  })

  it('keeps the active runtime unchanged when persistence fails', async () => {
    await freshHome()
    const services = servicesWithSave(async () => { throw new Error('disk full') })
    await services.init()

    await assert.rejects(() => services.runtimesUse('lmstudio'), /disk full/)

    const report = await services.runtimesDetect(true)
    assert.equal(report.active, null)
  })

  it('keeps marketplace installation state unchanged when persistence fails', async () => {
    await freshHome()
    let fail = false
    const registry = {
      format: 'toolbox-marketplace',
      formatVersion: 1,
      updated: '2026-11-24T00:00:00.000Z',
      modules: [{
        id: 'gmail-announcer',
        type: 'widget',
        name: 'Gmail Announcer',
        description: 'Inbox checks',
        version: '0.1.0',
        author: 'Toolbox',
        icon: 'mail',
        categories: ['communication'],
        tags: ['mail'],
        homepage: 'https://example.com',
        credentialsRequired: true
      }]
    }
    const registryFetch = (async (input: string | URL) => {
      if (String(input).includes('registry.json')) return new Response(JSON.stringify(registry), { status: 200 })
      return new Response('[]', { status: 200 })
    }) as FetchLike
    const services = servicesWithSave(async () => {
      if (fail) throw new Error('disk full')
    }, registryFetch)
    await services.init()
    await services.marketplaceUninstall('gmail-announcer')
    fail = true

    await assert.rejects(() => services.marketplaceInstall('gmail-announcer'), /disk full/)

    assert.equal(services.installedWidgets().includes('gmail-announcer'), false)
  })

  it('continues committing later updates after a failed save', async () => {
    await freshHome()
    let attempts = 0
    let persisted: StoredSettings | null = null
    const services = servicesWithSave(async (candidate) => {
      attempts++
      if (attempts === 1) throw new Error('disk full')
      persisted = structuredClone(candidate)
    })
    await services.init()

    await assert.rejects(() => services.modelFarmSetPrefs({ scenario: 'total' }), /disk full/)
    const saved = await services.modelFarmSetPrefs({ scenario: 'total', taskFilter: 'text-generation' })

    assert.equal(attempts, 2)
    assert.equal(saved.modelFarm.scenario, 'total')
    assert.equal(saved.modelFarm.taskFilter, 'text-generation')
    assert.ok(persisted)
    assert.equal(persisted.modelFarm.scenario, 'total')
    assert.equal(persisted.modelFarm.taskFilter, 'text-generation')
  })

  it('does not let a failed Gmail connect restore credentials over a later connection', async () => {
    await freshHome()
    const values = new Map<string, string>()
    const credentialStore: CredentialStore = {
      async set(ref, password) { values.set(ref, password) },
      async get(ref) { return values.get(ref) ?? null },
      async delete(ref) { values.delete(ref) }
    }
    const failedSaveStarted = deferred()
    const releaseFailedSave = deferred()
    let saves = 0
    const services = createServices({
      fetchImpl: emptyFetch,
      credentialStore,
      gmailInboxImpl: async () => ({ unread: 0, messages: [] }),
      saveSettingsImpl: async () => {
        saves++
        if (saves === 2) {
          failedSaveStarted.resolve()
          await releaseFailedSave.promise
          throw new Error('disk full')
        }
      },
      ...noExec
    })
    await services.init()
    await services.gmailConnect({ email: 'original@example.com', password: 'abcdefghijklmnop' })

    const failed = services.gmailConnect({ email: 'failed@example.com', password: 'qrstuvwxyzABCDEF' })
    await failedSaveStarted.promise
    const later = services.gmailConnect({ email: 'later@example.com', password: '0123456789abcdef' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFailedSave.resolve()

    await assert.rejects(failed, /settings could not be saved/i)
    const connected = await later
    assert.equal(connected.email, 'later@example.com')
    assert.deepEqual([...values.values()], ['0123456789abcdef'])
  })

  it('does not let an uninstall disconnect a newer remote installation', async () => {
    await freshHome()
    const registry = {
      format: 'toolbox-marketplace',
      formatVersion: 1,
      updated: '2026-11-24T00:00:00.000Z',
      modules: [{
        id: 'remote-test',
        type: 'remote-server',
        name: 'Remote Test',
        description: 'Test remote',
        version: '0.1.0',
        author: 'Toolbox',
        icon: 'remote',
        categories: ['developer'],
        tags: ['test'],
        homepage: 'https://example.com',
        endpoint: 'https://remote.example.com/mcp'
      }]
    }
    const registryFetch = (async (input: string | URL) => {
      if (String(input).includes('registry.json')) return new Response(JSON.stringify(registry), { status: 200 })
      return new Response('[]', { status: 200 })
    }) as FetchLike
    const connections: RemoteConnection[] = []
    const remoteConnect = async (): Promise<RemoteConnection> => {
      const connection: RemoteConnection = {
        async listTools() { return [] },
        async callTool() { return null },
        async close() {}
      }
      connections.push(connection)
      return connection
    }
    const uninstallSaveStarted = deferred()
    const releaseUninstallSave = deferred()
    let saves = 0
    const services = createServices({
      fetchImpl: registryFetch,
      remoteConnect,
      saveSettingsImpl: async () => {
        saves++
        if (saves === 2) {
          uninstallSaveStarted.resolve()
          await releaseUninstallSave.promise
        }
      },
      ...noExec
    })
    await services.init()
    await services.marketplaceInstall('remote-test')

    const uninstall = services.marketplaceUninstall('remote-test')
    await uninstallSaveStarted.promise
    const install = services.marketplaceInstall('remote-test')
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseUninstallSave.resolve()
    await Promise.all([uninstall, install])

    assert.equal(services.installedWidgets().includes('remote-test'), true)
    assert.equal(services.remoteStatus().find((entry) => entry.id === 'remote-test')?.connected, true)
    assert.equal(connections.length, 2)
  })

  it('keeps the Gmail credential usable when disconnect persistence fails', async () => {
    await freshHome()
    const values = new Map<string, string>()
    let fail = false
    const services = createServices({
      fetchImpl: emptyFetch,
      credentialStore: {
        async set(ref, password) { values.set(ref, password) },
        async get(ref) { return values.get(ref) ?? null },
        async delete(ref) { values.delete(ref) }
      },
      gmailInboxImpl: async () => ({ unread: 0, messages: [] }),
      saveSettingsImpl: async () => {
        if (fail) throw new Error('disk full')
      },
      ...noExec
    })
    await services.init()
    await services.gmailConnect({ email: 'person@example.com', password: 'abcdefghijklmnop' })
    fail = true

    await assert.rejects(() => services.gmailDisconnect(), /disk full/)

    assert.deepEqual([...values.values()], ['abcdefghijklmnop'])
    assert.equal((await services.gmailCheck()).configured, true)
    assert.equal(services.gmail.email, 'person@example.com')
  })

  it('publishes disconnected Gmail state even when secure cleanup fails', async () => {
    await freshHome()
    const values = new Map<string, string>()
    let failDelete = false
    const services = createServices({
      fetchImpl: emptyFetch,
      credentialStore: {
        async set(ref, password) { values.set(ref, password) },
        async get(ref) { return values.get(ref) ?? null },
        async delete(ref) {
          if (failDelete) throw new Error('secure store unavailable')
          values.delete(ref)
        }
      },
      gmailInboxImpl: async () => ({ unread: 0, messages: [] }),
      saveSettingsImpl: async () => {},
      ...noExec
    })
    await services.init()
    await services.gmailConnect({ email: 'person@example.com', password: 'abcdefghijklmnop' })
    failDelete = true

    const result = await services.importWidgets({
      format: 'toolbox-widgets',
      formatVersion: 1,
      widgets: [{
        widget: 'gmail-announcer',
        settings: { email: 'person@example.com', notifications: true },
        credentialsRef: 'gmail/app-password'
      }]
    })

    assert.deepEqual(result.applied, ['gmail-announcer'])
    assert.equal(services.gmail.configured, false)
    assert.equal(services.gmail.email, '')
    assert.match(services.gmail.error ?? '', /could not be removed/i)
  })

  it('does not let an older runtime detection replace a newer report', async () => {
    await freshHome()
    const firstStarted = deferred()
    const releaseFirst = deferred()
    let holdFirst = true
    const runtimeFetchImpl: RuntimeFetch = async (input) => {
      const gated = holdFirst
      if (gated) {
        holdFirst = false
        firstStarted.resolve()
        await releaseFirst.promise
      }
      const url = String(input)
      const body = gated && url.includes('127.0.0.1:11434/api/version')
        ? { version: '0.0.1-old' }
        : null
      return {
        ok: body !== null,
        status: body === null ? 404 : 200,
        json: async () => body ?? {},
        text: async () => JSON.stringify(body ?? {})
      }
    }
    const services = createServices({
      fetchImpl: emptyFetch,
      runtimeFetchImpl,
      saveSettingsImpl: async () => {},
      homeDir: process.env.TOOLBOX_MCP_HOME,
      ...noExec
    })
    await services.init()

    const older = services.runtimesDetect(true)
    await firstStarted.promise
    await services.runtimesUse('lmstudio')
    releaseFirst.resolve()
    const stale = await older
    const cached = await services.runtimesDetect()

    assert.equal(stale.active, 'lmstudio')
    assert.equal(cached.active, 'lmstudio')
    assert.equal(cached.runtimes.find((entry) => entry.id === 'ollama')?.running, false)
  })

  it('admits marketplace lifecycle operations before registry I/O', async () => {
    await freshHome()
    const registry = {
      format: 'toolbox-marketplace',
      formatVersion: 1,
      updated: '2026-11-24T00:00:00.000Z',
      modules: [{
        id: 'queue-test',
        type: 'widget',
        name: 'Queue Test',
        description: 'Lifecycle ordering',
        version: '0.1.0',
        author: 'Toolbox',
        icon: 'test',
        categories: ['developer'],
        tags: ['test'],
        homepage: 'https://example.com'
      }]
    }
    const firstRegistryStarted = deferred()
    const releaseFirstRegistry = deferred()
    let registryRequests = 0
    const registryFetch = (async (input: string | URL) => {
      if (String(input).includes('registry.json')) {
        registryRequests++
        if (registryRequests === 1) {
          firstRegistryStarted.resolve()
          await releaseFirstRegistry.promise
        }
        return new Response(JSON.stringify(registry), { status: 200 })
      }
      return new Response('[]', { status: 200 })
    }) as FetchLike
    const services = servicesWithSave(async () => {}, registryFetch)
    await services.init()

    const uninstall = services.marketplaceUninstall('queue-test')
    await firstRegistryStarted.promise
    const install = services.marketplaceInstall('queue-test')
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFirstRegistry.resolve()
    await Promise.all([uninstall, install])

    assert.equal(services.installedWidgets().includes('queue-test'), true)
  })
})
