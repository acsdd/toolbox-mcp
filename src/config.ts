/**
 * Local settings store for toolbox-mcp.
 *
 * Lives in ~/.toolbox-mcp (or %TOOLBOX_MCP_HOME%). The file is written with
 * owner-only permissions. Gmail credentials are stored in the operating
 * system credential store; settings contain only a reference.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import os from 'node:os'

/** Browsing options the Model Farm panel remembers across restarts. */
export interface ModelFarmPrefs {
  scenario: 'now' | 'total'
  taskFilter: string
  minParams: number | null
  maxParams: number | null
  showReds: boolean
}

export const DEFAULT_MODEL_FARM_PREFS: ModelFarmPrefs = {
  scenario: 'now',
  taskFilter: '',
  minParams: null,
  maxParams: null,
  showReds: false
}

/** Parameter bounds (billions) offered by the panel's min/max selects. */
const MIN_PARAM_OPTIONS = [1, 3, 7, 13, 33, 70]
const MAX_PARAM_OPTIONS = [3, 7, 13, 33, 70]
const TASK_FILTER_MAX_LENGTH = 120

/**
 * Validate stored or submitted browsing options. Anything unrecognized falls
 * back to the default for that field, so old or corrupted settings never
 * restore a broken filter state.
 */
export function sanitizeModelFarmPrefs(raw: unknown): ModelFarmPrefs {
  const doc = (raw ?? {}) as {
    scenario?: unknown
    taskFilter?: unknown
    minParams?: unknown
    maxParams?: unknown
    showReds?: unknown
  }
  const taskFilter = typeof doc.taskFilter === 'string' ? doc.taskFilter.trim() : ''
  return {
    scenario: doc.scenario === 'total' ? 'total' : 'now',
    taskFilter: taskFilter.length <= TASK_FILTER_MAX_LENGTH ? taskFilter : '',
    minParams: typeof doc.minParams === 'number' && MIN_PARAM_OPTIONS.includes(doc.minParams) ? doc.minParams : null,
    maxParams: typeof doc.maxParams === 'number' && MAX_PARAM_OPTIONS.includes(doc.maxParams) ? doc.maxParams : null,
    showReds: doc.showReds === true
  }
}

export interface StoredSettings {
  version: 2
  cryptoWatchlist: string[]
  gmail: { email: string; credentialRef: string; notifications: boolean } | null
  resource: { diskPath?: string; showProcesses: boolean }
  marketplace: { installed: string[] }
  /** The local model runtime the Model Farm installs into; null means Ollama. */
  runtimes: { active: string | null }
  modelFarm: ModelFarmPrefs
}

export interface LegacyGmailSettings {
  email: string
  password: string
  notifications: boolean
  credentialRef?: string
}

export interface LoadedSettings {
  settings: StoredSettings
  legacyGmail: LegacyGmailSettings | null
}

const DEFAULTS: StoredSettings = {
  version: 2,
  cryptoWatchlist: ['bitcoin', 'ethereum', 'solana'],
  gmail: null,
  resource: { showProcesses: true },
  marketplace: { installed: ['crypto-watch', 'gmail-announcer', 'resource-monitor'] },
  runtimes: { active: null },
  modelFarm: { ...DEFAULT_MODEL_FARM_PREFS }
}

export function configDir(): string {
  return process.env.TOOLBOX_MCP_HOME ?? join(os.homedir(), '.toolbox-mcp')
}

export function configPath(): string {
  return join(configDir(), 'settings.json')
}

export async function loadSettings(): Promise<LoadedSettings> {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as {
      cryptoWatchlist?: unknown
      gmail?: { email?: unknown; password?: unknown; credentialRef?: unknown; notifications?: unknown } | null
      resource?: { diskPath?: unknown; showProcesses?: unknown }
      marketplace?: { installed?: unknown }
      runtimes?: { active?: unknown }
      modelFarm?: unknown
    }
    const rawGmail = raw.gmail
    const legacyGmail = rawGmail && typeof rawGmail.email === 'string' && typeof rawGmail.password === 'string'
      ? {
          email: rawGmail.email,
          password: rawGmail.password,
          notifications: rawGmail.notifications !== false,
          ...(typeof rawGmail.credentialRef === 'string' ? { credentialRef: rawGmail.credentialRef } : {})
        }
      : null
    const settings: StoredSettings = {
      version: 2,
      cryptoWatchlist: Array.isArray(raw.cryptoWatchlist) ? raw.cryptoWatchlist.filter((id): id is string => typeof id === 'string') : DEFAULTS.cryptoWatchlist,
      gmail:
        rawGmail && typeof rawGmail.email === 'string' && typeof rawGmail.credentialRef === 'string' && !legacyGmail
          ? {
              email: rawGmail.email,
              credentialRef: rawGmail.credentialRef,
              notifications: rawGmail.notifications !== false
            }
          : null,
      resource: {
        diskPath: typeof raw.resource?.diskPath === 'string' ? raw.resource.diskPath : undefined,
        showProcesses: raw.resource?.showProcesses !== false
      },
      marketplace: {
        installed: Array.isArray(raw.marketplace?.installed)
          ? raw.marketplace.installed.filter((id): id is string => typeof id === 'string')
          : [...DEFAULTS.marketplace.installed]
      },
      runtimes: {
        active: typeof raw.runtimes?.active === 'string' ? raw.runtimes.active : null
      },
      modelFarm: sanitizeModelFarmPrefs(raw.modelFarm)
    }
    return { settings, legacyGmail }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { settings: structuredClone(DEFAULTS), legacyGmail: null }
    }
    throw new Error('Unable to read settings; refusing to continue without checking legacy Gmail credentials.')
  }
}

export async function saveSettings(settings: StoredSettings): Promise<void> {
  const target = configPath()
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(settings, null, 2), {
    encoding: 'utf8',
    mode: 0o600
  })
}

/** On-disk cache for the llamafarm model catalog (HuggingFace data). */
export interface CatalogCache {
  models: unknown[]
  fetchedAt: number
}

export function catalogCachePath(): string {
  return join(configDir(), 'llamafarm-cache.json')
}

export async function loadCatalogCache(): Promise<CatalogCache | null> {
  try {
    const raw = JSON.parse(await readFile(catalogCachePath(), 'utf8')) as Partial<CatalogCache>
    if (!Array.isArray(raw.models) || typeof raw.fetchedAt !== 'number') return null
    return { models: raw.models, fetchedAt: raw.fetchedAt }
  } catch {
    return null
  }
}

export async function saveCatalogCache(cache: CatalogCache): Promise<void> {
  const target = catalogCachePath()
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(cache), { encoding: 'utf8', mode: 0o600 })
}
