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
  fetchModelById,
  fetchRegistry,
  fetchSeries,
  friendlyGmailError,
  buildModelfile,
  MODEL_TASKS,
  normalizeWatchlist,
  parseBundle,
  planOllamaInstall,
  probeOllamaCli,
  pullIntoOllama,
  runOllamaCommand,
  scoreModels,
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
  type GmailCheckResult,
  type MachineProfile,
  type MarketplaceModule,
  type ModelTask,
  type PullResult,
  type ResourceStats,
  type ScoredModel,
  type TopProcess,
  type WidgetBundleEntry
} from '@toolbox/widgets'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCatalogCache, loadSettings, saveCatalogCache, saveSettings, type StoredSettings } from './config.js'
import { connectRemote, proxiedToolName, type ProxiedTool, type RemoteConnect, type RemoteConnection, type RemoteToolDef } from './remote.js'

function isCatalogModel(value: unknown): value is CatalogModel {
  const candidate = value as Partial<CatalogModel> | null
  return (
    typeof candidate?.id === 'string' &&
    typeof candidate.task === 'string' &&
    typeof candidate.runtimeRamBytes === 'number' &&
    Array.isArray(candidate.formats)
  )
}

export const USER_AGENT = 'toolbox-mcp/0.5.0 (+https://github.com/28121978444/toolbox-mcp)'
const SERIES_TTL_MS = 30 * 60 * 1000
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000
const CATALOG_PER_TASK = 24
const REGISTRY_TTL_MS = 5 * 60 * 1000

interface ServicesOptions {
  fetchImpl?: FetchLike
  execFileImpl?: ExecFileLike
  /** Pulls a model into the local Ollama runtime (injectable for tests). */
  pullModel?: (reference: string) => Promise<PullResult>
  /** Runs an arbitrary Ollama subcommand (injectable for tests). */
  runOllama?: (args: string[]) => Promise<PullResult>
  /** Remote MCP connection factory (injectable for tests). */
  remoteConnect?: RemoteConnect
  /** Called when a remote server connects and its tools are ready to register. */
  onRemoteTools?: (moduleId: string, tools: ProxiedTool[]) => void
  /** Called when a remote server is uninstalled and its tools must go. */
  onRemoteRemoved?: (moduleId: string) => void
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

export interface LlamafarmInstallInput {
  /** HuggingFace repo id, e.g. 'bartowski/Llama-3.2-3B-Instruct-GGUF'. */
  repo: string
  /** Quantization tag, e.g. 'Q4_K_M'. Defaults to the catalog entry's quant. */
  quant?: string
  /** Layers to keep on the GPU; writes a Modelfile instead of a plain pull. */
  offload?: number
}

export type LlamafarmInstallReason = 'installed' | 'ollama-missing' | 'not-found' | 'failed'

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

export function createServices(options: ServicesOptions = {}) {
  const fetchOptions = { userAgent: USER_AGENT, fetchImpl: options.fetchImpl }
  const settings: { current: StoredSettings } = {
    current: {
      version: 1,
      cryptoWatchlist: ['bitcoin', 'ethereum', 'solana'],
      gmail: null,
      resource: { showProcesses: true },
      marketplace: { installed: ['crypto-watch', 'gmail-announcer', 'resource-monitor'] }
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
  let registry: { modules: MarketplaceModule[]; updated: string; fetchedAt: number } | null = null
  let registryError: string | null = null
  const remotes = new Map<string, { connection: RemoteConnection; tools: RemoteToolDef[] }>()
  const remoteConnect = options.remoteConnect ?? connectRemote
  const detectOptions = { fetchImpl: options.fetchImpl, execFileImpl: options.execFileImpl }
  const execFileImpl = options.execFileImpl ?? (execFile as unknown as ExecFileLike)

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

  /**
   * Install a catalog model into the local Ollama runtime. Ollama serves any
   * GGUF from the Hub directly, so this is a single `ollama pull` — unless a
   * GPU split is requested, which writes a Modelfile instead.
   */
  async function llamafarmInstall(input: LlamafarmInstallInput): Promise<LlamafarmInstallResult> {
    const repo = input.repo?.trim() ?? ''
    const failure = (reason: LlamafarmInstallReason, message: string, extra: Partial<LlamafarmInstallResult> = {}): LlamafarmInstallResult => ({
      ok: false,
      repo,
      reference: null,
      modelName: null,
      reason,
      message,
      output: '',
      steps: [],
      ...extra
    })
    if (!repo) {
      throw new Error('A repo id is required, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF".')
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

    let plan: ReturnType<typeof planOllamaInstall>
    try {
      plan = planOllamaInstall(model, input.quant ?? model.quantLabel)
    } catch (cause) {
      return failure('failed', cause instanceof Error ? cause.message : String(cause))
    }

    const cli = await probeOllamaCli(execFileImpl)
    if (!cli.installed) {
      return failure('ollama-missing', 'Ollama is not installed on this machine.', {
        reference: plan.reference,
        modelName: plan.modelName,
        steps: plan.steps
      })
    }

    let result
    if (typeof input.offload === 'number' && Number.isFinite(input.offload)) {
      const directory = mkdtempSync(join(tmpdir(), 'toolbox-mcp-'))
      const modelfilePath = join(directory, 'Modelfile')
      writeFileSync(modelfilePath, buildModelfile(plan.reference, { numGpu: input.offload }), 'utf8')
      const runner = options.runOllama ?? ((args: string[]) => runOllamaCommand(args))
      result = await runner(['create', plan.modelName, '--file', modelfilePath])
    } else {
      const pull = options.pullModel ?? ((reference: string) => pullIntoOllama(reference))
      result = await pull(plan.reference)
    }

    if (!result.ok) {
      return failure('failed', result.error ?? 'The Ollama runtime refused the install.', {
        reference: plan.reference,
        modelName: plan.modelName,
        output: result.output,
        steps: plan.steps
      })
    }

    return {
      ok: true,
      repo: model.id,
      reference: plan.reference,
      modelName: plan.modelName,
      reason: 'installed',
      message: `${plan.reference} is ready to run.`,
      output: result.output,
      steps: plan.steps
    }
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

  /** Connect a remote-server module and surface its tools for registration. */
  async function remoteConnectModule(module: MarketplaceModule): Promise<ProxiedTool[]> {
    if (!module.endpoint) throw new Error(`"${module.name}" has no endpoint.`)
    const existing = remotes.get(module.id)
    if (existing) await existing.connection.close().catch(() => {})
    const connection = await remoteConnect(module.endpoint)
    let tools: RemoteToolDef[]
    try {
      tools = await connection.listTools()
    } catch (cause) {
      await connection.close().catch(() => {})
      throw cause
    }
    remotes.set(module.id, { connection, tools })
    const proxied: ProxiedTool[] = tools.map((tool) => ({
      name: proxiedToolName(module.id, tool.name),
      description: `[${module.name}] ${tool.description ?? tool.name}`,
      inputSchema: tool.inputSchema,
      call: (args) => connection.callTool(tool.name, args)
    }))
    options.onRemoteTools?.(module.id, proxied)
    return proxied
  }

  async function remoteDisconnectModule(moduleId: string): Promise<void> {
    const existing = remotes.get(moduleId)
    if (!existing) return
    remotes.delete(moduleId)
    options.onRemoteRemoved?.(moduleId)
    await existing.connection.close().catch(() => {})
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
        failed.push({ id, error: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    return { connected, failed }
  }

  function remoteStatus(): Array<{ id: string; tools: number }> {
    return [...remotes.entries()].map(([id, entry]) => ({ id, tools: entry.tools.length }))
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
    llamafarmStatus,
    llamafarmCatalog,
    llamafarmScore,
    llamafarmRefresh,
    llamafarmInstall,
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
