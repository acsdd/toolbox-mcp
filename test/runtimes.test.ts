import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, describe, it, mock, type TestContext } from 'node:test'
import {
  DEFAULT_RUNTIME_ID,
  OLLAMA_SILENT_ARGS,
  RUNTIME_REGISTRY,
  detectRuntimes,
  downloadGguf,
  expandPath,
  findRuntimeBinary,
  freeDiskBytes,
  installOllama,
  listRuntimeModels,
  parseVersion,
  probePort,
  probeRuntimeCli,
  providerBaseUrl,
  resolveGgufFile,
  runtimeDescriptor,
  runtimeModelsDir,
  serverLaunchCommand,
  startServerRuntime,
  type RuntimeFetch,
  type RuntimeFetchResponse
} from '../dist/runtimes.js'

/** A fetch that answers from a table of URL -> body. */
function tableFetch(routes: Record<string, unknown>): RuntimeFetch {
  return async (url) => {
    const body = routes[url]
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' } as RuntimeFetchResponse
    }
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(text),
      text: async () => text
    } as RuntimeFetchResponse
  }
}

class FakeDetachedChild extends EventEmitter {
  readonly spawned: Promise<void>
  unreferenced = false
  markSpawned!: () => void

  constructor() {
    super()
    this.spawned = new Promise<void>((resolve) => { this.markSpawned = resolve })
  }

  unref(): void {
    this.unreferenced = true
  }
}

function fakeDetachedSpawn(t: TestContext, spawnError?: Error): FakeDetachedChild {
  const child = new FakeDetachedChild()
  const spawnMock = mock.method(childProcess, 'spawn', (() => {
    child.markSpawned()
    if (spawnError) queueMicrotask(() => child.emit('error', spawnError))
    return child
  }) as never)
  syncBuiltinESMExports()
  t.after(() => {
    spawnMock.mock.restore()
    syncBuiltinESMExports()
  })
  return child
}

describe('runtime registry', () => {
  it('knows Ollama and its neighbours', () => {
    assert.equal(DEFAULT_RUNTIME_ID, 'ollama')
    assert.ok(RUNTIME_REGISTRY.length >= 5)
    assert.equal(runtimeDescriptor('ollama')?.port, 11434)
    assert.equal(runtimeDescriptor('lmstudio')?.api, 'openai')
    assert.equal(runtimeDescriptor('koboldcpp')?.api, 'kobold')
    assert.equal(runtimeDescriptor('nope'), null)
  })

  it('marks only Ollama as installable', () => {
    const installable = RUNTIME_REGISTRY.filter((entry) => entry.installable).map((entry) => entry.id)
    assert.deepEqual(installable, ['ollama'])
  })

  it('builds an OpenAI-compatible base URL', () => {
    assert.equal(providerBaseUrl({ api: 'openai', baseUrl: 'http://127.0.0.1:1234' }), 'http://127.0.0.1:1234/v1')
    assert.equal(providerBaseUrl({ api: 'openai', baseUrl: 'http://127.0.0.1:1234/v1' }), 'http://127.0.0.1:1234/v1')
    assert.equal(providerBaseUrl({ api: 'ollama', baseUrl: null }), 'http://127.0.0.1:11434/v1')
  })
})

describe('paths and versions', () => {
  it('expands ~ and the Windows variables', () => {
    const env = { LOCALAPPDATA: 'C:\\Users\\vrm\\AppData\\Local' }
    assert.equal(expandPath('~/.ollama/models', env, '/home/vrm'), '/home/vrm/.ollama/models')
    assert.equal(
      expandPath('%LOCALAPPDATA%/Programs/Ollama', env, '/home/vrm'),
      'C:\\Users\\vrm\\AppData\\Local/Programs/Ollama'
    )
    // The variable expands to the platform app-data path; the rest is untouched.
    assert.equal(expandPath('%APPDATA%/Jan', {}, '/home/vrm'), `${join('/home/vrm', 'AppData', 'Roaming')}/Jan`)
  })

  it('honors OLLAMA_MODELS without changing other runtime destinations', () => {
    const env = { OLLAMA_MODELS: 'D:/weights/ollama' }
    assert.equal(runtimeModelsDir(runtimeDescriptor('ollama')!, { env, homeDir: '/home/vrm' }), 'D:/weights/ollama')
    assert.equal(runtimeModelsDir(runtimeDescriptor('lmstudio')!, { env, homeDir: '/home/vrm' }), '/home/vrm/.lmstudio/models')
    assert.equal(runtimeModelsDir(runtimeDescriptor('ollama')!, { env: { OLLAMA_MODELS: '' }, homeDir: '/home/vrm' }), '/home/vrm/.ollama/models')
  })

  it('reads a version out of CLI output', () => {
    assert.equal(parseVersion('ollama version 0.12.3'), '0.12.3')
    assert.equal(parseVersion('Version: 1.2.3-beta'), '1.2.3-beta')
    assert.equal(parseVersion('no version here'), null)
  })

  it('resolves the models directory of a runtime', () => {
    const ollama = runtimeDescriptor('ollama')
    assert.ok(ollama)
    assert.equal(
      runtimeModelsDir(ollama, { env: {}, homeDir: '/home/vrm' }),
      '/home/vrm/.ollama/models'
    )
    const kobold = runtimeDescriptor('koboldcpp')
    assert.ok(kobold)
    assert.equal(runtimeModelsDir(kobold, { env: {}, homeDir: '/home/vrm' }), null)
  })
})

describe('destination free space', () => {
  it('uses available blocks on the nearest existing ancestor of a new models directory', async () => {
    const parent = resolve('disk-fixture')
    const target = join(parent, 'new', 'models')
    const visited: string[] = []
    const free = await freeDiskBytes(target, async (directory) => {
      visited.push(directory)
      if (directory !== parent) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      return { bsize: 4096, bavail: 3 }
    })
    assert.equal(free, 12288)
    assert.deepEqual(visited, [target, join(parent, 'new'), parent])
  })

  it('does not substitute a parent volume when access to an existing target is denied', async () => {
    let probes = 0
    const free = await freeDiskBytes('models', async () => {
      probes++
      throw Object.assign(new Error('denied'), { code: 'EACCES' })
    })
    assert.equal(free, null)
    assert.equal(probes, 1)
  })

  it('distinguishes a full drive from an unavailable disk measurement', async () => {
    assert.equal(await freeDiskBytes('models', async () => ({ bsize: 4096, bavail: 0 })), 0)
    for (const bavail of [-1, NaN, Infinity]) {
      assert.equal(await freeDiskBytes('models', async () => ({ bsize: 4096, bavail })), null)
    }
  })
})

describe('port probes', () => {
  it('recognises an Ollama server and lists its models', async () => {
    const probe = await probePort(11434, {
      fetchImpl: tableFetch({
        'http://127.0.0.1:11434/api/version': { version: '0.12.3' },
        'http://127.0.0.1:11434/api/tags': {
          models: [{ name: 'qwen2.5-coder:7b', size: 4096, modified_at: '2026-11-01T00:00:00Z' }]
        }
      })
    })
    assert.ok(probe)
    assert.equal(probe.api, 'ollama')
    assert.equal(probe.identity, 'ollama')
    assert.equal(probe.models[0].name, 'qwen2.5-coder:7b')
    assert.equal(probe.models[0].sizeBytes, 4096)
  })

  it('recognises an OpenAI-compatible server and names it from its banner', async () => {
    const probe = await probePort(1234, {
      fetchImpl: tableFetch({
        'http://127.0.0.1:1234/v1/models': { data: [{ id: 'local-model' }] },
        'http://127.0.0.1:1234/': 'LM Studio server'
      })
    })
    assert.ok(probe)
    assert.equal(probe.api, 'openai')
    assert.equal(probe.identity, 'lmstudio')
    assert.equal(probe.models[0].name, 'local-model')
  })

  it('recognises a KoboldCpp server', async () => {
    const probe = await probePort(5001, {
      fetchImpl: tableFetch({
        'http://127.0.0.1:5001/api/v1/models': { data: [{ id: 'kobold-model' }] }
      })
    })
    assert.ok(probe)
    assert.equal(probe.api, 'kobold')
    assert.equal(probe.identity, 'koboldcpp')
  })

  it('returns nothing when the port is silent', async () => {
    const probe = await probePort(9999, { fetchImpl: tableFetch({}) })
    assert.equal(probe, null)
  })

  it('lists the models a runtime serves', async () => {
    const descriptor = runtimeDescriptor('ollama')
    assert.ok(descriptor)
    const result = await listRuntimeModels(descriptor, {
      fetchImpl: tableFetch({
        'http://127.0.0.1:11434/api/version': { version: '0.12.3' },
        'http://127.0.0.1:11434/api/tags': { models: [{ name: 'a:1b', size: 1 }] }
      })
    })
    assert.equal(result.error, null)
    assert.equal(result.models.length, 1)
  })

  it('says so when nothing answers', async () => {
    const descriptor = runtimeDescriptor('llamacpp')
    assert.ok(descriptor)
    const result = await listRuntimeModels(descriptor, { fetchImpl: tableFetch({}) })
    assert.equal(result.models.length, 0)
    assert.match(result.error ?? '', /8080/)
  })

  it('does not return another runtime’s models from a shared port', async () => {
    const descriptor = runtimeDescriptor('localai')
    assert.ok(descriptor)
    const result = await listRuntimeModels(descriptor, {
      fetchImpl: tableFetch({
        'http://127.0.0.1:8080/v1/models': { data: [{ id: 'owned-by-llamacpp' }] },
        'http://127.0.0.1:8080/': 'llama.cpp server'
      })
    })
    assert.equal(result.models.length, 0)
    assert.match(result.error ?? '', /served by llama\.cpp/)
  })

  it('does not guess which runtime owns an unnamed shared port', async () => {
    const descriptor = runtimeDescriptor('llamacpp')
    assert.ok(descriptor)
    const result = await listRuntimeModels(descriptor, {
      fetchImpl: tableFetch({
        'http://127.0.0.1:8080/v1/models': { data: [{ id: 'who-knows' }] }
      })
    })
    assert.equal(result.models.length, 0)
    assert.match(result.error ?? '', /does not name itself/)
  })
})

describe('detection', () => {
  it('finds a runtime on its port and keeps the others clean', async () => {
    const report = await detectRuntimes({
      active: null,
      env: {},
      homeDir: '/home/vrm',
      fetchImpl: tableFetch({
        'http://127.0.0.1:11434/api/version': { version: '0.12.3' },
        'http://127.0.0.1:11434/api/tags': { models: [] }
      }),
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', '')
    })
    const ollama = report.runtimes.find((entry) => entry.id === 'ollama')
    const lmstudio = report.runtimes.find((entry) => entry.id === 'lmstudio')
    assert.ok(ollama && lmstudio)
    assert.equal(ollama.running, true)
    assert.equal(ollama.installed, true)
    assert.equal(lmstudio.running, false)
    assert.equal(lmstudio.baseUrl, null)
  })

  it('tells the runtimes that share a port who owns it', async () => {
    const report = await detectRuntimes({
      env: {},
      homeDir: '/home/vrm',
      fetchImpl: tableFetch({
        'http://127.0.0.1:8080/v1/models': { data: [] },
        'http://127.0.0.1:8080/': 'llama.cpp server'
      }),
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', '')
    })
    const llamacpp = report.runtimes.find((entry) => entry.id === 'llamacpp')
    const localai = report.runtimes.find((entry) => entry.id === 'localai')
    const llamafile = report.runtimes.find((entry) => entry.id === 'llamafile')
    assert.ok(llamacpp && localai && llamafile)
    assert.equal(llamacpp.running, true)
    // The owner keeps its own note; the others learn who holds the port.
    assert.equal(llamacpp.note, 'Runs one GGUF per process — toolbox-mcp can start it for you.')
    assert.equal(localai.running, false)
    assert.match(localai.note, /served by llama\.cpp/)
    assert.equal(llamafile.running, false)
    assert.match(llamafile.note, /served by llama\.cpp/)
    // Another runtime answering on the port is not proof that these are
    // installed — only the CLI or an install folder is.
    assert.equal(localai.installed, false)
    assert.equal(llamafile.installed, false)
  })

  it('does not guess an owner when a shared port has no banner', async () => {
    const report = await detectRuntimes({
      env: {},
      homeDir: '/home/vrm',
      fetchImpl: tableFetch({
        'http://127.0.0.1:8080/v1/models': { data: [] }
      }),
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', '')
    })
    for (const id of ['llamacpp', 'localai', 'llamafile']) {
      const runtime = report.runtimes.find((entry) => entry.id === id)
      assert.ok(runtime)
      assert.equal(runtime.installed, false, `${id} must not be guessed`)
      assert.equal(runtime.running, false)
      assert.equal(runtime.baseUrl, null)
      assert.match(runtime.note, /does not name itself/)
    }
  })

  it('does not call a runtime installed when a neighbour answers on its port', async () => {
    const report = await detectRuntimes({
      env: {},
      homeDir: '/home/vrm',
      fetchImpl: tableFetch({
        'http://127.0.0.1:1337/v1/models': { data: [] },
        'http://127.0.0.1:1337/': 'LM Studio'
      }),
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', '')
    })
    const jan = report.runtimes.find((entry) => entry.id === 'jan')
    assert.ok(jan)
    assert.equal(jan.running, false)
    assert.equal(jan.installed, false)
    assert.match(jan.note, /served by LM Studio/)
  })

  it('probes the CLI for a version', async () => {
    const descriptor = runtimeDescriptor('ollama')
    assert.ok(descriptor)
    const found = await probeRuntimeCli(descriptor, {
      execFileImpl: (_file, _args, _options, cb) => cb(null, 'ollama version 0.12.3', '')
    })
    assert.equal(found.installed, true)
    assert.equal(found.version, '0.12.3')

    const missing = await probeRuntimeCli(descriptor, {
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('ENOENT'), '', '')
    })
    assert.equal(missing.installed, false)
    assert.equal(missing.version, null)
  })

  it('reads a version that a runtime prints on stderr', async () => {
    const descriptor = runtimeDescriptor('llamacpp')
    assert.ok(descriptor)
    const found = await probeRuntimeCli(descriptor, {
      execFileImpl: (_file, _args, _options, cb) =>
        cb(null, '', 'version: 0.9.0-dev (build 12343, commit 3ba1ce0e2)')
    })
    assert.equal(found.installed, true)
    assert.equal(found.version, '0.9.0-dev')
  })

  it('falls back to a banner for a runtime without a semantic version', async () => {
    const descriptor = runtimeDescriptor('lmstudio')
    assert.ok(descriptor)
    const found = await probeRuntimeCli(descriptor, {
      execFileImpl: (_file, _args, _options, cb) => cb(null, 'CLI commit: 43d4b26', '')
    })
    assert.equal(found.version, 'CLI commit: 43d4b26')
  })

  it('only counts a folder as an install when it holds the program', async () => {
    const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-dirs-'))
    try {
      const descriptor = runtimeDescriptor('ollama')
      assert.ok(descriptor)
      // A leftover data folder is not an install.
      await mkdir(join(home, '.ollama'), { recursive: true })
      assert.equal(findRuntimeBinary(descriptor, { env: {}, homeDir: home }), null)

      // The program folder is.
      const programDir = join(home, 'AppData', 'Local', 'Programs', 'Ollama')
      await mkdir(programDir, { recursive: true })
      await writeFile(join(programDir, 'ollama.exe'), 'binary')
      const found = findRuntimeBinary(descriptor, {
        env: { LOCALAPPDATA: join(home, 'AppData', 'Local') },
        homeDir: home
      })
      assert.ok(found)
      assert.ok(found.endsWith('ollama.exe'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('finds a program in a bin subfolder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-bin-'))
    try {
      const descriptor = runtimeDescriptor('lmstudio')
      assert.ok(descriptor)
      await mkdir(join(home, '.lmstudio', 'bin'), { recursive: true })
      await writeFile(join(home, '.lmstudio', 'bin', 'lms.exe'), 'binary')
      const found = findRuntimeBinary(descriptor, { env: {}, homeDir: home })
      assert.ok(found)
      assert.ok(found.endsWith('lms.exe'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('carries the chosen runtime into the report', async () => {
    const report = await detectRuntimes({
      active: 'lmstudio',
      env: {},
      homeDir: '/home/vrm',
      fetchImpl: tableFetch({}),
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', '')
    })
    assert.equal(report.active, 'lmstudio')
    assert.equal(report.platform, process.platform)
  })
})

describe('starting a server runtime', () => {
  it('builds the command each runtime understands', () => {
    const llamacpp = runtimeDescriptor('llamacpp')
    const vllm = runtimeDescriptor('vllm')
    assert.ok(llamacpp && vllm)
    const model = 'C:/Model Farm/acme/model Q4_K_M.gguf'

    const llamaCmd = serverLaunchCommand(llamacpp, model)
    assert.equal(llamaCmd.file, 'llama-server')
    assert.deepEqual(llamaCmd.args, ['-m', model, '--port', '8080', '--host', '127.0.0.1'])
    assert.match(llamaCmd.display, /"C:\/Model Farm\/acme\/model Q4_K_M\.gguf"/)

    // vLLM takes a subcommand; the old launcher used llama.cpp arguments.
    const vllmCmd = serverLaunchCommand(vllm, model)
    assert.equal(vllmCmd.file, 'vllm')
    assert.deepEqual(vllmCmd.args.slice(0, 2), ['serve', model])
    assert.ok(vllmCmd.args.includes('--port'))
  })

  it('passes the tokenizer repository to vLLM for a local GGUF', () => {
    const vllm = runtimeDescriptor('vllm')
    assert.ok(vllm)
    const command = serverLaunchCommand(vllm, '/models/model.gguf', 'acme/model')
    assert.deepEqual(command.args, [
      'serve', '/models/model.gguf', '--tokenizer', 'acme/model', '--port', '8000', '--host', '127.0.0.1'
    ])
  })

  it('reuses a server that already serves the same model', async () => {
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    let launched = 0
    const result = await startServerRuntime(llamacpp, '/models/cool-model-Q4_K_M.gguf', {
      fetchImpl: tableFetch({
        'http://127.0.0.1:8080/v1/models': { data: [{ id: 'cool-model-Q4_K_M.gguf' }] },
        'http://127.0.0.1:8080/': 'llama.cpp server'
      }),
      launchImpl: () => { launched += 1 }
    })
    assert.equal(result.ok, true)
    assert.equal(result.baseUrl, 'http://127.0.0.1:8080')
    assert.match(result.message, /already serves cool-model-Q4_K_M\.gguf/)
    assert.equal(launched, 0)
  })

  it('refuses to claim a port already serving another model', async () => {
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    let launched = 0
    const result = await startServerRuntime(llamacpp, '/models/new-model.gguf', {
      fetchImpl: tableFetch({
        'http://127.0.0.1:8080/v1/models': { data: [{ id: 'other-model.gguf' }] },
        'http://127.0.0.1:8080/': 'llama.cpp server'
      }),
      launchImpl: () => { launched += 1 }
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /already serving other-model\.gguf/)
    assert.match(result.message, /new-model\.gguf/)
    assert.equal(launched, 0)
  })

  it('does not claim a port that some other server already answers on', async () => {
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    let launched = 0
    const result = await startServerRuntime(llamacpp, '/models/model.gguf', {
      fetchImpl: tableFetch({ 'http://127.0.0.1:8080/v1/models': { data: [] } }),
      launchImpl: () => { launched += 1 }
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /already answers/)
    assert.equal(launched, 0)
  })

  it('returns a launcher failure immediately instead of a generic port timeout', async () => {
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    const result = await startServerRuntime(llamacpp, '/models/model.gguf', {
      fetchImpl: tableFetch({}),
      launchImpl: async () => 'spawn EACCES',
      startAttempts: 1,
      startDelayMs: 0
    })
    assert.equal(result.ok, false)
    assert.match(result.message, /EACCES/)
    assert.match(result.message, /could not start|failed to start/i)
  })

  it('consumes asynchronous detached spawn errors and reports them', async (t) => {
    const child = fakeDetachedSpawn(t)
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    const pending = startServerRuntime(llamacpp, '/models/model.gguf', {
      fetchImpl: tableFetch({}),
      startAttempts: 1,
      startDelayMs: 0
    })
    await child.spawned
    child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))

    const result = await pending
    assert.equal(result.ok, false)
    assert.match(result.message, /ENOENT/)
    assert.match(result.message, /could not start|failed to start/i)
  })

  it('waits for the detached spawn event and releases the child handle', async (t) => {
    const child = fakeDetachedSpawn(t)
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    let serving = false
    const ready = tableFetch({
      'http://127.0.0.1:8080/v1/models': { data: [{ id: 'model.gguf' }] },
      'http://127.0.0.1:8080/': 'llama.cpp server'
    })
    const pending = startServerRuntime(llamacpp, '/models/model.gguf', {
      fetchImpl: (url) => serving ? ready(url) : tableFetch({})(url),
      startAttempts: 1,
      startDelayMs: 0
    })
    let settled = false
    void pending.then(() => { settled = true }, () => { settled = true })
    await child.spawned
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(settled, false, 'launch must wait for the child spawn event')
    serving = true
    child.emit('spawn')

    const result = await pending
    assert.equal(result.ok, true)
    assert.equal(child.unreferenced, true)
  })

  it('continues to accept a launcher that returns a child-process handle', async () => {
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    const handle = {} as ReturnType<typeof childProcess.spawn>
    const result = await startServerRuntime(llamacpp, '/models/model.gguf', {
      fetchImpl: tableFetch({
        'http://127.0.0.1:8080/v1/models': { data: [{ id: 'model.gguf' }] },
        'http://127.0.0.1:8080/': 'llama.cpp server'
      }),
      launchImpl: async () => handle,
      startAttempts: 1,
      startDelayMs: 0
    })

    assert.equal(result.ok, true)
  })
})

describe('installing Ollama', () => {
  let home = ''

  before(async () => {
    home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-'))
  })

  after(async () => {
    await rm(home, { recursive: true, force: true })
  })

  it('downloads the official installer and runs it silently', async () => {
    const calls: Array<{ url: string; target: string }> = []
    const runs: Array<{ file: string; args: string[] }> = []
    const result = await installOllama({
      platform: 'win32',
      tempDir: home,
      env: {},
      homeDir: home,
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
      fetchImpl: tableFetch({}),
      download: async (url, target) => {
        calls.push({ url, target })
        return 1024
      },
      runInstaller: async (file, args) => {
        runs.push({ file, args })
        return { code: 0, output: 'ok' }
      }
    })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://ollama.com/download/OllamaSetup.exe')
    assert.equal(runs.length, 1)
    assert.deepEqual(runs[0].args, OLLAMA_SILENT_ARGS)
    assert.ok(runs[0].file.endsWith('OllamaSetup.exe'))
    // No Ollama on the test machine means no version could be confirmed.
    assert.equal(result.ok, false)
    assert.equal(result.action, 'failed')
  })

  it('reports the exit code of a failing installer', async () => {
    const result = await installOllama({
      platform: 'linux',
      tempDir: home,
      env: {},
      homeDir: home,
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
      fetchImpl: tableFetch({}),
      download: async () => 10,
      runInstaller: async () => ({ code: 3, output: 'boom' })
    })
    assert.equal(result.ok, false)
    assert.equal(result.action, 'failed')
    assert.match(result.message, /exited with code 3/)
    assert.equal(result.log, 'boom')
  })

  it('does not report serving success when only the CLI can be verified', async () => {
    let probes = 0
    const result = await installOllama({
      platform: 'linux',
      tempDir: home,
      env: {},
      homeDir: home,
      execFileImpl: (_file, _args, _options, cb) => {
        probes += 1
        cb(probes === 1 ? new Error('not found') : null, 'ollama version 0.12.3', '')
      },
      fetchImpl: tableFetch({}),
      download: async () => 10,
      runInstaller: async () => ({ code: 0, output: 'installed' }),
      startServer: async () => 'spawn ENOENT',
      serveAttempts: 1,
      serveDelayMs: 0
    })

    assert.equal(result.ok, false)
    assert.equal(result.action, 'installed')
    assert.equal(result.version, '0.12.3')
    assert.match(result.message, /installed.*server.*did not answer/i)
    assert.match(result.message, /ENOENT/)
  })

  it('retains a server launch error when the installed CLI has no readable version', async () => {
    let probes = 0
    const result = await installOllama({
      platform: 'linux',
      tempDir: home,
      env: {},
      homeDir: home,
      execFileImpl: (_file, _args, _options, cb) => {
        probes += 1
        cb(probes === 1 ? new Error('not found') : null, 'ollama development build', '')
      },
      fetchImpl: tableFetch({}),
      download: async () => 10,
      runInstaller: async () => ({ code: 0, output: 'installed' }),
      startServer: async () => 'spawn ENOENT',
      serveAttempts: 1,
      serveDelayMs: 0
    })

    assert.equal(result.ok, false)
    assert.equal(result.version, null)
    assert.match(result.message, /ENOENT/)
    assert.match(result.message, /server/i)
    assert.match(result.log, /ENOENT/)
    assert.equal(result.action, 'installed')
  })

  it('confirms success only after the Ollama API answers', async () => {
    let probes = 0
    const result = await installOllama({
      platform: 'linux',
      tempDir: home,
      env: {},
      homeDir: home,
      execFileImpl: (_file, _args, _options, cb) => {
        probes += 1
        cb(probes === 1 ? new Error('not found') : null, 'ollama version 0.12.3', '')
      },
      fetchImpl: tableFetch({ 'http://127.0.0.1:11434/api/version': { version: '0.12.3' } }),
      download: async () => 10,
      runInstaller: async () => ({ code: 0, output: 'installed' }),
      startServer: async () => { throw new Error('must not launch an already-serving API') },
      serveAttempts: 1,
      serveDelayMs: 0
    })

    assert.equal(result.ok, true)
    assert.equal(result.version, '0.12.3')
    assert.match(result.message, /installed and serving/)
  })

  it('starts a missing Ollama server and verifies the API before succeeding', async () => {
    let probes = 0
    let serving = false
    let launches = 0
    const result = await installOllama({
      platform: 'linux',
      tempDir: home,
      env: {},
      homeDir: home,
      execFileImpl: (_file, _args, _options, cb) => {
        probes += 1
        cb(probes === 1 ? new Error('not found') : null, 'ollama version 0.12.3', '')
      },
      fetchImpl: async (url) => url.endsWith('/api/version') && serving
        ? { ok: true, status: 200, json: async () => ({ version: '0.12.3' }), text: async () => '{"version":"0.12.3"}' }
        : { ok: false, status: 503, json: async () => ({}), text: async () => '' },
      download: async () => 10,
      runInstaller: async () => ({ code: 0, output: 'installed' }),
      startServer: async () => { launches += 1; serving = true; return null },
      serveAttempts: 1,
      serveDelayMs: 0
    })

    assert.equal(launches, 1)
    assert.equal(result.ok, true)
    assert.equal(result.version, '0.12.3')
    assert.match(result.message, /installed and serving/)
  })

  it('uses the official install script on Linux', async () => {
    const downloads: string[] = []
    const runs: Array<{ file: string; args: string[] }> = []
    await installOllama({
      platform: 'linux',
      tempDir: home,
      env: {},
      homeDir: home,
      execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
      fetchImpl: tableFetch({}),
      download: async (url) => {
        downloads.push(url)
        return 10
      },
      runInstaller: async (file, args) => {
        runs.push({ file, args })
        return { code: 1, output: 'failed' }
      }
    })
    assert.deepEqual(downloads, ['https://ollama.com/install.sh'])
    assert.equal(runs[0].file, '/bin/sh')
  })
})

describe('weights for a runtime that cannot pull', () => {
  it('finds the GGUF file of a repo', async () => {
    const file = await resolveGgufFile('bartowski/Llama-3.2-3B-Instruct-GGUF', 'Q4_K_M', {
      fetchImpl: tableFetch({
        'https://huggingface.co/api/models/bartowski/Llama-3.2-3B-Instruct-GGUF?blobs=true': {
          siblings: [
            { rfilename: 'model-Q4_K_M.gguf', lfs: { size: 2000 } },
            { rfilename: 'model-Q8_0.gguf', lfs: { size: 4000 } },
            { rfilename: 'README.md' }
          ]
        }
      })
    })
    assert.ok(file)
    assert.equal(file.filename, 'model-Q4_K_M.gguf')
    assert.equal(file.sizeBytes, 2000)
    assert.match(file.url, /resolve\/main\/model-Q4_K_M\.gguf$/)
  })

  it('refuses an unavailable requested quant instead of downloading a heavier one', async () => {
    await assert.rejects(resolveGgufFile('owner/repo', 'Q2_K', {
      fetchImpl: tableFetch({
        'https://huggingface.co/api/models/owner/repo?blobs=true': {
          siblings: [
            { rfilename: 'small-Q4_K_M.gguf', lfs: { size: 100 } },
            { rfilename: 'big-Q8_0.gguf', lfs: { size: 900 } }
          ]
        }
      })
    }), /Q2_K.*not available/i)
  })

  it('refuses a split GGUF instead of treating its first shard as a complete model', async () => {
    await assert.rejects(resolveGgufFile('owner/split', 'Q4_K_M', {
      fetchImpl: tableFetch({ 'https://huggingface.co/api/models/owner/split?blobs=true': { siblings: [
        { rfilename: 'model-q4_k_m-00001-of-00002.gguf', size: 4000 },
        { rfilename: 'model-q4_k_m-00002-of-00002.gguf', size: 4000 }
      ] } })
    }), /split GGUF.*not supported/i)
  })

  it('returns nothing when the repo has no GGUF', async () => {
    const file = await resolveGgufFile('owner/repo', null, {
      fetchImpl: tableFetch({
        'https://huggingface.co/api/models/owner/repo?blobs=true': { siblings: [{ rfilename: 'model.safetensors' }] }
      })
    })
    assert.equal(file, null)
  })

  it('keeps equal filenames from different repos in separate directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-mcp-isolated-'))
    try {
      const results = []
      for (const repoId of ['alice/model', 'bob/model']) {
        results.push(await downloadGguf({ repoId, filename: 'model.gguf', url: 'https://example.invalid/model', sizeBytes: 11 }, root, {
          download: async (_url, target) => { await writeFile(target, repoId.padEnd(11)); return 11 }
        }))
      }
      assert.notEqual(results[0].path, results[1].path)
      assert.equal(await readFile(results[0].path, 'utf8'), 'alice/model')
      assert.equal(await readFile(results[1].path, 'utf8'), 'bob/model  ')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('preserves an existing model and removes staging when publication would overwrite it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'toolbox-mcp-preserve-'))
    try {
      await writeFile(join(root, 'model.gguf'), 'original')
      await assert.rejects(downloadGguf({ filename: 'model.gguf', url: 'https://example.invalid/model', sizeBytes: 7 }, root, {
        download: async (_url, target) => { await writeFile(target, 'changed'); return 7 }
      }), /already exists|EEXIST/)
      assert.equal(await readFile(join(root, 'model.gguf'), 'utf8'), 'original')
      assert.deepEqual(await readdir(root), ['model.gguf'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  for (const failure of ['throw', 'truncated']) {
    it(`cleans ${failure} downloads without publishing invalid weights`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'toolbox-mcp-partial-'))
      try {
        await assert.rejects(downloadGguf({ filename: 'model.gguf', url: 'https://example.invalid/model', sizeBytes: 20 }, root, {
          download: async (_url, target) => {
            await writeFile(target, 'short')
            if (failure === 'throw') throw new Error('disconnected')
            return 20 // A transport's reported count must not replace the actual file size.
          }
        }), failure === 'throw' ? /disconnected/ : /size.*expected/i)
        assert.deepEqual(await readdir(root), [])
      } finally { await rm(root, { recursive: true, force: true }) }
    })
  }

  it('downloads the weights into the runtime folder', async () => {
    const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-gguf-'))
    try {
      const seen: Array<{ url: string; target: string }> = []
      const result = await downloadGguf(
        { filename: 'model-Q4_K_M.gguf', url: 'https://example.invalid/model-Q4_K_M.gguf', sizeBytes: 12 },
        join(home, 'models'),
        {
          download: async (url, target) => {
            seen.push({ url, target })
            await writeFile(target, Buffer.alloc(12))
            return 12
          }
        }
      )
      assert.equal(seen[0].url, 'https://example.invalid/model-Q4_K_M.gguf')
      assert.equal(result.bytes, 12)
      assert.ok(result.path.endsWith('model-Q4_K_M.gguf'))
      assert.deepEqual(await readdir(join(home, 'models')), ['model-Q4_K_M.gguf'])
      assert.ok((await stat(result.path)).isFile())
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
