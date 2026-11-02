import type { ActionId, ConversationBranchId, OperationId, TurnId, WorkspaceActor } from './workspace'

/**
 * What the thread's own Git did while a change was recorded. Mousse never moves HEAD or a branch for a
 * turn, so this is what the agent or the user did there: `headBefore`/`headAfter` and the branch names are
 * read from the worktree, `rewroteHistory` says the old HEAD is no longer an ancestor of the new one (a
 * reset or rebase), and `operationInProgress` names a merge, rebase, revert or cherry-pick left unfinished.
 */
export interface GitRecord {
  headBefore?: string
  headAfter?: string
  branchBefore?: string
  branchAfter?: string
  rewroteHistory: boolean
  operationInProgress?: string
  /** What was in the worktree at the end but not in the snapshot, and why (a nested repository with no commit). */
  coverageGaps?: Array<{ path: string; reason: string }>
}

/** Persisted once in the operation journal; actions and workflow results reference this ID. */
export interface ChangeReceipt {
  id: string
  operationId: string
  workspaceId: string
  generation: number
  kind: 'checkpoint' | 'integration' | 'undo' | 'redo' | 'revert' | 'publish'
  actor: WorkspaceActor
  turnId?: string
  runId?: string
  actionId?: string
  beforeSha: string
  afterSha: string
  introducedCommits: string[]
  contributions: Array<{ receiptId?: string; actorId?: string; baseSha: string; resultSha: string }>
  retainedRefs: string[]
  externalEffects: ExternalEffect[]
  /** Set when `beforeSha` and `afterSha` are workspace snapshots (see docs/workspace-snapshots.md); absent on commit-based receipts. */
  git?: GitRecord
  /** What of the files this receipt does not cover, in words: "Not covered: vendor/sub (nested repository with no commits)". */
  notCovered?: string
  reversesReceiptId?: string
  publishedReceiptIds?: string[]
  createdAt: string
}

export type ThreadActionState =
  | 'planned'
  | 'running'
  | 'checkpointing'
  | 'completed'
  | 'stopped'
  | 'failed'
  | 'undoing'
  | 'undo_conflict'
  | 'undone'

export interface NativeContextBoundary {
  messageIndex: number
  activeStartIndex?: number
  compactionGeneration: number
  fidelity: 'exact' | 'compacted' | 'legacy'
  compaction?: import('./types').NativeCompactionCheckpoint
  acceptedQueueItemIds?: string[]
  acceptedSteerItemIds?: string[]
  safeBoundaryProof?: string
}

export interface ExternalEffect {
  kind: 'ignored-file' | 'outside-workspace' | 'mcp' | 'network' | 'process' | 'database' | 'unknown'
  description: string
  reversible: false
}

export interface ChildIntegrationRecord {
  receiptId?: string
  operationId?: string
  /** The thread's files before the result came in (a snapshot, or the branch commit of an integration recorded before snapshots). */
  preMergeSha?: string
  agentId: string
  /** The code the worker started from. */
  spawnBaseSha: string
  /** The worker's result: a snapshot of its files, or its branch commit in an integration recorded before snapshots. */
  workerHeadSha: string
  /** The thread's files after the result came in, as `preMergeSha`. */
  integrationSha: string
  /** Which parent of the merge commit is the thread's own; only in integrations recorded before snapshots, which were merges. */
  mainlineParent?: number
  changedPaths: string[]
}

export interface ThreadAction {
  /** Conversation-only receipts never authorize filesystem or external-effect reversal. */
  scope?: 'conversation'
  /** Live projection only; the retention journal remains authoritative. */
  retention?: import('./undoRetention').UndoRetentionEligibility
  receiptId?: string
  actor?: WorkspaceActor
  runId?: string
  id: ActionId
  turnId: TurnId
  conversationBranchId: ConversationBranchId
  parentActionId?: ActionId
  presentationMessageStart: number
  presentationMessageEnd: number
  /** Context position before the turn was admitted; conversation undo restores here. */
  nativeContextStartBoundary?: NativeContextBoundary
  /** Context position after the turn settled; forks restore this point. */
  nativeContextBoundary: NativeContextBoundary
  /** The code before the action: a workspace snapshot, or a branch commit in actions recorded before snapshots. */
  startSha: string
  /** The code after the action, as `startSha`. */
  endSha: string
  /** Real commits the action added to the thread's HEAD (first parent only); empty when history was rewritten. */
  commits: string[]
  childIntegrations: ChildIntegrationRecord[]
  /** The files that differ between the trees of `startSha` and `endSha`. */
  changedPaths: Array<{ path: string; beforeHash?: string; afterHash?: string }>
  externalEffects: ExternalEffect[]
  /** What the thread's Git did during the action; absent on actions recorded before snapshots. */
  git?: GitRecord
  /** A line Undo, Redo or revert shows next to its result, such as commits that were already pushed. */
  notice?: string
  reversible: boolean
  state: ThreadActionState
  compensationActionId?: ActionId
  createdAt: string
  completedAt?: string
}

export interface ConversationBranch {
  id: ConversationBranchId
  name: string
  parentBranchId?: ConversationBranchId
  parentTurnId?: TurnId
  gitBranch: string
  retainedRef: string
  activeActionId?: ActionId
  contextBoundary: NativeContextBoundary
  lifecycle: 'active' | 'inactive' | 'tombstoned'
  creationReason: 'initial' | 'fork' | 'undo' | 'recovery'
  createdAt: string
}

export interface ThreadOperation {
  id: OperationId
  type: 'checkpoint' | 'integrate' | 'publish' | 'undo' | 'revert' | 'fork' | 'redo' | 'trash' | 'restore'
  actionId?: ActionId
  conversationBranchId: ConversationBranchId
  state: string
  owner: string
  expectedGitState?: unknown
  conflictFiles?: string[]
  error?: string
  recoveryDecision?: string
  createdAt: string
  updatedAt: string
}
