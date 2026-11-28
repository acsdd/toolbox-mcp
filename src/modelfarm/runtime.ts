/** Node adapters for the Electron-free Model Farm domain. */
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { probeOllamaCli, type ExecFileLike, type PullResult } from '@toolbox/widgets'
import { writeAtomic } from '../config.js'
import { pullIntoOwnedOllama, runOwnedOllamaCommand, type OllamaSpawnLike } from '../ollama-process.js'
import {
  DEFAULT_RUNTIME_ID,
  downloadGguf,
  freeDiskBytes,
  ggufDirectory,
  listRuntimeModels,
  providerBaseUrl,
  resolveGgufFile,
  runtimeDescriptor,
  runtimeModelsDir,
  startServerRuntime,
  type DownloadFn,
  type RuntimeExec,
  type RuntimeFetch,
  type RuntimeOptions
} from '../runtimes.js'
import type { CacheIo } from './contracts.js'
import type { RuntimePort } from './ports.js'

export function createNodeCacheIo(): CacheIo {
  return {
    async read(path) {
      try { return await readFile(path, 'utf8') }
      catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw cause
      }
    },
    write: (path, data) => writeAtomic(path, data)
  }
}

export interface ModelFarmRuntimeAdaptersOptions {
  runtimeOptions?: RuntimeOptions
  execFileImpl?: ExecFileLike
  freeDiskImpl?: RuntimePort['freeDisk']
  downloadFileImpl?: DownloadFn
  pullModel?: (reference: string) => Promise<PullResult>
  runOllama?: (args: string[], signal?: AbortSignal) => Promise<PullResult>
  spawnOllamaImpl?: OllamaSpawnLike
  onShutdownError?: (cause: unknown) => void
}

/** Adapt the existing runtime/download/process helpers; no parallel implementation. */
export function createRuntimePort(options: ModelFarmRuntimeAdaptersOptions = {}): RuntimePort {
  const runtimeOptions: RuntimeOptions = options.runtimeOptions ?? {}
  const execFileImpl = options.execFileImpl ?? (execFile as unknown as ExecFileLike)
  const signal = runtimeOptions.signal
  const remember = (cause: unknown): never => {
    options.onShutdownError?.(cause)
    throw cause
  }
  return {
    defaultRuntimeId: DEFAULT_RUNTIME_ID,
    descriptor: runtimeDescriptor,
    modelsDirectory: (descriptor) => runtimeModelsDir(descriptor, runtimeOptions),
    listModels: (descriptor) => listRuntimeModels(descriptor, runtimeOptions),
    resolveGguf: (repo, quant) => resolveGgufFile(repo, quant, runtimeOptions),
    ggufDirectory,
    freeDisk: options.freeDiskImpl ?? ((directory) => freeDiskBytes(directory)),
    async downloadGguf(file, directory, downloadOptions) {
      return downloadGguf(file, directory, {
        ...runtimeOptions,
        ...(downloadOptions.download ? { download: downloadOptions.download } : {}),
        ...(downloadOptions.signal ? { signal: downloadOptions.signal } : {}),
        ...(downloadOptions.onProgress ? { onProgress: downloadOptions.onProgress } : {})
      })
    },
    probeOllama: () => probeOllamaCli(execFileImpl),
    pull: options.pullModel ?? (async (reference) => {
      try {
        return await pullIntoOwnedOllama(reference, { signal, spawnImpl: options.spawnOllamaImpl })
      } catch (cause) { return remember(cause) }
    }),
    run: options.runOllama ?? (async (args, runSignal) => {
      try {
        return await runOwnedOllamaCommand(args, { signal: runSignal ?? signal, spawnImpl: options.spawnOllamaImpl })
      } catch (cause) { return remember(cause) }
    }),
    startServer: (descriptor, path, startOptions) => startServerRuntime(descriptor, path, { ...runtimeOptions, ...startOptions }),
    providerBaseUrl
  }
}

export type { RuntimeFetch, RuntimeExec }
