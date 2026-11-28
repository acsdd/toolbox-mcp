import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import type { CatalogModel, ModelFormat, ModelTask } from '@toolbox/widgets'
import { CATALOG_TTL_MS, cacheScopeKey } from '../../dist/modelfarm/policy.js'
import { createCatalogCache, versionedCachePath, type CatalogCacheDocument } from '../../dist/modelfarm/cache.js'

function model(id: string, task: ModelTask, formats: ModelFormat[] = ['gguf']): CatalogModel {
  return {
    id,
    task,
    label: id,
    author: 'owner',
    formats,
    paramsBillions: 7,
    quantLabel: formats.includes('gguf') ? 'Q4_K_M' : null,
    fileBytes: 1024,
    runtimeRamBytes: 1280,
    downloads: 1,
    likes: 1,
    license: 'mit',
    tags: formats,
    hfUrl: `https://huggingface.co/${id}`
  }
}

function memoryIo(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial))
  return {
    files,
    read: async (path: string) => files.get(path) ?? null,
    write: async (path: string, data: string) => { files.set(path, data) }
  }
}

describe('versioned catalog cache scopes', () => {
  it('derives a sibling v2 path without changing the public legacy path', () => {
    assert.equal(versionedCachePath('/data/catalog-cache.json'), '/data/catalog-cache-v2.json')
    assert.equal(versionedCachePath('/data/llamafarm-cache.json'), '/data/llamafarm-cache-v2.json')
    assert.equal(versionedCachePath('/data/model-catalog-v2.json'), '/data/model-catalog-v2.json')
    assert.equal(
      cacheScopeKey({ tasks: ['text-to-image', 'text-generation'], formats: ['gguf'], runtime: 'ollama', perTask: 24 }),
      cacheScopeKey({ tasks: ['text-generation', 'text-to-image'], formats: ['gguf'], runtime: 'ollama', perTask: 24 })
    )
  })

  it('isolates formats, runtimes and per-task depth', async () => {
    const io = memoryIo()
    const cache = createCatalogCache({ path: '/data/catalog-cache.json', io, now: () => 1000 })
    const calls: unknown[] = []
    const fetch = async (options: { tasks?: ModelTask[]; formats?: ModelFormat[] }) => {
      calls.push(options)
      return [model(`m-${calls.length}`, 'text-generation', options.formats)]
    }
    await cache.load({ tasks: ['text-generation'], formats: ['gguf'], runtime: 'ollama', perTask: 24 }, fetch)
    await cache.load({ tasks: ['text-generation'], formats: ['safetensors'], runtime: 'ollama', perTask: 24 }, fetch)
    await cache.load({ tasks: ['text-generation'], formats: ['gguf'], runtime: 'lmstudio', perTask: 24 }, fetch)
    await cache.load({ tasks: ['text-generation'], formats: ['gguf'], runtime: 'ollama', perTask: 40 }, fetch)
    assert.equal(calls.length, 4)
    const hit = await cache.load({ tasks: ['text-generation'], formats: ['gguf'], runtime: 'ollama', perTask: 24 }, fetch)
    assert.equal(hit.fromCache, true)
    assert.equal(calls.length, 4)
  })

  it('expires buckets at the six-hour TTL', async () => {
    let now = 1000
    const io = memoryIo()
    const cache = createCatalogCache({ path: '/data/catalog-cache.json', io, now: () => now })
    let calls = 0
    const fetch = async () => { calls++; return [model('text', 'text-generation')] }
    const request = { formats: ['gguf'] as ModelFormat[], runtime: 'ollama', perTask: 24 }
    await cache.load(request, fetch)
    now += CATALOG_TTL_MS - 1
    assert.equal((await cache.load(request, fetch)).fromCache, true)
    now += 1
    assert.equal((await cache.load(request, fetch)).fromCache, false)
    assert.equal(calls, 2)
  })

  it('fetches only missing task coverage and preserves the other task age', async () => {
    let now = 1000
    const io = memoryIo()
    const cache = createCatalogCache({ path: '/data/catalog-cache.json', io, now: () => now })
    const fetched: ModelTask[][] = []
    const fetch = async (options: { tasks?: ModelTask[] }) => {
      fetched.push([...(options.tasks ?? [])])
      return (options.tasks ?? []).map((task) => model(task, task))
    }
    await cache.load({ tasks: ['text-generation'], formats: ['gguf'], runtime: 'ollama', perTask: 24 }, fetch)
    now = 2000
    const combined = await cache.load({
      tasks: ['text-generation', 'text-to-image'], formats: ['gguf'], runtime: 'ollama', perTask: 24
    }, fetch)
    assert.equal(combined.fromCache, false)
    assert.deepEqual(fetched, [['text-generation'], ['text-to-image']])
    assert.deepEqual(combined.coverage, ['text-generation', 'text-to-image'])
    assert.equal(combined.models.length, 2)
    const document = JSON.parse(io.files.get(versionedCachePath('/data/catalog-cache.json'))!) as CatalogCacheDocument
    const bucket = Object.values(document.buckets).find((entry) => entry.tasks.includes('text-to-image'))!
    assert.equal(bucket.taskFetchedAt['text-generation'], 1000)
    assert.equal(bucket.taskFetchedAt['text-to-image'], 2000)
  })

  it('does not infer full coverage from a partial cache', async () => {
    const io = memoryIo()
    const cache = createCatalogCache({ path: '/data/catalog-cache.json', io, now: () => 1000 })
    let calls = 0
    const fetch = async () => { calls++; return [model('text', 'text-generation'), model('image', 'text-to-image')] }
    await cache.load({ tasks: ['text-generation'], formats: ['gguf'], runtime: 'ollama', perTask: 24 }, fetch)
    const full = await cache.load({ formats: ['gguf'], runtime: 'ollama', perTask: 24 }, fetch)
    assert.equal(full.fromCache, false)
    assert.deepEqual(full.coverage, '*')
    assert.equal(calls, 2)
  })

  it('merges concurrent different-task publications and keeps original bucket timestamps', async () => {
    let now = 1000
    const io = memoryIo()
    const cache = createCatalogCache({ path: '/data/catalog-cache.json', io, now: () => now })
    let releaseText!: () => void
    const textGate = new Promise<void>((resolve) => { releaseText = resolve })
    const text = cache.load({ tasks: ['text-generation'], formats: ['gguf'], runtime: 'ollama', perTask: 24 }, async () => {
      await textGate
      return [model('text', 'text-generation')]
    })
    now = 2000
    const image = cache.load({ tasks: ['text-to-image'], formats: ['gguf'], runtime: 'ollama', perTask: 24 }, async () => {
      now = 3000
      return [model('image', 'text-to-image')]
    })
    await image
    now = 1000
    releaseText()
    await text
    now = 3000
    const document = JSON.parse(io.files.get(versionedCachePath('/data/catalog-cache.json'))!) as CatalogCacheDocument
    const buckets = Object.values(document.buckets)
    assert.equal(buckets.length, 2)
    assert.equal(buckets.find((bucket) => bucket.tasks.includes('text-generation'))?.fetchedAt, 1000)
    assert.equal(buckets.find((bucket) => bucket.tasks.includes('text-to-image'))?.fetchedAt, 3000)
    const combined = await cache.load({
      tasks: ['text-generation', 'text-to-image'], formats: ['gguf'], runtime: 'ollama', perTask: 24
    }, async () => { throw new Error('combined coverage should be cached') })
    assert.equal(combined.fromCache, true)
    assert.equal(combined.models.length, 2)
  })

  it('refreshes only requested tasks in an existing bucket', async () => {
    let now = 1000
    const io = memoryIo()
    const cache = createCatalogCache({ path: '/data/catalog-cache.json', io, now: () => now })
    const fetch = async (options: { tasks?: ModelTask[] }) => (options.tasks ?? []).map((task) => model(`${task}-${now}`, task))
    const both = { tasks: ['text-generation', 'text-to-image'] as ModelTask[], formats: ['gguf'] as ModelFormat[], runtime: 'ollama', perTask: 24 }
    await cache.load(both, fetch)
    now = 2000
    await cache.load({ ...both, tasks: ['text-generation'], refresh: true }, fetch)
    now = 3000
    const result = await cache.load(both, fetch)
    assert.equal(result.fromCache, true)
    assert.ok(result.models.some((entry) => entry.id === 'text-generation-2000'))
    assert.ok(result.models.some((entry) => entry.id === 'text-to-image-1000'))
  })
})

describe('legacy migration and atomic cache publication', () => {
  it('imports legacy coverage without modifying the original and is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cache-migrate-'))
    const path = join(dir, 'catalog-cache.json')
    const legacy = JSON.stringify({ fetchedAt: 1000, coverage: '*', models: [model('legacy', 'text-generation')] })
    try {
      await writeFile(path, legacy)
      const cache = createCatalogCache({ path, now: () => 2000 })
      const first = await cache.load({ formats: ['gguf', 'safetensors'], runtime: 'llamafarm', perTask: 24 }, async () => {
        throw new Error('legacy full coverage should be imported')
      })
      assert.equal(first.fromCache, true)
      assert.equal(first.models.length, 1)
      assert.equal(await readFile(path, 'utf8'), legacy)
      const canonical = await readFile(versionedCachePath(path), 'utf8')
      await cache.load({ formats: ['gguf', 'safetensors'], runtime: 'llamafarm', perTask: 24 }, async () => {
        throw new Error('second migration should remain cached')
      })
      assert.equal(await readFile(versionedCachePath(path), 'utf8'), canonical)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  it('never treats metadata-free legacy data as a fresh full catalog', async () => {
    const io = memoryIo({ '/data/catalog-cache.json': JSON.stringify({ fetchedAt: 1000, models: [model('legacy', 'text-generation')] }) })
    const cache = createCatalogCache({ path: '/data/catalog-cache.json', io, now: () => 2000 })
    let calls = 0
    const result = await cache.load({ formats: ['gguf'], runtime: 'ollama', perTask: 24 }, async () => {
      calls++
      throw new Error('offline')
    })
    assert.equal(calls, 1)
    assert.equal(result.fromCache, false)
    assert.equal(result.error, 'offline')
    assert.deepEqual(result.models.map((entry) => entry.id), ['legacy'])
    assert.deepEqual(result.coverage, [])
  })

  it('rejects stale mixed-format legacy entries for MCP and filters offline fallback to GGUF', async () => {
    const io = memoryIo({
      '/data/llamafarm-cache.json': JSON.stringify({
        fetchedAt: 1000,
        coverage: '*',
        models: [model('gguf', 'text-generation', ['gguf']), model('safe', 'text-to-image', ['safetensors'])]
      })
    })
    const cache = createCatalogCache({ path: '/data/llamafarm-cache.json', io, now: () => 2000 })
    const result = await cache.load({ formats: ['gguf'], runtime: 'ollama', perTask: 24 }, async () => {
      throw new Error('offline')
    })
    assert.equal(result.error, 'offline')
    assert.deepEqual(result.models.map((entry) => entry.id), ['gguf'])
    assert.deepEqual(result.coverage, [])
  })

  it('leaves the previous complete document intact when atomic publication fails', async () => {
    const path = '/data/catalog-cache.json'
    const original = JSON.stringify({ version: 2, buckets: {} })
    const io = memoryIo({ [versionedCachePath(path)]: original })
    let fail = false
    const cache = createCatalogCache({
      path,
      now: () => 1000,
      io: {
        read: io.read,
        write: async (target, data) => {
          assert.ok(JSON.parse(data).version === 2, 'only complete JSON reaches the publisher')
          if (fail) throw new Error('disk full')
          await io.write(target, data)
        }
      }
    })
    const fetch = async () => [model('text', 'text-generation')]
    const request = { formats: ['gguf'] as ModelFormat[], runtime: 'ollama', perTask: 24 }
    fail = true
    const result = await cache.load(request, fetch)
    assert.equal(result.error, 'disk full')
    assert.equal(io.files.get(versionedCachePath(path)), original)
    fail = false
    assert.equal((await cache.load(request, fetch)).models.length, 1)
  })

  it('keeps installed and portable cache locations separate', async () => {
    const installed = memoryIo()
    const portable = memoryIo()
    const a = createCatalogCache({ path: '/installed/catalog-cache.json', io: installed, now: () => 1000 })
    const b = createCatalogCache({ path: '/portable/catalog-cache.json', io: portable, now: () => 1000 })
    await a.load({ formats: ['gguf'], runtime: 'ollama', perTask: 24 }, async () => [model('installed', 'text-generation')])
    assert.equal(portable.files.size, 0)
    const result = await b.load({ formats: ['gguf'], runtime: 'ollama', perTask: 24 }, async () => [model('portable', 'text-generation')])
    assert.deepEqual(result.models.map((entry) => entry.id), ['portable'])
  })
})
