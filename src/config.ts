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
import { normalizeWatchlist } from '@toolbox/widgets'

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

/** One successful Model Farm install, as remembered for the panel's recent strip. */
export interface ModelInstallRecord {
  repo: string
  label: string
  runtime: string
  installedAt: number
}

export const MAX_INSTALL_HISTORY = 12
const INSTALL_REPO_MAX_LENGTH = 200
const INSTALL_LABEL_MAX_LENGTH = 120
const INSTALL_RUNTIME_MAX_LENGTH = 60

/**
 * Validate stored install history: drop malformed entries, deduplicate by
 * repo+runtime keeping the newest, order newest-first and cap the list so
 * settings cannot grow without bound.
 */
export function sanitizeModelInstalls(raw: unknown): ModelInstallRecord[] {
  if (!Array.isArray(raw)) return []
  const byKey = new Map<string, ModelInstallRecord>()
  for (const entry of raw) {
    const doc = (entry ?? {}) as { repo?: unknown; label?: unknown; runtime?: unknown; installedAt?: unknown }
    if (typeof doc.repo !== 'string') continue
    const repo = doc.repo.trim()
    if (!repo || repo.length > INSTALL_REPO_MAX_LENGTH) continue
    if (typeof doc.installedAt !== 'number' || !Number.isFinite(doc.installedAt) || doc.installedAt <= 0) continue
    const label =
      typeof doc.label === 'string' && doc.label.trim()
        ? doc.label.trim().slice(0, INSTALL_LABEL_MAX_LENGTH)
        : repo
    const runtime = typeof doc.runtime === 'string' ? doc.runtime.trim().slice(0, INSTALL_RUNTIME_MAX_LENGTH) : ''
    const record: ModelInstallRecord = { repo, label, runtime, installedAt: Math.floor(doc.installedAt) }
    const key = `${repo}\u0000${runtime}`
    const current = byKey.get(key)
    if (!current || record.installedAt > current.installedAt) byKey.set(key, record)
  }
  return [...byKey.values()].sort((a, b) => b.installedAt - a.installedAt).slice(0, MAX_INSTALL_HISTORY)
}

/** Record a fresh install; reinstalling the same repo moves it to the front. */
export function recordModelInstall(history: ModelInstallRecord[], record: ModelInstallRecord): ModelInstallRecord[] {
  return sanitizeModelInstalls([record, ...history])
}

/** Free-form user notes per model repo, shown in the Model Farm detail view. */
export const MAX_MODEL_NOTES = 200
export const NOTE_REPO_MAX_LENGTH = 200
export const NOTE_MAX_LENGTH = 1000

/**
 * Validate stored model notes: drop malformed entries, trim and truncate
 * prose, and cap the count so settings cannot grow without bound. Built
 * through Object.fromEntries so a repo named "__proto__" stays a plain key.
 */
export function sanitizeModelNotes(raw: unknown): Record<string, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const entries: [string, string][] = []
  for (const [key, value] of Object.entries(raw)) {
    if (entries.length >= MAX_MODEL_NOTES) break
    const repo = key.trim()
    if (!repo || repo.length > NOTE_REPO_MAX_LENGTH) continue
    if (typeof value !== 'string') continue
    const note = value.trim().slice(0, NOTE_MAX_LENGTH)
    if (!note) continue
    entries.push([repo, note])
  }
  return Object.fromEntries(entries)
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
  modelInstalls: ModelInstallRecord[]
  modelNotes: Record<string, string>
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
  modelFarm: { ...DEFAULT_MODEL_FARM_PREFS },
  modelInstalls: [],
  modelNotes: {}
}

export function configDir(): string {
  return process.env.TOOLBOX_MCP_HOME ?? join(os.homedir(), '.toolbox-mcp')
}

/** Persisted settings are untrusted; a bad watchlist must not block startup. */
function sanitizeCryptoWatchlist(raw: unknown): string[] {
  try {
    return normalizeWatchlist(raw)
  } catch {
    return [...DEFAULTS.cryptoWatchlist]
  }
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
      modelInstalls?: unknown
      modelNotes?: unknown
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
      cryptoWatchlist: sanitizeCryptoWatchlist(raw.cryptoWatchlist),
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
      modelFarm: sanitizeModelFarmPrefs(raw.modelFarm),
      modelInstalls: sanitizeModelInstalls(raw.modelInstalls),
      modelNotes: sanitizeModelNotes(raw.modelNotes)
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
 * How many times an atomic replace is retried when the operating system
 * refuses it.
 *
 * Windows refuses to replace a file that any handle still has open, so a
 * reader looking at the settings at that instant makes the replace fail with
 * EPERM. The window is short — a read handle is open for milliseconds — so
 * the write samples the replace often and gives the lock time to clear
 * instead of failing the save. The budget spans a few seconds, which covers a
 * busy machine holding the file open for a long moment.
 */
export const ATOMIC_WRITE_MAX_ATTEMPTS = 400

/** Errors that a later attempt can plausibly succeed past. */
const ATOMIC_WRITE_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

export interface AtomicWriteOptions {
  /** The replace step; injectable so the retry policy can be exercised. */
  renameImpl?: (from: string, to: string) => Promise<void>
  /** How many replace attempts to make before giving up. */
  maxAttempts?: number
}

/**
 * Write a file atomically: serialize to a unique temp file in the same
 * directory, flush it to disk, then rename over the target. A crash at any
 * point leaves either the old complete file or the new complete file — never
 * a truncated one that the fail-closed loader would reject.
 *
 * The rename step is retried while the operating system reports a transient
 * refusal (a locked target on Windows), because giving up there would turn a
 * momentary lock into a lost write.
 */
export async function writeAtomic(
  target: string,
  data: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const renameImpl = options.renameImpl ?? rename
  const maxAttempts = Math.max(1, options.maxAttempts ?? ATOMIC_WRITE_MAX_ATTEMPTS)
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
  for (let attempt = 0; ; attempt++) {
    try {
      await renameImpl(tmp, target)
      return
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException)?.code
      if (
        attempt >= maxAttempts - 1 ||
        !code ||
        !ATOMIC_WRITE_RETRY_CODES.has(code)
      ) {
        await rm(tmp, { force: true }).catch(() => {})
        throw cause
      }
      // The lock clears in milliseconds, so the first attempts sample it
      // tightly; later attempts ease off so a stuck file cannot spin.
      await new Promise((resolve) => setTimeout(resolve, attempt < 50 ? 2 : 20))
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
