# toolbox-mcp

Private, local-first MCP server that exposes the shared [Toolbox widgets](https://github.com/28121978444/toolbox-widgets) — **crypto watch**, **Gmail announcer** and **resource monitor** — to any MCP client, plus a small ops panel on `http://127.0.0.1:3851`.

Part of the Toolbox family:

| App | Repo |
| --- | --- |
| Toolbox (desktop) | [`toolbox-desktop`](https://github.com/28121978444/toolbox-desktop) |
| NAS companion | [`toolbox-nas`](https://github.com/28121978444/toolbox-nas) |
| Shared widget core | [`toolbox-widgets`](https://github.com/28121978444/toolbox-widgets) |

## Tools

| Tool | What it does |
| --- | --- |
| `crypto_status` / `crypto_refresh` / `crypto_set_watchlist` / `crypto_series` | CoinGecko watchlist and price history |
| `gmail_status` / `gmail_check` / `gmail_connect` / `gmail_disconnect` | Read-only Gmail IMAP checks (App Password, 16 chars) |
| `system_stats` / `system_processes` | CPU / memory / disk and top processes |
| `llamafarm_status` / `llamafarm_catalog` / `llamafarm_score` / `llamafarm_refresh` | Model Farm: HuggingFace catalog fit-scored against this machine |
| `widgets_export` / `widgets_import` | Portable widget bundles (same format as Toolbox and the NAS app) |

## Ops panel

`http://127.0.0.1:3851` (override with `TOOLBOX_MCP_PORT`), localhost only.

- **Overview** — the shared widgets, live.
- **Model Farm** — top HuggingFace models per skill (Text Generation, Text to Image,
  Text to Speech, …) as columns, color-marked against this machine:
  green = runs now, yellow = runs if you free resources, red = doesn't fit.
  Wave 1 detects the machine (RAM, cores, GPU VRAM, Ollama) and only requests
  compatible formats (GGUF when Ollama is present). Wave 2 marks models live as
  you filter; wave 3 (Submit) returns the ordered verdict and keeps only reds
  that have an offload path — click a model for hints like `--n-gpu-layers`.
  The catalog is cached in `~/.toolbox-mcp/llamafarm-cache.json` for 6 hours.
- **Terminal** — a local PowerShell session streamed to the browser. It runs
  with your user rights; the panel never binds beyond 127.0.0.1.

![Model Farm](docs/panel-model-farm.png)

## Run

Requires Node.js 22+. The sibling `toolbox-widgets` repo must be checked out next to this one.

```bash
npm install
npm start          # MCP server on stdio + ops panel on 127.0.0.1:3851
```

Settings live in `~/.toolbox-mcp/settings.json` (override with `TOOLBOX_MCP_HOME`).
The file is owner-readable only (`0600`). **Note:** the Gmail App Password is stored
there until OS keychain integration lands — keep the repo private and the file safe.

## Development

```bash
npm test           # build + node:test suite
npm run typecheck
```

## License

MIT — see [LICENSE](LICENSE).
