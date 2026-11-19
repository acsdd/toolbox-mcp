import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createTerminal, powerShellPromptDirectory } from '../dist/terminal.js'

describe('terminal completion', () => {
  it('tracks the live PowerShell directory from its prompt', () => {
    assert.equal(powerShellPromptDirectory('output\r\nPS D:\\work\\models> '), 'D:\\work\\models')
    assert.equal(powerShellPromptDirectory('PS C:\\Users\\me>'), 'C:\\Users\\me')
    assert.equal(powerShellPromptDirectory('output without a prompt'), null)
  })

  it('does not advertise shell completion on unsupported platforms', async () => {
    let invoked = false
    const terminal = createTerminal({
      platform: 'linux',
      execFileImpl: (() => { invoked = true }) as never
    })

    const result = await terminal.complete('echo hello', 4)

    assert.deepEqual(result, {
      supported: false,
      candidates: [],
      replacementIndex: 4,
      replacementLength: 0
    })
    assert.equal(invoked, false)
  })

  it('uses PowerShell command completion and safely encodes the typed line', async () => {
    let args: string[] = []
    let options: { timeout?: number } = {}
    const terminal = createTerminal({
      platform: 'win32',
      execFileImpl: ((_file: string, inputArgs: string[], inputOptions: { timeout?: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => {
        args = inputArgs
        options = inputOptions
        callback(null, JSON.stringify({
          candidates: ['Get-ChildItem', 'Get-ChildItemProperty'],
          replacementIndex: 0,
          replacementLength: 7
        }), '')
      }) as never
    })

    const line = "Get-Chi'; throw 'not data"
    const result = await terminal.complete(line, line.length)

    assert.deepEqual(result, {
      supported: true,
      candidates: ['Get-ChildItem', 'Get-ChildItemProperty'],
      replacementIndex: 0,
      replacementLength: 7
    })
    const encodedIndex = args.indexOf('-EncodedCommand') + 1
    assert.ok(encodedIndex > 0)
    const script = Buffer.from(args[encodedIndex], 'base64').toString('utf16le')
    assert.match(script, /CommandCompletion.*CompleteInput/)
    assert.match(script, new RegExp(Buffer.from(line, 'utf8').toString('base64')))
    assert.doesNotMatch(script, /Get-Chi'; throw 'not data/)
    // A cold host needs a real budget before the hint is worth giving up on.
    assert.ok((options.timeout ?? 0) >= 5000, `expected a generous completion timeout, got ${options.timeout}`)
  })

  it('bounds long input and the number of returned completion candidates', async () => {
    let invoked = false
    const terminal = createTerminal({
      platform: 'win32',
      execFileImpl: (() => { invoked = true }) as never
    })

    const result = await terminal.complete('x'.repeat(4096), 4096)

    assert.deepEqual(result, {
      supported: true,
      candidates: [],
      replacementIndex: 2048,
      replacementLength: 0
    })
    assert.equal(invoked, false)
  })
})
