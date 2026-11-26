import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runCli } from '../dist/index.js'
import { parseArgs, flagBool, flagList, flagNumber, flagString } from '../dist/index.js'
import { formatBytes, formatCount, renderTable, stripAnsi, truncate } from '../dist/index.js'
import { groupByTask, parseScenario } from '../dist/index.js'
import { parseTasks } from '../dist/index.js'
import { createPalette } from '../dist/index.js'
import type { CatalogModel, MachineProfile } from '@toolbox/widgets'

const GiB = 2 ** 30

function model(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'owner/model',
    task: 'text-generation',
    label: 'Model',
    author: 'owner',
    formats: ['gguf'],
    paramsBillions: 7,
    quantLabel: 'Q4_K_M',
    fileBytes: 4 * GiB,
    runtimeRamBytes: 5 * GiB,
    downloads: 1000,
    likes: 10,
    license: 'apache-2.0',
    tags: ['gguf'],
    hfUrl: 'https://huggingface.co/owner/model',
    ...overrides
  }
}

function machine(overrides: Partial<MachineProfile> = {}): MachineProfile {
  return {
    totalRamBytes: 32 * GiB,
    availableRamBytes: 16 * GiB,
    cores: 16,
    gpus: [{ name: 'Test GPU', vramBytes: 8 * GiB }],
    ollama: { installed: true, url: 'http://127.0.0.1:11434', models: [], error: null },
    detectedAt: 1_700_000_000_000,
    ...overrides
  }
}

interface RunResult {
  code: number
  output: string
}

async function run(argv: string[], deps: Record<string, unknown> = {}): Promise<RunResult> {
  let output = ''
  const code = await runCli(argv, {
    write: (text: string) => {
      output += text
    },
    cachePath: join(tmpdir(), `llamafarm-test-cache-${process.pid}-${Math.random().toString(36).slice(2)}.json`),
    ...deps
  })
  return { code, output: stripAnsi(output) }
}

describe('argument parsing', () => {
  it('splits the command, positionals and flags', () => {
    const parsed = parseArgs(['fit', 'owner/repo', '--scenario', 'total', '--top=3', '--json'])
    assert.equal(parsed.command, 'fit')
    assert.deepEqual(parsed.positionals, ['owner/repo'])
    assert.equal(parsed.flags.scenario, 'total')
    assert.equal(parsed.flags.top, '3')
    assert.equal(parsed.flags.json, true)
  })

  it('treats a trailing flag as a boolean', () => {
    const parsed = parseArgs(['catalog', '--refresh'])
    assert.equal(parsed.flags.refresh, true)
  })

  it('reads typed flags', () => {
    const parsed = parseArgs(['x', '--n', '5', '--flag', '--list', 'a,b', '--off', 'false'])
    assert.equal(flagNumber(parsed.flags, 'n'), 5)
    assert.equal(flagString(parsed.flags, 'n'), '5')
    assert.deepEqual(flagList(parsed.flags, 'list'), ['a', 'b'])
    assert.equal(flagBool(parsed.flags, 'off'), false)
    assert.equal(flagBool(parsed.flags, 'missing'), undefined)
  })

  it('defaults to the help command', () => {
    assert.equal(parseArgs([]).command, 'help')
  })
})

describe('rendering', () => {
  it('formats byte sizes', () => {
    assert.equal(formatBytes(0), '0 B')
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(1.5 * GiB), '1.50 GB')
    assert.equal(formatBytes(31.7 * GiB), '31.7 GB')
  })

  it('formats counts', () => {
    assert.equal(formatCount(999), '999')
    assert.equal(formatCount(1500), '1.5K')
    assert.equal(formatCount(2_500_000), '2.5M')
  })

  it('aligns table columns', () => {
    const palette = createPalette(false)
    const table = renderTable(['A', 'B'], [['one', 'x'], ['longer', 'y']], palette)
    assert.equal(table.split('\n')[0], 'A       B')
    assert.equal(table.split('\n')[1], 'one     x')
  })

  it('truncates long labels', () => {
    assert.equal(truncate('short', 10), 'short')
    assert.equal(truncate('a-very-long-model-name', 10).length, 10)
  })
})

describe('fit grouping', () => {
  it('parses the scenario', () => {
    assert.equal(parseScenario(undefined), 'now')
    assert.equal(parseScenario('now'), 'now')
    assert.equal(parseScenario('total'), 'total')
    assert.throws(() => parseScenario('later'), /Unknown scenario/)
  })

  it('parses tasks and rejects unknown ones', () => {
    assert.deepEqual(parseTasks('text-generation,text-to-image'), ['text-generation', 'text-to-image'])
    assert.equal(parseTasks(undefined), undefined)
    assert.throws(() => parseTasks('nope'), /Unknown task/)
  })

  it('groups models per skill set', () => {
    const groups = groupByTask([
      { ...model({ id: 'a', task: 'text-generation', label: 'A' }) },
      { ...model({ id: 'b', task: 'text-to-image', label: 'B' }) },
      { ...model({ id: 'c', task: 'text-generation', label: 'C' }) }
    ] as never)
    assert.equal(groups.length, 2)
    assert.equal(groups[0]?.task, 'text-generation')
    assert.equal(groups[0]?.models.length, 2)
    assert.equal(groups[1]?.task, 'text-to-image')
  })
})

describe('status command', () => {
  it('reports the machine profile', async () => {
    const result = await run(['status'], { detect: async () => machine() })
    assert.equal(result.code, 0)
    assert.match(result.output, /RAM total\s+32.0 GB/)
    assert.match(result.output, /CPU cores\s+16/)
    assert.match(result.output, /Test GPU/)
  })

  it('emits json when asked', async () => {
    const result = await run(['status', '--json'], { detect: async () => machine() })
    const payload = JSON.parse(result.output)
    assert.equal(payload.cores, 16)
    assert.equal(payload.totalRamBytes, 32 * GiB)
    assert.equal(payload.nowBudgetBytes, Math.round(16 * GiB * 0.93))
  })

  it('shows the PC scorecard with per-axis digits', async () => {
    const result = await run(['status'], { detect: async () => machine() })
    assert.equal(result.code, 0)
    assert.match(result.output, /PC SCORECARD/)
    assert.match(result.output, /\/100/)
    // 16 cores against the 16-core reference ceiling saturates the compute axis.
    assert.match(result.output, /Compute\s+100/)
  })

  it('includes the machine grade in status json', async () => {
    const result = await run(['status', '--json'], { detect: async () => machine() })
    const payload = JSON.parse(result.output)
    assert.equal(payload.grade.axes.length, 4)
    const compute = payload.grade.axes.find((axis: { axis: string }) => axis.axis === 'compute')
    assert.equal(compute.score, 100)
    assert.ok(payload.grade.score >= 0 && payload.grade.score <= 100)
    assert.equal(typeof payload.grade.label, 'string')
  })
})

describe('fit command', () => {
  it('lists the models that fit right now, lightest first', async () => {
    const result = await run(['fit'], {
      detect: async () => machine(),
      fetchCatalog: async () => [
        model({ id: 'big', label: 'Big', runtimeRamBytes: 30 * GiB, fileBytes: 24 * GiB }),
        model({ id: 'small', label: 'Small', runtimeRamBytes: 2 * GiB, fileBytes: 1.6 * GiB })
      ]
    })
    assert.equal(result.code, 0)
    const smallIndex = result.output.indexOf('Small')
    const bigIndex = result.output.indexOf('Big')
    assert.ok(smallIndex > 0 && bigIndex > smallIndex, 'the lighter model comes first')
    assert.match(result.output, /TEXT GENERATION/)
  })

  it('honours the total scenario', async () => {
    const result = await run(['fit', '--scenario', 'total', '--json'], {
      detect: async () => machine(),
      fetchCatalog: async () => [model({ id: 'big', label: 'Big', runtimeRamBytes: 20 * GiB, fileBytes: 16 * GiB })]
    })
    const payload = JSON.parse(result.output)
    assert.equal(payload.scenario, 'total')
    assert.equal(payload.groups[0].models[0].verdict, 'green')
  })

  it('marks a model that needs more memory than is free as yellow', async () => {
    const result = await run(['fit', '--json'], {
      detect: async () => machine(),
      fetchCatalog: async () => [model({ id: 'mid', label: 'Mid', runtimeRamBytes: 20 * GiB, fileBytes: 16 * GiB })]
    })
    const payload = JSON.parse(result.output)
    assert.equal(payload.groups[0].models[0].verdict, 'yellow')
    assert.equal(payload.groups[0].models[0].fitsNow, false)
    assert.equal(payload.groups[0].models[0].fitsTotal, true)
  })

  it('shows a grade column for each model', async () => {
    const result = await run(['fit'], {
      detect: async () => machine(),
      fetchCatalog: async () => [model({ id: 'small', label: 'Small', runtimeRamBytes: 2 * GiB, fileBytes: 1.6 * GiB })]
    })
    assert.equal(result.code, 0)
    // The grade column is appended after the license: a letter grade + 0-100 score.
    assert.match(result.output, /apache-2\.0\s+[A-F]\+?\s+\d{1,3}/)
  })

  it('grades a lighter model higher than a heavy one', async () => {
    const result = await run(['fit', '--json'], {
      detect: async () => machine(),
      fetchCatalog: async () => [
        model({ id: 'heavy', label: 'Heavy', runtimeRamBytes: 40 * GiB, fileBytes: 32 * GiB }),
        model({ id: 'light', label: 'Light', runtimeRamBytes: 2 * GiB, fileBytes: 1.6 * GiB })
      ]
    })
    const payload = JSON.parse(result.output)
    const models = payload.groups[0].models as Array<{ id: string; grade: { score: number; letter: string } }>
    const light = models.find((entry) => entry.id === 'light')
    const heavy = models.find((entry) => entry.id === 'heavy')
    assert.ok(light?.grade && heavy?.grade, 'each model carries a grade')
    assert.ok(light.grade.score > heavy.grade.score, 'the lighter model grades higher')
    assert.match(light.grade.letter, /^[A-F]\+?$/)
  })
})

describe('install command', () => {
  it('refuses to run without a repo', async () => {
    const result = await run(['install'])
    assert.equal(result.code, 2)
    assert.match(result.output, /Usage: llamafarm install/)
  })

  it('explains the missing runtime instead of failing silently', async () => {
    const result = await run(['install', 'owner/model'], {
      fetchModel: async () => model(),
      detect: async () => machine(),
      probeOllama: async () => ({ installed: false, version: null, error: 'ollama command not found' })
    })
    assert.equal(result.code, 3)
    assert.match(result.output, /Ollama is not available/)
    assert.match(result.output, /ollama pull hf\.co\/owner\/model:Q4_K_M/)
  })

  it('pulls the model and prints the run command', async () => {
    const pulled: string[] = []
    const result = await run(['install', 'owner/model'], {
      fetchModel: async () => model(),
      detect: async () => machine(),
      probeOllama: async () => ({ installed: true, version: '0.12.3', error: null }),
      pull: async (reference: string) => {
        pulled.push(reference)
        return { ok: true, code: 0, output: 'success', error: null }
      }
    })
    assert.equal(result.code, 0)
    assert.deepEqual(pulled, ['hf.co/owner/model:Q4_K_M'])
    assert.match(result.output, /ollama run hf\.co\/owner\/model:Q4_K_M/)
  })

  it('reports a failing download', async () => {
    const result = await run(['install', 'owner/model'], {
      fetchModel: async () => model(),
      detect: async () => machine(),
      probeOllama: async () => ({ installed: true, version: '0.12.3', error: null }),
      pull: async () => ({ ok: false, code: 1, output: '', error: 'ollama exited with code 1' })
    })
    assert.equal(result.code, 1)
    assert.match(result.output, /Download failed/)
  })

  it('does not download in a dry run', async () => {
    let pulled = false
    const result = await run(['install', 'owner/model', '--dry-run'], {
      fetchModel: async () => model(),
      detect: async () => machine(),
      probeOllama: async () => ({ installed: true, version: '0.12.3', error: null }),
      pull: async () => {
        pulled = true
        return { ok: true, code: 0, output: '', error: null }
      }
    })
    assert.equal(result.code, 0)
    assert.equal(pulled, false)
    assert.match(result.output, /dry run/)
  })

  it('rejects models that are not published as GGUF', async () => {
    const result = await run(['install', 'owner/model'], {
      fetchModel: async () => model({ formats: ['safetensors'] }),
      detect: async () => machine(),
      probeOllama: async () => ({ installed: true, version: '0.12.3', error: null })
    })
    assert.equal(result.code, 1)
    assert.match(result.output, /not published as GGUF/)
  })
})

describe('explain command', () => {
  it('shows the size, the fit and the run commands', async () => {
    const result = await run(['explain', 'owner/model'], {
      fetchModel: async () => model(),
      detect: async () => machine()
    })
    assert.equal(result.code, 0)
    assert.match(result.output, /Weights\s+4.00 GB/)
    assert.match(result.output, /Runtime RAM\s+5.00 GB/)
    assert.match(result.output, /ollama run hf\.co\/owner\/model:Q4_K_M/)
  })

  it('fails cleanly for a repo without weights', async () => {
    const result = await run(['explain', 'owner/model'], {
      fetchModel: async () => null,
      detect: async () => machine()
    })
    assert.equal(result.code, 1)
    assert.match(result.output, /No GGUF or safetensors weights/)
  })

  it('shows the digits comparison and the coverage sentence', async () => {
    const result = await run(['explain', 'owner/model'], {
      fetchModel: async () => model(),
      detect: async () => machine({ freeDiskBytes: 200 * GiB })
    })
    assert.equal(result.code, 0)
    assert.match(result.output, /SCORECARD/)
    assert.match(result.output, /AXIS/)
    assert.match(result.output, /HEADROOM/)
    // Every axis is measurable and covered, so the PC is not the weak link.
    assert.match(result.output, /This PC covers the model\./)
  })

  it('names the weak link for a model that exceeds the machine', async () => {
    const result = await run(['explain', 'owner/model'], {
      fetchModel: async () => model({ runtimeRamBytes: 40 * GiB, fileBytes: 32 * GiB }),
      detect: async () => machine()
    })
    assert.equal(result.code, 0)
    assert.match(result.output, /Weak link:/)
  })

  it('includes the setup grade in explain json', async () => {
    const result = await run(['explain', 'owner/model', '--json'], {
      fetchModel: async () => model(),
      detect: async () => machine()
    })
    const payload = JSON.parse(result.output)
    assert.equal(payload.grade.axes.length, 4)
    assert.ok(payload.grade.bottleneck && typeof payload.grade.bottleneck.message === 'string')
    assert.ok(payload.grade.score >= 0 && payload.grade.score <= 100)
  })
})

describe('serve command', () => {
  it('answers the local api', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'llamafarm-serve-'))
    try {
      const { startServer } = await import('../dist/index.js')
      let output = ''
      const ctx = {
        deps: {
          detect: async () => machine(),
          fetchCatalog: async () => [model()],
          cachePath: join(directory, 'cache.json')
        },
        args: parseArgs(['serve']),
        palette: createPalette(false),
        json: false,
        write: (text: string) => {
          output += text
        }
      }
      const handle = await startServer(ctx as never, { host: '127.0.0.1', port: 0 })
      const base = `http://127.0.0.1:${handle.port}`
      try {
        const headers = { Authorization: `Bearer ${handle.token}` }
        assert.equal((await fetch(`${base}/api/profile`)).status, 401)
        assert.equal((await fetch(`${base}/api/profile`, { method: 'POST', headers })).status, 405)
        assert.equal((await fetch(`${base}/api/profile`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403)
        const health = await fetch(`${base}/healthz`, { headers })
        assert.equal(health.status, 200)

        const profile = await (await fetch(`${base}/api/profile`, { headers })).json()
        assert.equal(profile.cores, 16)

        const fit = await (await fetch(`${base}/api/fit?scenario=total`, { headers })).json()
        assert.equal(fit.scenario, 'total')
        assert.equal(fit.models.length, 1)

        const missing = await fetch(`${base}/api/nope`, { headers })
        assert.equal(missing.status, 404)
      } finally {
        await handle.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('cli shell', () => {
  it('prints help', async () => {
    const result = await run(['help'])
    assert.equal(result.code, 0)
    assert.match(result.output, /llamafarm <command>/)
    assert.match(result.output, /install <owner\/repo>/)
  })

  it('reports unknown commands', async () => {
    const result = await run(['frobnicate'])
    assert.equal(result.code, 2)
    assert.match(result.output, /Unknown command/)
  })
})
