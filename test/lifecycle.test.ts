import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createShutdown, watchShutdownSignals, watchStartup } from '../dist/lifecycle.js'

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (cause: unknown) => void } {
  let resolve!: () => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

test('shutdown closes every owned resource once and shares its failure', async () => {
  const shutdown = createShutdown()
  const release = deferred()
  const calls: string[] = []
  shutdown.own({ close: () => { calls.push('panel'); return release.promise } })
  shutdown.own({ close: () => { calls.push('broken'); throw new Error('cleanup failed') } })

  const first = shutdown.close()
  const second = shutdown.close()
  assert.equal(first, second)
  assert.equal(shutdown.closing, true)
  assert.deepEqual(calls, ['panel', 'broken'])
  assert.throws(() => shutdown.assertOpen(), /shutting down/)

  let settled = false
  void first.catch(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'close must wait for the remaining resource')
  release.resolve()
  await assert.rejects(first, (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 1)
    assert.match(String(error.errors[0]), /cleanup failed/)
    return true
  })
  await shutdown.close().catch(() => {})
  assert.deepEqual(calls, ['panel', 'broken'])
})

test('shutdown drains tracked startup and closes a resource acquired during it', async () => {
  const shutdown = createShutdown()
  const startup = deferred()
  let lateClosed = false
  shutdown.track(startup.promise)

  const closing = shutdown.close()
  startup.resolve()
  shutdown.own({ close: async () => { lateClosed = true } })
  await closing

  assert.equal(lateClosed, true)
})

test('shutdown preserves a late cleanup failure while earlier cleanup is pending', async () => {
  const shutdown = createShutdown()
  const initialCleanup = deferred()
  shutdown.own({ close: () => initialCleanup.promise })

  const closing = shutdown.close()
  const lateCleanup = deferred()
  shutdown.own({ close: () => lateCleanup.promise })
  lateCleanup.reject(new Error('late cleanup failed'))
  await Promise.resolve()
  initialCleanup.resolve()

  await assert.rejects(closing, (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.equal(error.errors.length, 1)
    assert.match(String(error.errors[0]), /late cleanup failed/)
    return true
  })
})

test('stdin EOF and termination signals share shutdown and remove their listeners', async () => {
  const shutdown = createShutdown()
  const stdin = new EventEmitter()
  const signals = new EventEmitter()
  const errors: unknown[] = []
  watchShutdownSignals(shutdown, {
    stdin,
    processEvents: signals,
    onError: (error) => errors.push(error)
  })

  stdin.emit('end')
  signals.emit('SIGTERM')
  signals.emit('SIGINT')
  await shutdown.close()

  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
  assert.equal(stdin.listenerCount('end'), 0)
  assert.equal(signals.exitCode, undefined)
  assert.deepEqual(errors, [])
})

test('termination signals preserve a failing exit status while cleanup still finishes', async () => {
  const shutdown = createShutdown()
  const signals = new EventEmitter() as EventEmitter & { exitCode?: number }
  const errors: unknown[] = []
  watchShutdownSignals(shutdown, {
    processEvents: signals,
    onError: (error) => errors.push(error)
  })
  shutdown.own({ close: async () => { throw new Error('listener cleanup failed') } })

  signals.emit('SIGTERM')
  await shutdown.close().catch(() => {})

  assert.equal(signals.exitCode, 143)
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof AggregateError)
  assert.equal(signals.listenerCount('SIGTERM'), 0)
  assert.equal(signals.listenerCount('SIGINT'), 0)
})

test('stdin EOF turns a cleanup failure into a nonzero exit status', async () => {
  const shutdown = createShutdown()
  const stdin = new EventEmitter()
  const signals = Object.assign(new EventEmitter(), {
    exitCode: undefined as number | string | undefined
  })
  const errors: unknown[] = []
  watchShutdownSignals(shutdown, {
    stdin,
    processEvents: signals,
    onError: (error) => errors.push(error)
  })
  shutdown.own({ close: async () => { throw new Error('listener cleanup failed') } })

  stdin.emit('end')
  await shutdown.close().catch(() => {})

  assert.equal(signals.exitCode, 1)
  assert.equal(errors.length, 1)
  assert.ok(errors[0] instanceof AggregateError)
  assert.equal(stdin.listenerCount('end'), 0)
})

test('startup failures racing with shutdown are reported and fail the process', async () => {
  const shutdown = createShutdown()
  const startup = deferred()
  const signals = Object.assign(new EventEmitter(), {
    exitCode: 0 as number | string | null | undefined
  })
  const errors: unknown[] = []
  watchStartup(shutdown, startup.promise, {
    processEvents: signals,
    onError: (error) => errors.push(error)
  })

  const closing = shutdown.close()
  const failure = new Error('settings could not be loaded')
  startup.reject(failure)
  await closing
  await nextTurn()

  assert.deepEqual(errors, [failure])
  assert.equal(signals.exitCode, 1)
})

test('startup preserves an existing nonzero failure status', async () => {
  const shutdown = createShutdown()
  const startup = deferred()
  const signals = Object.assign(new EventEmitter(), {
    exitCode: 143 as number | string | null | undefined
  })
  const errors: unknown[] = []
  watchStartup(shutdown, startup.promise, {
    processEvents: signals,
    onError: (error) => errors.push(error)
  })

  const closing = shutdown.close()
  const failure = new Error('panel failed while terminating')
  startup.reject(failure)
  await closing
  await nextTurn()

  assert.equal(signals.exitCode, 143)
  assert.deepEqual(errors, [failure])
})

test('expected shutdown cancellation remains quiet during startup', async () => {
  for (const kind of ['guard', 'abort'] as const) {
    const shutdown = createShutdown()
    const startup = deferred()
    const signals = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | string | null | undefined
    })
    const errors: unknown[] = []
    watchStartup(shutdown, startup.promise, {
      processEvents: signals,
      onError: (error) => errors.push(error)
    })

    const closing = shutdown.close()
    let cancellation: unknown
    try {
      shutdown.assertOpen()
    } catch (cause) {
      cancellation = cause
    }
    if (kind === 'abort') {
      cancellation = new Error('The operation was aborted')
      cancellation.name = 'AbortError'
    }
    startup.reject(cancellation)
    await closing
    await nextTurn()

    assert.deepEqual(errors, [], `${kind} cancellation should not be reported as a startup failure`)
    assert.equal(signals.exitCode, undefined, `${kind} cancellation should remain a natural exit`)
  }
})
