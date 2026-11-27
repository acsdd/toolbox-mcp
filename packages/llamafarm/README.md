# LlamaFarm CLI

**Status:** `internal_UAT` — under acceptance testing inside the team. ![status](https://img.shields.io/badge/status-internal_UAT-e8c35c?style=flat-square)

**Site:** <https://acsdd.github.io/toolbox-llamafarm/> — The project landing page.

**What local models fit this machine — and how to run them.**

LlamaFarm reads the live [HuggingFace](https://huggingface.co) catalog, measures every
model by its real file size, and compares that against the RAM and VRAM this computer
actually has. Two questions, two answers:

- **total** — what could this machine run if it were idle?
- **now** — what runs with the memory that is free right now (93% of it, so the desktop
  stays responsive).

Results are grouped per skill set — text generation, text to image, text to speech,
image to text, image to image, text to video, any to any, speech to text — and inside
each group the lightest model comes first.

Part of the Toolbox family:

| App | Repo |
| --- | --- |
| Toolbox (desktop) | [`toolbox-desktop`](https://github.com/acsdd/toolbox-desktop) |
| NAS companion | [`toolbox-nas`](https://github.com/acsdd/toolbox-nas) |
| MCP server + panel | [`toolbox-mcp`](https://github.com/acsdd/toolbox-mcp) |
| Shared widget core | [`toolbox-widgets`](https://github.com/acsdd/toolbox-widgets) |

## Commands

```bash
llamafarm status                  # CPU, RAM, GPU, local runtimes + a 0–100 PC scorecard
llamafarm catalog                 # the live catalog with real file sizes
llamafarm fit                     # what runs here, per skill set, with a setup grade
llamafarm fit --scenario total    # what could run when the machine is idle
llamafarm explain owner/repo      # one model: size, fit, grade comparison + run commands
llamafarm install owner/repo      # pull a GGUF into the local Ollama runtime
llamafarm serve                   # local JSON API for other tools
```

Useful flags: `--task text-to-image`, `--top 5`, `--per-task 40`, `--refresh`,
`--quant Q8_0`, `--offload 24`, `--json`, `--no-color`.

## Grades

Beyond the green/yellow/red fit mark, every model gets a **setup grade A+…F
(0–100)** that pairs this PC against the model on four axes — memory, GPU,
compute and storage — and lets the weakest link drag the score down.

- `status` prints a **PC scorecard**: the machine rated 0–100 on each axis.
- `fit` adds a **grade column** (letter + score) to every model row.
- `explain` shows the full **PC-vs-model comparison** with signed headroom per
  axis and a plain-language weak-link sentence ("This PC covers the model" or
  "Weak link: …").

`--json` carries the same grade objects (`grade` on status/explain, a
`{ score, letter }` grade per model on fit) for other tools to consume.

## Install

Requires Node.js 22+.

```bash
npm install
npm run build
npm link          # optional: puts `llamafarm` on your PATH
```

The shared core (`@toolbox/widgets`) is a sibling checkout — clone
`toolbox-widgets` next to this folder, or point the dependency at your copy.

## The Ollama path

Ollama serves any GGUF straight from the Hub, so no conversion is needed:

```bash
ollama pull hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M
ollama run  hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M
```

`llamafarm install` runs exactly that, and `llamafarm install <repo> --offload 24`
writes a Modelffile that pins how many layers stay on the GPU.

## Local API

`llamafarm serve` exposes the same answers over HTTP on `127.0.0.1:3854`:

| Endpoint | What it returns |
| --- | --- |
| `/api/profile` | The machine profile (RAM, cores, GPUs, Ollama) |
| `/api/catalog` | The catalog (`?task=text-to-image` to narrow it) |
| `/api/fit` | Scored models (`?scenario=now\|total`) |
| `/healthz` | Liveness |

Every request needs `Authorization: Bearer <token>`. A random token is printed on startup, or set `LLAMAFARM_API_TOKEN` to a persistent secret. LAN access requires a specific `--host`, a token of at least 32 characters, and HTTPS via `--tls-cert` and `--tls-key`. Only GET requests are accepted.

## Development

```bash
npm test           # build + node:test suite
npm run typecheck
```

## License

MIT — see [LICENSE](LICENSE).
