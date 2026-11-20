/**
 * Widget services for toolbox-mcp: thin stateful wrappers around
 * @toolbox/widgets with local persistence and the portable bundle format.
 */
import {
  createResourceMonitor,
  detectMachine,
  fetchCatalog,
  fetchGatewayRequests,
  fetchGatewayStatus,
  fetchGmailInbox,
  fetchMarkets,
  fetchModelById,
  fetchRegistry,
  fetchSeries,
  friendlyGmailError,
  buildModelfile,
  diskShortfall,
  diskShortfallLabel,
  gradeMachine,
  gradeSetup,
  isQuantTagRejection,
  latestReference,
  listGgufQuants,
  matchInstalledModel,
  MODEL_TASKS,
  normalizeRepoId,
  normalizeWatchlist,
  ollamaModelName,
  parseBundle,
  planOllamaInstall,
  probeOllamaCli,
  pullIntoOllama,
  runOllamaCommand,
  scoreModels,
  searchCatalog,
  searchModules,
  serializeBundle,
  sortForDisplay,
  validateGmailSetup,
  type CatalogModel,
  type CryptoCoin,
  type CryptoRange,
  type CryptoSeries,
  type ExecFileLike,
  type FetchLike,
  type FitScenario,
  type GatewayRequestsResult,
  type GatewayStatus,
  type GgufQuant,
  type GmailCheckResult,
  type MachineGrade,
  type MachineProfile,
  type MarketplaceModule,
  type ModelTask,
  type PullResult,
  type ResourceStats,
  type ScoredModel,
  type ScoreRuntime,
  type SetupGrade,
  type TopProcess,
  type WidgetBundleEntry
} from '@toolbox/widgets'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir, homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { DEFAULT_MODEL_FARM_PREFS, NOTE_MAX_LENGTH, NOTE_REPO_MAX_LENGTH, cleanStaleTempFiles, loadCatalogCache, loadSettings, recordModelInstall, sanitizeModelFarmPrefs, sanitizeModelNotes, saveCatalogCache, saveSettings, type ModelFarmPrefs, type ModelInstallRecord, type StoredSettings } from './config.js'
import { createNativeCredentialStore, type CredentialStore } from './credentials.js'
import {
  connectRemote,
  DEFAULT_REMOTE_TIMEOUTS,
  proxiedToolName,
  RemoteTimeoutError,
  withRemoteTimeout,
  type ProxiedTool,
  type RemoteConnect,
  type RemoteConnection,
  type RemoteTimeouts,
  type RemoteToolDef
} from './remote.js'
import {
  DEFAULT_RUNTIME_ID,
  detectRuntimes,
  downloadGguf,
  freeDiskBytes,
  ggufDirectory,
  installOllama,
  listRuntimeModels,
  providerBaseUrl,
  resolveGgufFile,
  runtimeDescriptor,
  runtimeModelsDir,
  startServerRuntime,
  type DownloadProgress,
  type RuntimeFetch,
  type RuntimeInstallResult,
  type RuntimeReport,
  type RuntimeStatus
} from './runtimes.js'
import { appVersion } from './version.js'

function isCatalogModel(value: unknown): value is CatalogModel {
  const candidate = value as Partial<CatalogModel> | null
  return (
    typeof candidate?.id === 'string' &&
    typeof candidate.task === 'string' &&
    typeof candidate.runtimeRamBytes === 'number' &&
    Array.isArray(candidate.formats)
  )
}

/** The quantization the user asked for, in a form they can read. */
function requestedQuantLabel(model: CatalogModel, requested?: string | null): string {
  return (requested ?? model.quantLabel ?? '').trim() || 'requested'
}

export const USER_AGENT = `toolbox-mcp/${appVersion()} (+https://github.com/acsdd/toolbox-mcp)`
const SERIES_TTL_MS = 30 * 60 * 1000
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
const CATALOG_PER_TASK = 24
const REGISTRY_TTL_MS = 5 * 60 * 1000
const GATEWAY_TTL_MS = 30 * 1000
const RUNTIME_TTL_MS = 20 * 1000
const DOWNLOAD_HISTORY_LIMIT = 20

interface ServicesOptions {
  fetchImpl?: FetchLike
  /** Operating-system credential storage for Gmail App Passwords. */
  credentialStore?: CredentialStore
  /** Gmail inbox operation, injectable so credential flows are tested offline. */
  gmailInboxImpl?: (email: string, password: string) => Promise<GmailCheckResult>
  execFileImpl?: ExecFileLike
  /** Path to the read-only astrlink CLI; defaults to the AstrLink install. */
  gatewayCliPath?: string
  /** Pulls a model into the local Ollama runtime (injectable for tests). */
  pullModel?: (reference: string) => Promise<PullResult>
  /** Runs an arbitrary Ollama subcommand (injectable for tests). */
  runOllama?: (args: string[]) => Promise<PullResult>
  /** Remote MCP connection factory (injectable for tests). */
  remoteConnect?: RemoteConnect
  /** Bounded operation deadlines for remote MCP servers. */
  remoteTimeouts?: Partial<RemoteTimeouts>
  /** Called when a remote server connects and its tools are ready to register. */
  onRemoteTools?: (moduleId: string, tools: ProxiedTool[]) => void
  /** Called when a remote server is uninstalled and its tools must go. */
  onRemoteRemoved?: (moduleId: string) => void
  /** Fetch used for runtime probes and HuggingFace file lookups. */
  runtimeFetchImpl?: RuntimeFetch
  /** Fresh available bytes on a destination volume; null when unavailable. */
  freeDiskImpl?: (directory: string) => Promise<number | null>
  /** Downloads a URL to a file (injectable for tests); may report progress and honour cancellation. */
  downloadFileImpl?: (url: string, target: string, onProgress?: (progress: DownloadProgress) => void, signal?: AbortSignal) => Promise<number>
  /** Home used to expand runtime model folders; injectable so tests never write into the real profile. */
  homeDir?: string
}

export interface LlamafarmScoreInput {
  scenario: FitScenario
  search?: string
  minParams?: number | null
  maxParams?: number | null
  /** Wave 3: suppress reds that carry no offload hints. */
  onlyReachable?: boolean
}

/** A scored model plus the local name the active runtime already serves it under. */
export interface FarmScoredModel extends ScoredModel {
  /** Installed Ollama/runtime model name, or null when not present locally. */
  installed: string | null
  /** Runtime owning this inventory entry; never infer deletion targets from UI state. */
  installedRuntime: string | null
}

export interface LlamafarmGroup {
  task: ModelTask
  label: string
  icon: string
  models: FarmScoredModel[]
}

export interface LlamafarmScoreResult {
  machine: MachineProfile
  /** The machine rated 0-100 on the axes the models are graded against. */
  machineGrade: MachineGrade
  scenario: FitScenario
  fetchedAt: number | null
  groups: LlamafarmGroup[]
  total: number
  error: string | null
}

/** Live HuggingFace search beyond the cached catalog (point 1). */
export interface LlamafarmSearchInput {
  query: string
  scenario?: FitScenario
}
export interface LlamafarmSearchResult {
  query: string
  scenario: FitScenario
  machine: MachineProfile
  machineGrade: MachineGrade
  groups: LlamafarmGroup[]
  total: number
  error: string | null
}

/** The GGUF quantizations a repo offers, smallest first (point 5). */
export interface LlamafarmQuantsResult {
  repo: string
  quants: GgufQuant[]
  error: string | null
}

/** Remove a locally installed model (point 6). */
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

/** Best green model per task for the current machine (point 7). */
export interface LlamafarmRunNowResult {
  scenario: 'now'
  machine: MachineProfile
  picks: Array<{ task: ModelTask; label: string; model: FarmScoredModel }>
}

/** One tracked folder download (point 4). */
export interface FarmDownload {
  repo: string
  runtime: string
  status: 'downloading' | 'done' | 'error' | 'cancelled'
  /** null = indeterminate (e.g. an Ollama pull with no byte stream). */
  percent: number | null
  receivedBytes: number
  totalBytes: number | null
  file: string | null
  error: string | null
  startedAt: number
}
export interface LlamafarmCancelInput {
  repo: string
}
export interface LlamafarmCancelResult {
  ok: boolean
  repo: string
  message: string
}

export interface LlamafarmProgressResult {
  downloads: FarmDownload[]
}

export interface LlamafarmGradeInput {
  /** HuggingFace repo id to grade against this machine; omit to grade the PC alone. */
  repo?: string
  scenario?: FitScenario
}

export interface LlamafarmGradeResult {
  machine: MachineProfile
  machineGrade: MachineGrade
  scenario: FitScenario
  /** The resolved catalog model, or null when no repo was given / it has no weights. */
  model: CatalogModel | null
  /** The paired setup grade, or null when there is no model to grade. */
  grade: SetupGrade | null
  error: string | null
}

export interface LlamafarmInstallInput {
  /** HuggingFace repo id, e.g. 'bartowski/Llama-3.2-3B-Instruct-GGUF'. */
  repo: string
  /** Quantization tag, e.g. 'Q4_K_M'. Defaults to the catalog entry's quant. */
  quant?: string
  /** Layers to keep on the GPU; writes a Modelfile instead of a plain pull. */
  offload?: number
  /** Which runtime to install into; defaults to the active one. */
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

export interface LlamafarmInstallResult {
  ok: boolean
  repo: string
  reference: string | null
  modelName: string | null
  reason: LlamafarmInstallReason
  message: string
  /** Runtime output of the install command. */
  output: string
  /** What to run next. */
  steps: string[]
  /** The runtime the weights went to. */
  runtime: { id: string; label: string; baseUrl: string | null }
  /** Where the weights landed, for runtimes that take a file. */
  file: { path: string; bytes: number } | null
  /** Manual setup for the local runtime; present only after success. */
  astrlink: { baseUrl: string; model: string; capability: 'openai.chat' } | null
}

export interface MarketplaceListedModule extends MarketplaceModule {
  installed: boolean
}
export interface MarketplaceListResult {
  modules: MarketplaceListedModule[]
  categories: string[]
  fetchedAt: number | null
  error: string | null
}

export interface MarketplaceInstallResult {
  installed: string[]
  applied: string[]
  missingCredentials: string[]
  note: string | null
  remoteTools: string[]
}

export interface CryptoState {
  watchlist: string[]
  coins: CryptoCoin[]
  missing: string[]
  checking: boolean
  lastCheck: number | null
  error: string | null
}

export interface GmailState {
  configured: boolean
  email: string
  lastCheck: number | null
  unread: number
  messages: GmailCheckResult['messages']
  error: string | null
}

/** The subset of local settings the panel can read and edit. */
export interface PanelSettings {
  watchlist: string[]
  diskPath: string
  showProcesses: boolean
  modelFarm: ModelFarmPrefs
  modelInstalls: ModelInstallRecord[]
  modelNotes: Record<string, string>
}

export function createServices(options: ServicesOptions = {}) {
  const fetchOptions = { userAgent: USER_AGENT, fetchImpl: options.fetchImpl }
  const credentialStore = options.credentialStore ?? createNativeCredentialStore()
  const gmailInbox = options.gmailInboxImpl ?? ((email, password) => fetchGmailInbox(email, password))
  const settings: { current: StoredSettings } = {
    current: {
      version: 2,
      cryptoWatchlist: ['bitcoin', 'ethereum', 'solana'],
      gmail: null,
      resource: { showProcesses: true },
      marketplace: { installed: ['crypto-watch', 'gmail-announcer', 'resource-monitor'] },
      runtimes: { active: null },
      modelFarm: { ...DEFAULT_MODEL_FARM_PREFS },
      modelInstalls: [],
      modelNotes: {}
    }
  }
  const crypto: CryptoState = {
    watchlist: [],
    coins: [],
    missing: [],
    checking: false,
    lastCheck: null,
    error: null
  }
  let gmail: GmailState = {
    configured: false,
    email: '',
    lastCheck: null,
    unread: 0,
    messages: [],
    error: null
  }
  let monitor = createResourceMonitor({})
  let machine: MachineProfile | null = null
  let modelStateVersion = 0
  let catalog: { models: CatalogModel[]; fetchedAt: number | null } | null = null
  let catalogError: string | null = null
  let registry: { modules: MarketplaceModule[]; updated: string; fetchedAt: number } | null = null
  let registryError: string | null = null
  let gateway: { status: GatewayStatus; fetchedAt: number } | null = null
  let runtimeReport: RuntimeReport | null = null
  /** Folder downloads tracked for the progress surface (point 4). */
  const downloads: FarmDownload[] = []
  const activeDownloads = new Map<string, AbortController>()
  const remotes = new Map<string, { module: MarketplaceModule; connection: RemoteConnection; tools: RemoteToolDef[] }>()
  const remoteErrors = new Map<string, string>()
  const remoteConnectOperations = new Map<string, Promise<ProxiedTool[]>>()
  const remoteRecoveryOperations = new Map<string, Promise<void>>()
  const remoteTimeouts: RemoteTimeouts = {
    connectMs: options.remoteTimeouts?.connectMs ?? DEFAULT_REMOTE_TIMEOUTS.connectMs,
    listMs: options.remoteTimeouts?.listMs ?? DEFAULT_REMOTE_TIMEOUTS.listMs,
    callMs: options.remoteTimeouts?.callMs ?? DEFAULT_REMOTE_TIMEOUTS.callMs,
    closeMs: options.remoteTimeouts?.closeMs ?? DEFAULT_REMOTE_TIMEOUTS.closeMs
  }
  const remoteConnect = options.remoteConnect ?? connectRemote
  const detectOptions = { fetchImpl: options.fetchImpl, execFileImpl: options.execFileImpl }
  const execFileImpl = options.execFileImpl ?? (execFile as unknown as ExecFileLike)
  const runtimeOptions = {
    fetchImpl: options.runtimeFetchImpl ?? (globalThis.fetch as RuntimeFetch),
    execFileImpl: options.execFileImpl as never,
    ...(options.homeDir ? { homeDir: options.homeDir } : {})
  }

  async function init(): Promise<void> {
    await cleanStaleTempFiles()
    const loaded = await loadSettings()
    settings.current = loaded.settings
    crypto.watchlist = normalizeWatchlist(settings.current.cryptoWatchlist)
    monitor = createResourceMonitor({ diskPath: settings.current.resource.diskPath })
    gmail = { configured: false, email: '', lastCheck: null, unread: 0, messages: [], error: null }

    if (loaded.legacyGmail) {
      const ref = loaded.legacyGmail.credentialRef ?? randomUUID()
      try {
        await credentialStore.set(ref, loaded.legacyGmail.password)
        settings.current.gmail = {
          email: loaded.legacyGmail.email,
          credentialRef: ref,
          notifications: loaded.legacyGmail.notifications
        }
        await saveSettings(settings.current)
      } catch {
        settings.current.gmail = null
        try {
          await saveSettings(settings.current)
        } catch {
          throw new Error('Unable to remove the legacy Gmail password from settings. Secure migration failed; settings cleanup is required.')
        }
        await credentialStore.delete(ref).catch(() => {})
        gmail.error = 'The legacy Gmail password could not be migrated securely and was removed from settings. Reconnect Gmail to continue.'
      }
    }

    const account = settings.current.gmail
    if (account) {
      gmail.email = account.email
      try {
        const password = await credentialStore.get(account.credentialRef)
        gmail.configured = password !== null
        gmail.error = password === null ? 'Gmail credentials are missing from secure storage. Reconnect Gmail to continue.' : null
      } catch {
        gmail.configured = false
        gmail.error = 'The operating system credential store is unavailable. Unlock it or reconnect Gmail to continue.'
      }
    }

    const cached = await loadCatalogCache()
    if (cached) {
      catalog = { models: cached.models.filter(isCatalogModel), fetchedAt: cached.fetchedAt }
    }
  }

  async function cryptoRefresh(): Promise<CryptoState> {
    crypto.checking = true
    crypto.error = null
    try {
      const { coins, missing } = await fetchMarkets(crypto.watchlist, fetchOptions)
      crypto.coins = coins
      crypto.missing = missing
      crypto.lastCheck = Date.now()
    } catch (cause) {
      crypto.error = cause instanceof Error ? cause.message : String(cause)
    } finally {
      crypto.checking = false
    }
    return crypto
  }

  async function cryptoSetWatchlist(value: unknown): Promise<CryptoState> {
    crypto.watchlist = normalizeWatchlist(value)
    crypto.coins = []
    settings.current.cryptoWatchlist = [...crypto.watchlist]
    await saveSettings(settings.current)
    return cryptoRefresh()
  }

  async function cryptoSeries(id: unknown, days: unknown): Promise<CryptoSeries> {
    return fetchSeries(id, days, fetchOptions)
  }

  async function gmailConnect(input: unknown): Promise<GmailState> {
    const setup = validateGmailSetup(input)
    const result = await gmailInbox(setup.email, setup.password).catch((cause) => {
      throw new Error(friendlyGmailError(cause))
    })
    const previousAccount = settings.current.gmail
    const credentialRef = previousAccount?.credentialRef ?? randomUUID()
    let previousPassword: string | null = null
    if (previousAccount) {
      try {
        previousPassword = await credentialStore.get(credentialRef)
      } catch {
        throw new Error('The operating system credential store is unavailable. Gmail was not connected; unlock the store and try again.')
      }
    }
    await credentialStore.set(credentialRef, setup.password).catch(() => {
      throw new Error('The operating system credential store is unavailable. Gmail was not connected; unlock the store and try again.')
    })
    const nextSettings: StoredSettings = {
      ...settings.current,
      gmail: { email: setup.email, credentialRef, notifications: true }
    }
    try {
      await saveSettings(nextSettings)
    } catch {
      if (previousPassword === null) await credentialStore.delete(credentialRef).catch(() => {})
      else await credentialStore.set(credentialRef, previousPassword).catch(() => {})
      throw new Error('Gmail credentials were stored securely, but settings could not be saved. The connection was not completed.')
    }
    settings.current = nextSettings
    gmail = {
      configured: true,
      email: setup.email,
      lastCheck: Date.now(),
      unread: result.unread,
      messages: result.messages,
      error: null
    }
    return gmail
  }

  async function gmailDisconnect(): Promise<GmailState> {
    const account = settings.current.gmail
    if (account) {
      try {
        await credentialStore.delete(account.credentialRef)
      } catch {
        gmail.error = 'The Gmail credential could not be removed from the operating system store. It remains configured.'
        return gmail
      }
    }
    const nextSettings: StoredSettings = { ...settings.current, gmail: null }
    await saveSettings(nextSettings)
    settings.current = nextSettings
    gmail = { configured: false, email: '', lastCheck: null, unread: 0, messages: [], error: null }
    return gmail
  }

  async function gmailCheck(): Promise<GmailState> {
    const account = settings.current.gmail
    if (!account) {
      gmail.configured = false
      gmail.error ??= 'Gmail is not connected. Connect with an App Password first.'
      return gmail
    }

    let password: string | null
    try {
      password = await credentialStore.get(account.credentialRef)
    } catch {
      gmail.configured = false
      gmail.error = 'The operating system credential store is unavailable. Unlock it or reconnect Gmail to continue.'
      return gmail
    }
    if (password === null) {
      gmail.configured = false
      gmail.error = 'Gmail credentials are missing from secure storage. Reconnect Gmail to continue.'
      return gmail
    }

    try {
      const result = await gmailInbox(account.email, password)
      gmail = {
        configured: true,
        email: account.email,
        lastCheck: Date.now(),
        unread: result.unread,
        messages: result.messages,
        error: null
      }
    } catch (cause) {
      gmail.error = friendlyGmailError(cause)
    }
    return gmail
  }

  async function resourceStats(): Promise<ResourceStats> {
    return monitor.getStats()
  }

  async function resourceProcesses(): Promise<TopProcess[]> {
    if (!settings.current.resource.showProcesses) return []
    return monitor.getTopProcesses()
  }

  /** The editable local settings, as the panel shows them. */
  async function settingsSnapshot(): Promise<PanelSettings> {
    return {
      watchlist: [...crypto.watchlist],
      diskPath: settings.current.resource.diskPath ?? '',
      showProcesses: settings.current.resource.showProcesses,
      modelFarm: { ...settings.current.modelFarm },
      modelInstalls: settings.current.modelInstalls.map((entry) => ({ ...entry })),
      modelNotes: { ...settings.current.modelNotes }
    }
  }

  /**
   * Remember the Model Farm browsing options. Input is validated field by
   * field; unrecognized values fall back to defaults instead of being stored.
   */
  async function modelFarmSetPrefs(input: unknown): Promise<PanelSettings> {
    settings.current.modelFarm = sanitizeModelFarmPrefs(input)
    await saveSettings(settings.current)
    return settingsSnapshot()
  }

  /**
   * Save or delete the user's note for one model repo. An empty note removes
   * the entry; the repo must be a non-empty string within the storage limit.
   */
  async function modelFarmSetNote(input: unknown): Promise<PanelSettings> {
    const doc = (input ?? {}) as { repo?: unknown; note?: unknown }
    const repo = typeof doc.repo === 'string' ? doc.repo.trim() : ''
    if (!repo || repo.length > NOTE_REPO_MAX_LENGTH) throw new Error('A valid model repo is required.')
    const note = typeof doc.note === 'string' ? doc.note.trim().slice(0, NOTE_MAX_LENGTH) : ''
    const next = { ...settings.current.modelNotes }
    if (note) next[repo] = note
    else delete next[repo]
    settings.current.modelNotes = sanitizeModelNotes(next)
    await saveSettings(settings.current)
    return settingsSnapshot()
  }

  /**
   * Remember a successful install for the panel's recently-installed strip.
   * Failed installs return untouched; the history is capped and deduplicated
   * by the storage layer, so reinstalling a model just moves it to the front.
   */
  async function recordInstall(result: LlamafarmInstallResult): Promise<LlamafarmInstallResult> {
    if (result.ok) {
      settings.current.modelInstalls = recordModelInstall(settings.current.modelInstalls, {
        repo: result.repo,
        label: result.modelName ?? result.repo,
        runtime: result.runtime.id,
        installedAt: Date.now()
      })
      await saveSettings(settings.current)
    }
    return result
  }

  /**
   * Store the resource monitor preferences. The disk path is optional: an
   * empty value clears it so the monitor falls back to the system disk.
   */
  async function resourceSetSettings(input: unknown): Promise<PanelSettings> {
    const raw = (input ?? {}) as { diskPath?: unknown; showProcesses?: unknown }
    const diskPath = typeof raw.diskPath === 'string' ? raw.diskPath.trim() : ''
    settings.current.resource = {
      ...(diskPath === '' ? {} : { diskPath }),
      showProcesses: raw.showProcesses !== false
    }
    monitor = createResourceMonitor({ diskPath: settings.current.resource.diskPath })
    await saveSettings(settings.current)
    return settingsSnapshot()
  }

  /** Export the current widget setup as a portable bundle (JSON string). */
  async function exportWidgets(): Promise<string> {
    const entries: WidgetBundleEntry[] = [
      { widget: 'crypto-watch', settings: { watchlist: [...crypto.watchlist] } },
      ...(settings.current.gmail
        ? [
            {
              widget: 'gmail-announcer' as const,
              settings: {
                email: settings.current.gmail.email,
                notifications: settings.current.gmail.notifications
              },
              credentialsRef: 'gmail/app-password'
            }
          ]
        : []),
      {
        widget: 'resource-monitor',
        settings: {
          ...(settings.current.resource.diskPath
            ? { diskPath: settings.current.resource.diskPath }
            : {}),
          showProcesses: settings.current.resource.showProcesses
        }
      }
    ]
    return serializeBundle(entries)
  }

  /**
   * Import a portable bundle. Widget settings are applied; credential
   * references are reported back so the caller can wire up local secrets.
   */
  async function importWidgets(value: unknown): Promise<{ applied: string[]; missingCredentials: string[] }> {
    const bundle = parseBundle(value)
    const applied: string[] = []
    const missingCredentials: string[] = []

    for (const entry of bundle.widgets) {
      switch (entry.widget) {
        case 'crypto-watch':
          await cryptoSetWatchlist((entry.settings as { watchlist: string[] }).watchlist)
          applied.push('crypto-watch')
          break
        case 'resource-monitor': {
          const resource = entry.settings as { diskPath?: string; showProcesses?: boolean }
          settings.current.resource = {
            diskPath: resource.diskPath,
            showProcesses: resource.showProcesses !== false
          }
          monitor = createResourceMonitor({ diskPath: resource.diskPath })
          await saveSettings(settings.current)
          applied.push('resource-monitor')
          break
        }
        case 'gmail-announcer': {
          // Bundle settings never carry credentials; any prior local credential is removed.
          const previousCredentialRef = settings.current.gmail?.credentialRef
          const nextSettings: StoredSettings = { ...settings.current, gmail: null }
          await saveSettings(nextSettings)
          settings.current = nextSettings
          if (previousCredentialRef) await credentialStore.delete(previousCredentialRef)
          gmail = { configured: false, email: '', lastCheck: null, unread: 0, messages: [], error: null }
          missingCredentials.push(entry.credentialsRef ?? 'gmail/app-password')
          applied.push('gmail-announcer')
          break
        }
      }
    }
    return { applied, missingCredentials }
  }

  // --- llamafarm: model catalog + fit scoring --------------------------------

  function invalidateModelState(): void {
    modelStateVersion++
    machine = null
    runtimeReport = null
  }

  async function llamafarmStatus(forceDetect = false): Promise<MachineProfile> {
    if (!machine || forceDetect) {
      const version = modelStateVersion
      const detected = await detectMachine(detectOptions)
      // A transfer/removal may have finished while this snapshot was in flight.
      if (version !== modelStateVersion) return llamafarmStatus()
      machine = detected
    }
    return machine
  }

  /** The status tool payload: the machine profile plus its 0-100 scorecard. */
  async function llamafarmStatusReport(forceDetect = false): Promise<MachineProfile & { grade: MachineGrade }> {
    const profile = await llamafarmStatus(forceDetect)
    return { ...profile, grade: gradeMachine(profile, 'now') }
  }

  /**
   * The model catalog, cached on disk for CATALOG_TTL_MS. Ollama is the only
   * runtime Model Farm installs into, and it can only pull GGUF, so the
   * catalog is restricted to GGUF repos. A cache written before this rule
   * (or by a session without Ollama) may still list safetensors checkpoints;
   * it is treated as stale, refetched and filtered either way.
   */
  async function llamafarmCatalog(forceRefresh = false): Promise<{
    models: CatalogModel[]
    fetchedAt: number | null
    error: string | null
  }> {
    const installable = (models: CatalogModel[]): CatalogModel[] =>
      models.filter((model) => model.formats.includes('gguf'))

    const cachedModels = catalog?.models ?? []
    const staleFormats = cachedModels.some((model) => !model.formats.includes('gguf'))
    const fresh =
      catalog !== null &&
      catalog.fetchedAt !== null &&
      Date.now() - catalog.fetchedAt < CATALOG_TTL_MS &&
      !staleFormats
    if (!forceRefresh && (fresh || (catalog !== null && catalogError !== null))) {
      return { models: installable(cachedModels), fetchedAt: catalog?.fetchedAt ?? null, error: catalogError }
    }
    let models: CatalogModel[]
    let fetchedAt: number | null
    try {
      models = await fetchCatalog({
        formats: ['gguf'],
        perTask: CATALOG_PER_TASK,
        fetchImpl: options.fetchImpl
      })
      fetchedAt = Date.now()
      catalogError = null
      await saveCatalogCache({ models, fetchedAt }).catch(() => {})
    } catch (cause) {
      catalogError = cause instanceof Error ? cause.message : String(cause)
      models = catalog?.models ?? []
      fetchedAt = catalog?.fetchedAt ?? null
    }
    catalog = { models, fetchedAt }
    return { models: installable(models), fetchedAt, error: catalogError }
  }

  /** The runtime verdicts/hints are worded for; defaults to Ollama. */
  function activeScoreRuntime(): ScoreRuntime {
    const id = (settings.current.runtimes.active ?? DEFAULT_RUNTIME_ID).trim() || DEFAULT_RUNTIME_ID
    const descriptor = runtimeDescriptor(id)
    return descriptor ? { id: descriptor.id, api: descriptor.api } : { id: DEFAULT_RUNTIME_ID, api: 'ollama' }
  }

  /** Use the selected runtime's API; a downloaded-but-unloaded file is not served. */
  async function installedNames(runtime: string): Promise<string[]> {
    if (runtime === 'ollama') {
      const profile = await llamafarmStatus()
      return profile.ollama.models.map((entry) => entry.name)
    }
    const descriptor = runtimeDescriptor(runtime)
    if (!descriptor) return []
    const result = await listRuntimeModels(descriptor, runtimeOptions)
    return result.models.map((entry) => entry.name)
  }

  /** Pin inventory provenance so later deletion never follows a changed selector. */
  function markInstalled(scored: ScoredModel[], names: string[], runtime: string): FarmScoredModel[] {
    return scored.map((model) => {
      const installed = matchInstalledModel(model, names)
      return { ...model, installed, installedRuntime: installed ? runtime : null }
    })
  }

  /** Group scored models by pipeline task, in display order. */
  function groupByTask(models: FarmScoredModel[]): LlamafarmGroup[] {
    const byTask = new Map<ModelTask, FarmScoredModel[]>()
    for (const entry of models) {
      const list = byTask.get(entry.task) ?? []
      list.push(entry)
      byTask.set(entry.task, list)
    }
    return MODEL_TASKS.filter((info) => byTask.has(info.task)).map((info) => ({
      task: info.task,
      label: info.label,
      icon: info.icon,
      models: sortForDisplay(byTask.get(info.task) ?? []) as FarmScoredModel[]
    }))
  }

  /**
   * Score the catalog against the machine. This powers both wave 2 (live
   * color marks as filters change) and wave 3 (submitted, ordered verdicts).
   */
  async function llamafarmScore(input: LlamafarmScoreInput): Promise<LlamafarmScoreResult> {
    const runtime = activeScoreRuntime()
    const [profile, { models, fetchedAt, error }] = await Promise.all([llamafarmStatus(), llamafarmCatalog()])
    const search = input.search?.trim().toLowerCase() ?? ''
    const filtered = models.filter((model) => {
      if (search && !model.id.toLowerCase().includes(search) && !model.label.toLowerCase().includes(search)) {
        return false
      }
      if (input.minParams != null && (model.paramsBillions ?? 0) < input.minParams) return false
      if (input.maxParams != null && (model.paramsBillions ?? Infinity) > input.maxParams) return false
      return true
    })
    const scored = scoreModels({ models: filtered, machine: profile, scenario: input.scenario, runtime })
    const visible = input.onlyReachable ? scored.filter((m) => m.verdict !== 'red' || m.hints.length > 0) : scored
    const groups = groupByTask(markInstalled(visible, await installedNames(runtime.id), runtime.id))
    return {
      machine: profile,
      machineGrade: gradeMachine(profile, input.scenario),
      scenario: input.scenario,
      fetchedAt,
      groups,
      total: visible.length,
      error
    }
  }

  /** Live HuggingFace search beyond the cached catalog, graded (point 1). */
  async function llamafarmSearch(input: LlamafarmSearchInput): Promise<LlamafarmSearchResult> {
    const runtime = activeScoreRuntime()
    const query = input.query?.trim() ?? ''
    const scenario = input.scenario ?? 'now'
    const profile = await llamafarmStatus()
    const base = {
      query,
      scenario,
      machine: profile,
      machineGrade: gradeMachine(profile, scenario),
      groups: [] as LlamafarmGroup[],
      total: 0,
      error: null as string | null
    }
    if (!query) return base
    let models: CatalogModel[]
    try {
      models = await searchCatalog(query, { fetchImpl: options.fetchImpl })
    } catch (cause) {
      return { ...base, error: cause instanceof Error ? cause.message : String(cause) }
    }
    const scored = scoreModels({ models, machine: profile, scenario, runtime })
    const groups = groupByTask(markInstalled(scored, await installedNames(runtime.id), runtime.id))
    return { ...base, groups, total: scored.length }
  }

  /** The GGUF quantizations a repo offers, smallest first (point 5). */
  async function llamafarmQuants(repo: string): Promise<LlamafarmQuantsResult> {
    const id = normalizeRepoId(repo ?? '')
    try {
      const quants = await listGgufQuants(id, { fetchImpl: options.fetchImpl })
      return { repo: id, quants, error: null }
    } catch (cause) {
      return { repo: id, quants: [], error: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  /** Best green model per task for this machine right now (point 7). */
  async function llamafarmRunNow(): Promise<LlamafarmRunNowResult> {
    const runtime = activeScoreRuntime()
    const [profile, { models }] = await Promise.all([llamafarmStatus(), llamafarmCatalog()])
    const scored = scoreModels({ models, machine: profile, scenario: 'now', runtime })
    const groups = groupByTask(markInstalled(scored, await installedNames(runtime.id), runtime.id))
    const picks: LlamafarmRunNowResult['picks'] = []
    for (const group of groups) {
      const green = group.models.filter((model) => model.verdict === 'green')
      // "Run now" means runnable without a download: prefer an already-installed
      // green model, falling back to the lightest green that still needs pulling.
      const best = green.find((model) => model.installed) ?? green[0]
      if (best) picks.push({ task: group.task, label: group.label, model: best })
    }
    return { scenario: 'now', machine: profile, picks }
  }

  /** Keep the latest terminal attempts without ever evicting an active transfer. */
  function settleDownload(entry: FarmDownload, status: 'done' | 'error' | 'cancelled'): void {
    entry.status = status
    let terminal = 0
    for (let index = downloads.length - 1; index >= 0; index--) {
      if (downloads[index].status !== 'downloading' && ++terminal > DOWNLOAD_HISTORY_LIMIT) {
        downloads.splice(index, 1)
      }
    }
  }

  /** Cancel an active in-progress model download by repository id. */
  async function llamafarmCancel(input: LlamafarmCancelInput): Promise<LlamafarmCancelResult> {
    const repo = input.repo?.trim() ?? ''
    const key = repo.toLowerCase()
    const entry = downloads.find((d) => d.repo.toLowerCase() === key && d.status === 'downloading') ?? null
    if (!entry) {
      return { ok: false, repo, message: `No active download found for "${repo}".` }
    }
    const controller = activeDownloads.get(key)
    if (!controller) {
      // Ollama streams a pull through its own daemon; it offers no abort hook.
      return {
        ok: false,
        repo,
        message: `"${repo}" is being pulled by Ollama, which cannot be cancelled from here. Interrupt the pull in the terminal that started it.`
      }
    }
    controller.abort()
    activeDownloads.delete(key)
    settleDownload(entry, 'cancelled')
    entry.error = 'Download cancelled by user.'
    return { ok: true, repo, message: `Download of "${repo}" was cancelled.` }
  }

  /** Tracked downloads, newest started last (point 4). */
  async function llamafarmProgress(): Promise<LlamafarmProgressResult> {
    return { downloads: downloads.map((entry) => ({ ...entry })) }
  }

  /** Remove a locally installed Ollama model by repo or name (point 6). */
  async function llamafarmRemove(input: LlamafarmRemoveInput): Promise<LlamafarmRemoveResult> {
    const runtime = input.runtime?.trim() || activeScoreRuntime().id
    if (runtime !== 'ollama') {
      return { ok: false, removed: null, reason: 'unsupported-runtime',
        message: `Removal is supported only for Ollama. Manage models in ${runtimeDescriptor(runtime)?.label ?? runtime} itself.`, output: '' }
    }
    const names = await installedNames(runtime)
    let target: string | null = null
    if (input.model?.trim()) {
      const wanted = input.model.trim().toLowerCase()
      target = names.find((name) => name.toLowerCase() === wanted || name.toLowerCase().split(':')[0] === wanted) ?? null
    } else if (input.repo?.trim()) {
      const repo = normalizeRepoId(input.repo)
      const repoName = repo.split('/')[1] ?? repo
      const label = repoName.replace(/-GGUF$/i, '')
      const probe = { id: repo, label } as CatalogModel
      target = matchInstalledModel(probe, names)
    }
    if (!target) {
      return { ok: false, removed: null, reason: 'not-found', message: 'That model is not installed locally.', output: '' }
    }
    const runner = options.runOllama ?? ((args: string[]) => runOllamaCommand(args))
    let result
    try {
      result = await runner(['rm', target])
    } catch (cause) {
      return { ok: false, removed: null, reason: 'failed', message: cause instanceof Error ? cause.message : String(cause), output: '' }
    }
    if (!result.ok) {
      return { ok: false, removed: null, reason: 'failed', message: result.error ?? 'Ollama refused the removal.', output: result.output }
    }
    invalidateModelState()
    return { ok: true, removed: target, reason: 'removed', message: `${target} was removed.`, output: result.output }
  }

  /** Re-detect the machine and force a catalog refetch. */
  async function llamafarmRefresh(): Promise<{ machine: MachineProfile; catalog: number }> {
    await llamafarmStatus(true)
    const { models } = await llamafarmCatalog(true)
    return { machine: await llamafarmStatus(), catalog: models.length }
  }

  /**
   * Dedicated grade tool: rate the PC alone, or grade one catalog model against
   * it. Returns the machine scorecard plus the paired setup grade when a repo
   * resolves to a model with weights.
   */
  async function llamafarmGrade(input: LlamafarmGradeInput): Promise<LlamafarmGradeResult> {
    const scenario = input.scenario ?? 'now'
    const profile = await llamafarmStatus()
    const machineGrade = gradeMachine(profile, scenario)
    const base = { machine: profile, machineGrade, scenario, model: null, grade: null, error: null }
    if (!input.repo) return base
    let model: CatalogModel | null
    try {
      model = await fetchModelById(input.repo, { fetchImpl: options.fetchImpl })
    } catch (cause) {
      return { ...base, error: cause instanceof Error ? cause.message : String(cause) }
    }
    if (!model) {
      return { ...base, error: `No GGUF or safetensors weights found for ${input.repo}.` }
    }
    return { ...base, model, grade: gradeSetup(profile, model, scenario) }
  }

  /**
   * Install a catalog model into the local runtime.
   *
   * Ollama pulls the GGUF straight from the Hub, so that path is a single
   * `ollama pull` — unless a GPU split is requested, which writes a Modelfile
   * instead. A runtime that takes files instead of pulls gets the weights
   * downloaded into its own models folder, and one that serves a single model
   * per process is started with it.
   */
  async function llamafarmInstall(input: LlamafarmInstallInput): Promise<LlamafarmInstallResult> {
    const repo = input.repo?.trim() ?? ''
    const runtimeId = (input.runtime ?? settings.current.runtimes.active ?? DEFAULT_RUNTIME_ID).trim() || DEFAULT_RUNTIME_ID
    const descriptor = runtimeDescriptor(runtimeId)
    const failure = (reason: LlamafarmInstallReason, message: string, extra: Partial<LlamafarmInstallResult> = {}): LlamafarmInstallResult => ({
      ok: false,
      repo,
      reference: null,
      modelName: null,
      reason,
      message,
      output: '',
      steps: [],
      runtime: { id: runtimeId, label: descriptor?.label ?? runtimeId, baseUrl: null },
      file: null,
      astrlink: null,
      ...extra
    })
    if (!repo) {
      throw new Error('A repo id is required, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF".')
    }
    if (!descriptor) {
      return failure('not-found', `Unknown runtime "${runtimeId}".`)
    }

    const cached = catalog?.models.find((entry) => entry.id.toLowerCase() === repo.toLowerCase())
    let model: CatalogModel | null = cached ?? null
    if (!model) {
      try {
        model = await fetchModelById(repo, { fetchImpl: options.fetchImpl })
      } catch (cause) {
        return failure('not-found', cause instanceof Error ? cause.message : String(cause))
      }
    }
    if (!model) {
      return failure('not-found', `No GGUF weights found for ${repo}.`)
    }

    if (descriptor.id !== DEFAULT_RUNTIME_ID) {
      return installIntoRuntime(descriptor, model, input.quant ?? null)
    }

    let plan: ReturnType<typeof planOllamaInstall>
    try {
      plan = planOllamaInstall(model, input.quant ?? model.quantLabel)
    } catch (cause) {
      return failure('failed', cause instanceof Error ? cause.message : String(cause))
    }

    // Disk guard: refuse before pulling when the download cannot fit. Guard
    // the *requested* quant's real size, not the catalog default, so a heavier
    // quant (e.g. Q8_0 over Q4_K_M) cannot slip past the check.
    let neededBytes = model.fileBytes
    const requested = (input.quant ?? '').trim()
    if (requested && requested.toUpperCase() !== (model.quantLabel ?? '').toUpperCase()) {
      try {
        const quants = await listGgufQuants(model.id, { fetchImpl: options.fetchImpl })
        const match = quants.find((q) => (q.quant ?? '').toUpperCase() === requested.toUpperCase())
        if (match && match.sizeBytes > 0) neededBytes = match.sizeBytes
      } catch {
        // Keep the catalog default size when the quant listing is unavailable.
      }
    }
    const cli = await probeOllamaCli(execFileImpl)
    if (!cli.installed) {
      return failure('ollama-missing', 'Ollama is not installed on this machine.', {
        reference: plan.reference,
        modelName: plan.modelName,
        steps: plan.steps
      })
    }

    const directory = runtimeModelsDir(descriptor, runtimeOptions)!
    const available = await (options.freeDiskImpl ?? freeDiskBytes)(directory).catch(() => null)
    const short = diskShortfall(available, neededBytes)
    if (short !== null && short > 0) {
      return failure('insufficient-disk', `Not enough disk at ${directory} for ${model.id}: ${diskShortfallLabel(short)}.`)
    }

    // Live progress for the Ollama pull: the CLI gives no byte stream, so the
    // bar stays indeterminate until the pull resolves.
    const pullEntry: FarmDownload = {
      repo: model.id,
      runtime: descriptor.id,
      status: 'downloading',
      percent: null,
      receivedBytes: 0,
      totalBytes: neededBytes,
      file: null,
      error: null,
      startedAt: Date.now()
    }
    downloads.push(pullEntry)

    let result
    const split = typeof input.offload === 'number' && Number.isFinite(input.offload)
    // Ollama matches a quantization tag against the file names a repository
    // publishes, so the tag that is actually served can differ from the one
    // that was asked for. The reference that ends up installed is the truth.
    let effectiveReference = plan.reference
    try {
      if (split) {
        const directory = mkdtempSync(join(tmpdir(), 'toolbox-mcp-'))
        const modelfilePath = join(directory, 'Modelfile')
        const runner = options.runOllama ?? ((args: string[]) => runOllamaCommand(args))
        writeFileSync(modelfilePath, buildModelfile(plan.reference, { numGpu: input.offload }), 'utf8')
        result = await runner(['create', plan.modelName, '--file', modelfilePath])
        if (!result.ok && isQuantTagRejection(result.output)) {
          const fallback = latestReference(plan.reference)
          writeFileSync(modelfilePath, buildModelfile(fallback, { numGpu: input.offload }), 'utf8')
          result = await runner(['create', plan.modelName, '--file', modelfilePath])
          effectiveReference = fallback
        }
      } else {
        const pull = options.pullModel ?? ((reference: string) => pullIntoOllama(reference))
        result = await pull(plan.reference)
        effectiveReference = result.reference ?? plan.reference
      }
    } catch (cause) {
      settleDownload(pullEntry, 'error')
      pullEntry.error = cause instanceof Error ? cause.message : String(cause)
      return failure('failed', pullEntry.error, {
        reference: plan.reference,
        modelName: plan.modelName,
        steps: plan.steps
      })
    }

    if (!result.ok) {
      settleDownload(pullEntry, 'error')
      pullEntry.error = result.error ?? 'The Ollama runtime refused the install.'
      return failure('failed', pullEntry.error, {
        reference: effectiveReference,
        modelName: plan.modelName,
        output: result.output,
        steps: plan.steps
      })
    }
    settleDownload(pullEntry, 'done')
    pullEntry.percent = 100
    // Byte counts remain unknown: Ollama may have reused already-cached layers.
    invalidateModelState()

    // Say it plainly when the served quantization is not the requested one.
    const fallbackNote =
      plan.quantFallback || effectiveReference !== plan.reference
        ? ` Ollama could not use the ${requestedQuantLabel(model, input.quant)} tag for this repository, so it installed the repository default (${effectiveReference}).`
        : ''

    return recordInstall({
      ok: true,
      repo: model.id,
      reference: effectiveReference,
      modelName: plan.modelName,
      reason: 'installed',
      message: `${split ? plan.modelName : effectiveReference} is ready to run.${fallbackNote}`,
      output: result.output,
      steps: split
        ? [`ollama run ${plan.modelName}`]
        : [`ollama pull ${effectiveReference}`, `ollama run ${effectiveReference}`],
      runtime: { id: descriptor.id, label: descriptor.label, baseUrl: 'http://127.0.0.1:11434' },
      file: null,
      astrlink: {
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: split ? plan.modelName : effectiveReference,
        capability: 'openai.chat'
      }
    })
  }

  /**
   * Hand the weights to a runtime that cannot pull them itself: the GGUF is
   * downloaded into the runtime's models folder, and a runtime that serves one
   * model per process is started with it.
   */
  async function installIntoRuntime(
    descriptor: NonNullable<ReturnType<typeof runtimeDescriptor>>,
    model: CatalogModel,
    quant: string | null
  ): Promise<LlamafarmInstallResult> {
    const failure = (reason: LlamafarmInstallReason, message: string, extra: Partial<LlamafarmInstallResult> = {}): LlamafarmInstallResult => ({
      ok: false,
      repo: model.id,
      reference: null,
      modelName: null,
      reason,
      message,
      output: '',
      steps: [],
      runtime: { id: descriptor.id, label: descriptor.label, baseUrl: null },
      file: null,
      astrlink: null,
      ...extra
    })

    let gguf: Awaited<ReturnType<typeof resolveGgufFile>>
    const directory = runtimeModelsDir(descriptor, runtimeOptions) ?? join(homedir(), '.toolbox-mcp', 'models')
    let destination: string
    try {
      gguf = await resolveGgufFile(model.id, quant ?? model.quantLabel, runtimeOptions)
      if (!gguf) return failure('not-found', `No GGUF file found for ${model.id}.`)
      destination = ggufDirectory(gguf, directory)
    } catch (cause) {
      return failure('failed', cause instanceof Error ? cause.message : String(cause))
    }

    // Probe the same namespaced destination that will receive the model.
    const available = await (options.freeDiskImpl ?? freeDiskBytes)(destination).catch(() => null)
    const short = diskShortfall(available, gguf.sizeBytes)
    if (short !== null && short > 0) {
      return failure('insufficient-disk', `Not enough disk at ${directory} for ${model.id}: ${diskShortfallLabel(short)}.`)
    }

    const key = model.id.toLowerCase()
    // Two concurrent installs would write the same staging file and leave the
    // first transfer without a cancel handle.
    if (activeDownloads.has(key)) {
      return failure('failed', `"${model.id}" is already downloading. Cancel it before starting another install.`)
    }

    const entry: FarmDownload = {
      repo: model.id,
      runtime: descriptor.id,
      status: 'downloading',
      percent: 0,
      receivedBytes: 0,
      totalBytes: gguf.sizeBytes ?? null,
      file: null,
      error: null,
      startedAt: Date.now()
    }
    downloads.push(entry)
    const controller = new AbortController()
    activeDownloads.set(key, controller)
    let downloaded: { path: string; bytes: number }
    try {
      downloaded = await downloadGguf(gguf, directory, {
        ...runtimeOptions,
        ...(options.downloadFileImpl ? { download: options.downloadFileImpl } : {}),
        signal: controller.signal,
        onProgress: (progress) => {
          entry.receivedBytes = progress.receivedBytes
          entry.totalBytes = progress.totalBytes ?? entry.totalBytes
          entry.percent = entry.totalBytes ? Math.min(100, Math.round((progress.receivedBytes / entry.totalBytes) * 100)) : 0
        }
      })
      settleDownload(entry, 'done')
      entry.percent = 100
      entry.receivedBytes = downloaded.bytes
      entry.totalBytes = downloaded.bytes
      entry.file = downloaded.path
    } catch (cause) {
      if (controller.signal.aborted) {
        // llamafarmCancel may already have settled the entry as cancelled.
        if (entry.status === 'downloading') settleDownload(entry, 'cancelled')
        entry.error = 'Download cancelled by user.'
        return failure('cancelled', entry.error)
      }
      settleDownload(entry, 'error')
      entry.error = cause instanceof Error ? cause.message : String(cause)
      return failure('failed', entry.error)
    } finally {
      if (activeDownloads.get(key) === controller) activeDownloads.delete(key)
    }

    const modelName = basename(downloaded.path, extname(downloaded.path))
    const steps: string[] = []
    let baseUrl: string | null = null

    if (descriptor.accepts === 'server') {
      const started = await startServerRuntime(descriptor, downloaded.path, runtimeOptions)
      baseUrl = started.baseUrl
      steps.push(...started.steps)
      if (!started.ok) steps.push(started.message)
    } else {
      const status = runtimeReport?.runtimes.find((entry) => entry.id === descriptor.id) ?? null
      if (status?.running) baseUrl = status.baseUrl
      steps.push(`Open ${descriptor.label} and load ${basename(downloaded.path)}.`)
    }

    const openaiBase = baseUrl ? providerBaseUrl({ api: descriptor.api, baseUrl }) : null
    invalidateModelState()

    return recordInstall({
      ok: true,
      repo: model.id,
      reference: null,
      modelName,
      reason: 'installed',
      message: `${modelName} is in ${descriptor.label}'s model folder — ${destination}.`,
      output: '',
      steps,
      runtime: { id: descriptor.id, label: descriptor.label, baseUrl },
      file: { path: downloaded.path, bytes: downloaded.bytes },
      astrlink: openaiBase
        ? { baseUrl: openaiBase, model: modelName, capability: 'openai.chat' }
        : null
    })
  }

  // --- local runtimes ---------------------------------------------------------

  /** Every runtime we can find on this machine, with the active one marked. */
  async function runtimesDetect(force = false): Promise<RuntimeReport> {
    if (!force && runtimeReport && Date.now() - runtimeReport.detectedAt < RUNTIME_TTL_MS) {
      return { ...runtimeReport, active: settings.current.runtimes.active }
    }
    const report = await detectRuntimes({ ...runtimeOptions, active: settings.current.runtimes.active })
    runtimeReport = report
    return report
  }

  /** Install a runtime from its official installer — Ollama, for now. */
  async function runtimesInstall(id: string): Promise<RuntimeInstallResult> {
    const runtime = (id ?? '').trim() || DEFAULT_RUNTIME_ID
    const descriptor = runtimeDescriptor(runtime)
    if (!descriptor) {
      throw new Error(`Unknown runtime "${runtime}".`)
    }
    if (!descriptor.installable) {
      return {
        ok: false,
        id: runtime,
        action: 'unsupported',
        version: null,
        message: `toolbox-mcp cannot install ${descriptor.label} for you — it has its own installer.`,
        steps: [`Download and install ${descriptor.label} from ${descriptor.homepage}.`],
        log: ''
      }
    }
    const result = await installOllama({
      ...runtimeOptions,
      ...(options.downloadFileImpl ? { download: options.downloadFileImpl } : {})
    })
    runtimeReport = null
    return result
  }

  /** Point the Model Farm at one of the runtimes that was found. */
  async function runtimesUse(id: string): Promise<{ active: string | null; runtime: RuntimeStatus | null }> {
    const value = (id ?? '').trim()
    if (value === '' || value === 'none') {
      settings.current.runtimes.active = null
      await saveSettings(settings.current)
      runtimeReport = null
      return { active: null, runtime: null }
    }
    const descriptor = runtimeDescriptor(value)
    if (!descriptor) {
      throw new Error(`Unknown runtime "${value}".`)
    }
    settings.current.runtimes.active = value
    await saveSettings(settings.current)
    const report = await runtimesDetect(true)
    return { active: value, runtime: report.runtimes.find((entry) => entry.id === value) ?? null }
  }

  /** The models a runtime is serving right now. */
  async function runtimesModels(id?: string): Promise<{
    runtime: string
    models: RuntimeStatus['models']
    baseUrl: string
    error: string | null
  }> {
    const runtime = (id ?? settings.current.runtimes.active ?? DEFAULT_RUNTIME_ID).trim() || DEFAULT_RUNTIME_ID
    const descriptor = runtimeDescriptor(runtime)
    if (!descriptor) {
      throw new Error(`Unknown runtime "${runtime}".`)
    }
    const result = await listRuntimeModels(descriptor, runtimeOptions)
    return { runtime, models: result.models, baseUrl: result.baseUrl, error: result.error }
  }

  /** Download a GGUF into a runtime's models folder without installing it. */
  async function runtimesDownload(input: { runtime?: string; repo: string; quant?: string }): Promise<LlamafarmInstallResult> {
    const runtime = (input.runtime ?? settings.current.runtimes.active ?? DEFAULT_RUNTIME_ID).trim() || DEFAULT_RUNTIME_ID
    const descriptor = runtimeDescriptor(runtime)
    if (!descriptor) {
      throw new Error(`Unknown runtime "${runtime}".`)
    }
    const repo = input.repo?.trim() ?? ''
    if (!repo) {
      throw new Error('A repo id is required, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF".')
    }
    const cached = catalog?.models.find((entry) => entry.id.toLowerCase() === repo.toLowerCase()) ?? null
    const model =
      cached ??
      (await fetchModelById(repo, { fetchImpl: options.fetchImpl }).catch(() => null)) ?? {
        id: repo,
        task: 'text-generation' as const,
        label: repo.split('/')[1] ?? repo,
        author: repo.split('/')[0] ?? '',
        formats: ['gguf' as const],
        paramsBillions: null,
        quantLabel: input.quant ?? null,
        fileBytes: null,
        runtimeRamBytes: 0,
        downloads: 0,
        likes: 0,
        license: null,
        tags: [],
        hfUrl: `https://huggingface.co/${repo}`
      }
    return installIntoRuntime(descriptor, model, input.quant ?? null)
  }


  // --- astrlink gateway: read-only observability -----------------------------

  /**
   * The local AstrLink gateway report, cached briefly because the panel polls
   * it. Reads go through the gateway's own observer CLI: no setting can be
   * changed from here, and no request bodies are ever fetched.
   */
  async function gatewayStatus(forceRefresh = false): Promise<GatewayStatus> {
    if (!forceRefresh && gateway && Date.now() - gateway.fetchedAt < GATEWAY_TTL_MS) {
      return gateway.status
    }
    const status = await fetchGatewayStatus({
      execFileImpl: options.execFileImpl,
      ...(options.gatewayCliPath ? { cliPath: options.gatewayCliPath } : {})
    })
    gateway = { status, fetchedAt: Date.now() }
    return status
  }

  /** Recent gateway request records (metadata only) with a spend summary. */
  async function gatewayRequests(
    input: { limit?: number; status?: string; serviceId?: string } = {}
  ): Promise<GatewayRequestsResult> {
    return fetchGatewayRequests({
      ...input,
      execFileImpl: options.execFileImpl,
      ...(options.gatewayCliPath ? { cliPath: options.gatewayCliPath } : {})
    })
  }

  // --- marketplace: live registry + installs --------------------------------

  async function marketplaceRegistry(forceRefresh = false): Promise<void> {
    const fresh = registry !== null && Date.now() - registry.fetchedAt < REGISTRY_TTL_MS
    if (!forceRefresh && (fresh || (registry !== null && registryError !== null))) return
    try {
      const fetched = await fetchRegistry({ fetchImpl: options.fetchImpl })
      registry = { modules: fetched.modules, updated: fetched.updated, fetchedAt: Date.now() }
      registryError = null
    } catch (cause) {
      registryError = cause instanceof Error ? cause.message : String(cause)
    }
  }

  function isInstalled(module: MarketplaceModule): boolean {
    return module.builtIn === true || settings.current.marketplace.installed.includes(module.id)
  }

  /** Live listing: fetches the registry when stale, then filters in memory. */
  async function marketplaceList(
    filter: { query?: string; category?: string } = {},
    forceRefresh = false
  ): Promise<MarketplaceListResult> {
    await marketplaceRegistry(forceRefresh)
    const modules = registry?.modules ?? []
    const categories = [...new Set(modules.flatMap((m) => m.categories))].sort()
    return {
      modules: searchModules(modules, filter).map((module) => ({ ...module, installed: isInstalled(module) })),
      categories,
      fetchedAt: registry?.fetchedAt ?? null,
      error: registryError
    }
  }

  async function closeRemoteConnection(module: MarketplaceModule, connection: RemoteConnection): Promise<void> {
    try {
      await withRemoteTimeout(connection.close(), remoteTimeouts.closeMs, `${module.name} close`)
    } catch {
      // Closing is best-effort; a deadline prevents cleanup from blocking the server.
    }
  }

  async function removeRemoteConnection(moduleId: string): Promise<void> {
    const existing = remotes.get(moduleId)
    if (!existing) return
    remotes.delete(moduleId)
    options.onRemoteRemoved?.(moduleId)
    await closeRemoteConnection(existing.module, existing.connection)
  }

  /** Connect and list with bounded deadlines, sharing concurrent reconnect attempts. */
  async function remoteConnectModule(module: MarketplaceModule): Promise<ProxiedTool[]> {
    const pending = remoteConnectOperations.get(module.id)
    if (pending) return pending
    const operation = connectRemoteModule(module)
    remoteConnectOperations.set(module.id, operation)
    try {
      return await operation
    } finally {
      if (remoteConnectOperations.get(module.id) === operation) remoteConnectOperations.delete(module.id)
    }
  }

  async function connectRemoteModule(module: MarketplaceModule): Promise<ProxiedTool[]> {
    if (!module.endpoint) throw new Error(`"${module.name}" has no endpoint.`)
    await removeRemoteConnection(module.id)

    const connectionPromise = remoteConnect(module.endpoint)
    let connectExpired = false
    // A connect may resolve after the caller timed out. Close that late client
    // rather than leaking a transport that is no longer registered.
    void connectionPromise.then((lateConnection) => {
      if (connectExpired) void closeRemoteConnection(module, lateConnection)
    }, () => {})

    let connection: RemoteConnection
    try {
      connection = await withRemoteTimeout(connectionPromise, remoteTimeouts.connectMs, `${module.name} connect`)
    } catch (cause) {
      if (cause instanceof RemoteTimeoutError) connectExpired = true
      const message = cause instanceof Error ? cause.message : String(cause)
      remoteErrors.set(module.id, message)
      throw cause
    }

    let tools: RemoteToolDef[]
    try {
      tools = await withRemoteTimeout(connection.listTools(), remoteTimeouts.listMs, `${module.name} list tools`)
    } catch (cause) {
      await closeRemoteConnection(module, connection)
      const message = cause instanceof Error ? cause.message : String(cause)
      remoteErrors.set(module.id, message)
      throw cause
    }

    remotes.set(module.id, { module, connection, tools })
    remoteErrors.delete(module.id)
    const proxied: ProxiedTool[] = tools.map((tool) => ({
      name: proxiedToolName(module.id, tool.name),
      description: `[${module.name}] ${tool.description ?? tool.name}`,
      inputSchema: tool.inputSchema,
      annotations: tool.annotations,
      call: (args) => remoteCall(module, tool.name, args)
    }))
    options.onRemoteTools?.(module.id, proxied)
    return proxied
  }

  async function recoverRemote(module: MarketplaceModule): Promise<void> {
    const pending = remoteRecoveryOperations.get(module.id)
    if (pending) return pending
    const operation = (async () => {
      await removeRemoteConnection(module.id)
      await remoteConnectModule(module)
    })()
    remoteRecoveryOperations.set(module.id, operation)
    try {
      await operation
    } finally {
      if (remoteRecoveryOperations.get(module.id) === operation) remoteRecoveryOperations.delete(module.id)
    }
  }

  async function remoteCall(module: MarketplaceModule, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const existing = remotes.get(module.id)
    if (!existing) {
      try {
        await recoverRemote(module)
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause)
        remoteErrors.set(module.id, reason)
        throw new Error(`Remote ${module.name} is unavailable and the request was not sent: ${reason}`)
      }
      throw new Error(`Remote ${module.name} reconnected. This request was not sent; retry only after checking that the previous result is safe to repeat.`)
    }

    try {
      return await withRemoteTimeout(
        existing.connection.callTool(toolName, args),
        remoteTimeouts.callMs,
        `${module.name} tool ${toolName}`
      )
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      remoteErrors.set(module.id, reason)
      let recoveryError: string | null = null
      try {
        await recoverRemote(module)
      } catch (reconnectCause) {
        recoveryError = reconnectCause instanceof Error ? reconnectCause.message : String(reconnectCause)
        remoteErrors.set(module.id, recoveryError)
      }
      const recovery = recoveryError
        ? `Reconnect failed: ${recoveryError}`
        : 'The connection has been restored; check remote state before deciding to retry.'
      throw new Error(`Remote ${module.name} tool "${toolName}" failed: ${reason} The remote may have completed it; the call was not retried. ${recovery}`)
    }
  }

  async function remoteDisconnectModule(moduleId: string): Promise<void> {
    await removeRemoteConnection(moduleId)
    remoteErrors.delete(moduleId)
  }

  /** Reconnect installed remote servers after a restart. Failures are reported, not fatal. */
  async function remoteRestore(): Promise<{ connected: Array<{ id: string; tools: number }>; failed: Array<{ id: string; error: string }> }> {
    await marketplaceRegistry()
    const connected: Array<{ id: string; tools: number }> = []
    const failed: Array<{ id: string; error: string }> = []
    for (const id of settings.current.marketplace.installed) {
      const module = registry?.modules.find((m) => m.id === id && m.type === 'remote-server')
      if (!module) continue
      try {
        const tools = await remoteConnectModule(module)
        connected.push({ id, tools: tools.length })
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : String(cause)
        remoteErrors.set(id, error)
        failed.push({ id, error })
      }
    }
    return { connected, failed }
  }

  function remoteStatus(): Array<{ id: string; tools: number; connected: boolean; error: string | null }> {
    const ids = new Set([
      ...settings.current.marketplace.installed.filter((id) => registry?.modules.some((module) => module.id === id && module.type === 'remote-server')),
      ...remotes.keys(),
      ...remoteErrors.keys()
    ])
    return [...ids].map((id) => {
      const entry = remotes.get(id)
      return {
        id,
        tools: entry?.tools.length ?? 0,
        connected: Boolean(entry),
        error: entry ? null : (remoteErrors.get(id) ?? 'Remote server is not connected.')
      }
    })
  }

  /**
   * Install a module: widget bundles are applied through the portable bundle
   * validator; remote servers connect and register proxied tools; credential-
   * gated modules install enabled and report what still needs wiring.
   * Built-ins cannot be installed (they already are).
   */
  async function marketplaceInstall(id: unknown): Promise<MarketplaceInstallResult> {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('A module id is required.')
    await marketplaceRegistry()
    const module = registry?.modules.find((m) => m.id === id.trim())
    if (!module) throw new Error(`Unknown module "${id}". Refresh the marketplace and try again.`)
    if (module.builtIn) throw new Error(`"${module.name}" is built in — nothing to install.`)

    let applied: string[] = []
    let missingCredentials: string[] = []
    let note: string | null = null
    let remoteTools: string[] = []
    if (module.type === 'remote-server') {
      const tools = await remoteConnectModule(module)
      remoteTools = tools.map((tool) => tool.name)
      note = `Connected ${tools.length} remote tools from ${module.endpoint}. Tool arguments leave this machine.`
    } else if (module.bundle) {
      const result = await importWidgets({
        format: 'toolbox-widgets',
        formatVersion: 1,
        widgets: [module.bundle]
      })
      applied = result.applied
      missingCredentials = result.missingCredentials
    }
    if (module.credentialsRequired) {
      note = `"${module.name}" needs credentials wired up locally before it can run.`
    }
    if (!settings.current.marketplace.installed.includes(module.id)) {
      settings.current.marketplace.installed.push(module.id)
      await saveSettings(settings.current)
    }
    return { installed: [...settings.current.marketplace.installed], applied, missingCredentials, note, remoteTools }
  }

  /** Uninstall marks the module removed; widget settings are left intact. */
  async function marketplaceUninstall(id: unknown): Promise<{ installed: string[] }> {
    if (typeof id !== 'string' || id.trim() === '') throw new Error('A module id is required.')
    await marketplaceRegistry()
    const module = registry?.modules.find((m) => m.id === id.trim())
    if (module?.builtIn) throw new Error(`"${module.name}" is built in — it cannot be uninstalled.`)
    await remoteDisconnectModule(id.trim())
    settings.current.marketplace.installed = settings.current.marketplace.installed.filter((entry) => entry !== id.trim())
    await saveSettings(settings.current)
    return { installed: [...settings.current.marketplace.installed] }
  }

  async function marketplaceRefresh(): Promise<MarketplaceListResult> {
    return marketplaceList({}, true)
  }

  /** Installed widget ids — the overview renders only these cards. */
  function installedWidgets(): string[] {
    return [...settings.current.marketplace.installed]
  }

  return {
    init,
    get crypto() {
      return crypto
    },
    get gmail() {
      return gmail
    },
    cryptoRefresh,
    cryptoSetWatchlist,
    cryptoSeries,
    gmailConnect,
    gmailDisconnect,
    gmailCheck,
    resourceStats,
    resourceProcesses,
    settingsSnapshot,
    resourceSetSettings,
    modelFarmSetPrefs,
    modelFarmSetNote,
    llamafarmStatus,
    llamafarmStatusReport,
    llamafarmCatalog,
    llamafarmScore,
    llamafarmRefresh,
    llamafarmGrade,
    llamafarmInstall,
    llamafarmSearch,
    llamafarmQuants,
    llamafarmRemove,
    llamafarmRunNow,
    llamafarmProgress,
    llamafarmCancel,
    runtimesDetect,
    runtimesInstall,
    runtimesUse,
    runtimesModels,
    runtimesDownload,
    gatewayStatus,
    gatewayRequests,
    marketplaceList,
    marketplaceInstall,
    marketplaceUninstall,
    marketplaceRefresh,
    remoteRestore,
    remoteStatus,
    installedWidgets,
    exportWidgets,
    importWidgets
  }
}

export type Services = ReturnType<typeof createServices>
