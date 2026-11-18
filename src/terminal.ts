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

  function start(): TerminalState {
    if (child) return state()
    const shell =
      process.platform === 'win32'
        ? { cmd: 'powershell.exe', args: ['-NoLogo', '-NoProfile'] }
        : { cmd: '/bin/sh', args: ['-i'] as string[] }
    child = spawn(shell.cmd, shell.args, { windowsHide: true, env: process.env })
    startedAt = Date.now()
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => append(chunk))
    child.stderr?.on('data', (chunk: string) => append(chunk))
    child.on('exit', () => {
      child = null
      append('\r\n[session ended — start again to reopen]\r\n')
    })
    if (process.platform === 'win32') {
      child.stdin?.write('[Console]::OutputEncoding = [Text.Encoding]::UTF8\r\n')
    }
    append(`[terminal started: ${shell.cmd} — local session, be careful]\r\n`)
    return state()
  }

  function input(data: string): TerminalState {
    if (child?.stdin?.writable) child.stdin.write(data)
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
        timeout: 2000,
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
    child?.kill()
    child = null
    return state()
  }

  /** Subscribe to output; replays the buffered history first. */
  function subscribe(listener: (chunk: string) => void): () => void {
    listeners.add(listener)
    if (buffer) listener(buffer)
    return () => listeners.delete(listener)
  }

  process.once('exit', () => {
    child?.kill()
  })

  return { start, input, complete, stop, state, subscribe, snapshot: () => buffer }
}

export type Terminal = ReturnType<typeof createTerminal>
