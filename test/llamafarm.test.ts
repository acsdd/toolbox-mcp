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

  async function clientFor(reply: () => Promise<Response>, writeText: (text: string) => Promise<void>) {
    const { startPanel } = await import('../dist/panel.js')
    const services = createServices({ fetchImpl: farmFetch(), execFileImpl: gpuExec })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    let page: string
    try {
      page = await (await fetch(`http://127.0.0.1:${panel.port}/`)).text()
    } finally {
      panel.close()
    }
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
    assert.ok(script)
    // Capture writes at the DOM boundary while executing the real, complete panel script.
    const element = () => ({
      innerHTML: '', textContent: '',
      classList: { toggle() {}, contains() { return true } },
      addEventListener() {},
      appendChild(child: { innerHTML: string }) { this.innerHTML += child.innerHTML }
    })
    const elements = new Map<string, ReturnType<typeof element>>()
    const get = (id: string) => {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)!
    }
    const client = runInNewContext(script + '\n;({ mf, mfInstall, copy: function(id) { return mfCopyAstrlink(id) }, setResult: function(value) { lastResult = value; renderGroups(value) } })', {
      document: {
        getElementById: get, createElement: element,
        querySelector: get, querySelectorAll: () => []
      },
      navigator: { clipboard: { writeText } },
      fetch: (url: string) => url === '/api/llamafarm/install' ? reply() : Promise.resolve(Response.json({})),
      setTimeout, clearTimeout
    })
    client.mf.expanded[repo] = true
    client.setResult({ total: 1, fetchedAt: 1, groups: [{
      label: 'Text generation', icon: 'T', models: [{
        id: repo, label: 'Model', formats: ['gguf'], hints: [], verdict: 'green',
        runtimeRamBytes: GiB, downloads: 1, hfUrl: 'https://huggingface.co/' + repo, reason: 'Fits'
      }]
    }] })
    return { client, markup: () => get('mf-cols').innerHTML }
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
