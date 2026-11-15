/**
 * Localhost ops panel for toolbox-mcp: JSON API + single-page UI in the
 * "vrm AIO" dark-green design language. Sections: Overview (shared widgets),
 * Model Farm (HuggingFace catalog fit-scored against this machine) and a
 * Terminal (local shell session streamed over SSE).
 * Binds to 127.0.0.1 only. MCP clients talk stdio; humans use the panel.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createServices, type Services } from './services.js'
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
  .minstall { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 0 8px; }
  .minstall button { font: inherit; color: #0b1510; background: var(--accent); border: 0; border-radius: 3px; padding: 7px 12px; cursor: pointer; }
  .minstall button:disabled { opacity: 0.55; cursor: progress; }
  .minstall button:hover:not(:disabled) { filter: brightness(1.08); }
  .minstall .ok { color: var(--accent); }
  .minstall .err { color: #e08b7a; }
  .minstall .note { color: var(--dim); }
  .msetup { margin: 12px 0; padding: 14px; border: 1px solid var(--border); border-left: 3px solid var(--accent); background: var(--bg); font-size: 12px; color: var(--text); }
  .msetup strong { color: var(--accent); font-size: 13px; }
  .msetup p { margin: 8px 0; line-height: 1.6; color: var(--text); }
  .msetup pre { margin: 12px 0; font: inherit; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .msetup-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .msetup-actions .btn { min-height: 44px; padding: 10px 16px; }
  .msetup-actions .btn:disabled { opacity: 0.55; cursor: progress; }
  .msetup pre:focus-visible, .msetup-actions .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .msetup-actions [role="status"] { color: var(--accent); overflow-wrap: anywhere; }
  .msetup .msetup-note { margin-bottom: 0; color: var(--text); }
  .grade { flex: 0 0 auto; min-width: 40px; text-align: right; font-size: 11px; letter-spacing: 0.5px; }
  .grade b { font-weight: 600; }
  .grade small { display: block; color: var(--dim); font-size: 9px; }
  .g-A, .g-Ap { color: var(--accent); }
  .g-B { color: #9ec96a; }
  .g-C { color: #d8b45c; }
  .g-D { color: #d9925a; }
  .g-F { color: #e08b7a; }
  .scorecard { width: 100%; border-collapse: collapse; margin: 0 0 8px; font-size: 10px; }
  .scorecard th { text-align: right; color: var(--dim); font-weight: 400; font-size: 9px; padding: 0 0 4px 8px; letter-spacing: 0.5px; }
  .scorecard th:first-child { text-align: left; padding-left: 0; }
  .scorecard td { text-align: right; padding: 4px 0 4px 8px; border-top: 1px solid #132219; color: #c3cec5; font-variant-numeric: tabular-nums; }
  .scorecard td:first-child { text-align: left; padding-left: 0; color: var(--muted); }
  .scorecard td small { display: block; color: var(--dim); font-size: 9px; }
  .scorecard tr.weak td:first-child { color: #e0b07a; }
  .scorecard tr.weak td:first-child::after { content: ' ◂ weak link'; font-size: 9px; color: #e0b07a; }
  .scorecard .pos { color: var(--accent); }
  .scorecard .neg { color: #e08b7a; }
  .scorecard .na { color: var(--dim); }
  .verdict { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; }
  .verdict .mark { font-size: 20px; font-weight: 600; line-height: 1; }
  .verdict .outof { color: var(--dim); font-size: 10px; }
  .verdict .says { flex: 1; min-width: 0; color: #9fb3a4; font-size: 10px; }
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

  /* gateway */
  .gw-alerts { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .gw-alert { display: flex; gap: 10px; align-items: flex-start; padding: 11px 14px; border: 1px solid var(--border); border-left-width: 3px; border-radius: 5px; background: var(--panel); font-size: 11px; color: #a6b4aa; }
  .gw-alert.error { border-left-color: var(--red); }
  .gw-alert.warn { border-left-color: var(--yellow); }
  .gw-alert.info { border-left-color: var(--dim); }
  .gw-alert i { flex: 0 0 auto; font-style: normal; }
  .gw-alert.error i { color: var(--red); }
  .gw-alert.warn i { color: var(--yellow); }
  .gw-alert.info i { color: var(--muted); }
  .gw-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .gw-table th { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--dim); font-weight: 400; font-size: 9px; letter-spacing: .06em; }
  .gw-table td { padding: 10px 14px; border-bottom: 1px solid #132219; color: #c3cec5; vertical-align: top; }
  .gw-table tr:last-child td { border-bottom: 0; }
  .gw-table td small { display: block; color: var(--dim); font-size: 9px; }
  .gw-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .gw-state { display: inline-block; padding: 3px 9px; border: 1px solid var(--border); border-radius: 3px; font-size: 9px; color: var(--muted); }
  .gw-state.ok { color: var(--green); border-color: #2a4935; }
  .gw-state.bad { color: var(--red); border-color: #4a2a2c; }
  .gw-state.off { color: var(--dim); }
  .gw-empty { padding: 36px 16px; text-align: center; color: var(--dim); font-size: 11px; line-height: 1.8; }
  .gw-log { margin-top: 14px; }

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
    <button class="navbtn hidden" data-nav="gateway"><i>⇄</i><span>Gateway</span><small>05</small></button>
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

    <section id="sec-gateway" class="hidden">
      <h1>AstrLink gateway</h1>
      <p class="sub">Read-only view of the local API gateway: providers, routing, capture posture and recent traffic. Metadata only — no prompt bodies, no setting changes.</p>
      <div class="mf-bar">
        <button class="btn primary" onclick="gwLoad(true)">Refresh</button>
        <label>status <select id="gw-filter" onchange="gwLoadRequests()">
          <option value="">all</option><option value="succeeded">succeeded</option><option value="failed">failed</option>
          <option value="blocked">blocked</option><option value="cancelled">cancelled</option>
        </select></label>
        <div class="mf-status" id="gw-line">reading the gateway…</div>
      </div>
      <div class="machine" id="gw-chips"></div>
      <div class="gw-alerts" id="gw-alerts"></div>
      <div class="card-grid">
        <div class="card"><h2>Providers</h2><div id="gw-providers"></div></div>
        <div class="card"><h2>Posture</h2><div id="gw-posture"></div></div>
      </div>
      <div class="card gw-log"><h2>Recent requests</h2><div id="gw-requests"></div></div>
    </section>
  </main>
</div>

<script>
var mf = { scenario: 'now', search: '', min: null, max: null, submitted: false, showReds: false, timer: null, expanded: {}, install: {} }
var lastResult = null

function show(name) {
  document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.toggle('active', b.dataset.nav === name) })
  ;['overview', 'models', 'terminal', 'marketplace', 'gateway'].forEach(function (s) {
    document.getElementById('sec-' + s).classList.toggle('hidden', s !== name)
  })
  if (name === 'models' && !lastResult) mfLoad()
  if (name === 'terminal') termAutoStart()
  if (name === 'marketplace' && !mp.data) mpLoad()
  if (name === 'gateway' && !gw.data) gwLoad()
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
  var gwInstalled = installed.indexOf('astrlink-gateway') !== -1
  document.querySelector('[data-nav="gateway"]').classList.toggle('hidden', !gwInstalled)
  if (!gwInstalled && !document.getElementById('sec-gateway').classList.contains('hidden')) show('overview')
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
  renderMachine(lastResult.machine, lastResult.machineGrade)
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
function gradeClass(letter) {
  return 'g-' + letter.replace('+', 'p')
}
function renderMachine(m, grade) {
  var scores = {}
  if (grade && grade.axes) {
    grade.axes.forEach(function (a) { scores[a.axis] = a })
  }
  function rated(axis, value) {
    var a = scores[axis]
    if (!a || a.score === null) return value
    return value + ' · <em>' + a.score + '</em>/100'
  }
  var ramLabel = mf.scenario === 'now'
    ? gb(m.availableRamBytes) + ' free of ' + gb(m.totalRamBytes)
    : gb(m.totalRamBytes) + ' total'
  var html = '<div class="chip"><span>MEMORY</span><b>' + rated('memory', ramLabel) + '</b></div>'
  html += '<div class="chip"><span>COMPUTE</span><b>' + rated('compute', m.cores + ' cores') + '</b></div>'
  if (m.gpus.length) {
    var gpuText = esc(m.gpus.map(function (g) { return g.name + ' ' + gb(g.vramBytes) }).join(' · '))
    html += '<div class="chip"><span>GPU</span><b>' + rated('gpu', gpuText) + '</b></div>'
  }
  if (typeof m.freeDiskBytes === 'number') {
    html += '<div class="chip"><span>STORAGE</span><b>' + rated('storage', gb(m.freeDiskBytes) + ' free') + '</b></div>'
  }
  var oll = m.ollama.installed
    ? 'installed · ' + m.ollama.models.length + ' models'
    : 'not found' + (m.ollama.error ? ' (' + esc(m.ollama.error) + ')' : '')
  html += '<div class="chip"><span>OLLAMA</span><b>' + oll + '</b></div>'
  if (grade) {
    html += '<div class="chip"><span>THIS PC · ' + (mf.scenario === 'now' ? 'AVAILABLE NOW' : 'TOTAL') + '</span><b>' +
      grade.score + '/100 · ' + esc(grade.label) + '</b></div>'
  }
  document.getElementById('mf-machine').innerHTML = html
}
/** The Warp-style spec block, with digits instead of bars. */
function renderScorecard(grade) {
  if (!grade) return ''
  var head = '<div class="verdict">' +
    '<span class="mark ' + gradeClass(grade.letter) + '">' + esc(grade.letter) + '</span>' +
    '<span class="outof">' + grade.score + '/100 · ' + esc(grade.label) + '</span>' +
    '<span class="says">' + esc(grade.bottleneck.message) + '</span></div>'
  var rows = grade.axes.map(function (a) {
    var weak = a.axis === grade.bottleneck.axis && grade.bottleneck.kind === 'machine'
    var pc = a.score === null ? '<span class="na">—</span>' : a.score
    var room
    if (a.headroom === null) room = '<span class="na">—</span>'
    else room = '<span class="' + (a.headroom < 0 ? 'neg' : 'pos') + '">' + (a.headroom > 0 ? '+' : '') + a.headroom + '</span>'
    return '<tr' + (weak ? ' class="weak"' : '') + '>' +
      '<td>' + esc(a.label) + '</td>' +
      '<td>' + pc + '<small>' + esc(a.detail) + '</small></td>' +
      '<td>' + a.model + '<small>' + esc(a.modelDetail) + '</small></td>' +
      '<td>' + room + '</td></tr>'
  }).join('')
  return head +
    '<table class="scorecard"><thead><tr><th>AXIS</th>' +
    '<th>THIS PC</th><th>MODEL WANTS</th><th>HEADROOM</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    '<p>' + esc(grade.bottleneck.advice) + '</p>'
}
function mfAstrlinkText(setup) {
  return 'Provider: OpenAI-compatible\\nBase URL: ' + setup.baseUrl +
    '\\nModel: ' + setup.model + '\\nCapability: ' + setup.capability
}
function renderAstrlinkSetup(id, inst) {
  if (!inst || inst.state !== 'ok' || !inst.astrlink) return ''
  var copying = inst.copyState === 'copying'
  var feedback = inst.copyState === 'copied' ? 'Copied' :
    inst.copyState === 'error' ? 'Copy unavailable — select and copy the settings above.' : ''
  return '<div class="msetup"><strong>Use in AstrLink</strong>' +
    '<p>Add an OpenAI-compatible service in AstrLink using these settings. ' +
    'This uses the default local Ollama address; adjust it if your server runs elsewhere.</p>' +
    '<pre tabindex="0" aria-label="AstrLink service settings">' + esc(mfAstrlinkText(inst.astrlink)) + '</pre>' +
    '<div class="msetup-actions"><button class="btn" data-copy-setup="' + esc(id) +
    '" onclick="mfCopyAstrlink(this.dataset.copySetup)"' + (copying ? ' disabled' : '') + '>Copy setup</button>' +
    '<span role="status" aria-live="polite">' + esc(copying ? 'Copying…' : feedback) + '</span></div>' +
    '<p class="msetup-note">Manual setup only. No credentials included; no gateway settings changed.</p></div>'
}
async function mfCopyAstrlink(id) {
  var inst = mf.install[id]
  if (!inst || inst.state !== 'ok' || !inst.astrlink || inst.copyState === 'copying') return
  inst.copyState = 'copying'
  if (lastResult) renderGroups(lastResult)
  try {
    await navigator.clipboard.writeText(mfAstrlinkText(inst.astrlink))
    inst.copyState = 'copied'
  } catch {
    inst.copyState = 'error'
  }
  if (mf.install[id] === inst && lastResult) renderGroups(lastResult)
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
        '<span class="dot"></span><span class="nm"><b>' + esc(m.label) + '</b><small>' + meta + '</small></span>' +
        (m.grade ? '<span class="grade ' + gradeClass(m.grade.letter) + '"><b>' + esc(m.grade.letter) + '</b><small>' + m.grade.score + '</small></span>' : '') +
        '</button>'
      if (mf.expanded[m.id]) {
        var hints = m.hints.map(function (h) { return '<li>' + esc(h) + '</li>' }).join('')
        var inst = mf.install[m.id]
        var pullable = (m.formats || []).indexOf('gguf') !== -1
        var installBlock = '<div class="minstall">' +
          (pullable
            ? '<button onclick="mfInstall(\\'' + esc(m.id) + '\\')"' + (inst && inst.state === 'busy' ? ' disabled' : '') + '>⬇ Install in Ollama</button>'
            : '<span class="note">safetensors only — convert to GGUF to install in Ollama</span>') +
          (inst ? '<span class="' + (inst.state === 'ok' ? 'ok' : 'err') + '">' + esc(inst.message) + '</span>' : '') +
          '</div>'
        row += '<div class="mdetail"><p>' + esc(m.reason) + '</p>' +
          renderScorecard(m.grade) +
          (hints ? '<ul>' + hints + '</ul>' : '') +
          installBlock + renderAstrlinkSetup(m.id, inst) +
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
async function mfInstall(id) {
  mf.install[id] = { state: 'busy', message: 'downloading…' }
  if (lastResult) renderGroups(lastResult)
  try {
    var res = await fetch('/api/llamafarm/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: id })
    })
    var body = await res.json()
    var ok = res.ok && body.ok === true
    var steps = body.steps || []
    var message = body.message || body.error || (ok ? 'Installed' : 'Install failed')
    if (ok && steps.length) message = steps[steps.length - 1]
    mf.install[id] = { state: ok ? 'ok' : 'err', message: message, astrlink: ok ? body.astrlink : null }
  } catch (cause) {
    mf.install[id] = { state: 'err', message: String(cause && cause.message ? cause.message : cause) }
  }
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
    (m.endpoint ? '<p class="mp-note">remote endpoint: ' + esc(m.endpoint) + '<br />tool arguments leave this machine</p>' : '') +
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

/* ---- astrlink gateway ---- */
var gw = { data: null, log: null }

function gwMs(value) {
  if (value === null || value === undefined) return '—'
  return value >= 1000 ? (value / 1000).toFixed(1) + 's' : value + 'ms'
}
function gwPlural(count, word, plural) { return count + ' ' + (count === 1 ? word : (plural || word + 's')) }
function gwState(text, kind) { return '<span class="gw-state ' + kind + '">' + esc(text) + '</span>' }
function gwEmpty(message) { return '<div class="gw-empty">' + esc(message) + '</div>' }
function gwDownMessage(status) {
  if (status.availability === 'not-installed') {
    return 'AstrLink CLI not found. Open the AstrLink desktop, go to Settings → Agent tools and install the tools for this host.'
  }
  if (status.availability === 'not-running') {
    return 'The AstrLink desktop gateway is not running. Start it and wait until it shows Ready.'
  }
  if (status.availability === 'blocked') {
    return 'The host sandbox blocked the AstrLink local socket. Reinstall the agent tools for this host, or approve running outside the sandbox.'
  }
  return status.error || 'The gateway could not be read.'
}
async function gwLoad(force) {
  document.getElementById('gw-line').textContent = 'reading the gateway…'
  var res = force
    ? await fetch('/api/gateway/refresh', { method: 'POST' })
    : await fetch('/api/gateway/status')
  gw.data = await res.json()
  gwRender()
  await gwLoadRequests()
}
async function gwLoadRequests() {
  if (!gw.data || gw.data.availability !== 'ready') return
  var filter = document.getElementById('gw-filter').value
  var res = await fetch('/api/gateway/requests?limit=25' + (filter ? '&status=' + encodeURIComponent(filter) : ''))
  gw.log = await res.json()
  gwRenderRequests()
  gwRenderChips()
}
function gwRender() {
  var status = gw.data
  var line = document.getElementById('gw-line')
  if (status.availability !== 'ready') {
    line.innerHTML = '<span class="err">' + esc(status.availability) + '</span>'
    document.getElementById('gw-chips').innerHTML = ''
    document.getElementById('gw-alerts').innerHTML = gwEmpty(gwDownMessage(status))
    document.getElementById('gw-providers').innerHTML = gwEmpty('No provider data.')
    document.getElementById('gw-posture').innerHTML = gwEmpty('No posture data.')
    document.getElementById('gw-requests').innerHTML = gwEmpty('No request records.')
    return
  }
  line.textContent = gwPlural(status.services.length, 'provider') + ' · read ' + new Date(status.checkedAt).toLocaleTimeString() +
    (status.warnings.length ? ' · ' + gwPlural(status.warnings.length, 'section') + ' unavailable' : '')
  document.getElementById('gw-alerts').innerHTML = status.alerts.map(function (a) {
    var icon = a.level === 'error' ? '✖' : a.level === 'warn' ? '▲' : 'ℹ'
    return '<div class="gw-alert ' + a.level + '"><i>' + icon + '</i><span>' + esc(a.message) + '</span></div>'
  }).join('')
  gwRenderChips()
  gwRenderProviders()
  gwRenderPosture()
}
function gwRenderChips() {
  var status = gw.data
  if (!status || status.availability !== 'ready') return
  var enabled = status.services.filter(function (s) { return s.enabled }).length
  var subs = status.services.filter(function (s) { return s.subscription })
  var connected = subs.filter(function (s) { return s.subscription.status === 'connected' }).length
  var errors = status.alerts.filter(function (a) { return a.level === 'error' }).length
  var warns = status.alerts.filter(function (a) { return a.level === 'warn' }).length
  var html = '<div class="chip"><span>PROVIDERS</span><b>' + enabled + ' / ' + status.services.length + ' enabled</b></div>'
  html += '<div class="chip"><span>SUBSCRIPTIONS</span><b>' + connected + ' / ' + subs.length + ' connected</b></div>'
  html += '<div class="chip"><span>ALERTS</span><b>' + gwPlural(errors, 'error') + ' · ' + gwPlural(warns, 'warning') + '</b></div>'
  if (gw.log && gw.log.availability === 'ready') {
    html += '<div class="chip"><span>RECENT REQUESTS</span><b>' + gw.log.summary.count + ' · ' + gw.log.summary.failed + ' failed</b></div>'
    html += '<div class="chip"><span>TOKENS</span><b>' + gw.log.summary.totalTokens.toLocaleString() + '</b></div>'
    html += '<div class="chip"><span>AVG LATENCY</span><b>' + gwMs(gw.log.summary.avgLatencyMs) + '</b></div>'
  }
  document.getElementById('gw-chips').innerHTML = html
}
function gwRenderProviders() {
  var rows = gw.data.services.map(function (s) {
    var state = !s.enabled ? gwState('disabled', 'off')
      : s.subscription ? gwState(s.subscription.status, s.subscription.status === 'connected' ? 'ok' : 'bad')
      : gwState('enabled', 'ok')
    var expiry = s.subscription && s.subscription.tokenExpiresAt
      ? '<small>token ' + esc(new Date(s.subscription.tokenExpiresAt).toLocaleString()) + '</small>'
      : ''
    var protocols = s.capabilities.map(function (c) { return c.protocol }).join(', ')
    return '<tr><td>' + esc(s.name) + '<small>' + esc(s.kind) + '</small></td>' +
      '<td>' + state + expiry + '</td>' +
      '<td class="num">' + (s.models.length || 'dynamic') + '</td>' +
      '<td>' + esc(protocols || '—') + '</td></tr>'
  }).join('')
  document.getElementById('gw-providers').innerHTML = rows
    ? '<table class="gw-table"><thead><tr><th>PROVIDER</th><th>STATE</th><th class="num">MODELS</th><th>PROTOCOLS</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : gwEmpty('No providers configured.')
}
function gwRenderPosture() {
  var status = gw.data
  var rows = []
  function row(label, value) { rows.push('<tr><td>' + esc(label) + '</td><td>' + value + '</td></tr>') }
  if (status.routing) {
    var r = status.routing
    row('Strategy', esc(r.strategy) + ' · ' + gwPlural(r.maxAttempts, 'attempt') + ' · ' + gwPlural(r.maxRetries, 'retry', 'retries'))
    row('Identity enforced', r.identityEnforcement.length ? esc(r.identityEnforcement.join(', ')) : '—')
    row('Risk protection', r.subscriptionRiskProtection ? 'on' : 'off')
    row('Session isolation', r.sessionIsolation ? 'on' : 'off')
    row('Channel stickiness', r.channelStickinessSeconds === null ? 'off' : r.channelStickinessSeconds + 's')
    row('Reasoning', esc(r.reasoningMode + ' · ' + r.reasoningLevel))
    if (r.redirects.length) {
      row('Redirects', r.redirects.map(function (x) { return esc(x.from + ' → ' + x.to) }).join('<br />'))
    }
  }
  if (status.audit) {
    var a = status.audit
    row('Body capture', (a.requestBodyEnabled || a.responseContentEnabled) ? 'on' : 'off')
    row('Retention', a.metadataRetentionDays + 'd metadata · ' + a.contentRetentionDays + 'd content')
    row('Agent raw access', a.agentRawAccessEnabled ? 'your approval required' : 'off')
  }
  status.privacy.forEach(function (p) {
    row('Privacy', (p.enabled ? 'enabled' : 'disabled') + ' · request ' + esc(p.requestAction) +
      '<small>' + esc(p.enabledKinds.join(', ') || 'no kinds') + ' · ' + gwPlural(p.customRuleCount, 'custom rule') + ' · ' +
      gwPlural(p.allowlistCount, 'allowlist entry', 'allowlist entries') + '</small>')
  })
  document.getElementById('gw-posture').innerHTML = rows.length
    ? '<table class="gw-table"><tbody>' + rows.join('') + '</tbody></table>'
    : gwEmpty('No posture data.')
}
function gwRenderRequests() {
  var box = document.getElementById('gw-requests')
  if (!gw.log) { box.innerHTML = gwEmpty('No request records.'); return }
  if (gw.log.availability !== 'ready') { box.innerHTML = gwEmpty(gwDownMessage(gw.log)); return }
  var names = {}
  gw.data.services.forEach(function (s) { names[s.id] = s.name })
  var rows = gw.log.requests.map(function (r) {
    var kind = r.status === 'succeeded' ? 'ok' : (r.status === 'failed' || r.status === 'blocked') ? 'bad' : 'off'
    var model = esc(r.requestedModel) +
      (r.upstreamModel && r.upstreamModel !== r.requestedModel ? '<small>→ ' + esc(r.upstreamModel) + '</small>' : '')
    return '<tr><td>' + esc(new Date(r.startedAt).toLocaleString()) +
      '<small>' + esc(r.clientType) + ' · ' + esc(r.inputProtocol) + '</small></td>' +
      '<td>' + model + '</td>' +
      '<td>' + esc(names[r.serviceId] || r.serviceId || '—') + '</td>' +
      '<td>' + gwState(r.status, kind) + (r.errorMessage ? '<small>' + esc(r.errorMessage) + '</small>' : '') + '</td>' +
      '<td class="num">' + gwMs(r.latencyMs) + '<small>first ' + gwMs(r.firstTokenMs) + '</small></td>' +
      '<td class="num">' + (r.usage ? r.usage.totalTokens.toLocaleString() : '—') + '</td></tr>'
  }).join('')
  box.innerHTML = rows
    ? '<table class="gw-table"><thead><tr><th>WHEN</th><th>MODEL</th><th>PROVIDER</th><th>STATUS</th><th class="num">LATENCY</th><th class="num">TOKENS</th></tr></thead><tbody>' + rows + '</tbody></table>'
    : gwEmpty('No requests match this filter.')
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

export function startPanel(services: Services, options: { port?: number } = {}): Promise<PanelHandle> {
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
        if (req.method === 'POST' && url.pathname === '/api/llamafarm/install') {
          const raw = JSON.parse(await readBody(req)) as { repo?: string; quant?: string; offload?: number }
          send(res, 200, JSON.stringify(await services.llamafarmInstall({
            repo: raw.repo ?? '',
            ...(raw.quant ? { quant: raw.quant } : {}),
            ...(typeof raw.offload === 'number' ? { offload: raw.offload } : {})
          })))
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

        // --- astrlink gateway ----------------------------------------------
        if (req.method === 'GET' && url.pathname === '/api/gateway/status') {
          send(res, 200, JSON.stringify(await services.gatewayStatus()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/gateway/refresh') {
          send(res, 200, JSON.stringify(await services.gatewayStatus(true)))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/gateway/requests') {
          const limit = Number(url.searchParams.get('limit'))
          send(res, 200, JSON.stringify(await services.gatewayRequests({
            ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}),
            status: url.searchParams.get('status') ?? undefined,
            serviceId: url.searchParams.get('serviceId') ?? undefined
          })))
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
    server.listen(options.port ?? PANEL_PORT, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('The panel did not obtain a TCP port.'))
        return
      }
      resolve({
        port: address.port,
        close: () => {
          terminal.stop()
          server.closeAllConnections()
          server.close()
        }
      })
    })
  })
}

// `npm run panel` runs this file directly; the MCP server imports it instead.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const services = createServices()
  await services.init()
  const handle = await startPanel(services)
  console.log(`Toolbox ops panel: http://127.0.0.1:${handle.port}`)
}
