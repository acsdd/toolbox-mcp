/**
 * Local settings store for toolbox-mcp.
 *
 * Lives in ~/.toolbox-mcp (or %TOOLBOX_MCP_HOME%). The file is written with
 * owner-only permissions. NOTE: the Gmail App Password is stored in this file
 * until a proper OS keychain integration lands — the repo is private and the
 * server binds to localhost only, but treat the file as sensitive.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import os from 'node:os'

export interface StoredSettings {
  version: 1
  cryptoWatchlist: string[]
  gmail: { email: string; password: string; notifications: boolean } | null
  resource: { diskPath?: string; showProcesses: boolean }
}

const DEFAULTS: StoredSettings = {
  version: 1,
  cryptoWatchlist: ['bitcoin', 'ethereum', 'solana'],
  gmail: null,
  resource: { showProcesses: true }
}

export function configDir(): string {
  return process.env.TOOLBOX_MCP_HOME ?? join(os.homedir(), '.toolbox-mcp')
}

export function configPath(): string {
  return join(configDir(), 'settings.json')
}

export async function loadSettings(): Promise<StoredSettings> {
  try {
    const raw = JSON.parse(await readFile(configPath(), 'utf8')) as Partial<StoredSettings>
    return {
      version: 1,
      cryptoWatchlist: Array.isArray(raw.cryptoWatchlist) ? raw.cryptoWatchlist : DEFAULTS.cryptoWatchlist,
      gmail:
        raw.gmail && typeof raw.gmail.email === 'string' && typeof raw.gmail.password === 'string'
          ? {
              email: raw.gmail.email,
              password: raw.gmail.password,
              notifications: raw.gmail.notifications !== false
            }
          : null,
      resource: {
        diskPath: typeof raw.resource?.diskPath === 'string' ? raw.resource.diskPath : undefined,
        showProcesses: raw.resource?.showProcesses !== false
      }
    }
  } catch {
    return structuredClone(DEFAULTS)
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
