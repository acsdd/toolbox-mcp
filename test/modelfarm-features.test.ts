import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ExecFileLike, FetchLike } from '@toolbox/widgets'
import { createServices } from '../dist/services.js'
import type { RuntimeFetch, RuntimeFetchResponse } from '../dist/runtimes.js'

const GiB = 2 ** 30
let home = ''
const savedEnv: Record<string, string | undefined> = {}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-modelfarm-'))
  process.env.TOOLBOX_MCP_HOME = home
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

interface HfItem {
  id: string
  pipeline_tag: string
  tags: string[]
  downloads: number
  likes: number
}

const QWEN: HfItem = {
  id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
  pipeline_tag: 'text-generation',
  tags: ['gguf', 'license:apache-2.0'],
  downloads: 9000,
  likes: 500
}

const QWEN_DETAIL = {
  siblings: [
    { rfilename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', size: 4 * GiB, lfs: { size: 4 * GiB } },
    { rfilename: 'qwen2.5-coder-7b-instruct-q8_0.gguf', size: 8 * GiB, lfs: { size: 8 * GiB } }
  ],
  cardData: { license: 'apache-2.0' }
}

function okJson(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}
const notFound = { ok: false, status: 404, json: async () => ({}), text: async () => '' }

/** A HuggingFace + Ollama fake whose catalog, search hits and details vary per test. */
function farmFetch(opts: {
  ollamaNames?: string[]
  catalog?: HfItem[]
  search?: HfItem[]
  details?: Record<string, unknown>
} = {}): FetchLike {
  const ollamaNames = opts.ollamaNames ?? []
  const catalog = opts.catalog ?? [QWEN]
  const search = opts.search ?? [QWEN]
  const details: Record<string, unknown> = {
    'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF': QWEN_DETAIL,
    ...opts.details
  }
  return (async (input: string | URL) => {
    const url = String(input)
    if (url === 'http://127.0.0.1:11434/api/tags') {
      return okJson({ models: ollamaNames.map((name) => ({ name, size: 4 * GiB, modified_at: '2026-11-01T00:00:00Z' })) }) as never
    }
    if (url.includes('/api/models?') && url.includes('search=')) return okJson(search) as never
    if (url.includes('pipeline_tag=')) {
      const task = decodeURIComponent(url.split('pipeline_tag=')[1].split('&')[0])
      return okJson(task === 'text-generation' ? catalog : []) as never
    }
    if (url.includes('/api/models/') && url.includes('blobs=true')) {
      const repo = decodeURIComponent(url.split('/api/models/')[1].split('?')[0])
      const body = details[repo]
      return (body ? okJson(body) : notFound) as never
    }
    return notFound as never
  }) as FetchLike
}

/** Runtime probes answer nothing, so detection stays fast and offline. */
const deadRuntimeFetch: RuntimeFetch = (async () =>
  ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }) as RuntimeFetchResponse) as RuntimeFetch

/** A runtime file lookup that returns one small GGUF. */
function ggufFetch(size = 2048): RuntimeFetch {
  return (async () =>
    okJson({ siblings: [{ rfilename: 'model-q4_k_m.gguf', lfs: { size } }] }) as RuntimeFetchResponse) as RuntimeFetch
}

const gpuExec: ExecFileLike = (_file, _args, _opts, cb) =>
  cb(null, JSON.stringify({ Name: 'RTX 4070', AdapterRAM: 12 * GiB }))

const noExec: ExecFileLike = (_file, _args, _opts, cb) => cb(new Error('not found'), '', '')

describe('model farm: live search (point 1)', () => {
  it('searches HuggingFace beyond the catalog and grades the hits', async () => {
    const services = createServices({ fetchImpl: farmFetch({ search: [QWEN] }), execFileImpl: gpuExec })
    await services.init()
    const result = await services.llamafarmSearch({ query: 'qwen', scenario: 'now' })
    assert.equal(result.query, 'qwen')
    assert.ok(result.total >= 1)
    const model = result.groups.flatMap((g) => g.models).find((m) => m.id.includes('Qwen'))
    assert.ok(model)
    assert.ok(['green', 'yellow', 'red'].includes(model.verdict))
  })

  it('returns nothing for a blank query without hitting the network', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const result = await services.llamafarmSearch({ query: '   ' })
    assert.equal(result.total, 0)
    assert.equal(result.groups.length, 0)
  })
})

describe('model farm: disk guard (point 2)', () => {
  it('refuses an install that would overshoot free disk', async () => {
    const services = createServices({
      fetchImpl: farmFetch({
        details: { 'acme/huge-GGUF': { siblings: [{ rfilename: 'huge-q4_k_m.gguf', lfs: { size: 100000 * GiB } }] } }
      }),
      execFileImpl: gpuExec,
      pullModel: async () => {
        throw new Error('must not pull when disk is too small')
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'acme/huge-GGUF' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'insufficient-disk')
    assert.match(result.message, /disk/i)
    assert.equal(result.astrlink, null)
  })

  it('refuses a folder download that would overshoot free disk', async () => {
    const services = createServices({
      fetchImpl: farmFetch({
        details: { 'acme/huge-GGUF': { siblings: [{ rfilename: 'huge-q4_k_m.gguf', lfs: { size: 100000 * GiB } }] } }
      }),
      runtimeFetchImpl: ggufFetch(100000 * GiB),
      execFileImpl: noExec,
      downloadFileImpl: async () => {
        throw new Error('must not download when disk is too small')
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'acme/huge-GGUF', runtime: 'lmstudio' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'insufficient-disk')
  })

  it('guards the requested quant, not the catalog default', async () => {
    const services = createServices({
      fetchImpl: farmFetch({
        details: {
          'acme/quant-GGUF': {
            siblings: [
              { rfilename: 'quant-q4_k_m.gguf', lfs: { size: 1 * GiB } },
              { rfilename: 'quant-q8_0.gguf', lfs: { size: 100000 * GiB } }
            ]
          }
        }
      }),
      execFileImpl: gpuExec,
      pullModel: async () => {
        throw new Error('must not pull the heavy quant when disk is too small')
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'acme/quant-GGUF', quant: 'Q8_0' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'insufficient-disk')
    assert.match(result.message, /disk/i)
  })

  it('still installs a requested quant that fits', async () => {
    let pulled = ''
    const services = createServices({
      fetchImpl: farmFetch({
        details: {
          'acme/quant-GGUF': {
            siblings: [
              { rfilename: 'quant-q4_k_m.gguf', lfs: { size: 1 * GiB } },
              { rfilename: 'quant-q8_0.gguf', lfs: { size: 100000 * GiB } }
            ]
          }
        }
      }),
      execFileImpl: gpuExec,
      pullModel: async (reference: string) => {
        pulled = reference
        return { ok: true, code: 0, output: '', error: null }
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'acme/quant-GGUF', quant: 'Q4_K_M' })
    assert.equal(result.ok, true)
    assert.match(pulled, /:Q4_K_M$/)
  })
})

describe('model farm: already installed (point 3)', () => {
  it('marks a catalog model that the active runtime already serves', async () => {
    const other: HfItem = { id: 'acme/other-GGUF', pipeline_tag: 'text-generation', tags: ['gguf'], downloads: 1, likes: 0 }
    const services = createServices({
      fetchImpl: farmFetch({
        ollamaNames: ['qwen2.5-coder-7b-instruct'],
        catalog: [QWEN, other],
        details: { 'acme/other-GGUF': { siblings: [{ rfilename: 'other-q4_k_m.gguf', lfs: { size: GiB } }] } }
      }),
      execFileImpl: gpuExec
    })
    await services.init()
    const result = await services.llamafarmScore({ scenario: 'now' })
    const models = result.groups.flatMap((g) => g.models)
    const qwen = models.find((m) => m.id.includes('Qwen'))
    const acme = models.find((m) => m.id.includes('acme/other'))
    assert.equal(qwen?.installed, 'qwen2.5-coder-7b-instruct')
    assert.equal(acme?.installed, null)
  })
})

describe('model farm: quant picker (point 5)', () => {
  it('lists the GGUF quants a repo offers, smallest first', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const result = await services.llamafarmQuants('Qwen/Qwen2.5-Coder-7B-Instruct-GGUF')
    assert.equal(result.error, null)
    assert.equal(result.quants.length, 2)
    assert.equal(result.quants[0].quant, 'Q4_K_M')
    assert.equal(result.quants[1].quant, 'Q8_0')
    assert.ok(result.quants[0].sizeBytes < result.quants[1].sizeBytes)
  })
})

describe('model farm: remove (point 6)', () => {
  it('removes an installed Ollama model by repo', async () => {
    const calls: string[][] = []
    const services = createServices({
      fetchImpl: farmFetch({ ollamaNames: ['qwen2.5-coder-7b-instruct'] }),
      execFileImpl: gpuExec,
      runOllama: async (args) => {
        calls.push(args)
        return { ok: true, code: 0, output: 'removed', error: null }
      }
    })
    await services.init()
    const result = await services.llamafarmRemove({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' })
    assert.equal(result.ok, true)
    assert.equal(result.removed, 'qwen2.5-coder-7b-instruct')
    assert.deepEqual(calls[0], ['rm', 'qwen2.5-coder-7b-instruct'])
  })

  it('reports a model that is not installed as not-found', async () => {
    const services = createServices({
      fetchImpl: farmFetch({ ollamaNames: ['qwen2.5-coder-7b-instruct'] }),
      execFileImpl: gpuExec,
      runOllama: async () => {
        throw new Error('must not rm a model that is not there')
      }
    })
    await services.init()
    const result = await services.llamafarmRemove({ model: 'no-such-model' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-found')
  })
})

describe('model farm: what can I run now (point 7)', () => {
  it('picks the best green model per task', async () => {
    const tiny: HfItem = { id: 'acme/tiny-GGUF', pipeline_tag: 'text-generation', tags: ['gguf'], downloads: 5, likes: 0 }
    const services = createServices({
      fetchImpl: farmFetch({
        catalog: [QWEN, tiny],
        details: { 'acme/tiny-GGUF': { siblings: [{ rfilename: 'tiny-q4_k_m.gguf', lfs: { size: 0.2 * GiB } }] } }
      }),
      execFileImpl: gpuExec
    })
    await services.init()
    const result = await services.llamafarmRunNow()
    assert.equal(result.scenario, 'now')
    assert.ok(result.picks.length >= 1)
    assert.ok(result.picks.every((pick) => pick.model.verdict === 'green'))
    assert.ok(result.picks.some((pick) => pick.task === 'text-generation'))
  })

  it('prefers an already-installed green model over a lighter one needing a download', async () => {
    const tiny: HfItem = { id: 'acme/tiny-GGUF', pipeline_tag: 'text-generation', tags: ['gguf'], downloads: 5, likes: 0 }
    const services = createServices({
      fetchImpl: farmFetch({
        ollamaNames: ['qwen2.5-coder-7b-instruct'],
        catalog: [QWEN, tiny],
        details: {
          // Shrink QWEN so both it and tiny score green on a modest free disk.
          // QWEN stays heavier than tiny, so lightness alone would pick tiny.
          'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF': {
            siblings: [{ rfilename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', lfs: { size: 1 * GiB } }]
          },
          'acme/tiny-GGUF': { siblings: [{ rfilename: 'tiny-q4_k_m.gguf', lfs: { size: 0.2 * GiB } }] }
        }
      }),
      execFileImpl: gpuExec
    })
    await services.init()
    await services.llamafarmRefresh()
    const result = await services.llamafarmRunNow()
    const pick = result.picks.find((p) => p.task === 'text-generation')
    assert.ok(pick, 'a text-generation pick exists')
    assert.equal(pick.model.verdict, 'green')
    assert.equal(pick.model.installed, 'qwen2.5-coder-7b-instruct')
  })
})

describe('model farm: runtime-aware fit (point 8)', () => {
  const red: HfItem = { id: 'acme/red-GGUF', pipeline_tag: 'text-generation', tags: ['gguf'], downloads: 1, likes: 0 }
  const redDetail = { siblings: [{ rfilename: 'red-q4_k_m.gguf', lfs: { size: 300 * GiB } }] }

  it('words the offload hint for the active runtime', async () => {
    const services = createServices({
      fetchImpl: farmFetch({ catalog: [red], details: { 'acme/red-GGUF': redDetail } }),
      runtimeFetchImpl: deadRuntimeFetch,
      execFileImpl: gpuExec
    })
    await services.init()
    await services.runtimesUse('lmstudio')
    await services.llamafarmRefresh()
    const result = await services.llamafarmScore({ scenario: 'now' })
    const model = result.groups.flatMap((g) => g.models).find((m) => m.id.includes('acme/red'))
    assert.equal(model?.verdict, 'red')
    assert.ok(model?.hints.some((hint) => hint.includes('LM Studio')), 'hint names LM Studio')
  })

  it('defaults the offload hint to Ollama', async () => {
    const services = createServices({
      fetchImpl: farmFetch({ catalog: [red], details: { 'acme/red-GGUF': redDetail } }),
      runtimeFetchImpl: deadRuntimeFetch,
      execFileImpl: gpuExec
    })
    await services.init()
    await services.llamafarmRefresh()
    const result = await services.llamafarmScore({ scenario: 'now' })
    const model = result.groups.flatMap((g) => g.models).find((m) => m.id.includes('acme/red'))
    assert.ok(model?.hints.some((hint) => hint.includes('Ollama')), 'hint names Ollama')
  })
})

describe('model farm: download progress (point 4)', () => {
  it('reports a folder download through to completion', async () => {
    const services = createServices({
      fetchImpl: farmFetch(),
      runtimeFetchImpl: ggufFetch(2048),
      execFileImpl: noExec,
      downloadFileImpl: async (_url, target, onProgress) => {
        await mkdir(join(home, '.lmstudio', 'models'), { recursive: true })
        await writeFile(target, 'weights')
        onProgress?.({ receivedBytes: 1024, totalBytes: 2048 })
        return 2048
      }
    })
    await services.init()
    assert.deepEqual((await services.llamafarmProgress()).downloads, [])
    const result = await services.llamafarmInstall({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', runtime: 'lmstudio' })
    assert.equal(result.ok, true)
    const { downloads } = await services.llamafarmProgress()
    const entry = downloads.find((d) => d.repo.includes('Qwen'))
    assert.ok(entry)
    assert.equal(entry.runtime, 'lmstudio')
    assert.equal(entry.status, 'done')
    assert.equal(entry.percent, 100)
    assert.equal(entry.totalBytes, 2048)
  })

  it('tracks an Ollama pull as live progress through to completion', async () => {
    let services: ReturnType<typeof createServices>
    let midPull: { status: string; percent: number | null; runtime: string } | null = null
    services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: gpuExec,
      pullModel: async () => {
        midPull = (await services.llamafarmProgress()).downloads.find((d) => d.runtime === 'ollama') ?? null
        return { ok: true, code: 0, output: '', error: null }
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF', runtime: 'ollama' })
    assert.equal(result.ok, true)
    assert.ok(midPull, 'an ollama progress entry exists during the pull')
    assert.equal(midPull.status, 'downloading')
    assert.equal(midPull.percent, null)
    const after = (await services.llamafarmProgress()).downloads.find((d) => d.runtime === 'ollama')
    assert.ok(after)
    assert.equal(after.status, 'done')
    assert.equal(after.percent, 100)
    assert.equal(after.receivedBytes, 0, 'a CLI-only pull must not report estimated bytes as measured traffic')
  })

  for (const offload of [undefined, 0]) {
    for (const throws of [false, true]) {
      it(`settles ${offload === undefined ? 'pull' : 'split install'} progress when the runner ${throws ? 'throws' : 'reports failure'}`, async () => {
        const fail = async () => {
          if (throws) throw new Error('Ollama disconnected')
          return { ok: false, code: 1, output: '', error: 'Ollama disconnected' }
        }
        const services = createServices({
          fetchImpl: farmFetch(), execFileImpl: gpuExec,
          pullModel: fail, runOllama: fail
        })
        await services.init()
        const result = await services.llamafarmInstall({ repo: QWEN.id, runtime: 'ollama', offload })
        assert.equal(result.ok, false)
        assert.equal(result.reason, 'failed')
        assert.equal(result.astrlink, null)
        assert.match(result.message, /Ollama disconnected/)
        const { downloads } = await services.llamafarmProgress()
        assert.equal(downloads.length, 1)
        assert.equal(downloads[0].status, 'error')
        assert.equal(downloads[0].error, 'Ollama disconnected')
        assert.equal(downloads[0].percent, null)
        assert.equal(downloads[0].receivedBytes, 0)
      })
    }
  }
})