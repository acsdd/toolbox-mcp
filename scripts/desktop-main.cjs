/* Single-window shell orchestration, kept independent of Electron for tests. */
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

function createDesktopApp(options) {
  const { app, BrowserWindow, dialog, shell } = options
  const dirname = options.dirname ?? __dirname
  app.setName('Model Farm')
  app.setAppUserModelId('com.alpha.toolbox.modelfarm')

  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
  const dataDir = portableDir ? join(portableDir, 'ModelFarm-data') : app.getPath('userData')
  mkdirSync(join(dataDir, 'browser'), { recursive: true })
  app.setPath('userData', join(dataDir, 'browser'))
  process.env.TOOLBOX_MCP_HOME ??= join(dataDir, 'settings')
  const processEvents = options.processEvents ?? process
  const signalListeners = []

  let services = null
  let panel = null
  let window = null
  let closing = false
  let quitting = false
  let closePromise = null
  let startup = null
  let startupFailure = null
  let startupCleanupErrors = []

  function errorMessage(cause) {
    return cause instanceof Error ? cause.message : String(cause)
  }

  function openExternal(url) {
    try {
      if (['https:', 'http:'].includes(new URL(url).protocol)) {
        void shell.openExternal(url).catch((error) => console.error(error.message))
      }
    } catch {
      // Ignore malformed links rather than handing them to the operating system.
    }
  }

  function closeCurrent() {
    const owned = [services, panel].filter(Boolean)
    services = null
    panel = null
    return Promise.allSettled(owned.map((resource) => Promise.resolve().then(() => resource.close())))
      .then((results) => results
        .filter((result) => result.status === 'rejected')
        .map((result) => result.reason))
  }

  function stopSignalWatching() {
    for (const [signal, listener] of signalListeners) processEvents.removeListener(signal, listener)
    signalListeners.length = 0
  }

  function closeAll() {
    if (closePromise) return closePromise
    closing = true
    stopSignalWatching()
    const pendingStartup = startup
    closePromise = (async () => {
      const errors = await closeCurrent()
      // Startup owns resources it acquires after the first snapshot. It checks
      // `closing` after every await and closes those resources before settling.
      if (pendingStartup) await pendingStartup.catch(() => {})
      if (startupFailure !== null) errors.push(startupFailure, ...startupCleanupErrors)
      errors.push(...await closeCurrent())
      if (errors.length) {
        const detail = errors.map(errorMessage).join('; ')
        throw new AggregateError(errors, `Model Farm could not shut down cleanly. ${detail}`)
      }
    })()
    return closePromise
  }

  function requestQuit(exitCode) {
    if (quitting) return
    quitting = true
    void closeAll().then(() => {
      if (exitCode === undefined) app.quit()
      else app.exit(exitCode)
    }).catch((error) => {
      console.error(error)
      dialog.showErrorBox('Model Farm could not shut down', error.message)
      app.exit(exitCode ?? 1)
    })
  }

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return Promise.resolve(null)
  }

  for (const [signal, defaultExitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
    const onSignal = () => {
      if (processEvents.exitCode == null) processEvents.exitCode = defaultExitCode
      const existing = processEvents.exitCode
      const exitCode = typeof existing === 'number'
        ? existing
        : typeof existing === 'string' && /^\d+$/.test(existing)
          ? Number(existing)
          : defaultExitCode
      requestQuit(exitCode)
    }
    processEvents.once(signal, onSignal)
    signalListeners.push([signal, onSignal])
  }

  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  app.on('window-all-closed', () => {
    if (!quitting) app.quit()
  })
  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    requestQuit()
  })

  const createServices = options.createServices ?? (async () => {
    const { createServices: factory } = await import(pathToFileURL(join(dirname, '../dist/services.js')).href)
    return factory()
  })
  const startPanel = options.startPanel ?? (async (ownedServices) => {
    const { startPanel: factory } = await import(pathToFileURL(join(dirname, '../dist/panel.js')).href)
    return factory(ownedServices, { port: 0 })
  })

  startup = app.whenReady().then(async () => {
    if (closing) return null
    const ownedServices = await createServices()
    if (closing) {
      await ownedServices.close()
      return null
    }
    services = ownedServices
    await services.init()
    if (closing) return null

    // Each portable instance owns its listener; existing CLI/MCP ports are untouched.
    const ownedPanel = await startPanel(services)
    if (closing) {
      await ownedPanel.close()
      return null
    }
    panel = ownedPanel
    const origin = `http://127.0.0.1:${panel.port}`
    const ownedWindow = new BrowserWindow({
      width: 1440,
      height: 940,
      minWidth: 1000,
      minHeight: 680,
      show: false,
      autoHideMenuBar: true,
      backgroundColor: '#0a130e',
      title: 'Model Farm',
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true }
    })
    window = ownedWindow
    ownedWindow.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ownedWindow.webContents.session.setPermissionCheckHandler(() => false)
    ownedWindow.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    ownedWindow.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) {
        event.preventDefault()
        openExternal(url)
      }
    })
    ownedWindow.webContents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault()
    })
    ownedWindow.on('page-title-updated', (event) => event.preventDefault())
    try {
      await ownedWindow.loadURL(origin)
    } catch (error) {
      // Closing the loopback panel can make an in-flight page load reject.
      // That is expected during quit, not a startup failure.
      if (closing) return null
      throw error
    }
    if (closing) return null
    ownedWindow.show()
    return ownedWindow
  }).catch(async (error) => {
    startupFailure = error
    startupCleanupErrors = await closeCurrent()
    if (closing) return null
    stopSignalWatching()
    const failures = [error, ...startupCleanupErrors]
    for (const failure of failures) console.error(failure)
    dialog.showErrorBox('Model Farm could not start', failures.map(errorMessage).join('\n\n'))
    app.exit(1)
    return null
  })

  return startup
}

module.exports = { createDesktopApp }
