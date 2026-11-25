import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { createDesktopApp } = require('../scripts/desktop-main.cjs') as {
  createDesktopApp(options: Record<string, unknown>): Promise<unknown>
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

class FakeApp extends EventEmitter {
  name = ''
  modelId = ''
  userData = ''
  quitCalls = 0
  exitCalls: number[] = []
  ready = deferred()
  singleInstance = true

  setName(value: string) { this.name = value }
  setAppUserModelId(value: string) { this.modelId = value }
  getPath() { return 'unused-profile' }
  setPath(_name: string, value: string) { this.userData = value }
  requestSingleInstanceLock() { return this.singleInstance }
  whenReady() { return this.ready.promise }
  quit() {
    this.quitCalls += 1
    let prevented = false
    this.emit('before-quit', { preventDefault: () => { prevented = true } })
    return !prevented
  }
  exit(code: number) { this.exitCalls.push(code) }
}

class FakeWindow extends EventEmitter {
  static created = 0
  destroyed = false
  webContents = Object.assign(new EventEmitter(), {
    session: {
      setPermissionRequestHandler() {},
      setPermissionCheckHandler() {}
    },
    setWindowOpenHandler() {}
  })
  constructor() { super(); FakeWindow.created += 1 }
  isDestroyed() { return this.destroyed }
  isMinimized() { return false }
  restore() {}
  show() {}
  focus() {}
  async loadURL() {}
}

function harness(overrides: Record<string, unknown> = {}) {
  const app = new FakeApp()
  const dialogs: Array<[string, string]> = []
  const services = {
    init: async () => {},
    close: async () => {}
  }
  const panel = { port: 41234, close: async () => {} }
  const options = {
    app,
    BrowserWindow: FakeWindow,
    dialog: { showErrorBox: (title: string, message: string) => dialogs.push([title, message]) },
    shell: { openExternal: async () => {} },
    createServices: () => services,
    startPanel: async () => panel,
    ...overrides
  }
  return { app, dialogs, services, panel, options }
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for desktop lifecycle transition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('Electron before-quit waits for both services and panel before quitting', async () => {
  const serviceClose = deferred()
  const panelClose = deferred()
  let serviceCloses = 0
  let panelCloses = 0
  const { app, options } = harness({
    createServices: () => ({ init: async () => {}, close: () => { serviceCloses += 1; return serviceClose.promise } }),
    startPanel: async () => ({ port: 41234, close: () => { panelCloses += 1; return panelClose.promise } })
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await startup

  let prevented = false
  app.emit('before-quit', { preventDefault: () => { prevented = true } })
  assert.equal(prevented, true)
  assert.equal(app.quitCalls, 0)
  panelClose.resolve()
  await Promise.resolve()
  assert.equal(app.quitCalls, 0, 'quit must still wait for services')
  serviceClose.resolve()
  await waitFor(() => app.quitCalls === 1)
  assert.equal(serviceCloses, 1)
  assert.equal(panelCloses, 1)
})

for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
  test(`Electron ${signal} waits for cleanup and exits with ${exitCode}`, { timeout: 1000 }, async () => {
    const processEvents = Object.assign(new EventEmitter(), { exitCode: undefined as number | undefined })
    const cleanupStarted = deferred()
    const releaseCleanup = deferred()
    const { app, options } = harness({
      processEvents,
      createServices: () => ({
        init: async () => {},
        close: () => { cleanupStarted.resolve(); return releaseCleanup.promise }
      })
    })
    const startup = createDesktopApp(options)
    app.ready.resolve()
    await startup

    processEvents.emit(signal)
    await cleanupStarted.promise
    assert.deepEqual(app.exitCalls, [])
    assert.equal(processEvents.exitCode, exitCode)
    assert.equal(processEvents.listenerCount('SIGINT'), 0)
    assert.equal(processEvents.listenerCount('SIGTERM'), 0)

    releaseCleanup.resolve()
    await waitFor(() => app.exitCalls.length === 1)
    assert.deepEqual(app.exitCalls, [exitCode])
  })
}

test('Electron termination signals preserve an existing exit status', { timeout: 1000 }, async () => {
  const processEvents = Object.assign(new EventEmitter(), { exitCode: 7 as number | undefined })
  const { app, options } = harness({ processEvents })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await startup

  processEvents.emit('SIGTERM')
  await waitFor(() => app.exitCalls.length === 1)
  assert.deepEqual(app.exitCalls, [7])
  assert.equal(processEvents.exitCode, 7)
})

test('quit during service initialization closes it and never starts a panel', async () => {
  const initializing = deferred()
  const initStarted = deferred()
  let panelStarts = 0
  let serviceCloses = 0
  const { app, options } = harness({
    createServices: () => ({
      init: () => { initStarted.resolve(); return initializing.promise },
      close: async () => { serviceCloses += 1 }
    }),
    startPanel: async () => { panelStarts += 1; return { port: 1, close: async () => {} } }
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await initStarted.promise
  app.emit('before-quit', { preventDefault() {} })
  initializing.resolve()
  await startup
  await waitFor(() => app.quitCalls === 1)
  assert.equal(panelStarts, 0)
  assert.equal(serviceCloses, 1)
})

test('a panel resolving after quit begins is closed before Electron quits', async () => {
  const startingPanel = deferred<{ port: number; close: () => Promise<void> }>()
  const panelStarted = deferred()
  let panelCloses = 0
  let windows = 0
  const { app, options } = harness({
    BrowserWindow: class extends FakeWindow { constructor() { super(); windows += 1 } },
    startPanel: () => { panelStarted.resolve(); return startingPanel.promise }
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await panelStarted.promise
  app.emit('before-quit', { preventDefault() {} })
  startingPanel.resolve({ port: 41234, close: async () => { panelCloses += 1 } })
  await startup
  await waitFor(() => app.quitCalls === 1)
  assert.equal(panelCloses, 1)
  assert.equal(windows, 0)
})

test('quit while the window is loading does not report connection refusal as shutdown failure', async (t) => {
  t.mock.method(console, 'error', () => {})
  const loading = deferred<void>()
  const loadStarted = deferred()
  let windowShows = 0
  const { app, dialogs, options } = harness({
    BrowserWindow: class extends FakeWindow {
      loadURL() { loadStarted.resolve(); return loading.promise }
      show() { windowShows += 1 }
    }
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await loadStarted.promise
  app.emit('before-quit', { preventDefault() {} })
  loading.reject(new Error('ERR_CONNECTION_REFUSED'))
  await startup
  await waitFor(() => app.quitCalls === 1 || app.exitCalls.length === 1)

  assert.deepEqual(app.exitCalls, [])
  assert.equal(app.quitCalls, 1)
  assert.deepEqual(dialogs, [])
  assert.equal(windowShows, 0)
})

test('quit during window loading still reports genuine panel cleanup failures', async (t) => {
  t.mock.method(console, 'error', () => {})
  const loading = deferred<void>()
  const loadStarted = deferred()
  const { app, dialogs, options } = harness({
    BrowserWindow: class extends FakeWindow {
      loadURL() { loadStarted.resolve(); return loading.promise }
    },
    startPanel: async () => ({
      port: 41234,
      close: async () => { throw new Error('panel cleanup failed') }
    })
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await loadStarted.promise
  app.emit('before-quit', { preventDefault() {} })
  loading.reject(new Error('ERR_CONNECTION_REFUSED'))
  await startup
  await waitFor(() => app.exitCalls.length === 1)

  assert.deepEqual(app.exitCalls, [1])
  assert.equal(dialogs.length, 1)
  assert.match(dialogs[0][1], /panel cleanup failed/)
  assert.doesNotMatch(dialogs[0][1], /ERR_CONNECTION_REFUSED/)
})

test('quit during startup reports a late service cleanup failure', async (t) => {
  t.mock.method(console, 'error', () => {})
  const creatingServices = deferred<{ init: () => Promise<void>; close: () => Promise<void> }>()
  const createStarted = deferred()
  const { app, dialogs, options } = harness({
    createServices: () => {
      createStarted.resolve()
      return creatingServices.promise
    }
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await createStarted.promise
  app.emit('before-quit', { preventDefault() {} })
  creatingServices.resolve({
    init: async () => {},
    close: async () => { throw new Error('late service cleanup failed') }
  })
  await startup
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(app.exitCalls, [1])
  assert.equal(dialogs.length, 1)
  assert.match(dialogs[0][1], /late service cleanup failed/)
})

test('startup failure includes service cleanup errors in its failure report', async (t) => {
  t.mock.method(console, 'error', () => {})
  const { app, dialogs, options } = harness({
    createServices: () => ({
      init: async () => {},
      close: async () => { throw new Error('service cleanup failed') }
    }),
    startPanel: async () => { throw new Error('panel startup failed') }
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await startup
  await waitFor(() => app.exitCalls.length === 1)

  assert.deepEqual(app.exitCalls, [1])
  assert.equal(dialogs.length, 1)
  assert.match(dialogs[0][1], /panel startup failed/)
  assert.match(dialogs[0][1], /service cleanup failed/)
})

test('startup failure cleans up services before exiting with an error', async (t) => {
  t.mock.method(console, 'error', () => {})
  let serviceCloses = 0
  const { app, dialogs, options } = harness({
    createServices: () => ({
      init: async () => { throw new Error('settings unavailable') },
      close: async () => { serviceCloses += 1 }
    })
  })
  const startup = createDesktopApp(options)
  app.ready.resolve()
  await startup
  await waitFor(() => app.exitCalls.length === 1)
  assert.equal(serviceCloses, 1)
  assert.deepEqual(dialogs, [['Model Farm could not start', 'settings unavailable']])
})
