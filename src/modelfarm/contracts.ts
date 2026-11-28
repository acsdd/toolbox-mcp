/** Electron-free contracts shared by MCP, the compatibility CLI and widgets. */
import type {
  CatalogModel,
  FitScenario,
  FitVerdict,
  MachineGrade,
  MachineProfile,
  ModelFormat,
  ModelTask,
  OllamaInstallPlan,
  ScoredModel,
  ScoreRuntime,
  SetupGrade
} from '@toolbox/widgets'

export type {
  CatalogModel,
  FitScenario,
  FitVerdict,
  MachineGrade,
  MachineProfile,
  ModelFormat,
  ModelTask,
  ScoredModel,
  ScoreRuntime,
  SetupGrade
}

export interface ModelFarmPreferences {
  scenario: FitScenario
  taskFilter: string
  minParams: number | null
  maxParams: number | null
  showReds: boolean
}

export interface ModelQueryInput {
  search?: string | null
  /** A single task and/or a task list; both are combined before normalization. */
  task?: ModelTask | string | readonly string[] | null
  tasks?: readonly string[] | ModelTask | string | null
  formats?: ModelFormat | string | readonly string[] | null
  minParams?: number | null
  maxParams?: number | null
  scenario?: FitScenario | null
  runtime?: ScoreRuntime | string | null
  /** MCP's historical reachability switch. */
  onlyReachable?: boolean
  /** Panel preference: false hides red models that have no reachability hints. */
  showReds?: boolean
  top?: number | null
  /** Policy defaults are supplied by the caller, never inferred from the catalog. */
  defaultFormats?: readonly ModelFormat[]
  defaultScenario?: FitScenario
  defaultRuntime?: ScoreRuntime
}

export interface NormalizedModelQuery {
  search: string
  /** Empty means every task; otherwise MODEL_TASKS order. */
  tasks: ModelTask[]
  formats: ModelFormat[]
  minParams: number | null
  maxParams: number | null
  scenario: FitScenario
  runtime: ScoreRuntime
  hideUnreachable: boolean
  /** Null means no display limit. */
  top: number | null
}

export interface ModelInventory {
  names: readonly string[]
  /** Optional assertion of where the names came from; query runtime remains authoritative. */
  runtime?: string
}

export interface FarmScoredModel extends ScoredModel {
  installed: string | null
  installedRuntime: string | null
}

export interface ModelGroup {
  task: ModelTask
  label: string
  icon: string
  models: FarmScoredModel[]
}

export interface ModelQueryResult {
  query: NormalizedModelQuery
  /** Visible matched models before per-group top truncation. */
  models: FarmScoredModel[]
  groups: ModelGroup[]
  /** Visible matched count before top truncation. */
  total: number
}

export interface QuerySnapshot {
  models: readonly CatalogModel[]
  machine: MachineProfile
  query?: ModelQueryInput
  inventory?: ModelInventory
  runtime?: ScoreRuntime
  /** Test/integration seam; production always delegates to @toolbox/widgets.scoreModels. */
  score?: (options: Parameters<typeof import('@toolbox/widgets').scoreModels>[0]) => ScoredModel[]
}

export interface CatalogScope {
  /** Undefined/empty means full task coverage. */
  tasks?: readonly ModelTask[]
  formats: readonly ModelFormat[]
  runtime: string
  perTask: number
}

export interface CatalogLoadRequest extends CatalogScope {
  refresh?: boolean
}

export interface CatalogLoadResult {
  models: CatalogModel[]
  fetchedAt: number | null
  fromCache: boolean
  coverage: ModelTask[] | '*'
  error: string | null
}

export interface InstallProjection extends OllamaInstallPlan {
  runtimeRamBytes: number
}

export interface ModelFarmMigrationInput {
  legacyPreferencesPath: string
  legacyCatalogPath: string
  /** Explicit data-root selection; paths are never shared between installations. */
  location: 'installed' | 'portable'
}

export interface ModelExplainResult {
  model: CatalogModel
  machine: MachineProfile
  now: ScoredModel
  total: ScoredModel
  grade: SetupGrade
  plan: InstallProjection | null
  planError: string | null
}

export interface CacheIo {
  read(path: string): Promise<string | null>
  /** Implementations must publish complete JSON atomically. */
  write(path: string, data: string): Promise<void>
}

export interface CatalogCacheOptions {
  /** A legacy or caller-visible path; the canonical document uses a sibling v2 path. */
  path: string
  legacyPaths?: readonly string[]
  io?: CacheIo
  now?: () => number
  ttlMs?: number
}

export interface CacheBucketScope {
  tasks: ModelTask[] | '*'
  formats: ModelFormat[]
  runtime: string
  perTask: number
}

export interface CatalogCacheBucket extends CacheBucketScope {
  fetchedAt: number
  /** Per-task ages allow partial refreshes without making unrelated data look new. */
  taskFetchedAt: Partial<Record<ModelTask, number>>
  models: CatalogModel[]
}

export interface CatalogCacheDocument {
  version: 2
  buckets: Record<string, CatalogCacheBucket>
}

export interface LlamafarmScoreInput {
  scenario: FitScenario
  search?: string
  minParams?: number | null
  maxParams?: number | null
  onlyReachable?: boolean
  tasks?: readonly ModelTask[]
  formats?: readonly ModelFormat[]
  runtime?: ScoreRuntime
  top?: number | null
}

export interface LlamafarmScoreResult {
  machine: MachineProfile
  machineGrade: MachineGrade
  scenario: FitScenario
  fetchedAt: number | null
  groups: ModelGroup[]
  total: number
  error: string | null
}

export interface LlamafarmSearchInput {
  query: string
  scenario?: FitScenario
  tasks?: readonly ModelTask[]
  top?: number | null
}

export interface LlamafarmSearchResult {
  query: string
  scenario: FitScenario
  machine: MachineProfile
  machineGrade: MachineGrade
  groups: ModelGroup[]
  total: number
  error: string | null
}

export interface LlamafarmQuantsResult {
  repo: string
  quants: import('@toolbox/widgets').GgufQuant[]
  error: string | null
}

export interface LlamafarmRemoveInput {
  repo?: string
  model?: string
  runtime?: string
}

export interface LlamafarmRemoveResult {
  ok: boolean
  removed: string | null
  reason: 'removed' | 'not-found' | 'failed' | 'unsupported-runtime'
  message: string
  output: string
}

export interface LlamafarmRunNowResult {
  scenario: 'now'
  machine: MachineProfile
  picks: Array<{ task: ModelTask; label: string; model: FarmScoredModel }>
}

export interface FarmDownload {
  repo: string
  runtime: string
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  percent: number | null
  receivedBytes: number
  totalBytes: number | null
  file: string | null
  error: string | null
  startedAt: number
}

export interface LlamafarmCancelInput { repo: string }
export interface LlamafarmCancelResult { ok: boolean; repo: string; message: string }
export interface LlamafarmProgressResult { downloads: FarmDownload[] }

export interface LlamafarmGradeInput {
  repo?: string
  scenario?: FitScenario
}

export interface LlamafarmGradeResult {
  machine: MachineProfile
  machineGrade: MachineGrade
  scenario: FitScenario
  model: CatalogModel | null
  grade: SetupGrade | null
  error: string | null
}

export interface LlamafarmInstallInput {
  repo: string
  quant?: string
  offload?: number
  runtime?: string
}

export type LlamafarmInstallReason =
  | 'installed'
  | 'ollama-missing'
  | 'not-found'
  | 'failed'
  | 'runtime-missing'
  | 'insufficient-disk'
  | 'cancelled'
  | 'unsupported-runtime'

export interface LlamafarmInstallResult {
  ok: boolean
  repo: string
  reference: string | null
  modelName: string | null
  reason: LlamafarmInstallReason
  message: string
  output: string
  steps: string[]
  runtime: { id: string; label: string; baseUrl: string | null }
  file: { path: string; bytes: number } | null
  astrlink: { baseUrl: string; model: string; capability: 'openai.chat' } | null
}

export interface ModelFarmMigrationResult {
  preferences: ModelFarmPreferences
  cachePath: string
  legacyPreferencesPath: string
  legacyCatalogPath: string
  migrated: boolean
}

export interface ModelFarmPolicy {
  formats: readonly ModelFormat[]
  perTask: number
  visibility: 'reachable' | 'all'
  defaultScenario: FitScenario
}
