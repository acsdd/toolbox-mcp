import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { runInNewContext } from 'node:vm'
import { after, before, describe, it } from 'node:test'
import { startPanel } from '../dist/panel.js'
import { createServices } from '../dist/services.js'

let services: ReturnType<typeof createServices>
let panel: { port: number; close: () => Promise<void> }
let page = ''

interface Element {
  innerHTML: string
  textContent: string
  value: string
  classList: { toggle(): void; contains(): boolean; add(): void; remove(): void }
  addEventListener(): void
  focus(): void
  appendChild(child: { innerHTML: string }): void
}

interface NavItem {
  label: string
  hidden: boolean
  badge: { textContent: string }
  classList: { contains(): boolean }
  querySelector(selector: string): { textContent: string } | null
}

function navItem(label: string, hidden = false): NavItem {
  const badge = { textContent: '' }
  return {
    label,
    hidden,
    badge,
    classList: { contains: () => hidden },
    querySelector: (selector: string) => (selector === 'small' ? badge : null)
  }
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

after(async () => {
  await panel.close()
  await services.close()
})

const SCRIPT = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]

/**
 * Run the real panel script against a minimal DOM, the way a browser would.
 * Timers are stubbed out: the panel polls its activity feed while the
 * overview is visible, and a test has no reason to wait for that.
 */
function mount(
  responses: Record<string, unknown> = {},
  nav: NavItem[] = [],
  options: { confirm?: (message: string) => boolean } = {}
) {
  const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1]
  assert.ok(script, 'the panel page carries its script')
  const elements = new Map<string, Element>()
  const element = (): Element => ({
    innerHTML: '',
    textContent: '',
    value: '',
    classList: { toggle() {}, contains() { return false }, add() {}, remove() {} },
    addEventListener() {},
    focus() {},
    appendChild(child: { innerHTML: string }) { this.innerHTML += child.innerHTML }
  })
  const get = (id: string) => {
    if (!elements.has(id)) elements.set(id, element())
    return elements.get(id)!
  }
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const fetchStub = (url: string | URL, init?: RequestInit) => {
    const target = String(url)
    requests.push({ url: target, init })
    const key = target.replace('/api/', '')
    const reply = responses[key]
    if (reply instanceof Error) return Promise.reject(reply)
    if (reply instanceof Response) return Promise.resolve(reply)
    return Promise.resolve(Response.json(reply ?? {}))
  }
  const confirmations: string[] = []
  const history = { urls: [] as string[], replaceState(_state: unknown, _title: unknown, url: string) { this.urls.push(url) } }
  const client = runInNewContext(
    script + '\n;({ ov, filter: ovFilterTools, pick: ovPickGroup, clear: ovClearFilter, render: renderTools, section: sectionFromHash, setHash: setSectionHash, termClear: termClear, reset: mfResetFilters, rt: rt, mfState: mf, targets: rtInstallTargets, target: rtInstallTarget, pickTarget: mfPickTarget, astrlink: renderAstrlinkSetup, installMessage: mfInstallMessage, recentHtml: mfRecentHtml, downloadRow: mfDownloadRow, machine: renderMachine, rtRender: rtRender, connect: renderConnect, renumber: renumberNav, gmail: renderGmail, remove: mfRemove, mpInstall: mpInstall, mpUninstall: mpUninstall, marketplace: mp })',
    {
      document: {
        getElementById: get,
        createElement: element,
        querySelector: get,
        querySelectorAll: (selector: string) => (selector === '.navbtn' ? nav : [])
      },
      navigator: { clipboard: { writeText: async () => {} } },
      fetch: fetchStub,
      confirm: (message: string) => {
        confirmations.push(message)
        return options.confirm ? options.confirm(message) : true
      },
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
    astrlink: (id: string, inst: Record<string, unknown>) => string
    installMessage: (body: Record<string, unknown>, ok: boolean, steps: string[]) => string
    recentHtml: (history: Array<Record<string, unknown>>) => string
    downloadRow: (download: Record<string, unknown>) => string
    machine: (machine: Record<string, unknown>, grade: Record<string, unknown> | null) => void
    rtRender: () => void
    connect: (server: Record<string, unknown> | null, attached: boolean) => void
    renumber: () => void
    gmail: (state: Record<string, unknown>) => void
    remove: (id: string, name: string, runtime: string) => Promise<void>
    mpInstall: (id: string) => Promise<void>
    mpUninstall: (id: string) => Promise<void>
    marketplace: {
      data: null | { modules: Array<Record<string, unknown>> }
      busy: boolean
      note: string | null
    }
  }
  return { client, get, elements, history, requests, confirmations }
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

describe('gmail widget error state', () => {
  it('shows the real credential error instead of first-run setup copy', () => {
    const { client, get } = mount()
    client.gmail({ configured: false, error: 'Credential vault <locked>', unread: 0, messages: [] })
    assert.equal(get('ov-gmail-meta').textContent, 'not connected')
    assert.match(get('gmail').innerHTML, /Credential vault &lt;locked&gt;/)
    assert.doesNotMatch(get('gmail').innerHTML, /No Gmail account is connected/)
  })

  it('keeps the setup guidance when there is no service error', () => {
    const { client, get } = mount()
    client.gmail({ configured: false, error: null, unread: 0, messages: [] })
    assert.match(get('gmail').innerHTML, /gmail_connect/)
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

describe('model farm runtime status', () => {
  const MACHINE = {
    availableRamBytes: 8 * 1024 ** 3,
    totalRamBytes: 16 * 1024 ** 3,
    cores: 8,
    gpus: [],
    freeDiskBytes: 100 * 1024 ** 3,
    // The score probe can fail while the runtime scan still finds an install.
    ollama: { installed: false, models: [], error: 'fetch failed' }
  }

  it('says an installed runtime has no server running', () => {
    const { client, get } = mount()
    client.rt.data = {
      active: 'ollama',
      runtimes: [
        { id: 'ollama', label: 'Ollama', installed: true, running: false, version: '0.12.3', models: [], note: 'Pulls any GGUF.' },
        { id: 'jan', label: 'Jan', installed: false, running: false, models: [], note: 'Not here.' }
      ]
    }
    client.rtRender()
    const html = get('rt-list')!.innerHTML
    assert.match(html, /installed · server not running · 0\.12\.3/)
    assert.match(html, /<small>not found<\/small>/)
    // The missing runtime sits in the folded list, not next to the found one.
    assert.ok(html.indexOf('Ollama') < html.indexOf('<details'))
    assert.match(html, /Other runtimes \(1\)/)
    assert.match(get('rt-meta')!.textContent, /^1 of 2 found$/)
  })

  it('opens the folded list when nothing is found', () => {
    const { client, get } = mount()
    client.rt.data = {
      active: null,
      runtimes: [
        { id: 'ollama', label: 'Ollama', installed: false, running: false, models: [], note: 'Missing.' },
        { id: 'jan', label: 'Jan', installed: false, running: false, models: [], note: 'Missing.' }
      ]
    }
    client.rtRender()
    const html = get('rt-list')!.innerHTML
    assert.match(get('rt-meta')!.textContent, /^0 of 2 found$/)
    assert.match(html, /No local runtime found yet/)
    assert.match(html, /<details class="rt-more" open>/)
    assert.match(html, /Other runtimes \(2\)/)
  })

  it('keeps the active runtime visible even when it is missing', () => {
    const { client, get } = mount()
    client.rt.data = {
      active: 'jan',
      runtimes: [
        { id: 'ollama', label: 'Ollama', installed: true, running: true, models: [], note: '' },
        { id: 'jan', label: 'Jan', installed: false, running: false, models: [], note: 'Not here.' },
        { id: 'vllm', label: 'vLLM', installed: false, running: false, models: [], note: 'Not here.' }
      ]
    }
    client.rtRender()
    const html = get('rt-list')!.innerHTML
    assert.ok(html.indexOf('Jan') < html.indexOf('<details'))
    assert.match(html, /Other runtimes \(1\)/)
    assert.match(get('rt-meta')!.textContent, /^1 of 3 found$/)
  })

  it('uses the runtime scan for the Ollama chip', () => {
    const { client, get } = mount()
    client.rt.data = {
      active: 'ollama',
      runtimes: [{ id: 'ollama', label: 'Ollama', installed: true, running: false, models: [], note: '' }]
    }
    client.machine(MACHINE, null)
    const html = get('mf-machine')!.innerHTML
    assert.match(html, /OLLAMA<\/span><b>installed · server not running<\/b>/)
    assert.doesNotMatch(html, /fetch failed/)
    assert.match(html, /ACTIVE RUNTIME<\/span><b>Ollama · installed · server not running<\/b>/)
  })

  it('reports a serving Ollama with its model count', () => {
    const { client, get } = mount()
    client.rt.data = {
      active: 'ollama',
      runtimes: [{
        id: 'ollama', label: 'Ollama', installed: true, running: true, note: '',
        models: [{ name: 'llama3', sizeBytes: 1, modifiedAt: null }]
      }]
    }
    client.machine(MACHINE, null)
    const html = get('mf-machine')!.innerHTML
    assert.match(html, /OLLAMA<\/span><b>running · 1 models<\/b>/)
    assert.match(html, /ACTIVE RUNTIME<\/span><b>Ollama · running<\/b>/)
  })
})

describe('model farm install result', () => {
  const setup = {
    baseUrl: 'http://127.0.0.1:8080/v1',
    model: 'ornith-1.5-9b',
    capability: 'openai.chat'
  }

  it('names the runtime and its address in the AstrLink setup', () => {
    const { client } = mount()
    const html = client.astrlink('acme/model', {
      state: 'ok',
      message: '',
      runtime: { id: 'llamacpp', label: 'llama.cpp', baseUrl: 'http://127.0.0.1:8080' },
      astrlink: setup
    })
    assert.match(html, /llama\.cpp/)
    assert.match(html, /127\.0\.0\.1:8080\/v1/)
    // The old copy claimed this was Ollama's address no matter the runtime.
    assert.doesNotMatch(html, /Ollama/)
  })

  it('keeps the service explanation and the next step together', () => {
    const { client } = mount()
    const text = client.installMessage(
      { message: 'ornith is ready to run. Ollama could not use the Q8 tag, so it installed the default.' },
      true,
      ['ollama pull hf.co/acme/model', 'ollama run hf.co/acme/model']
    )
    assert.match(text, /could not use the Q8 tag/)
    assert.match(text, /ollama run hf\.co\/acme\/model/)
  })

  it('does not repeat a step the message already names', () => {
    const { client } = mount()
    const text = client.installMessage(
      { message: 'Run ollama run hf.co/acme/model to start it.' },
      true,
      ['ollama run hf.co/acme/model']
    )
    assert.equal(text, 'Run ollama run hf.co/acme/model to start it.')
  })

  it('reports the service error when the install failed', () => {
    const { client } = mount()
    const text = client.installMessage({ error: 'Not enough disk at /models.' }, false, ['ignored'])
    assert.equal(text, 'Not enough disk at /models.')
  })
})

describe('model farm runtime names', () => {
  const runtimes = {
    active: 'ollama',
    runtimes: [
      { id: 'ollama', label: 'Ollama', installed: true, running: true },
      { id: 'lmstudio', label: 'LM Studio', installed: true, running: false }
    ]
  }

  it('names the runtime in the recently-installed strip', () => {
    const { client } = mount()
    client.rt.data = runtimes
    const html = client.recentHtml([
      { repo: 'acme/model', label: 'acme model', runtime: 'lmstudio', installedAt: Date.now() }
    ])
    assert.match(html, /LM Studio/)
    assert.match(html, /acme model/)
    // The stored id is an implementation detail, not something to show.
    assert.doesNotMatch(html, /· lmstudio/)
  })

  it('falls back to the stored id until detection lands', () => {
    const { client } = mount()
    const html = client.recentHtml([
      { repo: 'acme/model', label: 'acme model', runtime: 'lmstudio', installedAt: Date.now() }
    ])
    assert.match(html, /· lmstudio/)
  })

  it('names the runtime in a running transfer and offers cancel when possible', () => {
    const { client } = mount()
    client.rt.data = runtimes
    const row = client.downloadRow({
      repo: 'acme/model', runtime: 'lmstudio', percent: 42, receivedBytes: 1000, totalBytes: 2000
    })
    assert.match(row, /LM Studio/)
    assert.doesNotMatch(row, /→ lmstudio/)
    assert.match(row, /42%/)
    assert.match(row, /Cancel download of acme\/model/)
  })

  it('does not offer a cancel that Ollama cannot honour', () => {
    const { client } = mount()
    client.rt.data = runtimes
    const row = client.downloadRow({
      repo: 'acme/other', runtime: 'ollama', percent: null, receivedBytes: 0, totalBytes: 0
    })
    assert.match(row, /Ollama/)
    assert.match(row, /no cancel/)
    assert.match(row, /cannot be cancelled here/)
    assert.doesNotMatch(row, /mfCancel/)
  })
})

describe('connect an MCP client', () => {
  const SERVER = {
    client: {
      command: 'C:\Program Files\nodejs\node.exe',
      args: ['D:\toolbox-mcp\dist\index.js'],
      config: '{\n  "mcpServers": {\n    "toolbox": {}\n  }\n}'
    }
  }

  it('shows the configuration for this installation and reports the client state', () => {
    const { client, get } = mount()
    client.connect(SERVER, true)
    assert.match(get('ov-connect-meta')!.textContent, /client attached/)
    assert.equal(get('ov-connect-config')!.textContent, SERVER.client.config)
    assert.match(get('ov-connect-note')!.textContent, /mcpServers/)
    assert.match(get('ov-connect-note')!.textContent, /own copy/)
  })

  it('says when a client is not attached yet', () => {
    const { client, get } = mount()
    client.connect(SERVER, false)
    assert.match(get('ov-connect-meta')!.textContent, /panel only/)
  })

  it('explains a portable build instead of showing a temporary path', () => {
    const { client, get } = mount()
    client.connect({
      client: {
        command: 'C:\Users\you\AppData\Local\Temp\abc\Model Farm.exe',
        args: [],
        reason: 'Portable builds extract to a temporary folder; install the app or use a source checkout.'
      }
    }, false)
    assert.match(get('ov-connect-meta')!.textContent, /not available/)
    assert.match(get('ov-connect-note')!.textContent, /Portable builds/)
    assert.match(get('ov-connect-note')!.textContent, /install the app/)
  })
})

describe('destructive panel actions', () => {
  it('cancels Ollama model removal without sending a request', async () => {
    const { client, requests, confirmations } = mount({}, [], { confirm: () => false })
    await client.remove('acme/model', 'acme/model:latest', 'ollama')
    assert.equal(confirmations.length, 1)
    assert.match(confirmations[0] ?? '', /acme\/model:latest/)
    assert.match(confirmations[0] ?? '', /Ollama/)
    assert.match(confirmations[0] ?? '', /cannot be undone/i)
    assert.equal(requests.some((request) => request.url === '/api/llamafarm/remove'), false)
  })

  it('removes the named Ollama model only after confirmation', async () => {
    const { client, requests, confirmations } = mount({ 'llamafarm/remove': { ok: true, message: 'Removed' } })
    await client.remove('acme/model', 'acme/model:latest', 'ollama')
    assert.equal(confirmations.length, 1)
    const removal = requests.find((request) => request.url === '/api/llamafarm/remove')
    assert.ok(removal)
    assert.deepEqual(JSON.parse(String(removal.init?.body)), { model: 'acme/model:latest', runtime: 'ollama' })
  })

  function marketplaceMount(confirm: () => boolean) {
    const module = {
      id: 'cve-now', type: 'remote-server', name: 'cve.now', description: 'Vulnerability feed', version: '1.0.0',
      author: 'Sazabi', categories: ['security'], tags: ['cve'], installed: true, builtIn: false,
      endpoint: 'https://mcp.cve.now/mcp', homepage: 'https://example.com'
    }
    const mounted = mount({ 'marketplace/list?q=&category=': { modules: [module], categories: ['security'], error: null } }, [], { confirm })
    mounted.client.marketplace.data = { modules: [module] }
    mounted.client.marketplace.selected = 'cve-now'
    return mounted
  }

  it('cancels Marketplace uninstall without disconnecting anything', async () => {
    const { client, requests, confirmations } = marketplaceMount(() => false)
    await client.mpUninstall('cve-now').catch(() => {})
    assert.equal(confirmations.length, 1)
    assert.match(confirmations[0] ?? '', /cve\.now/)
    assert.match(confirmations[0] ?? '', /remote tools.*disconnect/i)
    assert.match(confirmations[0] ?? '', /settings.*kept/i)
    assert.equal(requests.some((request) => request.url === '/api/marketplace/uninstall'), false)
  })

  it('uninstalls the named Marketplace module only after confirmation', async () => {
    const { client, requests, confirmations } = marketplaceMount(() => true)
    await client.mpUninstall('cve-now')
    assert.equal(confirmations.length, 1)
    const removal = requests.find((request) => request.url === '/api/marketplace/uninstall')
    assert.ok(removal)
    assert.deepEqual(JSON.parse(String(removal.init?.body)), { id: 'cve-now' })
    assert.match(client.marketplace.note ?? '', /Uninstalled/)
  })
})

describe('Marketplace mutation recovery', () => {
  it('re-enables Install after a network failure and explains how to retry', async () => {
    const { client, requests } = mount({ 'marketplace/install': new Error('network offline') })
    await client.mpInstall('cve-now').catch(() => {})
    assert.equal(client.marketplace.busy, false)
    assert.match(client.marketplace.note ?? '', /install failed.*network offline.*try again/i)
    assert.equal(requests.some((request) => request.url.startsWith('/api/marketplace/list')), false)
  })

  it('re-enables Install after a non-JSON HTTP error', async () => {
    const { client, requests } = mount({
      'marketplace/install': new Response('service unavailable', { status: 503 })
    })
    await client.mpInstall('cve-now').catch(() => {})
    assert.equal(client.marketplace.busy, false)
    assert.match(client.marketplace.note ?? '', /install failed.*503.*try again/i)
    assert.doesNotMatch(client.marketplace.note ?? '', /^Installed/)
    assert.equal(requests.some((request) => request.url.startsWith('/api/marketplace/list')), false)
  })

  it('re-enables Uninstall after a network failure', async () => {
    const { client, requests } = mount({ 'marketplace/uninstall': new Error('network offline') })
    await client.mpUninstall('cve-now').catch(() => {})
    assert.equal(client.marketplace.busy, false)
    assert.match(client.marketplace.note ?? '', /uninstall failed.*network offline.*try again/i)
    assert.equal(requests.some((request) => request.url.startsWith('/api/marketplace/list')), false)
  })

  it('re-enables Uninstall after a non-JSON HTTP error', async () => {
    const { client, requests } = mount({
      'marketplace/uninstall': new Response('service unavailable', { status: 502 })
    })
    await client.mpUninstall('cve-now').catch(() => {})
    assert.equal(client.marketplace.busy, false)
    assert.match(client.marketplace.note ?? '', /uninstall failed.*502.*try again/i)
    assert.doesNotMatch(client.marketplace.note ?? '', /Uninstalled/)
    assert.equal(requests.some((request) => request.url.startsWith('/api/marketplace/list')), false)
  })
})

describe('section numbering', () => {
  const labels = ['overview', 'models', 'terminal', 'marketplace', 'gateway', 'settings']

  it('numbers only the sections that are on screen', () => {
    const nav = labels.map((label) => navItem(label, label === 'gateway'))
    const { client } = mount({}, nav)
    client.renumber()
    assert.deepEqual(nav.map((item) => item.badge.textContent), ['01', '02', '03', '04', '', '05'])
  })

  it('numbers every section while the gateway is installed', () => {
    const nav = labels.map((label) => navItem(label))
    const { client } = mount({}, nav)
    client.renumber()
    assert.deepEqual(nav.map((item) => item.badge.textContent), ['01', '02', '03', '04', '05', '06'])
  })
})
