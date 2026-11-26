/** Shared, race-safe shutdown for process composition roots. */
import { EventEmitter } from 'node:events'

export interface Closeable {
  close(): void | Promise<void>
}

export interface ShutdownController {
  readonly closing: boolean
  assertOpen(): void
  own<T extends Closeable>(resource: T): T
  track<T>(operation: Promise<T>): Promise<T>
  close(): Promise<void>
}

const SHUTDOWN_MESSAGE = 'toolbox-mcp is shutting down'

/** Errors raised purely because shutdown had already started. */
const cancellationErrors = new WeakSet<object>()

function shutdownError(): Error {
  const error = new Error(SHUTDOWN_MESSAGE)
  cancellationErrors.add(error)
  return error
}

/**
 * True when a rejection only reports that shutdown was already underway — the
 * shutdown guard, or an abort triggered by it. Anything else is a real failure
 * even if it happens to arrive while the process is closing.
 */
export function isShutdownCancellation(cause: unknown): boolean {
  if (typeof cause === 'string') return cause === SHUTDOWN_MESSAGE
  if (!(cause instanceof Error)) return false
  return cancellationErrors.has(cause) || cause.name === 'AbortError' || cause.message === SHUTDOWN_MESSAGE
}

/**
 * Own every long-lived resource and startup operation from one place. Closing
 * is published synchronously, resource cleanup starts before the first await,
 * and a resource acquired by an already-running startup is still drained.
 */
export function createShutdown(): ShutdownController {
  const resources = new Set<Closeable>()
  const operations = new Set<Promise<unknown>>()
  const lateCleanups = new Set<Promise<void>>()
  const errors: unknown[] = []
  let closing = false
  let closePromise: Promise<void> | null = null

  function assertOpen(): void {
    if (closing) throw shutdownError()
  }

  function rememberCleanup(cleanup: Promise<void>): void {
    lateCleanups.add(cleanup)
    void cleanup.then(
      () => lateCleanups.delete(cleanup),
      (cause: unknown) => {
        errors.push(cause)
        lateCleanups.delete(cleanup)
      }
    )
  }

  function startCleanup(resource: Closeable): Promise<void> {
    try {
      return Promise.resolve(resource.close())
    } catch (cause) {
      return Promise.reject(cause)
    }
  }

  function own<T extends Closeable>(resource: T): T {
    if (!closing) {
      resources.add(resource)
    } else {
      rememberCleanup(startCleanup(resource))
    }
    return resource
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation)
    void operation.then(
      () => operations.delete(operation),
      () => operations.delete(operation)
    )
    return operation
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise
    closing = true
    let resolveClose!: () => void
    let rejectClose!: (cause: unknown) => void
    closePromise = new Promise<void>((resolve, reject) => {
      resolveClose = resolve
      rejectClose = reject
    })

    const owned = [...resources]
    resources.clear()
    const cleanups = owned.map(startCleanup)
    void (async () => {
      const results = await Promise.allSettled(cleanups)
      for (const result of results) {
        if (result.status === 'rejected') errors.push(result.reason)
      }
      // Startup may still be unwinding after its resources were closed. Wait
      // for it, then close anything it acquired after shutdown began.
      while (operations.size > 0 || lateCleanups.size > 0) {
        const pending = [...operations, ...lateCleanups]
        await Promise.allSettled(pending)
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, 'One or more resources failed to shut down cleanly.')
      }
    })().then(resolveClose, rejectClose)
    return closePromise
  }

  return { get closing() { return closing }, assertOpen, own, track, close }
}

export interface ShutdownSignalOptions {
  /** Omit for panel-only processes; MCP stdio passes process.stdin. */
  stdin?: EventEmitter
  processEvents?: EventEmitter & { exitCode?: number | string | null | undefined }
  onError?: (error: unknown) => void
}

/** Preserve an existing failure status; replace only a missing or successful one. */
function setFailingExitCode(events: EventEmitter & { exitCode?: number | string | null | undefined }, code: number): void {
  if (events.exitCode == null || events.exitCode === 0 || events.exitCode === '0') events.exitCode = code
}

/** Bind stdin EOF (when supplied), SIGINT and SIGTERM to the shared close. */
export function watchShutdownSignals(shutdown: ShutdownController, options: ShutdownSignalOptions = {}): void {
  const signals = options.processEvents ?? process
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  const listeners: Array<{ source: EventEmitter; event: string; listener: () => void }> = []

  if (options.stdin) {
    const onEnd = () => {
      void shutdown.close().catch((cause: unknown) => {
        onError(cause)
        setFailingExitCode(signals, 1)
      })
    }
    options.stdin.once('end', onEnd)
    listeners.push({ source: options.stdin, event: 'end', listener: onEnd })
  }
  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]] as const) {
    const onSignal = () => {
      if (signals.exitCode == null) signals.exitCode = exitCode
      void shutdown.close().catch(onError)
    }
    signals.once(signal, onSignal)
    listeners.push({ source: signals, event: signal, listener: onSignal })
  }

  shutdown.own({
    close: () => {
      for (const { source, event, listener } of listeners) source.removeListener(event, listener)
    }
  })
}

export interface StartupWatchOptions {
  processEvents?: EventEmitter & { exitCode?: number | string | null | undefined }
  onError?: (error: unknown) => void
}

/**
 * Track the startup promise and turn a genuine startup failure into a failing
 * exit after cleaning up. A rejection that only reports shutdown was already
 * underway — stdin EOF or a signal cancelling startup mid-flight — is the
 * expected way to exit and stays silent.
 */
export function watchStartup(
  shutdown: ShutdownController,
  startup: Promise<unknown>,
  options: StartupWatchOptions = {}
): void {
  const signals = options.processEvents ?? process
  const onError = options.onError ?? ((error: unknown) => console.error(error))
  shutdown.track(startup)
  void startup.catch(async (cause: unknown) => {
    if (shutdown.closing && isShutdownCancellation(cause)) return
    try {
      await shutdown.close()
    } catch (closeError) {
      onError(closeError)
    }
    onError(cause)
    setFailingExitCode(signals, 1)
  })
}
