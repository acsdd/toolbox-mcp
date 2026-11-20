/* Acceptance journey against the *installed* Model Farm app:
 * search -> quant list -> install -> progress -> installed -> remove -> gone.
 * The installed app doubles as the MCP stdio server, so this drives exactly the
 * tool surface an MCP client sees.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import fs from 'node:fs'

const installDir = process.argv[2] ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Model Farm')
const exe = join(installDir, 'Model Farm.exe')
const entry = join(installDir, 'resources', 'app.asar', 'dist', 'index.js')
const home = fs.mkdtempSync(join(tmpdir(), 'modelfarm-mcp-journey-'))

/** Reserve a free loopback port so the probe never touches the live panel. */
const freePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

const port = await freePort()

const transport = new StdioClientTransport({
  command: exe,
  args: [entry],
  env: { ELECTRON_RUN_AS_NODE: '1', TOOLBOX_MCP_PORT: String(port), TOOLBOX_MCP_HOME: home }
})
const client = new Client({ name: 'modelfarm-acceptance', version: '1.0.0' })
await client.connect(transport)

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content ?? []).map((part) => part.text ?? '').join('\n')
  try {
    return JSON.parse(text)
  } catch {
    return { raw: text, isError: result.isError === true }
  }
}

const show = (label, value) => {
  const trimmed = JSON.stringify(value)
  console.log(`${label}=${trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed}`)
}

// The journey removes the model when it is done. Refuse to start if this repo
// is already installed, so a probe can never delete a model the user pulled.
const before = await call('llamafarm_status', {})
const existing = (before.ollama?.models ?? [])
  .map((model) => model.name)
  .filter((name) => name.includes('phonon-31m-en'))
if (existing.length > 0) {
  console.error(`already installed: ${existing.join(', ')} — remove it or pick another repo first`)
  await transport.close()
  fs.rmSync(home, { recursive: true, force: true })
  process.exit(1)
}

const search = await call('llamafarm_search', { query: 'phonon-31m-en', scenario: 'now' })
const hit = (search.groups ?? []).flatMap((group) => group.models ?? []).find((model) => model.id === 'gradium/phonon-31m-en')
console.log(`SEARCH_FOUND=${Boolean(hit)}`)
show('SEARCH_QUANT', hit?.quantLabel)

const quants = await call('llamafarm_quants', { repo: 'gradium/phonon-31m-en' })
console.log(`QUANT_FILES=${(quants.quants ?? []).map((q) => `${q.filename}:${q.quant}`).join(',')}`)

const install = await call('llamafarm_install', { repo: 'gradium/phonon-31m-en', quant: 'Q8', runtime: 'ollama' })
console.log(`INSTALL_OK=${install.ok === true}`)
show('INSTALL_REFERENCE', install.reference)
show('INSTALL_MESSAGE', install.message)
show('INSTALL_STEPS', install.steps)
show('INSTALL_ASTRLINK', install.astrlink)

const progress = await call('llamafarm_progress', {})
show('PROGRESS', (progress.downloads ?? []).map((entry) => `${entry.repo}:${entry.status}`))

const status = await call('llamafarm_status', {})
const installed = (status.ollama?.models ?? []).map((model) => model.name)
console.log(`RUNTIME_HAS_MODEL=${installed.some((name) => name.includes('phonon-31m-en'))}`)
show('RUNTIME_MODELS', installed)

const removal = await call('llamafarm_remove', { repo: 'gradium/phonon-31m-en', runtime: 'ollama' })
console.log(`REMOVE_OK=${removal.ok === true}`)
show('REMOVE_MESSAGE', removal.message)

const after = await call('llamafarm_status', {})
const remaining = (after.ollama?.models ?? []).map((model) => model.name)
console.log(`RUNTIME_CLEANED=${!remaining.some((name) => name.includes('phonon-31m-en'))}`)

const missing = await call('llamafarm_install', { repo: 'acme/definitely-not-a-model', runtime: 'ollama' })
console.log(`MISSING_OK=${missing.ok === true}`)
show('MISSING_REASON', missing.reason)
show('MISSING_MESSAGE', missing.message)

await transport.close()
fs.rmSync(home, { recursive: true, force: true })
