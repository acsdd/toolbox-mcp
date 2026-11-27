/**
 * LlamaFarm CLI — what local models fit this machine, and how to run them.
 *
 * The heavy lifting (catalog, machine detection, fit scoring, Ollama import)
 * lives in the shared @toolbox/widgets core; this file only wires the
 * commands together and renders the output.
 */
import { flagBool, parseArgs } from './args.js'
import { createPalette } from './render.js'
import { catalogCommand } from './commands/catalog.js'
import { explainCommand } from './commands/explain.js'
import { fitCommand } from './commands/fit.js'
import { installCommand } from './commands/install.js'
import { serveCommand } from './commands/serve.js'
import { statusCommand } from './commands/status.js'
import type { CliDeps, CommandContext } from './context.js'

export const CLI_VERSION = '0.1.0'

const HELP = `llamafarm ${CLI_VERSION} — what local models fit this machine

USAGE
  llamafarm <command> [options]

COMMANDS
  status                    CPU, RAM, GPU and the local model runtimes
  catalog                   Live HuggingFace catalog with real file sizes
  fit                       What runs here — grouped per skill set
  explain <owner/repo>      One model: size, fit and the commands to run it
  install <owner/repo>      Pull a GGUF into the local Ollama runtime
  serve                     Local JSON API for other tools

OPTIONS
  --scenario now|total      Fit scenario (default: now)
  --task <task>             Limit to one skill set, e.g. text-to-image
  --per-task <n>            Catalog depth per skill set (default: 24)
  --top <n>                 Only show the n lightest models per group
  --quant <Q4_K_M>          Quantization tag for install/explain
  --offload <n>             Layers to keep on the GPU (install --offload)
  --refresh                 Ignore the cached catalog
  --port <n> --host <addr>  Address for serve
  --tls-cert <path> --tls-key <path>   Serve over HTTPS
  --json                    Machine readable output
  --no-color                Plain output
`

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const args = parseArgs(argv)
  const write = deps.write ?? ((text: string) => process.stdout.write(text))
  const colorEnabled = flagBool(args.flags, 'no-color') !== true && !process.env.NO_COLOR
  const palette = createPalette(colorEnabled)
  const json = flagBool(args.flags, 'json') === true

  const ctx: CommandContext = { deps, args, palette, json, write }

  try {
    switch (args.command) {
      case 'status':
        return await statusCommand(ctx)
      case 'catalog':
        return await catalogCommand(ctx)
      case 'fit':
        return await fitCommand(ctx)
      case 'explain':
        return await explainCommand(ctx)
      case 'install':
        return await installCommand(ctx)
      case 'serve':
        return await serveCommand(ctx)
      case 'help':
      case '--help':
      case '-h':
        write(HELP)
        return 0
      case 'version':
      case '--version':
        write(`${CLI_VERSION}\n`)
        return 0
      default:
        write(`Unknown command "${args.command}".\n\n${HELP}`)
        return 2
    }
  } catch (cause) {
    write(`${cause instanceof Error ? cause.message : String(cause)}\n`)
    return 1
  }
}
