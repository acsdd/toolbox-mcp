import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import type { ExecFileLike, FetchLike } from '@toolbox/widgets'
import { createServices } from '../dist/services.js'

const GiB = 2 ** 30
let home = ''

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-llamafarm-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

/** Canned HuggingFace + Ollama responses. */
function farmFetch(): FetchLike {
  const routes: Record<string, unknown> = {
    'http://127.0.0.1:11434/api/tags': {
      models: [{ name: 'qwen2.5-coder:7b', size: 4 * GiB, modified_at: '2026-11-01T00:00:00Z' }]
    }
  }
  const list = [
    {
      id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      pipeline_tag: 'text-generation',
      tags: ['gguf', 'license:apache-2.0'],
      downloads: 9000,
      likes: 500
    },
    {
      id: 'openai-community/gpt2',
      pipeline_tag: 'text-generation',
      tags: ['safetensors', 'license:mit'],
      downloads: 31775505,
      likes: 3919
    }
  ]
  for (const task of [
    'text-generation',
    'text-to-image',
    'text-to-speech',
    'image-to-text',
    'image-to-image',
    'text-to-video',
    'any-to-any',
    'automatic-speech-recognition'
  ]) {
    routes[`https://huggingface.co/api/models?pipeline_tag=${task}&sort=downloads&direction=-1&limit=24`] =
      task === 'text-generation' ? list : []
  }
  routes['https://huggingface.co/api/models/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF?blobs=true'] = {
    siblings: [
      { rfilename: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf', size: 4 * GiB, lfs: { size: 4 * GiB } }
    ],
    cardData: { license: 'apache-2.0' }
  }
  routes['https://huggingface.co/api/models/openai-community/gpt2?blobs=true'] = {
    siblings: [{ rfilename: 'model.safetensors', size: GiB, lfs: { size: GiB } }],
    cardData: { license: 'mit' }
  }
  return (async (url: string | URL) => {
    const body = routes[String(url)]
    if (body === undefined) return new Response('not found', { status: 404 })
    return new Response(JSON.stringify(body), { status: 200 })
  }) as FetchLike
}

const gpuExec: ExecFileLike = (_file, _args, _opts, cb) =>
  cb(null, JSON.stringify({ Name: 'RTX 4070', AdapterRAM: 12 * GiB }))

describe('llamafarm service', () => {
  it('detects the machine profile with injected probes', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const profile = await services.llamafarmStatus()
    assert.ok(profile.totalRamBytes > 0)
    assert.ok(profile.cores > 0)
    assert.equal(profile.ollama.installed, true)
    assert.equal(profile.ollama.models[0]?.name, 'qwen2.5-coder:7b')
    if (process.platform === 'win32') {
      assert.equal(profile.gpus[0]?.vramBytes, 12 * GiB)
    }
  })

  it('wave 1: with Ollama installed only GGUF repos enter the catalog', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const catalog = await services.llamafarmCatalog()
    assert.equal(catalog.error, null)
    assert.equal(catalog.models.length, 1)
    assert.ok(catalog.models[0]?.id.includes('Qwen'))
    assert.deepEqual(catalog.models[0]?.formats, ['gguf'])
  })

  it('scores, filters and groups the catalog by task', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const result = await services.llamafarmScore({ scenario: 'now' })
    assert.equal(result.scenario, 'now')
    assert.equal(result.groups.length, 1)
    assert.equal(result.groups[0]?.task, 'text-generation')
    const model = result.groups[0]?.models[0]
    assert.ok(model)
    assert.ok(['green', 'yellow', 'red'].includes(model.verdict))
    assert.ok(model.runtimeRamBytes > 0)

    const searched = await services.llamafarmScore({ scenario: 'now', search: 'zzz-no-match' })
    assert.equal(searched.total, 0)
    assert.equal(searched.groups.length, 0)

    const ranged = await services.llamafarmScore({ scenario: 'total', minParams: 100 })
    assert.equal(ranged.total, 0)
  })

  it('wave 3: onlyReachable hides reds without hints', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const all = await services.llamafarmScore({ scenario: 'now' })
    const reachable = await services.llamafarmScore({ scenario: 'now', onlyReachable: true })
    const redsAll = all.groups.flatMap((g) => g.models).filter((m) => m.verdict === 'red')
    const redsKept = reachable.groups.flatMap((g) => g.models).filter((m) => m.verdict === 'red')
    assert.ok(redsKept.every((m) => m.hints.length > 0))
    assert.ok(redsKept.length <= redsAll.length)
  })

  it('persists the catalog to disk and reloads it on init', async () => {
    const first = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await first.init()
    await first.llamafarmCatalog()

    const offline: FetchLike = (async () => {
      throw new Error('offline')
    }) as FetchLike
    const second = createServices({ fetchImpl: offline, execFileImpl: gpuExec })
    await second.init()
    const catalog = await second.llamafarmCatalog()
    assert.equal(catalog.models.length, 1)
    assert.ok(catalog.fetchedAt)
  })
})

describe('llamafarm install', () => {
  const ollamaExec: ExecFileLike = (_file, _args, _opts, cb) =>
    cb(null, 'ollama version is 0.5.4')

  it('pulls a GGUF model into Ollama', async () => {
    const pulled: string[] = []
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      pullModel: async (reference) => {
        pulled.push(reference)
        return { ok: true, code: 0, output: 'success', error: null }
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' })
    assert.equal(result.ok, true)
    assert.equal(result.reason, 'installed')
    assert.equal(result.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M')
    assert.ok(result.modelName)
    assert.deepEqual(pulled, ['hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M'])
    assert.ok(result.steps.some((step) => step.includes('ollama pull')))
  })

  it('reports a missing Ollama runtime instead of failing hard', async () => {
    const missing: ExecFileLike = (_file, _args, _opts, cb) =>
      cb(new Error('spawn ollama ENOENT'), '')
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: missing,
      pullModel: async () => {
        throw new Error('should not pull when Ollama is missing')
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'ollama-missing')
    assert.match(result.message, /Ollama is not installed/)
    assert.equal(result.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M')
  })

  it('reports an unknown repo as not-found', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: ollamaExec })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'acme/no-such-model' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'not-found')
    assert.match(result.message, /404/)
  })

  it('rejects checkpoints that are not published as GGUF', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: ollamaExec })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'openai-community/gpt2' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'failed')
    assert.match(result.message, /GGUF/)
  })

  it('surfaces a failing pull', async () => {
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      pullModel: async () => ({ ok: false, code: 1, output: 'pull failed', error: 'ollama exited with code 1' })
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' })
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'failed')
    assert.equal(result.output, 'pull failed')
  })

  it('creates a Modelfile when a GPU split is requested', async () => {
    const created: string[][] = []
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      runOllama: async (args) => {
        created.push(args)
        return { ok: true, code: 0, output: 'created', error: null }
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      offload: 20
    })
    assert.equal(result.ok, true)
    assert.equal(created.length, 1)
    assert.equal(created[0]?.[0], 'create')
    assert.equal(created[0]?.[1], result.modelName)
    assert.equal(created[0]?.[2], '--file')
  })
})

describe('panel', () => {
  it('allocates independent ports for portable windows', async () => {
    const { startPanel } = await import('../dist/panel.js')
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const first = await startPanel(services, { port: 0 })
    try {
      const second = await startPanel(services, { port: 0 })
      try {
        assert.ok(first.port > 0)
        assert.ok(second.port > 0)
        assert.notEqual(first.port, second.port)
        const page = await fetch(`http://127.0.0.1:${second.port}/`)
        assert.equal(page.status, 200)
        assert.match(await page.text(), /MODEL WANTS/)
      } finally {
        second.close()
      }
    } finally {
      first.close()
    }
  })

  it('serves the SPA, scores models and runs a terminal session', async () => {
    const { startPanel } = await import('../dist/panel.js')
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: gpuExec,
      pullModel: async () => ({ ok: true, code: 0, output: 'success', error: null })
    })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    const base = `http://127.0.0.1:${panel.port}`

    try {
      const page = await (await fetch(`${base}/`)).text()
      assert.ok(page.includes('Model Farm'))
      assert.ok(page.includes('Terminal'))

      const score = await (
        await fetch(`${base}/api/llamafarm/score`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scenario: 'now' })
        })
      ).json() as { groups: Array<{ task: string; models: Array<{ grade: { letter: string; score: number; axes: unknown[]; bottleneck: { kind: string } } }> }>; machineGrade: { score: number; axes: unknown[] } }
      assert.equal(score.groups[0]?.task, 'text-generation')
      assert.equal(score.machineGrade.axes.length, 4)
      assert.ok(score.machineGrade.score >= 0 && score.machineGrade.score <= 100)
      const graded = score.groups[0]?.models[0]?.grade
      assert.ok(graded)
      assert.equal(graded.axes.length, 4)
      assert.match(graded.letter, /^(A\+|A|B|C|D|F)$/)
      assert.ok(['machine', 'model'].includes(graded.bottleneck.kind))
      assert.ok(page.includes('MODEL WANTS'), 'the panel renders the numeric scorecard')
      assert.ok(page.includes('HEADROOM'))

      const install = await (
        await fetch(`${base}/api/llamafarm/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' })
        })
      ).json() as { ok: boolean; reference: string; reason: string }
      assert.equal(install.ok, true)
      assert.equal(install.reason, 'installed')
      assert.equal(install.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M')

      const started = await (await fetch(`${base}/api/terminal/start`, { method: 'POST' })).json() as { running: boolean }
      assert.equal(started.running, true)
      await fetch(`${base}/api/terminal/input`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: process.platform === 'win32' ? 'Write-Output farm-ok\r\n' : 'echo farm-ok\n' })
      })
      let output = ''
      for (let attempt = 0; attempt < 40; attempt++) {
        const body = await (await fetch(`${base}/api/terminal/output`)).json() as { output: string }
        output = body.output
        if (output.includes('farm-ok')) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.ok(output.includes('farm-ok'), 'terminal should echo command output')
      const stopped = await (await fetch(`${base}/api/terminal/stop`, { method: 'POST' })).json() as { running: boolean }
      assert.equal(stopped.running, false)
    } finally {
      panel.close()
    }
  })
})

describe('llamafarm grade exposure', () => {
  it('exposes the machine grade through the status report', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const report = await services.llamafarmStatusReport()
    assert.ok(report.totalRamBytes > 0)
    assert.ok(report.cores > 0)
    assert.equal(report.grade.axes.length, 4)
    assert.ok(report.grade.score >= 0 && report.grade.score <= 100)
    assert.equal(typeof report.grade.label, 'string')
  })

  it('grades the machine alone when no repo is given', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const result = await services.llamafarmGrade({})
    assert.equal(result.model, null)
    assert.equal(result.grade, null)
    assert.equal(result.error, null)
    assert.equal(result.machineGrade.axes.length, 4)
    assert.equal(result.scenario, 'now')
  })

  it('grades a specific repo against the machine', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const result = await services.llamafarmGrade({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      scenario: 'total'
    })
    assert.ok(result.model && result.model.id.includes('Qwen'))
    assert.ok(result.grade)
    assert.equal(result.grade.axes.length, 4)
    assert.equal(result.grade.scenario, 'total')
    assert.ok(['machine', 'model'].includes(result.grade.bottleneck.kind))
    assert.equal(result.error, null)
  })

  it('reports a clean error for an unknown repo', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const result = await services.llamafarmGrade({ repo: 'owner/does-not-exist' })
    assert.equal(result.grade, null)
    assert.equal(result.model, null)
    assert.ok(result.error && result.error.length > 0)
  })
})
