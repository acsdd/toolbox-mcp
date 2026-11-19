/**
 * Localhost ops panel for toolbox-mcp: JSON API + single-page UI in the
 * "vrm AIO" dark-green design language. Sections: Overview (shared widgets),
 * Model Farm (HuggingFace catalog fit-scored against this machine) and a
 * Terminal (local shell session streamed over SSE).
 * Binds to 127.0.0.1 only. MCP clients talk stdio; humans use the panel.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import { pathToFileURL } from 'node:url'
import { WIDGET_HOST_CSS } from '@toolbox/widgets'
import { createServices, type Services } from './services.js'
import { createTerminal, type Terminal } from './terminal.js'
import { TOOL_GROUPS, catalogEntries } from './catalog.js'
import { createActivity, type Activity } from './activity.js'
import { appVersion } from './version.js'

const PANEL_PORT = Number(process.env.TOOLBOX_MCP_PORT ?? 3851)
/** The repository the panel points at for source and issue reports. */
const REPO_URL = 'https://github.com/acsdd/toolbox-mcp'
/** Request bodies are small JSON documents; anything larger is refused. */
const MAX_BODY_BYTES = 1_000_000
/** Upper bound for a body that is drained instead of buffered. */
const MAX_DRAIN_BYTES = 10_000_000
/** Only these hostnames may address the panel (loopback, by name or address). */
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * The panel is loopback-only, but a web page the user visits can still try to
 * talk to it. Requests that name a foreign host (DNS rebinding) or carry a
 * foreign origin are refused, so a page cannot drive the local terminal.
 */
function isLocalHost(host: string | undefined): boolean {
  if (!host) return false
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]
  return LOCAL_HOSTS.has(name)
}

function isPanelRequest(req: import('node:http').IncomingMessage, port: number): boolean {
  if (!isLocalHost(req.headers.host)) return false
  // Another local website is still a different security origin.
  const site = req.headers['sec-fetch-site']
  if (site && site !== 'same-origin' && site !== 'none') return false
  try {
    const target = new URL(`http://${req.headers.host}`)
    if (Number(target.port || 80) !== port) return false
    const origin = req.headers.origin
    // Origin-less CLI clients are supported; browser writes additionally require JSON.
    return origin === undefined || origin === target.origin
  } catch {
    return false
  }
}

/** An error that carries the HTTP status the client should see. */
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>toolbox-mcp · ops panel</title>
<style>
${WIDGET_HOST_CSS}
  /* No webfont: the panel loads nothing from the network, so it works
     offline and the page can run under a strict content security policy. */
  :root {
    --bg: #060b08; --bg-2: #08110c; --panel: #0c1712; --panel2: #0a1410;
    --elevated: #112018; --border: #1f3a2d; --border-soft: #16281f;
    --text: #dde5df; --muted: #6d7f74; --dim: #46584d;
    --accent: #9cf37e; --accent-2: #5fd7c0;
    --green: #92ec74; --yellow: #e8c35c; --red: #ff6b6e;
    --radius: 10px;
    --shadow-lg: 0 22px 46px -22px rgba(0, 0, 0, .8);
    --shadow-sm: 0 2px 12px -6px rgba(0, 0, 0, .7);
  }
  * { box-sizing: border-box; }
  html { font-size: 110%; }
  body {
    margin: 0; color: var(--text); font: .8125rem/1.5 "Cascadia Mono", ui-monospace, Consolas, "IBM Plex Mono", monospace;
    background:
      radial-gradient(1100px 620px at 80% -14%, rgba(156, 243, 126, .07), transparent 62%),
      radial-gradient(900px 540px at 4% 108%, rgba(95, 215, 192, .05), transparent 60%),
      var(--bg);
    background-attachment: fixed;
  }
  button, input, select { font: inherit; color: inherit; }
  button { cursor: pointer; }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

  /* Widget host: glued stage on the left, vertical tool rail on the RIGHT. */
  .shell { display: grid; grid-template: 62px 1fr / minmax(0, 1fr) 232px; height: 100vh; }
  .topbar { grid-column: 1 / -1; display: flex; align-items: center; gap: 24px; padding: 0 26px; background: rgba(10, 20, 16, .92); border-bottom: 1px solid var(--border-soft); backdrop-filter: blur(8px); }
  .brand { font-size: 1.0625rem; font-weight: 600; letter-spacing: .02em; }
  .brand b { color: var(--accent); font-weight: 600; }
  .brand small { display: block; margin-top: 2px; color: var(--dim); font-size: .5625rem; letter-spacing: .08em; }
  .topbar .spacer { flex: 1; }
  .badge { padding: 5px 12px; border: 1px solid var(--border); border-radius: 999px; color: var(--muted); font-size: .625rem; }
  .badge.live { color: var(--accent); border-color: #2a4c34; background: rgba(156, 243, 126, .06); }

  .sidebar { grid-row: 2; grid-column: 2; display: flex; flex-direction: column; gap: 6px; padding: 22px 16px; background: rgba(8, 17, 12, .72); border-left: 1px solid var(--border-soft); }
  .navbtn { display: grid; grid-template-columns: 30px 1fr auto; align-items: center; min-height: 48px; padding: 0 12px; border: 0; border-radius: 7px; background: transparent; color: #71847a; text-align: left; transition: background .12s ease, color .12s ease; }
  .navbtn i { font-style: normal; font-size: 1.0625rem; }
  .navbtn small { color: var(--dim); font-size: .5625rem; }
  .navbtn:hover { color: #a4c69f; background: #0f1d16; }
  .navbtn.active { color: var(--accent); background: linear-gradient(270deg, #16291f, #12211a); box-shadow: inset -2px 0 0 var(--accent), var(--shadow-sm); }
  .sidebar .foot { margin-top: auto; padding: 13px 14px; border: 1px solid var(--border-soft); border-radius: 7px; color: var(--dim); font-size: .5625rem; line-height: 1.9; }
  .sidebar .foot b { color: var(--muted); font-weight: 400; }

  main { grid-column: 1; grid-row: 2; min-width: 0; }
  /* The glued host stage comes from the shared pattern; keep panel spacing. */
  main.host-screen { padding: 28px 30px 48px; }
  h1 { margin: 0 0 4px; font-size: 1.5625rem; font-weight: 500; letter-spacing: -.01em; }
  .sub { margin: 0 0 22px; color: var(--muted); font-size: .6875rem; line-height: 1.7; max-width: 76ch; }
  .hidden { display: none !important; }

  .card-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; align-items: start; }
  .card { border: 1px solid var(--border-soft); border-radius: var(--radius); background: linear-gradient(180deg, var(--panel), var(--panel2)); box-shadow: var(--shadow-sm); overflow: hidden; }
  .card h2 { margin: 0; padding: 15px 18px; border-bottom: 1px solid var(--border-soft); font-size: .6875rem; font-weight: 400; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .card h2 em { font-style: normal; color: var(--dim); letter-spacing: 0; text-transform: none; }
  .card pre { margin: 0; padding: 14px 18px; white-space: pre-wrap; word-break: break-word; font-size: .6875rem; color: #b8c3ba; max-height: 300px; overflow: auto; }
  .card .actions { padding: 0 18px 16px; display: flex; gap: 10px; flex-wrap: wrap; }
  .btn { min-height: 38px; padding: 0 16px; border: 1px solid var(--border); border-radius: 6px; background: #0e1d15; color: #a4c69f; font-size: .6875rem; transition: border-color .12s ease, color .12s ease, background .12s ease; }
  .btn:hover { border-color: var(--accent); color: var(--accent); background: #12241a; }
  .btn.primary { background: linear-gradient(180deg, #1b3527, #163024); color: var(--accent); border-color: #2b4d38; }
  .btn.primary:hover { border-color: var(--accent); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.small { min-height: 30px; padding: 0 11px; font-size: .625rem; }

  /* overview: the MCP feature surface */
  .hero { position: relative; margin-bottom: 16px; padding: 24px 26px; border: 1px solid var(--border); border-radius: 14px; overflow: hidden; background: linear-gradient(135deg, #10241a 0%, #0b1611 52%, #091310 100%); box-shadow: var(--shadow-lg); }
  .hero::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: radial-gradient(560px 220px at 86% -10%, rgba(156, 243, 126, .14), transparent 68%); }
  .hero-top { position: relative; z-index: 1; display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
  .hero-mark { flex: 0 0 auto; width: 54px; height: 54px; display: flex; align-items: center; justify-content: center; border: 1px solid #2b4d38; border-radius: 13px; background: linear-gradient(150deg, #1a3726, #102018); color: var(--accent); font-size: 1.5rem; box-shadow: var(--shadow-sm); }
  .hero-id { flex: 1; min-width: 260px; }
  .hero-id h2 { margin: 0 0 4px; font-size: 1.375rem; font-weight: 500; letter-spacing: -.01em; }
  .hero-id h2 b { color: var(--accent); font-weight: 500; }
  .hero-id p { margin: 0; color: var(--muted); font-size: .6875rem; line-height: 1.7; }
  .hero-facts { position: relative; z-index: 1; display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
  .fact { display: flex; align-items: center; gap: 7px; padding: 6px 12px; border: 1px solid var(--border-soft); border-radius: 999px; background: rgba(8, 17, 12, .6); color: var(--muted); font-size: .625rem; }
  .fact b { color: var(--text); font-weight: 500; }
  .fact .dot-live { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 8px rgba(156, 243, 126, .7); }
  .fact .dot-off { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); }

  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(168px, 1fr)); gap: 12px; margin-bottom: 18px; }
  .tile { padding: 15px 17px; border: 1px solid var(--border-soft); border-radius: var(--radius); background: linear-gradient(180deg, var(--panel), var(--panel2)); box-shadow: var(--shadow-sm); }
  .tile span { display: block; margin-bottom: 6px; color: var(--dim); font-size: .5625rem; letter-spacing: .1em; text-transform: uppercase; }
  .tile b { display: block; font-size: 1.375rem; font-weight: 500; line-height: 1.1; color: var(--text); }
  .tile b em { font-style: normal; color: var(--accent); }
  .tile small { display: block; margin-top: 5px; color: var(--muted); font-size: .5625rem; }
  .tile.warn b { color: var(--yellow); }
  .tile.bad b { color: var(--red); }

  .ov-grid { display: grid; grid-template-columns: minmax(0, 1.55fr) minmax(300px, .85fr); gap: 16px; align-items: start; }
  .ov-activity-card { position: sticky; top: 0; }
  @media (max-width: 1180px) { .ov-grid { grid-template-columns: 1fr; } .ov-activity-card { position: static; } }

  .tool-search { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 14px 18px; border-bottom: 1px solid var(--border-soft); }
  .tool-search input[type="search"] { flex: 1; min-width: 200px; min-height: 38px; padding: 0 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--panel2); color: var(--text); font-size: .75rem; }
  .tool-search input[type="search"]::placeholder { color: var(--dim); }
  .grp-chips { display: flex; flex-wrap: wrap; gap: 7px; padding: 12px 18px; border-bottom: 1px solid var(--border-soft); }
  .grp-chip { min-height: 30px; padding: 0 12px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--muted); font-size: .625rem; }
  .grp-chip:hover { color: var(--text); border-color: #2f5340; }
  .grp-chip.on { color: var(--bg); background: var(--accent); border-color: var(--accent); font-weight: 600; }

  .tool-group { border-bottom: 1px solid var(--border-soft); }
  .tool-group:last-child { border-bottom: 0; }
  .tool-group > h3 { display: flex; align-items: center; gap: 9px; margin: 0; padding: 13px 18px 7px; color: var(--muted); font-size: .625rem; font-weight: 400; letter-spacing: .09em; text-transform: uppercase; }
  .tool-group > h3 i { font-style: normal; color: var(--accent); font-size: .8125rem; }
  .tool-group > h3 small { margin-left: auto; color: var(--dim); letter-spacing: 0; text-transform: none; font-size: .5625rem; }
  .tool { padding: 9px 18px 12px 40px; border-top: 1px solid rgba(22, 40, 31, .55); }
  .tool:first-of-type { border-top: 0; }
  .tool b { display: block; color: #c9d4cb; font-size: .75rem; font-weight: 500; }
  .tool p { margin: 4px 0 0; color: var(--muted); font-size: .625rem; line-height: 1.7; }
  .tool .params { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .param { padding: 3px 9px; border: 1px solid var(--border-soft); border-radius: 4px; background: rgba(8, 17, 12, .7); color: var(--dim); font-size: .5625rem; }
  .param i { font-style: normal; color: #7fae8c; }
  .param.req { color: var(--accent-2); border-color: #24463f; }
  .tool-empty { padding: 30px 18px; text-align: center; color: var(--dim); font-size: .6875rem; }

  .act-list { max-height: 460px; overflow: auto; }
  .act { display: flex; align-items: baseline; gap: 9px; padding: 9px 16px; border-bottom: 1px solid rgba(22, 40, 31, .55); font-size: .625rem; }
  .act:last-child { border-bottom: 0; }
  .act .mark { flex: 0 0 auto; font-size: .625rem; }
  .act.ok .mark { color: var(--accent); }
  .act.bad .mark { color: var(--red); }
  .act .nm { flex: 1; min-width: 0; color: #c9d4cb; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .act .ms { flex: 0 0 auto; color: var(--dim); font-variant-numeric: tabular-nums; }
  .act .when { flex: 0 0 auto; color: var(--dim); font-size: .5625rem; }
  .act .err { display: block; margin-top: 3px; color: var(--red); overflow-wrap: anywhere; }
  .act-note { padding: 18px; color: var(--muted); font-size: .625rem; line-height: 1.8; }

  /* widget cards on the overview */
  .wtable { width: 100%; border-collapse: collapse; font-size: .6875rem; }
  .wtable th { text-align: right; padding: 0 16px 8px; color: var(--dim); font-weight: 400; font-size: .5625rem; letter-spacing: .07em; }
  .wtable th:first-child { text-align: left; padding-left: 18px; }
  .wtable td { padding: 8px 16px; border-top: 1px solid rgba(22, 40, 31, .55); color: #c9d4cb; text-align: right; font-variant-numeric: tabular-nums; }
  .wtable td:first-child { text-align: left; padding-left: 18px; }
  .wtable td small { display: block; color: var(--dim); font-size: .5625rem; }
  .wtable .up { color: var(--green); }
  .wtable .down { color: var(--red); }
  .wtable .flat { color: var(--muted); }
  .wlist { list-style: none; margin: 0; padding: 0; }
  .wlist li { padding: 10px 18px; border-top: 1px solid rgba(22, 40, 31, .55); font-size: .6875rem; }
  .wlist li:first-child { border-top: 0; }
  .wlist b { display: block; color: #c9d4cb; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wlist small { display: block; margin-top: 2px; color: var(--dim); font-size: .5625rem; }
  .wlist .unread { color: var(--accent); }
  .wlist .seen { color: var(--dim); }
  .meters { padding: 16px 18px; display: flex; flex-direction: column; gap: 13px; }
  .meter-label { display: flex; justify-content: space-between; margin-bottom: 6px; color: var(--muted); font-size: .625rem; }
  .meter-label b { color: #c9d4cb; font-weight: 400; font-variant-numeric: tabular-nums; }
  .meter { height: 7px; border-radius: 999px; background: #101d16; overflow: hidden; }
  .meter i { display: block; height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-2), var(--accent)); }
  .meter.warn i { background: linear-gradient(90deg, #d8b45c, var(--yellow)); }
  .meter.bad i { background: linear-gradient(90deg, #d9925a, var(--red)); }
  .wmeta { display: flex; flex-wrap: wrap; gap: 10px; padding: 0 18px 16px; color: var(--dim); font-size: .5625rem; }
  .wmeta b { color: var(--muted); font-weight: 400; }
  .wempty { padding: 26px 18px; color: var(--dim); font-size: .625rem; line-height: 1.8; }
  details.json { padding: 0 18px 16px; }
  details.json summary { cursor: pointer; color: var(--muted); font-size: .625rem; padding: 6px 0; }
  details.json pre { max-height: 220px; }

  /* model farm */
  .mf-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-bottom: 14px; }
  .seg { display: flex; border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
  .seg button { min-height: 38px; padding: 0 18px; border: 0; background: var(--panel2); color: var(--muted); font-size: .6875rem; }
  .seg button.on { background: #183024; color: var(--accent); }
  .mf-bar label { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: .625rem; }
  .mf-bar select, .mf-bar input[type="search"] { min-height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--panel2); color: var(--text); font-size: .75rem; }
  .mf-bar input[type="search"] { width: 220px; }
  .mf-status { width: 100%; color: var(--dim); font-size: .625rem; }
  .mf-status .err { color: var(--red); }
  .mf-purpose-filters { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .mf-purpose-filters .label { color: var(--muted); font-size: .625rem; margin-right: 2px; }
  .mf-purpose-chip { min-height: 32px; padding: 0 10px; border: 1px solid var(--border); border-radius: 999px; background: transparent; color: var(--muted); font: inherit; }
  .mf-purpose-chip:hover { border-color: var(--accent); }
  .mf-purpose-chip[aria-pressed="true"] { border-color: var(--accent); background: #12241a; }
  .mf-purpose-chip .count { margin-left: 5px; color: var(--dim); }
  .mf-list-nav { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 4px 0 8px; color: var(--muted); font-size: .625rem; }
  .mf-list-nav .controls { display: flex; gap: 6px; }
  .mf-list-nav .btn { min-width: 44px; min-height: 38px; padding: 0 12px; }
  .machine { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 16px; }
  .chip { display: flex; flex-direction: column; gap: 3px; min-width: 130px; padding: 11px 15px; border: 1px solid var(--border-soft); border-radius: 8px; background: linear-gradient(180deg, var(--panel), var(--panel2)); }
  .chip span { color: var(--dim); font-size: .5625rem; letter-spacing: .06em; }
  .chip b { color: var(--text); font-size: .8125rem; font-weight: 500; }
  .chip b em { color: var(--green); font-style: normal; }

  .mf-recent { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 0 0 16px; }
  .mf-recent-title { color: var(--dim); font-size: .5625rem; letter-spacing: .06em; text-transform: uppercase; margin-right: 2px; }
  .mf-recent-chip { display: flex; flex-direction: column; gap: 2px; padding: 7px 12px; border: 1px solid var(--border-soft); border-radius: 8px; background: var(--panel2); cursor: pointer; text-align: left; font: inherit; }
  .mf-recent-chip:hover { border-color: var(--green); }
  .mf-recent-chip b { color: var(--text); font-size: .75rem; font-weight: 500; }
  .mf-recent-chip em { color: var(--dim); font-style: normal; font-size: .625rem; }

  .rt-card { margin: 0 0 18px; padding: 16px 18px; }
  .rt-card h2 { display: flex; align-items: baseline; gap: 10px; margin: 0 0 6px; font-size: .75rem; font-weight: 500; letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .rt-card h2 em { font-style: normal; font-size: .625rem; color: var(--dim); text-transform: none; letter-spacing: 0; }
  .rt-intro { margin: 0 0 12px; color: var(--dim); font-size: .75rem; line-height: 1.6; }
  .rt-list { display: grid; gap: 8px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); margin-bottom: 12px; }
  .rt-item { display: flex; flex-direction: column; gap: 6px; padding: 11px 13px; border: 1px solid var(--border-soft); border-radius: 7px; background: var(--panel2); }
  .rt-item.on { border-color: var(--green); box-shadow: inset 2px 0 0 var(--green); }
  .rt-id { display: flex; align-items: baseline; gap: 8px; }
  .rt-id b { color: var(--text); font-size: .8125rem; font-weight: 500; }
  .rt-id small { color: var(--dim); font-size: .625rem; letter-spacing: .04em; text-transform: uppercase; }
  .rt-item.on .rt-id small { color: var(--green); }
  .rt-note { color: var(--dim); font-size: .6875rem; line-height: 1.5; }
  .rt-item .btn { align-self: flex-start; min-height: 34px; }
  .rt-log { margin-top: 10px; font-size: .75rem; min-height: 18px; }
  .rt-log .ok { color: var(--green); }
  .rt-log .err { color: var(--red); }
  .rt-log pre { margin: 8px 0 0; padding: 10px; border: 1px solid var(--border-soft); border-radius: 6px; background: var(--bg); color: var(--dim); font-size: .6875rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; user-select: text; }

  .mf-cols { display: flex; gap: 14px; align-items: flex-start; overflow-x: auto; overscroll-behavior-x: contain; scroll-snap-type: x proximity; scrollbar-width: thin; scrollbar-color: var(--border) transparent; padding: 2px 2px 12px; }
  .mf-cols:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .mf-col { flex: 0 0 min(320px, 84vw); scroll-snap-align: start; border: 1px solid var(--border); border-radius: 7px; background: var(--panel); overflow: hidden; }
  .mf-col h3 { display: flex; align-items: center; gap: 8px; margin: 0; padding: 12px 14px; border-bottom: 1px solid #16271e; font-size: .9375rem; font-weight: 600; color: var(--text); }
  .mf-col h3 i { font-style: normal; color: var(--muted); }
  .mf-col h3 .purpose-name { color: var(--purpose-color, var(--text)); }
  .mf-col h3 small { margin-left: auto; color: var(--dim); font-size: .5625rem; font-weight: 400; }
  .mf-purpose-coding { color: #c9afff; }
  .mf-purpose-art { color: #73d9ef; }
  .mf-purpose-edit { color: #f0a4bf; }
  .mf-purpose-speech { color: #89dfc5; }
  .mf-purpose-transcribe { color: #f1cc78; }
  .mf-purpose-video { color: #9dc0ff; }
  .mf-purpose-understand { color: #b5d7ff; }
  .mf-purpose-multimodal { color: #dda8eb; }
  .mrow { width: 100%; display: flex; align-items: flex-start; gap: 10px; min-height: 46px; padding: 8px 12px; border: 0; border-bottom: 1px solid #132219; background: transparent; text-align: left; }
  .mrow:hover { background: #102017; }
  .mrow .dot { flex: 0 0 auto; width: 9px; height: 9px; margin-top: 5px; border-radius: 50%; }
  .v-green .dot { background: var(--green); box-shadow: 0 0 6px rgba(146, 236, 116, .5); }
  .v-yellow .dot { background: var(--yellow); }
  .v-red .dot { background: var(--red); }
  .mrow .nm { flex: 1; min-width: 0; }
  .mrow .nm b { display: block; color: #c3cec5; font-weight: 400; font-size: .6875rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mrow .nm small { color: var(--dim); font-size: .5625rem; }
  .mdetail { padding: 10px 12px 12px 30px; border-bottom: 1px solid #132219; background: #0a130e; font-size: .625rem; color: var(--muted); }
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
  .mf-inst { color: var(--accent); font-style: normal; }
  .mquants { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 8px; font-size: .6875rem; }
  .mquants select { font: inherit; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 4px 6px; }
  .mquants .note { color: var(--dim); }
  .mquants .err { color: #e08b7a; }
  .mquants .fit-ok { color: var(--accent); }
  .mquants .fit-warn { color: var(--yellow); }
  .mnote { display: grid; gap: 6px; margin: 0 0 10px; font-size: .6875rem; }
  .mnote label { color: var(--muted); }
  .mnote textarea { font: inherit; width: 100%; box-sizing: border-box; background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: 3px; padding: 6px; resize: vertical; }
  .mnote textarea:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
  .mnote .note { color: var(--dim); }
  .mf-note-flag { color: var(--accent-2); font-style: normal; }
  .mf-runnow { margin: 4px 0 10px; }
  .mf-runnow h3 { margin: 0 0 8px; font-size: .75rem; color: var(--accent); letter-spacing: 0.04em; }
  .mf-runnow .mrow { margin-bottom: 6px; }
  .mf-progress { margin: 4px 0 10px; }
  .mf-dl { display: flex; align-items: center; gap: 10px; font-size: .6875rem; color: var(--text); padding: 6px 0; }
  .mf-dl span { min-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mf-dl small { color: var(--dim); }
  .mf-bar-track { flex: 1; height: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 3px; overflow: hidden; }
  .mf-bar-fill { height: 100%; background: var(--accent); transition: width 0.4s ease; }
  .mf-bar-fill.indet { width: 40%; animation: mf-slide 1.1s ease-in-out infinite; }
  @keyframes mf-slide { 0% { margin-left: -40%; } 100% { margin-left: 100%; } }
  .msetup { margin: 12px 0; padding: 14px; border: 1px solid var(--border); border-left: 3px solid var(--accent); background: var(--bg); font-size: .75rem; color: var(--text); }
  .msetup strong { color: var(--accent); font-size: .8125rem; }
  .msetup p { margin: 8px 0; line-height: 1.6; color: var(--text); }
  .msetup pre { margin: 12px 0; font: inherit; color: var(--text); white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
  .msetup-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }
  .msetup-actions .btn { min-height: 44px; padding: 10px 16px; }
  .msetup-actions .btn:disabled { opacity: 0.55; cursor: progress; }
  .msetup pre:focus-visible, .msetup-actions .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .msetup-actions [role="status"] { color: var(--accent); overflow-wrap: anywhere; }
  .msetup .msetup-note { margin-bottom: 0; color: var(--text); }
  .grade { flex: 0 0 auto; min-width: 40px; text-align: right; font-size: .6875rem; letter-spacing: 0.5px; }
  .grade b { font-weight: 600; }
  .grade small { display: block; color: var(--dim); font-size: .5625rem; }
  .g-A, .g-Ap { color: var(--accent); }
  .g-B { color: #9ec96a; }
  .g-C { color: #d8b45c; }
  .g-D { color: #d9925a; }
  .g-F { color: #e08b7a; }
  .scorecard { width: 100%; border-collapse: collapse; margin: 0 0 8px; font-size: .625rem; }
  .scorecard th { text-align: right; color: var(--dim); font-weight: 400; font-size: .5625rem; padding: 0 0 4px 8px; letter-spacing: 0.5px; }
  .scorecard th:first-child { text-align: left; padding-left: 0; }
  .scorecard td { text-align: right; padding: 4px 0 4px 8px; border-top: 1px solid #132219; color: #c3cec5; font-variant-numeric: tabular-nums; }
  .scorecard td:first-child { text-align: left; padding-left: 0; color: var(--muted); }
  .scorecard td small { display: block; color: var(--dim); font-size: .5625rem; }
  .scorecard tr.weak td:first-child { color: #e0b07a; }
  .scorecard tr.weak td:first-child::after { content: ' ◂ weak link'; font-size: .5625rem; color: #e0b07a; }
  .scorecard .pos { color: var(--accent); }
  .scorecard .neg { color: #e08b7a; }
  .scorecard .na { color: var(--dim); }
  .verdict { display: flex; align-items: baseline; gap: 10px; margin: 0 0 8px; }
  .verdict .mark { font-size: 1.25rem; font-weight: 600; line-height: 1; }
  .verdict .outof { color: var(--dim); font-size: .625rem; }
  .verdict .says { flex: 1; min-width: 0; color: #9fb3a4; font-size: .625rem; }
  .mf-note { padding: 10px 14px; color: var(--dim); font-size: .625rem; }
  .mf-note button { border: 0; background: none; color: var(--accent); font-size: .625rem; padding: 4px 0; }

  /* marketplace */
  .mp-layout { display: grid; grid-template-columns: minmax(320px, 430px) minmax(0, 1fr); gap: 14px; align-items: start; }
  .mp-list { border: 1px solid var(--border); border-radius: 7px; background: var(--panel); overflow: hidden; }
  .mp-item { width: 100%; display: flex; gap: 12px; align-items: flex-start; padding: 12px 14px; min-height: 66px; border: 0; border-bottom: 1px solid #132219; background: transparent; text-align: left; }
  .mp-item:hover { background: #102017; }
  .mp-item.sel { background: #183024; box-shadow: inset 2px 0 0 var(--accent); }
  .mp-icon { flex: 0 0 42px; height: 42px; display: flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 6px; background: #0d1a13; color: var(--accent); font-size: 1.3125rem; }
  .mp-item .mp-meta { flex: 1; min-width: 0; }
  .mp-item .mp-meta b { display: block; color: #c3cec5; font-weight: 500; font-size: .75rem; }
  .mp-item .mp-meta small { display: block; color: var(--dim); font-size: .5625rem; margin-top: 2px; }
  .mp-item .mp-meta p { margin: 4px 0 0; color: var(--muted); font-size: .625rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-state { flex: 0 0 auto; margin-top: 4px; padding: 4px 10px; border-radius: 3px; font-size: .5625rem; border: 1px solid var(--border); color: var(--muted); }
  .mp-state.installed { color: var(--green); border-color: #2a4935; }
  .mp-detail { border: 1px solid var(--border); border-radius: 7px; background: var(--panel); padding: 22px; min-height: 320px; }
  .mp-detail .mp-head { display: flex; gap: 16px; align-items: center; margin-bottom: 14px; }
  .mp-detail .mp-icon { flex-basis: 56px; height: 56px; font-size: 1.75rem; }
  .mp-detail h2 { margin: 0; font-size: 1.125rem; font-weight: 500; }
  .mp-detail .mp-by { color: var(--dim); font-size: .625rem; margin-top: 3px; }
  .mp-detail .mp-desc { color: #a6b4aa; font-size: .75rem; line-height: 1.7; margin: 0 0 14px; }
  .mp-detail .mp-tags { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .mp-detail .mp-tags span { padding: 4px 10px; border: 1px solid var(--border); border-radius: 3px; color: var(--muted); font-size: .5625rem; }
  .mp-detail .mp-actions { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
  .mp-detail .mp-note { color: var(--yellow); font-size: .625rem; margin: 0 0 10px; }
  .mp-detail a { color: var(--accent); font-size: .625rem; }
  .mp-detail .mp-empty { color: var(--dim); font-size: .6875rem; padding: 40px 0; text-align: center; }
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
  .gw-alert { display: flex; gap: 10px; align-items: flex-start; padding: 11px 14px; border: 1px solid var(--border); border-left-width: 3px; border-radius: 5px; background: var(--panel); font-size: .6875rem; color: #a6b4aa; }
  .gw-alert.error { border-left-color: var(--red); }
  .gw-alert.warn { border-left-color: var(--yellow); }
  .gw-alert.info { border-left-color: var(--dim); }
  .gw-alert i { flex: 0 0 auto; font-style: normal; }
  .gw-alert.error i { color: var(--red); }
  .gw-alert.warn i { color: var(--yellow); }
  .gw-alert.info i { color: var(--muted); }
  .gw-table { width: 100%; border-collapse: collapse; font-size: .6875rem; }
  .gw-table th { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--dim); font-weight: 400; font-size: .5625rem; letter-spacing: .06em; }
  .gw-table td { padding: 10px 14px; border-bottom: 1px solid #132219; color: #c3cec5; vertical-align: top; }
  .gw-table tr:last-child td { border-bottom: 0; }
  .gw-table td small { display: block; color: var(--dim); font-size: .5625rem; }
  .gw-table .num { text-align: right; font-variant-numeric: tabular-nums; }
  .gw-state { display: inline-block; padding: 3px 9px; border: 1px solid var(--border); border-radius: 3px; font-size: .5625rem; color: var(--muted); }
  .gw-state.ok { color: var(--green); border-color: #2a4935; }
  .gw-state.bad { color: var(--red); border-color: #4a2a2c; }
  .gw-state.off { color: var(--dim); }
  .gw-empty { padding: 36px 16px; text-align: center; color: var(--dim); font-size: .6875rem; line-height: 1.8; }
  .gw-log { margin-top: 14px; }

  /* terminal */
  /* The terminal box has a definite height so the output scrolls inside its
     own region and the prompt stays pinned below it. */
  .term { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 7px; background: #050a07; overflow: hidden; height: min(70vh, 620px); min-height: 240px; }
  .term-head { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); color: var(--muted); font-size: .625rem; flex: 0 0 auto; }
  .term-head .spacer { flex: 1; }
  .term-head .btn { min-height: 30px; padding: 0 12px; font-size: .625rem; }
  .term-out { flex: 1 1 auto; min-height: 0; height: auto; margin: 0; padding: 14px 16px; overflow: auto; white-space: pre-wrap; word-break: break-word; font-size: .75rem; line-height: 1.55; color: #b9e3b0; background: transparent; }
  .term-line { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--border); flex: 0 0 auto; }
  .term-line span { color: var(--accent); }
  .term-line input { flex: 1; min-height: 38px; border: 0; background: transparent; color: var(--text); font-size: .75rem; }
  .term-line input:focus { outline: none; }
  .term-completion { padding: 8px 14px; border-top: 1px solid var(--border-soft); color: var(--muted); font-size: .6875rem; flex: 0 0 auto; }
  .term-completion[hidden] { display: none; }
  .term-completion b { color: var(--accent); font-weight: 500; }
  .term-completion-list { margin-left: 10px; }
  .term-completion-list .selected { color: var(--accent); }
  .term-completion .unsupported { color: var(--dim); }

  /* settings */
  .set-body { padding: 14px 16px 16px; }
  .set-hint { margin: 0 0 10px; color: var(--dim); font-size: .625rem; line-height: 1.7; }
  .set-input { width: 100%; min-height: 38px; padding: 0 10px; border: 1px solid var(--border); border-radius: 3px; background: var(--panel2); color: var(--text); font-size: .75rem; }
  .set-check { display: flex; align-items: center; gap: 8px; margin: 12px 0 0; color: var(--muted); font-size: .6875rem; }
  .set-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
  .set-msg { color: var(--dim); font-size: .625rem; }
  .set-msg.ok { color: var(--accent); }
  .set-msg.err { color: var(--red); }

  @media (max-width: 860px) {
    .shell { grid-template: 62px 1fr / 1fr; }
    .sidebar { display: none; }
    .mf-bar input[type="search"] { width: 100%; }
    main.host-screen { padding: 22px 18px 40px; }
  }
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand"><b>TOOLBOX</b> MCP<small>LOCAL TOOLS · GATEWAY</small></div>
    <div class="spacer"></div>
    <span class="badge" id="ov-version">…</span>
    <span class="badge">127.0.0.1 ONLY · LOCAL</span>
  </header>

  <aside class="sidebar">
    <button class="navbtn active" data-nav="overview"><i>▣</i><span>Overview</span><small>01</small></button>
    <button class="navbtn" data-nav="models"><i>⌁</i><span>Model Farm</span><small>02</small></button>
    <button class="navbtn" data-nav="terminal"><i>❯</i><span>Terminal</span><small>03</small></button>
    <button class="navbtn" data-nav="marketplace"><i>▦</i><span>Marketplace</span><small>04</small></button>
    <button class="navbtn hidden" data-nav="gateway"><i>⇄</i><span>Gateway</span><small>05</small></button>
    <button class="navbtn" data-nav="settings"><i>⚙</i><span>Settings</span><small>06</small></button>
    <div class="foot"><b>LOCAL SESSION</b><br />MCP stdio + panel<br />127.0.0.1 only</div>
  </aside>

  <main class="host-screen">
    <section id="sec-overview">
      <h1>toolbox-mcp</h1>
      <p class="sub">The server's front page: the tools it exposes to an agent, what it is doing right now, and the widgets it is wired to. Everything below is served by this machine.</p>

      <div class="hero">
        <div class="hero-top">
          <div class="hero-mark">◈</div>
          <div class="hero-id">
            <h2><b>toolbox-mcp</b> · MCP server</h2>
            <p id="ov-blurb">A local-first MCP server: crypto watch, Gmail announcer, resource monitor, Model Farm scoring, marketplace and gateway observability — over stdio, with this panel on the side.</p>
          </div>
        </div>
        <div class="hero-facts" id="ov-facts"></div>
      </div>

      <div class="tiles" id="ov-tiles"></div>

      <div class="ov-grid">
        <div class="card">
          <h2>MCP tool surface <em id="ov-tool-count"></em></h2>
          <div class="tool-search">
            <input type="search" id="ov-tool-search" placeholder="search tools by name, group or purpose…" oninput="ovFilterTools()" autocomplete="off" spellcheck="false" />
            <button class="btn small" onclick="ovFilterTools()">Filter</button>
          </div>
          <div class="grp-chips" id="ov-groups"></div>
          <div id="ov-tools"></div>
        </div>

        <div class="card ov-activity-card">
          <h2>Live activity <em id="ov-act-count"></em></h2>
          <div class="act-list" id="ov-activity"></div>
        </div>
      </div>

      <h2 style="margin:26px 0 12px;font-size:.6875rem;font-weight:400;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Widgets on this machine</h2>
      <div class="card-grid">
        <div class="card" data-widget="crypto-watch"><h2>Crypto watch <em id="ov-crypto-meta"></em></h2><div id="crypto"></div><div class="actions"><button class="btn" onclick="act('crypto_refresh','crypto')">Refresh prices</button></div></div>
        <div class="card" data-widget="gmail-announcer"><h2>Gmail announcer <em id="ov-gmail-meta"></em></h2><div id="gmail"></div><div class="actions"><button class="btn" onclick="act('gmail_check','gmail')">Check inbox</button></div></div>
        <div class="card" data-widget="resource-monitor"><h2>Resource monitor <em id="ov-res-meta"></em></h2><div id="resource"></div><div class="actions"><button class="btn" onclick="act('system_stats','resource')">Refresh stats</button></div></div>
        <div class="card"><h2>Widget bundle <em id="ov-bundle-meta"></em></h2><div id="bundle"></div><div class="actions"><button class="btn" onclick="loadBundle()">Export widgets</button></div></div>
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
        <div class="mf-purpose-filters" id="mf-purpose-filters" aria-label="Filter models by purpose"></div>
        <button class="btn primary" onclick="mfSubmit()">Submit filter</button>
        <button class="btn" onclick="mfSearch()">Search HuggingFace</button>
        <button class="btn" onclick="mfRunNow()">Run now</button>
        <button class="btn" onclick="mfRefresh()">Refresh catalog</button>
        <div class="mf-status" id="mf-status">warming up…</div>
      </div>
      <div class="machine" id="mf-machine"></div>
      <div class="mf-recent hidden" id="mf-recent" aria-label="Recently installed models"></div>
      <div class="card rt-card" id="rt-card">
        <h2>Local runtimes <em id="rt-meta">detecting…</em></h2>
        <p class="rt-intro">Ollama is not the only local runtime. These are the ones found on this machine — pick one and the Model Farm installs into it.</p>
        <div class="rt-list" id="rt-list"></div>
        <div class="actions">
          <button class="btn" onclick="rtDetect()">Scan again</button>
          <button class="btn primary" onclick="rtInstall()">Install / update Ollama</button>
        </div>
        <div class="rt-log" id="rt-log"></div>
      </div>
      <div class="mf-runnow" id="mf-runnow"></div>
      <div class="mf-progress" id="mf-progress"></div>
      <div class="mf-list-nav" id="mf-list-nav">
        <span id="mf-list-position" aria-live="polite">0 purpose lists</span>
        <div class="controls">
          <button class="btn" type="button" aria-label="Scroll model purposes left" onclick="mfScrollColumns(-1)">‹</button>
          <button class="btn" type="button" aria-label="Scroll model purposes right" onclick="mfScrollColumns(1)">›</button>
        </div>
      </div>
      <div class="mf-cols" id="mf-cols" tabindex="0" role="region" aria-label="Model purpose lists"></div>
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
          <input id="term-in" autocomplete="off" spellcheck="false" aria-describedby="term-completion" placeholder="type a command, Enter to run, ↑ history, Tab to complete, Ctrl+C to interrupt" />
        </div>
        <div class="term-completion" id="term-completion" role="status" aria-live="polite" hidden></div>
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
      <p class="sub">Read-only view of the local API gateway: providers, routing, capture posture and recent traffic. Metadata only — no prompt bodies, no setting changes. <a href="https://docs.astrsk.ai/en/How-to-connect-providers" target="_blank" rel="noopener">AstrLink setup guide ↗</a></p>
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

    <section id="sec-settings" class="hidden">
      <h1>Settings</h1>
      <p class="sub">Local preferences. They are stored in your Toolbox settings file, never uploaded.</p>
      <div class="card-grid">
        <div class="card">
          <h2>Crypto watchlist</h2>
          <div class="set-body">
            <p class="set-hint">Coin ids from CoinGecko, comma separated. Up to 8.</p>
            <input class="set-input" id="set-watchlist" type="text" spellcheck="false" placeholder="bitcoin, ethereum, solana" />
            <div class="set-actions">
              <button class="btn primary" onclick="setSaveWatchlist()">Save watchlist</button>
              <span class="set-msg" id="set-watchlist-msg" role="status"></span>
            </div>
          </div>
        </div>
        <div class="card">
          <h2>Resource monitor</h2>
          <div class="set-body">
            <p class="set-hint">Disk to report. Leave empty to follow the system disk.</p>
            <input class="set-input" id="set-diskpath" type="text" spellcheck="false" placeholder="C:\\" />
            <label class="set-check"><input type="checkbox" id="set-processes" /> <span>Show the process list</span></label>
            <div class="set-actions">
              <button class="btn primary" onclick="setSaveResource()">Save monitor settings</button>
              <span class="set-msg" id="set-resource-msg" role="status"></span>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
</div>

<script>
var mf = { scenario: 'now', search: '', taskFilter: '', min: null, max: null, submitted: false, showReds: false, timer: null, expanded: {}, install: {}, quants: {}, progressTimer: null, progressGeneration: 0, listRequest: 0, runNowRequest: 0, runNowShown: false, view: null, prefsLoaded: false, prefsTimer: null, recent: [], notes: {}, noteDrafts: {} }
var lastResult = null

function show(name) {
  document.querySelectorAll('.navbtn').forEach(function (b) { b.classList.toggle('active', b.dataset.nav === name) })
  ;['overview', 'models', 'terminal', 'marketplace', 'gateway', 'settings'].forEach(function (s) {
    document.getElementById('sec-' + s).classList.toggle('hidden', s !== name)
  })
  if (name === 'models') { if (!lastResult) mfFirstLoad(); else mfLoadRecent(); mfSyncProgress() }
  if (name === 'models' && !rt.data) rtDetect()
  if (name === 'terminal') { termAutoStart(); termReveal() }
  if (name === 'marketplace' && !mp.data) mpLoad()
  if (name === 'gateway' && !gw.data) gwLoad()
  if (name === 'settings') setLoad()
  if (name === 'overview') ovTimer()
}
document.querySelectorAll('.navbtn').forEach(function (b) { b.onclick = function () { show(b.dataset.nav) } })

/* ---- overview: the MCP feature surface ---- */
var ov = { catalog: null, tools: [], groups: [], group: '', query: '', activity: null, timer: null }

function fmtPrice(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—'
  if (value >= 1000) return '$' + value.toLocaleString(undefined, { maximumFractionDigits: 0 })
  if (value >= 1) return '$' + value.toLocaleString(undefined, { maximumFractionDigits: 2 })
  return '$' + value.toPrecision(3)
}
function fmtPct(value) {
  if (typeof value !== 'number' || !isFinite(value)) return '—'
  return (value >= 0 ? '+' : '') + value.toFixed(2) + '%'
}
function fmtBytes(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes)) return '—'
  var units = ['B', 'KB', 'MB', 'GB', 'TB']
  var index = 0
  var value = bytes
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index++ }
  return value.toFixed(index === 0 ? 0 : 1) + ' ' + units[index]
}
function fmtUptime(seconds) {
  if (typeof seconds !== 'number' || !isFinite(seconds)) return '—'
  var days = Math.floor(seconds / 86400)
  var hours = Math.floor((seconds % 86400) / 3600)
  var minutes = Math.floor((seconds % 3600) / 60)
  if (days) return days + 'd ' + hours + 'h'
  if (hours) return hours + 'h ' + minutes + 'm'
  return minutes + 'm'
}
function fmtWhen(ms) {
  if (!ms) return '—'
  var delta = Date.now() - ms
  if (delta < 60000) return 'just now'
  if (delta < 3600000) return Math.floor(delta / 60000) + 'm ago'
  if (delta < 86400000) return Math.floor(delta / 3600000) + 'h ago'
  return new Date(ms).toLocaleDateString()
}
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] }) }

/* --- identity, stats --- */
function renderHero(server) {
  var facts = document.getElementById('ov-facts')
  var attached = ov.activity && ov.activity.attached
  var info = server || {}
  facts.innerHTML =
    '<span class="fact"><span class="' + (attached ? 'dot-live' : 'dot-off') + '"></span>' +
      (attached ? 'MCP server attached' : 'Panel only — no MCP client') + '</span>' +
    '<span class="fact">VERSION <b>' + esc(info.version || '—') + '</b></span>' +
    '<span class="fact">TRANSPORT <b>' + esc(info.transport || '—') + '</b></span>' +
    '<span class="fact">TOOLS <b>' + ov.tools.length + '</b></span>' +
    '<span class="fact">PANEL <b>' + esc(info.panel || '—') + '</b></span>' +
    (info.repo ? '<span class="fact"><a href="' + esc(info.repo) + '" target="_blank" rel="noopener" style="color:var(--accent)">github ↗</a></span>' : '')
  document.getElementById('ov-version').textContent = 'toolbox-mcp ' + (info.version || '')
}
function renderTiles(server) {
  var activity = ov.activity && Array.isArray(ov.activity.perTool)
    ? ov.activity
    : { total: 0, failed: 0, perTool: [] }
  var groups = ov.groups.length
  var used = activity.perTool.length
  var tiles = document.getElementById('ov-tiles')
  var html = '<div class="tile"><span>MCP tools</span><b><em>' + ov.tools.length + '</em></b><small>across ' + groups + ' feature groups</small></div>'
  html += '<div class="tile"><span>Tool calls</span><b>' + activity.total + '</b><small>' + (used ? used + ' distinct tools used' : 'no calls recorded yet') + '</small></div>'
  html += '<div class="tile' + (activity.failed ? ' warn' : '') + '"><span>Failed calls</span><b>' + activity.failed + '</b><small>' + (activity.failed ? 'the last calls did not all succeed' : 'every recorded call succeeded') + '</small></div>'
  html += '<div class="tile"><span>Transport</span><b>' + esc((server && server.transport) || '—') + '</b><small>clients speak MCP over stdio</small></div>'
  tiles.innerHTML = html
}

/* --- the tool surface --- */
function renderGroupChips() {
  var box = document.getElementById('ov-groups')
  box.innerHTML = '<button class="grp-chip' + (ov.group === '' ? ' on' : '') + '" onclick="ovPickGroup(\\'\\')">all</button>' +
    ov.groups.map(function (g) {
      var count = ov.tools.filter(function (t) { return t.group === g.id }).length
      return '<button class="grp-chip' + (ov.group === g.id ? ' on' : '') + '" onclick="ovPickGroup(\\\'' + esc(g.id) + '\\\')">' +
        esc(g.icon) + ' ' + esc(g.label) + ' · ' + count + '</button>'
    }).join('')
}
function ovPickGroup(id) {
  ov.group = id
  renderGroupChips()
  renderTools()
}
function ovFilterTools() {
  ov.query = document.getElementById('ov-tool-search').value.trim().toLowerCase()
  renderTools()
}
function renderTools() {
  var box = document.getElementById('ov-tools')
  var groups = ov.groups.filter(function (g) { return !ov.group || g.id === ov.group })
  var total = 0
  var html = ''
  groups.forEach(function (group) {
    var tools = ov.tools.filter(function (tool) {
      if (tool.group !== group.id) return false
      if (!ov.query) return true
      var haystack = (tool.name + ' ' + tool.description + ' ' + group.label + ' ' +
        tool.params.map(function (p) { return p.name + ' ' + p.description }).join(' ')).toLowerCase()
      return haystack.indexOf(ov.query) !== -1
    })
    if (!tools.length) return
    total += tools.length
    var rows = tools.map(function (tool) {
      var params = tool.params.map(function (p) {
        return '<span class="param' + (p.required ? ' req' : '') + '"><i>' + esc(p.name) + '</i> · ' +
          esc(p.type) + (p.required ? ' · required' : '') + (p.description ? ' — ' + esc(p.description) : '') + '</span>'
      }).join('')
      return '<div class="tool"><b>' + esc(tool.name) + '</b><p>' + esc(tool.description) + '</p>' +
        (params ? '<div class="params">' + params + '</div>' : '') + '</div>'
    }).join('')
    html += '<div class="tool-group"><h3><i>' + esc(group.icon) + '</i> ' + esc(group.label) +
      '<small>' + tools.length + ' tool' + (tools.length === 1 ? '' : 's') + ' · ' + esc(group.hint) + '</small></h3>' + rows + '</div>'
  })
  document.getElementById('ov-tool-count').textContent = total + ' of ' + ov.tools.length
  box.innerHTML = html || '<div class="tool-empty">No tool matches "' + esc(ov.query) + '".</div>'
}

/* --- live activity --- */
function renderActivity() {
  var box = document.getElementById('ov-activity')
  var snapshot = ov.activity
  if (!snapshot || !snapshot.attached) {
    document.getElementById('ov-act-count').textContent = ''
    box.innerHTML = '<div class="act-note">The panel is running without an MCP server attached, so there are no tool calls to show. ' +
      'Start the server with <b>toolbox-mcp</b> to watch an agent drive the tool surface.</div>'
    return
  }
  var calls = Array.isArray(snapshot.calls) ? snapshot.calls : []
  document.getElementById('ov-act-count').textContent = (snapshot.total || 0) + ' call' + ((snapshot.total || 0) === 1 ? '' : 's')
  if (!calls.length) {
    box.innerHTML = '<div class="act-note">No calls yet. An agent is connected but has not called a tool.</div>'
    return
  }
  box.innerHTML = calls.map(function (call) {
    return '<div class="act ' + (call.ok ? 'ok' : 'bad') + '">' +
      '<span class="mark">' + (call.ok ? '●' : '✖') + '</span>' +
      '<span class="nm">' + esc(call.tool) + (call.error ? '<span class="err">' + esc(call.error) + '</span>' : '') + '</span>' +
      '<span class="ms">' + call.ms + 'ms</span>' +
      '<span class="when">' + fmtWhen(call.at) + '</span></div>'
  }).join('')
}

/* --- widget cards --- */
function renderCrypto(state) {
  var box = document.getElementById('crypto')
  var meta = document.getElementById('ov-crypto-meta')
  if (!state) { box.innerHTML = '<div class="wempty">No crypto state.</div>'; return }
  if (state.error) {
    meta.textContent = 'error'
    box.innerHTML = '<div class="wempty">' + esc(state.error) + '</div>'
    return
  }
  meta.textContent = (state.watchlist || []).length + ' coins'
  if (!state.coins || !state.coins.length) {
    box.innerHTML = '<div class="wempty">No prices cached yet. Hit “Refresh prices”, or set a watchlist in Settings.</div>'
    return
  }
  var rows = state.coins.map(function (coin) {
    var change = coin.change24h
    var cls = change === null || change === undefined ? 'flat' : change >= 0 ? 'up' : 'down'
    return '<tr><td>' + esc(coin.symbol ? coin.symbol.toUpperCase() : coin.id) +
      '<small>' + esc(coin.name || coin.id) + '</small></td>' +
      '<td>' + fmtPrice(coin.price) + '</td>' +
      '<td class="' + cls + '">' + fmtPct(change) + '</td></tr>'
  }).join('')
  var missing = (state.missing && state.missing.length)
    ? '<div class="wmeta"><b>missing:</b> ' + esc(state.missing.join(', ')) + '</div>'
    : ''
  box.innerHTML = '<table class="wtable"><thead><tr><th>COIN</th><th>PRICE</th><th>24H</th></tr></thead><tbody>' +
    rows + '</tbody></table>' + missing +
    '<div class="wmeta"><b>updated</b> ' + fmtWhen(state.lastCheck) + '</div>'
}
function renderGmail(state) {
  var box = document.getElementById('gmail')
  var meta = document.getElementById('ov-gmail-meta')
  if (!state) { box.innerHTML = '<div class="wempty">No Gmail state.</div>'; return }
  if (!state.configured) {
    meta.textContent = 'not connected'
    box.innerHTML = '<div class="wempty">No Gmail account is connected. An agent can connect one with <b>gmail_connect</b> using a 16-character App Password — it is stored only on this machine.</div>'
    return
  }
  meta.textContent = state.unread + ' unread'
  if (state.error) {
    box.innerHTML = '<div class="wempty">' + esc(state.error) + '</div>'
    return
  }
  var messages = state.messages || []
  if (!messages.length) {
    box.innerHTML = '<div class="wempty">Inbox is clear. Last checked ' + fmtWhen(state.lastCheck) + '.</div>'
    return
  }
  var items = messages.map(function (message) {
    return '<li><b class="' + (message.seen ? 'seen' : 'unread') + '">' +
      (message.seen ? '' : '● ') + esc(message.subject || '(no subject)') + '</b>' +
      '<small>' + esc(message.from || 'unknown sender') + ' · ' + esc(message.date ? new Date(message.date).toLocaleString() : 'no date') + '</small></li>'
  }).join('')
  box.innerHTML = '<ul class="wlist">' + items + '</ul>' +
    '<div class="wmeta"><b>' + esc(state.email) + '</b> · last checked ' + fmtWhen(state.lastCheck) + '</div>'
}
function renderResource(stats) {
  var box = document.getElementById('resource')
  var meta = document.getElementById('ov-res-meta')
  if (!stats) { box.innerHTML = '<div class="wempty">No resource data.</div>'; return }
  meta.textContent = stats.hostname || ''
  function meter(label, used, total, format) {
    var pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0
    var cls = pct >= 90 ? 'bad' : pct >= 75 ? 'warn' : ''
    return '<div><div class="meter-label"><span>' + esc(label) + '</span><b>' + esc(format(used, total, pct)) + '</b></div>' +
      '<div class="meter ' + cls + '"><i style="width:' + pct.toFixed(1) + '%"></i></div></div>'
  }
  var mem = meter('MEMORY', stats.memUsed, stats.memTotal, function (used, total) {
    return fmtBytes(used) + ' / ' + fmtBytes(total)
  })
  var disk = meter('DISK · ' + (stats.diskName || ''), stats.diskTotal - stats.diskFree, stats.diskTotal, function (used, total) {
    return fmtBytes(used) + ' used of ' + fmtBytes(total)
  })
  var cpu = meter('CPU', stats.cpuPercent, 100, function (used) { return used.toFixed(0) + '%' })
  box.innerHTML = '<div class="meters">' + cpu + mem + disk + '</div>' +
    '<div class="wmeta"><b>' + esc(stats.hostname || 'host') + '</b> · ' + esc(stats.platform || '') + ' · ' +
    esc(stats.cores || 0) + ' cores · up ' + esc(fmtUptime(stats.uptime)) + '</div>' +
    (stats.cpuModel ? '<div class="wmeta"><b>cpu</b> ' + esc(stats.cpuModel) + '</div>' : '')
}
function renderBundle(raw) {
  var box = document.getElementById('bundle')
  var meta = document.getElementById('ov-bundle-meta')
  var bundle = null
  try { bundle = JSON.parse(raw) } catch (cause) { bundle = null }
  if (!bundle || !Array.isArray(bundle.widgets)) {
    box.innerHTML = '<div class="wempty">The bundle could not be read.</div>'
    return
  }
  meta.textContent = bundle.widgets.length + ' widgets'
  var names = bundle.widgets.map(function (entry) { return entry.widget }).join(', ')
  box.innerHTML = '<div class="wmeta"><b>' + esc(names) + '</b></div>' +
    '<details class="json"><summary>Show bundle JSON</summary><pre>' + esc(raw) + '</pre></details>'
}

/* --- boot --- */
async function act(action, target) {
  var res = await fetch('/api/' + action, { method: 'POST' })
  var data = await res.json()
  if (target === 'crypto') renderCrypto(data)
  else if (target === 'gmail') renderGmail(data)
  else if (target === 'resource') renderResource(data)
  ovTimer()
}
async function loadBundle() {
  var res = await fetch('/api/widgets_export')
  renderBundle(await res.text())
}
async function loadActivity() {
  var res = await fetch('/api/activity')
  ov.activity = await res.json()
  renderActivity()
  renderTiles(ov.catalog ? ov.catalog.server : { transport: 'stdio' })
}
async function bootOverview() {
  var res = await fetch('/api/overview')
  var data = await res.json()
  var catalogRes = await fetch('/api/catalog')
  var catalog = await catalogRes.json()
  ov.catalog = catalog
  ov.groups = catalog.groups || []
  ov.tools = catalog.tools || []
  await loadActivity()
  renderHero(catalog.server)
  renderGroupChips()
  renderTools()
  renderCrypto(data.crypto)
  renderGmail(data.gmail)
  renderResource(data.resource)
  var installed = data.installed || []
  document.querySelectorAll('[data-widget]').forEach(function (card) {
    card.classList.toggle('hidden', installed.indexOf(card.dataset.widget) === -1)
  })
  var gwInstalled = installed.indexOf('astrlink-gateway') !== -1
  document.querySelector('[data-nav="gateway"]').classList.toggle('hidden', !gwInstalled)
  if (!gwInstalled && !document.getElementById('sec-gateway').classList.contains('hidden')) show('overview')
  loadBundle().catch(function () {})
}
/** The activity feed polls gently so it stays live without hammering the panel. */
function ovTimer() {
  clearTimeout(ov.timer)
  // Only poll while the overview is on screen.
  if (document.getElementById('sec-overview').classList.contains('hidden')) return
  ov.timer = setTimeout(function () { loadActivity().catch(function () {}) }, 4000)
}
bootOverview().catch(function (cause) {
  var box = document.getElementById('ov-tools')
  if (box) box.innerHTML = '<div class="tool-empty">The tool catalog could not be read: ' + esc(cause && cause.message ? cause.message : cause) + '</div>'
})
ovTimer()

/* ---- settings ---- */
var setDirty = false
function setMsg(id, text, kind) {
  var el = document.getElementById(id)
  el.textContent = text
  el.className = 'set-msg' + (kind ? ' ' + kind : '')
}
async function setLoad() {
  if (setDirty) return
  var res = await fetch('/api/settings')
  if (!res.ok) {
    setMsg('set-watchlist-msg', 'Could not read the local settings.', 'err')
    return
  }
  var data = await res.json()
  document.getElementById('set-watchlist').value = (data.watchlist || []).join(', ')
  document.getElementById('set-diskpath').value = data.diskPath || ''
  document.getElementById('set-processes').checked = data.showProcesses !== false
}
document.getElementById('set-watchlist').addEventListener('input', function () { setDirty = true })
document.getElementById('set-diskpath').addEventListener('input', function () { setDirty = true })
document.getElementById('set-processes').addEventListener('change', function () { setDirty = true })
async function setSaveWatchlist() {
  var ids = document.getElementById('set-watchlist').value.split(',').map(function (s) { return s.trim() }).filter(Boolean)
  var res = await fetch('/api/settings/watchlist', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ watchlist: ids })
  })
  var body = await res.json().catch(function () { return {} })
  if (!res.ok) {
    setMsg('set-watchlist-msg', body.error || 'Could not save the watchlist.', 'err')
    return
  }
  setDirty = false
  document.getElementById('set-watchlist').value = (body.watchlist || []).join(', ')
  setMsg('set-watchlist-msg', 'Saved · ' + (body.watchlist || []).length + ' coins', 'ok')
  bootOverview().catch(function () {})
}
async function setSaveResource() {
  var res = await fetch('/api/settings/resource', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      diskPath: document.getElementById('set-diskpath').value,
      showProcesses: document.getElementById('set-processes').checked
    })
  })
  var body = await res.json().catch(function () { return {} })
  if (!res.ok) {
    setMsg('set-resource-msg', body.error || 'Could not save the monitor settings.', 'err')
    return
  }
  setDirty = false
  setMsg('set-resource-msg', 'Saved.', 'ok')
  bootOverview().catch(function () {})
}

/* ---- model farm ---- */
function gb(bytes) { return (bytes / Math.pow(2, 30)).toFixed(1) + ' GB' }
// Pre-flight disk fit for one quant, mirroring the install disk guard: a quant
// heavier than free disk is "too big", one that fits but leaves <1 GB is "tight".
function quantDiskFit(sizeBytes) {
  var free = lastResult && lastResult.machine && typeof lastResult.machine.freeDiskBytes === 'number' ? lastResult.machine.freeDiskBytes : null
  if (free === null || typeof sizeBytes !== 'number' || sizeBytes <= 0) return null
  if (sizeBytes > free) return { tag: 'too big', cls: 'fit-warn', headroom: free - sizeBytes }
  var headroom = free - sizeBytes
  if (headroom < Math.pow(2, 30)) return { tag: 'tight', cls: 'fit-warn', headroom: headroom }
  return { tag: 'fits', cls: 'fit-ok', headroom: headroom }
}
function quantFitNote(quant) {
  var generic = '<span class="note">disk fit unavailable — checked again at install</span>'
  var chosenVal = quant.chosen
  var q = (quant.list || []).find(function (entry) { return (entry.quant || entry.filename) === chosenVal })
  if (!q) return generic
  var fit = quantDiskFit(q.sizeBytes)
  if (!fit) return generic
  if (fit.tag === 'too big') return '<span class="fit-warn">' + esc(chosenVal) + ' needs ' + gb(q.sizeBytes) + ' — only ' + gb(q.sizeBytes + fit.headroom) + ' free (short ' + gb(-fit.headroom) + ')</span>'
  if (fit.tag === 'tight') return '<span class="fit-warn">' + esc(chosenVal) + ' fits but leaves only ' + gb(fit.headroom) + '</span>'
  return '<span class="fit-ok">' + esc(chosenVal) + ' fits with ' + gb(fit.headroom) + ' to spare</span>'
}

function setScenario(sc) {
  mf.scenario = sc
  document.getElementById('sc-now').classList.toggle('on', sc === 'now')
  document.getElementById('sc-total').classList.toggle('on', sc === 'total')
  mfSavePrefs()
  queueLoad()
}
function setRange() {
  mf.min = document.getElementById('f-min').value ? Number(document.getElementById('f-min').value) : null
  mf.max = document.getElementById('f-max').value ? Number(document.getElementById('f-max').value) : null
  mfSavePrefs()
  queueLoad()
}
function setSearch() {
  mf.search = document.getElementById('f-search').value
  queueLoad()
}
/* Browsing options (scenario, purpose, size bounds, reds) survive restarts;
   the search text and the submitted verdict stay per-visit. */
async function mfFirstLoad() {
  if (!mf.prefsLoaded) {
    try {
      await mfRestorePrefs()
      mf.prefsLoaded = true
    } catch (cause) { /* defaults are fine; retry on the next visit */ }
  }
  mfLoadRecent()
  await mfLoad()
}
async function mfRestorePrefs() {
  var res = await fetch('/api/settings')
  if (!res.ok) throw new Error('settings unavailable')
  var prefs = (await res.json()).modelFarm || {}
  mf.scenario = prefs.scenario === 'total' ? 'total' : 'now'
  document.getElementById('sc-now').classList.toggle('on', mf.scenario === 'now')
  document.getElementById('sc-total').classList.toggle('on', mf.scenario === 'total')
  mf.min = typeof prefs.minParams === 'number' ? prefs.minParams : null
  mf.max = typeof prefs.maxParams === 'number' ? prefs.maxParams : null
  document.getElementById('f-min').value = mf.min === null ? '' : String(mf.min)
  document.getElementById('f-max').value = mf.max === null ? '' : String(mf.max)
  mf.taskFilter = typeof prefs.taskFilter === 'string' ? prefs.taskFilter : ''
  mf.showReds = prefs.showReds === true
}
function mfSavePrefs() {
  clearTimeout(mf.prefsTimer)
  mf.prefsTimer = setTimeout(function () {
    fetch('/api/settings/modelfarm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario: mf.scenario, taskFilter: mf.taskFilter, minParams: mf.min, maxParams: mf.max, showReds: mf.showReds })
    }).catch(function () { /* best effort; browsing must not block on a save */ })
  }, 400)
}
function mfAgo(ts) {
  var seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 60) return 'just now'
  var minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm ago'
  var hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h ago'
  var days = Math.floor(hours / 24)
  if (days < 30) return days + 'd ago'
  return new Date(ts).toLocaleDateString()
}
async function mfLoadRecent() {
  var box = document.getElementById('mf-recent')
  try {
    var res = await fetch('/api/settings')
    if (!res.ok) throw new Error('settings unavailable')
    var body = await res.json()
    var history = body.modelInstalls || []
    mf.recent = history
    mf.notes = body.modelNotes || {}
    if (!history.length) { box.innerHTML = ''; box.classList.add('hidden') }
    else {
      box.classList.remove('hidden')
      box.innerHTML = '<span class="mf-recent-title">Recently installed</span>' + history.map(function (entry, index) {
        return '<button type="button" class="mf-recent-chip" onclick="mfRecentJump(' + index + ')" title="' + esc(entry.repo) + ' — search again">' +
          '<b>' + esc(entry.label) + '</b><em>' + mfAgo(entry.installedAt) + (entry.runtime ? ' · ' + esc(entry.runtime) : '') + '</em></button>'
      }).join('')
    }
    if (lastResult) renderGroups(lastResult)
  } catch (cause) {
    box.innerHTML = ''
    box.classList.add('hidden')
  }
}
function mfRecentJump(index) {
  var entry = mf.recent && mf.recent[index]
  if (!entry) return
  document.getElementById('f-search').value = entry.repo
  mfSearch()
}
async function mfSaveNote(id) {
  var input = document.getElementById('mf-note-' + id)
  var note = input ? input.value : ''
  try {
    var res = await fetch('/api/settings/model-note', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: id, note: note })
    })
    var body = await res.json()
    if (!res.ok || body.error) throw new Error(body.error || 'save failed')
    mf.notes = body.modelNotes || {}
    delete mf.noteDrafts[id]
    if (input) input.value = mf.notes[id] || ''
    if (lastResult) renderGroups(lastResult)
    var status = document.getElementById('mf-note-status-' + id)
    if (status) status.textContent = 'saved'
  } catch (cause) {
    var err = document.getElementById('mf-note-status-' + id)
    if (err) err.textContent = String(cause && cause.message ? cause.message : cause)
  }
}
function queueLoad() {
  clearTimeout(mf.timer)
  mf.timer = setTimeout(mfLoad, 150)
}
async function mfLoad() {
  mf.view = { kind: 'catalog' }
  var request = ++mf.listRequest
  var status = document.getElementById('mf-status')
  status.innerHTML = 'scoring…'
  var body = {
    scenario: mf.scenario,
    search: mf.search || undefined,
    minParams: mf.min,
    maxParams: mf.max,
    onlyReachable: mf.submitted && !mf.showReds
  }
  try {
    var res = await fetch('/api/llamafarm/score', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    var result = await res.json()
    if (request !== mf.listRequest) return
    if (!res.ok || !result.groups) {
      status.innerHTML = '<span class="err">' + esc(result.error || 'request failed') + '</span>'
      return
    }
    lastResult = result
    // A remembered purpose that no longer exists in the catalog falls back to All.
    if (mf.taskFilter && !(result.groups || []).some(function (group) { return group.task === mf.taskFilter })) mf.taskFilter = ''
    renderMachine(lastResult.machine, lastResult.machineGrade)
    renderGroups(lastResult)
  } catch (cause) {
    if (request === mf.listRequest) status.innerHTML = '<span class="err">Could not refresh models. Try Refresh.</span>'
  }
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
  mfSavePrefs()
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
  var activeId = rt.data && rt.data.active ? rt.data.active : 'ollama'
  var activeRuntime = rt.data
    ? rt.data.runtimes.filter(function (r) { return r.id === activeId })[0]
    : null
  if (activeRuntime) {
    var state = activeRuntime.running ? 'running' : (activeRuntime.installed ? 'installed' : 'not running')
    html += '<div class="chip"><span>ACTIVE RUNTIME</span><b>' + esc(activeRuntime.label) + ' · ' + state + '</b></div>'
  }
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
    'See the <a href="https://docs.astrsk.ai/en/How-to-connect-providers" target="_blank" rel="noopener">AstrLink provider setup guide ↗</a>. ' +
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
/* ---- local runtimes ---- */
var rt = { data: null, busy: false }

async function rtDetect() {
  var meta = document.getElementById('rt-meta')
  if (!meta) return
  meta.textContent = 'scanning…'
  try {
    var res = await fetch('/api/runtimes')
    rt.data = await res.json()
  } catch (cause) {
    meta.textContent = 'scan failed'
    return
  }
  rtRender()
}
function rtRender() {
  var meta = document.getElementById('rt-meta')
  var list = document.getElementById('rt-list')
  if (!meta || !list || !rt.data || !rt.data.runtimes) return
  var found = rt.data.runtimes.filter(function (r) { return r.installed || r.running })
  meta.textContent = found.length + ' of ' + rt.data.runtimes.length + ' found'
  list.innerHTML = rt.data.runtimes.map(function (r) {
    var state = r.running ? 'running' : (r.installed ? 'installed' : 'not found')
    var active = rt.data.active === r.id
    var detail = r.version ? ' · ' + esc(r.version) : ''
    var models = r.models && r.models.length ? ' · ' + r.models.length + ' models' : ''
    var action = active
      ? '<span class="rt-id"><small>active</small></span>'
      : r.installed
        ? '<button class="btn small" onclick="rtUse(\\\'' + esc(r.id) + '\\\')">use this</button>'
        : '<a class="btn small" href="' + esc(r.homepage) + '" target="_blank" rel="noopener">get it</a>'
    return '<div class="rt-item' + (active ? ' on' : '') + '">' +
      '<div class="rt-id"><b>' + esc(r.label) + '</b><small>' + state + detail + '</small></div>' +
      '<div class="rt-note">' + esc(r.note) + models + '</div>' + action + '</div>'
  }).join('')
}
function rtLabel(id) {
  var found = rt.data && rt.data.runtimes && rt.data.runtimes.filter(function (r) { return r.id === id })[0]
  return found ? found.label : (id === 'ollama' ? 'Ollama' : id)
}
/** The runtime the Model Farm installs into right now. */
function rtActiveLabel() {
  if (!rt.data || !rt.data.runtimes) return 'Ollama'
  var id = rt.data.active ? rt.data.active : 'ollama'
  var found = rt.data.runtimes.filter(function (r) { return r.id === id })[0]
  return found ? found.label : 'Ollama'
}
async function rtUse(id) {
  var log = document.getElementById('rt-log')
  if (log) log.innerHTML = ''
  await fetch('/api/runtimes/use', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: id })
  })
  await rtDetect()
  if (lastResult) await mfLoad()
}
async function rtInstall() {
  var log = document.getElementById('rt-log')
  if (!log || rt.busy) return
  rt.busy = true
  log.innerHTML = '<span>Downloading the official Ollama installer — this can take a minute…</span>'
  try {
    var res = await fetch('/api/runtimes/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: 'ollama' })
    })
    var result = await res.json()
    log.innerHTML = result.ok
      ? '<span class="ok">' + esc(result.message) + '</span>'
      : '<span class="err">' + esc(result.message) + '</span>' +
        (result.log ? '<pre>' + esc(result.log.slice(-2000)) + '</pre>' : '')
  } catch (cause) {
    log.innerHTML = '<span class="err">The install request failed.</span>'
  }
  rt.busy = false
  await rtDetect()
}

var mfPurposeInfoByTask = {
  'text-generation': { label: 'Chat & coding', icon: '⌘', className: 'mf-purpose-coding', color: '#c9afff' },
  'text-to-image': { label: 'Generate artwork', icon: '✦', className: 'mf-purpose-art', color: '#73d9ef' },
  'image-to-image': { label: 'Edit photos', icon: '◉', className: 'mf-purpose-edit', color: '#f0a4bf' },
  'text-to-speech': { label: 'Generate speech', icon: '♫', className: 'mf-purpose-speech', color: '#89dfc5' },
  'automatic-speech-recognition': { label: 'Transcribe audio', icon: '≋', className: 'mf-purpose-transcribe', color: '#f1cc78' },
  'text-to-video': { label: 'Generate video', icon: '▷', className: 'mf-purpose-video', color: '#9dc0ff' },
  'image-to-text': { label: 'Understand images', icon: '◎', className: 'mf-purpose-understand', color: '#b5d7ff' },
  'any-to-any': { label: 'Multimodal', icon: '◇', className: 'mf-purpose-multimodal', color: '#dda8eb' }
}
function mfPurposeInfo(group) {
  return mfPurposeInfoByTask[group.task] || { label: group.label, icon: group.icon, className: '', color: 'var(--text)' }
}
function mfRenderPurposeFilters(result) {
  var root = document.getElementById('mf-purpose-filters')
  var groups = result && Array.isArray(result.groups) ? result.groups : []
  var total = groups.reduce(function (sum, group) { return sum + (group.models || []).length }, 0)
  var buttons = '<span class="label">Purpose</span><button type="button" class="mf-purpose-chip" aria-pressed="' + (!mf.taskFilter) + '" onclick="mfSetTaskFilter(&quot;&quot;)">All <span class="count">' + total + '</span></button>'
  groups.forEach(function (group) {
    var info = mfPurposeInfo(group)
    var count = (group.models || []).length
    var task = String(group.task || '')
    buttons += '<button type="button" class="mf-purpose-chip" aria-pressed="' + (mf.taskFilter === task) + '" onclick="mfSetTaskFilter(&quot;' + esc(task) + '&quot;)">' +
      '<span class="' + esc(info.className) + '">' + esc(info.icon) + ' ' + esc(info.label) + '</span><span class="count">' + count + '</span></button>'
  })
  root.innerHTML = buttons
}
function mfSetTaskFilter(task) {
  var known = lastResult && lastResult.groups && lastResult.groups.some(function (group) { return group.task === task })
  var next = task && known ? task : ''
  if (next !== mf.taskFilter) {
    mf.taskFilter = next
    mfSavePrefs()
  }
  if (lastResult) renderGroups(lastResult)
}
function mfScrollColumns(direction) {
  var list = document.getElementById('mf-cols')
  var distance = Math.max(280, Math.floor((list.clientWidth || 350) * 0.8))
  if (typeof list.scrollBy === 'function') list.scrollBy({ left: direction * distance, behavior: 'smooth' })
  else list.scrollLeft += direction * distance
}
function renderGroups(result) {
  // Re-renders (refresh, outside download completing) must not wipe a note
  // the user is still typing: keep anything that differs from the saved note.
  document.querySelectorAll('textarea.mnote-input').forEach(function (ta) {
    var id = ta.id.slice('mf-note-'.length)
    if (ta.value !== (mf.notes[id] || '')) mf.noteDrafts[id] = ta.value
    else delete mf.noteDrafts[id]
  })
  mfRenderPurposeFilters(result)
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
  var groups = (result.groups || []).filter(function (group) { return !mf.taskFilter || group.task === mf.taskFilter })
  var position = document.getElementById('mf-list-position')
  position.textContent = groups.length ? groups.length + ' purpose list' + (groups.length === 1 ? '' : 's') + (groups.length > 1 ? ' · scroll or use arrows' : '') : 'No purpose lists match these filters.'
  groups.forEach(function (group) {
    var info = mfPurposeInfo(group)
    var col = document.createElement('div')
    col.className = 'mf-col'
    var head = '<h3><i>' + esc(info.icon || group.icon) + '</i> <span class="purpose-name ' + esc(info.className) + '" style="--purpose-color:' + esc(info.color) + '">' + esc(info.label) + '</span><small>' + group.models.length + '</small></h3>'
    var rows = group.models.map(function (m) {
      var meta = (m.paramsBillions ? m.paramsBillions + 'B' : '?') +
        (m.quantLabel ? ' · ' + esc(m.quantLabel) : '') +
        ' · ' + gb(m.runtimeRamBytes) + ' runtime' +
        (m.installed ? ' · <em class="mf-inst">installed' + (m.installedRuntime ? ' in ' + esc(rtLabel(m.installedRuntime)) : '') + '</em>' : '') +
        (mf.notes[m.id] ? ' · <em class="mf-note-flag">note</em>' : '')
      var row = '<button class="mrow v-' + m.verdict + '" onclick="mfToggle(\\'' + esc(m.id) + '\\')">' +
        '<span class="dot"></span><span class="nm"><b>' + esc(m.label) + '</b><small>' + meta + '</small></span>' +
        (m.grade ? '<span class="grade ' + gradeClass(m.grade.letter) + '"><b>' + esc(m.grade.letter) + '</b><small>' + m.grade.score + '</small></span>' : '') +
        '</button>'
      if (mf.expanded[m.id]) {
        var hints = m.hints.map(function (h) { return '<li>' + esc(h) + '</li>' }).join('')
        var inst = mf.install[m.id]
        var pullable = (m.formats || []).indexOf('gguf') !== -1
        var targetName = rtActiveLabel()
        var quant = mf.quants[m.id]
        var quantBlock = ''
        if (pullable) {
          quantBlock = '<div class="mquants"><button class="btn small" onclick="mfQuants(&quot;' + esc(m.id) + '&quot;)">Quants…</button>'
          if (quant && quant.state === 'ok' && quant.list.length) {
            var selectedQuant = quant.list.find(function (q) { return (q.quant || q.filename) === quant.chosen }) ||
              quant.list.find(function (q) { return (q.quant || q.filename) === m.quantLabel }) || quant.list[0]
            quant.chosen = selectedQuant.quant || selectedQuant.filename
            quantBlock += '<select aria-label="Quantization for ' + esc(m.label) + '" onchange="mfPickQuant(&quot;' + esc(m.id) + '&quot;, this)">' +
              quant.list.map(function (q) {
                var val = q.quant || q.filename
                var fit = quantDiskFit(q.sizeBytes)
                return '<option value="' + esc(val) + '"' + (quant.chosen === val ? ' selected' : '') + '>' + esc(val) + ' · ' + gb(q.sizeBytes) + (fit ? ' · ' + fit.tag : '') + '</option>'
              }).join('') + '</select><span id="mf-quant-note-' + esc(m.id) + '" aria-live="polite">' + quantFitNote(quant) + '</span>'
          } else if (quant && quant.state === 'err') {
            quantBlock += '<span class="err">' + esc(quant.error || 'could not list quants') + '</span>'
          } else if (quant && quant.state === 'busy') {
            quantBlock += '<span class="note">listing quants…</span>'
          }
          quantBlock += '</div>'
        }
        var removeBtn = m.installed && m.installedRuntime === 'ollama'
          ? '<button class="btn small" data-repo="' + esc(m.id) + '" data-model="' + esc(m.installed) + '" data-runtime="ollama" onclick="mfRemove(this.dataset.repo,this.dataset.model,this.dataset.runtime)"' + (inst && inst.state === 'busy' ? ' disabled' : '') + '>Remove from Ollama</button>'
          : (m.installed && m.installedRuntime ? '<span class="note">Manage models in ' + esc(rtLabel(m.installedRuntime)) + '.</span>' : '')
        var installBlock = '<div class="minstall">' +
          (pullable
            ? '<button onclick="mfInstall(\\'' + esc(m.id) + '\\')"' + (inst && inst.state === 'busy' ? ' disabled' : '') + '>⬇ Install in ' + esc(targetName) + '</button>'
            : '<span class="note">safetensors only — convert to GGUF to install in ' + esc(targetName) + '</span>') +
          removeBtn +
          (inst ? '<span class="' + (inst.state === 'ok' ? 'ok' : 'err') + '">' + esc(inst.message) + '</span>' : '') +
          '</div>' + quantBlock
        var noteBlock = '<div class="mnote"><label for="mf-note-' + esc(m.id) + '">Note</label>' +
          '<textarea id="mf-note-' + esc(m.id) + '" class="mnote-input" rows="2" maxlength="1000" placeholder="quant that fits, speed, why you kept it…">' +
          esc(mf.noteDrafts[m.id] !== undefined ? mf.noteDrafts[m.id] : (mf.notes[m.id] || '')) + '</textarea>' +
          '<div><button class="btn small" onclick="mfSaveNote(&quot;' + esc(m.id) + '&quot;)">Save note</button> ' +
          '<span id="mf-note-status-' + esc(m.id) + '" class="note" aria-live="polite"></span></div></div>'
        row += '<div class="mdetail"><p>' + esc(m.reason) + '</p>' +
          renderScorecard(m.grade) +
          (hints ? '<ul>' + hints + '</ul>' : '') +
          installBlock + renderAstrlinkSetup(m.id, inst) + noteBlock +
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
  if (!groups.length) {
    cols.innerHTML = '<div class="mf-note">' + (mf.taskFilter ? 'No models in this purpose match the current filters.' : 'nothing matches the current filters.') + '</div>'
  }
}
function mfToggle(id) {
  mf.expanded[id] = !mf.expanded[id]
  if (lastResult) renderGroups(lastResult)
}
async function mfInstall(id, quant) {
  mf.install[id] = { state: 'busy', message: 'downloading…' }
  if (lastResult) renderGroups(lastResult)
  mfStartProgress()
  try {
    var payload = { repo: id }
    var chosen = quant || (mf.quants[id] && mf.quants[id].chosen)
    if (chosen) payload.quant = chosen
    var res = await fetch('/api/llamafarm/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
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
  mfStopProgress()
  if (lastResult) renderGroups(lastResult)
  if (mf.install[id].state === 'ok') await mfRefreshInstalled()
}

// Refresh the current surface without discarding search hits, expansion or quant choices.
async function mfRefreshInstalled() {
  try {
    if (lastResult) {
      if (mf.view && mf.view.kind === 'search') await mfSearch(mf.view.query)
      else if (!mf.view && lastResult.query) await mfSearch(lastResult.query)
      else await mfLoad()
    }
  } catch (cause) {
    document.getElementById('mf-status').innerHTML = '<span class="err">Model changed, but the list could not refresh. Try Refresh.</span>'
  }
  await mfLoadRecent()
  if (mf.runNowShown) await mfRunNow()
}

/* ---- live search, run-now, remove, quants, progress ---- */
async function mfSearch(savedQuery) {
  var status = document.getElementById('mf-status')
  var query = (savedQuery || document.getElementById('f-search').value || '').trim()
  if (!query) { status.innerHTML = '<span class="err">type a search term first</span>'; return }
  mf.view = { kind: 'search', query: query }
  var request = ++mf.listRequest
  status.textContent = 'searching HuggingFace for "' + query + '"…'
  try {
    var res = await fetch('/api/llamafarm/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, scenario: mf.scenario })
    })
    var result = await res.json()
    if (request !== mf.listRequest) return
    if (!res.ok || result.error || !result.groups) { status.innerHTML = '<span class="err">' + esc(result.error || 'search failed') + '</span>'; return }
    lastResult = result
    renderMachine(result.machine, result.machineGrade)
    renderGroups(result)
    status.textContent = 'live search: ' + result.total + ' hits for "' + query + '"'
  } catch (cause) {
    if (request === mf.listRequest) status.innerHTML = '<span class="err">search failed</span>'
  }
}
async function mfRunNow() {
  var request = ++mf.runNowRequest
  mf.runNowShown = true
  var box = document.getElementById('mf-runnow')
  box.innerHTML = '<div class="mf-note">choosing what runs well right now…</div>'
  try {
    var res = await fetch('/api/llamafarm/run-now')
    var result = await res.json()
    if (request !== mf.runNowRequest) return
    if (!res.ok) throw new Error('run-now request failed')
    if (!result.picks || !result.picks.length) {
      box.innerHTML = '<div class="mf-note">nothing scores green right now — free some RAM or try the TOTAL scenario.</div>'
      return
    }
    box.innerHTML = '<h3>Comfortable on this PC right now</h3>' + result.picks.map(function (p) {
      var m = p.model
      return '<button class="mrow v-green" onclick="mfToggle(&quot;' + esc(m.id) + '&quot;)">' +
        '<span class="dot"></span><span class="nm"><b>' + esc(m.label) + '</b><small>' + esc(p.label) +
        ' · ' + (m.paramsBillions ? m.paramsBillions + 'B' : '?') + ' · ' + gb(m.runtimeRamBytes) + ' runtime' +
        (m.installed ? ' · <em class="mf-inst">installed' + (m.installedRuntime ? ' in ' + esc(rtLabel(m.installedRuntime)) : '') + '</em>' : ' · needs download') + '</small></span>' +
        (m.grade ? '<span class="grade ' + gradeClass(m.grade.letter) + '"><b>' + esc(m.grade.letter) + '</b><small>' + m.grade.score + '</small></span>' : '') +
        '</button>'
    }).join('')
  } catch (cause) {
    if (request === mf.runNowRequest) box.innerHTML = '<div class="mf-note err">could not compute run-now picks</div>'
  }
}
async function mfRemove(id, name, runtime) {
  mf.install[id] = { state: 'busy', message: 'removing…' }
  if (lastResult) renderGroups(lastResult)
  try {
    var res = await fetch('/api/llamafarm/remove', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: name, runtime: runtime })
    })
    var body = await res.json()
    var ok = res.ok && body.ok === true
    mf.install[id] = { state: ok ? 'ok' : 'err', message: body.message || (ok ? 'Removed' : 'Remove failed') }
  } catch (cause) {
    mf.install[id] = { state: 'err', message: String(cause && cause.message ? cause.message : cause) }
  }
  mfStopProgress()
  if (lastResult) renderGroups(lastResult)
  if (mf.install[id].state === 'ok') await mfRefreshInstalled()
}
async function mfQuants(id) {
  var chosen = mf.quants[id] && mf.quants[id].chosen
  mf.quants[id] = { state: 'busy', list: [], chosen: chosen }
  if (lastResult) renderGroups(lastResult)
  try {
    var res = await fetch('/api/llamafarm/quants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ repo: id })
    })
    var body = await res.json()
    mf.quants[id] = { state: body.error ? 'err' : 'ok', list: body.quants || [], error: body.error, chosen: chosen }
  } catch (cause) {
    mf.quants[id] = { state: 'err', list: [], error: String(cause && cause.message ? cause.message : cause) }
  }
  if (lastResult) renderGroups(lastResult)
}
function mfPickQuant(id, select) {
  var quant = mf.quants[id]
  if (!quant) return
  quant.chosen = select.value
  // Update just the guidance so keyboard focus stays on the native select.
  var note = document.getElementById('mf-quant-note-' + id)
  if (note) note.innerHTML = quantFitNote(quant)
}
// Downloads can also start outside the panel (e.g. through an MCP tool);
// opening Model Farm checks once and adopts any that are still running.
async function mfSyncProgress() {
  try {
    var res = await fetch('/api/llamafarm/progress')
    var body = await res.json()
    if (!res.ok) return
    if ((body.downloads || []).some(function (d) { return d.status === 'downloading' })) mfStartProgress()
  } catch (cause) { /* best-effort */ }
}
function mfStartProgress() {
  if (mf.progressTimer) return
  var generation = mf.progressGeneration = (mf.progressGeneration || 0) + 1
  var polling = false
  var shown = []
  mf.progressTimer = setInterval(async function () {
    if (polling || generation !== mf.progressGeneration) return
    polling = true
    try {
      var res = await fetch('/api/llamafarm/progress')
      var body = await res.json()
      if (!res.ok || generation !== mf.progressGeneration) return
      var box = document.getElementById('mf-progress')
      var active = (body.downloads || []).filter(function (d) {
        var local = mf.install[d.repo]
        return d.status === 'downloading' && (!local || local.state === 'busy')
      })
      if (!active.length) {
        box.innerHTML = ''
        // An outside download (no local install entry) just finished: the
        // list and the recently-installed strip are stale, so refresh them.
        var outside = shown.some(function (repo) { return !mf.install[repo] })
        shown = []
        mfStopProgress()
        if (outside) mfRefreshInstalled()
        return
      }
      shown = active.map(function (d) { return d.repo })
      box.innerHTML = active.map(function (d) {
        var indet = d.percent === null || d.percent === undefined
        var pct = indet ? 0 : d.percent
        var bar = indet
          ? '<div class="mf-bar-track"><div class="mf-bar-fill indet"></div></div>'
          : '<div class="mf-bar-track"><div class="mf-bar-fill" style="width:' + pct + '%"></div></div>'
        var label = indet ? '<b>pulling…</b>' : '<b>' + pct + '%</b>'
        var size = indet
          ? (d.totalBytes ? 'target ' + gb(d.totalBytes) : '')
          : gb(d.receivedBytes) + (d.totalBytes ? ' / ' + gb(d.totalBytes) : '')
        return '<div class="mf-dl"><span>' + esc(d.repo) + ' → ' + esc(d.runtime) + '</span>' +
          bar + label + '<small>' + size + '</small></div>'
      }).join('')
    } catch (cause) { /* polling is best-effort */ }
    finally { polling = false }
  }, 700)
}
function mfStopProgress() {
  if (Object.keys(mf.install).some(function (id) { return mf.install[id].state === 'busy' })) return
  mf.progressGeneration = (mf.progressGeneration || 0) + 1
  if (mf.progressTimer) { clearInterval(mf.progressTimer); mf.progressTimer = null }
  var box = document.getElementById('mf-progress')
  if (box) box.innerHTML = ''
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
  bootOverview().catch(function () {})
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
  bootOverview().catch(function () {})
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
var HISTORY_KEY = 'toolbox-mcp.terminal.history'
var HISTORY_MAX = 200
var termOut = document.getElementById('term-out')
var termIn = document.getElementById('term-in')

/* New output only pulls the view down while the user is reading the tail:
   scrolling up to read earlier lines is never interrupted. */
var TERM_FOLLOW_MARGIN = 32
function termFollows() {
  if (!termOut) return false
  // A hidden panel has no height yet, so keep the tail current for the moment
  // the user opens the Terminal again.
  if (!termOut.clientHeight) return true
  return termOut.scrollHeight - termOut.scrollTop - termOut.clientHeight <= TERM_FOLLOW_MARGIN
}
function termScrollToTail() {
  if (termOut) termOut.scrollTop = termOut.scrollHeight
}
function termReveal() {
  // The layout settles after the section becomes visible, so the tail is
  // scrolled to once the browser has laid the panel out.
  setTimeout(termScrollToTail, 0)
}

/* The command history survives a page reload: it lives in this browser's
   local storage, never on the server. */
function historyLoad() {
  try {
    var raw = window.localStorage.getItem(HISTORY_KEY)
    var parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) {
      cmdHistory = parsed.filter(function (entry) { return typeof entry === 'string' && entry !== '' })
    }
  } catch (cause) {
    cmdHistory = []
  }
  hIdx = cmdHistory.length
}
function historySave() {
  try {
    window.localStorage.setItem(HISTORY_KEY, JSON.stringify(cmdHistory.slice(-HISTORY_MAX)))
  } catch (cause) {
    // Storage can be unavailable (private mode, quota) — history is a nicety.
  }
}
historyLoad()

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
      var follow = termFollows()
      termOut.textContent += JSON.parse(e.data)
      if (follow) termScrollToTail()
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
var termCompletion = { baseLine: null, lastApplied: null, candidates: [], index: -1, replacementIndex: 0, replacementLength: 0 }
var termCompletionBox = document.getElementById('term-completion')
function termCompletionMessage(message, candidates) {
  termCompletionBox.hidden = !message
  if (!message) { termCompletionBox.innerHTML = ''; return }
  termCompletionBox.innerHTML = '<span>' + esc(message) + '</span>' + (candidates && candidates.length
    ? '<span class="term-completion-list">' + candidates.map(function (candidate, index) {
      return '<span' + (index === termCompletion.index ? ' class="selected"' : '') + '>' + esc(candidate) + '</span>'
    }).join(' · ') + '</span>'
    : '')
}
function termApplyCompletion(index) {
  var candidate = termCompletion.candidates[index]
  if (typeof candidate !== 'string') return
  termCompletion.index = index
  var source = termCompletion.baseLine
  var start = termCompletion.replacementIndex
  var end = start + termCompletion.replacementLength
  termIn.value = source.slice(0, start) + candidate + source.slice(end)
  termCompletion.lastApplied = termIn.value
  var cursor = start + candidate.length
  termIn.selectionStart = termIn.selectionEnd = cursor
  termIn.focus()
  termCompletionMessage('Tab to cycle matches · Enter to run', termCompletion.candidates)
}
async function termComplete(reverse) {
  var current = termIn.value
  var sameCompletion = termCompletion.candidates.length &&
    (current === termCompletion.baseLine || current === termCompletion.lastApplied)
  if (sameCompletion) {
    var count = termCompletion.candidates.length
    var next = (termCompletion.index + (reverse ? count - 1 : 1)) % count
    termApplyCompletion(next)
    return
  }
  var cursor = Number.isInteger(termIn.selectionStart) ? termIn.selectionStart : current.length
  termCompletion = { baseLine: current, lastApplied: null, candidates: [], index: -1, replacementIndex: cursor, replacementLength: 0 }
  try {
    var res = await fetch('/api/terminal/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ line: current, cursor: cursor })
    })
    var result = await res.json()
    if (!res.ok || !result.supported) {
      termCompletionMessage('Shell completion is unavailable here; Tab kept focus in the prompt.')
      return
    }
    termCompletion.candidates = Array.isArray(result.candidates) ? result.candidates.filter(function (entry) { return typeof entry === 'string' }).slice(0, 40) : []
    termCompletion.replacementIndex = Number.isInteger(result.replacementIndex) ? result.replacementIndex : current.length
    termCompletion.replacementLength = Number.isInteger(result.replacementLength) ? result.replacementLength : 0
    if (!termCompletion.candidates.length) {
      termCompletionMessage('No completion found.')
      return
    }
    termApplyCompletion(reverse ? termCompletion.candidates.length - 1 : 0)
  } catch (cause) {
    termCompletionMessage('Could not request shell completion; Tab kept focus in the prompt.')
  }
}
termIn.addEventListener('input', function () {
  termCompletion = { baseLine: null, lastApplied: null, candidates: [], index: -1, replacementIndex: 0, replacementLength: 0 }
  termCompletionMessage('')
})
termIn.addEventListener('keydown', async function (ev) {
  if (ev.key === 'Tab') {
    ev.preventDefault()
    await termComplete(ev.shiftKey)
    termIn.focus()
    return
  }
  if (termCompletion.candidates.length) {
    termCompletion = { baseLine: null, lastApplied: null, candidates: [], index: -1, replacementIndex: 0, replacementLength: 0 }
    termCompletionMessage('')
  }
  if (ev.key === 'Enter') {
    var line = termIn.value
    termIn.value = ''
    if (line.trim()) {
      if (cmdHistory[cmdHistory.length - 1] !== line) cmdHistory.push(line)
      hIdx = cmdHistory.length
      historySave()
    }
    var follow = termFollows()
    termOut.textContent += line + '\\r\\n'
    if (follow) termScrollToTail()
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

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store', ...SECURITY_HEADERS })
  res.end(body)
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    let size = 0
    let overflow = false
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // Stop buffering, but keep draining so the client can still read the
        // 413 answer instead of a dropped connection.
        if (!overflow) {
          overflow = true
          body = ''
        }
        if (size > MAX_DRAIN_BYTES) {
          req.destroy()
          reject(new HttpError(413, 'Request body too large.'))
        }
        return
      }
      body += chunk
    })
    req.on('end', () => {
      if (overflow) reject(new HttpError(413, 'Request body too large.'))
      else resolve(body)
    })
    req.on('error', reject)
  })
}

/** Parse a JSON request body, answering 400 rather than 500 when it is malformed. */
async function readJson<T>(req: import('node:http').IncomingMessage): Promise<T> {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    req.resume()
    throw new HttpError(415, 'Content-Type must be application/json.')
  }
  const raw = await readBody(req)
  try {
    return JSON.parse(raw) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON body.')
  }
}

export interface PanelHandle {
  port: number
  close: () => void
}

export interface PanelOptions {
  port?: number
  /**
   * The MCP call recorder. When it is not attached the panel still works; the
   * activity card then explains that no server is feeding it.
   */
  activity?: Activity
  /**
   * The local shell session. Injectable so the panel can be driven by tests
   * without spawning a real shell on the host.
   */
  terminal?: Terminal
}

export function startPanel(services: Services, options: PanelOptions = {}): Promise<PanelHandle> {
  const terminal = options.terminal ?? createTerminal()
  const activity = options.activity ?? createActivity(false)
  let panelPort = options.port ?? PANEL_PORT
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    void (async () => {
      try {
        // Only the panel's own browser origin may drive the local tools.
        if (!isPanelRequest(req, panelPort)) {
          send(res, 403, JSON.stringify({ error: 'Only local requests are accepted.' }))
          return
        }
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
        if (req.method === 'GET' && url.pathname === '/api/catalog') {
          // The same catalog the MCP server registers, so the panel and an
          // agent always see the same tool surface.
          send(res, 200, JSON.stringify({
            server: {
              name: 'toolbox-mcp',
              version: appVersion(),
              transport: 'stdio',
              panel: `http://127.0.0.1:${panelPort}`,
              repo: REPO_URL
            },
            groups: TOOL_GROUPS,
            tools: catalogEntries()
          }))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/activity') {
          send(res, 200, JSON.stringify(activity.snapshot()))
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
        if (req.method === 'GET' && url.pathname === '/api/settings') {
          send(res, 200, JSON.stringify(await services.settingsSnapshot()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/settings/watchlist') {
          const raw = await readJson<{ watchlist?: unknown }>(req)
          try {
            send(res, 200, JSON.stringify(await services.cryptoSetWatchlist(raw.watchlist)))
          } catch (cause) {
            // The watchlist validator is the only expected failure here.
            send(res, 400, JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }))
          }
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/settings/resource') {
          const raw = await readJson<{ diskPath?: unknown; showProcesses?: unknown }>(req)
          send(res, 200, JSON.stringify(await services.resourceSetSettings(raw)))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/settings/modelfarm') {
          const raw = await readJson<unknown>(req)
          send(res, 200, JSON.stringify(await services.modelFarmSetPrefs(raw)))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/settings/model-note') {
          const raw = await readJson<unknown>(req)
          try {
            send(res, 200, JSON.stringify(await services.modelFarmSetNote(raw)))
          } catch (cause) {
            // The repo validator is the only expected failure here.
            send(res, 400, JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }))
          }
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/widgets_export') {
          send(res, 200, await services.exportWidgets(), 'application/json')
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/widgets_import') {
          const bundle = await readJson<unknown>(req)
          send(res, 200, JSON.stringify(await services.importWidgets(bundle)))
          return
        }

        // --- llamafarm -----------------------------------------------------
        if (req.method === 'POST' && url.pathname === '/api/llamafarm/score') {
          const raw = await readJson<{
            scenario?: 'now' | 'total'
            search?: string
            minParams?: number | null
            maxParams?: number | null
            onlyReachable?: boolean
          }>(req)
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
          const raw = await readJson<{ repo?: string; quant?: string; offload?: number; runtime?: string }>(req)
          send(res, 200, JSON.stringify(await services.llamafarmInstall({
            repo: raw.repo ?? '',
            ...(raw.quant ? { quant: raw.quant } : {}),
            ...(typeof raw.offload === 'number' ? { offload: raw.offload } : {}),
            ...(raw.runtime ? { runtime: raw.runtime } : {})
          })))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/llamafarm/search') {
          const raw = await readJson<{ query?: string; scenario?: 'now' | 'total' }>(req)
          send(res, 200, JSON.stringify(await services.llamafarmSearch({
            query: raw.query ?? '',
            scenario: raw.scenario === 'total' ? 'total' : 'now'
          })))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/llamafarm/quants') {
          const raw = await readJson<{ repo?: string }>(req)
          send(res, 200, JSON.stringify(await services.llamafarmQuants(raw.repo ?? '')))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/llamafarm/remove') {
          const raw = await readJson<{ repo?: string; model?: string; runtime?: string }>(req)
          send(res, 200, JSON.stringify(await services.llamafarmRemove({
            ...(raw.repo ? { repo: raw.repo } : {}),
            ...(raw.model ? { model: raw.model } : {}),
            ...(raw.runtime ? { runtime: raw.runtime } : {})
          })))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/llamafarm/run-now') {
          send(res, 200, JSON.stringify(await services.llamafarmRunNow()))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/llamafarm/progress') {
          send(res, 200, JSON.stringify(await services.llamafarmProgress()))
          return
        }

        // --- local runtimes -------------------------------------------------
        if (req.method === 'GET' && url.pathname === '/api/runtimes') {
          send(res, 200, JSON.stringify(await services.runtimesDetect()))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/runtimes/install') {
          const raw = await readJson<{ id?: string }>(req)
          send(res, 200, JSON.stringify(await services.runtimesInstall(raw.id ?? 'ollama')))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/runtimes/use') {
          const raw = await readJson<{ id?: string }>(req)
          send(res, 200, JSON.stringify(await services.runtimesUse(raw.id ?? '')))
          return
        }
        if (req.method === 'GET' && url.pathname === '/api/runtimes/models') {
          const id = url.searchParams.get('id')
          send(res, 200, JSON.stringify(await services.runtimesModels(id ?? undefined)))
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
          const raw = await readJson<{ id?: unknown }>(req)
          send(res, 200, JSON.stringify(await services.marketplaceInstall(raw.id)))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/marketplace/uninstall') {
          const raw = await readJson<{ id?: unknown }>(req)
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
          const raw = await readJson<{ data?: unknown }>(req)
          send(res, 200, JSON.stringify(terminal.input(typeof raw.data === 'string' ? raw.data : '')))
          return
        }
        if (req.method === 'POST' && url.pathname === '/api/terminal/complete') {
          const raw = await readJson<{ line?: unknown; cursor?: unknown }>(req)
          const line = typeof raw.line === 'string' ? raw.line : ''
          const cursor = typeof raw.cursor === 'number' ? raw.cursor : line.length
          send(res, 200, JSON.stringify(await terminal.complete(line, cursor)))
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
        // Client-side problems keep their own status; everything else is a
        // genuine server fault and must not leak internals.
        if (cause instanceof HttpError) {
          send(res, cause.status, JSON.stringify({ error: cause.message }))
          return
        }
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
      panelPort = address.port
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
