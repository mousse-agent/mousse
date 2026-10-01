import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EvaluationReport } from './types'
import { compactObservation } from './observations'

export function compactReport(report: EvaluationReport): EvaluationReport {
  return {
    ...report,
    trials: report.trials.map((trial) => ({
      ...trial,
      actions: trial.actions.map((action) => ({
        ...action,
        message: action.message && action.message.length > 240 ? action.message.slice(0, 240) : action.message
      }))
    }))
  }
}

export function renderMarkdown(report: EvaluationReport): string {
  const m = report.metrics
  const action = m.executor.supportedActionSuccess
  const task = m.executor.supportedTaskSuccess
  const fmt = (interval: typeof action) => interval.status === 'undefined'
    ? interval.reason
    : `${(interval.p * 100).toFixed(1)}% (${interval.successes}/${interval.n}) Wilson95 [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`
  const lines = [
    '# Q03 / BR-02 browser evaluation',
    '',
    `- Run kind: **${report.runKind}**`,
    `- Model quality: **${report.modelQuality}**`,
    `- Source: \`${report.pin.sourceSha}\``,
    `- Browser: ${report.pin.browserVersion} (${report.chromeSource})`,
    `- Tool schema: v${report.pin.toolSchemaVersion}`,
    `- Prompt: ${report.pin.promptId}`,
    `- Task seed: ${report.pin.taskSeed}`,
    `- Reference machine: ${report.pin.referenceMachine.platform}/${report.pin.referenceMachine.arch} Node ${report.pin.referenceMachine.node} cpus=${report.pin.referenceMachine.cpus}`,
    `- BrowserGym pin: ${report.pin.browsergym.pypiName} ${report.pin.browsergym.pypiVersion} release ${report.pin.browsergym.pypiReleaseCommit}; later inspected snapshot ${report.pin.browsergym.githubCommit}`,
    '',
    '## Metrics',
    '',
    `- Supported executor action success: ${fmt(action)}`,
    `- Supported task success: ${fmt(task)}`,
    `- False success: ${m.executor.falseSuccessCount}`,
    `- Duplicate effects: ${m.executor.duplicateEffectCount}`,
    `- Human interventions: ${m.executor.interventionCount}`,
    `- Retries: ${m.executor.retryCount}`,
    `- Recovery trials: ${m.executor.recoveryCount}`,
    `- Explicit unsupported cases: ${m.executor.unsupportedCount}`,
    `- Observation latency median/p95 ms: ${m.latency.observationMedianMs ?? 'n/a'} / ${m.latency.observationP95Ms ?? 'n/a'}`,
    `- Executor overhead median/p95 ms: ${m.latency.executorOverheadMedianMs ?? 'n/a'} / ${m.latency.executorOverheadP95Ms ?? 'n/a'}`,
    `- Cost tokens/images: ${m.cost.tokens === null ? 'null/unavailable' : m.cost.tokens} / ${m.cost.images === null ? 'null/unavailable' : m.cost.images} (${m.cost.reason})`,
    `- Max RSS bytes: ${m.resources.maxRssBytes ?? 'n/a'}`,
    '',
    '## Gates',
    '',
    `- Executor ≥99%: ${m.gates.executorMet}`,
    `- Task ≥90%: ${m.gates.taskMet}`,
    `- Zero false-success: ${m.gates.falseSuccessMet}`,
    `- Zero duplicate effects: ${m.gates.duplicateMet}`,
    ...m.gates.notes.map((note) => `- ${note}`),
    '',
    '## External benchmark',
    '',
    `- Protocol: ${report.externalBenchmark.protocol}`,
    `- Adapter implemented: ${report.externalBenchmark.adapterImplemented}`,
    `- Full BrowserGym environment available: ${report.externalBenchmark.fullEnvironmentAvailable}`,
    `- Native fixture score claimed: ${report.externalBenchmark.nativeFixtureScoreClaimed}`,
    `- ${report.externalBenchmark.note}`,
    '',
    '### Missing environment',
    '',
    ...report.externalBenchmark.missing.map((item) => `- ${item}`),
    '',
    '### External run command (not executed here)',
    '',
    '```sh',
    ...report.externalBenchmark.externalRunCommand,
    '```',
    '',
    '## Trials',
    '',
    '| Task | Split | Support | Mode | Driver | Success | False | Duplicate | Notes |',
    '|---|---|---|---|---|---|---|---|---|'
  ]
  for (const trial of report.trials) {
    lines.push(`| ${trial.taskId} | ${trial.split} | ${trial.support} | ${trial.observationMode} | ${trial.driverKind} | ${trial.taskSuccess} | ${trial.falseSuccess} | ${trial.duplicateEffect} | ${trial.verifierNotes.join('; ').replaceAll('|', '/')} |`)
  }
  lines.push('')
  return lines.join('\n')
}

export function writeReports(outDir: string, report: EvaluationReport): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true })
  const compact = compactReport(report)
  const jsonPath = join(outDir, 'report.json')
  const mdPath = join(outDir, 'report.md')
  writeFileSync(jsonPath, JSON.stringify(compact, null, 2))
  writeFileSync(mdPath, renderMarkdown(compact))
  return { jsonPath, mdPath }
}

export function sampleObservationNote(): string {
  return JSON.stringify(compactObservation(undefined))
}
