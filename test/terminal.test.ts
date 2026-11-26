import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { syncBuiltinESMExports } from 'node:module'
import { PassThrough } from 'node:stream'
import { describe, it, mock, type TestContext } from 'node:test'
import { createTerminal, powerShellPromptDirectory } from '../dist/terminal.js'

class FakeInput extends PassThrough {
  readonly writes: string[] = []
  failure: Error | null = null

  override write(chunk: unknown, encodingOrCallback?: unknown, callback?: unknown): boolean {
    const done = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    this.writes.push(String(chunk))
    queueMicrotask(() => {
      if (typeof done === 'function') done(this.failure)
    })
    return true
  }
}

class FakeChild extends EventEmitter {
  static nextPid = 4100
  readonly pid = FakeChild.nextPid++
  readonly file: string
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new FakeInput()
  kills = 0
  readonly killSignals: Array<NodeJS.Signals | undefined> = []
  killError: Error | null = null
  exitOnKillSignal: NodeJS.Signals | undefined

  constructor(file: string) {
    super()
    this.file = file
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills += 1
    this.killSignals.push(signal)
    if (this.killError) queueMicrotask(() => this.emit('error', this.killError))
    if (signal && signal === this.exitOnKillSignal) queueMicrotask(() => {
      this.emit('exit', 0, null)
      this.emit('close', 0, null)
    })
    return true
  }
}

function fakeSpawn(t: TestContext): FakeChild[] {
  const children: FakeChild[] = []
  const spawnMock = mock.method(childProcess, 'spawn', ((file: string) => {
    const child = new FakeChild(file)
    children.push(child)
    return child
  }) as never)
  syncBuiltinESMExports()
  t.after(() => {
    spawnMock.mock.restore()
    syncBuiltinESMExports()
  })
  return children
}

/** Keep each test's process-exit cleanup hook from leaking into the next one. */
function testTerminal(t: TestContext, options?: Parameters<typeof createTerminal>[0]) {
  const existingExitListeners = new Set(process.listeners('exit'))
  const terminal = createTerminal(options)
  t.after(() => {
    for (const listener of process.listeners('exit')) {
      if (!existingExitListeners.has(listener)) process.removeListener('exit', listener)
    }
  })
  return terminal
}

describe('terminal completion', () => {
  it('tracks the live PowerShell directory from its prompt', () => {
    assert.equal(powerShellPromptDirectory('output\r\nPS D:\\work\\models> '), 'D:\\work\\models')
    assert.equal(powerShellPromptDirectory('PS C:\\Users\\me>'), 'C:\\Users\\me')
    assert.equal(powerShellPromptDirectory('output without a prompt'), null)
  })

  it('does not advertise shell completion on unsupported platforms', async (t) => {
    let invoked = false
    const terminal = testTerminal(t, {
      platform: 'linux',
      execFileImpl: (() => { invoked = true }) as never
    })

    const result = await terminal.complete('echo hello', 4)

    assert.deepEqual(result, {
      supported: false,
      candidates: [],
      replacementIndex: 4,
      replacementLength: 0
    })
    assert.equal(invoked, false)
  })

  it('uses PowerShell command completion and safely encodes the typed line', async (t) => {
    let args: string[] = []
    let options: { timeout?: number } = {}
    const terminal = testTerminal(t, {
      platform: 'win32',
      execFileImpl: ((_file: string, inputArgs: string[], inputOptions: { timeout?: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        args = inputArgs
        options = inputOptions
        callback(null, JSON.stringify({
          candidates: ['Get-ChildItem', 'Get-ChildItemProperty'],
          replacementIndex: 0,
          replacementLength: 7
        }), '')
      }) as never
    })

    const line = "Get-Chi'; throw 'not data"
    const result = await terminal.complete(line, line.length)

    assert.deepEqual(result, {
      supported: true,
      candidates: ['Get-ChildItem', 'Get-ChildItemProperty'],
      replacementIndex: 0,
      replacementLength: 7
    })
    const encodedIndex = args.indexOf('-EncodedCommand') + 1
    assert.ok(encodedIndex > 0)
    const script = Buffer.from(args[encodedIndex], 'base64').toString('utf16le')
    assert.match(script, /CommandCompletion.*CompleteInput/)
    assert.match(script, new RegExp(Buffer.from(line, 'utf8').toString('base64')))
    assert.doesNotMatch(script, /Get-Chi'; throw 'not data/)
    // A cold host needs a real budget before the hint is worth giving up on.
    assert.ok((options.timeout ?? 0) >= 5000, `expected a generous completion timeout, got ${options.timeout}`)
  })

  it('bounds long input and the number of returned completion candidates', async (t) => {
    let invoked = false
    const terminal = testTerminal(t, {
      platform: 'win32',
      execFileImpl: (() => { invoked = true }) as never
    })

    const result = await terminal.complete('x'.repeat(4096), 4096)

    assert.deepEqual(result, {
      supported: true,
      candidates: [],
      replacementIndex: 2048,
      replacementLength: 0
    })
    assert.equal(invoked, false)
  })
})

describe('terminal process lifecycle', () => {
  it('close is shared, waits for the direct child, and prevents a restart', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 50 })
    terminal.start()

    const first = terminal.close()
    const second = terminal.close()
    assert.ok(first instanceof Promise)
    assert.equal(first, second)
    assert.equal(children[0].kills, 1)
    assert.equal(terminal.state().running, false)

    let closed = false
    void first.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false, 'close must wait for the owned shell to exit')

    children[0].emit('exit', 0, null)
    children[0].emit('close', 0, null)
    await first
    assert.equal(closed, true)
    assert.equal(terminal.start().running, false)
    assert.equal(children.length, 1)
    assert.doesNotMatch(terminal.snapshot(), /start again to reopen/)
  })

  it('close waits for stdio close after the direct child exits', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 50 })
    terminal.start()

    const closing = terminal.close()
    let closed = false
    void closing.then(() => { closed = true })
    children[0].emit('exit', 0, null)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(closed, false, 'exit alone must not finish shutdown while stdio is open')
    assert.equal(children[0].stdin.destroyed, true)
    assert.equal(children[0].stdout.destroyed, true)
    assert.equal(children[0].stderr.destroyed, true)

    children[0].emit('close', 0, null)
    await closing
  })

  it('close releases subscribers and ignores late output', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 50 })
    let delivered = 0
    terminal.start()
    terminal.subscribe(() => { delivered += 1 })
    const beforeClose = delivered

    const closing = terminal.close()
    children[0].emit('exit', 0, null)
    children[0].emit('close', 0, null)
    await closing
    const afterClose = delivered
    children[0].stdout.write('late output')
    terminal.subscribe(() => { delivered += 1 })

    assert.ok(afterClose >= beforeClose)
    assert.equal(delivered, afterClose)
    assert.doesNotMatch(terminal.snapshot(), /late output/)
  })

  it('close prevents new shell completion work', async (t) => {
    let invoked = false
    const terminal = testTerminal(t, {
      platform: 'win32',
      execFileImpl: (() => { invoked = true }) as never
    })
    await terminal.close()

    const result = await terminal.complete('Get-Chi', 7)

    assert.deepEqual(result, {
      supported: true,
      candidates: [],
      replacementIndex: 7,
      replacementLength: 0
    })
    assert.equal(invoked, false)
  })

  it('close force-kills a direct child and waits for its observed exit', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 10 })
    terminal.start()
    children[0].exitOnKillSignal = 'SIGKILL'

    await terminal.close()

    assert.deepEqual(children[0].killSignals, ['SIGTERM', 'SIGKILL'])
    assert.match(terminal.snapshot(), /did not exit|forcing|force/i)
  })

  it('close rejects when a direct child never exits after force-kill', { timeout: 1000 }, async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 5 })
    terminal.start()

    await assert.rejects(terminal.close(), /did not exit|force-kill/i)
    assert.deepEqual(children[0].killSignals, ['SIGTERM', 'SIGKILL'])
  })

  it('close kills and drains an in-flight PowerShell completion child', async (t) => {
    const completion = new FakeChild('powershell.exe')
    let complete: ((error: Error | null, stdout: string, stderr: string) => void) | undefined
    const terminal = testTerminal(t, {
      platform: 'win32',
      execFileImpl: ((_file, _args, _options, callback) => {
        complete = callback
        return completion
      }) as never
    })

    const pending = terminal.complete('Get-Chi', 7)
    const closing = terminal.close()
    try {
      assert.deepEqual(completion.killSignals, ['SIGTERM'])
      let closed = false
      void closing.then(() => { closed = true })
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(closed, false, 'shutdown must await the completion child')
    } finally {
      complete?.(new Error('completion cancelled'), '', '')
      completion.emit('exit', 0, null)
      completion.emit('close', 0, null)
    }

    assert.deepEqual(await pending, {
      supported: true,
      candidates: [],
      replacementIndex: 7,
      replacementLength: 0
    })
    await closing
  })

  it('close rejects a completion child that never exits without retrying it forever', { timeout: 500 }, async (t) => {
    const completion = new FakeChild('powershell.exe')
    const terminal = testTerminal(t, {
      platform: 'win32',
      stopTimeoutMs: 5,
      execFileImpl: (() => completion) as never
    })
    void terminal.complete('Get-Chi', 7)
    const watchdog = setTimeout(() => completion.emit('exit', 0, null), 100)
    t.after(() => clearTimeout(watchdog))

    await assert.rejects(terminal.close(), /did not exit|force-kill/i)
    assert.deepEqual(completion.killSignals, ['SIGTERM', 'SIGKILL'])
  })

  it('close waits for a shell already stopping and removes its process-exit hook', async (t) => {
    const children = fakeSpawn(t)
    const exitListenersBefore = new Set(process.listeners('exit'))
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 50 })
    terminal.start()
    terminal.stop()

    const closing = terminal.close()
    let closed = false
    void closing.then(() => { closed = true })
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(closed, false)

    children[0].emit('exit', 0, null)
    children[0].emit('close', 0, null)
    await closing
    assert.deepEqual(new Set(process.listeners('exit')), exitListenersBefore)
  })

  it('close drains a stopped shell that is still alive after a restart', { timeout: 1000 }, async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 10 })
    terminal.start()
    terminal.stop()
    terminal.start()
    children[1].exitOnKillSignal = 'SIGKILL'

    await assert.rejects(terminal.close(), /session did not exit after force-kill/)
    assert.deepEqual(children[0].killSignals, ['SIGTERM', 'SIGKILL'])
  })

  it('close retains a shell orphaned by a stream error and restart', { timeout: 1000 }, async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux', stopTimeoutMs: 10 })
    terminal.start()
    children[0].stdout.emit('error', new Error('stdout EIO'))
    terminal.start()
    children[1].exitOnKillSignal = 'SIGKILL'

    await assert.rejects(terminal.close(), /session did not exit after force-kill/)
    assert.ok(children[0].killSignals.includes('SIGKILL'), 'the orphaned shell must be force-killed')
  })

  it('uses the injected platform to choose the shell and encoding setup', (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux' })

    terminal.start()

    assert.equal(children.length, 1)
    assert.equal(children[0].file, '/bin/sh')
    assert.equal(terminal.state().pid, children[0].pid)
    assert.deepEqual(children[0].stdin.writes, [])
    terminal.stop()
  })

  it('reports an asynchronous shell spawn failure and permits a retry', (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux' })
    terminal.start()

    children[0].emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))

    assert.deepEqual(terminal.state(), { running: false, pid: null, startedAt: null })
    assert.match(terminal.snapshot(), /ENOENT/)
    assert.match(terminal.snapshot(), /terminal.*(failed|error)|could not start/i)

    const retry = terminal.start()
    assert.equal(retry.running, true)
    assert.equal(retry.pid, children[1].pid)
    terminal.stop()
  })

  it('reports a broken stdin instead of leaving a dead shell running', (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux' })
    terminal.start()

    children[0].stdin.emit('error', new Error('write EPIPE'))

    assert.equal(terminal.state().running, false)
    assert.equal(terminal.state().pid, null)
    assert.match(terminal.snapshot(), /EPIPE/)
    assert.ok(children[0].kills >= 1, 'the failed shell should not be left running')
  })

  it('treats an asynchronous input write failure as a stopped session', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux' })
    terminal.start()
    children[0].stdin.failure = new Error('write EPIPE')

    terminal.input('echo hello\r\n')
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.equal(terminal.state().running, false)
    assert.equal(terminal.state().pid, null)
    assert.match(terminal.snapshot(), /EPIPE/)
  })

  it('reports asynchronous output stream errors without throwing', (t) => {
    const children = fakeSpawn(t)
    for (const stream of ['stdout', 'stderr'] as const) {
      const terminal = testTerminal(t, { platform: 'linux' })
      terminal.start()
      const child = children.at(-1)!
      assert.doesNotThrow(() => child[stream].emit('error', new Error(`${stream} EIO`)))
      assert.equal(terminal.state().running, false)
      assert.match(terminal.snapshot(), new RegExp(`${stream} EIO`))
    }
  })

  it('ignores a stopped shell’s delayed exit and output after a restart', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux' })
    terminal.start()
    children[0].stdin.failure = new Error('write EPIPE')
    terminal.input('echo stale\r\n')
    terminal.stop()
    const current = terminal.start()

    children[0].stdout.write('stale output')
    children[0].emit('exit', 0, null)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.deepEqual(terminal.state(), current)
    assert.doesNotMatch(terminal.snapshot(), /stale output|EPIPE/)
    terminal.input('echo current\r\n')
    assert.ok(children[1].stdin.writes.includes('echo current\r\n'))
    terminal.stop()
    assert.equal(children[1].kills, 1)
  })

  it('reports an asynchronous stop failure instead of claiming the shell stopped', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux' })
    terminal.start()
    children[0].killError = new Error('kill EACCES')

    assert.equal(terminal.stop().running, false)
    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.match(terminal.snapshot(), /session stop failed: kill EACCES/)
    assert.doesNotMatch(terminal.snapshot(), /session stopped/)
  })

  it('ignores a stopped shell’s delayed kill error after a restart', async (t) => {
    const children = fakeSpawn(t)
    const terminal = testTerminal(t, { platform: 'linux' })
    terminal.start()
    children[0].killError = new Error('kill EACCES')
    terminal.stop()
    const current = terminal.start()

    await new Promise<void>((resolve) => setImmediate(resolve))

    assert.deepEqual(terminal.state(), current)
    assert.doesNotMatch(terminal.snapshot(), /EACCES/)
    terminal.stop()
  })

  it('reports synchronous spawn failures without throwing and permits a retry', (t) => {
    const children: FakeChild[] = []
    let attempts = 0
    const spawnMock = mock.method(childProcess, 'spawn', (() => {
      attempts += 1
      if (attempts === 1) throw new Error('spawn EACCES')
      const child = new FakeChild('ollama')
      children.push(child)
      return child
    }) as never)
    syncBuiltinESMExports()
    t.after(() => {
      spawnMock.mock.restore()
      syncBuiltinESMExports()
    })
    const terminal = testTerminal(t, { platform: 'linux' })

    assert.doesNotThrow(() => terminal.start())
    assert.equal(terminal.state().running, false)
    assert.match(terminal.snapshot(), /EACCES/)
    assert.equal(terminal.start().pid, children[0].pid)
    terminal.stop()
  })
})
