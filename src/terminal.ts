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
) => void

export function createTerminal(options: { platform?: NodeJS.Platform | string; execFileImpl?: CompletionExec } = {}) {
  const platform = options.platform ?? process.platform
  const execFileImpl = options.execFileImpl ?? (execFile as unknown as CompletionExec)
  let child: ChildProcess | null = null
  let stopping: ChildProcess | null = null
  let startedAt: number | null = null
  let buffer = ''
  let completionCwd = process.cwd()
  const listeners = new Set<(chunk: string) => void>()

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
    try { session.kill() } catch { /* The process may already be gone. */ }
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
    if (child) return state()
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
    startedAt = Date.now()
    session.on('error', (cause) => {
      if (child === session) {
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
      if (child === session) {
        child = null
        startedAt = null
        append('\r\n[session ended — start again to reopen]\r\n')
      } else if (stopping === session) {
        stopping = null
        append('\r\n[session stopped — start again to reopen]\r\n')
      }
    })
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
      execFileImpl('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
        windowsHide: true,
        // A cold host (first PowerShell start, antivirus scanning, a busy
        // machine) can take a while to answer; the tab-completion hint is
        // worth waiting for.
        timeout: COMPLETION_TIMEOUT_MS,
        maxBuffer: 64 * 1024,
        cwd: completionCwd
      }, (error, stdout) => {
        if (error) { resolve(empty(true)); return }
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
    })
  }

  function stop(): TerminalState {
    const session = child
    if (!session) return state()
    stopping = session
    child = null
    startedAt = null
    try {
      if (!session.kill()) {
        stopping = null
        append('\r\n[session stop failed: kill signal was not sent — the process may still be running]\r\n')
      }
      // A successful kill is reported only when the child actually exits.
    } catch (cause) {
      stopping = null
      append(`\r\n[session stop failed: ${errorText(cause)} — the process may still be running]\r\n`)
    }
    return state()
  }

  /** Subscribe to output; replays the buffered history first. */
  function subscribe(listener: (chunk: string) => void): () => void {
    listeners.add(listener)
    if (buffer) listener(buffer)
    return () => listeners.delete(listener)
  }

  process.once('exit', () => {
    try { child?.kill() } catch { /* The process may already be gone. */ }
  })

  return { start, input, complete, stop, state, subscribe, snapshot: () => buffer }
}

export type Terminal = ReturnType<typeof createTerminal>
