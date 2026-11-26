/**
 * Local terminal session for the ops panel: one shell child process
 * (PowerShell on Windows, /bin/sh elsewhere), output streamed to browsers
 * over SSE, input accepted over POST. The panel binds 127.0.0.1 only, so
 * this is a convenience console for the machine's owner, never remote.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process'

export interface TerminalState {
  running: boolean
  pid: number | null
  startedAt: number | null
}

const MAX_BUFFER_CHARS = 200_000
const MAX_COMPLETION_INPUT_CHARS = 2048
const MAX_COMPLETION_MATCHES = 40
/** How long a completion request may wait for the shell before giving up. */
export const COMPLETION_TIMEOUT_MS = 5000

export function powerShellPromptDirectory(output: string): string | null {
  const lastLine = output.split(/\r?\n/).at(-1) ?? ''
  const match = /^PS ([A-Za-z]:\\[^>\r\n]*)>\s*$/.exec(lastLine)
  return match?.[1]?.trimEnd() ?? null
}

export interface TerminalCompletion {
  supported: boolean
  candidates: string[]
  replacementIndex: number
  replacementLength: number
}

type CompletionExec = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; timeout: number; maxBuffer: number; cwd?: string },
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => ChildProcess | undefined

export interface TerminalOptions {
  platform?: NodeJS.Platform | string
  execFileImpl?: CompletionExec
  /** Maximum wait for graceful exit before the direct child is force-killed. */
  stopTimeoutMs?: number
}

const DEFAULT_STOP_TIMEOUT_MS = 1500

export function createTerminal(options: TerminalOptions = {}) {
  const platform = options.platform ?? process.platform
  const execFileImpl = options.execFileImpl ?? (execFile as unknown as CompletionExec)
  const stopTimeoutMs = typeof options.stopTimeoutMs === 'number' && Number.isFinite(options.stopTimeoutMs)
    ? Math.max(0, options.stopTimeoutMs)
    : DEFAULT_STOP_TIMEOUT_MS
  let child: ChildProcess | null = null
  let stopping: ChildProcess | null = null
  let startedAt: number | null = null
  let buffer = ''
  let completionCwd = process.cwd()
  let closed = false
  let closePromise: Promise<void> | null = null
  let processExitHandler: (() => void) | null = null
  const listeners = new Set<(chunk: string) => void>()
  const completionChildren = new Set<ChildProcess>()
  // UI state follows only the newest shell; ownership follows every spawned
  // shell until observed close, including stopped or failed sessions.
  const sessions = new Set<ChildProcess>()
  const terminationRequested = new WeakSet<ChildProcess>()

  function append(chunk: string): void {
    buffer = (buffer + chunk).slice(-MAX_BUFFER_CHARS)
    if (platform === 'win32') completionCwd = powerShellPromptDirectory(buffer) ?? completionCwd
    for (const listener of listeners) listener(chunk)
  }

  function state(): TerminalState {
    return { running: child !== null, pid: child?.pid ?? null, startedAt }
  }

  function errorText(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause)
    return message.replace(/[\r\n]+/g, ' ').trim().slice(0, 240) || 'unknown error'
  }

  /** Clear and stop only the session that actually failed. */
  function fail(session: ChildProcess, context: string, cause: unknown): void {
    if (child !== session) return
    child = null
    startedAt = null
    try {
      if (session.kill()) terminationRequested.add(session)
    } catch { /* The process may already be gone. */ }
    append(`\r\n[${context}: ${errorText(cause)} — start again to reopen]\r\n`)
  }

  function write(session: ChildProcess, data: string, context: string): boolean {
    if (!session.stdin?.writable) {
      fail(session, context, new Error('stdin is not writable'))
      return false
    }
    try {
      session.stdin.write(data, (cause) => {
        if (cause) fail(session, context, cause)
      })
    } catch (cause) {
      fail(session, context, cause)
      return false
    }
    return true
  }

  function start(): TerminalState {
    if (closed || child) return state()
    // A replacement session owns all later callbacks and visible errors.
    stopping = null
    const shell =
      platform === 'win32'
        ? { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
        : { cmd: '/bin/sh', args: ['-i'] as string[] }
    let session: ChildProcess
    try {
      session = spawn(shell.cmd, shell.args, { windowsHide: true, env: process.env })
    } catch (cause) {
      append(`\r\n[terminal could not start: ${errorText(cause)} — start again to reopen]\r\n`)
      return state()
    }
    child = session
    sessions.add(session)
    startedAt = Date.now()
    session.on('error', (cause) => {
      if (closed) {
        stopping = null
      } else if (child === session) {
        fail(session, 'terminal shell failed', cause)
      } else if (stopping === session) {
        stopping = null
        append(`\r\n[session stop failed: ${errorText(cause)} — the process may still be running]\r\n`)
      }
    })
    session.stdin?.on('error', (cause) => fail(session, 'terminal input failed', cause))
    session.stdout?.setEncoding('utf8')
    session.stderr?.setEncoding('utf8')
    session.stdout?.on('error', (cause) => fail(session, 'terminal output failed', cause))
    session.stderr?.on('error', (cause) => fail(session, 'terminal output failed', cause))
    session.stdout?.on('data', (chunk: string) => {
      if (child === session) append(chunk)
    })
    session.stderr?.on('data', (chunk: string) => {
      if (child === session) append(chunk)
    })
    session.on('exit', () => {
      if (closed) {
        stopping = null
      } else if (child === session) {
        child = null
        startedAt = null
        append('\r\n[session ended — start again to reopen]\r\n')
      } else if (stopping === session) {
        stopping = null
        append('\r\n[session stopped — start again to reopen]\r\n')
      }
    })
    session.on('close', () => sessions.delete(session))
    if (platform === 'win32') {
      write(session, '[Console]::OutputEncoding = [Text.Encoding]::UTF8\r\n', 'terminal encoding setup failed')
    }
    if (child === session) {
      append(`[terminal started: ${shell.cmd} — local session, be careful]\r\n`)
    }
    return state()
  }

  function input(data: string): TerminalState {
    if (child) write(child, data, 'terminal input failed')
    return state()
  }

  function complete(line: string, cursor: number): Promise<TerminalCompletion> {
    const safeLine = typeof line === 'string' ? line : ''
    const safeCursor = Number.isFinite(cursor) ? Math.max(0, Math.min(safeLine.length, Math.floor(cursor))) : safeLine.length
    const empty = (supported: boolean, replacementIndex = safeCursor): TerminalCompletion => ({
      supported,
      candidates: [],
      replacementIndex,
      replacementLength: 0
    })
    if (platform !== 'win32') return Promise.resolve(empty(false))
    if (closed) return Promise.resolve(empty(true))
    if (safeLine.length > MAX_COMPLETION_INPUT_CHARS) return Promise.resolve(empty(true, MAX_COMPLETION_INPUT_CHARS))

    // The user's command is base64 data inside a constant PowerShell program,
    // never source text passed to the shell for evaluation.
    const line64 = Buffer.from(safeLine, 'utf8').toString('base64')
    const script = [
      "$ErrorActionPreference = 'Stop'",
      `$line = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${line64}'))`,
      `$cursor = ${safeCursor}`,
      '$completion = [System.Management.Automation.CommandCompletion]::CompleteInput($line, $cursor, $null)',
      '$result = [ordered]@{ replacementIndex = $completion.ReplacementIndex; replacementLength = $completion.ReplacementLength; candidates = @($completion.CompletionMatches | ForEach-Object { $_.CompletionText } | Select-Object -First 40) }',
      'ConvertTo-Json -InputObject $result -Compress -Depth 4'
    ].join('; ')
    const encodedScript = Buffer.from(script, 'utf16le').toString('base64')

    return new Promise((resolve) => {
      const completion = execFileImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
        windowsHide: true,
        // A cold host (first PowerShell start, antivirus scanning, a busy
        // machine) can take a while to answer; the tab-completion hint is
        // worth waiting for.
        timeout: COMPLETION_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        cwd: completionCwd
      }, (error, stdout) => {
        if (error || closed) { resolve(empty(true)); return }
        try {
          const parsed = JSON.parse(stdout.trim()) as {
            candidates?: unknown
            replacementIndex?: unknown
            replacementLength?: unknown
          }
          const replacementIndex = typeof parsed.replacementIndex === 'number'
            ? Math.max(0, Math.min(safeLine.length, Math.floor(parsed.replacementIndex)))
            : safeCursor
          const replacementLength = typeof parsed.replacementLength === 'number'
            ? Math.max(0, Math.min(safeLine.length - replacementIndex, Math.floor(parsed.replacementLength)))
            : 0
          const candidates = Array.isArray(parsed.candidates)
            ? parsed.candidates.filter((candidate): candidate is string => typeof candidate === 'string').slice(0, MAX_COMPLETION_MATCHES)
            : []
          resolve({ supported: true, candidates, replacementIndex, replacementLength })
        } catch {
          resolve(empty(true))
        }
      })
      if (completion) {
        completionChildren.add(completion)
        const release = (): void => {
          completionChildren.delete(completion)
          resolve(empty(true))
        }
        completion.once('exit', release)
        completion.once('close', release)
        completion.once('error', () => resolve(empty(true)))
        if (closed) void waitForSessionExit(completion, 'completion process').catch(() => {})
      }
    })
  }

  function stop(): TerminalState {
    const session = child
    if (!session) return state()
    stopping = session
    child = null
    startedAt = null
    try {
      if (!session.kill('SIGTERM')) {
        append('\r\n[session stop failed: kill signal was not sent — the process may still be running]\r\n')
      } else {
        terminationRequested.add(session)
      }
      // A successful kill is reported only when the child actually exits.
    } catch (cause) {
      append(`\r\n[session stop failed: ${errorText(cause)} — the process may still be running]\r\n`)
    }
    return state()
  }

  function signalSession(session: ChildProcess, signal: NodeJS.Signals, context: string): void {
    try {
      if (!session.kill(signal)) {
        append(`\r\n[${context}: kill signal was not sent — the process may still be running]\r\n`)
      }
    } catch (cause) {
      append(`\r\n[${context}: ${errorText(cause)} — the process may still be running]\r\n`)
    }
  }

  /** Resolve only after the owned process has closed its stdio handles. */
  function waitForSessionExit(
    session: ChildProcess,
    label: string,
    initialSignalSent = false
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      let finishTimer: ReturnType<typeof setTimeout> | undefined
      const finish = (cause?: unknown): void => {
        if (settled) return
        settled = true
        if (forceTimer) clearTimeout(forceTimer)
        if (finishTimer) clearTimeout(finishTimer)
        session.off('exit', onExit)
        session.off('close', onClose)
        if (cause) reject(cause)
        else resolve()
      }
      const onExit = (): void => {
        // Grandchildren can inherit the shell's pipes and outlive its direct
        // process. Release our handles after exit, then wait for close so a
        // broken transport cannot keep the MCP process alive indefinitely.
        session.stdin?.destroy()
        session.stdout?.destroy()
        session.stderr?.destroy()
      }
      const onClose = (): void => finish()
      session.once('exit', onExit)
      session.once('close', onClose)
      forceTimer = setTimeout(() => {
        append(`\r\n[${label} did not exit after stop timeout — forcing termination]\r\n`)
        signalSession(session, 'SIGKILL', `${label} force-kill failed`)
        // A timer or a failed kill is not proof of exit or closed stdio.
        finishTimer = setTimeout(
          () => finish(new Error(`${label} did not exit after force-kill.`)),
          Math.max(1, Math.min(stopTimeoutMs, 250))
        )
      }, stopTimeoutMs)
      if (!initialSignalSent) signalSession(session, 'SIGTERM', `${label} stop failed`)
    })
  }

  function finishClose(): void {
    child = null
    stopping = null
    startedAt = null
    sessions.clear()
    completionChildren.clear()
    listeners.clear()
    if (processExitHandler) {
      process.removeListener('exit', processExitHandler)
      processExitHandler = null
    }
  }

  /** Final shutdown: stop new work, then await every shell we still own. */
  function close(): Promise<void> {
    if (closePromise) return closePromise
    closed = true
    let resolveClose!: () => void
    let rejectClose!: (cause: unknown) => void
    const closing = new Promise<void>((resolve, reject) => {
      resolveClose = resolve
      rejectClose = reject
    })
    // Publish the shared promise before stopping so re-entrant close calls
    // from output subscribers cannot start a second cleanup.
    closePromise = closing
    void (async () => {
      const errors: unknown[] = []
      try {
        const active = child
        if (active) stop()
        const ownedSessions = [...sessions]
        const waiting: Promise<void>[] = ownedSessions.map((session) =>
          waitForSessionExit(session, 'session', terminationRequested.has(session))
        )
        const completions = [...completionChildren]
        for (const completion of completions) {
          waiting.push(waitForSessionExit(completion, 'completion process'))
        }
        const results = await Promise.allSettled(waiting)
        for (const result of results) {
          if (result.status === 'rejected') errors.push(result.reason)
        }
        // A resolved wait observed exit/close; a rejected wait already has a
        // cleanup failure. Neither should be retried indefinitely.
        for (const completion of completions) completionChildren.delete(completion)
        // A custom exec implementation can return its child after a re-entrant
        // close call. Drain any such late completion before releasing hooks.
        while (completionChildren.size > 0) {
          const pending = [...completionChildren]
          const late = await Promise.allSettled(
            pending.map((completion) => waitForSessionExit(completion, 'completion process'))
          )
          for (const result of late) {
            if (result.status === 'rejected') errors.push(result.reason)
          }
          for (const completion of pending) completionChildren.delete(completion)
        }
      } finally {
        finishClose()
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `Terminal shutdown failed: ${errors.map(errorText).join('; ')}`)
      }
    })().then(resolveClose, rejectClose)
    return closing
  }

  /** Subscribe to output; replays the buffered history first. */
  function subscribe(listener: (chunk: string) => void): () => void {
    if (closed) return () => {}
    listeners.add(listener)
    if (buffer) listener(buffer)
    return () => listeners.delete(listener)
  }

  processExitHandler = () => {
    for (const session of new Set([...sessions, ...completionChildren])) {
      if (!session) continue
      try { session.kill() } catch { /* The process may already be gone. */ }
    }
  }
  process.once('exit', processExitHandler)

  return { start, input, complete, stop, close, state, subscribe, snapshot: () => buffer }
}

export type Terminal = ReturnType<typeof createTerminal>
