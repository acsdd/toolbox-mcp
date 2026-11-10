/**
 * Local terminal session for the ops panel: one shell child process
 * (PowerShell on Windows, /bin/sh elsewhere), output streamed to browsers
 * over SSE, input accepted over POST. The panel binds 127.0.0.1 only, so
 * this is a convenience console for the machine's owner, never remote.
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface TerminalState {
  running: boolean
  pid: number | null
  startedAt: number | null
}

const MAX_BUFFER_CHARS = 200_000

export function createTerminal() {
  let child: ChildProcess | null = null
  let startedAt: number | null = null
  let buffer = ''
  const listeners = new Set<(chunk: string) => void>()

  function append(chunk: string): void {
    buffer = (buffer + chunk).slice(-MAX_BUFFER_CHARS)
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

  return { start, input, stop, state, subscribe, snapshot: () => buffer }
}

export type Terminal = ReturnType<typeof createTerminal>
