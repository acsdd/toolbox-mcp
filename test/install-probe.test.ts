import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)
const { probeMcpStdio } = require('../scripts/stdio-probe.cjs') as {
  probeMcpStdio: (options: {
    command: string
    args: string[]
    env: NodeJS.ProcessEnv
    timeoutMs?: number
    spawnImpl?: typeof import('node:child_process').spawn
    inspect: (session: {
      tools: Array<{ name: string }>
      request: (method: string, params?: Record<string, unknown>) => Promise<any>
    }) => Promise<unknown>
  }) => Promise<{ code: number | null; signal: NodeJS.Signals | null; inspection: unknown }>
}

async function fakeServer(t: { after: (cleanup: () => Promise<void>) => void }, source: string) {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-probe-'))
  const script = join(home, 'server.cjs')
  const eofFile = join(home, 'stdin-eof.txt')
  await writeFile(script, source)
  t.after(() => rm(home, { recursive: true, force: true }))
  return {
    command: process.execPath,
    args: [script],
    env: { ...process.env, PROBE_EOF_FILE: eofFile },
    eofFile
  }
}

test('install probe completes a tool call and lets the child exit naturally on EOF', { timeout: 10_000 }, async (t) => {
  const server = await fakeServer(t as Parameters<typeof fakeServer>[0], `
    const fs = require('node:fs')
    const readline = require('node:readline')
    const lines = readline.createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id === undefined) return
      let result
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'runtimes_detect', inputSchema: { type: 'object', properties: {} } }] }
      } else if (message.method === 'tools/call' && message.params.name === 'runtimes_detect') {
        result = { content: [{ type: 'text', text: '{"ok":true}' }], isError: false }
      } else {
        process.exit(2)
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
    })
    process.stdin.on('end', () => {
      fs.writeFileSync(process.env.PROBE_EOF_FILE, 'natural')
      process.exit(0)
    })
  `)

  const result = await probeMcpStdio({
    ...server,
    inspect: async ({ tools, request }) => {
      assert.deepEqual(tools.map((tool) => tool.name), ['runtimes_detect'])
      return request('tools/call', { name: 'runtimes_detect', arguments: {} })
    }
  })

  assert.deepEqual(result.inspection, {
    content: [{ type: 'text', text: '{"ok":true}' }],
    isError: false
  })
  assert.equal(result.code, 0)
  assert.equal(result.signal, null)
  assert.equal(await readFile(server.eofFile, 'utf8'), 'natural')
})

test('install probe rejects malformed stdout even when no request is pending', { timeout: 10_000 }, async (t) => {
  const server = await fakeServer(t as Parameters<typeof fakeServer>[0], `
    const readline = require('node:readline')
    const lines = readline.createInterface({ input: process.stdin })
    lines.on('line', (line) => {
      const message = JSON.parse(line)
      if (message.id === undefined) return
      let result
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } }
      } else if (message.method === 'tools/list') {
        result = { tools: [{ name: 'runtimes_detect', inputSchema: { type: 'object', properties: {} } }] }
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
        setImmediate(() => process.stdout.write('not-json\\n'))
        return
      } else {
        process.exit(2)
      }
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n')
    })
    process.stdin.on('end', () => process.exit(0))
  `)

  await assert.rejects(
    probeMcpStdio({
      ...server,
      inspect: async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
    }),
    /invalid JSON/i
  )
})

function fakeStdioChild() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const writes: Array<{ id?: number; method?: string }> = []
  const initialization = {
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'fake', version: '1.0.0' }
  }
  const child = Object.assign(new EventEmitter(), {
    stdin,
    stdout,
    stderr,
    exitCode: null,
    signalCode: null,
    kill() {
      queueMicrotask(() => child.emit('close', 0, null))
      return true
    }
  }) as unknown as ReturnType<typeof import('node:child_process').spawn>
  stdin.on('data', (chunk: Buffer) => {
    const message = JSON.parse(chunk.toString()) as { id?: number; method?: string }
    writes.push(message)
    if (message.id === undefined) return
    const result = message.method === 'initialize'
      ? initialization
      : message.method === 'tools/list'
        ? { tools: [{ name: 'runtimes_detect', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [], isError: false }
    queueMicrotask(() => stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`))
  })
  return {
    child,
    stdout,
    writes,
    initializationLine: JSON.stringify({ jsonrpc: '2.0', id: 1, result: initialization })
  }
}

test('install probe stops initialization after malformed stdout in the same chunk', { timeout: 2000 }, async () => {
  const fake = fakeStdioChild()

  await assert.rejects(
    probeMcpStdio({
      command: 'fake-child',
      args: [],
      env: {},
      timeoutMs: 50,
      spawnImpl: (() => {
        queueMicrotask(() => fake.stdout.write(`${fake.initializationLine}\nnot-json\n`))
        return fake.child
      }) as typeof import('node:child_process').spawn,
      inspect: async () => undefined
    }),
    /invalid JSON/i
  )
  assert.deepEqual(fake.writes.map((message) => message.method), ['initialize'])
})

test('install probe rejects inspection requests after malformed stdout poisons the session', { timeout: 2000 }, async () => {
  const fake = fakeStdioChild()

  await assert.rejects(
    probeMcpStdio({
      command: 'fake-child',
      args: [],
      env: {},
      timeoutMs: 50,
      spawnImpl: (() => fake.child) as typeof import('node:child_process').spawn,
      inspect: async ({ request }) => {
        fake.stdout.write('not-json\n')
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        return request('tools/call', { name: 'runtimes_detect', arguments: {} })
      }
    }),
    /invalid JSON/i
  )
  assert.deepEqual(fake.writes.map((message) => message.method), [
    'initialize',
    'notifications/initialized',
    'tools/list'
  ])
})

test('install probe rejects valid non-object JSON-RPC frames without escaping cleanup', { timeout: 2000 }, async (t) => {
  for (const frame of ['null', '[]', '42', '"text"']) {
    await t.test(frame, async () => {
      const fake = fakeStdioChild()

      await assert.rejects(
        probeMcpStdio({
          command: 'fake-child',
          args: [],
          env: {},
          timeoutMs: 50,
          spawnImpl: (() => {
            queueMicrotask(() => fake.stdout.write(`${fake.initializationLine}\n${frame}\n`))
            return fake.child
          }) as typeof import('node:child_process').spawn,
          inspect: async () => undefined
        }),
        /invalid JSON-RPC/i
      )
      assert.deepEqual(fake.writes.map((message) => message.method), ['initialize'])
    })
  }
})

test('install probe bounds failure cleanup when a child ignores termination', { timeout: 2000 }, async () => {
  const signals: Array<NodeJS.Signals | undefined> = []
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill(signal?: NodeJS.Signals) {
      signals.push(signal)
      return true
    }
  }) as unknown as ReturnType<typeof import('node:child_process').spawn>
  const started = Date.now()

  await assert.rejects(
    probeMcpStdio({
      command: 'fake-child',
      args: [],
      env: {},
      timeoutMs: 50,
      spawnImpl: (() => {
        queueMicrotask(() => { child.stdout.write('not-json\n') })
        return child
      }) as typeof import('node:child_process').spawn,
      inspect: async () => undefined
    }),
    /invalid JSON|did not exit|cleanup timed out/i
  )
  assert.deepEqual(signals, [undefined, 'SIGKILL'])
  assert.ok(Date.now() - started < 1500, 'failed probe cleanup must be bounded')
})

test('install probe rejects when the child exits before answering', { timeout: 10_000 }, async (t) => {
  const server = await fakeServer(t as Parameters<typeof fakeServer>[0], 'process.exit(3)\n')

  await assert.rejects(
    probeMcpStdio({
      ...server,
      inspect: async () => undefined
    }),
    /exited before the probe completed.*3/i
  )
})
