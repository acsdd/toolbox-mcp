import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request as httpRequest } from 'node:http'
import { after, describe, it } from 'node:test'
import { MAX_MODEL_NOTES, sanitizeModelNotes } from '../dist/config.js'
import { createServices } from '../dist/services.js'
import { startPanel } from '../dist/panel.js'

const homes: string[] = []

async function freshHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'toolbox-mcp-mfnotes-'))
  homes.push(home)
  process.env.TOOLBOX_MCP_HOME = home
  return home
}

after(async () => {
  delete process.env.TOOLBOX_MCP_HOME
  for (const home of homes) await rm(home, { recursive: true, force: true })
})

describe('model notes: storage validation', () => {
  it('keeps valid notes trimmed and drops malformed entries', () => {
    const cleaned = sanitizeModelNotes({
      'a/keep': '  runs at 12 tok/s  ',
      'a/empty': '   ',
      'a/number': 42,
      '': 'no repo',
      ['x'.repeat(201)]: 'repo too long'
    })
    assert.deepEqual(cleaned, { 'a/keep': 'runs at 12 tok/s' })
  })

  it('truncates over-long notes instead of dropping them', () => {
    const cleaned = sanitizeModelNotes({ 'a/model': 'n'.repeat(2000) })
    assert.equal(cleaned['a/model'].length, 1000)
  })

  it('caps the number of stored notes', () => {
    const raw: Record<string, string> = {}
    for (let i = 0; i < MAX_MODEL_NOTES + 50; i++) raw['repo/model-' + i] = 'note ' + i
    const cleaned = sanitizeModelNotes(raw)
    assert.equal(Object.keys(cleaned).length, MAX_MODEL_NOTES)
    assert.equal(cleaned['repo/model-0'], 'note 0')
  })

  it('rejects non-object input and survives a restart', async () => {
    assert.deepEqual(sanitizeModelNotes(null), {})
    assert.deepEqual(sanitizeModelNotes([1, 2]), {})
    assert.deepEqual(sanitizeModelNotes('notes'), {})

    const home = await freshHome()
    const services = createServices({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }) as never })
    await services.init()
    await services.modelFarmSetNote({ repo: 'a/model', note: 'fits in VRAM' })

    // A settings file written before notes existed must load as empty.
    const file = join(home, 'settings.json')
    const stored = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(stored.modelNotes['a/model'], 'fits in VRAM')
    delete stored.modelNotes
    await writeFile(file, JSON.stringify(stored))
    const restarted = createServices({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }) as never })
    await restarted.init()
    assert.deepEqual((await restarted.settingsSnapshot()).modelNotes, {})
  })
})

describe('model notes: service and panel API', () => {
  const offlineFetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' }) as never

  interface Reply { status: number; body: string }
  function ask(port: number, path: string, payload?: unknown): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1', port, path,
        method: payload === undefined ? 'GET' : 'POST',
        headers: payload === undefined ? {} : { 'Content-Type': 'application/json' }
      }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      if (payload !== undefined) req.write(JSON.stringify(payload))
      req.end()
    })
  }

  it('saves, replaces and deletes a note, persisting across restarts', async () => {
    await freshHome()
    const services = createServices({ fetchImpl: offlineFetch })
    await services.init()
    await services.modelFarmSetNote({ repo: 'a/model', note: 'first' })
    let snapshot = await services.modelFarmSetNote({ repo: 'a/model', note: 'second' })
    assert.equal(snapshot.modelNotes['a/model'], 'second')
    snapshot = await services.modelFarmSetNote({ repo: 'a/model', note: '   ' })
    assert.deepEqual(snapshot.modelNotes, {})

    await services.modelFarmSetNote({ repo: 'a/model', note: 'kept' })
    const restarted = createServices({ fetchImpl: offlineFetch })
    await restarted.init()
    assert.equal((await restarted.settingsSnapshot()).modelNotes['a/model'], 'kept')
  })

  it('rejects a missing or over-long repo', async () => {
    await freshHome()
    const services = createServices({ fetchImpl: offlineFetch })
    await services.init()
    await assert.rejects(() => services.modelFarmSetNote({ note: 'orphan' }))
    await assert.rejects(() => services.modelFarmSetNote({ repo: 'x'.repeat(201), note: 'too long' }))
    assert.deepEqual((await services.settingsSnapshot()).modelNotes, {})
  })

  it('exposes notes through the panel API and validates submissions', async () => {
    await freshHome()
    const services = createServices({ fetchImpl: offlineFetch })
    await services.init()
    const panel = await startPanel(services, { port: 0 })
    try {
      const saved = await ask(panel.port, '/api/settings/model-note', { repo: 'a/model', note: 'via the panel' })
      assert.equal(saved.status, 200)
      assert.equal(JSON.parse(saved.body).modelNotes['a/model'], 'via the panel')

      const listed = await ask(panel.port, '/api/settings')
      assert.equal(JSON.parse(listed.body).modelNotes['a/model'], 'via the panel')

      const bad = await ask(panel.port, '/api/settings/model-note', { note: 'no repo' })
      assert.equal(bad.status, 400)
      assert.ok(JSON.parse(bad.body).error)
    } finally {
      panel.close()
    }
  })
})

describe('model notes: MCP surface', () => {
  it('exposes note read/write tools with honest annotations and shapes', async () => {
    const { TOOL_CATALOG, catalogEntries } = await import('../dist/catalog.js')
    const read = TOOL_CATALOG.find((tool) => tool.name === 'llamafarm_notes')
    const write = TOOL_CATALOG.find((tool) => tool.name === 'llamafarm_note')
    assert.ok(read, 'llamafarm_notes is catalogued')
    assert.ok(write, 'llamafarm_note is catalogued')
    assert.equal(read.annotations.readOnlyHint, true)
    assert.equal(write.annotations.readOnlyHint, false)
    assert.equal(write.annotations.idempotentHint, true)
    assert.equal(write.annotations.openWorldHint, false)
    assert.equal(read.annotations.openWorldHint, false)
    const params = catalogEntries().find((tool) => tool.name === 'llamafarm_note')?.params
    assert.deepEqual(params?.map((param) => param.name), ['repo', 'note'])
    assert.equal(params?.find((param) => param.name === 'repo')?.required, true)
    assert.equal(params?.find((param) => param.name === 'note')?.required, false)
  })
})