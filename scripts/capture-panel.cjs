/* Verify where the navigation sits in the app and capture the evidence.
 *
 * Usage:
 *   electron scripts/capture-panel.cjs [app-directory-or-app.asar]
 *
 * The nav is the app's primary menu — Overview, Model Farm, Terminal,
 * Marketplace, Gateway, Settings — so it has to sit in the first column,
 * on the left of the stage, with the active item's accent on the inner
 * edge. A narrow window hides the rail and gives the stage the full width.
 *
 * The capture overwrites docs/panel-overview.png so the screenshot in the
 * readme shows the layout the build actually ships.
 */
const assert = require('node:assert/strict')
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const appRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '..'))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelfarm-panel-'))
process.env.PORTABLE_EXECUTABLE_DIR = home
process.env.TOOLBOX_MCP_HOME = path.join(home, 'ModelFarm-data/settings')
fs.mkdirSync(process.env.TOOLBOX_MCP_HOME, { recursive: true })

const watchdog = setTimeout(() => {
  console.error('Panel capture timed out')
  app.exit(1)
}, 90000)

/** Where the rail and the stage sit, and how the active item is marked. */
const readLayout = (window) =>
  window.webContents.executeJavaScript(`(() => {
    const rail = document.querySelector('.sidebar')
    const stage = document.querySelector('main')
    const active = document.querySelector('.navbtn.active')
    const railBox = rail.getBoundingClientRect()
    const stageBox = stage.getBoundingClientRect()
    return {
      innerWidth: window.innerWidth,
      railVisible: getComputedStyle(rail).display !== 'none',
      railLeft: Math.round(railBox.left),
      railRight: Math.round(railBox.right),
      railWidth: Math.round(railBox.width),
      stageLeft: Math.round(stageBox.left),
      stageRight: Math.round(stageBox.right),
      activeShadow: getComputedStyle(active).boxShadow
    }
  })()`)

require(path.join(appRoot, 'scripts/desktop.cjs')).then(async (window) => {
  assert.ok(window)
  window.setSize(1440, 940)
  await new Promise((resolve) => setTimeout(resolve, 1200))

  const layout = await readLayout(window)
  assert.equal(layout.railVisible, true, 'the nav rail has to be visible in a wide window')
  assert.ok(
    layout.railRight <= layout.stageLeft,
    `the nav rail has to sit left of the stage (rail ${layout.railRight}, stage ${layout.stageLeft})`
  )
  assert.ok(layout.railWidth > 150 && layout.railWidth < 320, `unexpected rail width ${layout.railWidth}`)
  assert.match(layout.activeShadow, /inset/, 'the active nav item carries an inner accent')
  assert.match(layout.activeShadow, /2px 0px/, 'the accent sits on the rail’s inner (left) edge')

  // A narrow window drops the rail and gives the stage the full width.
  window.setSize(820, 700)
  await new Promise((resolve) => setTimeout(resolve, 900))
  const narrow = await readLayout(window)
  assert.equal(narrow.railVisible, false, 'the rail is hidden in a narrow window')
  assert.equal(narrow.stageLeft, 0, 'the stage takes the full width when the rail is hidden')
  assert.ok(narrow.stageRight >= narrow.innerWidth - 1, 'the stage fills the window')

  // Back to the wide layout for the screenshot.
  window.setSize(1440, 940)
  await new Promise((resolve) => setTimeout(resolve, 900))
  await window.webContents.executeJavaScript(
    'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
  )
  const docs = path.join(__dirname, '..', 'docs')
  fs.mkdirSync(docs, { recursive: true })
  const screenshot = path.join(docs, 'panel-overview.png')
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG())
  console.log(JSON.stringify({ ok: true, screenshot, ...layout, narrow }))
  clearTimeout(watchdog)
  app.exit(0)
}).catch((error) => {
  clearTimeout(watchdog)
  console.error(error)
  app.exit(1)
})
