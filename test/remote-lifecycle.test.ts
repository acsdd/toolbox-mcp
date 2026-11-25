import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  assertRemoteEndpointAllowed,
  connectRemote,
  RemoteTimeoutError,
  withRemoteTimeout
} from '../dist/remote.js'

test('remote deadlines abort the operation signal and report the deadline', async () => {
  let operationSignal: AbortSignal | undefined
  const operation = withRemoteTimeout(
    (signal) => {
      operationSignal = signal
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
    10,
    'list tools'
  )

  await assert.rejects(operation, (error: unknown) => {
    assert.ok(error instanceof RemoteTimeoutError)
    assert.equal(error.operation, 'list tools')
    return true
  })
  assert.equal(operationSignal?.aborted, true)
  assert.ok(operationSignal?.reason instanceof RemoteTimeoutError)
})

test('an already-aborted remote operation never starts', async () => {
  const controller = new AbortController()
  controller.abort(new Error('shutdown'))
  let started = false

  await assert.rejects(
    withRemoteTimeout(
      async () => {
        started = true
      },
      100,
      'connect',
      controller.signal
    ),
    /shutdown/
  )
  assert.equal(started, false)
})

test('synchronous remote factories reject cleanly without an orphaned deadline', async () => {
  const failure = new Error('factory failed')
  const unhandled: unknown[] = []
  const onUnhandled = (cause: unknown): void => { unhandled.push(cause) }
  process.on('unhandledRejection', onUnhandled)
  try {
    let synchronous: unknown
    let operation: Promise<unknown> | undefined
    try {
      operation = withRemoteTimeout(() => { throw failure }, 10, 'connect')
    } catch (cause) {
      synchronous = cause
    }
    await assert.rejects(operation ?? Promise.reject(synchronous), (error: unknown) => error === failure)
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    assert.equal(synchronous, undefined, 'factory failures must use the asynchronous result contract')
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})

test('failed remote connect bounds transport cleanup and retains both failures', { timeout: 3000 }, async (t) => {
  const controller = new AbortController()
  let connectStarted!: () => void
  const started = new Promise<void>((resolve) => { connectStarted = resolve })
  let rejectClose!: (cause: unknown) => void
  const closePending = new Promise<void>((_resolve, reject) => { rejectClose = reject })
  const connectMock = mock.method(Client.prototype, 'connect', (function (
    this: Client,
    _transport: unknown,
    options?: { signal?: AbortSignal }
  ) {
    connectStarted()
    return new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
    })
  }) as never)
  const closeMock = mock.method(StreamableHTTPClientTransport.prototype, 'close', (() => closePending) as never)
  t.after(() => {
    connectMock.mock.restore()
    closeMock.mock.restore()
  })

  const connecting = connectRemote('https://8.8.8.8/mcp', controller.signal)
  await started
  controller.abort(new Error('shutdown'))
  const outcome = await Promise.race([
    connecting.then(
      () => 'resolved',
      (error: unknown) => `rejected: ${error instanceof AggregateError
        ? error.errors.map((cause) => String(cause)).join(' | ')
        : String(error)}`
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 1200))
  ])

  try {
    assert.match(outcome, /shutdown/)
    assert.match(outcome, /transport close timed out/i)
  } finally {
    rejectClose(new Error('transport close failed'))
    await connecting.catch(() => {})
  }
})

test('remote endpoint resolution observes caller cancellation', { timeout: 1000 }, async () => {
  const controller = new AbortController()
  let resolverSignal: AbortSignal | undefined
  const resolveEndpoint = assertRemoteEndpointAllowed as unknown as (
    endpoint: string,
    policy: {
      resolve: (host: string, signal?: AbortSignal) => Promise<Array<{ address: string; family: number }>>
    },
    signal: AbortSignal
  ) => Promise<URL>
  const resolving = resolveEndpoint(
    'https://remote.example.com/mcp',
    {
      resolve: async (_host, signal) => {
        resolverSignal = signal
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
    },
    controller.signal
  )
  controller.abort(new Error('shutdown'))

  await assert.rejects(resolving, /shutdown/)
  assert.equal(resolverSignal?.aborted, true)
})
