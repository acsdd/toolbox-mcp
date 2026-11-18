import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createServices } from '../dist/services.js'
import type { CredentialStore } from '../dist/credentials.js'

let home = ''
const legacyPassword = 'test-only-legacy-password'

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-credentials-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

function memoryCredentialStore(): CredentialStore & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    values,
    async set(ref, password) { values.set(ref, password) },
    async get(ref) { return values.get(ref) ?? null },
    async delete(ref) { values.delete(ref) }
  }
}

async function writeLegacySettings(): Promise<void> {
  await writeFile(join(home, 'settings.json'), JSON.stringify({
    version: 1,
    cryptoWatchlist: ['bitcoin'],
    gmail: { email: 'person@example.com', password: legacyPassword, notifications: true },
    resource: { showProcesses: true },
    marketplace: { installed: ['gmail-announcer'] },
    runtimes: { active: null }
  }))
}

describe('Gmail OS credential storage', () => {
  it('migrates the legacy password out of settings and can read it from the credential store', async () => {
    await writeLegacySettings()
    const credentials = memoryCredentialStore()
    const services = createServices({
      credentialStore: credentials,
      gmailInboxImpl: async (_email, password) => {
        assert.equal(password, legacyPassword)
        return { unread: 0, messages: [] }
      }
    })

    await services.init()
    const settings = await readFile(join(home, 'settings.json'), 'utf8')
    const parsed = JSON.parse(settings)
    assert.equal(parsed.version, 2)
    assert.deepEqual(parsed.gmail, {
      email: 'person@example.com',
      credentialRef: [...credentials.values.keys()][0],
      notifications: true
    })
    assert.equal(settings.includes(legacyPassword), false)
    assert.equal(await services.gmailCheck().then((state) => state.configured), true)
    assert.deepEqual([...credentials.values.values()], [legacyPassword])
  })

  it('scrubs legacy plaintext and requires reconnect when secure storage is unavailable', async () => {
    await writeLegacySettings()
    const unavailable: CredentialStore = {
      async set() { throw new Error('secure store unavailable') },
      async get() { throw new Error('secure store unavailable') },
      async delete() { throw new Error('secure store unavailable') }
    }
    const services = createServices({ credentialStore: unavailable })

    await services.init()
    const settings = await readFile(join(home, 'settings.json'), 'utf8')
    const state = await services.gmailCheck()
    assert.equal(settings.includes(legacyPassword), false)
    assert.equal(JSON.parse(settings).gmail, null)
    assert.equal(state.configured, false)
    assert.match(state.error ?? '', /reconnect/i)
  })

  it('refuses to start from unreadable settings rather than bypassing legacy-secret migration', async () => {
    await writeFile(join(home, 'settings.json'), '{not valid json')
    const services = createServices({ credentialStore: memoryCredentialStore() })
    await assert.rejects(() => services.init(), /refusing to continue/i)
  })

  it('stores new connections securely and deletes the keychain entry on disconnect', async () => {
    await rm(join(home, 'settings.json'), { force: true })
    const credentials = memoryCredentialStore()
    const calls: string[] = []
    const services = createServices({
      credentialStore: credentials,
      gmailInboxImpl: async (email, password) => {
        calls.push(`${email}:${password}`)
        return { unread: 2, messages: [] }
      }
    })
    await services.init()

    const connected = await services.gmailConnect({ email: 'person@example.com', password: 'test-only-123456' })
    const settings = await readFile(join(home, 'settings.json'), 'utf8')
    assert.equal(connected.configured, true)
    assert.equal(settings.includes('test-only-123456'), false)
    assert.deepEqual([...credentials.values.values()], ['test-only-123456'])

    await services.gmailConnect({ email: 'person@example.com', password: 'new-pass-1234567' })
    assert.deepEqual([...credentials.values.values()], ['new-pass-1234567'])

    await services.gmailDisconnect()
    assert.equal(credentials.values.size, 0)
    assert.equal(JSON.parse(await readFile(join(home, 'settings.json'), 'utf8')).gmail, null)
    assert.deepEqual(calls, [
      'person@example.com:test-only-123456',
      'person@example.com:new-pass-1234567'
    ])
  })
})
