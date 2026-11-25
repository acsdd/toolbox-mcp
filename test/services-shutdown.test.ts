import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import type { StoredSettings } from '../dist/config.js'
import { createServices } from '../dist/services.js'
import type { RuntimeFetchResponse, RuntimeInstallOptions, RuntimeInstallResult } from '../dist/runtimes.js'
import type { ProxiedTool, RemoteConnection } from '../dist/remote.js'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const SHUTDOWN_REMOTE_MODULE = {
  id: 'remote-test',
  type: 'remote-server' as const,
  name: 'Remote Test',
  description: 'Shutdown test remote',
  version: '0.1.0',
  author: 'Toolbox',
  icon: 'remote',
  categories: ['developer'],
  tags: ['test'],
  homepage: 'https://example.com',
  endpoint: 'https://remote.example.com/mcp'
}

function shutdownRegistryFetch() {
  const registry = {
    format: 'toolbox-marketplace',
    formatVersion: 1,
    updated: '2026-11-24T00:00:00.000Z',
    modules: [SHUTDOWN_REMOTE_MODULE]
  }
  return (async (input: string | URL) => {
    if (String(input).includes('registry.json')) return new Response(JSON.stringify(registry), { status: 200 })
    return new Response('[]', { status: 200 })
  }) as never
}

function fakeRemoteConnection(overrides: Partial<RemoteConnection> = {}): RemoteConnection {
  return {
    async listTools() { return [] },
    async callTool() { return null },
    async close() {},
    ...overrides
  }
}

async function useTemporaryHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-shutdown-'))
  const previous = process.env.TOOLBOX_MCP_HOME
  process.env.TOOLBOX_MCP_HOME = home
  t.after(async () => {
    if (previous === undefined) delete process.env.TOOLBOX_MCP_HOME
    else process.env.TOOLBOX_MCP_HOME = previous
    await rm(home, { recursive: true, force: true })
  })
  return home
}

const SHUTDOWN_MODEL_BYTES = 100 * 1024 * 1024

const SHUTDOWN_MODEL = {
  id: 'test/shutdown-model',
  pipeline_tag: 'text-generation',
  tags: ['gguf', 'license:apache-2.0'],
  downloads: 10,
  likes: 1
}

function shutdownModelFetch() {
  return (async (input: string | URL) => {
    const url = String(input)
    const body = url.includes('/api/models/test/shutdown-model')
      ? {
          siblings: [{ rfilename: 'shutdown-model-Q4_K_M.gguf', size: SHUTDOWN_MODEL_BYTES, lfs: { size: SHUTDOWN_MODEL_BYTES } }],
          cardData: { license: 'apache-2.0' }
        }
      : [SHUTDOWN_MODEL]
    return new Response(JSON.stringify(body), { status: 200 })
  }) as never
}

function shutdownRuntimeFetchResponse(): RuntimeFetchResponse {
  return {
    ok: true,
    status: 200,
    json: async () => ({ siblings: [{ rfilename: 'shutdown-model-Q4_K_M.gguf', lfs: { size: SHUTDOWN_MODEL_BYTES } }] }),
    text: async () => ''
  }
}

const shutdownRuntimeFetch = async (): Promise<RuntimeFetchResponse> => shutdownRuntimeFetchResponse()

test('close aborts and drains a marketplace registry fetch started by remote restore', { timeout: 3_000 }, async (t) => {
  const home = await useTemporaryHome(t)
  await writeFile(join(home, 'settings.json'), JSON.stringify({ marketplace: { installed: ['remote-test'] } }))
  const fetchStarted = deferred()
  let registrySignal: AbortSignal | undefined
  let releaseFetch: ((response: Response) => void) | undefined
  t.after(() => releaseFetch?.(new Response(JSON.stringify({
    format: 'toolbox-marketplace', formatVersion: 1, modules: []
  }), { status: 200 })))
  const services = createServices({
    fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
      registrySignal = init?.signal ?? undefined
      const stalledFetch = new Promise<Response>((resolve, reject) => {
        releaseFetch = resolve
        registrySignal?.addEventListener('abort', () => reject(registrySignal?.reason), { once: true })
      })
      fetchStarted.resolve()
      return stalledFetch
    }) as never
  })
  await services.init()
  const restoring = services.remoteRestore()
  await fetchStarted.promise
  const closing = services.close()
  const outcome = await Promise.race([
    restoring.then(() => 'restored' as const, () => 'rejected' as const),
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250))
  ])
  releaseFetch(new Response('{}', { status: 500 }))
  await closing
  assert.equal(outcome, 'rejected')
  assert.equal(registrySignal?.aborted, true)
})

test('close is shared, closes admission synchronously, and works before init', async () => {
  const services = createServices({
    fetchImpl: (async () => new Response('[]', { status: 200 })) as never,
    saveSettingsImpl: async () => {}
  })

  const first = services.close()
  const second = services.close()

  assert.equal(first, second)
  assert.equal(services.closing, true)
  await assert.rejects(() => services.cryptoSetWatchlist(['bitcoin']), /shutting down/)
  await Promise.all([first, second])
})

test('close drains an admitted settings commit without admitting another', async () => {
  const saveStarted = deferred()
  const releaseSave = deferred()
  const services = createServices({
    saveSettingsImpl: async (_settings: StoredSettings) => {
      saveStarted.resolve()
      await releaseSave.promise
    }
  })

  const mutation = services.modelFarmSetPrefs({ scenario: 'total' })
  await saveStarted.promise
  let closed = false
  const closing = services.close().then(() => { closed = true })

  await assert.rejects(() => services.resourceSetSettings({ diskPath: 'R:\\models' }), /shutting down/)
  await Promise.resolve()
  assert.equal(closed, false, 'shutdown must await an admitted persistence operation')

  releaseSave.resolve()
  await Promise.all([mutation, closing])
  assert.equal(closed, true)
})

test('close drains an admitted model install and prevents a late download', { timeout: 3000 }, async (t) => {
  const home = await useTemporaryHome(t)
  const metadataStarted = deferred()
  const releaseMetadata = deferredValue<RuntimeFetchResponse>()
  let downloads = 0
  const services = createServices({
    fetchImpl: shutdownModelFetch(),
    runtimeFetchImpl: async () => {
      metadataStarted.resolve()
      return releaseMetadata.promise
    },
    freeDiskImpl: async () => 1024 * 1024 * 1024,
    homeDir: join(home, 'home'),
    downloadFileImpl: async () => {
      downloads++
      throw new Error('a late download must not start')
    }
  })
  await services.init()

  const install = services.llamafarmInstall({ repo: SHUTDOWN_MODEL.id, runtime: 'lmstudio' })
  const outcome = install.then(
    (result) => `resolved: ${result.reason}`,
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`
  )
  await metadataStarted.promise
  const closing = services.close()
  try {
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'shutdown must await the admitted install')
  } finally {
    releaseMetadata.resolve(shutdownRuntimeFetchResponse())
  }

  assert.match(await outcome, /rejected: .*shutting down/)
  await closing
  assert.equal(downloads, 0)
})

test('close prevents a watchlist refresh after its settings commit finishes', { timeout: 3000 }, async () => {
  const saveStarted = deferred()
  const releaseSave = deferred()
  let marketRequests = 0
  const services = createServices({
    saveSettingsImpl: async () => {
      saveStarted.resolve()
      await releaseSave.promise
    },
    fetchImpl: (async () => {
      marketRequests++
      return new Response('[]', { status: 200 })
    }) as never
  })

  const mutation = services.cryptoSetWatchlist(['bitcoin'])
  await saveStarted.promise
  const closing = services.close()
  releaseSave.resolve()

  await assert.rejects(() => mutation, /shutting down/)
  await closing
  assert.equal(marketRequests, 0, 'shutdown must prevent follow-on market I/O')
})

test('close prevents GGUF metadata work after a download model lookup finishes', { timeout: 3000 }, async () => {
  const metadataStarted = deferred()
  const releaseMetadata = deferred()
  let modelSignal: AbortSignal | undefined
  let ggufRequests = 0
  const services = createServices({
    fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
      modelSignal = init?.signal ?? undefined
      metadataStarted.resolve()
      await releaseMetadata.promise
      return new Response(JSON.stringify(SHUTDOWN_MODEL), { status: 200 })
    }) as never,
    runtimeFetchImpl: async () => {
      ggufRequests++
      return shutdownRuntimeFetchResponse()
    },
    freeDiskImpl: async () => 1024 * 1024 * 1024,
    homeDir: join(tmpdir(), 'toolbox-mcp-late-download-home'),
    downloadFileImpl: async () => {
      throw new Error('a late download must not start')
    }
  })

  const download = services.runtimesDownload({ runtime: 'lmstudio', repo: SHUTDOWN_MODEL.id })
  await metadataStarted.promise
  const closing = services.close()
  releaseMetadata.resolve()

  await assert.rejects(() => download, /shutting down/)
  await closing
  assert.equal(modelSignal?.aborted, true, 'shutdown must cancel the model lookup')
  assert.equal(ggufRequests, 0, 'shutdown must prevent follow-on GGUF metadata I/O')
})

test('close drains runtime detection and rejects its late result', { timeout: 3000 }, async () => {
  const detectionStarted = deferred()
  const releaseDetection = deferredValue<RuntimeFetchResponse>()
  let probes = 0
  let cliProbes = 0
  const services = createServices({
    runtimeFetchImpl: async () => {
      probes++
      if (probes === 1) {
        detectionStarted.resolve()
        return releaseDetection.promise
      }
      return shutdownRuntimeFetchResponse()
    },
    execFileImpl: (_file, _args, _options, cb) => {
      cliProbes++
      cb(new Error('not found'), '', '')
    }
  })

  const detection = services.runtimesDetect(true).then(
    () => 'resolved',
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`
  )
  await detectionStarted.promise
  const closing = services.close()
  try {
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'shutdown must await admitted runtime detection')
  } finally {
    releaseDetection.resolve(shutdownRuntimeFetchResponse())
  }

  assert.match(await detection, /rejected: .*shutting down/)
  await closing
  assert.equal(cliProbes, 0, 'shutdown must prevent new runtime CLI probes')
})

test('model installation is rejected before network work after closing starts', async () => {
  let requests = 0
  const services = createServices({
    fetchImpl: (async () => {
      requests++
      return new Response('[]', { status: 200 })
    }) as never
  })

  await services.close()
  await assert.rejects(
    () => services.llamafarmInstall({ repo: 'test/model', runtime: 'lmstudio' }),
    /shutting down/
  )
  assert.equal(requests, 0)
})

test('close aborts a forced catalog fetch and prevents its cache write', { timeout: 3000 }, async (t) => {
  const home = await useTemporaryHome(t)
  const fetchStarted = deferred()
  const releaseFetch = deferredValue<Response>()
  let catalogSignal: AbortSignal | undefined
  const services = createServices({
    fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
      catalogSignal = init?.signal ?? undefined
      fetchStarted.resolve()
      return releaseFetch.promise
    }) as never
  })
  await services.init()

  const cataloging = services.llamafarmCatalog(true)
  void cataloging.catch(() => {})
  await fetchStarted.promise
  const closing = services.close()
  try {
    assert.equal(catalogSignal?.aborted, true, 'shutdown must cancel the catalog request')
  } finally {
    releaseFetch.resolve(new Response(JSON.stringify([SHUTDOWN_MODEL]), { status: 200 }))
  }

  await assert.rejects(() => cataloging, /shutting down/)
  await closing
  await assert.rejects(
    () => readFile(join(home, 'llamafarm-cache.json'), 'utf8'),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
})

test('close prevents a catalog refresh after machine detection is cancelled', { timeout: 3000 }, async (t) => {
  await useTemporaryHome(t)
  const detectionStarted = deferred()
  let catalogRequests = 0
  const services = createServices({
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/tags')) {
        detectionStarted.resolve()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
        })
      }
      if (url.includes('/api/models')) catalogRequests++
      return new Response('[]', { status: 200 })
    }) as never,
    execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', '')
  })
  await services.init()

  const refreshing = services.llamafarmRefresh()
  void refreshing.catch(() => {})
  await detectionStarted.promise
  const closing = services.close()

  await assert.rejects(() => refreshing, /shutting down/)
  await closing
  assert.equal(catalogRequests, 0, 'shutdown must prevent follow-on catalog I/O')
})

test('close aborts model search and rejects its late result', { timeout: 3000 }, async (t) => {
  await useTemporaryHome(t)
  const searchStarted = deferred()
  const releaseSearch = deferredValue<Response>()
  let searchingCatalog = false
  let searchSignal: AbortSignal | undefined
  const services = createServices({
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('/api/tags')) return new Response(JSON.stringify({ models: [] }), { status: 200 })
      if (!searchingCatalog) return new Response('[]', { status: 200 })
      searchSignal = init?.signal ?? undefined
      searchStarted.resolve()
      return releaseSearch.promise
    }) as never,
    execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', '')
  })
  await services.init()
  await services.llamafarmStatus()

  searchingCatalog = true
  const search = services.llamafarmSearch({ query: 'shutdown' })
  void search.catch(() => {})
  await searchStarted.promise
  const closing = services.close()
  try {
    assert.equal(searchSignal?.aborted, true, 'shutdown must cancel the search request')
  } finally {
    releaseSearch.resolve(new Response(JSON.stringify([SHUTDOWN_MODEL]), { status: 200 }))
  }

  await assert.rejects(() => search, /shutting down/)
  await closing
})

test('close aborts GGUF quantization lookup and rejects its late result', { timeout: 3000 }, async () => {
  const quantsStarted = deferred()
  const releaseQuants = deferredValue<Response>()
  let quantsSignal: AbortSignal | undefined
  const services = createServices({
    fetchImpl: (async (_input: string | URL, init?: RequestInit) => {
      quantsSignal = init?.signal ?? undefined
      quantsStarted.resolve()
      return releaseQuants.promise
    }) as never
  })

  const quants = services.llamafarmQuants(SHUTDOWN_MODEL.id)
  void quants.catch(() => {})
  await quantsStarted.promise
  const closing = services.close()
  try {
    assert.equal(quantsSignal?.aborted, true, 'shutdown must cancel the quantization request')
  } finally {
    releaseQuants.resolve(new Response(JSON.stringify({
      siblings: [{ rfilename: 'shutdown-model-Q8_0.gguf', size: SHUTDOWN_MODEL_BYTES, lfs: { size: SHUTDOWN_MODEL_BYTES } }],
      cardData: { license: 'apache-2.0' }
    }), { status: 200 }))
  }

  await assert.rejects(() => quants, /shutting down/)
  await closing
})

test('close cancels an install quantization lookup before probing Ollama', { timeout: 3000 }, async (t) => {
  const home = await useTemporaryHome(t)
  const quantsStarted = deferred()
  const releaseQuants = deferredValue<Response>()
  let lookupSignal: AbortSignal | undefined
  let cliProbes = 0
  let lookupPending = false
  const services = createServices({
    fetchImpl: (async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      if (lookupPending && url.includes('/api/models')) {
        lookupSignal = init?.signal ?? undefined
        quantsStarted.resolve()
        return releaseQuants.promise
      }
      if (url.includes('/api/models/test/shutdown-model')) {
        return new Response(JSON.stringify({
          siblings: [{ rfilename: 'shutdown-model-Q4_K_M.gguf', size: SHUTDOWN_MODEL_BYTES, lfs: { size: SHUTDOWN_MODEL_BYTES } }],
          cardData: { license: 'apache-2.0' }
        }), { status: 200 })
      }
      return new Response(JSON.stringify([SHUTDOWN_MODEL]), { status: 200 })
    }) as never,
    execFileImpl: (_file, _args, _options, cb) => {
      cliProbes++
      cb(new Error('not found'), '', '')
    },
    homeDir: join(home, 'home')
  })
  await services.init()
  await services.llamafarmCatalog(true)

  lookupPending = true
  const installing = services.llamafarmInstall({ repo: SHUTDOWN_MODEL.id, runtime: 'ollama', quant: 'Q8_0' })
  void installing.catch(() => {})
  await quantsStarted.promise
  const closing = services.close()
  try {
    assert.equal(lookupSignal?.aborted, true, 'shutdown must cancel the install quantization request')
  } finally {
    releaseQuants.resolve(new Response(JSON.stringify({
      siblings: [{ rfilename: 'shutdown-model-Q8_0.gguf', size: SHUTDOWN_MODEL_BYTES, lfs: { size: SHUTDOWN_MODEL_BYTES } }],
      cardData: { license: 'apache-2.0' }
    }), { status: 200 }))
  }

  await assert.rejects(() => installing, /shutting down/)
  await closing
  assert.equal(cliProbes, 0, 'shutdown must prevent the follow-on Ollama CLI probe')
})

test('close aborts an active folder download and awaits its cleanup', { timeout: 3000 }, async (t) => {
  const home = await useTemporaryHome(t)
  const cleanupStarted = deferred()
  const releaseCleanup = deferred()
  const downloadStarted = deferred()
  let downloadSignal: AbortSignal | undefined
  const services = createServices({
    fetchImpl: shutdownModelFetch(),
    runtimeFetchImpl: shutdownRuntimeFetch,
    freeDiskImpl: async () => 1024 * 1024 * 1024,
    homeDir: join(home, 'home'),
    downloadFileImpl: async (_url, _target, _onProgress, signal) => {
      downloadSignal = signal
      downloadStarted.resolve()
      return new Promise<number>((_resolve, reject) => {
        const abort = () => {
          cleanupStarted.resolve()
          void releaseCleanup.promise.then(() => {
            const error = new Error('Download aborted.')
            error.name = 'AbortError'
            reject(error)
          })
        }
        if (signal?.aborted) abort()
        else signal?.addEventListener('abort', abort, { once: true })
      })
    }
  })
  await services.init()

  const install = services.llamafarmInstall({ repo: SHUTDOWN_MODEL.id, runtime: 'lmstudio' })
  const started = await Promise.race([
    downloadStarted.promise.then(() => 'started'),
    install.then((result) => `ended: ${result.reason}: ${result.message}`)
  ])
  assert.equal(started, 'started')
  const closing = services.close()
  try {
    await Promise.resolve()
    assert.equal(downloadSignal?.aborted, true, 'shutdown must abort an owned transfer')
    await cleanupStarted.promise
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    assert.equal(closed, false, 'shutdown must wait for transfer cleanup')
  } finally {
    releaseCleanup.resolve()
  }

  const result = await install
  await closing
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
  assert.equal((await services.llamafarmProgress()).downloads[0]?.status, 'cancelled')
})

test('close aborts an admitted runtime installer and waits for it', { timeout: 3000 }, async () => {
  const installerStarted = deferred()
  const cleanupStarted = deferred()
  const releaseCleanup = deferred()
  let installSignal: AbortSignal | undefined
  let installs = 0
  const options = {
    runtimeFetchImpl: async (): Promise<RuntimeFetchResponse> => ({
      ok: false, status: 404, json: async () => ({}), text: async () => ''
    }),
    execFileImpl: (
      _file: string,
      _args: string[],
      _options: unknown,
      cb: (error: Error | null, stdout: string, stderr: string) => void
    ): void => cb(new Error('not found'), '', ''),
    installRuntimeImpl: async (installOptions: RuntimeInstallOptions): Promise<RuntimeInstallResult> => {
      installs++
      installSignal = installOptions.signal
      installerStarted.resolve()
      return new Promise<RuntimeInstallResult>((resolve) => {
        const abort = () => {
          cleanupStarted.resolve()
          void releaseCleanup.promise.then(() => resolve({
            ok: false,
            id: 'ollama',
            action: 'failed',
            version: null,
            message: 'Runtime installation aborted.',
            steps: [],
            log: ''
          }))
        }
        if (installOptions.signal?.aborted) abort()
        else installOptions.signal?.addEventListener('abort', abort, { once: true })
      })
    }
  }
  const services = createServices(options)
  const install = services.runtimesInstall('ollama')
  const started = await Promise.race([
    installerStarted.promise.then(() => 'started'),
    install.then((result) => `ended: ${result.action}: ${result.message}`)
  ])
  assert.equal(started, 'started')
  const closing = services.close()
  try {
    await Promise.resolve()
    assert.equal(installSignal?.aborted, true, 'shutdown must abort the runtime installer')
    await cleanupStarted.promise
    let closed = false
    void closing.then(() => { closed = true })
    await Promise.resolve()
    assert.equal(closed, false, 'shutdown must wait for installer cleanup')
  } finally {
    releaseCleanup.resolve()
  }

  const result = await install
  await closing
  assert.equal(result.ok, false)
  assert.equal(result.action, 'failed')
  assert.equal(installs, 1)
})

test('close reports an installer failure to observe process exit', { timeout: 3000 }, async () => {
  const installerStarted = deferred()
  const services = createServices({
    installRuntimeImpl: async ({ signal }: RuntimeInstallOptions): Promise<RuntimeInstallResult> => {
      installerStarted.resolve()
      return new Promise<RuntimeInstallResult>((_resolve, reject) => {
        signal?.addEventListener('abort', () => {
          reject(new Error('Installer did not exit after SIGKILL.'))
        }, { once: true })
      })
    }
  })
  const installOutcome = services.runtimesInstall('ollama').then(
    () => 'resolved',
    (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`
  )
  await installerStarted.promise

  await assert.rejects(() => services.close(), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.ok(error.errors.some((cause) => String(cause).includes('did not exit after SIGKILL')))
    return true
  })
  assert.match(await installOutcome, /rejected: Installer did not exit after SIGKILL/)
})

test('runtime installation is rejected before work after closing starts', async () => {
  let installs = 0
  const options = {
    runtimeFetchImpl: async (): Promise<RuntimeFetchResponse> => ({
      ok: false, status: 404, json: async () => ({}), text: async () => ''
    }),
    execFileImpl: (
      _file: string,
      _args: string[],
      _options: unknown,
      cb: (error: Error | null, stdout: string, stderr: string) => void
    ): void => cb(new Error('not found'), '', ''),
    installRuntimeImpl: async (): Promise<RuntimeInstallResult> => {
      installs++
      return { ok: false, id: 'ollama', action: 'unsupported', version: null, message: 'unused', steps: [], log: '' }
    }
  }
  const services = createServices(options)
  await services.close()

  await assert.rejects(() => services.runtimesInstall('ollama'), /shutting down/)
  assert.equal(installs, 0)
})

test('close unregisters remote tools and awaits bounded connection cleanup', { timeout: 3000 }, async () => {
  const closeStarted = deferred()
  const releaseClose = deferred()
  const removed: string[] = []
  const connection = fakeRemoteConnection({
    async close() {
      closeStarted.resolve()
      await releaseClose.promise
    }
  })
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async () => connection,
    onRemoteRemoved: (id) => removed.push(id),
    saveSettingsImpl: async () => {}
  })
  await services.init()
  await services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)
  assert.equal(services.remoteStatus()[0]?.connected, true)

  const closing = services.close()
  const outcome = await Promise.race([
    closeStarted.promise.then(() => 'started'),
    closing.then(() => 'completed')
  ])
  assert.equal(outcome, 'started')
  try {
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'shutdown must await remote close')
    assert.equal(services.remoteStatus()[0]?.connected, false)
    assert.deepEqual(services.remoteToolMetadata(), [])
  } finally {
    releaseClose.resolve()
  }

  await closing
  assert.deepEqual(removed, [SHUTDOWN_REMOTE_MODULE.id])
})

test('close cleans up a remote connection that resolves after shutdown starts', { timeout: 3000 }, async () => {
  const connectStarted = deferred()
  const pendingConnection = deferredValue<RemoteConnection>()
  let closeCalls = 0
  let publishedTools = 0
  const connection = fakeRemoteConnection({
    async close() { closeCalls++ }
  })
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async () => {
      connectStarted.resolve()
      return pendingConnection.promise
    },
    onRemoteTools: () => { publishedTools++ },
    saveSettingsImpl: async () => {}
  })
  await services.init()

  const install = services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)
  await connectStarted.promise
  const closing = services.close()
  pendingConnection.resolve(connection)

  await assert.rejects(() => install, /shutting down/)
  await closing
  assert.equal(closeCalls, 1)
  assert.equal(publishedTools, 0)
  assert.equal(services.remoteStatus()[0]?.connected, false)
  assert.equal(services.installedWidgets().includes(SHUTDOWN_REMOTE_MODULE.id), false)
})

test('close interrupts an admitted remote connect without waiting for its full deadline', { timeout: 3000 }, async () => {
  const connectStarted = deferred()
  let connectSignal: AbortSignal | undefined
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async (_endpoint, signal) => {
      connectSignal = signal
      connectStarted.resolve()
      return new Promise<RemoteConnection>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    remoteTimeouts: { connectMs: 60_000 },
    saveSettingsImpl: async () => {}
  })
  await services.init()

  const install = services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)
  const settledInstall = install.then(
    () => 'installed',
    (error: unknown) => `rejected: ${String(error)}`
  )
  await connectStarted.promise
  const closing = services.close()
  const outcome = await Promise.race([
    settledInstall,
    closing.then(() => 'closed')
  ])

  assert.match(outcome, /rejected: .*shutting down/)
  assert.equal(connectSignal?.aborted, true)
  await closing
})

test('close aborts remote tool listing and drains its cancellation cleanup', { timeout: 3000 }, async () => {
  const listStarted = deferred()
  const releaseListCleanup = deferred()
  let listSignal: AbortSignal | undefined
  let closeCalls = 0
  const connection = fakeRemoteConnection({
    async listTools(signal) {
      listSignal = signal
      listStarted.resolve()
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', async () => {
          await releaseListCleanup.promise
          reject(signal.reason)
        }, { once: true })
      })
    },
    async close() { closeCalls++ }
  })
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async () => connection,
    saveSettingsImpl: async () => {}
  })
  await services.init()

  const install = services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)
  const installOutcome = install.then(
    () => 'installed',
    (error: unknown) => `rejected: ${String(error)}`
  )
  await listStarted.promise
  const closing = services.close()
  try {
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(listSignal?.aborted, true)
    assert.equal(closeCalls, 1)
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'shutdown must await remote request cleanup')
  } finally {
    releaseListCleanup.resolve()
  }

  assert.match(await installOutcome, /rejected: .*shutting down/)
  await closing
})

test('remote call deadlines abort the request before reconnecting', { timeout: 3000 }, async () => {
  let callSignal: AbortSignal | undefined
  let closeCalls = 0
  let connections = 0
  let publishedTools: ProxiedTool[] = []
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteTimeouts: { callMs: 15, closeMs: 100 },
    remoteConnect: async () => {
      const connectionNumber = ++connections
      return fakeRemoteConnection({
        async listTools() { return [{ name: 'ping' }] },
        async callTool(_name, _args, signal) {
          if (connectionNumber > 1) return { content: [{ type: 'text', text: 'pong' }] }
          callSignal = signal
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          })
        },
        async close() { closeCalls++ }
      })
    },
    onRemoteTools: (_id, tools) => { publishedTools = tools },
    saveSettingsImpl: async () => {}
  })
  await services.init()
  await services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)

  await assert.rejects(() => publishedTools[0]!.call({}), /may have completed.*not retried/i)
  assert.equal(callSignal?.aborted, true)
  assert.ok(callSignal?.reason instanceof Error)
  assert.equal(closeCalls, 1)
  assert.equal(connections, 2)
  assert.deepEqual(await publishedTools[0]!.call({}), { content: [{ type: 'text', text: 'pong' }] })
})

test('remote tool calls cannot reconnect after shutdown starts', async () => {
  let connects = 0
  let publishedTools: ProxiedTool[] = []
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async () => {
      connects++
      return fakeRemoteConnection({ async listTools() { return [{ name: 'ping' }] } })
    },
    onRemoteTools: (_id, tools) => { publishedTools = tools },
    saveSettingsImpl: async () => {}
  })
  await services.init()
  await services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)
  assert.equal(publishedTools.length, 1)
  await services.close()

  await assert.rejects(() => publishedTools[0].call({}), /shutting down/)
  assert.equal(connects, 1)
})

test('remote close deadlines bound shutdown and report a stuck transport', { timeout: 1000 }, async () => {
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async () => fakeRemoteConnection({ close: () => new Promise<void>(() => {}) }),
    remoteTimeouts: { closeMs: 20 },
    saveSettingsImpl: async () => {}
  })
  await services.init()
  await services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)

  await assert.rejects(() => services.close(), /Remote Test close timed out after 20ms/)
  assert.equal(services.remoteStatus()[0]?.connected, false)
})

test('close bounds shutdown when a remote request ignores cancellation', { timeout: 1000 }, async () => {
  const listStarted = deferred()
  let listSignal: AbortSignal | undefined
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async () => fakeRemoteConnection({
      async listTools(signal) {
        listSignal = signal
        listStarted.resolve()
        return new Promise(() => {})
      },
      async close() {}
    }),
    remoteTimeouts: { closeMs: 20 },
    saveSettingsImpl: async () => {}
  })
  await services.init()

  const install = services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)
  void install.catch(() => {})
  await listStarted.promise
  const closing = services.close()
  const outcome = await Promise.race([
    closing.then(
      () => 'closed',
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250))
  ])

  assert.match(outcome, /rejected: .*transport cleanup timed out/i)
  assert.equal(listSignal?.aborted, true)
  await assert.rejects(() => install, /shutting down/)
})

test('close still cleans up a remote connection that resolves after its drain deadline', { timeout: 1000 }, async () => {
  const connectStarted = deferred()
  const pendingConnection = deferredValue<RemoteConnection>()
  let closeCalls = 0
  let publishedTools = 0
  const connection = fakeRemoteConnection({
    async listTools() { return [] },
    async close() { closeCalls++ }
  })
  const services = createServices({
    fetchImpl: shutdownRegistryFetch(),
    remoteConnect: async () => {
      connectStarted.resolve()
      return pendingConnection.promise
    },
    onRemoteTools: () => { publishedTools++ },
    remoteTimeouts: { closeMs: 20 },
    saveSettingsImpl: async () => {}
  })
  await services.init()

  const install = services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id)
  void install.catch(() => {})
  await connectStarted.promise
  const closing = services.close()
  const outcome = await Promise.race([
    closing.then(
      () => 'closed',
      (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 250))
  ])
  try {
    assert.match(outcome, /rejected: .*transport cleanup timed out/i)
  } finally {
    pendingConnection.resolve(connection)
  }

  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(closeCalls, 1, 'a late connection must still be closed after shutdown stops waiting')
  assert.equal(publishedTools, 0)
  await assert.rejects(() => install, /shutting down/)
})

test('init is shared and cannot start after closing', async (t) => {
  await useTemporaryHome(t)
  const services = createServices({ saveSettingsImpl: async () => {} })

  const first = services.init()
  const second = services.init()
  assert.equal(first, second)
  await first
  await services.close()
  await assert.rejects(() => services.init(), /shutting down/)
})

test('close drains initialization before allowing the process to exit', { timeout: 3000 }, async (t) => {
  const home = await useTemporaryHome(t)
  await mkdir(home, { recursive: true })
  await writeFile(join(home, 'settings.json'), JSON.stringify({
    gmail: { email: 'person@example.com', credentialRef: 'gmail/test' }
  }))
  const credentialReadStarted = deferred()
  const releaseCredentialRead = deferredValue<string | null>()
  const services = createServices({
    credentialStore: {
      async set() {},
      async get() {
        credentialReadStarted.resolve()
        return releaseCredentialRead.promise
      },
      async delete() {}
    },
    saveSettingsImpl: async () => {}
  })

  const initializing = services.init()
  await credentialReadStarted.promise
  const closing = services.close()
  try {
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'shutdown must await admitted initialization')
  } finally {
    releaseCredentialRead.resolve(null)
  }

  await Promise.all([initializing, closing])
  assert.equal(services.gmail.configured, false)
})

test('all public work is rejected before I/O once closing starts', async () => {
  let requests = 0
  const services = createServices({
    fetchImpl: (async () => {
      requests++
      return new Response('[]', { status: 200 })
    }) as never,
    runtimeFetchImpl: async (): Promise<RuntimeFetchResponse> => {
      requests++
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' }
    },
    execFileImpl: (_file, _args, _options, cb) => cb(new Error('not found'), '', ''),
    gmailInboxImpl: async () => ({ unread: 0, messages: [] }),
    saveSettingsImpl: async () => {}
  })
  await services.close()

  const work: Array<() => Promise<unknown>> = [
    () => services.cryptoRefresh(),
    () => services.cryptoSetWatchlist(['bitcoin']),
    () => services.gmailConnect({ email: 'person@example.com', password: 'abcdefghijklmnop' }),
    () => services.gmailDisconnect(),
    () => services.gmailCheck(),
    () => services.resourceStats(),
    () => services.resourceProcesses(),
    () => services.resourceSetSettings({ diskPath: 'R:\\models' }),
    () => services.modelFarmSetPrefs({ scenario: 'total' }),
    () => services.modelFarmSetNote({ repo: 'test/model', note: 'test' }),
    () => services.exportWidgets(),
    () => services.importWidgets({ format: 'toolbox-widgets', formatVersion: 1, widgets: [] }),
    () => services.llamafarmStatus(true),
    () => services.llamafarmCatalog(true),
    () => services.llamafarmSearch({ query: 'test' }),
    () => services.llamafarmQuants('test/model'),
    () => services.llamafarmRunNow(),
    () => services.llamafarmCancel({ repo: 'test/model' }),
    () => services.llamafarmRemove({ repo: 'test/model' }),
    () => services.llamafarmRefresh(),
    () => services.llamafarmGrade({ scenario: 'now' }),
    () => services.runtimesDetect(true),
    () => services.runtimesInstall('ollama'),
    () => services.runtimesUse('lmstudio'),
    () => services.runtimesModels('ollama'),
    () => services.runtimesDownload({ runtime: 'ollama', repo: 'test/model' }),
    () => services.gatewayStatus(true),
    () => services.gatewayRequests(),
    () => services.marketplaceList(),
    () => services.marketplaceInstall(SHUTDOWN_REMOTE_MODULE.id),
    () => services.marketplaceUninstall(SHUTDOWN_REMOTE_MODULE.id),
    () => services.marketplaceRefresh(),
    () => services.remoteRestore()
  ]
  const results = await Promise.allSettled(work.map((operation) => operation()))

  for (const result of results) {
    assert.equal(result.status, 'rejected')
    if (result.status === 'rejected') assert.match(String(result.reason), /shutting down/)
  }
  assert.equal(requests, 0)
})
