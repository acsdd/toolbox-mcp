import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ExecFileLike, FetchLike } from '@toolbox/widgets'
import { createServices } from '../dist/services.js'
import type { RuntimeFetch, RuntimeFetchResponse } from '../dist/runtimes.js'

let home = ''

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-cancel-test-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

const MOCK_MODEL = {
  id: 'test/cancel-model-3b',
  pipeline_tag: 'text-generation',
  tags: ['gguf', 'license:apache-2.0'],
  downloads: 100,
  likes: 10
}

function mockCatalogFetch(): FetchLike {
  return async (input) => {
    const url = String(input)
    if (url.includes('/api/models/test/cancel-model-3b')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          siblings: [{ rfilename: 'model-Q4_K_M.gguf', size: 1024 * 1024 * 100, lfs: { size: 1024 * 1024 * 100 } }],
          cardData: { license: 'apache-2.0' }
        })
      } as never
    }
    return {
      ok: true,
      status: 200,
      json: async () => [MOCK_MODEL]
    } as never
  }
}

function mockGgufFetch(): RuntimeFetch {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      siblings: [{ rfilename: 'model-Q4_K_M.gguf', lfs: { size: 1024 * 1024 * 100 } }]
    }),
    text: async () => ''
  } as RuntimeFetchResponse)
}

describe('model farm: download cancellation', () => {
  it('gracefully cancels an in-progress transfer when requested', async () => {
    let downloadAborted = false
    let downloadStarted = false
    const services = createServices({
      fetchImpl: mockCatalogFetch(),
      runtimeFetchImpl: mockGgufFetch(),
      freeDiskImpl: async () => 100 * 1024 * 1024 * 1024,
      homeDir: join(home, 'home'),
      downloadFileImpl: async (_url, _target, _onProgress, signal) => {
        downloadStarted = true
        return new Promise<number>((resolve, reject) => {
          const timeout = setTimeout(() => resolve(1024), 5000)
          if (signal) {
            signal.addEventListener('abort', () => {
              clearTimeout(timeout)
              downloadAborted = true
              const err = new Error('Download was cancelled.')
              err.name = 'AbortError'
              reject(err)
            })
          }
        })
      }
    })

    await services.init()
    await services.runtimesUse('lmstudio')

    const installPromise = services.llamafarmInstall({ repo: 'test/cancel-model-3b' })

    let progress = await services.llamafarmProgress()
    for (let i = 0; i < 50; i++) {
      progress = await services.llamafarmProgress()
      if (progress.downloads.length > 0 && downloadStarted) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(progress.downloads.length, 1)
    assert.equal(progress.downloads[0].status, 'downloading')
    assert.equal(downloadStarted, true)

    const cancelRes = await services.llamafarmCancel({ repo: 'test/cancel-model-3b' })
    assert.equal(cancelRes.ok, true)
    assert.match(cancelRes.message, /cancelled/i)

    const installRes = await installPromise
    assert.equal(installRes.ok, false)
    assert.equal(installRes.reason, 'cancelled')
    assert.equal(downloadAborted, true)

    progress = await services.llamafarmProgress()
    assert.equal(progress.downloads[0].status, 'cancelled')
  })

  it('refuses a second install of a repo that is already downloading', async () => {
    const services = createServices({
      fetchImpl: mockCatalogFetch(),
      runtimeFetchImpl: mockGgufFetch(),
      freeDiskImpl: async () => 100 * 1024 * 1024 * 1024,
      homeDir: join(home, 'home'),
      downloadFileImpl: async (_url, _target, _onProgress, signal) => {
        return new Promise<number>((_resolve, reject) => {
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('Download was cancelled.')
              err.name = 'AbortError'
              reject(err)
            })
          }
        })
      }
    })

    await services.init()
    await services.runtimesUse('lmstudio')

    const first = services.llamafarmInstall({ repo: 'test/cancel-model-3b' })
    for (let i = 0; i < 50; i++) {
      if ((await services.llamafarmProgress()).downloads.length > 0) break
      await new Promise((r) => setTimeout(r, 20))
    }

    const second = await services.llamafarmInstall({ repo: 'test/cancel-model-3b' })
    assert.equal(second.ok, false)
    assert.match(second.message, /already downloading/i)

    await services.llamafarmCancel({ repo: 'test/cancel-model-3b' })
    const firstResult = await first
    assert.equal(firstResult.reason, 'cancelled')
  })

  it('rejects cancellation for repos that have no active download', async () => {
    const services = createServices({
      fetchImpl: mockCatalogFetch(),
      runtimeFetchImpl: mockGgufFetch()
    })
    await services.init()
    const cancelRes = await services.llamafarmCancel({ repo: 'nonexistent/repo' })
    assert.equal(cancelRes.ok, false)
    assert.match(cancelRes.message, /no active download/i)
  })

  it('says plainly that an Ollama pull keeps running instead of pointing at a terminal', async () => {
    let finishPull: (result: { ok: boolean; code: number; output: string; error: string | null }) => void = () => {}
    const ollamaExec: ExecFileLike = (_file, _args, _opts, cb) =>
      cb(null, 'ollama version is 0.5.4')
    const services = createServices({
      fetchImpl: mockCatalogFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * 1024 * 1024 * 1024,
      homeDir: join(home, 'home-ollama-cancel'),
      pullModel: () => new Promise<{ ok: boolean; code: number; output: string; error: string | null }>((resolve) => {
        finishPull = resolve
      })
    })
    await services.init()
    await services.runtimesUse('ollama')

    const install = services.llamafarmInstall({ repo: 'test/cancel-model-3b' })
    let progress = await services.llamafarmProgress()
    for (let i = 0; i < 50; i++) {
      progress = await services.llamafarmProgress()
      if (progress.downloads.length > 0) break
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(progress.downloads.length, 1)

    const cancelRes = await services.llamafarmCancel({ repo: 'test/cancel-model-3b' })
    assert.equal(cancelRes.ok, false)
    assert.match(cancelRes.message, /cannot be cancelled from the panel/i)
    assert.match(cancelRes.message, /keeps running in the background/i)
    assert.doesNotMatch(cancelRes.message, /terminal/i)

    finishPull({ ok: false, code: 1, output: '', error: 'stopped for test' })
    const result = await install
    assert.equal(result.ok, false)
  })
})
