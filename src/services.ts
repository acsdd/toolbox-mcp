/**
 * Widget services for toolbox-mcp: thin stateful wrappers around
 * @toolbox/widgets with local persistence and the portable bundle format.
 */
import {
  createResourceMonitor,
  detectMachine,
  fetchCatalog,
  fetchGmailInbox,
  fetchMarkets,
  fetchSeries,
  friendlyGmailError,
  MODEL_TASKS,
  normalizeWatchlist,
  parseBundle,
  scoreModels,
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
  type GmailCheckResult,
  type MachineProfile,
  type ModelTask,
  type ResourceStats,
  type ScoredModel,
  type TopProcess,
  type WidgetBundleEntry
} from '@toolbox/widgets'
import { loadCatalogCache, loadSettings, saveCatalogCache, saveSettings, type StoredSettings } from './config.js'

function isCatalogModel(value: unknown): value is CatalogModel {
  const candidate = value as Partial<CatalogModel> | null
  return (
    typeof candidate?.id === 'string' &&
    typeof candidate.task === 'string' &&
    typeof candidate.runtimeRamBytes === 'number' &&
    Array.isArray(candidate.formats)
  )
}

export const USER_AGENT = 'toolbox-mcp/0.2.0 (+https://github.com/28121978444/toolbox-mcp)'
const SERIES_TTL_MS = 30 * 60 * 1000
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
const CATALOG_PER_TASK = 24

interface ServicesOptions {
  fetchImpl?: FetchLike
  execFileImpl?: ExecFileLike
}

export interface LlamafarmScoreInput {
  scenario: FitScenario
  search?: string
  minParams?: number | null
  maxParams?: number | null
  /** Wave 3: suppress reds that carry no offload hints. */
  onlyReachable?: boolean
}

export interface LlamafarmGroup {
  task: ModelTask
  label: string
  icon: string
  models: ScoredModel[]
}

export interface LlamafarmScoreResult {
  machine: MachineProfile
  scenario: FitScenario
  fetchedAt: number | null
  groups: LlamafarmGroup[]
  total: number
  error: string | null
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

export function createServices(options: ServicesOptions = {}) {
  const fetchOptions = { userAgent: USER_AGENT, fetchImpl: options.fetchImpl }
  const settings: { current: StoredSettings } = {
    current: {
      version: 1,
      cryptoWatchlist: ['bitcoin', 'ethereum', 'solana'],
      gmail: null,
      resource: { showProcesses: true }
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
  let catalog: { models: CatalogModel[]; fetchedAt: number | null } | null = null
  let catalogError: string | null = null
  const detectOptions = { fetchImpl: options.fetchImpl, execFileImpl: options.execFileImpl }

  async function init(): Promise<void> {
    settings.current = await loadSettings()
    crypto.watchlist = normalizeWatchlist(settings.current.cryptoWatchlist)
    monitor = createResourceMonitor({ diskPath: settings.current.resource.diskPath })
    gmail = {
      configured: Boolean(settings.current.gmail),
      email: settings.current.gmail?.email ?? '',
      lastCheck: null,
      unread: 0,
      messages: [],
      error: null
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
    const result = await fetchGmailInbox(setup.email, setup.password).catch((cause) => {
      throw new Error(friendlyGmailError(cause))
    })
    settings.current.gmail = { ...setup, notifications: true }
    await saveSettings(settings.current)
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
    settings.current.gmail = null
    await saveSettings(settings.current)
    gmail = { configured: false, email: '', lastCheck: null, unread: 0, messages: [], error: null }
    return gmail
  }

  async function gmailCheck(): Promise<GmailState> {
    const account = settings.current.gmail
    if (!account) {
      gmail.error = 'Gmail is not connected. Connect with an App Password first.'
      return gmail
    }
    try {
      const result = await fetchGmailInbox(account.email, account.password)
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
        case 'gmail-announcer':
          // Settings are kept, but the App Password must exist locally.
          settings.current.gmail = null
          await saveSettings(settings.current)
          gmail = { configured: false, email: '', lastCheck: null, unread: 0, messages: [], error: null }
          missingCredentials.push(entry.credentialsRef ?? 'gmail/app-password')
          applied.push('gmail-announcer')
          break
      }
    }
    return { applied, missingCredentials }
  }

  // --- llamafarm: model catalog + fit scoring --------------------------------

  async function llamafarmStatus(forceDetect = false): Promise<MachineProfile> {
    if (!machine || forceDetect) {
      machine = await detectMachine(detectOptions)
    }
    return machine
  }

  /**
   * The model catalog, cached on disk for CATALOG_TTL_MS. Wave 1: when
   * Ollama is installed only GGUF repos are requested, since those are the
   * ones the machine can actually run.
   */
  async function llamafarmCatalog(forceRefresh = false): Promise<{
    models: CatalogModel[]
    fetchedAt: number | null
    error: string | null
  }> {
    const fresh = catalog !== null && catalog.fetchedAt !== null && Date.now() - catalog.fetchedAt < CATALOG_TTL_MS
    if (!forceRefresh && (fresh || (catalog !== null && catalogError !== null))) {
      return { models: catalog?.models ?? [], fetchedAt: catalog?.fetchedAt ?? null, error: catalogError }
    }
    const profile = await llamafarmStatus(forceRefresh)
    let models: CatalogModel[]
    let fetchedAt: number | null
    try {
      models = await fetchCatalog({
        formats: profile.ollama.installed ? ['gguf'] : ['gguf', 'safetensors'],
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
    return { models, fetchedAt, error: catalogError }
  }

  /**
   * Score the catalog against the machine. This powers both wave 2 (live
   * color marks as filters change) and wave 3 (submitted, ordered verdicts).
   */
  async function llamafarmScore(input: LlamafarmScoreInput): Promise<LlamafarmScoreResult> {
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
    const scored = scoreModels({ models: filtered, machine: profile, scenario: input.scenario })
    const visible = input.onlyReachable ? scored.filter((m) => m.verdict !== 'red' || m.hints.length > 0) : scored
    const byTask = new Map<ModelTask, ScoredModel[]>()
    for (const entry of visible) {
      const list = byTask.get(entry.task) ?? []
      list.push(entry)
      byTask.set(entry.task, list)
    }
    const groups: LlamafarmGroup[] = MODEL_TASKS.filter((info) => byTask.has(info.task)).map((info) => ({
      task: info.task,
      label: info.label,
      icon: info.icon,
      models: sortForDisplay(byTask.get(info.task) ?? [])
    }))
    return { machine: profile, scenario: input.scenario, fetchedAt, groups, total: visible.length, error }
  }

  /** Re-detect the machine and force a catalog refetch. */
  async function llamafarmRefresh(): Promise<{ machine: MachineProfile; catalog: number }> {
    machine = await detectMachine(detectOptions)
    await llamafarmCatalog(true)
    return { machine: await llamafarmStatus(), catalog: catalog?.models.length ?? 0 }
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
    llamafarmStatus,
    llamafarmCatalog,
    llamafarmScore,
    llamafarmRefresh,
    exportWidgets,
    importWidgets
  }
}

export type Services = ReturnType<typeof createServices>
