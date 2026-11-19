/* Verify the Terminal fix in the packaged app and capture the evidence.
 *
 * Usage:
 *   electron scripts/capture-terminal.cjs [app-directory-or-app.asar]
 *
 * The checks mirror the acceptance criteria of the terminal issue:
 *   - the output scrolls inside its own region and the page does not grow
 *   - the prompt stays visible at normal and narrow window sizes
 *   - switching away from the Terminal and back keeps the tail and the prompt
 *   - new output does not drag the view away from a reader scrolled up
 */
const assert = require('node:assert/strict')
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const appRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '..'))
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelfarm-terminal-'))
process.env.PORTABLE_EXECUTABLE_DIR = home
process.env.TOOLBOX_MCP_HOME = path.join(home, 'ModelFarm-data/settings')
fs.mkdirSync(process.env.TOOLBOX_MCP_HOME, { recursive: true })

const watchdog = setTimeout(() => {
  console.error('Terminal capture timed out')
  app.exit(1)
}, 90000)

/** Type a command the way a user does and wait for its output to land. */
async function runCommand(window, command, marker) {
  await window.webContents.executeJavaScript(`(() => {
    const input = document.getElementById('term-in')
    input.value = ${JSON.stringify(command)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  return window.webContents.executeJavaScript(`(async () => {
    const out = document.getElementById('term-out')
    for (let i = 0; i < 150; i += 1) {
      if (out.textContent.indexOf(${JSON.stringify(marker)}) >= 0) return true
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  })()`)
}

require(path.join(appRoot, 'scripts/desktop.cjs')).then(async (window) => {
  assert.ok(window)
  await window.webContents.executeJavaScript(`show('terminal'); true`)

  // The Terminal section starts its shell the first time it is opened.
  const state = await window.webContents.executeJavaScript(`(async () => {
    for (let i = 0; i < 150; i += 1) {
      const text = document.getElementById('term-state').textContent
      if (text.indexOf('running') === 0) return text
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return document.getElementById('term-state').textContent
  })()`)
  assert.match(state, /^running/, 'the terminal shell has to be running before the capture')

  assert.ok(await runCommand(window, '1..40 | ForEach-Object { "evidence line $_" }', 'evidence line 40'), 'the command has to produce output')

  const geometry = await window.webContents.executeJavaScript(`(() => {
    const out = document.getElementById('term-out')
    const prompt = document.getElementById('term-in').getBoundingClientRect()
    return {
      viewportHeight: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      outClientHeight: out.clientHeight,
      outScrollHeight: out.scrollHeight,
      outScrollTop: out.scrollTop,
      promptTop: Math.round(prompt.top),
      promptBottom: Math.round(prompt.bottom),
      promptVisible: prompt.bottom <= window.innerHeight && prompt.top >= 0
    }
  })()`)

  // The output scrolls inside the region; the page keeps its height.
  assert.ok(geometry.outScrollHeight > geometry.outClientHeight, 'the output has to overflow its own region')
  assert.ok(geometry.outScrollTop > 0, 'the region has to be scrolled to the tail')
  assert.ok(geometry.pageHeight <= geometry.viewportHeight, 'the page must not grow with the terminal output')
  assert.ok(geometry.promptVisible, 'the prompt has to stay visible')
  assert.ok(geometry.promptBottom <= geometry.viewportHeight, 'the prompt has to stay inside the window')

  // A narrow window keeps the prompt in view as well.
  window.setSize(1000, 680)
  await new Promise((resolve) => setTimeout(resolve, 800))
  const narrow = await window.webContents.executeJavaScript(`(() => {
    const out = document.getElementById('term-out')
    const prompt = document.getElementById('term-in').getBoundingClientRect()
    return {
      viewportHeight: window.innerHeight,
      pageHeight: document.documentElement.scrollHeight,
      outScrollHeight: out.scrollHeight,
      outClientHeight: out.clientHeight,
      promptBottom: Math.round(prompt.bottom),
      promptVisible: prompt.bottom <= window.innerHeight && prompt.top >= 0
    }
  })()`)
  assert.ok(narrow.promptVisible, 'the prompt has to stay visible in a narrow window')
  assert.ok(narrow.pageHeight <= narrow.viewportHeight, 'a narrow window must not grow the page either')
  assert.ok(narrow.outScrollHeight > narrow.outClientHeight, 'the output still scrolls inside the region')

  // Leaving the Terminal and coming back keeps the tail and the prompt.
  await window.webContents.executeJavaScript(`show('overview'); true`)
  await new Promise((resolve) => setTimeout(resolve, 400))
  await window.webContents.executeJavaScript(`show('terminal'); true`)
  await new Promise((resolve) => setTimeout(resolve, 600))
  const back = await window.webContents.executeJavaScript(`(() => {
    const out = document.getElementById('term-out')
    const prompt = document.getElementById('term-in').getBoundingClientRect()
    return {
      tailVisible: out.textContent.indexOf('evidence line 40') >= 0,
      outScrollTop: out.scrollTop,
      outScrollHeight: out.scrollHeight,
      promptVisible: prompt.bottom <= window.innerHeight && prompt.top >= 0
    }
  })()`)
  assert.ok(back.tailVisible, 'the output has to survive the switch')
  assert.ok(back.outScrollTop > 0, 'the region has to come back on the tail')
  assert.ok(back.promptVisible, 'the prompt has to be visible again')

  // A reader scrolled up keeps their position while new output arrives.
  await window.webContents.executeJavaScript(`(() => {
    document.getElementById('term-out').scrollTop = 0
    return true
  })()`)
  assert.ok(await runCommand(window, '1..20 | ForEach-Object { "late line $_" }', 'late line 20'), 'the second command has to produce output')
  await new Promise((resolve) => setTimeout(resolve, 500))
  const reading = await window.webContents.executeJavaScript(`(() => {
    const out = document.getElementById('term-out')
    const prompt = document.getElementById('term-in').getBoundingClientRect()
    return {
      outScrollTop: out.scrollTop,
      outScrollHeight: out.scrollHeight,
      promptVisible: prompt.bottom <= window.innerHeight && prompt.top >= 0
    }
  })()`)
  assert.ok(reading.outScrollTop === 0, 'the reading position must not be dragged to the tail')
  assert.ok(reading.outScrollHeight > geometry.outScrollHeight, 'the new output has to arrive')
  assert.ok(reading.promptVisible, 'the prompt has to stay visible while the reader reads')

  // Back to the tail for the screenshot.
  window.setSize(1440, 940)
  await new Promise((resolve) => setTimeout(resolve, 800))
  await window.webContents.executeJavaScript(`(() => {
    const out = document.getElementById('term-out')
    out.scrollTop = out.scrollHeight
    return true
  })()`)
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const docs = path.join(__dirname, '..', 'docs')
  fs.mkdirSync(docs, { recursive: true })
  const screenshot = path.join(docs, 'panel-terminal.png')
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG())
  console.log(JSON.stringify({ ok: true, screenshot, ...geometry, narrow, back, reading }))
  clearTimeout(watchdog)
  app.exit(0)
}).catch((error) => {
  clearTimeout(watchdog)
  console.error(error)
  app.exit(1)
})
