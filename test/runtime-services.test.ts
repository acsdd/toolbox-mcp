import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { FetchLike } from '@toolbox/widgets'
import { createServices } from '../dist/services.js'
import type { RuntimeFetch, RuntimeFetchResponse } from '../dist/runtimes.js'

const GiB = 2 ** 30
let home = ''
const savedEnv: Record<string, string | undefined> = {}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-runtime-services-'))
  process.env.TOOLBOX_MCP_HOME = home
  // The runtime folders are resolved from the home directory, so the test
  // must not touch the real one.
  for (const key of ['USERPROFILE', 'HOME']) {
    savedEnv[key] = process.env[key]
    process.env[key] = home
  }
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(home, { recursive: true, force: true })
})

/** The Hugging Face catalog the Model Farm reads. */
function catalogFetch(): FetchLike {
  const model = {
    id: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
    pipeline_tag: 'text-generation',
    tags: ['gguf', 'license:apache-2.0'],
    downloads: 5000,
    likes: 20
  }
  return async (input) => {
    const url = String(input)
    const body = url.includes('/api/models/bartowski/Llama-3.2-3B-Instruct-GGUF')
      ? {
          siblings: [
            { rfilename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', size: 2 * GiB, lfs: { size: 2 * GiB } }
          ],
          cardData: { license: 'apache-2.0' }
        }
      : url.includes('/api/models')
        ? [model]
        : null
    if (body === null) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as never
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as never
  }
}

/** The file lookup a runtime that cannot pull weights uses. */
function ggufFetch(): RuntimeFetch {
  return async (url) => {
    const body = {
      siblings: [{ rfilename: 'Llama-3.2-3B-Instruct-Q4_K_M.gguf', lfs: { size: 2048 } }]
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body)
    } as RuntimeFetchResponse
  }
}

const noExec = {
  execFileImpl: (
    _file: string,
    _args: string[],
    _options: unknown,
    cb: (error: Error | null, stdout: string, stderr: string) => void
  ): void => cb(new Error('not found'), '', '')
} as never

describe('runtime services', () => {
  it('detects the runtimes of the machine and marks the active one', async () => {
    const services = createServices({
      fetchImpl: catalogFetch(),
      runtimeFetchImpl: ggufFetch(),
      ...noExec
    })
    await services.init()
    const report = await services.runtimesDetect(true)
    assert.ok(report.runtimes.length >= 5)
    const ollama = report.runtimes.find((entry) => entry.id === 'ollama')
    assert.ok(ollama)
    assert.equal(ollama.installable, true)
    assert.equal(report.active, null)
  })

  it('remembers the runtime the user picked', async () => {
    const services = createServices({
      fetchImpl: catalogFetch(),
      runtimeFetchImpl: ggufFetch(),
      ...noExec
    })
    await services.init()
    const picked = await services.runtimesUse('lmstudio')
    assert.equal(picked.active, 'lmstudio')
    assert.equal(picked.runtime?.id, 'lmstudio')

    const report = await services.runtimesDetect(true)
    assert.equal(report.active, 'lmstudio')

    const cleared = await services.runtimesUse('none')
    assert.equal(cleared.active, null)
  })

  it('refuses an unknown runtime', async () => {
    const services = createServices({
      fetchImpl: catalogFetch(),
      runtimeFetchImpl: ggufFetch(),
      ...noExec
    })
    await services.init()
    await assert.rejects(() => services.runtimesUse('not-a-runtime'))
  })

  it('says that it cannot install a runtime with its own installer', async () => {
    const services = createServices({
      fetchImpl: catalogFetch(),
      runtimeFetchImpl: ggufFetch(),
      ...noExec
    })
    await services.init()
    const result = await services.runtimesInstall('lmstudio')
    assert.equal(result.ok, false)
    assert.equal(result.action, 'unsupported')
    assert.match(result.message, /LM Studio/)
    assert.match(result.steps.join(' '), /lmstudio\.ai/)
  })

  it('installs a model into the runtime that was picked', async () => {
    const downloads: Array<{ url: string; target: string }> = []
    const services = createServices({
      fetchImpl: catalogFetch(),
      runtimeFetchImpl: ggufFetch(),
      execFileImpl: (
        _file: string,
        _args: string[],
        _options: unknown,
        cb: (error: Error | null, stdout: string, stderr: string) => void
      ): void => cb(new Error('not found'), '', ''),
      downloadFileImpl: async (url, target) => {
        downloads.push({ url, target })
        await mkdir(join(home, '.lmstudio', 'models'), { recursive: true })
        await writeFile(target, Buffer.alloc(2048))
        return 2048
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
      runtime: 'lmstudio'
    })
    assert.equal(result.ok, true)
    assert.equal(result.runtime.id, 'lmstudio')
    assert.equal(result.reason, 'installed')
    assert.ok(result.file)
    assert.equal(result.file.bytes, 2048)
    assert.ok(result.file.path.startsWith(join(home, '.lmstudio', 'models')))
    assert.equal(downloads.length, 1)
    assert.match(downloads[0].url, /resolve\/main\//)
    // The weights land in the temp home, never in the real one.
    assert.ok(result.file.path.startsWith(home))
  })

  it('rejects an unknown runtime at install time', async () => {
    const services = createServices({
      fetchImpl: catalogFetch(),
      runtimeFetchImpl: ggufFetch(),
      ...noExec
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF',
      runtime: 'not-a-runtime'
    })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-found')
    assert.match(result.message, /not-a-runtime/)
  })
})
