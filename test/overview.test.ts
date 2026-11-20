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
  focus(): void
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
    focus() {},
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
  const history = { urls: [] as string[], replaceState(_state: unknown, _title: unknown, url: string) { this.urls.push(url) } }
  const client = runInNewContext(
    script + '\n;({ ov, filter: ovFilterTools, pick: ovPickGroup, clear: ovClearFilter, render: renderTools, section: sectionFromHash, setHash: setSectionHash, termClear: termClear, reset: mfResetFilters, rt: rt, mfState: mf, targets: rtInstallTargets, target: rtInstallTarget, pickTarget: mfPickTarget })',
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
      clearTimeout: () => {},
      location: { hash: '' },
      history
    }
  ) as {
    ov: { tools: unknown[]; groups: unknown[]; group: string; query: string }
    filter: () => void
    pick: (id: string) => void
    clear: () => void
    render: () => void
    section: (hash: string) => string
    setHash: (name: string) => void
    termClear: () => void
    reset: () => void
    rt: { data: null | { active?: string | null; runtimes?: Array<Record<string, unknown>> } }
    mfState: { installTarget: string | null }
    targets: () => Array<{ id: string; label: string }>
    target: () => string
    pickTarget: (select: { value: string }) => void
  }
  return { client, get, elements, history }
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

  it('clears the search text and the picked group together', () => {
    const { client, get } = mount()
    client.ov.tools = TOOLS
    client.ov.groups = GROUPS
    get('ov-tool-search').value = 'gmail'
    client.filter()
    client.pick('gmail')
    client.clear()
    assert.equal(client.ov.query, '')
    assert.equal(client.ov.group, '')
    assert.equal(get('ov-tool-search').value, '')
    assert.equal(get('ov-tool-count').textContent, '4 of 4')
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

describe('panel sections and filters', () => {
  it('turns a section name into a linkable address', () => {
    const { client, history } = mount()
    assert.equal(client.section('#models'), 'models')
    assert.equal(client.section('#terminal'), 'terminal')
    assert.equal(client.section('#settings'), 'settings')
    assert.equal(client.section('#elsewhere'), 'overview')
    assert.equal(client.section(''), 'overview')
    client.setHash('marketplace')
    assert.deepEqual(history.urls, ['#marketplace'])
  })

  it('clears only the terminal scrollback', () => {
    const { client, get } = mount()
    get('term-out').textContent = 'PS C:\\> echo hi\nhi'
    client.termClear()
    assert.equal(get('term-out').textContent, '')
  })

  it('resets every model filter back to the whole catalog', () => {
    const { client, get } = mount()
    get('f-search').value = 'llama'
    get('f-min').value = '33'
    get('f-max').value = '7'
    client.reset()
    assert.equal(get('f-search').value, '')
    assert.equal(get('f-min').value, '')
    assert.equal(get('f-max').value, '')
    assert.equal(get('mf-status').innerHTML, 'scoring…')
  })
})

describe('model farm install target', () => {
  it('offers the runtimes found here and defaults to the active one', () => {
    const { client } = mount()
    client.rt.data = {
      active: 'lmstudio',
      runtimes: [
        { id: 'ollama', label: 'Ollama', installed: true, running: true },
        { id: 'lmstudio', label: 'LM Studio', installed: true, running: false },
        { id: 'jan', label: 'Jan', installed: false, running: false }
      ]
    }
    // The VM has its own prototypes, so compare the shape, not the realm.
    assert.deepEqual(JSON.parse(JSON.stringify(client.targets())), [
      { id: 'ollama', label: 'Ollama' },
      { id: 'lmstudio', label: 'LM Studio' }
    ])
    assert.equal(client.target(), 'lmstudio')
  })

  it('keeps an explicit pick while it is still found', () => {
    const { client } = mount()
    client.rt.data = {
      active: 'ollama',
      runtimes: [
        { id: 'ollama', label: 'Ollama', installed: true, running: true },
        { id: 'lmstudio', label: 'LM Studio', installed: true, running: false }
      ]
    }
    client.mfState.installTarget = 'lmstudio'
    assert.equal(client.target(), 'lmstudio')
    client.pickTarget({ value: 'ollama' })
    assert.equal(client.mfState.installTarget, 'ollama')
    assert.equal(client.target(), 'ollama')
  })

  it('falls back to the active runtime when a pick disappears', () => {
    const { client } = mount()
    client.rt.data = {
      active: 'ollama',
      runtimes: [
        { id: 'ollama', label: 'Ollama', installed: true, running: true },
        { id: 'lmstudio', label: 'LM Studio', installed: false, running: false }
      ]
    }
    client.mfState.installTarget = 'lmstudio'
    assert.equal(client.target(), 'ollama')
  })

  it('stays on Ollama before detection has run', () => {
    const { client } = mount()
    assert.deepEqual(JSON.parse(JSON.stringify(client.targets())), [{ id: 'ollama', label: 'Ollama' }])
    assert.equal(client.target(), 'ollama')
  })
})
