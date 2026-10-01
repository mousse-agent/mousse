import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { inspectChromeSource } from './chrome'
import { startEvaluationSite } from './site'
import { createEvaluationRuntime } from './runtime'
import { buildReport, liveModelRefusalTrial, runBrowserGymSuite, runExecutorSuite, runModelSuite } from './runner'
import { createLiveModelDriver } from './modelDriver'
import { attachMetrics } from './metrics'
import { writeReports } from './report'
import { DEFAULT_BUDGETS, REPO_ROOT } from './pin'
import type { EvaluationMode, ObservationMode, TaskSplit } from './types'

export interface CliOptions {
  mode: EvaluationMode | 'all'
  observation: ObservationMode | 'all'
  split: TaskSplit | 'all'
  repeats: number
  seed: number
  stressCycles: number
  out: string
  liveModel: boolean
  research: boolean
  taskIds?: string[]
  modelEndpoint?: string
  modelId: string
  modelRevision: string
}

export function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    mode: 'all',
    observation: 'structured',
    split: 'all',
    repeats: 3,
    seed: 20260911,
    stressCycles: 20,
    out: join(REPO_ROOT, 'scripts', 'evaluation', 'browser', 'samples'),
    liveModel: false,
    research: false,
    modelId: 'mousse-eval-local',
    modelRevision: 'pinned-v1'
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = argv[i + 1]
    if (arg === '--mode' && next) { options.mode = next as CliOptions['mode']; i += 1 }
    else if (arg === '--observation' && next) { options.observation = next as CliOptions['observation']; i += 1 }
    else if (arg === '--split' && next) { options.split = next as CliOptions['split']; i += 1 }
    else if (arg === '--repeats' && next) { options.repeats = Number(next); i += 1 }
    else if (arg === '--seed' && next) { options.seed = Number(next); i += 1 }
    else if (arg === '--stress-cycles' && next) { options.stressCycles = Number(next); i += 1 }
    else if (arg === '--out' && next) { options.out = resolve(next); i += 1 }
    else if (arg === '--task-ids' && next) { options.taskIds = next.split(',').map((id) => id.trim()).filter(Boolean); i += 1 }
    else if (arg === '--model-endpoint' && next) { options.modelEndpoint = next; i += 1 }
    else if (arg === '--model-id' && next) { options.modelId = next; i += 1 }
    else if (arg === '--model-revision' && next) { options.modelRevision = next; i += 1 }
    else if (arg === '--live-model') options.liveModel = true
    else if (arg === '--research') options.research = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(`Q03 browser evaluation
Usage: node scripts/evaluation/browser/run.mjs [--mode executor|browsergym|all] [--observation structured|screenshot|hybrid|all] [--repeats N] [--stress-cycles N] [--seed N] [--task-ids id1,id2] [--out dir] [--model-endpoint URL] [--research]
Conformance mode exits nonzero when a required gate fails; use --research for exploratory runs. Does not download Chrome, call paid models, or write the sibling core cache.
`)
      process.exit(0)
    }
  }
  return options
}

export async function runCli(argv = process.argv.slice(2)): Promise<{ jsonPath: string; mdPath: string }> {
  const options = parseCli(argv)
  const chrome = inspectChromeSource()
  if (!chrome.ok) throw new Error(chrome.message)
  const site = await startEvaluationSite()
  const runtime = await createEvaluationRuntime()
  const rss = { maxRssBytes: process.memoryUsage().rss, maxHeapBytes: process.memoryUsage().heapUsed }
  try {
    const observationModes: ObservationMode[] = options.observation === 'all' ? ['structured', 'hybrid', 'screenshot'] : [options.observation]
    const trials = []
    if (options.mode === 'executor' || options.mode === 'all') {
      trials.push(...await runExecutorSuite({
        runtime,
        site,
        options: {
          observationModes,
          split: options.split,
          repeats: options.repeats,
          seed: options.seed,
          stressCycles: options.stressCycles,
          taskIds: options.taskIds
        }
      }))
    }
    if (options.mode === 'browsergym' || options.mode === 'all') {
      trials.push(...await runBrowserGymSuite({ runtime, site, seed: options.seed }))
    }
    if (options.liveModel && options.modelEndpoint) {
      trials.push(...await runModelSuite({
        runtime,
        site,
        driverFactory: () => createLiveModelDriver({ endpoint: options.modelEndpoint, modelId: options.modelId, revision: options.modelRevision, budgets: DEFAULT_BUDGETS }),
        options: { taskIds: options.taskIds, split: options.split, seed: options.seed, repeats: options.repeats, observationModes }
      }))
    } else {
      trials.push(liveModelRefusalTrial())
    }
    const mem = process.memoryUsage()
    rss.maxRssBytes = Math.max(rss.maxRssBytes, mem.rss)
    rss.maxHeapBytes = Math.max(rss.maxHeapBytes, mem.heapUsed)
    const report = attachMetrics(buildReport({
      trials,
      chrome: { source: chrome.source, version: chrome.version, sha256: chrome.sha256 },
      seed: options.seed
    }), {
      maxRssBytes: rss.maxRssBytes,
      maxHeapBytes: rss.maxHeapBytes,
      chromeMemoryBytes: null,
      chromeMemoryStatus: 'unavailable'
    })
    const paths = writeReports(options.out, report)
    process.stdout.write(`Wrote ${paths.jsonPath}\nWrote ${paths.mdPath}\nrunKind=${report.runKind} modelQuality=${report.modelQuality}\n`)
    if (!options.research && (!report.metrics.gates.executorMet || !report.metrics.gates.taskMet || !report.metrics.gates.falseSuccessMet || !report.metrics.gates.duplicateMet)) {
      process.exitCode = 2
      process.stdout.write('Conformance gates failed; rerun with --research to inspect exploratory results.\n')
    }
    return paths
  } finally {
    await runtime.close()
    await site.close()
    await rm(runtime.home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }).catch(() => undefined)
  }
}

if (process.env.MOUSSE_EVALUATION === '1') {
  runCli().catch((error) => {
    process.stderr.write(String(error instanceof Error ? error.stack ?? error.message : error) + '\n')
    process.exit(1)
  })
}
