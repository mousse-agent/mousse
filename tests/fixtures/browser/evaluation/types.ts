import type { BrowserAction, BrowserActionOutcome, BrowserElement, BrowserObservation } from '../../../../src/shared/browser/types'

export type EvaluationMode = 'executor' | 'browsergym' | 'live-model'
export type ObservationMode = 'structured' | 'screenshot' | 'hybrid'
export type TaskSplit = 'calibration' | 'held-out'
export type SupportClass = 'supported' | 'unsupported'
export type DriverKind = 'executor-script' | 'fixture-oracle' | 'live-model'
export type CostStatus = 'unavailable' | 'measured'

export interface EvaluationBudgets {
  maxActions: number
  maxElapsedMs: number
  maxToolCalls: number
  maxTokens: number | null
  maxImages: number | null
}

export interface PinRecord {
  sourceSha: string
  browserVersion: string
  browserSha256: string
  toolSchemaVersion: number
  promptId: string
  taskSeed: number
  budgets: EvaluationBudgets
  referenceMachine: ReferenceMachine
  browsergym: {
    pypiName: string
    pypiVersion: string
    pypiReleaseCommit: string
    githubCommit: string
    docs: string
  }
}

export interface ReferenceMachine {
  platform: NodeJS.Platform
  arch: string
  node: string
  cpus: number
  osRelease: string
}

export interface CostRecord {
  status: CostStatus
  tokens: number | null
  images: number | null
  reason: string
}

export interface Interval {
  n: number
  successes: number
  p: number
  low: number
  high: number
  method: 'wilson-95'
}

export interface ActionTrace {
  taskId: string
  trial: number
  seed: number
  support: SupportClass
  observationMode: ObservationMode
  driverKind: DriverKind
  tool: string
  actionType?: string
  startedAt: string
  endedAt: string
  wallMs: number
  observationMs: number | null
  executorOverheadMs: number | null
  outcome: BrowserActionOutcome | 'tool-error' | 'unsupported-reported' | 'skipped'
  dispatched: boolean
  code?: string
  message?: string
  verifiedByGroundTruth: boolean | null
  falseSuccess: boolean
  duplicateEffect: boolean
  intervention: boolean
  retry: boolean
  recovery: boolean
}

export interface TaskTrialResult {
  taskId: string
  trial: number
  seed: number
  split: TaskSplit
  support: SupportClass
  category: string
  observationMode: ObservationMode
  driverKind: DriverKind
  mode: EvaluationMode
  startedAt: string
  endedAt: string
  wallMs: number
  taskSuccess: boolean
  actionSuccessCount: number
  actionCount: number
  falseSuccess: boolean
  duplicateEffect: boolean
  intervention: boolean
  retries: number
  recovery: boolean
  unsupportedReported: boolean
  cost: CostRecord
  actions: ActionTrace[]
  verifierNotes: string[]
  error?: string
}

export interface EvaluationReport {
  kind: 'mousse-browser-evaluation'
  qualification: 'Q03'
  requirement: 'BR-02'
  runKind: 'fixture-only' | 'live-model'
  modelQuality: 'not-applicable' | 'unavailable' | 'measured'
  pin: PinRecord
  generatedAt: string
  chromeSource: string
  chromeMutated: false
  externalBenchmark: ExternalBenchmarkStatus
  trials: TaskTrialResult[]
  metrics: EvaluationMetrics
}

export interface ExternalBenchmarkStatus {
  protocol: 'browsergym-core-0.14.3'
  adapterImplemented: true
  fullEnvironmentAvailable: boolean
  missing: string[]
  externalRunCommand: string[]
  nativeFixtureScoreClaimed: false
  note: string
}

export interface EvaluationMetrics {
  executor: {
    supportedActionSuccess: Interval | { status: 'undefined'; reason: string }
    supportedTaskSuccess: Interval | { status: 'undefined'; reason: string }
    falseSuccessCount: number
    duplicateEffectCount: number
    interventionCount: number
    retryCount: number
    recoveryCount: number
    unsupportedCount: number
  }
  latency: {
    observationMedianMs: number | null
    observationP95Ms: number | null
    executorOverheadMedianMs: number | null
    executorOverheadP95Ms: number | null
    taskMedianMs: number | null
    taskP95Ms: number | null
  }
  cost: CostRecord
  resources: {
    maxRssBytes: number | null
    maxHeapBytes: number | null
    chromeMemoryBytes: number | null
    chromeMemoryStatus: 'unavailable' | 'measured'
  }
  gates: {
    executorTarget: 0.99
    taskTarget: 0.9
    falseSuccessTarget: 0
    duplicateTarget: 0
    executorMet: boolean | null
    taskMet: boolean | null
    falseSuccessMet: boolean
    duplicateMet: boolean
    notes: string[]
  }
}

export interface GroundTruthCheck {
  ok: boolean
  falseSuccess: boolean
  duplicateEffect: boolean
  notes: string[]
}

export type ElementQuery = { name?: string; role?: string; text?: string; ref?: string }

export type RecordedAction =
  | { kind: 'observe'; includeScreenshot?: boolean }
  | { kind: 'find'; query: string; role?: string }
  | { kind: 'act'; action: BrowserAction | ((observation: BrowserObservation) => BrowserAction); expected?: { type: string; text?: string; present?: boolean; includes?: string } }
  | { kind: 'wait'; condition: { type: 'text'; text: string; present: boolean } | { type: 'url'; includes: string } | { type: 'document-ready' }; timeoutMs?: number }
  | { kind: 'tabs'; operation: 'list' | 'new' | 'switch' | 'close'; url?: string }
  | { kind: 'takeover'; owner: 'human' | 'agent' }
  | { kind: 'human-act-expect-block'; action: BrowserAction | ((observation: BrowserObservation) => BrowserAction) }
  | { kind: 'upload'; query: ElementQuery; artifactIds: string[] }
  | { kind: 'replay-stale' }

export interface TaskDefinition {
  id: string
  category: string
  split: TaskSplit
  support: SupportClass
  page: string
  goal: string
  repeatsDefault: number
  observationModes: ObservationMode[]
  expected?: { text?: string; urlIncludes?: string; submitCount?: number }
  script: RecordedAction[]
  verify: (input: VerifierInput) => GroundTruthCheck | Promise<GroundTruthCheck>
}

export interface VerifierInput {
  observation: BrowserObservation | undefined
  submitCount: (path?: string) => number
  downloadNames: string[]
  frameSubmitCount: number
  actionOutcomes: ActionTrace[]
  support: SupportClass
}

export interface LocatedElement {
  element: BrowserElement
  observation: BrowserObservation
}
