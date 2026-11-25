import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const DIST = join(import.meta.dirname, '..', 'dist')

function outputUrl(output: string): URL {
  const match = output.match(/http:\/\/127\.0\.0\.1:\d+/)
  assert.ok(match, `server did not report its panel address: ${output}`)
  return new URL(`${match[0]}/`)
}

async function waitForOutput(read: () => string, pattern: RegExp): Promise<string> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const output = read()
    if (pattern.test(output)) return output
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for ${pattern}. Output: ${read()}`)
}

function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode])
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Process ${child.pid} did not exit after shutdown`)), timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve([code, signal])
    })
  })
}

async function launch(
  t: TestContext,
  entry: 'index' | 'panel',
  options: { closedStdin?: boolean; signalOnReady?: NodeJS.Signals; settings?: string } = {}
): Promise<{ child: ChildProcess; home: string; output: () => string }> {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-process-'))
  if (options.settings !== undefined) {
    await writeFile(join(home, 'settings.json'), options.settings)
  }
  const args: string[] = []
  if (options.signalOnReady) {
    const hook = join(home, 'signal-on-ready.cjs')
    await writeFile(hook, `
      const emit = (...args) => {
        if (args.some((value) => String(value).includes('toolbox-mcp ready') || String(value).includes('Toolbox ops panel:'))) {
          queueMicrotask(() => process.emit(${JSON.stringify(options.signalOnReady)}))
        }
      }
      console.error = (...args) => { emit(...args); process.stderr.write(args.join(' ') + '\\n') }
      console.log = (...args) => { emit(...args); process.stdout.write(args.join(' ') + '\\n') }
    `)
    args.push('--require', hook)
  }
  args.push(join(DIST, `${entry}.js`))
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      TOOLBOX_MCP_HOME: home,
      TOOLBOX_MCP_PORT: '0'
    },
    stdio: [options.closedStdin ? 'ignore' : 'pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += chunk })
  child.stderr?.on('data', (chunk) => { stderr += chunk })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForExit(child, 2_000).catch(() => {})
    await rm(home, { recursive: true, force: true })
  })
  const output = () => stdout + stderr
  await waitForOutput(output, entry === 'index' ? /toolbox-mcp ready/ : /Toolbox ops panel:/)
  return { child, home, output }
}

async function assertPanelClosed(origin: URL): Promise<void> {
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(1_000) }))
}

test('MCP stdin EOF closes the server, services, and owned panel before natural exit', { timeout: 15_000 }, async (t) => {
  const { child, output } = await launch(t, 'index')
  const origin = outputUrl(output())
  const exiting = waitForExit(child)
  child.stdin?.end()
  const [code, signal] = await exiting
  assert.equal(code, 0)
  assert.equal(signal, null)
  await assertPanelClosed(origin)
})

test('MCP startup with an already-closed stdin exits naturally', { timeout: 15_000 }, async (t) => {
  const { child } = await launch(t, 'index', { closedStdin: true })
  const [code, signal] = await waitForExit(child)
  assert.equal(code, 0)
  assert.equal(signal, null)
})

test('MCP termination signal closes its ephemeral panel before exit', { timeout: 15_000 }, async (t) => {
  const { child, output } = await launch(t, 'index', { signalOnReady: 'SIGTERM' })
  const origin = outputUrl(output())
  const [code, signal] = await waitForExit(child)
  assert.equal(code, 143)
  assert.equal(signal, null)
  await assertPanelClosed(origin)
})

test('MCP interrupt signal closes its ephemeral panel before exit', { timeout: 15_000 }, async (t) => {
  const { child, output } = await launch(t, 'index', { signalOnReady: 'SIGINT' })
  const origin = outputUrl(output())
  const [code, signal] = await waitForExit(child)
  assert.equal(code, 130)
  assert.equal(signal, null)
  await assertPanelClosed(origin)
})

test('panel-only startup binds termination signals to services and listener cleanup', { timeout: 15_000 }, async (t) => {
  const { child, output } = await launch(t, 'panel', { signalOnReady: 'SIGTERM' })
  const origin = outputUrl(output())
  const [code, signal] = await waitForExit(child)
  assert.equal(code, 143)
  assert.equal(signal, null)
  await assertPanelClosed(origin)
})

for (const entry of ['index', 'panel'] as const) {
  test(`${entry} handles real POSIX SIGINT and SIGTERM delivery`, {
    skip: process.platform === 'win32' ? 'Windows terminates Node processes on SIGINT/SIGTERM without running JavaScript signal handlers.' : false,
    timeout: 30_000
  }, async (t) => {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      await t.test(`${entry} ${signal}`, async (t) => {
        const { child, output } = await launch(t, entry)
        const origin = outputUrl(output())
        const exiting = waitForExit(child)
        assert.equal(child.kill(signal), true)
        const [code, exitSignal] = await exiting
        assert.equal(code, signal === 'SIGINT' ? 130 : 143)
        assert.equal(exitSignal, null)
        await assertPanelClosed(origin)
      })
    }
  })
}

test('invalid settings fail startup with a nonzero status', { timeout: 15_000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-invalid-settings-'))
  await writeFile(join(home, 'settings.json'), '{not json')
  const child = spawn(process.execPath, [join(DIST, 'index.js')], {
    env: { ...process.env, TOOLBOX_MCP_HOME: home, TOOLBOX_MCP_PORT: '0' },
    stdio: 'ignore'
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await waitForExit(child, 2_000).catch(() => {})
    await rm(home, { recursive: true, force: true })
  })
  const [code] = await waitForExit(child)
  assert.notEqual(code, 0)
})
