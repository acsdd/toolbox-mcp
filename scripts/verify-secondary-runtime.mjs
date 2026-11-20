/* End-to-end acceptance test for secondary runtimes and selection safety:
 * verifies multi-runtime discovery (Ollama, LM Studio, etc.), switching active
 * runtime, rejecting non-existent runtimes, refusing non-Ollama model removal,
 * and restoring the default runtime.
 */
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import fs from 'node:fs'

const installDir = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Model Farm')
const exe = join(installDir, 'Model Farm.exe')
const entry = join(installDir, 'resources', 'app.asar', 'dist', 'index.js')
const home = join(tmpdir(), 'modelfarm-secondary-probe')

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

const client = new Client({ name: 'secondary-runtime-acceptance', version: '1.0.0' })
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

try {
  // 1. Detect runtimes
  const detected = await call('runtimes_detect', {})
  assert.ok(detected.runtimes?.length >= 5, 'expected at least 5 registered runtimes')
  const hasLmStudio = (detected.runtimes ?? []).some((r) => r.id === 'lmstudio' && r.installed)
  console.log(`DETECTED_RUNTIMES=${detected.runtimes.length}`)
  console.log(`LMSTUDIO_INSTALLED=${hasLmStudio}`)

  // 2. Select LM Studio as active runtime
  const useLm = await call('runtimes_use', { id: 'lmstudio' })
  assert.equal(useLm.active, 'lmstudio', 'expected active runtime to be lmstudio')
  console.log('USE_LMSTUDIO=ok')

  // 3. Confirm active runtime persisted in status
  const statusLm = await call('runtimes_detect', {})
  assert.equal(statusLm.active, 'lmstudio', 'expected status to report lmstudio active')

  // 4. Test refusal of invalid/unknown runtime
  const useInvalid = await call('runtimes_use', { id: 'nonexistent-runtime-99' })
  assert.ok(
    useInvalid.isError === true || useInvalid.raw?.includes('unknown') || useInvalid.error != null,
    'expected unknown runtime to be rejected'
  )
  console.log('REJECT_UNKNOWN_RUNTIME=ok')

  // 5. Test Ollama model removal safety (cannot remove non-Ollama models)
  const removeNonOllama = await call('llamafarm_remove', { repo: 'gradium/phonon-31m-en', runtime: 'lmstudio' })
  assert.equal(removeNonOllama.ok, false, 'expected non-Ollama removal to be refused')
  console.log('NON_OLLAMA_REMOVAL_GUARD=ok')

  // 6. Restore Ollama as active runtime
  const useOllama = await call('runtimes_use', { id: 'ollama' })
  assert.ok(useOllama.active === 'ollama' || useOllama.active === null, 'expected active runtime restored to ollama')
  console.log('RESTORE_DEFAULT_RUNTIME=ok')

  console.log('SECONDARY_RUNTIME_ACCEPTANCE=ok')
} finally {
  await transport.close().catch(() => {})
  fs.rmSync(home, { recursive: true, force: true })
}
