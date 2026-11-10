import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FetchLike } from '@toolbox/widgets'
import { createServices } from '../dist/services.js'

let home = ''

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-market-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

const REGISTRY = {
  format: 'toolbox-marketplace',
  formatVersion: 1,
  updated: '2026-11-10T00:00:00.000Z',
  modules: [
    {
      id: 'crypto-watch',
      type: 'widget',
      name: 'Crypto Watch',
      description: 'Live coin prices',
      version: '0.1.0',
      author: 'Toolbox',
      icon: '◈',
      categories: ['finance'],
      tags: ['crypto'],
      homepage: 'https://example.com',
      bundle: { widget: 'crypto-watch', settings: { watchlist: ['dogecoin'] } }
    },
    {
      id: 'gmail-announcer',
      type: 'widget',
      name: 'Gmail Announcer',
      description: 'Inbox checks',
      version: '0.1.0',
      author: 'Toolbox',
      icon: '✉',
      categories: ['communication'],
      tags: ['mail'],
      homepage: 'https://example.com',
      credentialsRequired: true
    },
    {
      id: 'llamafarm',
      type: 'feature',
      name: 'Model Farm',
      description: 'Local model finder',
      version: '0.2.0',
      author: 'Toolbox',
      icon: '⌁',
      categories: ['ai'],
      tags: ['llm'],
      homepage: 'https://example.com',
      builtIn: true
    }
  ]
}

function registryFetch(): FetchLike {
  return (async (url: string | URL) => {
    if (String(url).includes('registry.json')) {
      return new Response(JSON.stringify(REGISTRY), { status: 200 })
    }
    // crypto refresh after install hits CoinGecko
    return new Response(JSON.stringify([{ id: 'dogecoin', symbol: 'doge', name: 'Dogecoin', current_price: 0.2 }]), {
      status: 200
    })
  }) as FetchLike
}

describe('marketplace service', () => {
  it('lists the live registry with installed flags and categories', async () => {
    const services = createServices({ fetchImpl: registryFetch() })
    await services.init()
    const list = await services.marketplaceList()
    assert.equal(list.error, null)
    assert.equal(list.modules.length, 3)
    assert.ok(list.categories.includes('finance'))
    const crypto = list.modules.find((m) => m.id === 'crypto-watch')
    const farm = list.modules.find((m) => m.id === 'llamafarm')
    assert.equal(crypto?.installed, true) // preinstalled default
    assert.equal(farm?.installed, true) // built-in
  })

  it('searches live by query and category', async () => {
    const services = createServices({ fetchImpl: registryFetch() })
    await services.init()
    const byQuery = await services.marketplaceList({ query: 'llm' })
    assert.equal(byQuery.modules.length, 1)
    assert.equal(byQuery.modules[0]?.id, 'llamafarm')
    const byCategory = await services.marketplaceList({ category: 'finance' })
    assert.equal(byCategory.modules[0]?.id, 'crypto-watch')
  })

  it('uninstall then install applies the module bundle', async () => {
    const services = createServices({ fetchImpl: registryFetch() })
    await services.init()

    const removed = await services.marketplaceUninstall('crypto-watch')
    assert.ok(!removed.installed.includes('crypto-watch'))
    assert.ok(!services.installedWidgets().includes('crypto-watch'))

    const result = await services.marketplaceInstall('crypto-watch')
    assert.ok(result.installed.includes('crypto-watch'))
    assert.deepEqual(result.applied, ['crypto-watch'])
    // the registry bundle carries watchlist ['dogecoin'] — prove it was applied
    assert.deepEqual(services.crypto.watchlist, ['dogecoin'])
  })

  it('credential-gated modules install with a note', async () => {
    const services = createServices({ fetchImpl: registryFetch() })
    await services.init()
    await services.marketplaceUninstall('gmail-announcer')
    const result = await services.marketplaceInstall('gmail-announcer')
    assert.ok(result.installed.includes('gmail-announcer'))
    assert.match(result.note ?? '', /credentials/i)
  })

  it('rejects unknown ids and built-in install/uninstall', async () => {
    const services = createServices({ fetchImpl: registryFetch() })
    await services.init()
    await assert.rejects(() => services.marketplaceInstall('nope'), /unknown module/i)
    await assert.rejects(() => services.marketplaceInstall('llamafarm'), /built in/i)
    await assert.rejects(() => services.marketplaceUninstall('llamafarm'), /built in/i)
  })

  it('persists installs across restarts', async () => {
    const first = createServices({ fetchImpl: registryFetch() })
    await first.init()
    await first.marketplaceUninstall('resource-monitor')

    const second = createServices({ fetchImpl: registryFetch() })
    await second.init()
    assert.ok(!second.installedWidgets().includes('resource-monitor'))
  })

  it('reports registry fetch failures without throwing the list away', async () => {
    const offline: FetchLike = (async () => {
      throw new Error('offline')
    }) as FetchLike
    const services = createServices({ fetchImpl: offline })
    await services.init()
    const list = await services.marketplaceList()
    assert.match(list.error ?? '', /offline/)
    assert.deepEqual(list.modules, [])
  })
})
