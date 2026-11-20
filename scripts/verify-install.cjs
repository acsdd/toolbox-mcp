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
 *
 * It never touches the settings of the real profile: the server runs with a
 * throwaway TOOLBOX_MCP_HOME and a throwaway panel port.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')

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

async function main() {
  assert.ok(fs.existsSync(exe), `missing ${exe}`)
  assert.ok(fs.existsSync(asar), `missing ${asar}`)

  const port = await freePort()
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'modelfarm-install-'))

  const transport = new StdioClientTransport({
    command: exe,
    args: [entry],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      TOOLBOX_MCP_PORT: String(port),
      TOOLBOX_MCP_HOME: path.join(home, 'settings')
    }
  })
  const client = new Client({ name: 'modelfarm-install-probe', version: '1.0.0' })

  let childPid = null
  try {
    await client.connect(transport)
    // Read the pid while the transport is open; closing it clears the handle.
    childPid = transport.pid
    const { tools } = await client.listTools()
    assert.ok(tools.length >= 30, `expected the full tool surface, saw ${tools.length}`)

    const call = await client.callTool({ name: 'runtimes_detect', arguments: {} })
    assert.notEqual(call.isError, true, `runtimes_detect failed: ${JSON.stringify(call.content)}`)

    const panel = await fetch(`http://127.0.0.1:${port}/api/catalog`)
    assert.equal(panel.status, 200, `panel answered ${panel.status}`)
    const catalog = await panel.json()
    assert.equal(catalog.tools.length, tools.length, 'panel and MCP server disagree on the tool count')

    console.log(`INSTALL_DIR=${installDir}`)
    console.log(`TOOL_COUNT=${tools.length}`)
    console.log(`PANEL_PORT=${port}`)
    console.log(`PANEL_TOOL_COUNT=${catalog.tools.length}`)
    console.log('READ_ONLY_CALL=ok')
    console.log('MCP_CLIENT_JOURNEY=ok')
  } finally {
    await client.close().catch(() => {})
    // Windows keeps the Electron-as-Node child alive after stdin closes, so a
    // finished probe would otherwise leave an MCP server and its panel behind.
    if (childPid) {
      try { process.kill(childPid) } catch { /* already gone */ }
    }
    fs.rmSync(home, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
