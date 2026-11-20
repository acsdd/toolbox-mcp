/* Acceptance journey for a *secondary* runtime: LM Studio.
 *
 * Usage:
 *   node scripts/verify-lmstudio-journey.mjs ["<install folder or unpacked portable app>"]
 *
 * Proves the whole file-based runtime path against the packaged build:
 *   select LM Studio -> search a tiny GGUF repo -> install into LM Studio's
 *   own models folder -> progress reaches done -> the file really exists.
 *
 * It downloads one ~55 MB GGUF straight from the Hub into the LM Studio models
 * folder, then deletes exactly that file and any folder it created, so the
 * machine is left as it was found. Settings live in a throwaway
 * TOOLBOX_MCP_HOME and the panel gets a throwaway port.
 */
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { existsSync, mkdtempSync, rmSync, rmdirSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import net from 'node:net'

const REPO = 'gradium/phonon-31m-en'

// Accepts a packaged app folder (installer or unpacked portable) or a plain
// checkout, so the same journey runs before and after packaging.
const installDir = process.argv[2] ?? join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Model Farm')
const packagedExe = join(installDir, 'Model Farm.exe')
const packaged = existsSync(packagedExe)
const command = packaged ? packagedExe : process.execPath
const entry = packaged
  ? join(installDir, 'resources', 'app.asar', 'dist', 'index.js')
  : join(installDir, 'dist', 'index.js')
// Plain Node cannot see inside app.asar, so only the checkout path is checked here.
if (!packaged && !existsSync(entry)) {
  throw new Error(`missing ${entry} — pass an install folder or a built checkout`)
}
console.log(`MODE=${packaged ? 'packaged' : 'checkout'}`)

const freePort = () =>
  new Promise((resolvePort, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })

const port = await freePort()
const home = mkdtempSync(join(tmpdir(), 'modelfarm-lmstudio-'))
const transport = new StdioClientTransport({
  command,
  args: [entry],
  env: {
    ...(packaged ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
    TOOLBOX_MCP_PORT: String(port),
    TOOLBOX_MCP_HOME: home
  }
})

const client = new Client({ name: 'lmstudio-journey', version: '1.0.0' })
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

/** Delete the repo folder the install created, then its now-empty parent, but never above the models folder. */
function cleanup(filePath, modelsDir) {
  const boundary = resolve(modelsDir)
  const target = resolve(filePath)
  const repoDir = resolve(target, '..')
  if (!existsSync(target)) return 'already gone'
  assert.ok(repoDir.startsWith(boundary + sep), `refusing to delete outside ${boundary}`)
  rmSync(repoDir, { recursive: true, force: true })
  const publisher = resolve(repoDir, '..')
  if (publisher !== boundary && publisher.startsWith(boundary + sep)) {
    try {
      // Windows can hold a just-deleted folder for a moment; retry briefly.
      rmdirSync(publisher, { maxRetries: 5, retryDelay: 100 })
    } catch {
      // Not empty — the publisher had other models before this run.
    }
  }
  return relative(boundary, target)
}

try {
  // Refuse to run if this repo already lives in the models folder: the install
  // would fail on the existing file and cleanup must never delete user data.
  const [owner, name] = REPO.split('/')
  const repoDir = join(homedir(), '.lmstudio', 'models', owner, name)
  assert.equal(existsSync(repoDir), false, `${repoDir} already exists; remove it or pick another repo first`)

  const before = await call('runtimes_detect', {})
  const lmstudio = (before.runtimes ?? []).find((runtime) => runtime.id === 'lmstudio')
  assert.ok(lmstudio?.installed, 'LM Studio is not installed on this machine')
  console.log(`LMSTUDIO_INSTALLED=${lmstudio.installed}`)
  console.log(`LMSTUDIO_RUNNING=${lmstudio.running}`)

  const selected = await call('runtimes_use', { id: 'lmstudio' })
  assert.equal(selected.active, 'lmstudio', 'could not select LM Studio')
  console.log('SELECT_LMSTUDIO=ok')

  const quants = await call('llamafarm_quants', { repo: REPO })
  const files = quants.quants ?? []
  console.log(`QUANT_FILES=${files.map((quant) => `${quant.filename}:${quant.quant}`).join(',')}`)
  const smallest = files.reduce((best, quant) => (best === null || (quant.sizeBytes ?? Infinity) < (best.sizeBytes ?? Infinity) ? quant : best), null)
  assert.ok(smallest, 'no GGUF quant reported for the test repo')
  console.log(`CHOSEN_QUANT=${smallest.quant ?? smallest.filename}`)

  const install = await call('llamafarm_install', {
    repo: REPO,
    ...(smallest.quant ? { quant: smallest.quant } : {}),
    runtime: 'lmstudio'
  })
  console.log(`INSTALL_OK=${install.ok === true}`)
  console.log(`INSTALL_RUNTIME=${install.runtime?.id}`)
  console.log(`INSTALL_MESSAGE=${install.message ?? ''}`)
  if (install.steps?.length) console.log(`INSTALL_STEPS=${install.steps.join(' | ')}`)
  assert.equal(install.ok, true, 'install into LM Studio failed')

  let download
  for (let attempt = 0; attempt < 150; attempt++) {
    const progress = await call('llamafarm_progress', {})
    download = (progress.downloads ?? []).find((item) => item.repo === REPO)
    if (download && download.status !== 'downloading') break
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  console.log(`DOWNLOAD_STATUS=${download?.status}`)
  assert.equal(download?.status, 'done', 'download did not finish')

  const filePath = install.file?.path
  assert.ok(filePath, 'install result carried no file path')
  assert.ok(existsSync(filePath), `expected ${filePath} to exist`)
  const bytes = statSync(filePath).size
  console.log(`DOWNLOADED_BYTES=${bytes}`)
  console.log(`FILE_UNDER_LMSTUDIO_MODELS=${resolve(filePath).startsWith(resolve(homedir(), '.lmstudio', 'models') + sep)}`)

  const removed = cleanup(filePath, join(homedir(), '.lmstudio', 'models'))
  console.log(`CLEANED_UP=${removed}`)

  await call('runtimes_use', { id: 'ollama' })
  console.log('RESTORED_OLLAMA=ok')
  console.log('SECONDARY_RUNTIME_JOURNEY=ok')
} finally {
  await client.close().catch(() => {})
  rmSync(home, { recursive: true, force: true })
}
