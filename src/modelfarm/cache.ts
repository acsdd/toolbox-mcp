/**
 * Versioned catalog cache for the Model Farm domain.
 *
 * The cache keeps one document per cache location. Every bucket records the
 * task set it covers, the age of every task it holds and the models that were
 * fetched for those tasks, so a refresh can replace one task without making
 * the other tasks look new.
 */
import type { CatalogModel, ModelFormat, ModelTask } from '@toolbox/widgets'

import { ALL_MODEL_TASKS, CATALOG_TTL_MS, cacheScopeKey, normalizeScopeTasks } from './policy.js'
import { createNodeCacheIo } from './runtime.js'
import type {
  CatalogCacheBucket,
  CatalogCacheDocument,
  CatalogCacheOptions,
  CatalogLoadRequest,
  CatalogLoadResult,
  CatalogScope,
  CacheIo
} from './contracts.js'

export type { CatalogCacheBucket, CatalogCacheDocument, CacheIo } from './contracts.js'

const CANONICAL_VERSION = 2 as const

export type CatalogFetcher = (options: { tasks?: ModelTask[]; formats?: ModelFormat[] }) => Promise<CatalogModel[]>

export interface CatalogCache {
  load(request: CatalogLoadRequest, fetch: CatalogFetcher): Promise<CatalogLoadResult>
  /** The canonical document path; the caller-visible path keeps its name. */
  readonly path: string
}

/** The canonical document lives beside the legacy file with a version suffix. */
export function versionedCachePath(path: string): string {
  if (/-v\d+\.json$/i.test(path)) return path
  return path.replace(/(\.json)$/i, `-v${CANONICAL_VERSION}$1`)
}

function bucketKey(bucket: CatalogCacheBucket): string {
  const tasks = bucket.tasks === '*' ? [] : bucket.tasks
  return cacheScopeKey({ tasks, formats: bucket.formats, runtime: bucket.runtime, perTask: bucket.perTask })
}

function bucketTasks(bucket: CatalogCacheBucket): ModelTask[] {
  return bucket.tasks === '*' ? [...ALL_MODEL_TASKS] : [...bucket.tasks]
}

function taskAge(bucket: CatalogCacheBucket, task: ModelTask, now: number): number {
  return now - (bucket.taskFetchedAt[task] ?? bucket.fetchedAt)
}

function uniqueModels(models: readonly CatalogModel[]): CatalogModel[] {
  const seen = new Set<string>()
  const result: CatalogModel[] = []
  for (const model of models) {
    if (seen.has(model.id)) continue
    seen.add(model.id)
    result.push(model)
  }
  return result
}

function matchesRequestFormats(model: CatalogModel, formats: readonly ModelFormat[]): boolean {
  if (!Array.isArray(model.formats) || model.formats.length === 0) return false
  return model.formats.some((format) => formats.includes(format))
}

export function createCatalogCache(options: CatalogCacheOptions): CatalogCache {
  const io = options.io ?? createNodeCacheIo()
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? CATALOG_TTL_MS
  const canonicalPath = versionedCachePath(options.path)
  const legacyPaths = [options.path, ...(options.legacyPaths ?? [])]

  let document: CatalogCacheDocument = { version: CANONICAL_VERSION, buckets: {} }
  let legacyModels: CatalogModel[] = []
  let publication: Promise<void> = Promise.resolve()

  function matchesScope(bucket: CatalogCacheBucket, request: CatalogLoadRequest): boolean {
    if (bucket.runtime !== request.runtime) return false
    if (bucket.perTask !== request.perTask) return false
    const requested = new Set(request.formats)
    return bucket.formats.length === requested.size && bucket.formats.every((format) => requested.has(format))
  }

  /** Fresh task coverage of the in-memory document for this request scope. */
  function freshCoverage(source: CatalogCacheDocument, request: CatalogLoadRequest): Map<ModelTask, CatalogCacheBucket> {
    const coverage = new Map<ModelTask, CatalogCacheBucket>()
    const timestamp = now()
    const fullRequest = !Array.isArray(request.tasks) || request.tasks.length === 0
    for (const bucket of Object.values(source.buckets)) {
      if (!matchesScope(bucket, request)) continue
      // A union of partial buckets is not a full catalog fetch.
      if (fullRequest && bucket.tasks !== '*') continue
      for (const task of bucketTasks(bucket)) {
        if (taskAge(bucket, task, timestamp) >= ttlMs) continue
        if (!coverage.has(task)) coverage.set(task, bucket)
      }
    }
    return coverage
  }

  async function load(request: CatalogLoadRequest, fetch: CatalogFetcher): Promise<CatalogLoadResult> {
    const formats = [...request.formats]
    const explicit = Array.isArray(request.tasks) && request.tasks.length > 0
    const targetTasks = explicit ? normalizeScopeTasks(request.tasks) : [...ALL_MODEL_TASKS]
    const fullCoverage = !explicit

    // The provider request must start before the first await, so the bucket
    // age reflects the moment the provider started working. The disk is read
    // afterwards; a disk hit then wins over the fresh fetch.
    const coverage = freshCoverage(document, request)
    const missing = targetTasks.filter((task) => !coverage.has(task))
    const needsFetch = request.refresh === true || missing.length > 0

    if (!needsFetch) {
      return {
        models: modelsFrom(coverage),
        fetchedAt: newestAge(coverage),
        fromCache: true,
        coverage: fullCoverage ? '*' : targetTasks,
        error: null
      }
    }

    // The provider request starts before the disk is touched: the bucket age
    // must reflect the moment the provider started working, not the moment the
    // cache finished reading its document.
    const started = startFetches(fetch, request, fullCoverage ? null : (request.refresh === true ? targetTasks : missing), formats)

    let fetchedModels: CatalogModel[] = []
    let fetchError: string | null = null
    try {
      for (const entry of started) {
        const models = await entry.promise
        fetchedModels.push(...models)
      }
    } catch (cause) {
      fetchError = cause instanceof Error ? cause.message : String(cause)
    }

    const hydrated = await hydrate(request)
    const diskCoverage = freshCoverage(hydrated, request)
    const diskComplete = request.refresh !== true && targetTasks.every((task) => diskCoverage.has(task))

    if (diskComplete) {
      return {
        models: modelsFrom(diskCoverage),
        fetchedAt: newestAge(diskCoverage),
        fromCache: true,
        coverage: fullCoverage ? '*' : targetTasks,
        error: null
      }
    }

    if (fetchError !== null) {
      const stale = staleModels(request, formats)
      return {
        models: stale,
        fetchedAt: null,
        fromCache: false,
        coverage: [...diskCoverage.keys()],
        error: fetchError
      }
    }

    const published = await publish(request, targetTasks, fullCoverage, fetchedModels, started, hydrated)
    return {
      models: published.bucket.models,
      fetchedAt: published.bucket.fetchedAt,
      fromCache: false,
      coverage: fullCoverage ? '*' : targetTasks,
      error: published.error
    }
  }

  function modelsFrom(coverage: Map<ModelTask, CatalogCacheBucket>): CatalogModel[] {
    const buckets = new Set<CatalogCacheBucket>(coverage.values())
    return uniqueModels([...buckets].flatMap((bucket) => bucket.models))
  }

  function newestAge(coverage: Map<ModelTask, CatalogCacheBucket>): number | null {
    let newest: number | null = null
    for (const bucket of new Set<CatalogCacheBucket>(coverage.values())) {
      if (newest === null || bucket.fetchedAt > newest) newest = bucket.fetchedAt
    }
    return newest
  }

  function startFetches(
    fetch: CatalogFetcher,
    request: CatalogLoadRequest,
    tasks: ModelTask[] | null,
    formats: ModelFormat[]
  ): Array<{ task: ModelTask | null; tasks?: ModelTask[]; promise: Promise<CatalogModel[]>; fetchedAt: number }> {
    const entries: Array<{ task: ModelTask | null; tasks?: ModelTask[]; promise: Promise<CatalogModel[]>; fetchedAt: number }> = []
    const start = (options: { tasks?: ModelTask[]; formats?: ModelFormat[] }, task: ModelTask | null) => {
      let promise: Promise<CatalogModel[]>
      try {
        promise = Promise.resolve(fetch(options))
      } catch (cause) {
        promise = Promise.reject(cause)
      }
      entries.push({ task, tasks: options.tasks, promise, fetchedAt: now() })
    }
    if (tasks === null) {
      start({ formats }, null)
      return entries
    }
    start({ tasks: [...tasks], formats }, null)
    return entries
  }

  /** Publish the fetched models into the document and write it atomically. */
  async function publish(
    request: CatalogLoadRequest,
    targetTasks: ModelTask[],
    fullCoverage: boolean,
    fetchedModels: CatalogModel[],
    started: Array<{ task: ModelTask | null; tasks?: ModelTask[]; fetchedAt: number }>,
    hydrated: CatalogCacheDocument
  ): Promise<{ bucket: CatalogCacheBucket; error: string | null }> {
    const buckets = new Map(Object.entries(hydrated.buckets))
    const scopeMatches = (bucket: CatalogCacheBucket) => matchesScope(bucket, request)

    const stampByTask = new Map<ModelTask, number>()
    for (const entry of started) {
      if (entry.task) stampByTask.set(entry.task, entry.fetchedAt)
      else for (const task of entry.tasks ?? targetTasks) stampByTask.set(task, entry.fetchedAt)
    }
    const fallbackStamp = started[0]?.fetchedAt ?? now()
    // Only the refetched tasks get a new age; the other tasks keep the age
    // they were fetched with.
    const fetchedTasks = new Set<ModelTask>(stampByTask.keys())

    const covering = [...buckets.values()].find((bucket) => {
      if (!scopeMatches(bucket)) return false
      const tasks = bucketTasks(bucket)
      return [...fetchedTasks].every((task) => tasks.includes(task))
    })
    const mergeable = [...buckets.values()].find((bucket) => {
      if (!scopeMatches(bucket)) return false
      const tasks = bucketTasks(bucket)
      return tasks.every((task) => targetTasks.includes(task))
    })

    let bucket: CatalogCacheBucket
    if (covering) {
      bucket = {
        ...covering,
        taskFetchedAt: { ...covering.taskFetchedAt },
        models: replaceTaskModels(covering.models, fetchedTasks, fetchedModels)
      }
    } else if (mergeable) {
      bucket = {
        ...mergeable,
        tasks: fullCoverage ? '*' : [...targetTasks],
        taskFetchedAt: { ...mergeable.taskFetchedAt },
        models: replaceTaskModels(mergeable.models, fetchedTasks, fetchedModels)
      }
    } else {
      const preserved = new Map<ModelTask, CatalogCacheBucket>()
      for (const task of targetTasks) {
        if (fetchedTasks.has(task)) continue
        for (const related of buckets.values()) {
          if (!scopeMatches(related) || !bucketTasks(related).includes(task)) continue
          const current = preserved.get(task)
          const stamp = related.taskFetchedAt[task] ?? related.fetchedAt
          if (!current || stamp > (current.taskFetchedAt[task] ?? current.fetchedAt)) preserved.set(task, related)
        }
      }
      bucket = {
        tasks: fullCoverage ? '*' : [...targetTasks],
        formats: [...request.formats],
        runtime: request.runtime,
        perTask: request.perTask,
        fetchedAt: fallbackStamp,
        taskFetchedAt: {},
        models: uniqueModels([...preserved.values()].flatMap((entry) => entry.models).concat(fetchedModels))
      }
      for (const [task, entry] of preserved) bucket.taskFetchedAt[task] = entry.taskFetchedAt[task] ?? entry.fetchedAt
    }

    for (const task of fetchedTasks) {
      bucket.taskFetchedAt[task] = stampByTask.get(task) ?? fallbackStamp
    }
    bucket.models = uniqueModels(bucket.models)
    bucket.fetchedAt = Math.min(...Object.values(bucket.taskFetchedAt) as number[])

    for (const [key, value] of [...buckets]) {
      if (value === covering || value === mergeable) buckets.delete(key)
    }
    buckets.set(bucketKey(bucket), bucket)
    const next = { version: CANONICAL_VERSION, buckets: Object.fromEntries(buckets) }
    try {
      await writeDocument(next)
    } catch (cause) {
      // The previous document stays intact; the caller sees the write failure.
      return { bucket, error: cause instanceof Error ? cause.message : String(cause) }
    }
    document = next
    return { bucket, error: null }
  }

  function replaceTaskModels(
    models: readonly CatalogModel[],
    tasks: ReadonlySet<ModelTask>,
    fetched: readonly CatalogModel[]
  ): CatalogModel[] {
    const kept = models.filter((model) => !tasks.has(model.task))
    return uniqueModels([...kept, ...fetched])
  }

  async function hydrate(request: CatalogLoadRequest): Promise<CatalogCacheDocument> {
    const raw = await io.read(canonicalPath)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CatalogCacheDocument
        if (parsed?.version === CANONICAL_VERSION && parsed.buckets) {
          document = { version: CANONICAL_VERSION, buckets: parsed.buckets }
          return document
        }
      } catch {
        // A damaged document is replaced by a fresh fetch.
      }
    }

    const legacy = await readLegacyDocument(request)
    legacyModels = legacy.models
    if (!legacy.bucket) {
      document = { version: CANONICAL_VERSION, buckets: {} }
      return document
    }
    document = { version: CANONICAL_VERSION, buckets: { [bucketKey(legacy.bucket)]: legacy.bucket } }
    try {
      await writeDocument(document)
    } catch {
      // The imported legacy catalog stays usable in memory even when the
      // canonical copy cannot be written.
    }
    return document
  }

  async function readLegacyDocument(request: CatalogLoadRequest): Promise<{ bucket: CatalogCacheBucket | null; models: CatalogModel[] }> {
    for (const legacyPath of legacyPaths) {
      const raw = await io.read(legacyPath)
      if (!raw) continue
      let parsed: { version?: unknown; fetchedAt?: number; coverage?: unknown; models?: unknown } | null = null
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      if (!parsed || parsed.version === CANONICAL_VERSION) continue
      const models = Array.isArray(parsed.models) ? (parsed.models as CatalogModel[]) : []
      // Legacy data without coverage metadata never proves a full catalog.
      if (parsed.coverage !== '*') return { bucket: null, models }
      if (typeof parsed.fetchedAt !== 'number') return { bucket: null, models }
      if (!models.every((model) => matchesRequestFormats(model, request.formats))) {
        return { bucket: null, models }
      }
      return {
        bucket: {
          tasks: '*',
          formats: [...request.formats],
          runtime: request.runtime,
          perTask: request.perTask,
          fetchedAt: parsed.fetchedAt,
          taskFetchedAt: {},
          models
        },
        models
      }
    }
    return { bucket: null, models: [] }
  }

  function staleModels(request: CatalogLoadRequest, formats: ModelFormat[]): CatalogModel[] {
    const fromBuckets = Object.values(document.buckets)
      .filter((bucket) => matchesScope(bucket, request))
      .flatMap((bucket) => bucket.models)
    return uniqueModels([...fromBuckets, ...legacyModels]).filter((model) => matchesRequestFormats(model, formats))
  }

  async function writeDocument(next: CatalogCacheDocument): Promise<void> {
    await io.write(canonicalPath, JSON.stringify(next))
  }

  return { load, path: canonicalPath }
}
