/* Single-window portable shell for the existing localhost panel. */
const { app, BrowserWindow, dialog, shell } = require('electron')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

app.setName('Model Farm')
app.setAppUserModelId('com.alpha.toolbox.modelfarm')

const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
const dataDir = portableDir ? join(portableDir, 'ModelFarm-data') : app.getPath('userData')
mkdirSync(join(dataDir, 'browser'), { recursive: true })
app.setPath('userData', join(dataDir, 'browser'))
process.env.TOOLBOX_MCP_HOME ??= join(dataDir, 'settings')

let panel
let window

function openExternal(url) {
  try {
    if (['https:', 'http:'].includes(new URL(url).protocol)) {
      void shell.openExternal(url).catch((error) => console.error(error.message))
    }
  } catch {
    // Ignore malformed links rather than handing them to the operating system.
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
  module.exports = Promise.resolve(null)
} else {
  app.on('second-instance', () => {
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', () => {
    panel?.close()
    panel = null
  })

  module.exports = app.whenReady().then(async () => {
    const { createServices } = await import(pathToFileURL(join(__dirname, '../dist/services.js')).href)
    const { startPanel } = await import(pathToFileURL(join(__dirname, '../dist/panel.js')).href)
    const services = createServices()
    await services.init()
    // Each portable instance owns its listener; existing CLI/MCP ports are untouched.
    panel = await startPanel(services, { port: 0 })
    const origin = `http://127.0.0.1:${panel.port}`
    window = new BrowserWindow({
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
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.setWindowOpenHandler(({ url }) => {
      openExternal(url)
      return { action: 'deny' }
    })
    window.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) {
        event.preventDefault()
        openExternal(url)
      }
    })
    window.webContents.on('will-redirect', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault()
    })
    window.on('page-title-updated', (event) => event.preventDefault())
    await window.loadURL(origin)
    window.show()
    return window
  }).catch((error) => {
    console.error(error)
    dialog.showErrorBox('Model Farm could not start', error.message)
    app.exit(1)
  })
}
