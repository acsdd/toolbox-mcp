/* Run with Electron; pass an unpacked app directory or resources/app.asar. */
const assert = require('node:assert/strict')
const { app } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const appRoot = path.resolve(process.argv[2] ?? path.join(__dirname, '..'))
// The packaged manifest carries the released version; it also feeds the
// version the MCP server reports.
const expectedVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')).version
const packagedVersion = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')).version
assert.equal(packagedVersion, expectedVersion)
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelfarm-smoke-'))
process.env.PORTABLE_EXECUTABLE_DIR = home
process.env.TOOLBOX_MCP_HOME = path.join(home, 'ModelFarm-data/settings')
fs.mkdirSync(process.env.TOOLBOX_MCP_HOME, { recursive: true })
const model = {
  id: 'test/portable-3b', task: 'text-generation', label: 'Portable smoke model', author: 'test',
  formats: ['gguf'], paramsBillions: 3, quantLabel: 'Q4_K_M', fileBytes: 2 ** 31,
  runtimeRamBytes: Math.round(2 ** 31 * 1.25), downloads: 0, likes: 0, license: null,
  tags: [], hfUrl: 'https://huggingface.co/test/portable-3b'
}
fs.writeFileSync(path.join(process.env.TOOLBOX_MCP_HOME, 'llamafarm-cache.json'), JSON.stringify({
  models: [model], fetchedAt: Date.now()
}))
const watchdog = setTimeout(() => {
  console.error('Portable smoke timed out')
  app.exit(1)
}, 45000)

require(path.join(appRoot, 'scripts/desktop.cjs')).then(async (window) => {
  assert.ok(window)
  const preferences = window.webContents.getLastWebPreferences()
  assert.equal(preferences.nodeIntegration, false)
  assert.equal(preferences.contextIsolation, true)
  assert.equal(preferences.sandbox, true)
  assert.ok(app.getPath('userData').startsWith(home))
  const origin = new URL(window.webContents.getURL()).origin
  assert.equal(new URL(origin).hostname, '127.0.0.1')
  assert.ok(Number(new URL(origin).port) > 0)
  const response = await fetch(`${origin}/api/llamafarm/score`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scenario: 'now' })
  })
  assert.equal(response.status, 200)
  // The panel only answers this machine: a foreign origin is refused.
  const foreign = await fetch(`${origin}/api/overview`, { headers: { Origin: 'https://evil.example.com' } })
  assert.equal(foreign.status, 403)
  const settings = await fetch(`${origin}/api/settings`).then((r) => r.json())
  assert.ok(Array.isArray(settings.watchlist))
  assert.equal(typeof settings.showProcesses, 'boolean')
  const result = await response.json()
  assert.equal(result.groups[0].models[0].grade.axes.length, 4)
  const rendered = await window.webContents.executeJavaScript(`
    lastResult = ${JSON.stringify(result)};
    mf.expanded['test/portable-3b'] = true;
    renderMachine(lastResult.machine, lastResult.machineGrade);
    renderGroups(lastResult);
    show('models');
    ({ rows: document.querySelectorAll('.scorecard tbody tr').length,
       header: document.querySelector('.scorecard thead').textContent,
       nodeVisible: typeof require !== 'undefined',
       modelsVisible: !document.getElementById('sec-models').classList.contains('hidden'),
       overviewHidden: document.getElementById('sec-overview').classList.contains('hidden') });
  `)
  assert.equal(rendered.rows, 4)
  assert.match(rendered.header, /HEADROOM/)
  assert.equal(rendered.nodeVisible, false)
  assert.equal(rendered.modelsVisible, true)
  assert.equal(rendered.overviewHidden, true)
  const settingsView = await window.webContents.executeJavaScript(`
    show('settings');
    ({ settingsVisible: !document.getElementById('sec-settings').classList.contains('hidden'),
       modelsHidden: document.getElementById('sec-models').classList.contains('hidden'),
       watchlistField: typeof document.getElementById('set-watchlist') === 'object' });
  `)
  assert.equal(settingsView.settingsVisible, true)
  assert.equal(settingsView.modelsHidden, true)
  assert.equal(settingsView.watchlistField, true)
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const screenshot = path.join(home, 'portable-smoke.png')
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG())
  console.log(JSON.stringify({ ok: true, port: new URL(origin).port, scorecardRows: rendered.rows, sandbox: true, screenshot }))
  clearTimeout(watchdog)
  // Closing the last window must close the owned HTTP listener too.
  app.once('before-quit', (event) => {
    event.preventDefault()
    setImmediate(async () => {
      try {
        await fetch(origin, { signal: AbortSignal.timeout(1000) })
        console.error('Panel remained open after closing the window')
        app.exit(1)
      } catch {
        app.exit(0)
      }
    })
  })
  window.close()
}).catch((error) => {
  clearTimeout(watchdog)
  console.error(error)
  app.exit(1)
})
