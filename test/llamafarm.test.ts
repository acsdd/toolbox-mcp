import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { runInNewContext } from 'node:vm'
import type { ExecFileLike, FetchLike } from '@toolbox/widgets'
import { createServices } from '../dist/services.js'

const GiB = 2 ** 30
let home = ''
let panelScript: Promise<string> | undefined
let panelPage: Promise<string> | undefined

// Reuse the immutable served script; every test still gets a fresh VM and DOM.
// Starting a terminal-owning panel for every assertion needlessly adds listeners.
function servedPanelPage(): Promise<string> {
  panelPage ??= (async () => {
    const { startPanel } = await import('../dist/panel.js')
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    try {
      return await (await fetch(`http://127.0.0.1:${panel.port}/`)).text()
    } finally {
      panel.close()
    }
  })()
  return panelPage
}

function servedPanelScript(): Promise<string> {
  panelScript ??= servedPanelPage().then((page) => {
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
    assert.ok(script)
    return script
  })
  return panelScript
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-llamafarm-'))
  process.env.TOOLBOX_MCP_HOME = home
})

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  await rm(home, { recursive: true, force: true })
})

/** Canned HuggingFace + Ollama responses. */
function farmFetch(ollamaUp = true): FetchLike {
  const routes: Record<string, unknown> = {}
  if (ollamaUp) {
    routes['http://127.0.0.1:11434/api/tags'] = {
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
    assert.ok(
      result.groups.flatMap((group) => group.models).every((entry) => entry.formats.includes('gguf')),
      'the farm only lists models Ollama can pull'
    )

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

  it('drops cached safetensors checkpoints Ollama can never pull', async () => {
    // Old caches wrote safetensors repos (e.g. SmolLM2-135M) that Ollama has
    // no way to import. They must not survive into the served catalog, even
    // when the follow-up refetch fails and the cache is all we have.
    const stale = {
      fetchedAt: Date.now(),
      models: [
        {
          id: 'HuggingFaceTB/SmolLM2-135M',
          task: 'text-generation',
          label: 'SmolLM2-135M',
          author: 'HuggingFaceTB',
          formats: ['safetensors'],
          paramsBillions: 0.14,
          quantLabel: null,
          fileBytes: 269060552,
          runtimeRamBytes: 336325690,
          downloads: 163870,
          likes: 500,
          license: 'apache-2.0',
          tags: ['safetensors'],
          hfUrl: 'https://huggingface.co/HuggingFaceTB/SmolLM2-135M'
        },
        {
          id: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
          task: 'text-generation',
          label: 'Qwen2.5-Coder-7B-Instruct',
          author: 'Qwen',
          formats: ['gguf'],
          paramsBillions: 7,
          quantLabel: 'Q4_K_M',
          fileBytes: 4 * GiB,
          runtimeRamBytes: 5 * GiB,
          downloads: 9000,
          likes: 500,
          license: 'apache-2.0',
          tags: ['gguf'],
          hfUrl: 'https://huggingface.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF'
        }
      ]
    }
    await writeFile(join(home, 'llamafarm-cache.json'), JSON.stringify(stale), 'utf8')

    const offline: FetchLike = (async () => {
      throw new Error('offline')
    }) as FetchLike
    const services = createServices({ fetchImpl: offline, execFileImpl: gpuExec })
    await services.init()
    const catalog = await services.llamafarmCatalog()
    assert.ok(catalog.error !== null, 'a mixed-format cache forces a refetch attempt')
    assert.deepEqual(
      catalog.models.map((model) => model.id),
      ['Qwen/Qwen2.5-Coder-7B-Instruct-GGUF']
    )
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
      freeDiskImpl: async () => 100 * GiB,
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
    assert.deepEqual(result.astrlink, {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M',
      capability: 'openai.chat'
    })
  })

  it('uses the requested quantization in the AstrLink model setting', async () => {
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * GiB,
      pullModel: async () => ({ ok: true, code: 0, output: 'success', error: null })
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      quant: 'Q8_0'
    })
    assert.equal(result.astrlink?.model, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q8_0')
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
    assert.equal(result.astrlink, null, 'failed installs must not offer gateway setup')
    assert.equal(result.reason, 'ollama-missing')
    assert.match(result.message, /Ollama is not installed/)
    assert.equal(result.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M')
  })

  it('reports an unknown repo as not-found', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: ollamaExec })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'acme/no-such-model' })
    assert.equal(result.ok, false)
    assert.equal(result.astrlink, null, 'failed installs must not offer gateway setup')
    assert.equal(result.reason, 'not-found')
    assert.match(result.message, /404/)
  })

  it('rejects checkpoints that are not published as GGUF', async () => {
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: ollamaExec })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'openai-community/gpt2' })
    assert.equal(result.ok, false)
    assert.equal(result.astrlink, null, 'failed installs must not offer gateway setup')
    assert.equal(result.reason, 'failed')
    assert.match(result.message, /GGUF/)
  })

  it('surfaces a failing pull', async () => {
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * GiB,
      pullModel: async () => ({ ok: false, code: 1, output: 'pull failed', error: 'ollama exited with code 1' })
    })
    await services.init()
    const result = await services.llamafarmInstall({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' })
    assert.equal(result.ok, false)
    assert.equal(result.astrlink, null, 'failed installs must not offer gateway setup')
    assert.equal(result.reason, 'failed')
    assert.equal(result.output, 'pull failed')
  })

  it('creates a Modelfile when a GPU split is requested', async () => {
    const created: string[][] = []
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * GiB,
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
    assert.deepEqual(result.astrlink, {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-coder-7b-instruct',
      capability: 'openai.chat'
    })
    assert.equal(result.steps.at(-1), 'ollama run qwen2.5-coder-7b-instruct')
  })

  it('keeps the created model name for a zero-layer GPU split', async () => {
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * GiB,
      runOllama: async () => ({ ok: true, code: 0, output: 'created', error: null })
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      offload: 0
    })
    assert.equal(result.astrlink?.model, 'qwen2.5-coder-7b-instruct')
  })

  it('does not offer AstrLink setup when creating the split model fails', async () => {
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      runOllama: async () => ({ ok: false, code: 1, output: 'create failed', error: 'create failed' })
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      offload: 20
    })
    assert.equal(result.ok, false)
    assert.equal(result.astrlink, null)
  })

  it('installs the repository default when Ollama cannot tag the quantization', async () => {
    const pulled: string[] = []
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * GiB,
      pullModel: async (reference) => {
        pulled.push(reference)
        return { ok: true, code: 0, output: 'success', error: null }
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      quant: 'Q8'
    })
    assert.equal(result.ok, true)
    assert.deepEqual(pulled, ['hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:latest'])
    assert.equal(result.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:latest')
    assert.match(result.message, /repository default/i)
  })

  it('records the reference Ollama actually used', async () => {
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * GiB,
      pullModel: async () => ({
        ok: true,
        code: 0,
        output: 'success',
        error: null,
        reference: 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:latest'
      })
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      quant: 'Q8_0'
    })
    assert.equal(result.ok, true)
    assert.equal(result.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:latest')
    assert.equal(result.astrlink?.model, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:latest')
    assert.match(result.message, /repository default/i)
  })

  it('retries the split create with the repository default', async () => {
    const created: string[][] = []
    const services = createServices({
      fetchImpl: farmFetch(),
      execFileImpl: ollamaExec,
      freeDiskImpl: async () => 100 * GiB,
      runOllama: async (args) => {
        created.push(args)
        if (created.length === 1) {
          return {
            ok: false,
            code: 1,
            output:
              'Error: pull model manifest: 400: {"error":"The specified tag is not available in the repository."}',
            error: 'tag rejected'
          }
        }
        return { ok: true, code: 0, output: 'created', error: null }
      }
    })
    await services.init()
    const result = await services.llamafarmInstall({
      repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF',
      offload: 20
    })
    assert.equal(result.ok, true)
    assert.equal(created.length, 2)
    assert.equal(result.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:latest')
    assert.match(result.message, /repository default/i)
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
      freeDiskImpl: async () => 100 * GiB,
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
      assert.ok(page.includes('safetensors only'), 'non-GGUF models get a note instead of an install button')

      const install = await (
        await fetch(`${base}/api/llamafarm/install`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repo: 'Qwen/Qwen2.5-Coder-7B-Instruct-GGUF' })
        })
      ).json() as { ok: boolean; reference: string; reason: string; astrlink: unknown }
      assert.equal(install.ok, true)
      assert.equal(install.reason, 'installed')
      assert.equal(install.reference, 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M')
      assert.deepEqual(install.astrlink, {
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'hf.co/Qwen/Qwen2.5-Coder-7B-Instruct-GGUF:Q4_K_M',
        capability: 'openai.chat'
      })

      const started = await (await fetch(`${base}/api/terminal/start`, { method: 'POST' })).json() as { running: boolean }
      assert.equal(started.running, true)
      const shell = process.platform === 'win32' ? 'Write-Output' : 'echo'
      const eol = process.platform === 'win32' ? '\r\n' : '\n'
      const send = (data: string) =>
        fetch(`${base}/api/terminal/input`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ data })
        })
      const readOutput = async (): Promise<string> => {
        const body = await (await fetch(`${base}/api/terminal/output`)).json() as { output: string }
        return body.output
      }
      // The shell is a real process: it can still be starting up when the
      // panel reports it as running. Probe it until it answers before sending
      // the real command, otherwise the first input is lost and the test fails
      // for reasons that have nothing to do with the code under test.
      let output = ''
      let probes = 0
      for (let attempt = 0; attempt < 80; attempt++) {
        if (probes < 3 && attempt % 4 === 0) {
          await send(`${shell} farm-ready${eol}`)
          probes += 1
        }
        output = await readOutput()
        if (output.includes('farm-ready')) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      assert.ok(output.includes('farm-ready'), 'the shell should answer a probe')
      await send(`${shell} farm-ok${eol}`)
      for (let attempt = 0; attempt < 40; attempt++) {
        output = await readOutput()
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

describe('Model Farm setup panel', () => {
  const repo = 'Qwen/Model-GGUF'
  const installed = {
    ok: true, repo, reference: 'hf.co/Qwen/Model-GGUF:Q4_K_M', modelName: 'model',
    reason: 'installed', message: 'ready', output: 'success',
    steps: ['ollama run hf.co/Qwen/Model-GGUF:Q4_K_M'],
    astrlink: {
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'hf.co/Qwen/Model-GGUF:Q4_K_M',
      capability: 'openai.chat'
    }
  }
  const setupText = 'Provider: OpenAI-compatible\nBase URL: http://127.0.0.1:11434/v1\nModel: hf.co/Qwen/Model-GGUF:Q4_K_M\nCapability: openai.chat'

  async function clientFor(reply: (init?: RequestInit) => Promise<Response>, writeText: (text: string) => Promise<void>, quants: unknown[] = [], readReply?: (url: string, init?: RequestInit) => Promise<Response>) {
    const script = await servedPanelScript()
    // Capture writes and scrolling at the DOM boundary while executing the real, complete panel script.
    const scrollRequests: number[] = []
    const eventHandlers = new Map<string, Map<string, (event: Record<string, unknown>) => unknown>>()
    // The terminal output arrives over SSE; the stub lets a test push a chunk.
    const eventSources: { url: string; onmessage: ((event: { data: string }) => void) | null }[] = []
    class FakeEventSource {
      url: string
      onmessage: ((event: { data: string }) => void) | null = null
      constructor(url: string) {
        this.url = url
        eventSources.push(this)
      }
    }
    const element = (id = '') => ({
      id,
      innerHTML: '', textContent: '', value: '', scrollLeft: 0, clientWidth: 500,
      scrollTop: 0, scrollHeight: 0, clientHeight: 0,
      selectionStart: 0, selectionEnd: 0, focused: false,
      classList: { toggle() {}, contains() { return true }, add() {}, remove() {} },
      addEventListener(name: string, handler: (event: Record<string, unknown>) => unknown) {
        if (!id) return
        if (!eventHandlers.has(id)) eventHandlers.set(id, new Map())
        eventHandlers.get(id)!.set(name, handler)
      },
      focus() { this.focused = true },
      setRangeText(text: string, start: number, end: number) {
        this.value = this.value.slice(0, start) + text + this.value.slice(end)
        this.selectionStart = this.selectionEnd = start + text.length
      },
      scrollBy(options: { left: number }) { scrollRequests.push(options.left) },
      appendChild(child: { innerHTML: string }) { this.innerHTML += child.innerHTML }
    })
    const elements = new Map<string, ReturnType<typeof element>>()
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, element(id))
      return elements.get(id)!
    }
    const client = runInNewContext(script + '\n;({ mf, rt, show, mfLoad, mfSearch, mfInstall, mfRemove, mfRunNow, mfQuants, mfPickQuant, mfSaveNote: typeof mfSaveNote === "function" ? mfSaveNote : null, mfSetTaskFilter, mfScrollColumns, termStart: termStart, copy: function(id) { return mfCopyAstrlink(id) }, setResult: function(value) { lastResult = value; renderGroups(value) } })', {
      document: {
        getElementById: get, createElement: element,
        querySelector: get,
        querySelectorAll: (selector: string) => selector === 'textarea.mnote-input'
          ? [...elements.entries()]
            .filter(([id]) => id.startsWith('mf-note-') && !id.startsWith('mf-note-status-'))
            .map(([, el]) => el)
          : []
      },
      navigator: { clipboard: { writeText } },
      EventSource: FakeEventSource,
      fetch: (url: string, init?: RequestInit) => url === '/api/llamafarm/install' ? reply(init)
        : readReply ? readReply(url, init) : Promise.resolve(Response.json(url === '/api/llamafarm/quants' ? { quants } : {})),
      // Timers are stubbed: the panel polls its activity feed while the
      // overview is visible, and a test has no reason to wait for that.
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 1,
      clearInterval: () => {}
    })
    client.mf.expanded[repo] = true
    client.setResult({ total: 1, fetchedAt: 1, groups: [{
      label: 'Text generation', icon: 'T', models: [{
        id: repo, label: 'Model', formats: ['gguf'], hints: [], verdict: 'green',
        runtimeRamBytes: GiB, downloads: 1, hfUrl: 'https://huggingface.co/' + repo, reason: 'Fits'
      }]
    }] })
    return { client, markup: () => get('mf-cols').innerHTML, quantNote: () => get('mf-quant-note-' + repo).innerHTML,
      purposeMarkup: () => get('mf-purpose-filters').innerHTML, scrollRequests,
      recentMarkup: () => get('mf-recent').innerHTML,
      noteInput: (id: string) => get('mf-note-' + id),
      terminalInput: get('term-in'),
      terminalOutput: get('term-out'),
      eventSources,
      terminalKeydown: (event: Record<string, unknown>) => eventHandlers.get('term-in')?.get('keydown')?.(event),
      picksMarkup: () => get('mf-runnow').innerHTML, status: () => get('mf-status').innerHTML }
  }

  it('filters model columns by purpose and exposes horizontal scroll controls', async () => {
    const { client, markup, purposeMarkup, scrollRequests } = await clientFor(async () => Response.json(installed), async () => {})
    const model = (id: string) => ({ id, label: id, formats: ['gguf'], hints: [], verdict: 'green', runtimeRamBytes: GiB, downloads: 1, hfUrl: 'https://huggingface.co/' + id })
    client.setResult({ total: 3, groups: [
      { task: 'text-generation', label: 'Text generation', icon: 'T', models: [model('Qwen-Coder')] },
      { task: 'text-to-image', label: 'Text to image', icon: 'I', models: [model('Stable-Diffusion')] },
      { task: 'image-to-image', label: 'Image to image', icon: 'E', models: [model('Photo-Editor')] }
    ] })

    assert.match(purposeMarkup(), /Chat &amp; coding/)
    assert.match(purposeMarkup(), /Generate artwork/)
    assert.match(purposeMarkup(), /Edit photos/)
    client.mfSetTaskFilter('image-to-image')
    assert.match(markup(), /Photo-Editor/)
    assert.doesNotMatch(markup(), /Qwen-Coder|Stable-Diffusion/)
    client.mfSetTaskFilter('')
    assert.match(markup(), /Qwen-Coder/)
    assert.match(markup(), /Stable-Diffusion/)

    client.mfScrollColumns(1)
    assert.equal(scrollRequests.length, 1)
    assert.ok(scrollRequests[0] > 0)
  })

  it('keeps focus in the terminal prompt when Tab requests completion', async () => {
    const { terminalKeydown, terminalInput } = await clientFor(async () => Response.json(installed), async () => {})
    let prevented = false
    await terminalKeydown!({ key: 'Tab', shiftKey: false, preventDefault() { prevented = true } })

    assert.equal(prevented, true)
    assert.equal(terminalInput.focused, true)
  })

  it('applies and cycles shell completion matches while keeping prompt focus', async () => {
    const { terminalKeydown, terminalInput } = await clientFor(
      async () => Response.json(installed), async () => {}, [],
      async (url) => url === '/api/terminal/complete'
        ? Response.json({ supported: true, candidates: ['Get-ChildItem', 'Get-ChildItemProperty'], replacementIndex: 0, replacementLength: 7 })
        : Response.json({})
    )
    terminalInput.value = 'Get-Chi'
    terminalInput.selectionStart = terminalInput.selectionEnd = terminalInput.value.length
    const key = { key: 'Tab', shiftKey: false, preventDefault() {} }

    await terminalKeydown!(key)
    assert.equal(terminalInput.value, 'Get-ChildItem')
    assert.equal(terminalInput.focused, true)
    await terminalKeydown!(key)
    assert.equal(terminalInput.value, 'Get-ChildItemProperty')
    assert.equal(terminalInput.focused, true)
  })

  it('sends a cursor at the start of the terminal command unchanged', async () => {
    let request: { line: string; cursor: number } | null = null
    const { terminalKeydown, terminalInput } = await clientFor(
      async () => Response.json(installed), async () => {}, [],
      async (url, init) => {
        if (url === '/api/terminal/complete') request = JSON.parse(String(init?.body))
        return Response.json({ supported: true, candidates: ['Get-ChildItem'], replacementIndex: 0, replacementLength: 0 })
      }
    )
    terminalInput.value = 'Get-ChildItem'
    terminalInput.selectionStart = terminalInput.selectionEnd = 0
    await terminalKeydown!({ key: 'Tab', shiftKey: false, preventDefault() {} })
    assert.deepEqual(request, { line: 'Get-ChildItem', cursor: 0 })
  })

  it('keeps the terminal output inside its own scroll region', async () => {
    const page = await servedPanelPage()
    const terminalRule = /\.term\s*\{([^}]*)\}/.exec(page)?.[1] ?? ''
    const outputRule = /\.term-out\s*\{([^}]*)\}/.exec(page)?.[1] ?? ''

    // An auto-height flex column lets the output grow with its content and
    // pushes the prompt below the fold, so the terminal box needs a definite
    // height and the output region needs to be allowed to shrink.
    assert.match(terminalRule, /height:\s*min\(/, 'the terminal box has a definite height')
    assert.match(outputRule, /min-height:\s*0/, 'the output region can shrink')
    assert.match(outputRule, /overflow:\s*auto/, 'the output region scrolls on its own')
  })

  it('follows new terminal output only while the user reads the tail', async () => {
    const { client, terminalOutput, eventSources } = await clientFor(async () => Response.json(installed), async () => {})
    await client.termStart()
    const source = eventSources[0]
    assert.ok(source, 'the terminal opens an output stream')

    terminalOutput.scrollHeight = 5000
    terminalOutput.clientHeight = 400

    // The user scrolled up to read earlier output: new lines must not yank the view.
    terminalOutput.scrollTop = 0
    source.onmessage!({ data: JSON.stringify('first chunk\n') })
    assert.equal(terminalOutput.scrollTop, 0, 'the reading position is preserved')

    // Back at the tail: new output follows.
    terminalOutput.scrollTop = 4600
    source.onmessage!({ data: JSON.stringify('second chunk\n') })
    assert.equal(terminalOutput.scrollTop, 5000, 'the tail follows new output')
  })

  it('keeps the prompt usable while output streams in', async () => {
    const sent: string[] = []
    const { client, terminalInput, terminalKeydown, eventSources } = await clientFor(
      async () => Response.json(installed), async () => {}, [],
      async (url, init) => {
        if (url === '/api/terminal/input') sent.push(String(init?.body))
        return Response.json({})
      }
    )
    await client.termStart()
    eventSources[0].onmessage!({ data: JSON.stringify('busy\n') })

    terminalInput.value = 'echo hi'
    await terminalKeydown!({ key: 'Enter', preventDefault() {} })

    assert.equal(sent.length, 1, 'the command is still submitted while output streams')
    assert.deepEqual(JSON.parse(sent[0]), { data: 'echo hi\r\n' })
    assert.equal(terminalInput.value, '', 'the prompt is cleared for the next command')
    assert.equal(terminalInput.focused, true, 'the prompt keeps focus')
  })

  for (const action of ['install', 'remove']) {
    for (const view of ['catalog', 'search']) {
      it(`refreshes ${view} badges and visible run-now picks after ${action}`, async () => {
        let present = action === 'remove'
        const model = () => ({ id: repo, label: 'Model', formats: ['gguf'], hints: [], verdict: 'green',
          runtimeRamBytes: GiB, downloads: 1, hfUrl: 'https://huggingface.co/' + repo, reason: 'Fits',
          installed: present ? 'model:Q4_K_M' : null })
        const result = () => ({ total: 1, fetchedAt: 1, ...(view === 'search' ? { query: 'original query' } : {}),
          machine: { availableRamBytes: 8 * GiB, totalRamBytes: 16 * GiB, cores: 8, gpus: [], freeDiskBytes: 10 * GiB,
            ollama: { installed: true, models: present ? [{ name: 'model:Q4_K_M' }] : [], error: null } },
          groups: [{ label: 'Text generation', icon: 'T', models: [model()] }] })
        const queries: string[] = []
        const { client, markup, picksMarkup } = await clientFor(async () => {
          present = true
          return Response.json(installed)
        }, async () => {}, [], async (url, init) => {
          if (url === '/api/llamafarm/remove') {
            present = false
            return Response.json({ ok: true, message: 'Removed' })
          }
          if (url === '/api/llamafarm/run-now') return Response.json({ picks: [{ label: 'Text generation', model: model() }] })
          if (url === '/api/llamafarm/search') {
            queries.push(JSON.parse(String(init?.body)).query)
            return Response.json(result())
          }
          if (url === '/api/llamafarm/score') return Response.json({ ...result(), query: undefined })
          return Response.json({})
        })
        client.setResult(result())
        client.mf.quants[repo] = { state: 'ok', chosen: 'Q8_0', list: [{ quant: 'Q8_0', sizeBytes: GiB }] }
        await client.mfRunNow()
        if (action === 'install') await client.mfInstall(repo)
        else await client.mfRemove(repo, 'model:Q4_K_M')
        if (present) {
          assert.match(markup(), /class="mf-inst"/)
          assert.match(picksMarkup(), /class="mf-inst"/)
          assert.match(markup(), /Copy setup/)
        } else {
          assert.doesNotMatch(markup(), /class="mf-inst"/)
          assert.match(picksMarkup(), /needs download/)
        }
        assert.equal(client.mf.expanded[repo], true)
        assert.equal(client.mf.quants[repo].chosen, 'Q8_0')
        assert.deepEqual(queries, view === 'search' ? ['original query'] : [])
      })
    }
  }

  for (const runtime of ['ollama', 'lmstudio']) {
    it(`offers removal only for an explicitly owned Ollama model, not ${runtime}`, async () => {
      let payload: Record<string, unknown> = {}
      const { client, markup } = await clientFor(async () => Response.json(installed), async () => {}, [], async (url, init) => {
        if (url === '/api/llamafarm/remove') payload = JSON.parse(String(init?.body))
        return Response.json({ ok: false, message: 'fixture no-op' })
      })
      client.rt.data = { active: runtime, runtimes: [{ id: runtime, label: runtime === 'lmstudio' ? 'LM Studio' : 'Ollama' }] }
      client.setResult({ total: 1, groups: [{ label: 'Text generation', icon: 'T', models: [{
        id: repo, label: 'Model', formats: ['gguf'], hints: [], verdict: 'green', downloads: 1,
        hfUrl: 'https://huggingface.co/' + repo, runtimeRamBytes: GiB, installed: 'local-model', installedRuntime: runtime
      }] }] })
      if (runtime === 'ollama') {
        assert.match(markup(), />Remove from Ollama</)
        await client.mfRemove(repo, 'local-model', runtime)
        assert.equal(payload.runtime, 'ollama')
      } else {
        assert.doesNotMatch(markup(), /onclick="mfRemove/)
        assert.match(markup(), /Manage.*LM Studio/i)
      }
    })
  }

  for (const view of ['catalog', 'search']) {
    it(`keeps the requested ${view} view when an install finishes during navigation`, async () => {
      let finishInstall!: (response: Response) => void
      let finishNavigation!: (response: Response) => void
      const reads: string[] = []
      const result = (label: string, query?: string) => ({ total: 1, query,
        machine: { totalRamBytes: 16 * GiB, availableRamBytes: 8 * GiB, cores: 8, gpus: [], ollama: { installed: true, models: [] } },
        groups: [{ label: 'Text generation', icon: 'T', models: [{ id: repo, label, formats: ['gguf'], hints: [], verdict: 'green', runtimeRamBytes: GiB, downloads: 1, reason: 'Fits' }] }] })
      const { client, markup } = await clientFor(() => new Promise((resolve) => { finishInstall = resolve }), async () => {}, [], async (url, init) => {
        if (!url.startsWith('/api/llamafarm/')) return Response.json({})
        const query = url.endsWith('/search') ? JSON.parse(String(init?.body)).query : undefined
        reads.push(query ?? 'catalog')
        if (reads.length === 1) return new Promise((resolve) => { finishNavigation = resolve })
        return Response.json(result(query === 'old query' ? 'old view' : 'new view', query))
      })
      client.setResult(result('old view', 'old query'))
      const install = client.mfInstall(repo)
      const navigation = view === 'search' ? client.mfSearch('new query') : client.mfLoad()
      finishInstall(Response.json(installed))
      await install
      finishNavigation(Response.json(result('new view', view === 'search' ? 'new query' : undefined)))
      await navigation
      assert.match(markup(), /new view/)
      assert.doesNotMatch(markup(), /old view/)
      assert.deepEqual(reads, view === 'search' ? ['new query', 'new query'] : ['catalog', 'catalog'])
    })
  }

  for (const view of ['catalog', 'search', 'run-now']) {
    it(`keeps the newer ${view} refresh when an older response arrives last`, async () => {
      let release!: (response: Response) => void
      let reads = 0
      const response = (label: string) => {
        const model = { id: repo, label, formats: ['gguf'], hints: [], verdict: 'green', runtimeRamBytes: GiB, reason: 'Fits', downloads: 1, hfUrl: 'https://huggingface.co/' + repo }
        return Response.json({ total: 1, query: view === 'search' ? 'query' : undefined,
          machine: { availableRamBytes: 8 * GiB, totalRamBytes: 16 * GiB, cores: 8, gpus: [], ollama: { installed: true, models: [] } },
          groups: [{ label: 'Text generation', icon: 'T', models: [model] }],
          picks: [{ label: 'Text generation', model }] })
      }
      const { client, markup, picksMarkup } = await clientFor(async () => Response.json(installed), async () => {}, [], async (url) => {
        if (!url.startsWith('/api/llamafarm/')) return Response.json({})
        if (++reads === 1) return new Promise((resolve) => { release = resolve })
        return response('newer result')
      })
      const refresh = () => view === 'catalog' ? client.mfLoad() : view === 'search' ? client.mfSearch('query') : client.mfRunNow()
      const older = refresh()
      await refresh()
      release(response('outdated result'))
      await older
      const html = view === 'run-now' ? picksMarkup() : markup()
      assert.match(html, /newer result/)
      assert.doesNotMatch(html, /outdated result/)
    })
  }

  it('shows successful setup and copies the exact displayed settings', async () => {
    let copied = ''
    const { client, markup } = await clientFor(
      async () => Response.json(installed), async (text) => { copied = text }
    )
    await client.mfInstall(repo)
    assert.match(markup(), /Copy setup/)
    assert.match(markup(), /http:\/\/127\.0\.0\.1:11434\/v1/)
    assert.match(markup(), /hf\.co\/Qwen\/Model-GGUF:Q4_K_M/)
    assert.match(markup(), /openai\.chat/)
    assert.match(markup(), /ollama run hf\.co\/Qwen\/Model-GGUF:Q4_K_M/)
    await client.copy(repo)
    assert.equal(copied, setupText)
    assert.match(markup(), /Copied/)
  })

  it('keeps setup selectable when clipboard access fails', async () => {
    const { client, markup } = await clientFor(
      async () => Response.json(installed), async () => { throw new Error('clipboard denied') }
    )
    await client.mfInstall(repo)
    assert.match(markup(), /Copy setup/)
    await client.copy(repo)
    assert.match(markup(), /select and copy/i)
    assert.doesNotMatch(markup(), /Copied/)
    assert.match(markup(), /hf\.co\/Qwen\/Model-GGUF:Q4_K_M/)
  })

  it('clears the previous setup while retrying and after a failed install', async () => {
    let reply = async () => Response.json(installed)
    const { client, markup } = await clientFor(() => reply(), async () => {})
    await client.mfInstall(repo)
    assert.match(markup(), /Copy setup/)
    let finish!: (response: Response) => void
    reply = () => new Promise<Response>((resolve) => { finish = resolve })
    const pending = client.mfInstall(repo)
    assert.doesNotMatch(markup(), /Copy setup|openai\.chat/)
    finish(Response.json({ ...installed, ok: false, reason: 'failed', message: 'pull failed', astrlink: null }))
    await pending
    assert.match(markup(), /pull failed/)
    assert.doesNotMatch(markup(), /Copy setup|openai\.chat/)
  })

  it('keeps progress polling until every concurrent install finishes', async () => {
    const replies = new Map<string, (response: Response) => void>()
    const other = 'acme/Other-GGUF'
    const { client } = await clientFor((init) => new Promise((resolve) => {
      replies.set(JSON.parse(String(init?.body)).repo, resolve)
    }), async () => {})
    const first = client.mfInstall(repo)
    const second = client.mfInstall(other)
    replies.get(repo)!(Response.json(installed))
    await first
    assert.ok(client.mf.progressTimer, 'the other install still needs polling')
    replies.get(other)!(Response.json({ ...installed, repo: other }))
    await second
    assert.equal(client.mf.progressTimer, null)
  })

  it('stops progress when an overlapping removal is the last operation to finish', async () => {
    let finishInstall!: (response: Response) => void
    let finishRemove!: (response: Response) => void
    const { client } = await clientFor(() => new Promise((resolve) => { finishInstall = resolve }), async () => {}, [], (url) =>
      url === '/api/llamafarm/remove' ? new Promise((resolve) => { finishRemove = resolve }) : Promise.resolve(Response.json({})))
    const install = client.mfInstall(repo)
    const remove = client.mfRemove('acme/other-GGUF', 'other')
    finishInstall(Response.json(installed))
    await install
    finishRemove(Response.json({ ok: true, message: 'Removed' }))
    await remove
    assert.equal(client.mf.progressTimer, null)
  })

  it('does not expose setup from an unsuccessful HTTP response', async () => {
    const { client, markup } = await clientFor(
      async () => Response.json(installed, { status: 500 }), async () => {}
    )
    await client.mfInstall(repo)
    assert.equal(client.mf.install[repo].state, 'err')
    assert.doesNotMatch(markup(), /Copy setup|openai\.chat/)
  })

  it('escapes model text rather than treating it as HTML', async () => {
    const model = '<img src=x onerror="alert(1)">'
    let copied = ''
    const { client, markup } = await clientFor(
      async () => Response.json({ ...installed, astrlink: { ...installed.astrlink, model } }),
      async (text) => { copied = text }
    )
    await client.mfInstall(repo)
    assert.match(markup(), /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/)
    assert.doesNotMatch(markup(), /<img/)
    await client.copy(repo)
    assert.ok(copied.includes('Model: ' + model))
  })

  it('marks each quant fit against free disk and warns on a chosen quant that will not fit', async () => {
    const { client, markup } = await clientFor(async () => Response.json(installed), async () => {})
    client.mf.quants[repo] = {
      state: 'ok', chosen: 'Q8_0',
      list: [
        { quant: 'Q4_K_M', filename: 'm-q4_k_m.gguf', sizeBytes: 2 * GiB },
        { quant: 'Q8_0', filename: 'm-q8_0.gguf', sizeBytes: 9 * GiB }
      ]
    }
    client.setResult({
      total: 1, fetchedAt: 1, machine: { freeDiskBytes: 5 * GiB },
      groups: [{
        label: 'Text generation', icon: 'T', models: [{
          id: repo, label: 'Model', formats: ['gguf'], hints: [], verdict: 'green',
          runtimeRamBytes: GiB, downloads: 1, hfUrl: 'https://huggingface.co/' + repo,
          reason: 'Fits', quantLabel: 'Q4_K_M'
        }]
      }]
    })
    assert.match(markup(), /too big/)
    assert.match(markup(), /fits/)
    assert.match(markup(), /short/)
  })

  const pickerQuants = [
    { quant: 'Q4_K_M', filename: 'm-q4_k_m.gguf', sizeBytes: 2 * GiB },
    { quant: 'Q8_0', filename: 'm-q8_0.gguf', sizeBytes: 9 * GiB }
  ]
  const pickerResult = (quantLabel = 'Q4_K_M') => ({
    total: 1, fetchedAt: 1, machine: { freeDiskBytes: 5 * GiB },
    groups: [{ label: 'Text generation', icon: 'T', models: [{
      id: repo, label: 'Model', formats: ['gguf'], hints: [], verdict: 'green',
      runtimeRamBytes: GiB, downloads: 1, hfUrl: 'https://huggingface.co/' + repo,
      reason: 'Fits', quantLabel
    }] }]
  })

  it('updates disk guidance immediately when a different quant is selected', async () => {
    const { client, quantNote } = await clientFor(async () => Response.json(installed), async () => {}, pickerQuants)
    client.setResult(pickerResult())
    await client.mfQuants(repo)
    client.mfPickQuant(repo, { value: 'Q8_0' })
    assert.match(quantNote(), /Q8_0.*short 4\.0 GB/)
    client.mfPickQuant(repo, { value: 'Q4_K_M' })
    assert.match(quantNote(), /Q4_K_M.*3\.0 GB to spare/)
    assert.doesNotMatch(quantNote(), /short/)
  })

  for (const [defaultQuant, expected] of [['Q8_0', 'Q8_0'], ['unavailable', 'Q4_K_M']]) {
    it(`aligns the visible quant and install payload for catalog default ${defaultQuant}`, async () => {
      let payload: { quant?: string } = {}
      const { client, markup } = await clientFor(async (init) => {
        payload = JSON.parse(String(init?.body))
        return Response.json(installed)
      }, async () => {}, pickerQuants)
      client.setResult(pickerResult(defaultQuant))
      await client.mfQuants(repo)
      assert.match(markup(), new RegExp('<option value="' + expected + '" selected>'))
      await client.mfInstall(repo)
      assert.equal(payload.quant, expected)
    })
  }

  it('keeps a user-selected quant when refreshing the list', async () => {
    const { client, markup } = await clientFor(async () => Response.json(installed), async () => {}, pickerQuants)
    client.setResult(pickerResult())
    await client.mfQuants(repo)
    client.mfPickQuant(repo, { value: 'Q8_0' })
    await client.mfQuants(repo)
    assert.match(markup(), /<option value="Q8_0" selected>/)
  })
  it('refreshes the strip when Model Farm is reopened after an outside install', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    let history: unknown[] = [{ repo: 'a/one', label: 'one', runtime: 'ollama', installedAt: Date.now() - 60_000 }]
    const { client, recentMarkup } = await clientFor(
      async () => Response.json({ ok: true }),
      async () => {},
      [],
      async (url) => Response.json(url === '/api/settings' ? { modelInstalls: history } : {})
    )
    client.show('models')
    await tick(); await tick(); await tick()
    assert.match(recentMarkup(), /one/)
    assert.doesNotMatch(recentMarkup(), /two/)

    // An install happened elsewhere (e.g. through an MCP tool); the open panel
    // must pick it up when the user returns to Model Farm, not only on reload.
    client.setResult({ total: 1, fetchedAt: 1, groups: [{ label: 'Text', icon: 'T', models: [] }] })
    history = [...history, { repo: 'a/two', label: 'two', runtime: 'ollama', installedAt: Date.now() }]
    client.show('overview')
    client.show('models')
    await tick(); await tick(); await tick()
    assert.match(recentMarkup(), /two/)
  })

  it('starts progress polling for downloads begun outside the panel when Model Farm opens', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const { client } = await clientFor(
      async () => Response.json({ ok: true }),
      async () => {},
      [],
      async (url) => Response.json(url === '/api/llamafarm/progress'
        ? { downloads: [{ repo: 'a/outside', runtime: 'ollama', status: 'downloading', percent: 10, receivedBytes: 1, totalBytes: 10, file: null, error: null, startedAt: 1 }] }
        : {})
    )
    assert.equal(client.mf.progressTimer, null)
    client.show('models')
    await tick(); await tick(); await tick()
    assert.ok(client.mf.progressTimer, 'an outside download should be polled while Model Farm is open')
  })

  it('does not start progress polling when nothing is downloading', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const { client } = await clientFor(
      async () => Response.json({ ok: true }),
      async () => {},
      [],
      async (url) => Response.json(url === '/api/llamafarm/progress' ? { downloads: [] } : {})
    )
    client.show('models')
    await tick(); await tick(); await tick()
    assert.equal(client.mf.progressTimer, null)
  })

  it('shows a saved note in the model detail and flags the row', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const { client, markup } = await clientFor(
      async () => Response.json({ ok: true }),
      async () => {},
      [],
      async (url) => Response.json(url === '/api/settings' ? { modelInstalls: [], modelNotes: { [repo]: 'fits in VRAM' } } : {})
    )
    client.show('models')
    await tick(); await tick(); await tick()
    assert.match(markup(), /fits in VRAM/)
    assert.match(markup(), /mf-note-flag/)
  })

  it('saves and clears a note through the panel API, updating the row flag', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const notes: Record<string, string> = {}
    let saved: unknown = null
    const { client, markup, noteInput } = await clientFor(
      async () => Response.json({ ok: true }),
      async () => {},
      [],
      async (url, init) => {
        if (url === '/api/settings/model-note') {
          saved = JSON.parse(String(init?.body))
          const body = saved as { repo: string; note: string }
          if (body.note.trim()) notes[body.repo] = body.note.trim()
          else delete notes[body.repo]
          return Response.json({ modelNotes: notes })
        }
        return Response.json(url === '/api/settings' ? { modelInstalls: [], modelNotes: notes } : {})
      }
    )
    client.show('models')
    await tick(); await tick(); await tick()
    noteInput(repo).value = 'new note'
    await client.mfSaveNote(repo)
    assert.deepEqual(saved, { repo, note: 'new note' })
    assert.match(markup(), /new note/)
    assert.match(markup(), /mf-note-flag/)

    noteInput(repo).value = '   '
    await client.mfSaveNote(repo)
    assert.doesNotMatch(markup(), /mf-note-flag/)
  })

  it('keeps an unsaved note draft across list re-renders until it is saved', async () => {
    const tick = () => new Promise((resolve) => setImmediate(resolve))
    const { client, markup, noteInput } = await clientFor(
      async () => Response.json({ ok: true }),
      async () => {},
      [],
      async (url, init) => {
        if (url === '/api/settings/model-note') {
          const note = (JSON.parse(String(init?.body)) as { note: string }).note.trim()
          return Response.json({ modelNotes: note ? { [repo]: note } : {} })
        }
        return Response.json(url === '/api/settings' ? { modelInstalls: [], modelNotes: {} } : {})
      }
    )
    client.show('models')
    await tick(); await tick(); await tick()
    noteInput(repo).value = 'half-typed thought'
    // A refresh (or an outside download completing) re-renders the list.
    client.setResult({ total: 1, fetchedAt: 1, groups: [{ label: 'Text', icon: 'T', models: [{
      id: repo, label: 'Model', formats: ['gguf'], hints: [], verdict: 'green',
      runtimeRamBytes: GiB, downloads: 1, hfUrl: 'https://huggingface.co/' + repo, reason: 'Fits'
    }] }] })
    assert.match(markup(), /half-typed thought/, 'the draft must survive the re-render')

    await client.mfSaveNote(repo)
    assert.equal(Object.keys(client.mf.noteDrafts).length, 0, 'saving clears the draft')
    assert.match(markup(), /half-typed thought/)
  })
})

describe('Model Farm run-now strip', () => {
  async function runNowClient(picks: unknown[]) {
    const script = await servedPanelScript()
    const element = () => ({
      innerHTML: '', textContent: '',
      classList: { toggle() {}, contains() { return true }, add() {}, remove() {} },
      addEventListener() {},
      appendChild(child: { innerHTML: string }) { this.innerHTML += child.innerHTML }
    })
    const elements = new Map<string, ReturnType<typeof element>>()
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)!
    }
    const client = runInNewContext(script + '\n;({ mfRunNow })', {
      document: { getElementById: get, createElement: element, querySelector: get, querySelectorAll: () => [] },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: (url: string) => url === '/api/llamafarm/run-now'
        ? Promise.resolve(Response.json({ scenario: 'now', picks }))
        : Promise.resolve(Response.json({})),
      setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}
    })
    return { client, markup: () => get('mf-runnow').innerHTML }
  }

  it('marks an installed pick ready and a non-installed pick as needing download', async () => {
    const ready = { task: 'text-generation', label: 'Text generation', model: {
      id: 'acme/ready-GGUF', label: 'Ready', verdict: 'green', installed: 'ready',
      paramsBillions: 3, runtimeRamBytes: GiB, grade: { letter: 'A', score: 90 }
    } }
    const download = { task: 'text-generation', label: 'Text generation', model: {
      id: 'acme/dl-GGUF', label: 'Download', verdict: 'green', installed: null,
      paramsBillions: 7, runtimeRamBytes: 2 * GiB, grade: { letter: 'B', score: 80 }
    } }
    const { client, markup } = await runNowClient([ready, download])
    await client.mfRunNow()
    assert.match(markup(), /installed/)
    assert.match(markup(), /needs download/)
  })
})

describe('Model Farm pull progress', () => {
  async function progressClient(reply: () => Promise<Response>) {
    const script = await servedPanelScript()
    const element = () => ({
      innerHTML: '', textContent: '', classList: { toggle() {}, contains() { return true }, add() {}, remove() {} },
      addEventListener() {}, appendChild(child: { innerHTML: string }) { this.innerHTML += child.innerHTML }
    })
    const elements = new Map<string, ReturnType<typeof element>>()
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)!
    }
    let tick!: () => Promise<void>
    const urls: string[] = []
    const client = runInNewContext(script + '\n;({ mf, mfStartProgress, mfStopProgress })', {
      document: { getElementById: get, createElement: element, querySelector: get, querySelectorAll: () => [] },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: (url: string) => { urls.push(url); return url === '/api/llamafarm/progress' ? reply() : Promise.resolve(Response.json({})) },
      setTimeout: () => 0, clearTimeout: () => {},
      setInterval: (fn: () => Promise<void>) => { tick = fn; return 1 }, clearInterval: () => {}
    })
    return { client, tick: () => tick(), markup: () => get('mf-progress').innerHTML, urls }
  }
  const progress = (repo: string) => Response.json({ downloads: [
    { repo, runtime: 'ollama', status: 'downloading', percent: null, receivedBytes: 0, totalBytes: GiB, file: null, error: null, startedAt: 1 }
  ] })

  for (const restart of [false, true]) {
    it(`ignores a late progress response after ${restart ? 'restarting' : 'stopping'} polling`, async () => {
      let release!: (response: Response) => void
      let calls = 0
      const { client, tick, markup } = await progressClient(() => ++calls === 1
        ? new Promise((resolve) => { release = resolve }) : Promise.resolve(progress('new-model')))
      client.mfStartProgress()
      const old = tick()
      client.mfStopProgress()
      if (restart) {
        client.mfStartProgress()
        await tick()
        assert.match(markup(), /new-model/)
      }
      release(progress('old-model'))
      await old
      assert.doesNotMatch(markup(), /old-model/)
      if (!restart) assert.equal(markup(), '')
    })
  }

  it('allows only one progress request at a time and resumes after it settles', async () => {
    let release!: (response: Response) => void
    let calls = 0
    const { client, tick } = await progressClient(() => {
      calls++
      return calls === 1 ? new Promise((resolve) => { release = resolve }) : Promise.resolve(progress('next'))
    })
    client.mfStartProgress()
    const pending = tick()
    await tick()
    assert.equal(calls, 1)
    release(progress('first'))
    await pending
    await tick()
    assert.equal(calls, 2)
  })

  it('does not revive a completed local install while another install still polls', async () => {
    const { client, tick, markup } = await progressClient(async () => progress('finished-model'))
    client.mf.install['finished-model'] = { state: 'ok' }
    client.mf.install['other-model'] = { state: 'busy' }
    client.mfStartProgress()
    await tick()
    assert.doesNotMatch(markup(), /finished-model/)
    assert.ok(client.mf.progressTimer)
  })

  it('stops polling once downloads finish and no local install is busy', async () => {
    const { client, tick, markup } = await progressClient(async () => Response.json({ downloads: [] }))
    client.mfStartProgress()
    assert.ok(client.mf.progressTimer)
    await tick()
    assert.equal(client.mf.progressTimer, null, 'idle polling should stop on its own')
    assert.equal(markup(), '')
  })

  it('refreshes the model surface when an outside download completes', async () => {
    let calls = 0
    const { client, tick, urls } = await progressClient(() => ++calls === 1
      ? progress('a/outside') : Promise.resolve(Response.json({ downloads: [] })))
    client.mfStartProgress()
    await tick()
    assert.ok(client.mf.progressTimer, 'polling continues while the download runs')
    await tick()
    assert.equal(client.mf.progressTimer, null)
    assert.ok(urls.includes('/api/settings'), 'completion should refresh the recently-installed strip')
  })

  it('leaves the refresh to mfInstall when a panel-initiated download completes', async () => {
    let calls = 0
    const { client, tick, urls } = await progressClient(() => ++calls === 1
      ? progress('a/local') : Promise.resolve(Response.json({ downloads: [] })))
    client.mf.install['a/local'] = { state: 'busy' }
    client.mfStartProgress()
    await tick()
    client.mf.install['a/local'] = { state: 'ok' }
    await tick()
    assert.equal(client.mf.progressTimer, null)
    assert.ok(!urls.includes('/api/settings'), 'mfInstall already refreshes; no duplicate refresh')
  })

  it('renders an indeterminate bar for a byte-less Ollama pull and a percent bar for folder downloads', async () => {
    const script = await servedPanelScript()
    const element = () => ({
      innerHTML: '', textContent: '',
      classList: { toggle() {}, contains() { return true }, add() {}, remove() {} },
      addEventListener() {},
      appendChild(child: { innerHTML: string }) { this.innerHTML += child.innerHTML }
    })
    const elements = new Map<string, ReturnType<typeof element>>()
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)!
    }
    let tick: (() => Promise<void>) | null = null
    const client = runInNewContext(script + '\n;({ mfStartProgress })', {
      document: { getElementById: get, createElement: element, querySelector: get, querySelectorAll: () => [] },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: (url: string) => url === '/api/llamafarm/progress'
        ? Promise.resolve(Response.json({ downloads: [
          { repo: 'acme/pull-GGUF', runtime: 'ollama', status: 'downloading', percent: null, receivedBytes: 0, totalBytes: 4 * GiB, file: null, error: null, startedAt: 1 },
          { repo: 'acme/folder-GGUF', runtime: 'lmstudio', status: 'downloading', percent: 55, receivedBytes: 2 * GiB, totalBytes: 4 * GiB, file: null, error: null, startedAt: 2 }
        ] }))
        : Promise.resolve(Response.json({})),
      setTimeout: () => 0, clearTimeout: () => {},
      setInterval: (fn: () => Promise<void>) => { tick = fn; return 1 },
      clearInterval: () => {}
    })
    client.mfStartProgress()
    assert.ok(tick, 'progress polling was scheduled')
    await tick!()
    const markup = get('mf-progress').innerHTML
    assert.match(markup, /pulling/)
    assert.match(markup, /indet/)
    assert.match(markup, /55%/)
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
