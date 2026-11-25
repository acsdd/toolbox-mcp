/** Owned Ollama CLI commands with cancellation and observed-exit cleanup. */
import { spawn } from 'node:child_process'
import {
  isQuantTagRejection,
  latestReference,
  summarizeOllamaFailure,
  type PullResult
} from '@toolbox/widgets'

const TERMINATION_GRACE_MS = 2000
const EXIT_OBSERVATION_MS = 2000

interface OllamaChildProcess {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null
  once(event: 'error', listener: (error: Error) => void): unknown
  once(event: 'close', listener: (code: number | null) => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'close', listener: (code: number | null) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
  pid?: number
}

export type OllamaSpawnLike = (file: string, args: string[]) => OllamaChildProcess

export interface OwnedOllamaOptions {
  signal?: AbortSignal
  spawnImpl?: OllamaSpawnLike
  onOutput?: (chunk: string) => void
}

export class OllamaExitObservationError extends Error {
  readonly output: string

  constructor(output: string) {
    super('Ollama did not exit after SIGKILL.')
    this.name = 'OllamaExitObservationError'
    this.output = output
  }
}

const defaultSpawn: OllamaSpawnLike = (file, args) =>
  spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

/**
 * Run one Ollama command without letting a signal-ignoring child outlive the
 * service indefinitely. Cancellation is sticky: a later zero exit cannot turn
 * a cancelled command into success, and cleanup settles only on observed close
 * or an explicit exit-observation failure.
 */
export function runOwnedOllamaCommand(
  args: string[],
  options: OwnedOllamaOptions = {}
): Promise<PullResult> {
  const signal = options.signal
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Ollama command cancelled.'))
  }
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  return new Promise<PullResult>((resolve, reject) => {
    let output = ''
    let settled = false
    let terminating = false
    let child: OllamaChildProcess | undefined
    let killTimer: ReturnType<typeof setTimeout> | undefined
    let observationTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (result: PullResult, cause?: unknown): void => {
      if (settled) return
      settled = true
      if (killTimer) clearTimeout(killTimer)
      if (observationTimer) clearTimeout(observationTimer)
      signal?.removeEventListener('abort', terminate)
      child?.removeListener('close', onClose)
      child?.removeListener('error', onError)
      if (cause !== undefined) reject(cause)
      else resolve(result)
    }

    const terminate = (): void => {
      if (settled || terminating) return
      terminating = true
      output += '\nOllama command cancelled.'
      try {
        child?.kill()
      } catch {
        // A failed kill still requires an observed close or a bounded failure.
      }
      killTimer = setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {
          // Keep observing: a timer or a failed kill is not proof of exit.
        }
        observationTimer = setTimeout(() => {
          finish(
            { ok: false, code: null, output, error: 'Ollama did not exit after SIGKILL.' },
            new OllamaExitObservationError(output)
          )
        }, EXIT_OBSERVATION_MS)
        observationTimer.unref?.()
      }, TERMINATION_GRACE_MS)
      killTimer.unref?.()
    }

    const onClose = (code: number | null): void => {
      if (terminating || signal?.aborted) {
        finish({
          ok: false,
          code,
          output,
          error: summarizeOllamaFailure(output, code)
        })
        return
      }
      finish({
        ok: code === 0,
        code,
        output,
        error: code === 0 ? null : summarizeOllamaFailure(output, code)
      })
    }

    const onError = (error: Error): void => {
      // Spawn failures have no process to own and are normally followed by
      // close. Other child errors do not prove exit, so retain ownership.
      output += `\n${error.message}`
      if (child?.pid === undefined) {
        finish({ ok: false, code: null, output, error: error.message })
      }
    }

    try {
      child = spawnImpl('ollama', args)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      finish({ ok: false, code: null, output: message, error: message })
      return
    }

    const collect = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      output += text
      options.onOutput?.(text)
    }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', onError)
    child.once('close', onClose)
    signal?.addEventListener('abort', terminate, { once: true })
    // A custom/provider spawn boundary can abort synchronously before returning
    // its child. Adopt that child and terminate it rather than losing ownership.
    if (signal?.aborted) terminate()
  })
}

/** Pull with the same one-time quantization fallback as the shared widget core. */
export async function pullIntoOwnedOllama(
  reference: string,
  options: OwnedOllamaOptions = {}
): Promise<PullResult> {
  const first = await runOwnedOllamaCommand(['pull', reference], options)
  if (first.ok || !isQuantTagRejection(first.output) || options.signal?.aborted) {
    return { ...first, reference }
  }
  const fallback = latestReference(reference)
  if (fallback === reference) return { ...first, reference }
  const second = await runOwnedOllamaCommand(['pull', fallback], options)
  if (second.ok) return { ...second, reference: fallback }
  return { ...second, reference }
}
