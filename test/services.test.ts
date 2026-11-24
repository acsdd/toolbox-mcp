import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createServices } from '../dist/services.js'

let home = ''

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-test-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

function fakeFetch(payload: unknown) {
  return async () => new Response(JSON.stringify(payload), { status: 200 })
}

describe('crypto watch service', () => {
  it('refreshes prices with an injected fetch', async () => {
    const services = createServices({
      fetchImpl: fakeFetch([{ id: 'bitcoin', symbol: 'btc', name: 'Bitcoin', current_price: 60000 }])
    })
    await services.init()

    const state = await services.cryptoRefresh()
    assert.equal(state.coins.length, 1)
    assert.equal(state.coins[0].price, 60000)
    assert.equal(state.error, null)
  })

  it('updates and persists the watchlist', async () => {
    const services = createServices({
      fetchImpl: fakeFetch([{ id: 'solana', symbol: 'sol', name: 'Solana', current_price: 150 }])
    })
    await services.init()

    const state = await services.cryptoSetWatchlist(['solana'])
    assert.deepEqual(state.watchlist, ['solana'])
    assert.equal(state.coins[0].id, 'solana')
    await assert.rejects(() => services.cryptoSetWatchlist([]), /at least one coin/i)
  })
})

describe('gmail announcer service', () => {
  it('reports a friendly error when checking unconfigured', async () => {
    const services = createServices()
    await services.init()
    const state = await services.gmailCheck()
    assert.equal(state.configured, false)
    assert.match(state.error ?? '', /not connected/i)
  })
})

describe('resource monitor service', () => {
  it('returns real stats', async () => {
    const services = createServices()
    await services.init()
    const stats = await services.resourceStats()
    assert.ok(stats.cores > 0)
  })
})

describe('persisted crypto watchlist recovery', () => {
  async function startWithWatchlist(value: unknown) {
    await writeFile(join(home, 'settings.json'), JSON.stringify({ version: 2, cryptoWatchlist: value }), 'utf8')
    const services = createServices({ fetchImpl: fakeFetch([]) })
    await services.init()
    return services
  }

  for (const [label, value] of [
    ['an empty list', []],
    ['a non-array value', 'bitcoin'],
    ['only malformed ids', ['', '!!!', 'x'.repeat(41), 42]],
    ['more than eight coins', Array.from({ length: 9 }, (_, index) => `coin-${index}`)]
  ] as Array<[string, unknown]>) {
    it(`starts with defaults when the saved watchlist has ${label}`, async () => {
      const services = await startWithWatchlist(value)
      assert.deepEqual(services.crypto.watchlist, ['bitcoin', 'ethereum', 'solana'])
      assert.deepEqual((await services.settingsSnapshot()).watchlist, ['bitcoin', 'ethereum', 'solana'])
    })
  }

  it('normalizes usable saved ids without preventing startup', async () => {
    const services = await startWithWatchlist([' Bitcoin ', 'bitcoin', 'Ethereum', null])
    assert.deepEqual(services.crypto.watchlist, ['bitcoin', 'ethereum'])
    assert.deepEqual((await services.settingsSnapshot()).watchlist, ['bitcoin', 'ethereum'])
  })
})

describe('portable widget bundles', () => {
  it('round-trips crypto + resource widgets through export/import', async () => {
    const services = createServices({
      fetchImpl: fakeFetch([{ id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 3000 }])
    })
    await services.init()
    await services.cryptoSetWatchlist(['bitcoin', 'ethereum'])

    const exported = await services.exportWidgets()
    const parsed = JSON.parse(exported)
    assert.equal(parsed.format, 'toolbox-widgets')
    assert.equal(parsed.widgets.length, 2) // gmail not configured

    // Import into a fresh service.
    const fresh = createServices({
      fetchImpl: fakeFetch([{ id: 'ethereum', symbol: 'eth', name: 'Ethereum', current_price: 3000 }])
    })
    await fresh.init()
    const result = await fresh.importWidgets(parsed)
    assert.deepEqual(result.applied.sort(), ['crypto-watch', 'resource-monitor'])
    assert.deepEqual(fresh.crypto.watchlist, ['bitcoin', 'ethereum'])
    assert.deepEqual(result.missingCredentials, [])
  })

  it('flags missing credentials when a bundle references gmail', async () => {
    const services = createServices()
    await services.init()
    const result = await services.importWidgets({
      format: 'toolbox-widgets',
      formatVersion: 1,
      widgets: [
        {
          widget: 'gmail-announcer',
          settings: { email: 'me@example.com', notifications: true },
          credentialsRef: 'gmail/app-password'
        }
      ]
    })
    assert.deepEqual(result.missingCredentials, ['gmail/app-password'])
    assert.equal(services.gmail.configured, false)
  })

  it('rejects malformed bundles', async () => {
    const services = createServices()
    await services.init()
    await assert.rejects(() => services.importWidgets({ format: 'nope' }), /not a Toolbox widget bundle/i)
  })
})
