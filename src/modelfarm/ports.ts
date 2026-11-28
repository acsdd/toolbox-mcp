/** Injectable boundaries; the domain service never imports Electron or Node I/O. */
import type {
  DetectOptions,
  FetchCatalogOptions,
  FetchLike,
  FetchModelOptions,
  GgufQuant,
  MachineProfile,
  ModelTask,
  OllamaCliInfo,
  PullResult,
  ScoreRuntime
} from '@toolbox/widgets'
import type { DownloadFn, GgufFile, RuntimeDescriptor, RuntimeInstallOptions, RuntimeInstallResult, RuntimeStatus, ServerStartOptions, ServerStartResult } from '../runtimes.js'
import type { CatalogLoadRequest, CatalogLoadResult, CatalogScope, ModelFarmPreferences } from './contracts.js'

export interface MachinePort {
  detect(options?: DetectOptions): Promise<MachineProfile>
}

export interface CatalogPort {
  fetchCatalog(options?: FetchCatalogOptions): Promise<import('@toolbox/widgets').CatalogModel[]>
  searchCatalog(query: string, options?: { formats?: import('@toolbox/widgets').ModelFormat[]; fetchImpl?: FetchLike }): Promise<import('@toolbox/widgets').CatalogModel[]>
  fetchModelById(repo: string, options?: FetchModelOptions): Promise<import('@toolbox/widgets').CatalogModel | null>
  listGgufQuants(repo: string, options?: FetchModelOptions): Promise<GgufQuant[]>
}

export interface CachePort {
  readonly path: string
  load(request: CatalogLoadRequest): Promise<CatalogLoadResult>
  migrate(legacyFiles: readonly string[], scope: CatalogScope): Promise<boolean>
}

export interface InventoryPort {
  names(runtime: string): Promise<string[]>
}

export interface RuntimePort {
  descriptor(id: string): RuntimeDescriptor | null
  defaultRuntimeId: string
  modelsDirectory(descriptor: RuntimeDescriptor): string | null
  listModels(descriptor: RuntimeDescriptor): Promise<{ models: Array<{ name: string }>; baseUrl: string; error: string | null }>
  resolveGguf(repo: string, quant: string | null): Promise<GgufFile | null>
  downloadGguf(file: GgufFile, directory: string, options: {
    signal?: AbortSignal
    onProgress?: (progress: { receivedBytes: number; totalBytes: number | null }) => void
    download?: DownloadFn
  }): Promise<{ path: string; bytes: number }>
  ggufDirectory(file: GgufFile, directory: string): string
  freeDisk(directory: string): Promise<number | null>
  probeOllama(): Promise<OllamaCliInfo>
  pull(reference: string): Promise<PullResult>
  run(args: string[], signal?: AbortSignal): Promise<PullResult>
  startServer(descriptor: RuntimeDescriptor, path: string, options?: ServerStartOptions): Promise<ServerStartResult>
  providerBaseUrl(runtime: { api: RuntimeDescriptor['api']; baseUrl: string | null }): string | null
  status(id: string): RuntimeStatus | null
  createModelfile(reference: string, offload: number): Promise<{ path: string; cleanup(): Promise<void> }>
}

export interface SettingsPort {
  preferences(): ModelFarmPreferences
  rawPreferences(): unknown
  savePreferences(input: unknown): Promise<ModelFarmPreferences>
  activeRuntime(): string | null
  notes(): Record<string, string>
  saveNote(input: unknown): Promise<Record<string, string>>
  installHistory(): unknown[]
  recordInstall(result: import('./contracts.js').LlamafarmInstallResult): Promise<import('./contracts.js').LlamafarmInstallResult>
  /** One transactional merge, persisted before the new snapshot is published. */
  migratePreferences(legacy: unknown): Promise<ModelFarmPreferences>
}

export interface LifecyclePort {
  assertAccepting(): void
  isClosing(): boolean
  signal: AbortSignal
  invalidate(): void
  abortDownloads(): void
  rememberShutdownError(cause: unknown): void
}

export interface MigrationPort {
  readJson(path: string): Promise<unknown>
}

export interface ModelFarmPorts {
  machine: MachinePort
  catalog: CatalogPort
  cache: CachePort
  inventory: InventoryPort
  runtime: RuntimePort
  settings: SettingsPort
  migration: MigrationPort
  lifecycle: LifecyclePort
  tasks?: readonly ModelTask[]
  scoreRuntime?: ScoreRuntime
  installRuntime?: (options: RuntimeInstallOptions) => Promise<RuntimeInstallResult>
}
