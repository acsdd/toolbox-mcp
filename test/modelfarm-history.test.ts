import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { after, describe, it } from 'node:test'
import type { ExecFileLike, FetchLike } from '@toolbox/widgets'
import { recordModelInstall, sanitizeModelInstalls } from '../dist/config.js'
import { createServices } from '../dist/services.js'
import { startPanel } from '../dist/panel.js'

const GiB = 2 ** 30
const homes: string[] = []

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-mfhistory-'))
  homes.push(home)
  process.env.TOOLBOX_MCP_HOME = home
  return home
}

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

const QWEN_REPO = 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF'

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' }

/** HuggingFace fake serving one GGUF repo; runtime probes stay offline. */
const farmFetch: FetchLike = (async (input: string | URL) => {
  const url = String(input)
  if (url === 'http://127.0.0.1:11434/api/tags') return okJson({ models: [] }) as never
  if (url.includes('/api/models/') && url.includes('blobs=true')) {
    return okJson({
      id: QWEN_REPO,
      pipeline_tag: 'text-generation',
      tags: ['gguf'],
      siblings: [{ rfilename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', lfs: { size: 4 * GiB } }]
    }) as never
  }
  return notFound as never
}) as FetchLike

const gpuExec: ExecFileLike = (_file, _args, _opts, cb) =>
  cb(null, JSON.stringify({ Name: 'RTX 4070', AdapterRAM: 12 * GiB }))

function installServices(pullOk: boolean) {
  return createServices({
    fetchImpl: farmFetch,
    execFileImpl: gpuExec,
    freeDiskImpl: async () => 100 * GiB,
    pullModel: async () =>
      pullOk
        ? { ok: true, code: 0, output: '', error: null }
        : { ok: false, code: 1, output: '', error: 'pull refused' }
  })
}

describe('install history: storage validation', () => {
  it('drops invalid entries and keeps valid ones newest-first', () => {
    const raw = [
      { repo: 'a/old', label: 'old', runtime: 'ollama', installedAt: 1000 },
      null,
      { repo: 42, installedAt: 5 },
      { repo: 'a/bad-time', installedAt: 'soon' },
      { repo: '   ', installedAt: 5 },
      { repo: 'a/new', label: 'new', runtime: 'ollama', installedAt: 2000 }
    ]
    const cleaned = sanitizeModelInstalls(raw)
    assert.deepEqual(cleaned.map((entry) => entry.repo), ['a/new', 'a/old'])
  })

  it('deduplicates by repo and runtime, keeping the newest entry', () => {
    const cleaned = sanitizeModelInstalls([
      { repo: 'a/model', label: 'model', runtime: 'ollama', installedAt: 1000 },
      { repo: 'a/model', label: 'model', runtime: 'ollama', installedAt: 3000 },
      { repo: 'a/model', label: 'model', runtime: 'lmstudio', installedAt: 2000 }
    ])
    assert.equal(cleaned.length, 2)
    assert.deepEqual(cleaned.map((entry) => [entry.runtime, entry.installedAt]), [
      ['ollama', 3000],
      ['lmstudio', 2000]
    ])
  })

  it('caps the history so settings cannot grow without bound', () => {
    const raw = Array.from({ length: 30 }, (_, i) => ({
      repo: `a/model-${i}`,
      label: `model-${i}`,
      runtime: 'ollama',
      installedAt: i + 1
    }))
    const cleaned = sanitizeModelInstalls(raw)
    assert.equal(cleaned.length, 12)
    assert.equal(cleaned[0].repo, 'a/model-29')
    assert.equal(cleaned[11].repo, 'a/model-18')
  })

  it('recordModelInstall moves a reinstall to the front with a new timestamp', () => {
    const history = sanitizeModelInstalls([
      { repo: 'a/first', label: 'first', runtime: 'ollama', installedAt: 1000 },
      { repo: 'a/second', label: 'second', runtime: 'ollama', installedAt: 2000 }
    ])
    const updated = recordModelInstall(history, {
      repo: 'a/first',
      label: 'first',
      runtime: 'ollama',
      installedAt: 5000
    })
    assert.deepEqual(updated.map((entry) => [entry.repo, entry.installedAt]), [
      ['a/first', 5000],
      ['a/second', 2000]
    ])
  })

  it('loads an empty history when settings predate the feature', async () => {
    const home = await freshHome()
    await mkdir(home, { recursive: true })
    await writeFile(
      join(home, 'settings.json'),
      JSON.stringify({
        version: 2,
        cryptoWatchlist: ['bitcoin'],
        gmail: null,
        resource: { showProcesses: true },
        marketplace: { installed: ['crypto-watch'] },
        runtimes: { active: null }
      }),
      'utf8'
    )
    const services = createServices({ fetchImpl: farmFetch })
    await services.init()
    assert.deepEqual((await services.settingsSnapshot()).modelInstalls, [])
  })
})

describe('install history: service lifecycle', () => {
  it('records a successful install and remembers it across a restart', async () => {
    await freshHome()
    const first = installServices(true)
    const before = Date.now()
    const result = await first.llamafarmInstall({ repo: QWEN_REPO })
    const after = Date.now()
    assert.equal(result.ok, true)

    const history = (await first.settingsSnapshot()).modelInstalls
    assert.equal(history.length, 1)
    assert.equal(history[0].repo, QWEN_REPO)
    assert.equal(history[0].runtime, 'ollama')
    assert.ok(typeof history[0].label === 'string' && history[0].label.length > 0)
    assert.ok(history[0].installedAt >= before && history[0].installedAt <= after)

    // A brand-new service instance over the same home is a panel restart.
    const second = createServices({ fetchImpl: farmFetch })
    await second.init()
    assert.deepEqual((await second.settingsSnapshot()).modelInstalls, history)
  })

  it('records nothing when the install fails', async () => {
    await freshHome()
    const services = installServices(false)
    const result = await services.llamafarmInstall({ repo: QWEN_REPO })
    assert.equal(result.ok, false)
    assert.deepEqual((await services.settingsSnapshot()).modelInstalls, [])
  })
})

describe('install history: panel API', () => {
  interface Reply { status: number; body: string }

  function ask(port: number, path: string): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
  }

  it('exposes the install history through /api/settings', async () => {
    await freshHome()
    const services = installServices(true)
    assert.equal((await services.llamafarmInstall({ repo: QWEN_REPO })).ok, true)
    const panel = await startPanel(services, { port: 0 })
    try {
      const reply = await ask(panel.port, '/api/settings')
      assert.equal(reply.status, 200)
      const history = JSON.parse(reply.body).modelInstalls
      assert.equal(history.length, 1)
      assert.equal(history[0].repo, QWEN_REPO)
    } finally {
      await panel.close()
      await services.close()
    }
  })

  it('wires a recently-installed strip into the Model Farm UI', async () => {
    await freshHome()
    const services = createServices({ fetchImpl: farmFetch })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    try {
      const page = await ask(panel.port, '/')
      assert.equal(page.status, 200)
      assert.match(page.body, /mf-recent/)
      assert.match(page.body, /mfLoadRecent/)
    } finally {
      await panel.close()
      await services.close()
    }
  })
})