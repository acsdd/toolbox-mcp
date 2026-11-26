/**
 * Shared plumbing for the CLI commands: dependency injection (so the whole
 * CLI is testable without a network or a GPU), the catalog cache and the
 * small helpers every command needs.
 */
import { homedir } from 'node:os'
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  catalogCachePath,
  detectMachine,
  fetchCatalog,
  isCatalogFresh,
  readCatalogCache,
  type CatalogModel,
  type DetectOptions,
  type ExecFileLike,
  type FetchCatalogOptions,
  type FetchModelOptions,
  type MachineProfile,
  type ModelTask,
  type OllamaCliInfo,
  type PullResult,
  type SpawnLike
} from '@toolbox/widgets'
import type { ParsedArgs } from './args.js'
import type { Palette } from './render.js'

export interface CliDeps {
  detect?: (options?: DetectOptions) => Promise<MachineProfile>
  fetchCatalog?: (options?: FetchCatalogOptions) => Promise<CatalogModel[]>
  fetchModel?: (repoId: string, options?: FetchModelOptions) => Promise<CatalogModel | null>
  probeOllama?: (execFileImpl: ExecFileLike) => Promise<OllamaCliInfo>
  pull?: (reference: string, options?: { onOutput?: (chunk: string) => void }) => Promise<PullResult>
  runOllama?: (args: string[], options?: { onOutput?: (chunk: string) => void }) => Promise<PullResult>
  execFile?: ExecFileLike
  spawnImpl?: SpawnLike
  write?: (text: string) => void
  env?: Record<string, string | undefined>
  cachePath?: string
  now?: () => number
}

export interface CommandContext {
  deps: CliDeps
  args: ParsedArgs
  palette: Palette
  json: boolean
  write: (text: string) => void
}

/** Where the CLI keeps its cache; overridable for tests and portable installs. */
export function appHome(env: Record<string, string | undefined> = process.env): string {
  return env.TOOLBOX_LLAMAFARM_HOME ?? join(homedir(), '.toolbox-llamafarm')
}

export function cachePathFor(deps: CliDeps): string {
  return deps.cachePath ?? catalogCachePath(appHome(deps.env ?? process.env))
}

/**
 * Load the catalog, preferring a fresh cache. Fetching is slow (one detail
 * request per model), so the cache is what makes the CLI feel instant.
 */
export async function loadCatalog(
  ctx: CommandContext,
  options: { tasks?: ModelTask[]; perTask?: number; refresh?: boolean } = {}
): Promise<{ models: CatalogModel[]; fromCache: boolean }> {
  const path = cachePathFor(ctx.deps)
  const cached = readCatalogCache(path)
  const now = ctx.deps.now?.() ?? Date.now()

  const wanted = options.tasks
  const freshCache = cached && isCatalogFresh(cached, undefined, now) ? cached : null
  let scope: '*' | string[] | null = null
  if (freshCache) try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { coverage?: unknown }
    if (saved.coverage === '*') scope = '*'
    else if (Array.isArray(saved.coverage) && saved.coverage.every(x => typeof x === 'string')) scope = saved.coverage
  } catch { /* Older or unreadable cache: refetch rather than claim completeness. */ }
  const coversRequested = scope === '*' || (Boolean(wanted) && Array.isArray(scope) && wanted!.every(task => scope!.includes(task)))

  if (!options.refresh && freshCache && coversRequested) {
    return { models: filterTasks(freshCache.models, wanted), fromCache: true }
  }

  const fetchImpl = ctx.deps.fetchCatalog ?? fetchCatalog
  const fresh = await fetchImpl({
    ...(wanted ? { tasks: wanted } : {}),
    ...(options.perTask ? { perTask: options.perTask } : {})
  })

  // Another task may have completed while the network request was in flight.
  // Merge its latest valid coverage instead of overwriting it with a stale snapshot.
  const current = readCatalogCache(path)
  let currentScope: '*' | string[] | null = null
  if (current && isCatalogFresh(current, undefined, now)) try {
    const saved = JSON.parse(readFileSync(path, 'utf8')) as { coverage?: unknown }
    if (saved.coverage === '*') currentScope = '*'
    else if (Array.isArray(saved.coverage) && saved.coverage.every(x => typeof x === 'string')) currentScope = saved.coverage
  } catch { /* Treat unreadable coverage as unknown. */ }
  const preserve = Boolean(wanted && current && currentScope)
  const otherTasks = preserve ? current!.models.filter(model => !wanted!.includes(model.task)) : []
  const merged = [...otherTasks, ...fresh]
  const coverage = !wanted || (preserve && currentScope === '*') ? '*' : [...new Set([...(preserve && Array.isArray(currentScope) ? currentScope : []), ...wanted])]
  // Preserved tasks retain their original age; a narrow refresh must not make
  // unrelated cached tasks appear newly fetched.
  const fetchedAt = preserve ? current!.fetchedAt : now
  mkdirSync(dirname(path), { recursive: true })
  const temp = path + '.' + randomUUID() + '.tmp'
  try { writeFileSync(temp, JSON.stringify({ fetchedAt, models: merged, coverage }), { encoding: 'utf8', mode: 0o600, flag: 'wx' }); renameSync(temp,path) }
  finally { rmSync(temp,{force:true}) }
  return { models: filterTasks(merged, wanted), fromCache: false }
}

function filterTasks(models: CatalogModel[], tasks?: ModelTask[]): CatalogModel[] {
  if (!tasks || tasks.length === 0) return models
  return models.filter((model) => tasks.includes(model.task))
}

/** Detect the machine with the injected detector. */
export async function detect(ctx: CommandContext): Promise<MachineProfile> {
  const detector = ctx.deps.detect ?? detectMachine
  return detector()
}
