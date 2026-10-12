export type RunStatus =
  | 'queued'
  | 'starting'
  | 'running'
  | 'finalizing'
  | 'completed'
  | 'interrupted'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'uncertain'
])

export type AttemptStatus =
  'pending' | 'running' | 'completed' | 'interrupted' | 'failed' | 'cancelled' | 'superseded'

export type AttemptReason = 'initial' | 'steer_restart' | 'retry' | 'recovery'

export interface RunOutcome {
  error?: string
  interruptedBy?: 'user' | 'daemon_restart' | 'provider'
  uncertainReason?: string
  stopRequested?: boolean
}

export interface RunRecord {
  runId: string
  threadId: string
  ordinal: number
  status: RunStatus
  epoch: number
  activeAttemptId: string | null
  source: string
  clientRequestId: string | null
  userMessageId: string | null
  requestedAt: string
  startedAt: string | null
  completedAt: string | null
  outcome: RunOutcome | null
}

export interface ProviderRef {
  provider: string
  model?: string
  sessionId?: string
  nativeTurnId?: string
}

export interface AttemptRecord {
  attemptId: string
  runId: string
  ordinal: number
  reason: AttemptReason
  status: AttemptStatus
  providerRef: ProviderRef | null
  startedAt: string | null
  completedAt: string | null
}

export interface ReceiptRecord {
  clientRequestId: string
  threadId: string
  commandKind: string
  status: 'accepted' | 'rejected' | 'ignored'
  result: unknown
  createdAt: string
}

export interface ThreadEvent {
  seq: number
  threadId: string
  runId: string | null
  type: string
  payload: unknown
  createdAt: string
}

export const runId = (threadId: string, ordinal: number): string =>
  `run:thread:${encodeURIComponent(threadId)}:ordinal:${ordinal}`

export const attemptId = (runId: string, ordinal: number): string => `attempt:${runId}:${ordinal}`
