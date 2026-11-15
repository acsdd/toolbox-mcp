import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { runInNewContext } from 'node:vm'
import { after, before, describe, it } from 'node:test'
import { startPanel } from '../dist/panel.js'
import { createServices } from '../dist/services.js'

let services: ReturnType<typeof createServices>
let panel: { port: number; close: () => void }
let page = ''

interface Element {
  innerHTML: string
  textContent: string
  value: string
  classList: { toggle(): void; contains(): boolean }
  addEventListener(): void
  appendChild(child: { innerHTML: string }): void
}

before(async () => {
  services = createServices({ fetchImpl: async () => new Response('[]', { status: 200 }) })
  await services.init()
  panel = await startPanel(services, { port: 0 })
  page = await new Promise<string>((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: panel.port, path: '/', method: 'GET' },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => resolve(text))
      }
    )
    req.on('error', reject)
    req.end()
  })
})

after(() => {
  panel.close()
})

const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]

/**
 * Run the real panel script against a minimal DOM, the way a browser would.
 * Timers are stubbed out: the panel polls its activity feed while the
 * overview is visible, and a test has no reason to wait for that.
 */
function mount(responses: Record<string, unknown> = {}) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
  assert.ok(script, 'the panel page carries its script')
  const elements = new Map<string, Element>()
  const element = (): Element => ({
    innerHTML: '',
    textContent: '',
    value: '',
    classList: { toggle() {}, contains() { return false } },
    addEventListener() {},
    appendChild(child: { innerHTML: string }) { this.innerHTML += child.innerHTML }
  })
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)!
  }
  const fetchStub = (url: string) => {
    const key = String(url).replace('/api/', '')
    if (key in responses) return Promise.resolve(Response.json(responses[key]))
    return Promise.resolve(Response.json({}))
  }
  const client = runInNewContext(
    script + '\n;({ ov, filter: ovFilterTools, pick: ovPickGroup, render: renderTools })',
    {
      document: {
        getElementById: get,
        createElement: element,
        querySelector: get,
        querySelectorAll: () => []
      },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: fetchStub,
      setTimeout: () => 0,
      clearTimeout: () => {}
    }
  ) as {
    ov: { tools: unknown[]; groups: unknown[]; group: string; query: string }
    filter: () => void
    pick: (id: string) => void
    render: () => void
  }
  return { client, get, elements }
}

const TOOLS = [
  { name: 'crypto_status', group: 'crypto', description: 'Current crypto watch state.', params: [] },
  { name: 'gmail_check', group: 'gmail', description: 'Run a read-only IMAP check.', params: [{ name: 'email', type: 'string', required: true, description: 'Gmail address' }] },
  { name: 'gmail_connect', group: 'gmail', description: 'Connect a Gmail account.', params: [] },
  { name: 'llamafarm_score', group: 'llamafarm', description: 'Score catalog models.', params: [] }
]

const GROUPS = [
  { id: 'crypto', label: 'Crypto watch', icon: '◈', hint: 'CoinGecko watchlist' },
  { id: 'gmail', label: 'Gmail announcer', icon: '✉', hint: 'Read-only inbox checks' },
  { id: 'llamafarm', label: 'Model Farm', icon: '⌁', hint: 'Local model catalog' }
]

describe('overview tool surface', () => {
  it('renders every tool of a group when no filter is set', () => {
    const { client, get } = mount()
    client.ov.tools = TOOLS
    client.ov.groups = GROUPS
    client.render()
    const markup = get('ov-tools').innerHTML
    assert.match(markup, /crypto_status/)
    assert.match(markup, /gmail_check/)
    assert.match(markup, /llamafarm_score/)
    assert.equal(get('ov-tool-count').textContent, '4 of 4')
  })

  it('narrows the list to the searched tools', () => {
    const { client, get } = mount()
    client.ov.tools = TOOLS
    client.ov.groups = GROUPS
    get('ov-tool-search').value = 'gmail'
    client.filter()
    const markup = get('ov-tools').innerHTML
    assert.match(markup, /gmail_check/)
    assert.match(markup, /gmail_connect/)
    assert.doesNotMatch(markup, /crypto_status/)
    assert.equal(get('ov-tool-count').textContent, '2 of 4')
  })

  it('keeps the group filter and the text filter working together', () => {
    const { client, get } = mount()
    client.ov.tools = TOOLS
    client.ov.groups = GROUPS
    get('ov-tool-search').value = 'gmail'
    client.filter()
    client.pick('gmail')
    const markup = get('ov-tools').innerHTML
    assert.match(markup, /gmail_check/)
    assert.match(markup, /gmail_connect/)
    assert.doesNotMatch(markup, /crypto_status/)
    assert.doesNotMatch(markup, /llamafarm_score/)
    assert.equal(get('ov-tool-count').textContent, '2 of 4')
  })

  it('excludes the tools of other groups', () => {
    const { client, get } = mount()
    client.ov.tools = TOOLS
    client.ov.groups = GROUPS
    client.pick('crypto')
    const markup = get('ov-tools').innerHTML
    assert.match(markup, /crypto_status/)
    assert.doesNotMatch(markup, /gmail_check/)
  })

  it('says so when nothing matches', () => {
    const { client, get } = mount()
    client.ov.tools = TOOLS
    client.ov.groups = GROUPS
    get('ov-tool-search').value = 'nothing-like-this'
    client.filter()
    assert.match(get('ov-tools').innerHTML, /No tool matches/)
    assert.equal(get('ov-tool-count').textContent, '0 of 4')
  })

  it('shows the parameters of a tool', () => {
    const { client, get } = mount()
    client.ov.tools = TOOLS
    client.ov.groups = GROUPS
    client.pick('gmail')
    const markup = get('ov-tools').innerHTML
    assert.match(markup, /email/)
    assert.match(markup, /required/)
    assert.match(markup, /Gmail address/)
  })
})
