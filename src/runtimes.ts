/**
 * Local model runtimes: finding them, installing Ollama, and using what is
 * already on the machine.
 *
 * Ollama is not the only local runtime. LM Studio, llama.cpp, Jan, GPT4All,
 * KoboldCpp, LocalAI, vLLM, llamafile and text-generation-webui all serve
 * models from this PC. This module looks for them three ways — a server on a
 * known port, a CLI on PATH, an install directory — and reports what it found
 * so the user can point the Model Farm at the one they already use.
 *
 * It can also install Ollama itself, always from the official installer, so
 * the result is a fresh version rather than whatever was on the machine.
 */
import { execFile, spawn } from 'node:child_process'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { link, mkdir, rm, stat, statfs } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parseQuantLabel } from '@toolbox/widgets'

// --- types ------------------------------------------------------------------

/** The API dialect a runtime speaks. */
export type RuntimeApi = 'ollama' | 'openai' | 'kobold'

/** How a runtime takes a model. */
export type RuntimeAccepts = 'pull' | 'folder' | 'server'

export interface RuntimeDescriptor {
  id: string
  label: string
  vendor: string
  homepage: string
  api: RuntimeApi
  /** Default port the runtime serves on. */
  port: number
  /** Executable probed on PATH, when the runtime ships one. */
  cli?: string
  /** Arguments for the CLI version probe. */
  cliArgs?: string[]
  /** Candidate install directories. */
  dirs?: string[]
  /** File names that prove the runtime is installed (without extension). */
  binaries?: string[]
  /** Where the runtime keeps model files. */
  modelsDir?: string
  /** True when toolbox-mcp knows how to install it. */
  installable: boolean
  /** What the runtime does with weights we hand it. */
  accepts: RuntimeAccepts
  /** One line the user can read. */
  note: string
}

export interface RuntimeModel {
  name: string
  sizeBytes: number
  modifiedAt: string | null
}

export interface RuntimeStatus {
  id: string
  label: string
  vendor: string
  homepage: string
  api: RuntimeApi
  port: number
  /** The runtime is on this machine (CLI, install directory or a live server). */
  installed: boolean
  /** Something answered on its port. */
  running: boolean
  /** The server answered but did not name itself. */
  identified: boolean
  baseUrl: string | null
  version: string | null
  /** Where the runtime was found, when it was found on disk. */
  path: string | null
  models: RuntimeModel[]
  accepts: RuntimeAccepts
  installable: boolean
  note: string
}

export interface RuntimeReport {
  runtimes: RuntimeStatus[]
  /** The runtime the Model Farm installs into; null means Ollama. */
  active: string | null
  detectedAt: number
  platform: string
}

export interface RuntimeFetchResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  body?: ReadableStream<Uint8Array> | null
  headers?: { get(name: string): string | null }
}

export type RuntimeFetch = (url: string, init?: RequestInit) => Promise<RuntimeFetchResponse>

/** Bytes received so far in a download; totalBytes null when the size is unknown. */
export interface DownloadProgress {
  receivedBytes: number
  totalBytes: number | null
}

/** Downloads a URL to a file, optionally reporting progress; returns bytes written. */
export type DownloadFn = (
  url: string,
  target: string,
  onProgress?: (progress: DownloadProgress) => void
) => Promise<number>

export type RuntimeExec = (
  file: string,
  args: string[],
  options: { timeout: number; windowsHide: boolean; maxBuffer?: number },
  cb: (error: Error | null, stdout: string, stderr: string) => void
) => void

export interface RuntimeOptions {
  fetchImpl?: RuntimeFetch
  execFileImpl?: RuntimeExec
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  homeDir?: string
  /** How long a single probe may take. */
  timeoutMs?: number
}

export interface RuntimeInstallOptions extends RuntimeOptions {
  /** Runs a downloaded installer; injectable for tests. */
  runInstaller?: (file: string, args: string[], options: { timeoutMs: number }) => Promise<{ code: number | null; output: string }>
  /** Downloads a URL to a file; injectable for tests. */
  download?: DownloadFn
  /** Where installers are staged. */
  tempDir?: string
}

// --- the registry ------------------------------------------------------------

/**
 * The runtimes we look for. The port is the giveaway: every one of these
 * serves on a well-known port, and several of them answer with a banner that
 * names them.
 */
export const RUNTIME_REGISTRY: RuntimeDescriptor[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    vendor: 'Ollama',
    homepage: 'https://ollama.com',
    api: 'ollama',
    port: 11434,
    cli: 'ollama',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/Ollama', '%LOCALAPPDATA%/Ollama'],
    binaries: ['ollama'],
    modelsDir: '~/.ollama/models',
    installable: true,
    accepts: 'pull',
    note: 'Pulls any GGUF straight from the Hugging Face Hub.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    vendor: 'LM Studio',
    homepage: 'https://lmstudio.ai',
    api: 'openai',
    port: 1234,
    cli: 'lms',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/LM Studio', '~/.lmstudio'],
    binaries: ['lms', 'LM Studio'],
    modelsDir: '~/.lmstudio/models',
    installable: false,
    accepts: 'folder',
    note: 'Loads models from its own folder; start its local server to use them.'
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    vendor: 'ggml-org',
    homepage: 'https://github.com/ggml-org/llama.cpp',
    api: 'openai',
    port: 8080,
    cli: 'llama-server',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/llama.cpp', '~/.local/bin'],
    binaries: ['llama-server', 'llama-cli'],
    modelsDir: '~/.toolbox-mcp/models',
    installable: false,
    accepts: 'server',
    note: 'Runs one GGUF per process — toolbox-mcp can start it for you.'
  },
  {
    id: 'jan',
    label: 'Jan',
    vendor: 'Jan',
    homepage: 'https://jan.ai',
    api: 'openai',
    port: 1337,
    cli: 'jan',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/Jan'],
    binaries: ['Jan-Desktop', 'jan'],
    modelsDir: '%APPDATA%/Jan/models',
    installable: false,
    accepts: 'folder',
    note: 'Desktop app with an OpenAI-compatible server on port 1337.'
  },
  {
    id: 'gpt4all',
    label: 'GPT4All',
    vendor: 'Nous Research',
    homepage: 'https://gpt4all.io',
    api: 'openai',
    port: 4891,
    cli: 'gpt4all',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/GPT4All', '%APPDATA%/GPT4All'],
    binaries: ['gpt4all'],
    modelsDir: '%LOCALAPPDATA%/GPT4All/models',
    installable: false,
    accepts: 'folder',
    note: 'Desktop app with an OpenAI-compatible server on port 4891.'
  },
  {
    id: 'koboldcpp',
    label: 'KoboldCpp',
    vendor: 'LostRuins',
    homepage: 'https://github.com/LostRuins/koboldcpp',
    api: 'kobold',
    port: 5001,
    cli: 'koboldcpp',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/KoboldCpp', '~/koboldcpp'],
    binaries: ['koboldcpp'],
    installable: false,
    accepts: 'folder',
    note: 'Kobold API; the model files sit next to the executable.'
  },
  {
    id: 'localai',
    label: 'LocalAI',
    vendor: 'mudler',
    homepage: 'https://localai.io',
    api: 'openai',
    port: 8080,
    cli: 'local-ai',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/localai'],
    binaries: ['local-ai'],
    modelsDir: '%LOCALAPPDATA%/localai/models',
    installable: false,
    accepts: 'folder',
    note: 'Self-hosted API that serves every model in its models folder.'
  },
  {
    id: 'vllm',
    label: 'vLLM',
    vendor: 'vLLM project',
    homepage: 'https://docs.vllm.ai',
    api: 'openai',
    port: 8000,
    cli: 'vllm',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/vLLM'],
    binaries: ['vllm'],
    installable: false,
    accepts: 'server',
    note: 'Serves one model from the Hugging Face Hub at a time.'
  },
  {
    id: 'llamafile',
    label: 'llamafile',
    vendor: 'Mozilla',
    homepage: 'https://github.com/Mozilla-Ocho/llamafile',
    api: 'openai',
    port: 8080,
    cli: 'llamafile',
    cliArgs: ['--version'],
    dirs: ['%LOCALAPPDATA%/Programs/llamafile'],
    binaries: ['llamafile'],
    installable: false,
    accepts: 'server',
    note: 'One executable that embeds a model and serves it.'
  },
  {
    id: 'text-generation-webui',
    label: 'Text generation web UI',
    vendor: 'oobabooga',
    homepage: 'https://github.com/oobabooga/text-generation-webui',
    api: 'openai',
    port: 5000,
    cli: 'webui',
    dirs: ['~/text-generation-webui'],
    binaries: ['webui'],
    modelsDir: '~/text-generation-webui/models',
    installable: false,
    accepts: 'folder',
    note: 'Popular local UI; it needs the API flag to be reachable.'
  }
]

/** The runtime used when the user has not chosen one. */
export const DEFAULT_RUNTIME_ID = 'ollama'

export function runtimeDescriptor(id: string): RuntimeDescriptor | null {
  return RUNTIME_REGISTRY.find((entry) => entry.id === id) ?? null
}

/** The OpenAI-compatible base URL a provider should talk to. */
export function providerBaseUrl(runtime: { api: RuntimeApi; baseUrl: string | null }): string {
  const base = runtime.baseUrl ?? 'http://127.0.0.1:11434'
  return base.endsWith('/v1') ? base : `${base}/v1`
}

// --- helpers ----------------------------------------------------------------

/** Expand ~ and the Windows environment variables we care about. */
export function expandPath(input: string, env: NodeJS.ProcessEnv, home: string): string {
  let out = input.replace(/^~(?=$|[\\/])/, home)
  out = out.replace(/%LOCALAPPDATA%|%APPDATA%|%PROGRAMFILES%|%PROGRAMFILES\(X86\)%|\{LOCALAPPDATA\}|\{APPDATA\}/gi, (match) => {
    const key = match.toUpperCase()
    if (key === '%LOCALAPPDATA%' || key === '{LOCALAPPDATA}') {
      return env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local')
    }
    if (key === '%APPDATA%' || key === '{APPDATA}') {
      return env.APPDATA ?? path.join(home, 'AppData', 'Roaming')
    }
    if (key === '%PROGRAMFILES(X86)%') return env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return env.ProgramFiles ?? 'C:\\Program Files'
  })
  return out
}

/** The directory a runtime keeps its model files in. */
export function runtimeModelsDir(descriptor: RuntimeDescriptor, options: RuntimeOptions = {}): string | null {
  if (!descriptor.modelsDir) return null
  const home = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  if (descriptor.id === 'ollama' && env.OLLAMA_MODELS?.trim()) return expandPath(env.OLLAMA_MODELS, env, home)
  return expandPath(descriptor.modelsDir, env, home)
}

/** Probe the destination volume, walking up only when a directory does not exist yet. */
export async function freeDiskBytes(
  directory: string,
  inspect: (directory: string) => Promise<{ bsize: number; bavail: number }> = statfs
): Promise<number | null> {
  let current = path.resolve(directory)
  for (;;) {
    try {
      const stats = await inspect(current)
      const free = stats.bsize * stats.bavail
      return Number.isFinite(free) && free >= 0 ? free : null
    } catch (cause) {
      const parent = path.dirname(current)
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) return null
      current = parent
    }
  }
}

/** A version string out of CLI output, e.g. 'ollama version 0.12.3' -> '0.12.3'. */
export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)
  return match ? match[1] : null
}

/**
 * A short label for runtimes that do not print a semantic version. LM Studio
 * answers with 'CLI commit: 43d4b26', which is more useful than nothing.
 */
export function parseVersionBanner(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry && /\d/.test(entry))
  return line ? line.slice(0, 40) : null
}

async function tryJson(url: string, options: RuntimeOptions): Promise<unknown | null> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as RuntimeFetch)
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 1200) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

async function tryText(url: string, options: RuntimeOptions): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as RuntimeFetch)
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 1200) })
    if (!response.ok) return null
    return (await response.text()).slice(0, 400)
  } catch {
    return null
  }
}

function parseOllamaModels(payload: unknown): RuntimeModel[] {
  const rows = (payload as { models?: Array<Record<string, unknown>> } | null)?.models ?? []
  return rows.map((row) => ({
    name: String(row.name ?? row.model ?? 'unknown'),
    sizeBytes: Number(row.size ?? 0),
    modifiedAt: typeof row.modified_at === 'string' ? row.modified_at : null
  }))
}

function parseOpenAiModels(payload: unknown): RuntimeModel[] {
  const rows = (payload as { data?: Array<Record<string, unknown>> } | null)?.data ?? []
  return rows.map((row) => ({
    name: String(row.id ?? row.name ?? 'unknown'),
    sizeBytes: 0,
    modifiedAt: null
  }))
}

/** Banners that name the runtime serving a port. */
const IDENTITY_MARKERS: Array<[RegExp, string]> = [
  [/llama\.cpp/i, 'llamacpp'],
  [/llamafile/i, 'llamafile'],
  [/vllm/i, 'vllm'],
  [/localai/i, 'localai'],
  [/kobold/i, 'koboldcpp'],
  [/gpt-?4all/i, 'gpt4all'],
  [/lm\s?studio/i, 'lmstudio'],
  [/oobabooga|text-generation-webui/i, 'text-generation-webui'],
  [/\bjan\b/i, 'jan']
]

function identifyServer(root: string | null): string | null {
  if (!root) return null
  for (const [pattern, id] of IDENTITY_MARKERS) {
    if (pattern.test(root)) return id
  }
  return null
}

interface PortProbe {
  port: number
  baseUrl: string
  api: RuntimeApi
  /** The runtime that named itself, when it did. */
  identity: string | null
  models: RuntimeModel[]
}

/** Ask one port what it is and what it serves. */
export async function probePort(port: number, options: RuntimeOptions = {}): Promise<PortProbe | null> {
  const baseUrl = `http://127.0.0.1:${port}`

  // Ollama is the only runtime with its own version endpoint.
  const version = await tryJson(`${baseUrl}/api/version`, options)
  if (version && typeof version === 'object' && 'version' in version) {
    const tags = await tryJson(`${baseUrl}/api/tags`, options)
    return { port, baseUrl, api: 'ollama', identity: 'ollama', models: parseOllamaModels(tags) }
  }

  // OpenAI-compatible servers expose /v1/models.
  const openai = await tryJson(`${baseUrl}/v1/models`, options)
  if (openai) {
    const root = await tryText(`${baseUrl}/`, options)
    return { port, baseUrl, api: 'openai', identity: identifyServer(root), models: parseOpenAiModels(openai) }
  }

  // KoboldCpp keeps its own model list.
  const kobold = await tryJson(`${baseUrl}/api/v1/models`, options)
  if (kobold) {
    const root = await tryText(`${baseUrl}/`, options)
    return { port, baseUrl, api: 'kobold', identity: identifyServer(root) ?? 'koboldcpp', models: parseOpenAiModels(kobold) }
  }

  return null
}

/**
 * Probe a runtime's CLI for a version.
 *
 * Only the command on PATH is executed — a desktop app found in its install
 * folder is reported, never launched, because some of them open a window
 * instead of answering a flag.
 */
export async function probeRuntimeCli(
  descriptor: RuntimeDescriptor,
  options: RuntimeOptions = {}
): Promise<{ installed: boolean; version: string | null; path: string | null }> {
  if (!descriptor.cli) return { installed: false, version: null, path: null }
  const execImpl = options.execFileImpl ?? (execFile as unknown as RuntimeExec)
  const result = await new Promise<{ ok: boolean; stdout: string; stderr: string }>((resolve) => {
    try {
      execImpl(
        descriptor.cli as string,
        descriptor.cliArgs ?? ['--version'],
        { timeout: options.timeoutMs ?? 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => resolve({ ok: !error, stdout: stdout ?? '', stderr: stderr ?? '' })
      )
    } catch {
      resolve({ ok: false, stdout: '', stderr: '' })
    }
  })
  if (!result.ok) return { installed: false, version: null, path: null }
  // Some runtimes print their banner on stderr (llama-server does).
  const output = `${result.stdout}\n${result.stderr}`
  return { installed: true, version: parseVersion(output) ?? parseVersionBanner(output), path: null }
}

/** File names a runtime may be installed under. */
const BINARY_SUFFIXES = ['', '.exe', '.bat', '.cmd', '.sh']

/**
 * Look for the executable of a runtime in its known folders.
 *
 * A folder on its own proves nothing — an uninstalled app leaves its data
 * behind — so the folder has to hold the program itself.
 */
export function findRuntimeBinary(
  descriptor: RuntimeDescriptor,
  options: RuntimeOptions = {}
): string | null {
  const home = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const names = descriptor.binaries ?? (descriptor.cli ? [descriptor.cli] : [])
  if (!names.length) return null
  const folders: string[] = []
  for (const dir of descriptor.dirs ?? []) {
    const full = expandPath(dir, env, home)
    folders.push(full, path.join(full, 'bin'), path.join(full, 'app'))
  }
  for (const folder of folders) {
    for (const name of names) {
      for (const suffix of BINARY_SUFFIXES) {
        const file = path.join(folder, name + suffix)
        try {
          if (existsSync(file) && statSync(file).isFile()) return file
        } catch {
          // An unreadable path simply is not an install.
        }
      }
    }
  }
  return null
}

/**
 * Look for every runtime we know: a live server, a CLI, an install folder.
 * Ports are probed once each; when two runtimes share a port, the one that
 * names itself wins and the other says so.
 */
export async function detectRuntimes(options: RuntimeOptions & { active?: string | null } = {}): Promise<RuntimeReport> {
  const platform = options.platform ?? process.platform
  const ports = [...new Set(RUNTIME_REGISTRY.map((entry) => entry.port))]
  const probes = await Promise.all(
    ports.map(async (port) => {
      try {
        return await probePort(port, options)
      } catch {
        return null
      }
    })
  )

  const runtimes: RuntimeStatus[] = []
  for (const descriptor of RUNTIME_REGISTRY) {
    const probe = probes.find((entry) => entry?.port === descriptor.port) ?? null
    const owner = probe?.identity ?? null
    const others = RUNTIME_REGISTRY.filter(
      (entry) => entry.port === descriptor.port && entry.id !== descriptor.id
    )
    const claimedByOther = owner !== null && owner !== descriptor.id
    const unclaimedButTaken =
      probe !== null && owner === null && RUNTIME_REGISTRY.find((entry) => entry.port === descriptor.port)?.id !== descriptor.id

    const cli = await probeRuntimeCli(descriptor, options)
    const binary = findRuntimeBinary(descriptor, options)

    let note = descriptor.note
    if (claimedByOther) {
      const named = runtimeDescriptor(owner as string)
      note = `Port ${descriptor.port} is served by ${named?.label ?? owner}.`
    } else if (unclaimedButTaken) {
      note = `Port ${descriptor.port} already answers — it is an OpenAI-compatible server of another kind.`
    }

    runtimes.push({
      id: descriptor.id,
      label: descriptor.label,
      vendor: descriptor.vendor,
      homepage: descriptor.homepage,
      api: descriptor.api,
      port: descriptor.port,
      installed: cli.installed || binary !== null || probe !== null,
      running: probe !== null && !claimedByOther && !unclaimedButTaken,
      identified: probe !== null && (owner !== null || others.length === 0),
      baseUrl: probe !== null && !claimedByOther && !unclaimedButTaken ? probe.baseUrl : null,
      version: cli.version,
      path: binary,
      models: probe !== null && !claimedByOther && !unclaimedButTaken ? probe.models : [],
      accepts: descriptor.accepts,
      installable: descriptor.installable,
      note
    })
  }

  return {
    runtimes,
    active: options.active ?? null,
    detectedAt: Date.now(),
    platform
  }
}

/** The models a runtime is currently serving. */
export async function listRuntimeModels(
  descriptor: RuntimeDescriptor,
  options: RuntimeOptions = {}
): Promise<{ models: RuntimeModel[]; baseUrl: string; error: string | null }> {
  const baseUrl = `http://127.0.0.1:${descriptor.port}`
  const probe = await probePort(descriptor.port, options)
  if (!probe) {
    return { models: [], baseUrl, error: `Nothing is answering on port ${descriptor.port}.` }
  }
  return { models: probe.models, baseUrl: probe.baseUrl, error: null }
}

// --- installing Ollama -------------------------------------------------------

const OLLAMA_WINDOWS_INSTALLER = 'https://ollama.com/download/OllamaSetup.exe'
const OLLAMA_LINUX_SCRIPT = 'https://ollama.com/install.sh'
const OLLAMA_MACOS_APP = 'https://ollama.com/download/Ollama-darwin.zip'

/** The official silent-install switches for the Inno Setup Windows installer. */
export const OLLAMA_SILENT_ARGS = ['/SP-', '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']

export interface RuntimeInstallResult {
  ok: boolean
  id: string
  /** 'installed' for a new install, 'updated' when one was already there. */
  action: 'installed' | 'updated' | 'failed' | 'unsupported'
  version: string | null
  message: string
  steps: string[]
  log: string
}

/** Download a URL to a file; returns the number of bytes written. */
export async function downloadFile(
  url: string,
  target: string,
  options: RuntimeOptions & { fetchImpl?: RuntimeFetch } = {},
  onProgress?: (progress: DownloadProgress) => void
): Promise<number> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as RuntimeFetch)
  const response = await fetchImpl(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status} for ${url}`)
  await mkdir(path.dirname(target), { recursive: true })
  const lengthHeader = response.headers?.get('content-length') ?? null
  const totalBytes = lengthHeader !== null && Number.isFinite(Number(lengthHeader)) ? Number(lengthHeader) : null
  if (response.body) {
    let received = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, callback) {
        received += chunk.length
        onProgress?.({ receivedBytes: received, totalBytes })
        callback(null, chunk)
      }
    })
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(target))
  } else {
    const buffer = Buffer.from(await response.text(), 'utf8')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(target, buffer)
    onProgress?.({ receivedBytes: buffer.length, totalBytes: buffer.length })
  }
  const info = await stat(target)
  onProgress?.({ receivedBytes: info.size, totalBytes: info.size })
  return info.size
}

async function runInstaller(
  file: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (code: number | null): void => {
      if (settled) return
      settled = true
      resolve({ code, output })
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (cause) {
      output += cause instanceof Error ? cause.message : String(cause)
      finish(null)
      return
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // The process may already be gone.
      }
      output += '\nInstaller timed out.'
      finish(null)
    }, options.timeoutMs)
    child.stdout?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      output += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      output += error.message
      finish(null)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      finish(code)
    })
  })
}

/** Start a background server and let it outlive this call. */
function startDetached(file: string, args: string[]): void {
  try {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
  } catch {
    // A runtime that will not start is reported by the follow-up probe.
  }
}

/** Wait for the Ollama API to answer; returns its version or null. */
async function waitForOllama(options: RuntimeOptions, attempts: number, delayMs: number): Promise<string | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const payload = await tryJson('http://127.0.0.1:11434/api/version', options)
    if (payload && typeof payload === 'object' && 'version' in payload) {
      return String((payload as { version: unknown }).version)
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}

/**
 * Install (or update) Ollama from the official installer, so the machine ends
 * up with a fresh version rather than a stale one. The Windows installer runs
 * silently and per user — no administrator rights needed.
 */
export async function installOllama(options: RuntimeInstallOptions = {}): Promise<RuntimeInstallResult> {
  const platform = options.platform ?? process.platform
  const home = options.homeDir ?? os.homedir()
  const env = options.env ?? process.env
  const download = options.download ?? ((url: string, target: string) => downloadFile(url, target, options))
  const installer = options.runInstaller ?? ((file, args, runOptions) => runInstaller(file, args, runOptions))
  const tempRoot = options.tempDir ?? path.join(os.tmpdir(), 'toolbox-mcp-install')
  const steps: string[] = []
  let log = ''

  const before = await probeRuntimeCli(runtimeDescriptor('ollama') as RuntimeDescriptor, options)
  const action: RuntimeInstallResult['action'] = before.installed ? 'updated' : 'installed'

  try {
    if (platform === 'win32') {
      const target = path.join(tempRoot, 'OllamaSetup.exe')
      steps.push(`Download ${OLLAMA_WINDOWS_INSTALLER}`)
      await download(OLLAMA_WINDOWS_INSTALLER, target)
      steps.push(`Run the installer silently (${OLLAMA_SILENT_ARGS.join(' ')})`)
      const result = await installer(target, OLLAMA_SILENT_ARGS, { timeoutMs: 15 * 60 * 1000 })
      log = result.output
      if (result.code !== 0) {
        return {
          ok: false,
          id: 'ollama',
          action: 'failed',
          version: before.version,
          message: `The Ollama installer exited with code ${result.code}.`,
          steps,
          log
        }
      }
    } else if (platform === 'darwin') {
      const target = path.join(tempRoot, 'Ollama-darwin.zip')
      steps.push(`Download ${OLLAMA_MACOS_APP}`)
      await download(OLLAMA_MACOS_APP, target)
      const appDir = path.join(home, 'Applications')
      steps.push('Unpack the app into ~/Applications')
      await mkdir(appDir, { recursive: true })
      const unpack = await installer('/usr/bin/unzip', ['-q', '-o', target, '-d', appDir], { timeoutMs: 10 * 60 * 1000 })
      log = unpack.output
      if (unpack.code !== 0) {
        return {
          ok: false,
          id: 'ollama',
          action: 'failed',
          version: before.version,
          message: 'Could not unpack the Ollama app.',
          steps,
          log
        }
      }
    } else {
      const target = path.join(tempRoot, 'install.sh')
      steps.push(`Download ${OLLAMA_LINUX_SCRIPT}`)
      await download(OLLAMA_LINUX_SCRIPT, target)
      steps.push('Run the official install script (it may ask for sudo)')
      const result = await installer('/bin/sh', [target], { timeoutMs: 15 * 60 * 1000 })
      log = result.output
      if (result.code !== 0) {
        return {
          ok: false,
          id: 'ollama',
          action: 'failed',
          version: before.version,
          message: `The Ollama install script exited with code ${result.code}.`,
          steps,
          log
        }
      }
    }
  } catch (cause) {
    return {
      ok: false,
      id: 'ollama',
      action: 'failed',
      version: before.version,
      message: cause instanceof Error ? cause.message : String(cause),
      steps,
      log
    }
  }

  // The installer may have replaced the binary in place; find it again.
  const cliPath =
    platform === 'win32'
      ? path.join(env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'Ollama', 'ollama.exe')
      : '/usr/local/bin/ollama'
  const cliOptions: RuntimeOptions = { ...options }
  const after = await probeRuntimeCli(runtimeDescriptor('ollama') as RuntimeDescriptor, cliOptions)

  // Make sure something is actually serving on 11434.
  let serving = await waitForOllama(options, 3, 1000)
  if (!serving && (after.installed || existsSync(cliPath))) {
    const binary = existsSync(cliPath) ? cliPath : 'ollama'
    steps.push('Start the Ollama server')
    startDetached(binary, ['serve'])
    serving = await waitForOllama(options, 20, 1500)
  }

  const version = serving ?? after.version
  if (!version) {
    return {
      ok: false,
      id: 'ollama',
      action: 'failed',
      version: null,
      message: 'Ollama was installed but did not report a version. Open Ollama and try again.',
      steps,
      log
    }
  }

  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  return {
    ok: true,
    id: 'ollama',
    action,
    version,
    message:
      action === 'updated'
        ? `Ollama ${version} is installed and serving on http://127.0.0.1:11434.`
        : `Ollama ${version} is installed and serving on http://127.0.0.1:11434.`,
    steps,
    log
  }
}

// --- weights for a runtime that cannot pull ----------------------------------

export interface GgufFile {
  /** Hub identity used to isolate equal filenames from different repositories. */
  repoId?: string
  filename: string
  url: string
  sizeBytes: number
}

/**
 * Resolve one complete GGUF. Explicit choices never silently fall back;
 * split GGUFs require a multi-file installer and are refused here.
 */
export async function resolveGgufFile(
  repoId: string,
  quant?: string | null,
  options: RuntimeOptions = {}
): Promise<GgufFile | null> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as RuntimeFetch)
  const url = `https://huggingface.co/api/models/${repoId
    .split('/')
    .map(encodeURIComponent)
    .join('/')}?blobs=true`
  let detail: { siblings?: Array<{ rfilename: string; size?: number; lfs?: { size?: number } }> }
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(15000) })
    if (!response.ok) return null
    detail = (await response.json()) as typeof detail
  } catch {
    return null
  }
  const files = (detail.siblings ?? []).filter((file) => file.rfilename.toLowerCase().endsWith('.gguf'))
  if (!files.length) return null
  const sizeOf = (file: (typeof files)[number]): number => Number(file.lfs?.size ?? file.size ?? 0)
  const wanted = quant?.trim().toUpperCase()
  const exact = wanted ? files.find((file) => parseQuantLabel(file.rfilename) === wanted || file.rfilename.toUpperCase() === wanted) : undefined
  if (wanted && !exact) throw new Error(`Quantization ${quant} is not available in ${repoId}. Choose an available quant.`)
  const chosen = exact ?? files.reduce((a, b) => (sizeOf(a) >= sizeOf(b) ? a : b))
  if (/-\d{5}-of-\d{5}\.gguf$/i.test(chosen.rfilename)) {
    throw new Error('Split GGUF downloads are not supported. Choose a single-file GGUF or use the runtime\'s own importer.')
  }
  return {
    repoId,
    filename: chosen.rfilename,
    url: `https://huggingface.co/${repoId}/resolve/main/${chosen.rfilename
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`,
    sizeBytes: sizeOf(chosen)
  }
}

/** Stable per-repository namespace; never accept path traversal from Hub metadata. */
export function ggufDirectory(file: GgufFile, directory: string): string {
  if (!file.repoId) return directory
  const parts = file.repoId.split('/')
  if (parts.length !== 2 || parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
    throw new Error('Invalid HuggingFace repository identity for the model directory.')
  }
  return path.join(directory, ...parts)
}

/** Publish validated weights without overwriting an existing model; always clean staging. */
export async function downloadGguf(
  file: GgufFile,
  directory: string,
  options: RuntimeOptions & { download?: DownloadFn; onProgress?: (progress: DownloadProgress) => void } = {}
): Promise<{ path: string; bytes: number }> {
  const download = options.download ?? ((url: string, target: string, onProgress?: (p: DownloadProgress) => void) => downloadFile(url, target, options, onProgress))
  const destination = ggufDirectory(file, directory)
  await mkdir(destination, { recursive: true })
  const target = path.join(destination, path.basename(file.filename))
  if (existsSync(target)) throw new Error(`Model file already exists: ${target}. It was not replaced.`)
  const staging = `${target}.${randomUUID()}.part`
  try {
    await download(file.url, staging, options.onProgress)
    const bytes = (await stat(staging)).size
    if (bytes === 0 || (file.sizeBytes > 0 && bytes !== file.sizeBytes)) {
      throw new Error(`Downloaded size ${bytes} bytes; expected ${file.sizeBytes > 0 ? file.sizeBytes : 'non-empty weights'}. Model was not installed.`)
    }
    // A same-directory hard link atomically claims the name and fails on EEXIST,
    // unlike rename(), which can silently replace a model installed concurrently.
    await link(staging, target)
    return { path: target, bytes }
  } finally {
    await rm(staging, { force: true })
  }
}

// --- serving a model with the runtime that was found ---------------------------

export interface ServerStartResult {
  ok: boolean
  baseUrl: string | null
  message: string
  steps: string[]
  log: string
}

/**
 * Start a runtime that serves one model per process (llama.cpp, llamafile)
 * with the weights we just downloaded, and wait for it to answer.
 */
export async function startServerRuntime(
  descriptor: RuntimeDescriptor,
  modelPath: string,
  options: RuntimeOptions = {}
): Promise<ServerStartResult> {
  if (!descriptor.cli) {
    return {
      ok: false,
      baseUrl: null,
      message: `${descriptor.label} has no command line to start.`,
      steps: [],
      log: ''
    }
  }
  const args =
    descriptor.id === 'llamafile'
      ? ['-m', modelPath, '--port', String(descriptor.port), '--host', '127.0.0.1']
      : ['-m', modelPath, '--port', String(descriptor.port), '--host', '127.0.0.1']
  startDetached(descriptor.cli, args)
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const probe = await probePort(descriptor.port, options)
    if (probe) {
      return {
        ok: true,
        baseUrl: probe.baseUrl,
        message: `${descriptor.label} is serving the model on ${probe.baseUrl}.`,
        steps: [`${descriptor.cli} ${args.join(' ')}`],
        log: ''
      }
    }
  }
  return {
    ok: false,
    baseUrl: null,
    message: `${descriptor.label} did not answer on port ${descriptor.port} within 25 seconds.`,
    steps: [`${descriptor.cli} ${args.join(' ')}`],
    log: ''
  }
}

