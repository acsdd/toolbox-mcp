/**
 * Local settings store for toolbox-mcp.
 *
 * Lives in ~/.toolbox-mcp (or %TOOLBOX_MCP_HOME%). The file is written with
 * owner-only permissions. Gmail credentials are stored in the operating
 * system credential store; settings contain only a reference.
 */
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
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

/**
 * Write a file atomically: serialize to a unique temp file in the same
 * directory, flush it to disk, then rename over the target. A crash at any
 * point leaves either the old complete file or the new complete file — never
 * a truncated one that the fail-closed loader would reject.
 */
async function writeAtomic(target: string, data: string): Promise<void> {
  const dir = dirname(target)
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`)
  const handle = await open(tmp, 'w', 0o600)
  try {
    await handle.writeFile(data, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  // Windows can briefly refuse to replace a file another handle has open
  // (a reader, antivirus, or an indexer); retry the rename a few times.
  const retryCodes = new Set(['EPERM', 'EACCES', 'EBUSY'])
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, target)
      return
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code
      if (attempt >= 5 || !code || !retryCodes.has(code)) {
        await rm(tmp, { force: true }).catch(() => {})
        throw cause
      }
      await new Promise((resolve) => setTimeout(resolve, 10 * (attempt + 1)))
    }
  }
}

export async function saveSettings(settings: StoredSettings): Promise<void> {
  await writeAtomic(configPath(), JSON.stringify(settings, null, 2))
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
  await writeAtomic(catalogCachePath(), JSON.stringify(cache))
}

/**
 * Remove the orphaned temp files a crash between write and rename can leave
 * in the config dir. Scoped strictly to our own temp naming for the two files
 * we write atomically, so unrelated user files are never touched.
 */
export async function cleanStaleTempFiles(): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(configDir())
  } catch {
    return // no config dir yet — nothing to clean
  }
  const stale = entries.filter(
    (name) =>
      name.endsWith('.tmp') &&
      (name.startsWith('.settings.json.') || name.startsWith('.llamafarm-cache.json.'))
  )
  await Promise.all(stale.map((name) => rm(join(configDir(), name), { force: true }).catch(() => {})))
}
