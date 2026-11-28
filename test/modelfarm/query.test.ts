import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { scoreModels, type CatalogModel, type MachineProfile, type ModelTask, type ScoredModel } from '@toolbox/widgets'
import {
  filterCatalogModels,
  isModelVisible,
  normalizeModelQuery,
  queryModels,
  scoreAndGroupModels
} from '../../dist/modelfarm/query.js'

const GiB = 2 ** 30

function model(id: string, overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id,
    task: 'text-generation',
    label: id.split('/')[1] ?? id,
    author: id.split('/')[0] ?? 'owner',
    formats: ['gguf'],
    paramsBillions: 7,
    quantLabel: 'Q4_K_M',
    fileBytes: 4 * GiB,
    runtimeRamBytes: 5 * GiB,
    downloads: 100,
    likes: 1,
    license: 'mit',
    tags: ['gguf'],
    hfUrl: `https://huggingface.co/${id}`,
    ...overrides
  }
}

function machine(overrides: Partial<MachineProfile> = {}): MachineProfile {
  return {
    totalRamBytes: 32 * GiB,
    availableRamBytes: 16 * GiB,
    cores: 16,
    gpus: [],
    ollama: { installed: false, url: 'http://127.0.0.1:11434', models: [], error: null },
    detectedAt: 1,
    ...overrides
  }
}

describe('canonical query normalization', () => {
  it('trims search, combines task selectors and deduplicates in task order', () => {
    const query = normalizeModelQuery({
      search: '  QwEn  ',
      task: 'text-to-image',
      tasks: ['automatic-speech-recognition', 'text-to-image', 'text-generation'],
      defaultFormats: ['gguf']
    })
    assert.equal(query.search, 'qwen')
    assert.deepEqual(query.tasks, ['text-generation', 'text-to-image', 'automatic-speech-recognition'])
    assert.deepEqual(query.formats, ['gguf'])
    assert.equal(query.scenario, 'now')
    assert.equal(query.top, null)
    assert.equal(query.hideUnreachable, false)
  })

  it('uses the caller format policy and rejects unknown tasks or formats', () => {
    assert.deepEqual(normalizeModelQuery({ defaultFormats: ['gguf', 'safetensors'] }).formats, ['gguf', 'safetensors'])
    assert.deepEqual(normalizeModelQuery({ formats: ['safetensors'] }).formats, ['safetensors'])
    assert.throws(() => normalizeModelQuery({ task: 'unknown' }), /Unknown task/)
    assert.throws(() => normalizeModelQuery({ formats: ['onnx'] }), /Unknown format/)
  })

  it('normalizes bounds and rejects negative or non-finite values', () => {
    assert.equal(normalizeModelQuery({ minParams: 7 }).minParams, 7)
    assert.equal(normalizeModelQuery({ maxParams: null }).maxParams, null)
    for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => normalizeModelQuery({ minParams: value }), /minParams/)
      assert.throws(() => normalizeModelQuery({ maxParams: value }), /maxParams/)
    }
  })

  it('rejects invalid scenarios and invalid explicit top limits', () => {
    assert.throws(() => normalizeModelQuery({ scenario: 'later' as never }), /Unknown scenario/)
    for (const top of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(() => normalizeModelQuery({ top }), /top/)
    }
    assert.equal(normalizeModelQuery({ top: 0 }).top, null)
    assert.equal(normalizeModelQuery({ top: 2 }).top, 2)
  })
})

describe('canonical catalog filtering and visibility', () => {
  const models = [
    model('Owner/Alpha-GGUF', { label: 'Alpha', paramsBillions: null, formats: ['gguf'] }),
    model('Owner/Beta', { label: 'Beta', task: 'text-to-image', paramsBillions: 3, formats: ['safetensors'] }),
    model('Owner/Gamma', { label: 'Gamma', paramsBillions: 13, formats: ['gguf', 'safetensors'] })
  ]

  it('filters once by search, tasks, formats and parameter bounds', () => {
    assert.deepEqual(filterCatalogModels(models, { search: ' ALPHA ', defaultFormats: ['gguf'] }).map((entry) => entry.id), ['Owner/Alpha-GGUF'])
    assert.deepEqual(filterCatalogModels(models, { task: 'text-to-image', formats: ['gguf', 'safetensors'] }).map((entry) => entry.id), ['Owner/Beta'])
    assert.deepEqual(filterCatalogModels(models, { formats: ['safetensors'], minParams: 3, maxParams: 3 }).map((entry) => entry.id), ['Owner/Beta'])
    assert.deepEqual(filterCatalogModels(models, { formats: ['gguf'], minParams: 1 }).map((entry) => entry.id), ['Owner/Gamma'])
    assert.deepEqual(filterCatalogModels(models, { formats: ['gguf'], maxParams: 3 }).map((entry) => entry.id), [])
  })

  it('hides only unreachable red models when reachability policy is enabled', () => {
    const red = { verdict: 'red', hints: [] } as ScoredModel
    const hintedRed = { verdict: 'red', hints: ['offload'] } as ScoredModel
    const yellow = { verdict: 'yellow', hints: [] } as ScoredModel
    assert.equal(isModelVisible(red, { onlyReachable: true }), false)
    assert.equal(isModelVisible(hintedRed, { onlyReachable: true }), true)
    assert.equal(isModelVisible(yellow, { onlyReachable: true }), true)
    assert.equal(isModelVisible(red, { showReds: true }), true)
    assert.equal(isModelVisible(red, { showReds: false }), false)
  })
})

describe('canonical scoring grouping and limits', () => {
  it('calls the scoring primitive exactly once and marks inventory provenance', () => {
    let calls = 0
    const result = queryModels({
      models: [model('Owner/Installed-GGUF', { label: 'Installed' })],
      machine: machine(),
      query: { defaultFormats: ['gguf'] },
      inventory: { names: ['installed:latest'] },
      score: (options) => { calls++; return scoreModels(options) }
    })
    assert.equal(calls, 1)
    assert.equal(result.total, 1)
    assert.equal(result.groups[0]?.models[0]?.installed, 'installed:latest')
    assert.equal(result.groups[0]?.models[0]?.installedRuntime, 'ollama')
  })

  it('groups in MODEL_TASKS order, sorts each group and applies top after sorting', () => {
    const models = [
      model('Owner/Heavy', { label: 'Heavy', runtimeRamBytes: 30 * GiB, fileBytes: 24 * GiB }),
      model('Owner/Light', { label: 'Light', runtimeRamBytes: 2 * GiB, fileBytes: 1.6 * GiB }),
      model('Owner/Image', { label: 'Image', task: 'text-to-image', runtimeRamBytes: 3 * GiB, fileBytes: 2.4 * GiB })
    ]
    const result = queryModels({ models, machine: machine(), query: { top: 1, defaultFormats: ['gguf'] } })
    assert.equal(result.total, 3)
    assert.deepEqual(result.groups.map((group) => group.task), ['text-generation', 'text-to-image'])
    assert.deepEqual(result.groups[0]?.models.map((entry) => entry.id), ['Owner/Light'])
    assert.deepEqual(result.groups[1]?.models.map((entry) => entry.id), ['Owner/Image'])
  })

  it('does not impose an implicit top limit and keeps totals before truncation', () => {
    const models = [model('a'), model('b'), model('c')]
    const all = queryModels({ models, machine: machine() })
    assert.equal(all.groups[0]?.models.length, 3)
    const limited = queryModels({ models, machine: machine(), query: { top: 2 } })
    assert.equal(limited.total, 3)
    assert.equal(limited.groups[0]?.models.length, 2)
  })

  it('applies visibility before grouping and counts only visible matches', () => {
    const models = [
      model('small', { runtimeRamBytes: 2 * GiB, fileBytes: 1.6 * GiB }),
      model('huge', { runtimeRamBytes: 40 * GiB, fileBytes: 32 * GiB })
    ]
    const result = scoreAndGroupModels({ models, machine: machine(), query: { onlyReachable: true } })
    assert.equal(result.total, 1)
    assert.deepEqual(result.groups[0]?.models.map((entry) => entry.id), ['small'])
  })

  it('accepts a single task without treating it as input group order', () => {
    const tasks: ModelTask[] = ['text-to-image', 'text-generation']
    const result = queryModels({
      models: [model('text'), model('image', { task: 'text-to-image' })],
      machine: machine(),
      query: { tasks }
    })
    assert.deepEqual(result.groups.map((group) => group.task), ['text-generation', 'text-to-image'])
  })

  it('does not mutate or alias a caller-owned normalized query', () => {
    const query = normalizeModelQuery({ defaultFormats: ['gguf'], runtime: 'ollama' })
    const before = structuredClone(query)
    const result = scoreAndGroupModels({
      models: [model('text')],
      machine: machine(),
      query,
      runtime: { id: 'lmstudio', api: 'openai' }
    })
    assert.deepEqual(query, before)
    assert.notEqual(result.query, query)
    assert.notEqual(result.query.tasks, query.tasks)
    assert.notEqual(result.query.formats, query.formats)
    assert.notEqual(result.query.runtime, query.runtime)
    assert.deepEqual(result.query.runtime, { id: 'lmstudio', api: 'openai' })
  })

  it('uses an explicit snapshot runtime over a query runtime', () => {
    const result = scoreAndGroupModels({
      models: [model('text')],
      machine: machine(),
      query: { runtime: 'ollama', defaultFormats: ['gguf'] },
      runtime: { id: 'kobold', api: 'kobold' }
    })
    assert.deepEqual(result.query.runtime, { id: 'kobold', api: 'kobold' })
  })
})
