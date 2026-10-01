import type { CostRecord, EvaluationMetrics, EvaluationReport, Interval, TaskTrialResult } from './types'

const Z95 = 1.959963984540054

export function wilsonInterval(successes: number, n: number): Interval | { status: 'undefined'; reason: string } {
  if (!Number.isInteger(successes) || !Number.isInteger(n) || successes < 0 || n < 0 || successes > n) {
    return { status: 'undefined', reason: 'Wilson interval requires 0 ≤ successes ≤ n with integer counts' }
  }
  if (n === 0) return { status: 'undefined', reason: 'No trials; interval is undefined, not 0' }
  const p = successes / n
  const z2 = Z95 * Z95
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const margin = (Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
  return {
    n,
    successes,
    p,
    low: Math.max(0, center - margin),
    high: Math.min(1, center + margin),
    method: 'wilson-95'
  }
}

export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (!sorted.length || p < 0 || p > 1) return null
  const index = (sorted.length - 1) * p
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  const weight = index - lower
  return sorted[lower] * (1 - weight) + sorted[upper] * weight
}

export const UNAVAILABLE_COST: CostRecord = {
  status: 'unavailable',
  tokens: null,
  images: null,
  reason: 'No live model ran; token and image cost are unknown, not zero'
}

export function combineCost(records: CostRecord[]): CostRecord {
  if (!records.length) return UNAVAILABLE_COST
  if (records.some((record) => record.status !== 'measured' || record.tokens === null || record.images === null)) {
    return UNAVAILABLE_COST
  }
  return {
    status: 'measured',
    tokens: records.reduce((sum, record) => sum + (record.tokens ?? 0), 0),
    images: records.reduce((sum, record) => sum + (record.images ?? 0), 0),
    reason: 'Sum of measured live-model cost records'
  }
}

function supportedTrials(trials: TaskTrialResult[]): TaskTrialResult[] {
  return trials.filter((trial) => trial.support === 'supported' && trial.driverKind !== 'live-model')
}

export function actionSucceeded(action: TaskTrialResult['actions'][number]): boolean {
  if (action.support !== 'supported' || action.outcome === 'skipped') return false
  if (action.falseSuccess || action.duplicateEffect) return false
  if (action.outcome === 'tool-error' || action.outcome === 'failed' || action.outcome === 'blocked') return false
  if (action.verifiedByGroundTruth === false) return false
  return action.dispatched || action.outcome === 'verified' || action.outcome === 'unverified'
}

export function computeMetrics(trials: TaskTrialResult[], resources: EvaluationMetrics['resources']): EvaluationMetrics {
  const supported = supportedTrials(trials)
  const countedActions = supported.flatMap((trial) => trial.actions.filter((action) => action.support === 'supported' && action.outcome !== 'skipped'))
  const successfulActions = countedActions.filter(actionSucceeded)
  const successfulTasks = supported.filter((trial) => trial.taskSuccess && !trial.falseSuccess && !trial.duplicateEffect)
  const falseSuccessCount = trials.reduce((sum, trial) => sum + (trial.falseSuccess ? 1 : 0), 0)
  const duplicateEffectCount = trials.reduce((sum, trial) => sum + (trial.duplicateEffect ? 1 : 0), 0)
  const interventionCount = trials.filter((trial) => trial.intervention).length
  const retryCount = trials.reduce((sum, trial) => sum + trial.retries, 0)
  const recoveryCount = trials.filter((trial) => trial.recovery).length
  const unsupportedCount = trials.filter((trial) => trial.support === 'unsupported').length

  const observationSamples = trials.flatMap((trial) => trial.actions.map((action) => action.observationMs).filter((value): value is number => value !== null))
  const overheadSamples = trials.flatMap((trial) => trial.actions.map((action) => action.executorOverheadMs).filter((value): value is number => value !== null))
  const taskSamples = supported.map((trial) => trial.wallMs)

  const executorInterval = wilsonInterval(successfulActions.length, countedActions.length)
  const taskInterval = wilsonInterval(successfulTasks.length, supported.length)
  const notes: string[] = []
  if (executorInterval.status !== 'undefined' && executorInterval.p >= 0.99 && executorInterval.low < 0.99) {
    notes.push(`Executor point estimate is ${(executorInterval.p * 100).toFixed(1)}% but the Wilson 95% lower bound ${executorInterval.low.toFixed(3)} is below 0.99 at n=${executorInterval.n}.`)
  }
  if (taskInterval.status !== 'undefined' && taskInterval.p >= 0.9 && taskInterval.low < 0.9) {
    notes.push(`Task point estimate is ${(taskInterval.p * 100).toFixed(1)}% but the Wilson 95% lower bound ${taskInterval.low.toFixed(3)} is below 0.90 at n=${taskInterval.n}.`)
  }
  notes.push('Model quality is reported separately and is not mixed into executor success.')
  notes.push('Unsupported cases are excluded from the supported-action denominator.')

  return {
    executor: {
      supportedActionSuccess: executorInterval,
      supportedTaskSuccess: taskInterval,
      falseSuccessCount,
      duplicateEffectCount,
      interventionCount,
      retryCount,
      recoveryCount,
      unsupportedCount
    },
    latency: {
      observationMedianMs: percentile(observationSamples, 0.5),
      observationP95Ms: percentile(observationSamples, 0.95),
      executorOverheadMedianMs: percentile(overheadSamples, 0.5),
      executorOverheadP95Ms: percentile(overheadSamples, 0.95),
      taskMedianMs: percentile(taskSamples, 0.5),
      taskP95Ms: percentile(taskSamples, 0.95)
    },
    cost: combineCost(trials.map((trial) => trial.cost)),
    resources,
    gates: {
      executorTarget: 0.99,
      taskTarget: 0.9,
      falseSuccessTarget: 0,
      duplicateTarget: 0,
      executorMet: executorInterval.status === 'undefined' ? null : executorInterval.p >= 0.99,
      taskMet: taskInterval.status === 'undefined' ? null : taskInterval.p >= 0.9,
      falseSuccessMet: falseSuccessCount === 0,
      duplicateMet: duplicateEffectCount === 0,
      notes
    }
  }
}

export function attachMetrics(report: Omit<EvaluationReport, 'metrics'>, resources: EvaluationMetrics['resources']): EvaluationReport {
  return { ...report, metrics: computeMetrics(report.trials, resources) }
}
