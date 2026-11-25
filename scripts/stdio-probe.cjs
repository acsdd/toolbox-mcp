/* Minimal newline-delimited MCP probe with direct ownership of the child's stdin. */
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')

function withTimeout(promise, timeoutMs, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

async function probeMcpStdio({
  command,
  args,
  env = process.env,
  spawnImpl = spawn,
  timeoutMs = 10_000,
  inspect = async () => undefined
}) {
  const child = spawnImpl(command, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  const pending = new Map()
  let nextId = 1
  let stderr = ''
  let fatalError = null
  let closed = false
  let eofRequested = false

  let resolveCompletion
  let rejectCompletion
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve
    rejectCompletion = reject
  })
  child.once('error', (error) => {
    closed = true
    fatalError = error
    failPending(error)
    rejectCompletion(error)
  })
  child.once('close', (code, signal) => {
    closed = true
    resolveCompletion({ code, signal })
    if (!eofRequested) {
      failPending(new Error(`MCP child exited before the probe completed (code ${code}, signal ${signal}).`))
    }
  })
  child.stderr.on('data', (chunk) => { stderr += chunk })

  function failPending(error) {
    fatalError ??= error
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
  }

  function send(message) {
    if (closed || fatalError) return Promise.reject(fatalError ?? new Error('MCP child is already closed.'))
    return new Promise((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  function request(method, params) {
    if (closed || fatalError) return Promise.reject(fatalError ?? new Error('MCP child is already closed.'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms.${stderr ? ` Server stderr: ${stderr.trim()}` : ''}`))
      }, timeoutMs)
      pending.set(id, { resolve, reject, timer })
      send({ jsonrpc: '2.0', id, method, params }).catch((error) => {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      })
    })
  }

  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch (cause) {
      failPending(new Error(`MCP child returned invalid JSON: ${line}`))
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      failPending(new Error(`MCP child returned an invalid JSON-RPC frame: ${line}`))
      return
    }
    if (message.id === undefined) return
    const request = pending.get(message.id)
    if (!request) return
    clearTimeout(request.timer)
    pending.delete(message.id)
    if (message.error) {
      request.reject(new Error(`MCP ${message.method ?? 'request'} failed: ${message.error.message ?? JSON.stringify(message.error)}`))
    } else {
      request.resolve(message.result)
    }
  })
  child.stdin.on('error', (error) => failPending(error))

  try {
    const initialization = await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'modelfarm-install-probe', version: '1.0.0' }
    })
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const catalog = await request('tools/list', {})
    const inspection = await inspect({ request, tools: catalog.tools })
    if (fatalError) throw fatalError
    eofRequested = true
    child.stdin.end()
    const exit = await withTimeout(completion, timeoutMs, 'MCP child did not exit after stdin EOF.')
    if (fatalError) throw fatalError
    if (exit.code !== 0 || exit.signal !== null) {
      throw new Error(`MCP child did not exit naturally (code ${exit.code}, signal ${exit.signal}).${stderr ? ` Server stderr: ${stderr.trim()}` : ''}`)
    }
    return { ...exit, initialization, catalog, inspection }
  } catch (error) {
    failPending(error)
    const cleanupGraceMs = Math.max(50, Math.min(timeoutMs, 1000))
    let forceKillTimer
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill()
      } catch {
        // Still bound the wait for an observed close below.
      }
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // The final deadline reports a transport that never closed.
          }
        }
      }, cleanupGraceMs)
    }
    try {
      await withTimeout(completion, cleanupGraceMs * 2 + 100, 'MCP child cleanup timed out before the process closed.')
    } catch (cleanupError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)} ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: error })
    } finally {
      if (forceKillTimer) clearTimeout(forceKillTimer)
    }
    throw error
  } finally {
    lines.close()
  }
}

module.exports = { probeMcpStdio }
