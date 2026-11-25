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

  it('cancels an owned CLI probe and waits for its observed close', async () => {
    const descriptor = runtimeDescriptor('ollama')
    assert.ok(descriptor)
    const controller = new AbortController()
    const signals: Array<NodeJS.Signals | undefined> = []
    const child = Object.assign(new EventEmitter(), {
      kill(signal?: NodeJS.Signals) {
        signals.push(signal)
        return true
      }
    })
    let finish!: (error: Error | null, stdout: string, stderr: string) => void
    const probing = probeRuntimeCli(descriptor, {
      signal: controller.signal,
      timeoutMs: 1000,
      execFileImpl: (_file, _args, _options, callback) => {
        finish = callback
        return child as never
      }
    })

    controller.abort(new Error('shutdown'))
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.deepEqual(signals, [undefined], 'shutdown must terminate the probe child')
    } finally {
      child.emit('close', null, 'SIGTERM')
      finish(new Error('probe aborted'), '', '')
    }
    assert.deepEqual(await probing, { installed: false, version: null, path: null })
  })

  it('owns a CLI child returned after cancellation starts', async () => {
    const descriptor = runtimeDescriptor('ollama')
    assert.ok(descriptor)
    const controller = new AbortController()
    const signals: Array<NodeJS.Signals | undefined> = []
    const child = Object.assign(new EventEmitter(), {
      kill(signal?: NodeJS.Signals) {
        signals.push(signal)
        return true
      }
    })
    const probing = probeRuntimeCli(descriptor, {
      signal: controller.signal,
      execFileImpl: () => {
        controller.abort(new Error('shutdown'))
        return child as never
      }
    })
    void probing.catch(() => {})

    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(signals, [undefined], 'a late child handle must still be terminated')
    child.emit('close', null, 'SIGTERM')
    assert.deepEqual(await probing, { installed: false, version: null, path: null })
  })

  it('force-kills an aborted CLI probe and waits for its observed close', { timeout: 2000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const descriptor = runtimeDescriptor('ollama')
    assert.ok(descriptor)
    const controller = new AbortController()
    const signals: Array<NodeJS.Signals | undefined> = []
    let settled = false
    const child = Object.assign(new EventEmitter(), {
      kill(signal?: NodeJS.Signals) {
        signals.push(signal)
        return true
      }
    })
    const probing = probeRuntimeCli(descriptor, {
      signal: controller.signal,
      execFileImpl: () => child as never
    })
    void probing.then(() => { settled = true }, () => { settled = true })

    controller.abort(new Error('shutdown'))
    t.mock.timers.tick(2000)
    await Promise.resolve()
    assert.deepEqual(signals, [undefined, 'SIGKILL'])
    assert.equal(settled, false, 'sending SIGKILL is not evidence that the CLI exited')

    child.emit('close', null, 'SIGKILL')
    assert.deepEqual(await probing, { installed: false, version: null, path: null })
  })

  it('reports a bounded failure when a force-killed CLI probe never closes', { timeout: 2000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const descriptor = runtimeDescriptor('ollama')
    assert.ok(descriptor)
    const controller = new AbortController()
    const signals: Array<NodeJS.Signals | undefined> = []
    const child = Object.assign(new EventEmitter(), {
      kill(signal?: NodeJS.Signals) {
        signals.push(signal)
        return true
      }
    })
    const probing = probeRuntimeCli(descriptor, {
      signal: controller.signal,
      execFileImpl: () => child as never
    })
    void probing.catch(() => {})

    controller.abort(new Error('shutdown'))
    t.mock.timers.tick(2000)
    t.mock.timers.tick(2000)
    await assert.rejects(probing, (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error.name, 'RuntimeCliExitObservationError')
      assert.match(error.message, /did not exit after SIGKILL/i)
      return true
    })
    assert.deepEqual(signals, [undefined, 'SIGKILL'])
  })

  it('stops launching CLI probes when shutdown starts during detection', async () => {
    const controller = new AbortController()
    let cliProbes = 0
    const report = await detectRuntimes({
      active: null,
      env: {},
      homeDir: '/home/vrm',
      fetchImpl: tableFetch({}),
      signal: controller.signal,
      execFileImpl: (_file, _args, _options, callback) => {
        cliProbes++
        callback(new Error('not found'), '', '')
        if (cliProbes === 1) controller.abort(new Error('shutdown'))
      }
    })

    assert.equal(cliProbes, 1, 'detection must not start another CLI after cancellation')
    assert.equal(report.runtimes.length, 0, 'cancelled detection must not publish a partial report')
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

  it('stops readiness polling when shutdown aborts the launch delay', async () => {
    const llamacpp = runtimeDescriptor('llamacpp')
    assert.ok(llamacpp)
    const controller = new AbortController()
    let probes = 0
    const result = await startServerRuntime(llamacpp, '/models/model.gguf', {
      signal: controller.signal,
      fetchImpl: async () => {
        probes += 1
        return { ok: false, status: 503, json: async () => ({}), text: async () => '' }
      },
      launchImpl: () => {
        controller.abort()
        return null
      },
      startAttempts: 1,
      startDelayMs: 20
    })

    assert.equal(result.ok, false)
    assert.match(result.message, /cancelled/i)
    assert.equal(probes, 3, 'shutdown must prevent probes after the readiness delay')
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

  it('cancels an in-progress installer download and removes staged files', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-cancel-'))
    const controller = new AbortController()
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    let receivedSignal: AbortSignal | undefined
    let installerRuns = 0
    const target = join(tempRoot, 'OllamaSetup.exe')

    try {
      const installing = installOllama({
        platform: 'win32',
        tempDir: tempRoot,
        signal: controller.signal,
        env: {},
        homeDir: tempRoot,
        execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
        fetchImpl: tableFetch({}),
        download: async (_url, file, _progress, signal) => {
          receivedSignal = signal
          await mkdir(tempRoot, { recursive: true })
          await writeFile(file, 'partial installer')
          notifyStarted()
          if (!signal) return 11
          await new Promise<number>((_resolve, reject) => {
            if (signal.aborted) reject(signal.reason)
            else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
          return 11
        },
        runInstaller: async () => {
          installerRuns += 1
          return { code: 3, output: 'must not run' }
        }
      } as Parameters<typeof installOllama>[0] & { signal?: AbortSignal })

      await started
      controller.abort()
      const result = await installing

      assert.equal(result.ok, false)
      assert.equal(result.action, 'failed')
      assert.equal(receivedSignal, controller.signal)
      assert.equal(installerRuns, 0)
      await assert.rejects(() => stat(target))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('does not launch a detached server after shutdown aborts installation', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-abort-'))
    const controller = new AbortController()
    let probes = 0
    let serverLaunches = 0
    const target = join(tempRoot, 'OllamaSetup.exe')

    try {
      const result = await installOllama({
        platform: 'win32',
        tempDir: tempRoot,
        signal: controller.signal,
        env: {},
        homeDir: tempRoot,
        execFileImpl: (_file, _args, _options, cb) => {
          probes += 1
          cb(probes === 1 ? new Error('not found') : null, 'ollama version 0.12.3', '')
        },
        fetchImpl: tableFetch({}),
        download: async (_url, file) => {
          await mkdir(tempRoot, { recursive: true })
          await writeFile(file, 'installer')
          return 8
        },
        runInstaller: async () => {
          controller.abort()
          return { code: 0, output: 'installed' }
        },
        startServer: async () => {
          serverLaunches += 1
          return 'spawn failed'
        },
        serveAttempts: 1,
        serveDelayMs: 0
      } as Parameters<typeof installOllama>[0] & { signal?: AbortSignal })

      assert.equal(result.ok, false)
      assert.equal(result.action, 'failed')
      assert.equal(probes, 1)
      assert.equal(serverLaunches, 0)
      await assert.rejects(() => stat(target))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('cancels an in-flight readiness probe without launching a server', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-probe-'))
    const controller = new AbortController()
    let probes = 0
    let readinessSignal: AbortSignal | undefined
    let serverLaunches = 0
    const notServing: RuntimeFetchResponse = {
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => ''
    }

    try {
      const result = await installOllama({
        platform: 'win32',
        tempDir: tempRoot,
        signal: controller.signal,
        timeoutMs: 20,
        env: {},
        homeDir: tempRoot,
        execFileImpl: (_file, _args, _options, cb) => {
          probes += 1
          cb(probes === 1 ? new Error('not found') : null, 'ollama version 0.12.3', '')
        },
        fetchImpl: async (_url, init) => {
          readinessSignal = init?.signal ?? undefined
          controller.abort()
          if (readinessSignal?.aborted) throw readinessSignal.reason
          await new Promise<void>((_resolve, reject) => {
            readinessSignal?.addEventListener('abort', () => reject(readinessSignal?.reason), { once: true })
          })
          return notServing
        },
        download: async (_url, file) => {
          await mkdir(tempRoot, { recursive: true })
          await writeFile(file, 'installer')
          return 8
        },
        runInstaller: async () => ({ code: 0, output: 'installed' }),
        startServer: async () => {
          serverLaunches += 1
          return 'must not launch'
        },
        serveAttempts: 1,
        serveDelayMs: 0
      } as Parameters<typeof installOllama>[0] & { signal?: AbortSignal })

      assert.equal(result.ok, false)
      assert.equal(result.action, 'failed')
      assert.equal(readinessSignal?.aborted, true)
      assert.equal(serverLaunches, 0)
      await assert.rejects(() => stat(join(tempRoot, 'OllamaSetup.exe')))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('kills an owned installer process when shutdown aborts it', async (t) => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-child-'))
    const controller = new AbortController()
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      killed: false,
      kill() {
        this.killed = true
        queueMicrotask(() => child.emit('close', null))
        return true
      }
    })
    const spawnMock = mock.method(childProcess, 'spawn', (() => {
      controller.abort()
      queueMicrotask(() => child.emit('close', 0))
      return child
    }) as never)
    syncBuiltinESMExports()
    t.after(() => {
      spawnMock.mock.restore()
      syncBuiltinESMExports()
    })
    let serverLaunches = 0

    try {
      const result = await installOllama({
        platform: 'win32',
        tempDir: tempRoot,
        signal: controller.signal,
        env: {},
        homeDir: tempRoot,
        execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
        fetchImpl: tableFetch({}),
        download: async (_url, file) => {
          await mkdir(tempRoot, { recursive: true })
          await writeFile(file, 'installer')
          return 8
        },
        startServer: async () => {
          serverLaunches += 1
          return 'must not launch'
        },
        serveAttempts: 1,
        serveDelayMs: 0
      } as Parameters<typeof installOllama>[0] & { signal?: AbortSignal })

      assert.equal(result.ok, false)
      assert.equal(result.action, 'failed')
      assert.equal(child.killed, true)
      assert.equal(serverLaunches, 0)
      await assert.rejects(() => stat(join(tempRoot, 'OllamaSetup.exe')))
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('does not report success when a timed-out installer later exits zero', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const tempRoot = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-timeout-'))
    const signals: Array<NodeJS.Signals | undefined> = []
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(signal?: NodeJS.Signals) {
        signals.push(signal)
        return true
      }
    })
    const spawnMock = mock.method(childProcess, 'spawn', (() => {
      notifyStarted()
      return child
    }) as never)
    syncBuiltinESMExports()
    t.after(() => {
      spawnMock.mock.restore()
      syncBuiltinESMExports()
    })
    let serverLaunches = 0

    try {
      const installing = installOllama({
        platform: 'win32',
        tempDir: tempRoot,
        env: {},
        homeDir: tempRoot,
        execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
        fetchImpl: tableFetch({
          'http://127.0.0.1:11434/api/version': { version: '0.12.3' }
        }),
        download: async (_url, file) => {
          await mkdir(tempRoot, { recursive: true })
          await writeFile(file, 'installer')
          return 8
        },
        startServer: async () => {
          serverLaunches += 1
          return 'must not launch'
        },
        serveAttempts: 1,
        serveDelayMs: 0
      })
      await started
      t.mock.timers.tick(15 * 60 * 1000)
      assert.deepEqual(signals, [undefined])
      child.emit('close', 0)
      const result = await installing

      assert.equal(result.ok, false)
      assert.equal(result.action, 'failed')
      assert.match(result.message, /timed out/i)
      assert.equal(serverLaunches, 0)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('waits for an aborted installer to close after force-kill', { timeout: 2000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const tempRoot = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-observe-'))
    const controller = new AbortController()
    const signals: Array<NodeJS.Signals | undefined> = []
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill(signal?: NodeJS.Signals) {
        signals.push(signal)
        return true
      }
    })
    const spawnMock = mock.method(childProcess, 'spawn', (() => {
      notifyStarted()
      return child
    }) as never)
    syncBuiltinESMExports()
    t.after(() => {
      spawnMock.mock.restore()
      syncBuiltinESMExports()
    })

    try {
      let settled = false
      const installing = installOllama({
        platform: 'win32',
        tempDir: tempRoot,
        signal: controller.signal,
        env: {},
        homeDir: tempRoot,
        execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
        fetchImpl: tableFetch({}),
        download: async (_url, file) => {
          await mkdir(tempRoot, { recursive: true })
          await writeFile(file, 'installer')
          return 8
        },
        startServer: async () => 'must not launch',
        serveAttempts: 1,
        serveDelayMs: 0
      } as Parameters<typeof installOllama>[0] & { signal?: AbortSignal })
      void installing.then(() => { settled = true }, () => { settled = true })
      await started
      controller.abort()
      t.mock.timers.tick(2000)
      const waitDeadline = Date.now() + 250
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (settled || Date.now() >= waitDeadline) resolve()
          else setImmediate(check)
        }
        check()
      })

      assert.deepEqual(signals, [undefined, 'SIGKILL'])
      assert.equal(settled, false, 'sending SIGKILL is not evidence that the installer exited')
      child.emit('close', null)
      const result = await installing
      assert.equal(result.action, 'failed')
      assert.match(result.message, /cancelled/i)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  })

  it('reports a bounded failure when a force-killed installer never closes', { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const tempRoot = await mkdtemp(join(tmpdir(), 'toolbox-mcp-install-stuck-'))
    const controller = new AbortController()
    let notifyStarted!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill() { return true }
    })
    const spawnMock = mock.method(childProcess, 'spawn', (() => {
      notifyStarted()
      return child
    }) as never)
    syncBuiltinESMExports()
    t.after(() => {
      spawnMock.mock.restore()
      syncBuiltinESMExports()
    })

    try {
      const installing = installOllama({
        platform: 'win32',
        tempDir: tempRoot,
        signal: controller.signal,
        env: {},
        homeDir: tempRoot,
        execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
        fetchImpl: tableFetch({}),
        download: async (_url, file) => {
          await mkdir(tempRoot, { recursive: true })
          await writeFile(file, 'installer')
          return 8
        }
      } as Parameters<typeof installOllama>[0] & { signal?: AbortSignal })
      await started
      controller.abort()
      t.mock.timers.tick(2000)
      t.mock.timers.tick(2000)
      await assert.rejects(installing, (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error.name, 'InstallerExitObservationError')
        assert.match(error.message, /did not exit after SIGKILL/i)
        return true
      })
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
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
  it('cancels GGUF metadata resolution with the supplied shutdown signal', async () => {
    const controller = new AbortController()
    let requestSignal: AbortSignal | undefined
    let release!: (response: RuntimeFetchResponse) => void
    const resolving = resolveGgufFile('owner/repo', 'Q4_K_M', {
      signal: controller.signal,
      fetchImpl: async (_url, init) => {
        const signal = init?.signal ?? undefined
        requestSignal = signal
        return new Promise<RuntimeFetchResponse>((resolve, reject) => {
          release = resolve
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    controller.abort(new Error('shutdown'))

    try {
      const outcome = await Promise.race([
        resolving.then(() => 'resolved', (error: unknown) => `rejected: ${String(error)}`),
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 50))
      ])
      assert.match(outcome, /rejected:.*shutdown/)
      assert.equal(requestSignal?.aborted, true)
    } finally {
      release({ ok: true, status: 200, json: async () => ({ siblings: [] }), text: async () => '' })
      await resolving.catch(() => {})
    }
  })

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
