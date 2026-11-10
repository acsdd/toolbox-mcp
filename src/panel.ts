/**
 * Localhost ops panel for toolbox-mcp: JSON API + single-page UI in the
 * "vrm AIO" dark-green design language. Sections: Overview (shared widgets),
 * Model Farm (HuggingFace catalog fit-scored against this machine) and a
 * Terminal (local shell session streamed over SSE).
 * Binds to 127.0.0.1 only. MCP clients talk stdio; humans use the panel.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { Services } from './services.js'
import { createTerminal } from './terminal.js'

const PANEL_PORT = Number(process.env.TOOLBOX_MCP_PORT ?? 3851)

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>toolbox-mcp · ops panel</title>
<style>
  @import url("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&display=swap");
  :root {
    --bg: #070d0a; --panel: #0b1510; --panel2: #0a110e; --border: #203a2d;
    --text: #d9dfda; --muted: #67746b; --dim: #41554b; --accent: #9cf37e;
    --green: #92ec74; --yellow: #e8c35c; --red: #ff5f62;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 13px/1.5 "IBM Plex Mono", ui-monospace, monospace; }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

  .shell { display: grid; grid-template: 58px 1fr / 216px minmax(0, 1fr); height: 100vh; }
  .topbar { grid-column: 1 / -1; display: flex; align-items: center; gap: 24px; padding: 0 24px; background: var(--panel2); border-bottom: 1px solid var(--border); }
  .brand { font-size: 17px; font-weight: 600; letter-spacing: .02em; }
  .brand b { color: var(--accent); font-weight: 600; }
  .brand small { display: block; margin-top: 2px; color: var(--dim); font-size: 9px; letter-spacing: .08em; }
  .topbar .spacer { flex: 1; }
  .badge { padding: 5px 12px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); font-size: 10px; }

  .sidebar { grid-row: 2; display: flex; flex-direction: column; gap: 6px; padding: 20px 14px; background: var(--panel2); border-right: 1px solid var(--border); }
  .navbtn { display: grid; grid-template-columns: 28px 1fr auto; align-items: center; min-height: 46px; padding: 0 12px; border: 0; border-radius: 2px; background: transparent; color: #71847a; text-align: left; }
  .navbtn i { font-style: normal; font-size: 17px; }
  .navbtn small { color: var(--dim); font-size: 9px; }
  .navbtn:hover { color: #a4c69f; background: #102017; }
  .navbtn.active { color: var(--accent); background: #183024; box-shadow: inset 2px 0 0 var(--accent); }
  .sidebar .foot { margin-top: auto; padding: 12px; border: 1px solid var(--border); border-radius: 3px; color: var(--dim); font-size: 9px; line-height: 1.8; }
  .sidebar .foot b { color: var(--muted); font-weight: 400; }

  main { overflow: auto; padding: 24px 26px 40px; min-width: 0; }
  h1 { margin: 0 0 4px; font-size: 24px; font-weight: 500; }
  .sub { margin: 0 0 18px; color: var(--muted); font-size: 11px; }
  .hidden { display: none !important; }

  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 14px; }
  .card { border: 1px solid var(--border); border-radius: 7px; background: var(--panel); overflow: hidden; }
  .card h2 { margin: 0; padding: 14px 16px; border-bottom: 1px solid #16271e; font-size: 11px; font-weight: 400; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); display: flex; justify-content: space-between; }
  .card pre { margin: 0; padding: 14px 16px; white-space: pre-wrap; word-break: break-word; font-size: 11px; color: #b8c3ba; max-height: 300px; overflow: auto; }
  .card .actions { padding: 0 16px 14px; display: flex; gap: 10px; }
  .btn { min-height: 36px; padding: 0 16px; border: 1px solid var(--border); border-radius: 3px; background: #0d1a13; color: #a4c69f; font-size: 11px; }
  .btn:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: #183024; color: var(--accent); }
  .btn:disabled { opacity: .45; cursor: default; }

  /* model farm */
  .mf-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 14px; }
  .seg { display: flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
  .seg button { min-height: 38px; padding: 0 18px; border: 0; background: var(--panel2); color: var(--muted); font-size: 11px; }
  .seg button.on { background: #183024; color: var(--accent); }
  .mf-bar label { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 10px; }
  .mf-bar select, .mf-bar input[type="search"] { min-height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--panel2); color: var(--text); font-size: 12px; }
  .mf-bar input[type="search"] { width: 220px; }
  .mf-status { width: 100%; color: var(--dim); font-size: 10px; }
  .mf-status .err { color: var(--red); }
  .machine { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  .chip { display: flex; flex-direction: column; gap: 3px; min-width: 130px; padding: 10px 14px; border: 1px solid var(--border); border-radius: 5px; background: var(--panel); }
  .chip span { color: var(--dim); font-size: 9px; letter-spacing: .06em; }
  .chip b { color: var(--text); font-size: 13px; font-weight: 500; }
  .chip b em { color: var(--green); font-style: normal; }

  .mf-cols { display: flex; gap: 14px; align-items: flex-start; overflow-x: auto; padding-bottom: 10px; }
  .mf-col { flex: 0 0 300px; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); overflow: hidden; }
  .mf-col h3 { display: flex; align-items: center; gap: 8px; margin: 0; padding: 12px 14px; border-bottom: 1px solid #16271e; font-size: 11px; font-weight: 400; color: var(--muted); }
  .mf-col h3 i { font-style: normal; color: var(--accent); }
  .mf-col h3 small { margin-left: auto; color: var(--dim); font-size: 9px; }
  .mrow { width: 100%; display: flex; align-items: flex-start; gap: 10px; min-height: 46px; padding: 8px 12px; border: 0; border-bottom: 1px solid #132219; background: transparent; text-align: left; }
  .mrow:hover { background: #102017; }
  .mrow .dot { flex: 0 0 auto; width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; }
  .v-green .dot { background: var(--green); box-shadow: 0 0 6px rgba(146, 236, 116, .5); }
  .v-yellow .dot { background: var(--yellow); }
  .v-red .dot { background: var(--red); }
  .mrow .nm { flex: 1; min-width: 0; }
  .mrow .nm b { display: block; color: #c3cec5; font-weight: 400; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mrow .nm small { color: var(--dim); font-size: 9px; }
  .mdetail { padding: 10px 12px 12px 30px; border-bottom: 1px solid #132219; background: #0a130e; font-size: 10px; color: var(--muted); }
  .mdetail p { margin: 0 0 8px; }
  .mdetail ul { margin: 0 0 8px; padding-left: 16px; }
  .mdetail li { margin: 3px 0; color: #9fb3a4; }
  .mdetail a { color: var(--accent); }
  .mf-note { padding: 10px 14px; color: var(--dim); font-size: 10px; }
  .mf-note button { border: 0; background: none; color: var(--accent); font-size: 10px; padding: 4px 0; }

  /* marketplace */
  .mp-layout { display: grid; grid-template-columns: minmax(320px, 430px) minmax(0, 1fr); gap: 14px; align-items: start; }
  .mp-list { border: 1px solid var(--border); border-radius: 7px; background: var(--panel); overflow: hidden; }
  .mp-item { width: 100%; display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; min-height: 66px; border: 0; border-bottom: 1px solid #132219; background: transparent; text-align: left; }
  .mp-item:hover { background: #102017; }
  .mp-item.sel { background: #183024; box-shadow: inset 2px 0 0 var(--accent); }
  .mp-icon { flex: 0 0 42px; height: 42px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 6px; background: #0d1a13; color: var(--accent); font-size: 21px; }
  .mp-item .mp-meta { flex: 1; min-width: 0; }
  .mp-item .mp-meta b { display: block; color: #c3cec5; font-weight: 500; font-size: 12px; }
  .mp-item .mp-meta small { display: block; color: var(--dim); font-size: 9px; margin-top: 2px; }
  .mp-item .mp-meta p { margin: 4px 0 0; color: var(--muted); font-size: 10px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-state { flex: 0 0 auto; margin-top: 4px; padding: 4px 10px; border-radius: 3px; font-size: 9px; border: 1px solid var(--border); color: var(--muted); }
  .mp-state.installed { color: var(--green); border-color: #2a4935; }
  .mp-detail { border: 1px solid var(--border); border-radius: 7px; background: var(--panel); padding: 22px; min-height: 320px; }
  .mp-detail .mp-head { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; }
  .mp-detail .mp-icon { flex-basis: 56px; height: 56px; font-size: 28px; }
  .mp-detail h2 { margin: 0; font-size: 18px; font-weight: 500; }
  .mp-detail .mp-by { color: var(--dim); font-size: 10px; margin-top: 3px; }
  .mp-detail .mp-desc { color: #a6b4aa; font-size: 12px; line-height: 1.7; margin: 0 0 14px; }
  .mp-detail .mp-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .mp-detail .mp-tags span { padding: 4px 10px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); font-size: 9px; }
  .mp-detail .mp-actions { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .mp-detail .mp-note { color: var(--yellow); font-size: 10px; margin: 0 0 10px; }
  .mp-detail a { color: var(--accent); font-size: 10px; }
  .mp-detail .mp-empty { color: var(--dim); font-size: 11px; padding: 40px 0; text-align: center; }
  .mp-skel { display: flex; gap: 12px; padding: 12px 14px; border-bottom: 1px solid #132219; }
  .mp-skel i { display: block; width: 42px; height: 42px; border-radius: 6px; background: #102017; animation: mp-pulse 1.2s ease-in-out infinite; }
  .mp-skel div { flex: 1; }
  .mp-skel div b, .mp-skel div s { display: block; height: 10px; border-radius: 3px; background: #102017; animation: mp-pulse 1.2s ease-in-out infinite; }
  .mp-skel div b { width: 55%; margin-bottom: 8px; }
  .mp-skel div s { width: 85%; text-decoration: none; }
  @keyframes mp-pulse { 50% { opacity: .4; } }
  @media (max-width: 1100px) { .mp-layout { grid-template-columns: 1fr; } }

  /* terminal */
  .term { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 7px; background: #050a07; overflow: hidden; }
  .term-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: 10px; }
  .term-head .spacer { flex: 1; }
  .term-head .btn { min-height: 30px; padding: 0 12px; font-size: 10px; }
  .term-out { flex: 1; height: 480px; margin: 0; padding: 14px 16px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: 12px; line-height: 1.55; color: #b9e3b0; background: transparent; }
  .term-line { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); }
  .term-line span { color: var(--accent); }
  .term-line input { flex: 1; min-height: 38px; border: 0; background: transparent; color: var(--text); font-size: 12px; }
  .term-line input:focus { outline: none; }

  @media (max-width: 860px) {
    .shell { grid-template: 58px 1fr / 1fr; }
    .sidebar { display: none; }
    .mf-bar input[type="search"] { width: 100%; }
  }
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand"><b>vrm</b> toolbox-mcp<small>ALL SYSTEMS. ONE TERMINAL.</small></div>
    <div class="spacer"></div>
    <span class="badge">127.0.0.1 ONLY · LOCAL</span>
  </header>

  <aside class="sidebar">
    <button class="navbtn active" data-nav="overview"><i>▣</i><span>Overview</span><small>01</small></button>
    <button class="navbtn" data-nav="models"><i>⌁</i><span>Model Farm</span><small>02</small></button>
    <button class="navbtn" data-nav="terminal"><i>❯</i><span>Terminal</span><small>03</small></button>
    <button class="navbtn" data-nav="marketplace"><i>▦</i><span>Marketplace</span><small>04</small></button>
    <div class="foot"><b>SESSION</b><br />operator@vrm<br />Local access · stdio + panel</div>
  </aside>

  <main>
    <section id="sec-overview">
      <h1>System overview</h1>
      <p class="sub">Shared Toolbox widgets, live from this machine.</p>
      <div class="card-grid">
        <div class="card" data-widget="crypto-watch"><h2>Crypto watch</h2><pre id="crypto">…</pre><div class="actions"><button class="btn" onclick="act('crypto_refresh','crypto')">Refresh prices</button></div></div>
        <div class="card" data-widget="gmail-announcer"><h2>Gmail announcer</h2><pre id="gmail">…</pre><div class="actions"><button class="btn" onclick="act('gmail_check','gmail')">Check inbox</button></div></div>
        <div class="card" data-widget="resource-monitor"><h2>Resource monitor</h2><pre id="resource">…</pre><div class="actions"><button class="btn" onclick="act('system_stats','resource')">Refresh stats</button></div></div>
        <div class="card"><h2>Widget bundle</h2><pre id="bundle">…</pre><div class="actions"><button class="btn" onclick="loadBundle()">Export widgets</button></div></div>
      </div>
    </section>

    <section id="sec-models" class="hidden">
      <h1>Model Farm</h1>
      <p class="sub">HuggingFace models fit-scored against this machine. Filters mark live; submit for the ordered verdict.</p>
      <div class="mf-bar">
        <div class="seg" role="group" aria-label="Scenario">
          <button id="sc-now" class="on" onclick="setScenario('now')">NOW</button>
          <button id="sc-total" onclick="setScenario('total')">TOTAL</button>
        </div>
        <label>min <select id="f-min" onchange="setRange()">
          <option value="">any</option><option value="1">1B+</option><option value="3">3B+</option>
          <option value="7">7B+</option><option value="13">13B+</option><option value="33">33B+</option><option value="70">70B+</option>
        </select></label>
        <label>max <select id="f-max" onchange="setRange()">
          <option value="">any</option><option value="3">3B</option><option value="7">7B</option>
          <option value="13">13B</option><option value="33">33B</option><option value="70">70B</option>
        </select></label>
        <input type="search" id="f-search" placeholder="search models…" oninput="setSearch()" />
        <button class="btn primary" onclick="mfSubmit()">Submit filter</button>
        <button class="btn" onclick="mfRefresh()">Refresh catalog</button>
        <div class="mf-status" id="mf-status">warming up…</div>
      </div>
      <div class="machine" id="mf-machine"></div>
      <div class="mf-cols" id="mf-cols"></div>
    </section>

    <section id="sec-terminal" class="hidden">
      <h1>Terminal</h1>
      <p class="sub">Local shell on this machine. It's yours — be careful.</p>
      <div class="term">
        <div class="term-head">
          <span id="term-state">not started</span>
          <div class="spacer"></div>
          <button class="btn" onclick="termStart()">Start</button>
          <button class="btn" onclick="termStop()">Stop</button>
        </div>
        <pre class="term-out" id="term-out"></pre>
        <div class="term-line">
          <span>❯</span>
          <input id="term-in" autocomplete="off" spellcheck="false" placeholder="type a command, Enter to run, ↑ history, Ctrl+C to interrupt" />
        </div>
      </div>
    </section>
    <section id="sec-marketplace" class="hidden">
      <h1>Marketplace</h1>
      <p class="sub">Shared Toolbox modules, live from the family registry. Search filters as you type.</p>
      <div class="mf-bar">
        <input type="search" id="mp-search" placeholder="search modules…" oninput="mpSetSearch()" />
        <label>category <select id="mp-category" onchange="mpSetCategory()"><option value="">all</option></select></label>
        <button class="btn" onclick="mpRefresh()">Refresh registry</button>
        <div class="mf-status" id="mp-status">loading registry…</div>
      </div>
      <div class="mp-layout">
        <div class="mp-list" id="mp-list"></div>
        <div class="mp-detail" id="mp-detail"><div class="mp-empty">select a module to see details</div></div>
      </div>
    </section>
  </main>
</div>

<script>
var mf = { scenario: 'now', search: '', min: null, max: null, submitted: false, showReds: false, timer: null, expanded: {} }
var lastResult = null

function show(name) {
  document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.toggle('active', b.dataset.nav === name) })
  ;['overview', 'models', 'terminal', 'marketplace'].forEach(function (s) {
    document.getElementById('sec-' + s).classList.toggle('hidden', s !== name)
  })
  if (name === 'models' && !lastResult) mfLoad()
  if (name === 'terminal') termAutoStart()
  if (name === 'marketplace' && !mp.data) mpLoad()
}
document.querySelectorAll('.navbtn').forEach(function (b) { b.onclick = function () { show(b.dataset.nav) } })

/* ---- overview ---- */
async function act(action, target) {
  var res = await fetch('/api/' + action, { method: 'POST' })
  document.getElementById(target).textContent = JSON.stringify(await res.json(), null, 2)
}
async function loadBundle() {
  var res = await fetch('/api/widgets_export')
  document.getElementById('bundle').textContent = await res.text()
}
async function bootOverview() {
  var res = await fetch('/api/overview')
  var data = await res.json()
  document.getElementById('crypto').textContent = JSON.stringify(data.crypto, null, 2)
  document.getElementById('gmail').textContent = JSON.stringify(data.gmail, null, 2)
  document.getElementById('resource').textContent = JSON.stringify(data.resource, null, 2)
  var installed = data.installed || []
  document.querySelectorAll('[data-widget]').forEach(function (card) {
    card.classList.toggle('hidden', installed.indexOf(card.dataset.widget) === -1)
  })
  loadBundle()
}
bootOverview()

/* ---- model farm ---- */
function gb(bytes) { return (bytes / Math.pow(2, 30)).toFixed(1) + ' GB' }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }

function setScenario(sc) {
  mf.scenario = sc
  document.getElementById('sc-now').classList.toggle('on', sc === 'now')
  document.getElementById('sc-total').classList.toggle('on', sc === 'total')
  queueLoad()
}
function setRange() {
  mf.min = document.getElementById('f-min').value ? Number(document.getElementById('f-min').value) : null
  mf.max = document.getElementById('f-max').value ? Number(document.getElementById('f-max').value) : null
  queueLoad()
}
function setSearch() {
  mf.search = document.getElementById('f-search').value
  queueLoad()
}
function queueLoad() {
  clearTimeout(mf.timer)
  mf.timer = setTimeout(mfLoad, 150)
}
async function mfLoad() {
  var status = document.getElementById('mf-status')
  status.innerHTML = 'scoring…'
  var body = {
    scenario: mf.scenario,
    search: mf.search || undefined,
    minParams: mf.min,
    maxParams: mf.max,
    onlyReachable: mf.submitted && !mf.showReds
  }
  var res = await fetch('/api/llamafarm/score', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  lastResult = await res.json()
  if (!lastResult.groups) {
    status.innerHTML = '<span class="err">' + esc(lastResult.error || 'request failed') + '</span>'
    return
  }
  renderMachine(lastResult.machine)
  renderGroups(lastResult)
}
async function mfSubmit() {
  mf.submitted = true
  mf.showReds = false
  await mfLoad()
}
async function mfRefresh() {
  var status = document.getElementById('mf-status')
  status.innerHTML = 'refreshing catalog from HuggingFace (wave 1: detecting runtimes)…'
  await fetch('/api/llamafarm/refresh', { method: 'POST' })
  mf.submitted = false
  await mfLoad()
}
function toggleReds() {
  mf.showReds = !mf.showReds
  mfLoad()
}
function renderMachine(m) {
  var ramAvail = '<em>' + gb(m.availableRamBytes) + '</em> free'
  var html = '<div class="chip"><span>MEMORY</span><b>' + gb(m.totalRamBytes) + ' · ' + ramAvail + '</b></div>'
  html += '<div class="chip"><span>CPU</span><b>' + m.cores + ' cores</b></div>'
  if (m.gpus.length) {
    html += '<div class="chip"><span>GPU</span><b>' + esc(m.gpus.map(function (g) { return g.name + ' ' + gb(g.vramBytes) }).join(' · ')) + '</b></div>'
  }
  var oll = m.ollama.installed
    ? 'installed · ' + m.ollama.models.length + ' models'
    : 'not found' + (m.ollama.error ? ' (' + esc(m.ollama.error) + ')' : '')
  html += '<div class="chip"><span>OLLAMA</span><b>' + oll + '</b></div>'
  document.getElementById('mf-machine').innerHTML = html
}
function renderGroups(result) {
  var status = document.getElementById('mf-status')
  if (result.error) {
    status.innerHTML = '<span class="err">catalog: ' + esc(result.error) + '</span>' + (result.fetchedAt ? ' (showing cache)' : '')
  } else if (result.fetchedAt) {
    status.textContent = 'catalog: ' + result.total + ' models · fetched ' + new Date(result.fetchedAt).toLocaleString()
  } else {
    status.textContent = 'no catalog yet — hit Refresh catalog'
  }
  var cols = document.getElementById('mf-cols')
  cols.innerHTML = ''
  result.groups.forEach(function (group) {
    var col = document.createElement('div')
    col.className = 'mf-col'
    var head = '<h3><i>' + esc(group.icon) + '</i> ' + esc(group.label) + '<small>' + group.models.length + '</small></h3>'
    var rows = group.models.map(function (m) {
      var meta = (m.paramsBillions ? m.paramsBillions + 'B' : '?') +
        (m.quantLabel ? ' · ' + esc(m.quantLabel) : '') +
        ' · ' + gb(m.runtimeRamBytes) + ' runtime'
      var row = '<button class="mrow v-' + m.verdict + '" onclick="mfToggle(\\'' + esc(m.id) + '\\')">' +
        '<span class="dot"></span><span class="nm"><b>' + esc(m.label) + '</b><small>' + meta + '</small></span></button>'
      if (mf.expanded[m.id]) {
        var hints = m.hints.map(function (h) { return '<li>' + esc(h) + '</li>' }).join('')
        row += '<div class="mdetail"><p>' + esc(m.reason) + '</p>' +
          (hints ? '<ul>' + hints + '</ul>' : '') +
          '<a href="' + esc(m.hfUrl) + '" target="_blank" rel="noopener">huggingface.co ↗</a>' +
          '<div>' + esc(m.id) + ' · ' + m.downloads.toLocaleString() + ' downloads' + (m.license ? ' · ' + esc(m.license) : '') + '</div></div>'
      }
      return row
    }).join('')
    var note = ''
    if (mf.submitted && !mf.showReds) {
      note = '<div class="mf-note">reds without a path are hidden · <button onclick="toggleReds()">show all reds</button></div>'
    } else if (mf.submitted && mf.showReds) {
      note = '<div class="mf-note"><button onclick="toggleReds()">hide hopeless reds</button></div>'
    }
    col.innerHTML = head + rows + note
    cols.appendChild(col)
  })
  if (!result.groups.length) {
    cols.innerHTML = '<div class="mf-note">nothing matches the current filters.</div>'
  }
}
function mfToggle(id) {
  mf.expanded[id] = !mf.expanded[id]
  if (lastResult) renderGroups(lastResult)
}

/* ---- marketplace ---- */
var mp = { query: '', category: '', selected: null, timer: null, data: null, busy: false, note: null }

function mpSetSearch() {
  mp.query = document.getElementById('mp-search').value
  clearTimeout(mp.timer)
  mp.timer = setTimeout(mpLoad, 150)
}
function mpSetCategory() {
  mp.category = document.getElementById('mp-category').value
  mpLoad()
}
async function mpRefresh() {
  document.getElementById('mp-status').textContent = 'refreshing registry…'
  await fetch('/api/marketplace/refresh', { method: 'POST' })
  await mpLoad()
}
function mpSkeleton() {
  var row = '<div class="mp-skel"><i></i><div><b></b><s></s></div></div>'
  document.getElementById('mp-list').innerHTML = row + row + row
}
async function mpLoad() {
  var status = document.getElementById('mp-status')
  if (!mp.data) mpSkeleton()
  var res = await fetch('/api/marketplace/list?q=' + encodeURIComponent(mp.query) + '&category=' + encodeURIComponent(mp.category))
  mp.data = await res.json()
  if (mp.data.error) {
    status.innerHTML = '<span class="err">registry: ' + esc(mp.data.error) + '</span>'
  } else {
    status.textContent = mp.data.modules.length + ' modules · live registry · fetched ' +
      (mp.data.fetchedAt ? new Date(mp.data.fetchedAt).toLocaleTimeString() : '—')
  }
  var catSel = document.getElementById('mp-category')
  var current = mp.category
  catSel.innerHTML = '<option value="">all</option>' + mp.data.categories.map(function (c) {
    return '<option value="' + esc(c) + '"' + (c === current ? ' selected' : '') + '>' + esc(c) + '</option>'
  }).join('')
  mpRenderList()
  mpRenderDetail()
}
function mpRenderList() {
  var list = document.getElementById('mp-list')
  if (!mp.data.modules.length) {
    list.innerHTML = '<div class="mf-note">no modules match.</div>'
    return
  }
  list.innerHTML = mp.data.modules.map(function (m) {
    var state = m.builtIn ? '<span class="mp-state installed">BUILT-IN</span>'
      : m.installed ? '<span class="mp-state installed">INSTALLED</span>'
      : '<span class="mp-state">INSTALL</span>'
    return '<button class="mp-item' + (mp.selected === m.id ? ' sel' : '') + '" onclick="mpSelect(\\'' + esc(m.id) + '\\')">' +
      '<span class="mp-icon">' + esc(m.icon) + '</span>' +
      '<span class="mp-meta"><b>' + esc(m.name) + '</b><small>' + esc(m.author) + ' · v' + esc(m.version) + '</small>' +
      '<p>' + esc(m.description) + '</p></span>' + state + '</button>'
  }).join('')
}
function mpSelect(id) {
  mp.selected = id
  mp.note = null
  mpRenderList()
  mpRenderDetail()
}
function mpRenderDetail() {
  var pane = document.getElementById('mp-detail')
  var m = mp.data && mp.data.modules.find(function (x) { return x.id === mp.selected })
  if (!m) {
    pane.innerHTML = '<div class="mp-empty">select a module to see details</div>'
    return
  }
  var action = m.builtIn
    ? '<button class="btn" disabled>Built-in</button>'
    : m.installed
      ? '<button class="btn" onclick="mpUninstall(\\'' + esc(m.id) + '\\')"' + (mp.busy ? ' disabled' : '') + '>Uninstall</button>'
      : '<button class="btn primary" onclick="mpInstall(\\'' + esc(m.id) + '\\')"' + (mp.busy ? ' disabled' : '') + '>Install</button>'
  var tags = m.categories.concat(m.tags).map(function (t) { return '<span>' + esc(t) + '</span>' }).join('')
  pane.innerHTML =
    '<div class="mp-head"><span class="mp-icon">' + esc(m.icon) + '</span><div><h2>' + esc(m.name) + '</h2>' +
    '<div class="mp-by">' + esc(m.author) + ' · v' + esc(m.version) + ' · ' + esc(m.type) + '</div></div></div>' +
    '<p class="mp-desc">' + esc(m.description) + '</p>' +
    '<div class="mp-tags">' + tags + '</div>' +
    '<div class="mp-actions">' + action + (m.installed && !m.builtIn ? '<span class="mp-state installed">INSTALLED</span>' : '') + '</div>' +
    (mp.note ? '<p class="mp-note">' + esc(mp.note) + '</p>' : '') +
    (m.credentialsRequired ? '<p class="mp-note">requires credentials after install</p>' : '') +
    (m.homepage ? '<a href="' + esc(m.homepage) + '" target="_blank" rel="noopener">homepage ↗</a>' : '')
}
async function mpInstall(id) {
  mp.busy = true
  mpRenderDetail()
  var res = await fetch('/api/marketplace/install', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id })
  })
  var result = await res.json()
  mp.busy = false
  mp.note = result.error ? result.error
    : [result.note].concat(result.missingCredentials && result.missingCredentials.length ? ['missing credentials: ' + result.missingCredentials.join(', ')] : []).filter(Boolean).join(' · ') || 'Installed.'
  await mpLoad()
  bootOverview()
}
async function mpUninstall(id) {
  mp.busy = true
  mpRenderDetail()
  var res = await fetch('/api/marketplace/uninstall', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id })
  })
  var result = await res.json()
  mp.busy = false
  mp.note = result.error || 'Uninstalled. Settings were kept.'
  await mpLoad()
  bootOverview()
}

/* ---- terminal ---- */
var es = null, termStarted = false
var cmdHistory = [], hIdx = -1
var termOut = document.getElementById('term-out')
var termIn = document.getElementById('term-in')

function termRenderState(st) {
  document.getElementById('term-state').textContent = st.running
    ? 'running · pid ' + st.pid
    : 'not running'
}
async function termStart() {
  var res = await fetch('/api/terminal/start', { method: 'POST' })
  termRenderState(await res.json())
  termStarted = true
  if (!es) {
    es = new EventSource('/api/terminal/events')
    es.onmessage = function (e) {
      termOut.textContent += JSON.parse(e.data)
      termOut.scrollTop = termOut.scrollHeight
    }
  }
  termIn.focus()
}
async function termStop() {
  var res = await fetch('/api/terminal/stop', { method: 'POST' })
  termRenderState(await res.json())
}
function termAutoStart() {
  if (!termStarted) termStart()
}
termIn.addEventListener('keydown', async function (ev) {
  if (ev.key === 'Enter') {
    var line = termIn.value
    termIn.value = ''
    if (line.trim()) { cmdHistory.push(line); hIdx = cmdHistory.length }
    termOut.textContent += line + '\\r\\n'
    termOut.scrollTop = termOut.scrollHeight
    await fetch('/api/terminal/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: line + '\\r\\n' })
    })
  } else if (ev.key === 'ArrowUp') {
    ev.preventDefault()
    if (hIdx > 0) { hIdx--; termIn.value = cmdHistory[hIdx] || '' }
  } else if (ev.key === 'ArrowDown') {
    ev.preventDefault()
    if (hIdx < cmdHistory.length - 1) { hIdx++; termIn.value = cmdHistory[hIdx] } else { hIdx = cmdHistory.length; termIn.value = '' }
  } else if (ev.key === 'c' && ev.ctrlKey) {
    ev.preventDefault()
    await fetch('/api/terminal/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: '\\u0003' })
    })
  }
})
</script>
</body>
</html>`

function send(res: ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

export interface PanelHandle {
  port: number
  close: () => void
}

export function startPanel(services: Services): Promise<PanelHandle> {
  const terminal = createTerminal()
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void (async () => {
      try {
        if (req.method === 'GET' && url.pathname === '/') {
          send(res, 200, PAGE, 'text/html')
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/overview') {
          send(res, 200, JSON.stringify({
            crypto: services.crypto,
            gmail: services.gmail,
            resource: await services.resourceStats(),
            installed: services.installedWidgets()
          }))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/crypto_refresh') {
          send(res, 200, JSON.stringify(await services.cryptoRefresh()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/gmail_check') {
          send(res, 200, JSON.stringify(await services.gmailCheck()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/system_stats') {
          send(res, 200, JSON.stringify(await services.resourceStats()))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/widgets_export') {
          send(res, 200, await services.exportWidgets(), 'application/json')
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/widgets_import') {
          send(res, 200, JSON.stringify(await services.importWidgets(JSON.parse(await readBody(req)))))
          return
        }

        // --- llamafarm -----------------------------------------------------
        if (req.method === 'POST' && url.pathname === '/api/llamafarm/score') {
          const raw = JSON.parse(await readBody(req)) as {
            scenario?: 'now' | 'total'
            search?: string
            minParams?: number | null
            maxParams?: number | null
            onlyReachable?: boolean
          }
          send(res, 200, JSON.stringify(await services.llamafarmScore({
            scenario: raw.scenario === 'total' ? 'total' : 'now',
            search: raw.search,
            minParams: raw.minParams ?? null,
            maxParams: raw.maxParams ?? null,
            onlyReachable: raw.onlyReachable === true
          })))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/llamafarm/refresh') {
          send(res, 200, JSON.stringify(await services.llamafarmRefresh()))
          return
        }

        // --- marketplace ---------------------------------------------------
        if (req.method === 'GET' && url.pathname === '/api/marketplace/list') {
          send(res, 200, JSON.stringify(await services.marketplaceList({
            query: url.searchParams.get('q') ?? undefined,
            category: url.searchParams.get('category') ?? undefined
          })))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/marketplace/refresh') {
          send(res, 200, JSON.stringify(await services.marketplaceRefresh()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/marketplace/install') {
          const raw = JSON.parse(await readBody(req)) as { id?: unknown }
          send(res, 200, JSON.stringify(await services.marketplaceInstall(raw.id)))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/marketplace/uninstall') {
          const raw = JSON.parse(await readBody(req)) as { id?: unknown }
          send(res, 200, JSON.stringify(await services.marketplaceUninstall(raw.id)))
          return
        }

        // --- terminal ------------------------------------------------------
        if (req.method === 'POST' && url.pathname === '/api/terminal/start') {
          send(res, 200, JSON.stringify(terminal.start()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/terminal/stop') {
          send(res, 200, JSON.stringify(terminal.stop()))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/terminal/state') {
          send(res, 200, JSON.stringify(terminal.state()))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/terminal/output') {
          send(res, 200, JSON.stringify({ output: terminal.snapshot() }))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/terminal/input') {
          const raw = JSON.parse(await readBody(req)) as { data?: unknown }
          send(res, 200, JSON.stringify(terminal.input(typeof raw.data === 'string' ? raw.data : '')))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/terminal/events') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store',
            Connection: 'keep-alive'
          })
          res.write('retry: 3000\n\n')
          const unsubscribe = terminal.subscribe((chunk) => {
            res.write(`data: ${JSON.stringify(chunk)}\n\n`)
          })
          const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000)
          req.on('close', () => {
            clearInterval(heartbeat)
            unsubscribe()
          })
          return
        }

        send(res, 404, JSON.stringify({ error: 'Not found' }))
      } catch (cause) {
        send(res, 500, JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }))
      }
    })()
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(PANEL_PORT, '127.0.0.1', () =>
      resolve({
        port: PANEL_PORT,
        close: () => {
          terminal.stop()
          server.closeAllConnections()
          server.close()
        }
      })
    )
  })
}
