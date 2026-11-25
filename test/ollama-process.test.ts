import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import {
  OllamaExitObservationError,
  pullIntoOwnedOllama,
  runOwnedOllamaCommand
} from '../dist/ollama-process.js'

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  pid: number
  kill(signal?: NodeJS.Signals): boolean
}

function fakeChild(signals: Array<NodeJS.Signals | undefined>, pid = 1234): FakeChild {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid,
    kill(signal?: NodeJS.Signals) {
      signals.push(signal)
      return true
    }
  })
}

test('owned Ollama command collects output and resolves only after close', async () => {
  const signals: Array<NodeJS.Signals | undefined> = []
  const child = fakeChild(signals)
  let settled = false
  const command = runOwnedOllamaCommand(['pull', 'hf.co/test/model:Q4_K_M'], {
    spawnImpl: () => child
  })
  void command.then(() => { settled = true }, () => { settled = true })

  child.stdout.write('pulling model\n')
  child.stderr.write('verifying sha256\n')
  await Promise.resolve()
  assert.equal(settled, false)
  child.emit('close', 0)

  assert.deepEqual(await command, {
    ok: true,
    code: 0,
    output: 'pulling model\nverifying sha256\n',
    error: null
  })
  assert.deepEqual(signals, [])
})

test('owned Ollama command escalates cancellation and waits for observed close', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: Array<NodeJS.Signals | undefined> = []
  const child = fakeChild(signals)
  const controller = new AbortController()
  let settled = false
  const command = runOwnedOllamaCommand(['pull', 'hf.co/test/model:Q4_K_M'], {
    spawnImpl: () => child,
    signal: controller.signal
  })
  void command.then(() => { settled = true }, () => { settled = true })

  controller.abort(new Error('shutdown'))
  await Promise.resolve()
  assert.deepEqual(signals, [undefined])
  t.mock.timers.tick(2000)
  await Promise.resolve()
  assert.deepEqual(signals, [undefined, 'SIGKILL'])
  assert.equal(settled, false, 'sending SIGKILL is not proof of exit')

  child.emit('close', null)
  const result = await command
  assert.equal(result.ok, false)
  assert.match(result.error ?? '', /cancelled/i)
})

test('owned Ollama command adopts and terminates a child returned after cancellation', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: Array<NodeJS.Signals | undefined> = []
  const child = fakeChild(signals)
  const controller = new AbortController()
  const command = runOwnedOllamaCommand(['rm', 'model'], {
    spawnImpl: () => {
      controller.abort(new Error('shutdown'))
      return child
    },
    signal: controller.signal
  })

  await Promise.resolve()
  assert.deepEqual(signals, [undefined])
  t.mock.timers.tick(2000)
  child.emit('close', null)
  assert.equal((await command).ok, false)
})

test('owned Ollama command rejects when a force-killed child never closes', { timeout: 2000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const signals: Array<NodeJS.Signals | undefined> = []
  const child = fakeChild(signals)
  const controller = new AbortController()
  const command = runOwnedOllamaCommand(['pull', 'hf.co/test/model:Q4_K_M'], {
    spawnImpl: () => child,
    signal: controller.signal
  })
  void command.catch(() => {})

  controller.abort(new Error('shutdown'))
  t.mock.timers.tick(2000)
  t.mock.timers.tick(2000)

  await assert.rejects(command, (error: unknown) => {
    assert.ok(error instanceof OllamaExitObservationError)
    assert.match(error.message, /did not exit after SIGKILL/i)
    return true
  })
  assert.deepEqual(signals, [undefined, 'SIGKILL'])
})

test('owned Ollama pull keeps the repository-default retry', async () => {
  const signals: Array<NodeJS.Signals | undefined> = []
  const children: FakeChild[] = []
  let secondSpawned!: () => void
  const started = new Promise<void>((resolve) => { secondSpawned = resolve })
  const command = pullIntoOwnedOllama('hf.co/test/model:Q8_0', {
    spawnImpl: () => {
      const child = fakeChild(signals)
      children.push(child)
      if (children.length === 2) secondSpawned()
      return child
    }
  })

  // The rejection text is emitted before close, as it is by the real CLI.
  children[0]!.stderr.write('Error: the specified tag is not a valid quantization scheme\n')
  children[0]!.emit('close', 1)
  await started
  children[1]!.emit('close', 0)

  const result = await command
  assert.equal(result.ok, true)
  assert.equal(result.reference, 'hf.co/test/model:latest')
  assert.equal(children.length, 2)
})

test('owned Ollama pull does not retry after cancellation begins', async () => {
  const signals: Array<NodeJS.Signals | undefined> = []
  const children: FakeChild[] = []
  const controller = new AbortController()
  const command = pullIntoOwnedOllama('hf.co/test/model:Q8_0', {
    spawnImpl: () => {
      const child = fakeChild(signals)
      children.push(child)
      return child
    },
    signal: controller.signal
  })

  children[0]!.stderr.write('Error: the specified tag is not a valid quantization scheme\n')
  children[0]!.emit('close', 1)
  controller.abort(new Error('shutdown'))

  const result = await command
  assert.equal(result.ok, false)
  assert.equal(result.reference, 'hf.co/test/model:Q8_0')
  assert.equal(children.length, 1)
})
