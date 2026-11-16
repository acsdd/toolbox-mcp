import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  DEFAULT_RUNTIME_ID,
  OLLAMA_SILENT_ARGS,
  RUNTIME_REGISTRY,
  detectRuntimes,
  downloadGguf,
  expandPath,
  findRuntimeBinary,
  installOllama,
  listRuntimeModels,
  parseVersion,
  probePort,
  probeRuntimeCli,
  providerBaseUrl,
  resolveGgufFile,
  runtimeDescriptor,
  runtimeModelsDir,
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

  it('falls back to the largest file when the quant is missing', async () => {
    const file = await resolveGgufFile('owner/repo', 'Q2_K', {
      fetchImpl: tableFetch({
        'https://huggingface.co/api/models/owner/repo?blobs=true': {
          siblings: [
            { rfilename: 'small-Q4_K_M.gguf', lfs: { size: 100 } },
            { rfilename: 'big-Q8_0.gguf', lfs: { size: 900 } }
          ]
        }
      })
    })
    assert.ok(file)
    assert.equal(file.filename, 'big-Q8_0.gguf')
  })

  it('returns nothing when the repo has no GGUF', async () => {
    const file = await resolveGgufFile('owner/repo', null, {
      fetchImpl: tableFetch({
        'https://huggingface.co/api/models/owner/repo?blobs=true': { siblings: [{ rfilename: 'model.safetensors' }] }
      })
    })
    assert.equal(file, null)
  })

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
            await writeFile(target, 'weights')
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
