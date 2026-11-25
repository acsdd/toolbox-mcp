/* Verify an installed Model Farm build the way an MCP client sees it.
 *
 * Usage:
 *   node scripts/verify-install.cjs ["C:\Users\you\AppData\Local\Programs\Model Farm"]
 *
 * The installed app ships its own Node runtime, so a client can talk to the
 * packaged MCP server without a separate Node install:
 *
 *   command: "<install>\Model Farm.exe"
 *   args:    ["<install>\resources\app.asar\dist\index.js"]
 *   env:     { ELECTRON_RUN_AS_NODE: "1" }
 *
 * This probe proves that journey end to end:
 *   - the packaged server answers an initialize / tools/list handshake
 *   - a read-only tool call succeeds
 *   - the ops panel the server starts answers on its own port
 *   - closing stdin lets the packaged server exit naturally with status 0
 *
 * It never touches the settings of the real profile: the server runs with a
 * throwaway TOOLBOX_MCP_HOME and a throwaway panel port.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { probeMcpStdio } = require('./stdio-probe.cjs')

const installDir = path.resolve(
  process.argv[2] ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Model Farm')
)
const exe = path.join(installDir, 'Model Farm.exe')
const asar = path.join(installDir, 'resources', 'app.asar')
// The server entry lives inside the asar, so plain Node cannot stat it; the
// app's own runtime reads the archive.
const entry = path.join(asar, 'dist', 'index.js')

/** Reserve a free loopback port so the probe never touches 3851. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function readPanelCatalog(origin, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/api/catalog`, { signal: AbortSignal.timeout(500) })
      if (response.status === 200) return response.json()
    } catch {
      // The MCP handshake and panel startup are separate asynchronous steps.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`Panel did not answer on ${origin} within ${timeoutMs}ms.`)
}

async function main() {
  assert.ok(fs.existsSync(exe), `missing ${exe}`)
  assert.ok(fs.existsSync(asar), `missing ${asar}`)

  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelfarm-install-'))

  try {
    const result = await probeMcpStdio({
      command: exe,
      args: [entry],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        TOOLBOX_MCP_PORT: String(port),
        TOOLBOX_MCP_HOME: path.join(home, 'settings')
      },
      inspect: async ({ tools, request }) => {
        assert.ok(tools.length >= 30, `expected the full tool surface, saw ${tools.length}`)

        const call = await request('tools/call', { name: 'runtimes_detect', arguments: {} })
        assert.notEqual(call.isError, true, `runtimes_detect failed: ${JSON.stringify(call.content)}`)

        const origin = `http://127.0.0.1:${port}`
        const catalog = await readPanelCatalog(origin)
        assert.equal(catalog.tools.length, tools.length, 'panel and MCP server disagree on the tool count')
        return catalog
      }
    })

    const catalog = result.inspection
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/catalog`, { signal: AbortSignal.timeout(1_000) }))

    console.log(`INSTALL_DIR=${installDir}`)
    console.log(`TOOL_COUNT=${result.catalog.tools.length}`)
    console.log(`PANEL_PORT=${port}`)
    console.log(`PANEL_TOOL_COUNT=${catalog.tools.length}`)
    console.log('READ_ONLY_CALL=ok')
    console.log('NATURAL_STDIN_EOF_EXIT=ok')
    console.log('MCP_CLIENT_JOURNEY=ok')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
