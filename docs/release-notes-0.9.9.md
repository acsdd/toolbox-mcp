# Model Farm 0.9.9

A readability fix for the ops panel, plus two pieces of release housekeeping.

## Secondary panel text now meets WCAG AA

The panel's two muted text tokens sat below the 4.5:1 contrast floor on
every surface they are used on, and both are set at 9.9–12px:

| Token | Before | Measured contrast | After | Measured contrast |
| --- | --- | --- | --- | --- |
| muted | `#6d7f74` | 4.31:1 on the page, 3.97:1 on cards | `#93a79a` | 7.35–7.78:1 |
| dim | `#46584d` | 2.41:1 on the page | `#7d9185` | 5.03–5.91:1 |

The measurements are computed in the running panel — the page background,
the card and badge backgrounds and the sidebar — with the same colour values
the browser resolves. No layout or palette change beyond those two tokens,
and the documented Overview screenshot is refreshed from the packaged build.

## Lockfile version caught up

`package-lock.json` still named `0.9.6` in its root fields, three releases
behind the manifest. Both root entries now read `0.9.9`, so the lockfile
describes the package it belongs to.

## Verification

- 282 MCP tests pass; typecheck is clean.
- The packaged smoke test passes: sandboxed window, panel bound to the
  loopback address, the 37-tool catalogue served, and the Overview
  screenshot regenerated.
- The install probe passes against both payloads — the portable app and the
  Setup artifact's extracted payload: 37 tools, matching panel catalogue,
  successful read-only call, MCP client journey.
- The secondary-runtime probe detects 10 runtimes and passes switching to
  LM Studio, unknown-runtime refusal, the non-Ollama removal guard and
  restore.
- No Model Farm, gateway, marketplace or remote-server code changed, so the
  download journeys were not re-run.

No widget-core change ships in this release; it stays at 0.2.2.

## Verify the download

```text
518bd09521bb977567f353ca3871f34a063f355f21943317b21d61e3d8e05344  ModelFarm-Portable-0.9.9.exe  (113,133,221 bytes)
7fd2e6627069f5c572af726c290b5a84c78b02b65440d1058d7e50f673ede0a6  ModelFarm-Setup-0.9.9.exe     (124,820,363 bytes)
```

PowerShell: `Get-FileHash .\ModelFarm-Portable-0.9.9.exe -Algorithm SHA256`.
