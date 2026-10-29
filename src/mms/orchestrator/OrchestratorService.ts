import { contextHandoff, previousTurnModel } from './contextHandoff'
import { AppletStore } from '../applets/AppletStore'
import { publishAppletPresentation, recoverAppletPresentation } from '../applets/publishPresentation'
import { validateAppletSubmission, type AppletSubmission } from '../../shared/applets'
import { logDebug } from '../log/diag'
import { ConversationActionService, assertConversationBoundary } from '../actions/ConversationActionService'
import { existsSync } from 'node:fs'
import { sha256Hex } from '../../shared/agents/hashes'
import { AgentEpisodeStore } from '../agents/AgentEpisodeStore'
import { TaskWriterAuthority } from '../agents/TaskWriterAuthority'
import { createAgentToolAccess } from '../agents/WorkspaceAccessPolicy'
import type { AgentWorkspacePolicy } from '../../shared/agentEpisodes'
import { AsyncLocalStorage } from 'async_hooks'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { readFileSync } from 'node:fs'
import {
  isAgentAccessLevel,
  narrowAgentAccess,
  normalizeAgentAccessSettings,
  normalizeContextSettings,
  normalizeRunSettings,
  resolveContextCompactionTokens,
  resolveModelForMode,
  type AgentAccessLevel
} from '../../shared/settings'
import { piInstanceId, PROVIDER_INSTANCE_ERROR_CODES, type ModelOverride } from '../../shared/providerInstances'
import type { Api, Model } from '@earendil-works/pi-ai'
import { customModelDefinition } from '../harness/catalog'
import { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import type { WorkflowChatExecutor } from '../platform/MmsWorkflowChatBridge'
import type { WorkflowChatRun } from '../../shared/workflowChat'
import {
  channelWorkflowInvocationId,
  formatBackgroundWorkflowDelivery,
  isBackgroundWorkflowWaiting,
  scheduleWorkflowInvocationId,
  type BackgroundWorkflowTurnResult,
  type ChannelWorkflowHostIngress,
  type ScheduledJobIngress
} from '../platform/MmsWorkflowChat'
import { DomainRpcError } from '../protocol/domainRegistry'
import { AgentExecutionService } from '../agentDefinitions/AgentExecutionService'
import {
  createDefinitionRuntime,
  definitionMessages,
  definitionFeatureRefusal,
  definitionRunPolicy,
  type DefinitionCheck,
  type DefinitionHostBindings,
  type DefinitionRefusal,
  type DefinitionTurnRequest,
  type DefinitionTurnResult
} from '../agentDefinitions/definitionRuntime'
import { definitionToolGranted, type DefinitionAuthority } from '../agentDefinitions/definitionGate'
import { DefinitionTurnRecord, definitionActor } from '../agentDefinitions/definitionTurnRecord'
import type { AgentExecutionLimit, AgentExecutionRequest, AgentExecutionResult } from '../../shared/agents/execution'
import type { EffectiveAgentGrants } from '../../shared/agents/types'
import { parseThinkingSuffixFromModelId } from '../../shared/modelVariants'
import { EventEmitter } from 'events'
import { nativeAgentAssistantMessage, nativeAgentHistory } from '../providers/nativeAgentHistory'
import { v4 as uuidv4 } from 'uuid'
import { narrowestAccess, TitleTakenRejection, type CommandResult, type RunEngine, type SendDelegation, type StopResult } from '../run/RunEngine'
import { isFencedSource, isPauseHeldSource, isResumeSource } from '../run/delegation/sources'
import { deleteRunResults } from '../run/delegation/hold'
import { decideUsageLimit, usageLimitOf, type UsageLimitDecision } from '../run/pausePolicy'
import { boundedResetIso, estimatedReset } from './providerErrors'
import { CONTINUE_TEXT, MANUAL_CONTINUE_TEXT, pausedLine } from '../run/pauseText'
import { currentStopGeneration, runStopGeneration } from '../run/stopGeneration'
import { buildSubagentView } from '../run/delegation/subagentView'
import { resolveSubagent, subagentsTitled, type SubagentAddressSources } from '../run/delegation/subagentAddress'
import { delegationRequestKey, followUpRequestKey, narrowCeiling } from '../run/delegation/policy'
import { CommandRejection, RunStoreError } from '../run/db/RunStoreError'
import { EffectDeferredError, WorkerStoppedError, type EffectExecutor, type EffectWorker } from '../run/EffectWorker'
import { stopStrategy } from '../run/CommandPolicy'
import { agentMessageText, AppToolTurns, createAppToolRegistry, McpToolError, unattendedRefusal, type AgentApprovalResult, type AgentCreatedThread, type AgentQueueCommand, type AgentQueueResult, type AgentScheduleHost, type AgentRunCommandResult, type AgentSendResult, type AgentThreadRequest, type ApprovalRequestInfo, type AppToolHost, type AppToolTurn, type McpCaller, type QueueSnapshot, type ToolRegistry, userMcpProxy } from '../run/mcp/appTools'
import { AGENT_THREAD_COMMAND, AGENT_THREAD_CREATED_ACTION, AGENT_THREAD_REPAIR_WINDOW_MS, agentThreadFingerprint, LAUNCHED_THREAD_ACCESS_CEILING, readAgentThreadReceipt, type AgentThreadIntent } from './agentThreadIntent'
import { THREAD_CREATE_MAX_ACTIVE_PER_THREAD } from '../run/mcp/appTools/thread'
import { createHash } from 'node:crypto'
import { QueueCommands, type QueueIntent } from '../run/QueueCommands'
import type { PlannedQueueCommand, QueueEffects } from '../queue/queueJournal'
import { modeFactsFor, prepareSkills, sessionInstructions, settingsToolEnabled, turnPreamble } from '../run/mcp/appTools/assemble'
import { questionApproval } from '../run/mcp/appTools/quickActions'
import { APPLET_GENERATION_GUIDANCE } from '../../shared/appletGuidance'
import { defaultIntegrationActor } from '../../shared/integrations/actor'
import { DevGuiTools } from '../devgui/DevGuiTools'
import { QuickActionTools } from './QuickActionTools'
import { WebTools } from './WebTools'
import { stableStringify } from '../run/json'
import { closeStaleActivity, cutOffActivityOf, formatRestartNote } from '../run/restartNote'
import type { OneShotTask } from '../harness/driver'
import { createHarnessGateway, type AdapterHost, type BindInput, type ChildTurnPolicy, type HarnessGateway, type ProviderMetrics, type RecoveredContext, type ResolvedTurnSelection, type ToolHost, type TurnAppContext, type TurnControl, type TurnInput, type TurnSink } from '../harness/gateway'
import { piDriver } from '../harness/drivers/pi'
import { contextGauge, policyOrigin, threadTurnOrigin } from '../harness/policy'
import type { BotThreads } from '../../shared/bots/personal/authority'
import { isBotWallAbort, type BotTurnDispatcher, type PreparedBotTurn } from '../bots/activation/dispatcher'
import { harnessAppError, isRetriesExhausted, onRetiredBareRoute, type BindPolicy, type ExecutionBinding, type HarnessCaps, type ProviderScope, type RunPolicy, type TurnOrigin } from '../../shared/harness/types'
import type { McpAttachmentProvider } from '../run/mcp/MousseMcpServer'
import { planWakeNotice, type NoticeContext } from '../run/delegation/notice'
import { acknowledgeRows } from '../run/terminal'
import { cancelQueuedWakes } from '../run/delegation/wake'
import { taskCheckpoint } from '../run/delegation/checkpoint'
import { subagentPreamble } from '../run/delegation/guidance'
import { isRunningSubagent, type SubagentNoticeItem } from '../../shared/subagents'
import type { DelegationRequest, ForkPointSeed, ThreadCreation } from '../run/RunEngine'
import type { HandoffItem } from '../run/handoff/budget'
import { committedTransfers, TurnHandoffs, type PlannedHandoff } from './turnHandoffs'
import { TranscriptAssembler } from '../run/transcript/TranscriptAssembler'
import { forkStrategy, handoffDelivery, mcpAttachable, subagentTargetRefusal, type SubagentRefusal } from '../run/policy/featureGates'
import { isContextOverflowError, retryContextOverflowOnce } from '../run/transcript/retryContextOverflow'
import {
  TERMINAL_RUN_STATUSES,
  isChildQuestionRow,
  isWakeTurnPayload,
  hasUnknownTurnPayloadKind,
  isBotTurnPayload,
  stoppedByPerson,
  type BotTurnPayload,
  type ChildQuestionPayload,
  type AgentActor,
  type DelegationRecord,
  type EffectKind,
  type InboxRecord,
  type EffectRecord,
  type ModeCeiling,
  type ProviderRef,
  type RunPause,
  type RunRecord,
  type RunResumePayload,
  type ThreadEvent,
  type TransferRecord,
  type WakeTurnPayload
} from '../run/types'
import {
  isTerminalAgentStatus,
  turnPhaseActivity,
  type Agent,
  type AgentOrigin,
  type AgentStatus,
  type ApprovalRuleInfo,
  type ThreadApprovalRequest,
  type ChatImageAttachment,
  type ChatMode,
  type ChatMessage,
  type CliType,
  type ContextUsageSnapshot,
  type NativeLlmContext,
  type OrchestratorAction,
  type OrchestratorContextUsageInput,
  type OrchestratorResponse,
  type OrchestratorSendInput,
  type PendingUserQuestions,
  type QueuedMessage,
  type Thread,
  type TurnPhase,
  type TurnState,
  type TurnStateSnapshot,
  type UserQuestion,
  type UserQuestionAnswers
} from '../../shared/types'
import { isDefaultThreadName } from '../../shared/threadTitle'
import {
  buildPermissionModeChangeNotice,
  getLastUserPermissionMode,
  describePermissionMode,
  isPermissionMode,
  isStricter,
  narrowPermissionMode,
  normalizePermissionMode,
  type PermissionMode
} from '../../shared/permissionMode'
import { describeApprovalRefusal, startedByPerson, type Answerer } from '../run/approvalRights'
import { describeApproval, formatApprovalDecisions } from '../run/approvalNote'
import { agentNoteOf, type ApprovalRecord, type ApprovalRule, type ContinuationDue } from '../run/ThreadApprovals'
import { allowsOrchestrationActions, buildModeChangeNotice, chatModeEquals, getChatModeLabel, getLastUserChatMode, normalizeChatMode } from '../../shared/chatMode'
import { AgentRegistry } from '../agents/AgentRegistry'
import { TaskQueue } from '../tasks/TaskQueue'
import { WorktreeManager } from '../worktree/WorktreeManager'
import { PtyManager } from '../terminals/PtyManager'
import { filterActionsForChatMode, parseActions, rejectOrchestrationAction, stripActionBlocks } from './actions'
import type { DelegateTaskInput, DelegationToolCall, DelegationToolHost, NamedAgentToolRequest, SubagentRef } from '../run/mcp/appTools/delegation'
import type { StreamingLlmTextEvent, StreamingLlmThinkingEvent, StreamingLlmToolEvent } from '../harness/turnEvents'
import type { BrowserRuntimePort } from '../../shared/browser/runtime'
import {
  type BrowserExecutionBinding,
  createDefinitionBrowserBinding,
  readHostBrowserRuntime,
  snapshotBrowserExecutionBinding
} from './browser'
import { computeContextUsage } from './contextUsage'
import { getToolCallDisplay } from '../../shared/toolCallDisplay'
import type { SettingsStore } from '../settings/SettingsStore'
import type { ProviderAuthService } from '../providers/ProviderAuthService'
import { ProviderInstanceService } from '../harness/instanceMap'
import type { McpManager } from '../integrations/mcp/McpManager'
import type { SkillsRegistry } from '../integrations/skills/SkillsRegistry'
import type { FileService } from '../files/FileService'
import type { GitService } from '../git/GitService'
import {
  PULL_REQUEST_DRAFT_SYSTEM,
  buildPullRequestDraftPrompt,
  conversationExcerpt,
  heuristicPullRequestDraft,
  parsePullRequestDraft,
  type PullRequestDraftInputs
} from '../git/pullRequestDraft'
import {
  COMMIT_SUGGESTION_SYSTEM,
  buildCommitSuggestionPrompt,
  commitSuggestionErrors,
  parseCommitSuggestion
} from '../git/commitSuggestion'
import { readPullRequestTemplate } from '../git/pullRequestTemplate'
import type { LineEditStatsStore } from '../stats/LineEditStatsStore'
import type { ProjectManager } from '../data/ProjectManager'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import { resolveThreadProjectPath } from '../data/resolveActiveProjectPath'
import { resolveProjectWorkingDirectory } from '../data/projectWorkingDirectory'
import { lineageForChild } from '../data/subagentLineage'
import { WorkspaceResolver, modeMutatesFiles, unprovisionedContext } from '../workspace/WorkspaceResolver'
import { ensureSnapshotWorkspace, setSnapshotsOff } from '../workspace/SnapshotWorkspace'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { findWorktreeOwner } from '../scheduled/validateJobOptions'
import { jobPermissionRequest } from '../scheduled/jobPermission'
import { occurrenceResultOfRun, scheduledReceiptId, type ScheduledRunProbe } from '../scheduled/ScheduledJobStore'
import { UndoService } from '../actions/UndoService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { PublishService } from '../actions/PublishService'
import { ConversationBranchService } from '../actions/ConversationBranchService'
import type { MousseFeatureFlags } from '../../shared/featureFlags'
import { DEFAULT_FEATURE_FLAGS } from '../../shared/featureFlags'
import { ThreadActionService } from '../actions/ThreadActionService'
import { ChildAgentIntegrationService, ChildIntegrationConflictError } from '../agents/ChildAgentIntegrationService'
import type { NativeContextBoundary } from '../../shared/threadActions'
import { SnapshotRefusedError, snapshotOrigin } from '../actions/snapshots'
import { git as actionGit, requireClean as requireCleanWorkspace } from '../actions/git'
import {
  claimNextNormal,
  clearPendingQueue,
  completeClaim,
  demoteSteerItems,
  dropSteerItems,
  assertQueueRevision,
  editQueuedMessage,
  editRefusal,
  enqueueMessage,
  listClaimedQueue,
  listPendingQueue,
  promoteQueuedMessageToSteer,
  QueueAccessError,
  QueueConflictError,
  queueRevision,
  QueueValidationError,
  reclaimAbandonedClaims,
  releaseClaim,
  removeQueuedMessage,
  reorderQueuedMessages,
  type QueuedMessagePatch
} from '../queue/ThreadMessageQueue'
import {
  createLeaseToken,
  heartbeatExecutionLease,
  isLeaseHeldByLivePeer,
  readLeaseOwner,
  releaseExecutionLeaseHandle,
  tryAcquireExecutionLease,
  tryReclaimStaleLease,
  waitAcquireExecutionLease,
  type ThreadLeaseHandle
} from '../queue/ThreadExecutionLease'
import { isProcessAlive } from '../queue/processLiveness'
import {
  completeClaimDurable,
  mutateDurableQueue,
  readDurableQueue,
  reclaimAbandonedClaimsDurable,
  releaseClaimDurable,
  repairQueueJournal,
  runDurableQueueCommand
} from '../queue/durableQueue'
import { ThreadSession, type ActiveTurnControl, type SteerEntry } from './ThreadSession'
import { userQuestionService as defaultUserQuestionService, UserQuestionService, withoutStandingRules } from './UserQuestionService'
import { modeRegistry as defaultModeRegistry, type ModeRegistry } from '../modes/ModeRegistry'
import { AppError, errorDiagnostic, knownAppError, normalizeAppError, serializeAppError, type AppErrorShape } from '../../shared/errors'
import {
  compactMessagesAtSafeBoundary,
  commitNativeMessages,
  compactNativeContext,
  createNativeContext,
  appendNativeMessage,
  DEFAULT_COMPACTION_RESERVE_TOKENS,
  estimateActiveContextTokens,
  getActiveMessages,
  getCompactionSummary,
  migrateLegacyContext,
  normalizeNativeContext,
  shouldCompactNativeContext,
  userMessage,
  type NativeMessageCheckpoint
} from './nativeContext'

/** A folder with no worktree whose turns are recorded in a hidden store (`snapshotFolderFor`). */
interface SnapshotFolder {
  /** The thread's data folder. */
  directory: string
  threadId: string
  /** The folder the agent works in. */
  workTree: string
  /** The project, when the folder is a project's; the project's threads share one store. */
  projectId?: string
}

interface NormalizedOrchestratorSendRequest {
  content: string
  mode: ChatMode
  images?: ChatImageAttachment[]
  workflowInvocationId?: string
}

interface NormalizedContextUsageRequest {
  draftInput: string
  mode: ChatMode
}

function normalizeSendRequest(request: OrchestratorSendInput): NormalizedOrchestratorSendRequest {
  if (typeof request === 'string') {
    return { content: request, mode: normalizeChatMode(), images: undefined }
  }

  return {
    content: request.content,
    workflowInvocationId: request.workflowInvocationId,
    mode: normalizeChatMode(request.mode),
    images: request.images?.filter((img) => img.data && img.mimeType)
  }
}

/** Render one answered value with option labels where they resolve, raw text otherwise. */
function formatQuestionAnswerValue(question: UserQuestion, value: string | string[]): string {
  const values = (Array.isArray(value) ? value : [value]).map((entry) => String(entry).trim())
  const labels = values
    .map((entry) => question.options.find((option) => option.id === entry)?.label ?? entry)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return labels.join(', ') || '(no answer)'
}

/**
 * Render submitted question answers as transcript text (`Q:`/`A:` per question).
 * Option ids resolve to their labels; custom-typed answers pass through verbatim.
 */
export function formatQuestionAnswersMessage(
  questions: UserQuestion[],
  answers: UserQuestionAnswers
): string {
  return questions
    .map((question) => {
      const value = answers[question.id]
      const rendered =
        value === undefined ? '(no answer)' : formatQuestionAnswerValue(question, value)
      return `Q: ${question.prompt}\nA: ${rendered}`
    })
    .join('\n\n')
}

/** Render an explicit dismissal as transcript text. */
export function formatQuestionDismissMessage(questions: UserQuestion[]): string {
  const first = questions[0]
  return first ? `Dismissed question: ${first.prompt}` : 'Dismissed the question.'
}

/**
 * Whether complete_task / stopAgent should attempt to finalize this agent.
 * failed is never auto-finalized. completed/cancelled/interrupted only when a
 * mergeable branch still exists (recoverable work).
 */
export function isActionFailureLog(line: string): boolean {
  return /\b(?:failed|skipped|error|conflict|refused|not found|not eligible)\b/i.test(line)
}

export function buildCompleteTaskFailureWake(agentIds: string[], logs: string[]): string | undefined {
  const failures = logs.filter(isActionFailureLog)
  if (failures.length === 0) return undefined

  const conflict = failures.some((line) => /\bconflict\b/i.test(line))
  const finalizeInstruction =
    'Rerunning complete_task after resolution is required to mark the task done, clean up its preserved worktree/branch, and close the agent GUI subtab.'
  const instruction = conflict
    ? `Inspect and resolve the listed conflicts in the main working tree, git add the resolutions, then retry complete_task with merge true. Do not abort the merge or delete the preserved agent worktree. ${finalizeInstruction}`
    : `Inspect the failure in the main working tree, preserve existing local changes, correct the blocker, then retry complete_task with merge true for the ready agent branch. ${finalizeInstruction}`

  return [
    '[Automatic complete_task update] The requested agent work was not merged.',
    `Target agents: ${agentIds.join(', ')}`,
    ...failures,
    instruction
  ].join('\n')
}

/**
 * After successful merges the parent turn ends. Wake it so multi-wave plans
 * (verification/integration agents, final reports) can continue without a manual nudge.
 */
export function buildCompleteTaskSuccessWake(agentIds: string[], logs: string[]): string | undefined {
  if (logs.some(isActionFailureLog)) return undefined
  const merged = logs.filter((line) => /\[merge\]\s+Merged\b/i.test(line))
  if (merged.length === 0) return undefined

  return [
    '[Automatic complete_task update] Integration finished.',
    `Target agents: ${agentIds.join(', ')}`,
    ...merged,
    'Continue the user plan now: spawn any remaining follow-up agents (for example a verification/integration wave), emit further complete_task actions as needed, or write a final status report if the requested work is fully done.'
  ].join('\n')
}

export function shouldFinalizeAgent(status: Agent['status'], hasMergeCandidate = false): boolean {
  if (status === 'failed') return false
  if (status === 'completed' || status === 'cancelled' || status === 'interrupted') {
    // Surviving branch means recoverable work must not be silently skipped.
    return hasMergeCandidate
  }
  return true
}

/** Statuses that only finalize when a merge candidate branch still exists. */
export function requiresMergeCandidateToFinalize(status: AgentStatus): boolean {
  return status === 'completed' || status === 'cancelled' || status === 'interrupted'
}

function normalizeContextUsageRequest(
  request: OrchestratorContextUsageInput
): NormalizedContextUsageRequest {
  if (typeof request === 'string') {
    return { draftInput: request, mode: normalizeChatMode() }
  }

  return {
    draftInput: request.draftInput ?? '',
    mode: normalizeChatMode(request.mode)
  }
}

// Owned by the provider adapters (SPEC §13.4); re-exported for existing callers.
export { isContextOverflowError, retryContextOverflowOnce }

export interface OrchestratorSendOptions {
  threadId?: string
  source?: string
  forceQueue?: boolean
  clientRequestId?: string
  /**
   * `turn` (default) resolves with the turn's result; `ack` resolves once the send is committed
   * and its `turn.start` effect recorded (SPEC §12.7). Only the engine path honours `ack`.
   */
  awaitMode?: 'turn' | 'ack'
  /** SPEC §16.4: the interrupted run this send continues (the restart note's "Continue"). */
  continuationOfRunId?: string
  /** Required when `continuationOfRunId` names an `uncertain` run. */
  acknowledgeUncertain?: boolean
  /** A follow-up on a subagent (`continue_subagent`): the run and its delegation row are written together. */
  delegation?: SendDelegation
  /**
   * Internal, daemon-only (never a field of the protocol `OrchestratorSendRequest`): a mode this
   * turn must not exceed. Applied as `narrowPermissionMode(ceiling, thread mode, option)`, so it
   * can only tighten (a scheduled job runs its turn in the mode the job chose).
   */
  permissionMode?: PermissionMode
  /**
   * Daemon-only: the other computer of the user this message was sent from (a routed call). It is
   * recorded on the thread and on the run, and changes nothing else: the message is the person's own.
   */
  sentFrom?: { node: string }
  /**
   * Who sends: the user through a client (the default), or an agent. A new message denies the
   * thread's pending approvals, so the sender must be allowed to answer them
   * (`canAnswerApproval`); one that is not leaves them pending and its message queues.
   */
  actor?: Answerer
  /**
   * Internal: this send is the continue turn that delivers these answered approval requests (SPEC
   * §17.4). They are handed to its run in the admitting transaction, and the send does not deny the
   * thread's other approvals.
   */
  bindDelivery?: { requestIds: string[] }
  /**
   * Daemon-only (the protocol request has no such fields): the model this turn runs on, whatever the
   * thread's own selection. A hidden or disabled model is refused before a run exists. The thread's
   * saved selection is never written.
   */
  modelOverride?: ModelOverride
  /** Who the turn runs for; recorded in the run's binding. Defaults to the thread's own origin. */
  origin?: TurnOrigin
  /** When false, a thread waiting on a question counts as busy and the send queues instead of answering it. Default true. */
  preemptQuestions?: boolean
  /**
   * Daemon-only: the send is refused (`questions_pending`) while the thread has a question or approval
   * waiting, decided at admission before any run exists. An agent's send uses it with
   * `preemptQuestions: false`; a question raised after admission is left alone and the message queues.
   */
  refuseWhileAsking?: boolean
  /**
   * Daemon-only: another thread's agent sends this (`thread_send`). The run's `agent.action` event is
   * written with it, the stored message and a queued item say it came from that agent, and its text is
   * never read for `/skill` mentions.
   */
  agent?: AgentActor
  /** Carried by the queue item when the send queues, so the item drains with the same model and origin. */
  queueOrigin?: QueuedMessage['origin']
  /** The scheduled occurrence this send is; the turn's end reports to the scheduler. */
  schedule?: ScheduledTurnRef
  /** Called right after the run is admitted (accepted and new), before it is queued or started. */
  onAdmitted?: (runId: string) => void
}

/** The scheduled occurrence a turn is; `jobName` lets the thread show who sent the prompt. */
export interface ScheduledTurnRef {
  jobId: string
  occurrenceKey: string
  jobName?: string
}

/** What the scheduler hears from the orchestrator about its occurrences. */
export interface ScheduledTurnHooks {
  /** The mode a run of the job asks for now (its mode and ceiling as stored), or nothing when the job has neither. */
  currentPermissionRequest?(jobId: string): PermissionMode | undefined
  onOccurrenceSettled(event: {
    jobId: string
    occurrenceKey: string
    runId: string
    status: 'ok' | 'error' | 'interrupted' | 'uncertain' | 'waiting'
    /** With `waiting`: when the usage limit the run hit resets. */
    retryAt?: string
    text?: string
    error?: string
    /** The model the run's binding used, so a run that waited in the queue records what ran. */
    selection?: ModelOverride
    /** The permission mode the run's binding enforced. */
    permissionMode?: PermissionMode
  }): void
}

/** What `OrchestratorService.stopThread` did: `ok` is true when anything was running or waiting. */
export interface StopThreadOutcome extends Partial<StopResult> {
  ok: boolean
  status: StopResult['status']
  replayed: boolean
  threadId: string
  threads: string[]
  activeRuns: StopResult['activeRuns']
  cancelledRuns: StopResult['cancelledRuns']
  delegations: string[]
}

/**
 * How long a wake waits when its thread is busy with a turn the engine does not schedule (a
 * workflow or legacy turn) before it looks again (C4: the wake stays queued instead of looping).
 */
export const WAKE_BUSY_DEFER_MS = 5_000

/** The run record's error for a scheduled occurrence whose run the daemon admitted but never started. */
const SCHEDULED_NEVER_STARTED = 'Interrupted: never started'

/** Open per-run threads one scheduled job may have; settle or delete some, or bind the job to a thread. */
const MAX_OPEN_SCHEDULED_THREADS = 10

/** Send refusals reported with their reason as the error code (SPEC §16.4). */
/** Thrown inside the thread write to leave the file untouched when the stale rows no longer need closing. */
class StaleActivitySkipped extends Error {}

const CONTINUATION_REFUSALS: ReadonlySet<string> = new Set([
  'continuation_not_found',
  'continuation_source_active',
  'uncertain_not_acknowledged'
])

/** Agent messages in a row, without a person in between, that a message may be the end of; the next one is refused. */
export const AGENT_MESSAGE_MAX_HOPS = 3
/** Messages from other threads' agents a thread may have waiting in its queue; the next one is refused. */
export const AGENT_QUEUE_MAX_PER_THREAD = 3

/** The origin an agent's message is stored with: who sent it, and how many agent hops led to it. */
function agentOriginOf(agent: Pick<AgentOrigin, 'threadId' | 'runId' | 'hops'>): AgentOrigin {
  return { kind: 'agent', threadId: agent.threadId, runId: agent.runId, ...(agent.hops !== undefined ? { hops: agent.hops } : {}) }
}

/** The longest removed message an `agent.action` event keeps whole. */
const REMOVED_TEXT_MAX_CHARS = 8_000

/**
 * Whether the new order puts any message ahead of one `own` does not count as the agent's that it was behind before: the
 * agent postpones that message by it.
 */
function putsAheadOfOthers(items: QueuedMessage[], orderedIds: readonly string[], authored: (item: QueuedMessage) => boolean): boolean {
  const pending = listPendingQueue(items).filter((item) => !item.internal)
  const before = pending.map((item) => item.id)
  for (const other of pending) {
    if (authored(other)) continue
    const wasAhead = new Set(before.slice(0, before.indexOf(other.id)))
    const nowAhead = orderedIds.slice(0, orderedIds.indexOf(other.id))
    if (nowAhead.some((id) => !wasAhead.has(id))) return true
  }
  return false
}

/** A standing rule as the windows show it, `active` when the thread's mode (`mode`) is not stricter than the one it was granted under. */
function approvalRuleInfo(rule: ApprovalRule, mode: PermissionMode): ApprovalRuleInfo {
  return {
    id: rule.fingerprint,
    permissionKey: rule.permissionKey,
    action: rule.action,
    summary: rule.summary,
    grantedUnder: rule.grantedUnder,
    active: !isStricter(mode, rule.grantedUnder),
    createdAt: rule.createdAt
  }
}

/** A saved approval request as the transcript shows it: the prompt, when it was asked and the answer it got. */
function threadApprovalRequest(record: ApprovalRecord): ThreadApprovalRequest {
  const by = record.answeredBy
  return {
    requestId: record.requestId,
    ...(record.runId ? { runId: record.runId } : {}),
    action: record.action,
    prompt: record.questions[0]?.prompt ?? '',
    status: record.status,
    ...(record.decision ? { decision: record.decision } : {}),
    ...(record.decisionScope ? { scope: record.decisionScope } : {}),
    // Who answered, without an agent's run or a computer's id: the transcript only says whether it was the user.
    ...(by ? { answeredBy: by.kind === 'user' ? { kind: 'user' as const, ...(by.via ? { via: by.via } : {}) } : { kind: 'agent' as const } } : {}),
    ...(record.cancelReason ? { cancelReason: record.cancelReason } : {}),
    createdAt: record.createdAt,
    ...(record.settledAt ? { settledAt: record.settledAt } : {})
  }
}

/** The stricter of two modes either of which may be absent; undefined when both are (no limit at all). */
function strictestMode(a: PermissionMode | undefined, b: PermissionMode | undefined): PermissionMode | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return isStricter(a, b) ? a : b
}

/** A turn handed to `startTurn`; `runId` is absent when the engine could not record a run. */
interface TurnStartRequest {
  runId?: string
  threadId: string
  input: OrchestratorSendInput
  reuseLastUser: boolean
  displayUserMessage: boolean
  source?: string
  queueItemId?: string
  claimOwnerToken?: string
  suppressAutoQueueDrain?: boolean
  /** The caller already set `session.turnAdmitted`; the turn inherits it. */
  admissionHeld?: boolean
  /** A delegated `shared` child runs in its parent's workspace (SPEC §14.2). */
  sharedWorkspace?: ThreadSession['sharedWorkspace']
  /** Inbox rows whose notice this turn delivers (a queued steer); they follow this run's outcome. */
  inboxIds?: string[]
  /** The subagent results the turn's message delivers. */
  subagentNotice?: SubagentNoticeItem[]
  /** A mode the turn must not exceed (`OrchestratorSendOptions.permissionMode`). */
  permissionMode?: PermissionMode
  /** A scheduled turn's model and origin; JSON-safe, so a `turn.start` effect keeps them across a restart. */
  modelOverride?: ModelOverride
  origin?: TurnOrigin
  schedule?: ScheduledTurnRef
  /** The agent that sent the message (`OrchestratorSendOptions.agent`); JSON-safe, so it survives queueing and a restart. */
  agent?: AgentOrigin
}

/** Payload of a `turn.start` effect (SPEC §12.2). */
export interface TurnStartPayload extends TurnStartRequest {
  runId: string
}

/** `turn.start` payload of an `integration` run (SPEC §14.4): merges one delegated result. */
interface IntegrationTurnPayload {
  kind: 'integration'
  threadId: string
  runId: string
  delegationId: string
}

function isIntegrationTurnPayload(payload: unknown): payload is IntegrationTurnPayload {
  return Boolean(payload) && typeof payload === 'object' && (payload as { kind?: unknown }).kind === 'integration'
}

/**
 * `turn.start` payload of a `provider-continuation` run: the turn a provider's runtime started on
 * its own after a background task finished. `note` is the line the transcript shows for it.
 */
interface ContinuationTurnPayload {
  kind: 'continuation'
  threadId: string
  runId: string
  /** Names the turn Claude started (`ClaudeLiveHost.continuationStarted`) that this run is for. */
  continuationId: string
  note: string
}

/** How long a Mousse tool call waits for the run of a turn the provider started, before it fails as usual. */
const CONTINUATION_CALL_WAIT_MS = 10_000

function isContinuationTurnPayload(payload: unknown): payload is ContinuationTurnPayload {
  return Boolean(payload) && typeof payload === 'object' && (payload as { kind?: unknown }).kind === 'continuation'
}

/** The `turn.start` payload kinds this build runs; any other string `kind` is refused (PR 6 §4). */
const KNOWN_TURN_PAYLOAD_KINDS: readonly string[] = ['wake', 'integration', 'continuation', 'bot']

/**
 * A bot turn's preamble: the bot's role and instructions first, then Mousse's own. Bots that never
 * ask anyone run their app tools with `approvals: 'never'`, so a tool that would ask is refused.
 */
function withBotInstructions(instructions: string | undefined, preamble: string): string {
  if (!instructions?.trim()) return preamble
  return [`Your role and instructions:\n${instructions.trim()}`, preamble].filter(Boolean).join('\n\n')
}

/** A bot turn's skills: only the granted ones are listed, and only those may be loaded. */
function grantedSkills(skills: Pick<AppToolTurn, 'enabledSkills' | 'loadedSkills'>, granted: ReadonlySet<string>): Pick<AppToolTurn, 'enabledSkills' | 'loadedSkills'> {
  const enabledSkills = skills.enabledSkills.filter((skill) => granted.has(skill.id))
  // Loaded skills carry only a name: one that an ungranted skill shares is dropped, never guessed.
  const ungranted = new Set(skills.enabledSkills.filter((skill) => !granted.has(skill.id)).map((skill) => skill.name))
  const names = new Set(enabledSkills.map((skill) => skill.name).filter((name) => !ungranted.has(name)))
  return { enabledSkills, loadedSkills: skills.loadedSkills.filter((loaded) => names.has(loaded.name)) }
}

/** Who delivers inbox rows while a queue item carries them (no effect: the reconciler leaves them alone). */
const queueOwner = (itemId: string): string => `queue:${itemId}`

/** A queue item's rows that could not be given back when it was removed: tries and the wait between them. */
const QUEUED_ROW_RELEASE_ATTEMPTS = 4
const QUEUED_ROW_RELEASE_RETRY_MS = 2_000
/** An agent queue command whose effects did not commit is retried this many times in the background. */
const QUEUE_REPAIR_ATTEMPTS = 6

/** Tool access of a delegated child in its parent's workspace: read-only roles only. */
const SHARED_READER_POLICY: AgentWorkspacePolicy = { version: 1, workspace: 'shared', access: 'read-only' }
/** Roles allowed `workspace: 'shared'` (SPEC §14.2: read-only roles). */
const SHARED_WORKSPACE_ROLES: ReadonlySet<string> = new Set(['research', 'review'])
/** Most named assignments one `create_subagents` call may start. */
const NAMED_BATCH_LIMIT = 8

/** In-process result of a `turn.start` effect, settled by its executor. */
interface TurnResult {
  promise: Promise<OrchestratorResponse>
  resolve: (response: OrchestratorResponse) => void
  reject: (error: unknown) => void
  /** Full payload, including image data the durable payload omits. */
  payload: TurnStartPayload
  effectId: string | null
  /** The executor picked the effect up; shutdown no longer abandons it. */
  started: boolean
  abandoned: boolean
}

/** Phases of a live turn that refresh its run heartbeat. */
const HEARTBEAT_TURN_PHASES: ReadonlySet<TurnPhase> = new Set<TurnPhase>([
  'queued', 'thinking', 'streaming', 'tool_running', 'awaiting_input', 'finalizing'
])
const RUN_HEARTBEAT_THROTTLE_MS = 5_000
/** How often a live definition turn beats for its run (well inside the reconciler's quiet window). */
const DEFINITION_HEARTBEAT_MS = 5_000

/** A definition run's Stop: its abort, and the run records its turns made (for a Stop by run id). */
interface DefinitionStop {
  abort: AbortController
  runIds: Set<string>
  /** The run holds the session's admission for its whole execution. */
  admitted: boolean
}

/** What a definition turn takes from its run besides the request. */
interface DefinitionTurnExtras {
  host?: DefinitionHostBindings
  browser?: BrowserExecutionBinding
  stop?: DefinitionStop
}

/**
 * The durable copy of a send input. Image data stays in memory: `turn.start` is process-bound,
 * so the executor always has the in-memory input, and every `effect.status` event repeats the
 * payload.
 */
function durableSendInput(input: OrchestratorSendInput): OrchestratorSendInput {
  if (typeof input === 'string' || !input.images?.length) return input
  const { images, ...rest } = input
  return { ...rest, images: images.map((image) => ({ ...image, data: '' })) }
}

/** Ledger digest of tool arguments: sha256 of their stable JSON. */
function toolArgsDigest(args: unknown): string {
  return sha256Hex(stableStringify(args ?? {}))
}

export class OrchestratorService extends EventEmitter {
  private appletStore?: AppletStore
  setAppletStore(store: AppletStore): void { this.appletStore = store }
  private readonly lifecycle = new OwnedWorkBarrier()

  getOwnedActivity(): Record<string, number> {
    return this.lifecycle.snapshot()
  }

  /**
   * The first step of a profile stop, before the effect worker stops (which aborts the live turns): from
   * here a provider's stop handling cannot withdraw a saved approval request, so each stays pending for the
   * next boot to offer as a continue request. Callbacks waiting for an answer are released. Idempotent.
   */
  holdApprovals(): void {
    this.questions.shutdown()
  }

  beginShutdown(): void {
    this.lifecycle.beginShutdown()
    for (const retry of this.releaseRetries) clearTimeout(retry)
    this.releaseRetries.clear()
    for (const [runId, entry] of [...this.turnResults]) {
      if (!entry.started) this.abandonTurnStart(runId, entry)
    }
    this.startupDrainPending = []
    this.startupDrainScheduled.clear()
    // Before any turn is stopped: a provider's stop handler dismisses its pending requests, and a dismissal
    // while the profile stops is no withdrawal. The saved requests stay pending for the next boot.
    this.questions.shutdown()
    // The shutdown reason marks these turns as cut off by a restart, not stopped by a user.
    for (const session of new Set([this.boundSession, ...this.sessions.values()])) session.activeTurn?.abort.abort(this.lifecycle.signal.reason)
    for (const turn of this.channelTurns.values()) turn.abort.abort()
  }

  /** A turn abort caused by the profile shutting down (worker stop or lifecycle), not by a user. */
  private isShutdownAbort(reason: unknown): boolean {
    return reason instanceof WorkerStoppedError || (this.lifecycle.stopping && reason === this.lifecycle.signal.reason)
  }

  async shutdown(timeoutMs = 30_000): Promise<void> {
    this.beginShutdown()
    await this.lifecycle.waitForIdle(timeoutMs)
    for (const timer of this.persistTimers.values()) clearTimeout(timer)
    this.persistTimers.clear()
    for (const session of new Set([this.boundSession, ...this.sessions.values()])) {
      if (session.threadId !== '__unbound__') this.persistFn?.(session.threadId)
    }
  }

  private workflowChat?: WorkflowChatExecutor

  setWorkflowChatExecutor(executor: WorkflowChatExecutor): void { this.workflowChat = executor }

  private scheduledHooks?: ScheduledTurnHooks

  /** The scheduler hears when a scheduled turn's run ends, wherever (and by whomever) the turn was drained. */
  setScheduledHooks(hooks: ScheduledTurnHooks | undefined): void { this.scheduledHooks = hooks }

  private scheduledJobs?: Omit<AgentScheduleHost, 'limits' | 'startedByPerson'>

  /** The profile's scheduled jobs, for the agents' `schedule_*` tools; without them the tools are not registered. */
  setScheduledJobs(jobs: Omit<AgentScheduleHost, 'limits' | 'startedByPerson'> | undefined): void { this.scheduledJobs = jobs }

  private browserRuntime?: BrowserRuntimePort
  private mainAgentBrowser?: BrowserExecutionBinding
  private mainBrowserFactory?: (turn: { threadId: string; turnId: string; source?: string; mode: ChatMode }) => BrowserExecutionBinding | undefined

  setMainAgentBrowserFactory(factory: (turn: { threadId: string; turnId: string; source?: string; mode: ChatMode }) => BrowserExecutionBinding | undefined): void {
    this.mainBrowserFactory = factory
  }

  /** Host-injected dispatcher. Root adapts platform.browser to BrowserRuntimePort. */
  setBrowserRuntime(port: BrowserRuntimePort | undefined): void {
    this.browserRuntime = port
  }

  /**
   * Trusted GUI/main-agent browser context. Root supplies source/profile/thread/turn
   * and resolved grants; this runtime never infers a tab owner from model text.
   * Not applied to scheduled/channel turns.
   */
  setMainAgentBrowserExecution(binding: BrowserExecutionBinding | undefined): void {
    this.mainAgentBrowser = binding
  }

  /**
   * Definition runs go through the harness gateway (PR 4 §6), owned by the profile's shutdown
   * barrier. Every stored `runtimeKind` runs the same way: the instance is the model ref's, and an
   * instance that cannot hold the definition's limits refuses the run with a typed reason.
   */
  runAgentDefinition(request: AgentExecutionRequest): Promise<AgentExecutionResult> {
    return this.lifecycle.run('definition-agent', () => {
      if (!this.threadStore?.getThread(request.threadId)) throw new Error('Agent execution thread is unavailable')
      const session = this.getOrCreateSession(request.threadId)
      if (session.deleted) throw new Error('Agent execution thread was deleted')
      const runId = request.runId ?? uuidv4()
      const browser = createDefinitionBrowserBinding({ request: { ...request, runId }, runId, resolved: request.resolved })
      const host = request.host as DefinitionHostBindings | undefined
      // The session stays admitted for the whole run, across retries and fallback backoffs, so a
      // message sent meanwhile queues instead of taking the thread between records.
      const fenced = !session.isTurnRunning()
      if (fenced) session.turnAdmitted = true
      // The thread's public Stop (`stopThread`, `abortRun`, a `turn.interrupt`) ends the whole run,
      // between records too: it aborts this, which every turn and backoff of the run listens to.
      const stop: DefinitionStop = { abort: new AbortController(), runIds: new Set(), admitted: fenced }
      const stops = this.definitionStops.get(request.threadId) ?? new Set<DefinitionStop>()
      stops.add(stop)
      this.definitionStops.set(request.threadId, stops)
      const runtime = createDefinitionRuntime({
        checkDefinitionTurn: (check) => this.checkDefinitionTurn(check),
        executeDefinitionTurn: (turn) => this.executeDefinitionTurn(turn, { ...(host ? { host } : {}), ...(browser ? { browser } : {}), stop })
      })
      const signals = [this.lifecycle.signal, stop.abort.signal, ...(request.signal ? [request.signal] : [])]
      return new AgentExecutionService({ runtime }).run({ ...request, runId, signal: AbortSignal.any(signals) }).finally(() => {
        stops.delete(stop)
        if (!stops.size && this.definitionStops.get(request.threadId) === stops) this.definitionStops.delete(request.threadId)
        if (fenced) {
          session.turnAdmitted = false
          session.abortRequested = false
        }
        // What queued behind the run runs once, now that the whole run settled; an agent chat that
        // lent its lease does this after it releases the lease.
        if (host?.lease?.kind !== 'borrowed') this.resumeThreadQueue(request.threadId)
      })
    })
  }

  /**
   * Aborts the definition runs of a thread (only the one whose record is `runId`, when given), as a
   * public Stop does. True when one was running.
   */
  private stopDefinitionRuns(threadId: string, runId?: string): boolean {
    let stopped = false
    for (const stop of this.definitionStops.get(threadId) ?? []) {
      if (stop.abort.signal.aborted || (runId && !stop.runIds.has(runId))) continue
      stop.abort.abort(new DOMException('The agent run was stopped.', 'AbortError'))
      stopped = true
    }
    return stopped
  }

  /**
   * The thread's queue runs again after a definition run released the thread: a message that queued
   * behind it (a composer send, a remote or MCP enqueue) is drained once, now that nothing holds the
   * thread. An agent chat calls this after it releases the lease its replies borrowed.
   */
  resumeThreadQueue(threadId: string): void {
    const session = this.boundSession.threadId === threadId ? this.boundSession : this.sessions.get(threadId)
    if (!session || session.deleted || session.turnAdmitted || session.isTurnRunning()) return
    this.effectWorker?.notify()
    session.drainAfterSettle = false
    try {
      this.scheduleQueueDrain(session)
    } catch (error) {
      logDebug('OrchestratorService', 'queue drain after a definition run failed to schedule', error, { threadId })
    }
  }

  /**
   * Where a definition runs on its instance: the instance's definition runtime, or its definition
   * loop where the instance runs definitions there (a connection on the legacy engine, a platform
   * without an evidence record; 4h deletes the loop). A token or USD limit the runtime cannot
   * reserve is refused by the check, never moved to the loop.
   */
  private placeDefinition(check: DefinitionCheck): ResolvedTurnSelection {
    return this.harness.resolveStored(this.definitionSelection(check.ref), { purpose: check.origin, scope: this.threadScope(check.threadId), definition: true })
  }

  /** The stored selection a definition's model ref names: its instance, else its provider's built-in one. */
  private definitionSelection(ref: DefinitionCheck['ref']): Pick<ModelOverride, 'instanceId' | 'llmProvider' | 'model'> {
    const model = ref.effort && !parseThinkingSuffixFromModelId(ref.modelId).effort ? `${ref.modelId}:${ref.effort}` : ref.modelId
    return { ...(ref.instanceId ? { instanceId: ref.instanceId } : {}), llmProvider: ref.providerId, model }
  }

  /**
   * Whether a definition candidate can run, without running it (PR 4 §6): its instance resolves for
   * the definition's purpose, and the gateway can enforce the definition's policy on it.
   */
  checkDefinitionTurn(check: DefinitionCheck): DefinitionRefusal | undefined {
    try {
      const resolved = this.placeDefinition(check)
      const verdict = this.harness.check(resolved, definitionRunPolicy(check))
      // Its output, browser, memory and delegation settings, where the runtime does not run its loop.
      if (verdict.ok) return definitionFeatureRefusal(resolved.caps, check.features)
      const { code, missing, reason } = verdict.error
      // A token or USD limit the runtime cannot reserve: why, and what to change (`spendModelGap`).
      const spendOnly = reason && missing?.length === 1 && missing[0] === 'spendLimits'
      const message = spendOnly ? `This agent's token or cost limits can't be held on this model. ${reason}` : verdict.error.message
      return { code, message, ...(missing ? { missing } : {}), ...(reason ? { reason } : {}) }
    } catch (error) {
      const normalized = normalizeAppError(error, 'definition_model_unavailable')
      const details = normalized.details as { missing?: DefinitionRefusal['missing']; reason?: string } | undefined
      return { code: normalized.code, message: normalized.message, ...(details?.missing ? { missing: details.missing } : {}), ...(details?.reason ? { reason: details.reason } : {}) }
    }
  }

  /**
   * One model turn of a definition run (PR 4 §6), next to `executeTurn`: the same binding, app-tool
   * registration, turn bridge and run marks, without what the host owns (the queue, the thread's
   * messages, workspace resolution, checkpoints, titles and `nativeContext`).
   *
   * - Lease: `borrowed` (agent chats) is checked live and never taken, stored or released; `own`
   *   (Try Run, workflow nodes, bridge dispatch) is taken here or the turn fails `operation_busy`,
   *   never queued, and released once. Either way a composer send to the thread queues meanwhile.
   * - Writer: the host's (`DefinitionHostBindings.writer`), else the lease's own.
   * - Run record: `definition:<runId>:<attempt>`, with no `turn.start` effect, so the run engine
   *   never retries or recovers it; retries and fallbacks are `definitionRuntime`'s, each a new record.
   * - Session: one of its own (`ephemeral`), the definition's system prompt replacing the runtime's
   *   instructions, and the bounded conversation as messages and as a preamble.
   * - Result: the text, and a history built from the turn's own events.
   */
  async executeDefinitionTurn(turn: DefinitionTurnRequest, extras: DefinitionTurnExtras = {}): Promise<DefinitionTurnResult> {
    const engine = this.runEngine
    // The definition's authority over app and MCP tools lives on the run's app-tool turn, which needs a run.
    if (!engine) throw harnessAppError({ code: 'unsupported', message: 'Agent definitions need the run engine to hold their tools to their grants.' })
    if (!this.threadStore?.getThread(turn.threadId)) throw new Error('Agent execution thread is unavailable')
    const session = this.getOrCreateSession(turn.threadId)
    if (session.deleted) throw new Error('Agent execution thread was deleted')
    const threadDir = this.resolveThreadDir(turn.threadId)
    if (!threadDir) throw new Error('Agent execution thread directory is unavailable')
    const mode = extras.host?.lease ?? { kind: 'own' as const }
    let owned: ThreadLeaseHandle | null = null
    let lease: ThreadLeaseHandle
    if (mode.kind === 'borrowed') {
      // The host holds the thread's lease for the run: it must be live and this thread's.
      const live = resolve(mode.handle.threadDir) === resolve(threadDir) && readLeaseOwner(mode.handle.lockPath)?.token === mode.handle.owner.token
      if (!live) throw harnessAppError({ code: 'operation_busy', message: "The agent's thread is not held for this run." })
      lease = mode.handle
    } else {
      owned = tryAcquireExecutionLease(threadDir, { source: 'definition' })
      if (!owned) throw harnessAppError({ code: 'operation_busy', message: "The agent's thread is running other work." })
      lease = owned
    }
    try {
      // The run's own admission (held across its records) is not another turn's.
      const fenced = extras.stop?.admitted === true
      if (session.activeTurn !== null || (session.turnAdmitted && !fenced)) throw harnessAppError({ code: 'operation_busy', message: "The agent's thread is running other work." })
      if (!fenced) session.turnAdmitted = true
      try {
        return await this.runDefinitionTurn(turn, engine, lease, extras)
      } finally {
        if (!fenced) {
          session.turnAdmitted = false
          session.abortRequested = false
        }
      }
    } finally {
      if (owned) releaseExecutionLeaseHandle(owned)
    }
  }

  private async runDefinitionTurn(turn: DefinitionTurnRequest, engine: RunEngine, lease: ThreadLeaseHandle, extras: DefinitionTurnExtras): Promise<DefinitionTurnResult> {
    const { threadId } = turn
    const resolved = this.placeDefinition(turn)
    // The user's MCP tools the definition was granted, by the name the runtime calls them.
    const mcpTools = this.mcpManager && turn.grants.mcpTools.length
      ? (await this.mcpManager.getEnabledTools(turn.projectPath, definitionActor(turn.grants)))
          .filter((tool) => definitionToolGranted(tool.providerName, turn.grants, [tool]))
      : []
    const policy = definitionRunPolicy(turn, mcpTools.map((tool) => tool.providerName))
    const verdict = this.harness.check(resolved, policy)
    if (!verdict.ok) throw harnessAppError(verdict.error)
    const featureRefusal = definitionFeatureRefusal(resolved.caps, turn.features, resolved.instanceId)
    if (featureRefusal) throw harnessAppError({ code: 'policy_unenforceable', message: featureRefusal.message, missing: featureRefusal.missing ?? ['toolControl'], instanceId: resolved.instanceId })
    // The definition's browser is Mousse app tools, on the host's browser runtime (an agent chat's
    // shared browser), else the profile's, which also lists them. Without one the turn fails before
    // it starts.
    const hostBrowser = readHostBrowserRuntime(extras.host)
    if (extras.browser && !this.browserRuntime)
      throw knownAppError({ code: 'browser_runtime_unbound', message: 'Browser runtime is not bound. Call setBrowserRuntime with a BrowserRuntimePort before enabling browser tools.' })
    if (turn.signal.aborted) throw turn.signal.reason ?? new DOMException('Aborted', 'AbortError')
    const dispatched = await engine.dispatch({ kind: 'send', threadId, clientRequestId: `definition:${turn.runId}:${turn.attempt}`, source: 'definition' })
    if (dispatched.status !== 'accepted') throw harnessAppError({ code: 'operation_busy', message: "The agent's turn could not be recorded." })
    const runId = dispatched.runId
    extras.stop?.runIds.add(runId)
    let terminal = false
    const markTerminal = (status: 'completed' | 'interrupted' | 'failed', outcome?: { error?: string; interruptedBy?: 'user' }, resultText?: string): void => {
      if (terminal) return
      terminal = true
      this.markRun(runId, (runs, id) => runs.markTerminal(id, status, outcome, { resultText }))
      this.harness.runSettled?.(runId)
    }
    try {
      this.markRunStarting(runId)
    } catch (error) {
      // Another run holds the thread (or this one was cancelled meanwhile): the record never stays queued.
      this.markRun(runId, (runs, id) => { if (runs.getRun(id)?.status === 'queued') runs.markTerminal(id, 'cancelled', { error: error instanceof Error ? error.message : String(error) }) })
      this.harness.runSettled?.(runId)
      throw harnessAppError({ code: 'operation_busy', message: "The agent's thread is running other work." })
    }
    const authority: DefinitionAuthority = {
      policy: turn.policy,
      grants: turn.grants,
      ...(turn.approve ? { approve: turn.approve } : {}),
      mcpTools
    }
    const projectPath = turn.projectPath
    // A definition acts at `lineage`, as on the loop, whatever the profile's agent access level
    // (SPEC §15.1); the grant is kept on the run.
    const modeCeiling = this.modeCeilingFor(threadId, 'agent')
    const accessLevel: AgentAccessLevel = 'lineage'
    try {
      engine.recordAccessGrant(runId, accessLevel)
    } catch (error) {
      console.warn('The access grant of the run could not be recorded', { runId, error: error instanceof Error ? error.message : String(error) })
    }
    const app = this.appToolTurns.register({
      threadId,
      runId,
      mode: 'agent',
      modeFacts: modeFactsFor(this.modeRegistry, 'agent', projectPath),
      modeCeiling,
      accessLevel,
      subagent: false,
      discovery: false,
      ...(projectPath ? { projectPath } : {}),
      actor: definitionActor(turn.grants),
      ...(extras.browser && hostBrowser ? { browserRuntime: hostBrowser } : {}),
      enabledSkills: [],
      loadedSkills: [],
      // As on the loop: the definition's grants decide its tools, not the profile's tool settings.
      settingsEnabled: () => true,
      definition: authority
    }, { continuation: false })
    const record = new DefinitionTurnRecord()
    // The turn's own end: the run's record left this process's hands (reconciled, or ended elsewhere).
    const lost = new AbortController()
    const signal = AbortSignal.any([turn.signal, lost.signal])
    // Liveness for the run engine's reconciler while the turn is quiet (a slow model, a tool, an
    // approval): the record has no effect of its own, so nothing else beats for it.
    const beat = setInterval(() => {
      const current = engine.getRun(runId)
      if (!current || TERMINAL_RUN_STATUSES.has(current.status)) {
        lost.abort(new DOMException('The agent run ended elsewhere.', 'AbortError'))
        return
      }
      try {
        engine.heartbeat(runId)
      } catch (error) {
        console.warn('definition run heartbeat failed', { runId, error: error instanceof Error ? error.message : String(error) })
      }
    }, this.definitionHeartbeatMs)
    beat.unref?.()
    let handle: ReturnType<HarnessGateway['startTurn']> | undefined
    const interrupt = (): void => { void handle?.interrupt().catch(() => {}) }
    signal.addEventListener('abort', interrupt, { once: true })
    try {
      this.markRun(runId, (runs, id) => runs.markRunning(id))
      const { tools, approvals, budget, authority } = policy
      const binding = await this.bindTurn(runId, undefined, resolved, 'agent', () => turn.origin, { cwd: projectPath ?? null, permissionMode: 'ask' }, { approvals, ...(tools ? { tools } : {}), ...(budget ? { budget } : {}), ...(authority ? { authority } : {}) }, true)
      const context = await this.completeAppTurn(app.turn, {
        ...(extras.browser ? { browser: extras.browser } : {}),
        userContent: turn.userMessage,
        instanceId: resolved.instanceId,
        model: binding.model,
        approvals: 'grants',
        grants: turn.grants
      })
      // The host's writer (a workflow node's mutation lease), else the lease's own.
      const writer = extras.host?.writer ?? (() => {
        const writers = new TaskWriterAuthority(lease)
        const token = writers.issue(`definition:${runId}`, { version: 1, workspace: 'shared', access: 'write' })
        return <T>(run: () => Promise<T>): Promise<T> => writers.runWriter(token, run)
      })()
      // The definition's prompt as written, then its granted skills (`Granted skill <name>`); nothing
      // else of Mousse's is added.
      const loadedSkills = this.appToolTurns.get(runId)?.loadedSkills ?? []
      const systemPrompt = [turn.systemPrompt, ...loadedSkills.map((skill) => `Granted skill ${skill.name}:\n${skill.content}`)].filter(Boolean).join('\n\n')
      // Prior turns only, as a runtime that takes history in its prompt reads them.
      const preamble = turn.conversation.length ? nativeAgentHistory(createNativeContext(definitionMessages(turn.conversation, '').slice(0, -1))) : ''
      const input: TurnInput = {
        runId,
        attemptId: engine.getRun(runId)?.activeAttemptId ?? runId,
        threadId,
        cwd: projectPath ?? null,
        model: binding.model,
        instanceId: resolved.instanceId,
        llmProvider: resolved.llmProvider,
        modelPinned: true,
        mode: 'agent',
        // The definition's own approval rules decide its calls; the runtime is never told to allow more.
        permissionMode: binding.policy.permissionMode ?? 'ask',
        prompt: turn.userMessage,
        messages: definitionMessages(turn.conversation, turn.userMessage),
        nativeHistory: preamble,
        signal
      }
      const sink: TurnSink = {
        text: (event) => record.text(event),
        thinking: () => {},
        tool: (event) => {
          // From the first tool on, the turn has effects: no retry and no fallback.
          if (event.phase === 'start' && event.kind !== 'skill_loaded') turn.onDispatched()
          record.tool(event)
        },
        nativeMessages: () => {},
        compaction: () => {},
        retry: () => {},
        progress: () => {},
        // A runtime that reports usage per request (Pi's agent): it is the record's usage, kept as it
        // arrives, so a turn that fails (a limit reached, a provider error) is still counted.
        usage: (reported) => {
          // In the usage statistics too.
          this.lineEditStats?.recordUsage({
            timestamp: new Date().toISOString(), provider: resolved.llmProvider, model: binding.model,
            input: reported.input, output: reported.output, cacheRead: reported.cacheRead, cacheWrite: reported.cacheWrite
          })
          const used = turn.effects.attemptUsage
          turn.effects.attemptUsage = {
            ...used,
            inputTokens: used.inputTokens + reported.input,
            outputTokens: used.outputTokens + reported.output,
            costUsd: used.costUsd + (reported.costUsd ?? 0)
          }
        },
        providerRef: (ref) => this.markRun(runId, (runs, id) => { runs.recordProviderRef(id, ref) }),
        steerAccepted: () => {},
        providerMetrics: (metrics) => record.metrics(metrics),
        lineEdits: (lines) => this.lineEditStats?.record('orchestrator', lines)
      }
      const control: TurnControl = { drainSteer: () => undefined, heartbeat: () => this.heartbeatRun(runId) }
      const host: AdapterHost = {
        tools: {
          ...(extras.browser ? { browser: extras.browser } : {}),
          toolAccess: { allows: () => true, execute: (_name, _args, run) => writer(run) },
          toolLedger: this.toolLedgerFor(runId),
          runActive: () => this.runEngine?.getActiveRun(threadId)?.runId === runId
        },
        context: {
          recoverOverflow: () => null,
          prepareNativeContext: () => null,
          nativeHistoryAfterTurn: () => preamble,
          nativeHistoryNow: () => preamble
        }
      }
      if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      // The granted app tools (the browser, `ask_user`, …) reach the runtime only over the Mousse MCP
      // server: without its bearer the turn is refused, never run without them.
      const allowed = new Set(tools?.allow ?? [])
      const requiredTools = this.mcpToolRegistry().listForTurn(threadId, runId)
        .filter((tool) => allowed.has(tool.name) && tool.class !== 'delegation').map((tool) => tool.name)
      handle = this.harness.startTurn({
        binding,
        attemptOrdinal: 1,
        input,
        sink,
        control,
        host,
        app: requiredTools.length ? { ...context, requiredTools } : context,
        instructions: { text: systemPrompt, placement: 'replace' },
        session: 'ephemeral',
        counters: turn.counters,
        spend: turn.spend
      })
      const result = await handle.result
      const text = result.text || record.finalText()
      // A turn its own run lost ends as a cancellation of the definition run, never as its answer:
      // the record is read again now, not only on the last heartbeat.
      const owned = engine.getRun(runId)
      if (!lost.signal.aborted && (!owned || TERMINAL_RUN_STATUSES.has(owned.status))) lost.abort(new DOMException('The agent run ended elsewhere.', 'AbortError'))
      if (lost.signal.aborted && !turn.signal.aborted) throw lost.signal.reason
      if (result.aborted || turn.signal.aborted) markTerminal('interrupted', { interruptedBy: 'user' }, text)
      else markTerminal('completed', undefined, text)
      const reported = turn.effects.attemptUsage
      const usage = reported.inputTokens || reported.outputTokens || reported.costUsd
        ? { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, costUsd: reported.costUsd }
        : record.usage(result.usage)
      return { text, history: record.history(turn.userMessage, text), usage }
    } catch (error) {
      // A limit the runtime refused the next step for ends the run with the reply so far and the
      // limit, not as an error that drops it.
      const limit = !signal.aborted && error instanceof AppError && error.code === 'budget_exhausted' ? (error.details as { limit?: AgentExecutionLimit } | undefined)?.limit : undefined
      if (limit && typeof limit.kind === 'string' && typeof limit.limit === 'number') {
        const text = record.finalText()
        markTerminal('failed', { error: `The agent reached its ${limit.kind} limit (${limit.limit}).` }, text)
        const reported = turn.effects.attemptUsage
        return { text, history: record.history(turn.userMessage, text), usage: { inputTokens: reported.inputTokens, outputTokens: reported.outputTokens, costUsd: reported.costUsd }, limit }
      }
      if (signal.aborted) markTerminal('interrupted', { interruptedBy: 'user' })
      else markTerminal('failed', { error: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      clearInterval(beat)
      signal.removeEventListener('abort', interrupt)
      app.drop()
    }
  }

  /** Called by the admitted definition-run owner, including during final shutdown persistence. */
  recordAgentDefinitionMessages(threadId: string, messages: ChatMessage[]): void {
    if (!this.threadStore?.getThread(threadId)) throw new Error('Agent execution thread is unavailable')
    const session = this.getOrCreateSession(threadId)
    if (session.deleted) throw new Error('Agent execution thread was deleted')
    this.sessionAls.run(session, () => {
      for (const message of messages) {
        if (session.messages.some((entry) => entry.id === message.id)) continue
        session.messages.push(structuredClone(message))
        this.emitMessageAdded(message)
      }
      this.markThreadStartedAndNotify(threadId)
      this.persistFn?.(threadId)
    })
  }
  /**
   * The harness gateway (SPEC §13): instance id → driver → turn runtime, capabilities, scope and
   * model prefs. Until the profile installs its own (`setHarness`), an in-memory instance map with
   * the `pi` driver and no Pi runtime (its turns are refused).
   */
  private harness: HarnessGateway
  /** The profile's bot threads (`bots.db`): a turn on one binds with origin `bot`. */
  private botThreads: BotThreads | null = null
  /** `thread_create` calls in flight by key, so two calls with one key make one thread. */
  private readonly agentCreations = new Map<string, { fingerprint: string; task: Promise<AgentCreatedThread> }>()

  /** The profile's bot threads, for the origin of their turns; null: none. */
  setBotThreads(threads: BotThreads | null): void {
    this.botThreads = threads
  }

  /** The profile's bot engine, which prepares and settles bot dispatches (PR 6 §4); null: none. */
  private botDispatcher: BotTurnDispatcher | null = null

  setBotDispatcher(dispatcher: BotTurnDispatcher | null): void {
    this.botDispatcher = dispatcher
  }

  /** Wakes the effect worker: a `turn.start` was written outside the orchestrator (a bot dispatch). */
  notifyEffects(): void {
    this.effectWorker?.notify()
  }

  /**
   * Ordinary sends, queued messages, steers and the generic Continue are refused on a bot's
   * threads: a bot request never runs as a plain turn, and only the Bots tab continues one.
   */
  private assertNotBotThread(threadId: string | undefined): void {
    const error = this.botThreadRefusal(threadId)
    if (error) throw error
  }

  /** The refusal for a turn or input on a bot's thread that is not its bot dispatch; undefined elsewhere. */
  private botThreadRefusal(threadId: string | undefined): AppError | undefined {
    if (!threadId || threadId === '__unbound__') return undefined
    const bot = this.botDispatcher?.ownerOf(threadId)
    if (bot === undefined) return undefined
    return new AppError({
      code: 'bot_thread_read_only',
      message: `This thread belongs to the bot ${bot}. Use the Bots tab to continue it.`,
      errorInfo: { category: 'invalid', retryable: false }
    })
  }

  /** Whether a thread belongs to a bot (only its own dispatches run there; a chat cannot bind to it). */
  isBotThread(threadId: string): boolean {
    return this.botThreadRefusal(threadId) !== undefined
  }

  /** Cancels a queued run that would start a turn on a bot's thread outside its bot dispatch. */
  private refuseOnBotThread(runId: string, threadId: string): boolean {
    if (!this.botThreadRefusal(threadId)) return false
    this.markRun(runId, (engine, id) => {
      if (engine.getRun(id)?.status === 'queued') engine.markTerminal(id, 'cancelled', { error: 'bot_thread_read_only' })
    })
    return true
  }

  /** The profile's harness gateway; also the test seam for fake drivers. */
  setHarness(harness: HarnessGateway): void {
    this.harness.setLiveHost(null)
    this.harness.setMcpAttachment(null)
    this.harness = harness
    this.attachLiveHost()
    this.harness.setMcpAttachment(this.mcpAttachment)
  }
  /** Runtimes that keep a live process per thread report their background work and the turns they start themselves here. */
  private attachLiveHost(): void {
    this.harness.setLiveHost({
      backgroundWork: (threadId, active) => this.setProviderBackgroundWork(threadId, active),
      continuationStarted: (threadId, info) => this.startProviderContinuation(threadId, info),
      notice: (threadId, text) => this.noteProviderNotice(threadId, text)
    })
  }
  /**
   * Migrate-on-read for a stored model selection: adds the instance id an older `llmProvider`
   * maps to. Never throws; an unmappable selection fails when a turn resolves it.
   */
  migrateModelOverride<T extends ModelOverride>(override: T | undefined): T | undefined {
    return this.harness.instanceMap.migrate(override)
  }
  private readonly questions: UserQuestionService
  private readonly modeRegistry: ModeRegistry
  /** Bound GUI/CLI session (active thread). Concurrent turns use ALS-scoped sessions. */
  private boundSession = new ThreadSession('__unbound__')
  private sessions = new Map<string, ThreadSession>()
  private readonly transcripts = new WeakMap<ThreadSession, TranscriptAssembler>()
  private readonly sessionAls = new AsyncLocalStorage<ThreadSession>()
  private persistFn?: (threadId?: string | null) => void
  /** Per-thread delayed persist timers (concurrent turns must not suppress each other). */
  private persistTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** In-flight channel turns keyed by mousse thread id; `runId` once the turn is an engine run. */
  private channelTurns = new Map<
    string,
    { abort: AbortController; pendingSteer: SteerEntry[]; runId?: string }
  >()
  /** Optional thread store for durable queue persistence. */
  private threadStore: ThreadDataStore | null = null
  /** Optional Run Engine (Phase 1 dual-write bridge). */
  private runEngine: RunEngine | null = null
  /** Title model refusals already logged (`reportTitleModelRefusal`). */
  private reportedTitleRefusals?: Set<string>
  private runEngineUnsubscribe: (() => void) | null = null
  /** Runs whose bridge write hit a stale epoch; later marks for that turn are skipped. */
  private readonly staleRuns = new Set<string>()
  /** `WAKE_BUSY_DEFER_MS`; tests shorten it. */
  private readonly wakeBusyDeferMs = WAKE_BUSY_DEFER_MS
  /** `DEFINITION_HEARTBEAT_MS`; tests shorten it. */
  private readonly definitionHeartbeatMs = DEFINITION_HEARTBEAT_MS
  /** Phase 2b: the worker that executes `turn.*` effects. Null keeps direct turn starts. */
  private effectWorker: EffectWorker | null = null
  /** Phase 5: mints a Mousse MCP credential per MCP-capable turn. Null attaches nothing. */
  private mcpAttachment: McpAttachmentProvider | null = null
  private mcpRegistry?: ToolRegistry
  /** The app-tool context of each running turn (PR 2 §2), for the Mousse MCP server's calls. */
  readonly appToolTurns = new AppToolTurns()
  /** The definition runs of each thread, for its public Stop (`stopDefinitionRuns`). */
  private readonly definitionStops = new Map<string, Set<DefinitionStop>>()
  /** Pending results of `turn.start` effects, keyed by runId (SPEC §12.7). */
  private readonly turnResults = new Map<string, TurnResult>()
  /**
   * Threads whose provider reports background work that outlives their runs (input 4 of the hold
   * predicate). No adapter reports any yet: a Codex turn stays open while its helpers run, and the
   * Claude and Antigravity adapters report nothing, so this stays empty until one does.
   */
  private readonly providerBackground = new Set<string>()
  /** How long a Mousse tool call waits for a continuation's run (tests shorten it). */
  private continuationCallWaitMs = CONTINUATION_CALL_WAIT_MS
  /**
   * Turns a provider started itself whose run is not active yet, by the provider's id for them. Each
   * holds the admission of its thread from the moment the provider reported it (a message typed meanwhile
   * queues behind it) and a gate Mousse tool calls of the thread wait on until the run is active.
   */
  private readonly pendingContinuations = new Map<string, { threadId: string; reserved: boolean; done: Promise<{ runId: string | null }>; settle: (runId: string | null) => void }>()
  /** Removes the listeners that route a subagent's questions to its parent (`routeSubagentQuestions`). */
  private questionRouterOff: (() => void) | null = null
  /** Pending retries of a queue item's row release (`releaseQueuedRows`); a shutdown clears them. */
  private readonly releaseRetries = new Set<ReturnType<typeof setTimeout>>()
  /** Background repairs of unfinished agent queue commands tried so far, per thread. */
  private readonly queueRepairAttempts = new Map<string, number>()
  /** Last run heartbeat (ms) per run; throttles `RunEngine.heartbeat` writes. */
  private readonly runHeartbeats = new Map<string, number>()
  /** Optional multi-tenant runtime manager (Phase 4). */
  private runtimeManager: import('../runtime/ThreadRuntimeManager').ThreadRuntimeManager | null =
    null
  /**
   * Max concurrent turns started by startup queue recovery.
   * Keeps recoverAndDrainPendingQueues bounded while still considering every eligible thread.
   */
  private static readonly STARTUP_QUEUE_DRAIN_CONCURRENCY = 2
  private startupDrainActive = 0
  private startupDrainPending: string[] = []
  private startupDrainScheduled = new Set<string>()
  private featureFlags: MousseFeatureFlags = { ...DEFAULT_FEATURE_FLAGS }
  private turnStates = new Map<string, TurnState>()

  /** `blockedOnWait`: every running tool call only waits, so the thread shows Waiting. */
  private setTurnPhase(threadId: string, phase: TurnPhase, patch?: Partial<Pick<TurnState, 'turnId' | 'activeMessageId' | 'error' | 'errorDescriptor' | 'pause'>> & { blockedOnWait?: boolean }): void {
    const now = new Date().toISOString()
    const existing = this.turnStates.get(threadId)
    const state: TurnState = {
      threadId,
      turnId: patch?.turnId !== undefined ? patch.turnId : (existing?.turnId ?? null),
      phase,
      updatedAt: now,
      ...(existing?.startedAt ? { startedAt: existing.startedAt } : phase !== 'idle' ? { startedAt: now } : {}),
      ...(patch?.activeMessageId !== undefined ? { activeMessageId: patch.activeMessageId } : existing?.activeMessageId ? { activeMessageId: existing.activeMessageId } : {}),
      ...(patch?.error ? { error: patch.error } : existing?.error && phase === 'failed' ? { error: existing.error } : {}),
    } as TurnState
    if (patch?.turnId !== undefined && patch.turnId !== existing?.turnId) (state as any).startedAt = now
    if (phase !== 'streaming' && phase !== 'tool_running') delete (state as any).activeMessageId
    if (phase === 'idle') { state.turnId = null; delete (state as any).startedAt }
    if (phase !== 'failed') { delete (state as any).error; delete state.errorDescriptor }
    // The pause is only part of the paused state; any other phase drops it.
    if (phase === 'paused' && patch?.pause) state.pause = patch.pause
    else delete state.pause
    if ((phase === 'queued' || phase === 'thinking') && !existing?.startedAt) (state as any).startedAt = now
    if (phase !== 'idle' && !(state as any).startedAt) (state as any).startedAt = existing?.startedAt ?? now
    this.turnStates.set(threadId, state)
    if (HEARTBEAT_TURN_PHASES.has(phase)) this.heartbeatRun(state.turnId)
    else if (existing?.turnId) this.runHeartbeats.delete(existing.turnId)
    this.emit('turn-state', state)
    this.runtimeManager?.setActivity(threadId, turnPhaseActivity(phase, patch?.blockedOnWait))
  }

  /** Liveness touch for an engine run (SPEC §12.4 rule 2), at most once per throttle window. */
  private heartbeatRun(runId: string | null | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId || !runId.startsWith('run:')) return
    const now = Date.now()
    const last = this.runHeartbeats.get(runId)
    if (last !== undefined && now - last < RUN_HEARTBEAT_THROTTLE_MS) return
    this.runHeartbeats.set(runId, now)
    try {
      engine.heartbeat(runId)
    } catch (error) {
      console.warn('run engine heartbeat failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  getTurnState(threadId: string): TurnState {
    return this.turnStates.get(threadId) ?? { threadId, turnId: null, phase: 'idle', updatedAt: new Date().toISOString() }
  }

  getTurnSnapshot(): TurnStateSnapshot {
    const out: TurnStateSnapshot = {}
    for (const [k, v] of this.turnStates) out[k] = v
    return out
  }

  setAwaitingInput(threadId: string): void {
    this.setTurnPhase(threadId, 'awaiting_input')
  }

  private get session(): ThreadSession {
    return this.sessionAls.getStore() ?? this.boundSession
  }

  private get messages(): ChatMessage[] {
    return this.session.messages
  }
  private set messages(value: ChatMessage[]) {
    this.session.messages = value
  }

  private get nativeContext(): NativeLlmContext {
    return this.session.nativeContext
  }
  private set nativeContext(value: NativeLlmContext) {
    this.session.nativeContext = value
  }

  private get activeTurn(): ThreadSession['activeTurn'] {
    return this.session.activeTurn
  }
  private set activeTurn(value: ThreadSession['activeTurn']) {
    this.session.activeTurn = value
  }

  private get activeAssistantMessageId(): string | null {
    return this.session.activeAssistantMessageId
  }
  private set activeAssistantMessageId(value: string | null) {
    this.session.activeAssistantMessageId = value
  }

  private get lastCompletedAssistantMessageId(): string | null {
    return this.session.lastCompletedAssistantMessageId
  }

  private get lastCompletedAssistantContent(): string {
    return this.session.lastCompletedAssistantContent
  }

  private get lastMeasuredInput(): number | null {
    return this.session.lastMeasuredInput
  }
  private set lastMeasuredInput(value: number | null) {
    this.session.lastMeasuredInput = value
  }

  private get lastMeasuredCacheRead(): number | null {
    return this.session.lastMeasuredCacheRead
  }
  private set lastMeasuredCacheRead(value: number | null) {
    this.session.lastMeasuredCacheRead = value
  }

  private get lastMeasuredCacheWrite(): number | null {
    return this.session.lastMeasuredCacheWrite
  }
  private set lastMeasuredCacheWrite(value: number | null) {
    this.session.lastMeasuredCacheWrite = value
  }

  private get lastMeasuredContextSignature(): string | null {
    return this.session.lastMeasuredContextSignature
  }
  private set lastMeasuredContextSignature(value: string | null) {
    this.session.lastMeasuredContextSignature = value
  }

  private get measuredAtHistoryLength(): number {
    return this.session.measuredAtHistoryLength
  }
  private set measuredAtHistoryLength(value: number) {
    this.session.measuredAtHistoryLength = value
  }

  private get failedConnectionRequest(): OrchestratorSendInput | null {
    return this.session.failedConnectionRequest
  }
  private set failedConnectionRequest(value: OrchestratorSendInput | null) {
    this.session.failedConnectionRequest = value
  }

  /** Session-scoped agents (ALS when inside a turn; else bound session). */
  private get agents(): AgentRegistry {
    return this.session.agents
  }

  /** Session-scoped tasks. */
  private get tasks(): TaskQueue {
    return this.session.tasks
  }

  constructor(
    agents: AgentRegistry,
    tasks: TaskQueue,
    private worktrees: WorktreeManager,
    private ptyManager: PtyManager,
    private settingsStore: SettingsStore,
    private providerAuth: ProviderAuthService,
    private mcpManager?: McpManager,
    private skillsRegistry?: SkillsRegistry,
    private fileService?: FileService,
    private gitService?: GitService,
    private lineEditStats?: LineEditStatsStore,
    private projectManager?: ProjectManager,
    runtime?: { questions?: UserQuestionService; modeRegistry?: ModeRegistry }
  ) {
    super()
    // Until `setHarness` binds the profile's gateway: the pi loop only, over a per-process scratch
    // home (nothing is written there unless a caller changes instance state).
    const unboundHome = join(tmpdir(), `mousse-unbound-harness-${process.pid}`)
    this.harness = createHarnessGateway({
      profileHome: unboundHome,
      installationHome: unboundHome,
      instanceMap: new ProviderInstanceService({ providerAuth }),
      drivers: [piDriver({ credentials: () => this.providerAuth })],
      questions: runtime?.questions ?? defaultUserQuestionService,
      shellPath: async () => ({ entries: [], source: 'failed' })
    })
    this.questions = runtime?.questions ?? defaultUserQuestionService
    // `canAnswerApproval` finds an approval's thread parent through the Run Engine's lineage.
    this.questions.setLineageSource((threadId) => {
      try {
        return this.runEngine?.delegations.getLineage(threadId) ?? null
      } catch {
        return null
      }
    })
    this.modeRegistry = runtime?.modeRegistry ?? defaultModeRegistry
    // Seed unbound session registries (tests / legacy inject shared instances).
    this.boundSession.agents = agents
    this.boundSession.tasks = tasks
  }

  /**
   * The session whose agent registry holds `agentId` (named-agent projections and agents restored
   * from earlier versions), searched instead of a separate ownership map.
   */
  private agentOwner(agentId: string): ThreadSession | undefined {
    for (const session of new Set([this.boundSession, ...this.sessions.values()]))
      if (session.agents.get(agentId)) return session
    return undefined
  }

  setPersistCallback(fn: (threadId?: string | null) => void): void {
    this.persistFn = fn
  }

  /** Optional ThreadDataStore for durable queue + cross-thread persistence. */
  setThreadStore(store: ThreadDataStore | null): void {
    this.threadStore = store
    this.installTitleGuard()
    this.installQueueJournal()
  }

  /**
   * Phase 1 Run Engine bridge (docs/run-engine/SPEC.md §5). When set, every send is a durable run
   * and executeTurn reports its lifecycle through the engine's CAS hooks. Null keeps legacy only.
   */
  setRunEngine(engine: RunEngine | null): void {
    this.runEngineUnsubscribe?.()
    this.runEngineUnsubscribe = null
    this.runEngine?.setDelegationHost(null)
    this.runEngine?.setInFlightCanceller(null)
    this.runEngine?.store.setProviderBackgroundWork(null)
    this.runEngine?.store.setUnreadSteers(null)
    this.questionRouterOff?.()
    this.questionRouterOff = null
    this.runEngine?.handoffs.setTranscriptSource(null)
    this.unbindApprovals()
    this.runEngine = engine
    this.installQueueJournal()
    if (!engine) return
    this.bindApprovals(engine)
    this.installTitleGuard()
    this.attachInFlightCanceller()
    // Input (4) of the hold predicate: synchronous, in memory, never throws (it is read inside transactions).
    engine.store.setProviderBackgroundWork((threadId) => this.providerBackground.has(threadId))
    // Input (5): steers a live turn has not read yet become a follow-up turn only after its terminal write.
    engine.store.setUnreadSteers((threadId) => this.hasUnreadSteers(threadId))
    this.questionRouterOff = this.routeSubagentQuestions(engine)
    engine.handoffs.setTranscriptSource((threadId) => this.handoffTranscript(threadId))
    engine.setDelegationHost({
      createThread: (creation) =>
        creation.kind === 'delegation' ? this.createChildThread(creation.request) : this.createForkThread(creation),
      deleteThread: (threadId) => this.discardCreatedThread(threadId),
      forkPointSeed: (sourceThreadId, sourceRunId) => this.forkPointSeed(sourceThreadId, sourceRunId),
      titleConflicts: (parentThreadId, title) => this.subagentTitleConflicts(parentThreadId, title),
      threadLive: (threadId) => this.titleOf(threadId) !== undefined,
      buildChildTurnPayload: ({ childThreadId, childRunId, prompt, request }): TurnStartPayload => ({
        runId: childRunId,
        threadId: childThreadId,
        // A plan-ceiling child plans only (SPEC §15.1). The subagent is told where its result goes, then its task.
        input: { content: `${subagentPreamble(this.titleOf(request.parentThreadId))}\n\n${prompt}`, mode: request.modeCeiling === 'plan' ? 'plan' : 'agent' },
        reuseLastUser: false,
        displayUserMessage: true,
        source: 'delegation',
        // The path recorded when the child was created, not the parent's workspace as it is now.
        ...(request.workspace === 'shared' ? { sharedWorkspace: this.getOrCreateSession(childThreadId).sharedWorkspace ?? null } : {})
      })
    })
    const onEvent = (event: ThreadEvent): void => {
      // Running delegated tasks wake the parent when they finish; until then its thread is Waiting.
      if (event.type === 'delegation.status')
        this.runtimeManager?.setPendingDelegations(event.threadId,
          engine.delegations.listForParentThread(event.threadId).some((delegation) => delegation.status === 'running'))
      if (event.type === 'reconcile.delivery_failed') this.noteUndeliveredResult(event)
      // A saved approval request closed without an answer (its run ended, a Stop, the thread was
      // deleted): its card goes and the provider callback that still waits for it is released.
      if (event.type === 'approval.cancelled') {
        const { requestId, reason } = event.payload as { requestId?: string; reason?: string }
        if (requestId) this.questions.approvalClosed(requestId, reason ?? 'withdrawn')
      }
      this.emit('run-event', event)
    }
    const onStop = (payload: { threadId: string; runId: string }): void => { this.emit('stop-requested', payload) }
    const onSteer = (payload: { threadId: string; runId: string }): void => { this.emit('steer-accepted', payload) }
    engine.on('event', onEvent)
    engine.on('stop-requested', onStop)
    engine.on('steer-accepted', onSteer)
    this.runEngineUnsubscribe = () => {
      engine.off('event', onEvent)
      engine.off('stop-requested', onStop)
      engine.off('steer-accepted', onSteer)
    }
  }

  /**
   * Approval requests are saved in the engine's database from now on (SPEC §17). The service finds the
   * run that is asking by its thread, delivers answers through the `request.respond` effect when a
   * worker is attached, and asks this orchestrator for the continue turn of a restarted run.
   */
  private bindApprovals(engine: RunEngine): void {
    this.questions.setApprovalStore({
      store: engine.approvals,
      context: (threadId) => {
        const run = engine.getActiveRun(threadId)
        if (!run) return null
        const binding = engine.bindingForRun(run.runId)
        const origin = binding ? policyOrigin(binding.policy) : 'interactive'
        const permissionMode = binding?.policy.permissionMode
        let currentMode = permissionMode
        if (permissionMode) {
          // A rule is checked against the stricter of the run's mode and the thread's own now: a tighter mode applies
          // to the next turn, but a rule stops answering at once.
          try { currentMode = narrowPermissionMode(permissionMode, this.requestedPermissionMode(threadId)) } catch { currentMode = 'ask' }
        }
        return {
          runId: run.runId,
          instanceId: binding?.instanceId ?? '',
          provider: binding?.driver ?? '',
          origin,
          // A binding that records no mode leaves it unknown: no rule is offered, made or matched for it.
          ...(permissionMode ? { permissionMode } : {}),
          ...(currentMode ? { currentMode } : {}),
          approvals: binding?.policy.approvals ?? 'ask',
          // No binding, no known starter: not a person's turn.
          startedByPerson: binding !== undefined && startedByPerson({ origin, source: run.source })
        }
      },
      effectDelivery: () => this.effectsEnabled(),
      continuationDue: (due, answeredBy) => this.startApprovalContinuation(due, answeredBy),
      ruleApplied: (threadId, rule) => this.noteProviderNotice(threadId, `Allowed without asking by your "Always for this thread" rule (${rule.summary.slice(0, 200)}).`)
    })
  }

  /** Only the binding this orchestrator made: a service shared with a newer orchestrator keeps theirs. */
  private unbindApprovals(): void {
    const store = this.runEngine?.approvals
    if (store && this.questions.approvalStore === store) this.questions.setApprovalStore(null)
  }

  /**
   * SPEC §17.4: every approval request a dead run left is answered, so the thread continues from where
   * the run was cut off. The click was the user action SPEC §16.4 requires; a repeat of the same run's
   * continuation is a replay (`approval-run:<runId>`). The answers are handed to the new run in the
   * admitting transaction, and the run's first request for the same action is granted once.
   */
  private startApprovalContinuation(due: ContinuationDue, answeredBy?: Answerer): void {
    // The source of the user's own client: a subagent's continuation is then tracked as a follow-up and its
    // parent hears the result, as for the restart note's Continue.
    // A person on another of the user's computers (`via: 'bridge'` with the computer that answered) is that
    // person: the turn that carries on is theirs, as if they had answered in this app. A linked phone answers
    // as `bridge` without a computer, and its continuation stays internal.
    const source = answeredBy?.kind === 'user'
      ? (answeredBy.via === 'gui' || answeredBy.via === 'cli' ? answeredBy.via : answeredBy.via === 'bridge' && answeredBy.node ? 'gui' : 'internal')
      : 'internal'
    void this.send('Continue where you left off.', false, {
      threadId: due.threadId,
      clientRequestId: `approval-run:${due.runId}`,
      continuationOfRunId: due.runId,
      acknowledgeUncertain: due.uncertain,
      bindDelivery: { requestIds: due.requestIds },
      source,
      // The computer that answered is the sender of the turn that carries on, so blocking it stops that turn.
      ...(answeredBy?.kind === 'user' && answeredBy.via === 'bridge' && answeredBy.node ? { sentFrom: { node: answeredBy.node } } : {}),
      awaitMode: 'ack'
    }).catch((error: unknown) => {
      console.warn('the continuation of an answered approval could not start', { threadId: due.threadId, runId: due.runId, error: error instanceof Error ? error.message : String(error) })
      // Another run already took these answers: nothing is waiting. Any other refusal leaves an answer with no
      // card and no turn, so the thread says so.
      if ((error as { code?: unknown } | undefined)?.code !== 'approvals_already_delivered')
        this.noteProviderNotice(due.threadId, `Your answer to an approval could not continue the thread (${error instanceof Error ? error.message : String(error)}). Send a message to carry on.`)
    })
  }

  /**
   * Boot: an answer committed before the process died but never delivered continues the thread now
   * that the worker runs, once every request of its run is answered. A run's continuation that was
   * already admitted is a replay.
   */
  private resumeUndeliveredApprovals(): void {
    const engine = this.runEngine
    if (!engine) return
    try {
      const byRun = new Map<string, ApprovalRecord[]>()
      for (const row of engine.approvals.listUndelivered()) {
        if (row.answerPath !== 'continue' || !row.runId) continue
        byRun.set(row.runId, [...(byRun.get(row.runId) ?? []), row])
      }
      for (const [runId, rows] of byRun) {
        if (engine.approvals.listPendingForRun(runId).length) continue
        const threadId = rows[0]!.threadId
        // Continuing is the user's click: an answer only agents gave waits for one.
        if (!rows.some((row) => row.answeredBy?.kind === 'user')) continue
        // A run the crash left `uncertain` is not continued behind the user's back: the acknowledgement that
        // a tool may already have run is theirs to give, with the restart note's Continue.
        if (rows.some((row) => row.uncertain)) {
          const tools = [...new Set(rows.flatMap((row) => row.uncertainTools ?? []))]
          this.noteProviderNotice(threadId, `An approval you answered before the restart was not delivered, and ${tools.length ? tools.join(', ') : 'a tool'} may already have run. Check the work, then press Continue.`)
          continue
        }
        this.startApprovalContinuation({ threadId, runId, requestIds: rows.map((row) => row.requestId), uncertain: false })
      }
    } catch (error) {
      console.warn('answered approvals could not be resumed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** What the run tells its agent about the approvals it was started to deliver; undefined when none. */
  private approvalDecisionNote(runId: string | undefined): string | undefined {
    const engine = this.runEngine
    if (!engine || !runId) return undefined
    try {
      const text = formatApprovalDecisions(engine.approvals.listDeliveredToRun(runId), (threadId) => this.titleOf(threadId))
      return text || undefined
    } catch (error) {
      console.warn('approval decisions could not be read', { runId, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  /**
   * A provider's background work for `threadId` started (`active`) or finished (including an idle-cap
   * expiry). While it runs, the tasks waiting on the thread stay `running`, and the thread shows
   * Waiting; when it ends they are evaluated again. Called by the provider that owns the work.
   */
  setProviderBackgroundWork(threadId: string, active: boolean): void {
    if (active === this.providerBackground.has(threadId)) return
    if (active) this.providerBackground.add(threadId)
    else this.providerBackground.delete(threadId)
    try {
      this.runtimeManager?.setPendingBackgroundWork(threadId, active)
    } catch (error) {
      console.warn('background work activity could not be updated', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
    if (!active) this.runEngine?.store.settleHold(threadId)
  }

  /** A line in the thread about its provider's process (a helper's result that may not have arrived). */
  private noteProviderNotice(threadId: string, text: string): void {
    try {
      const session = this.getOrCreateSession(threadId)
      this.sessionAls.run(session, () => this.addSystemMessage(text))
    } catch (error) {
      console.warn('provider notice could not be written', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * A line in the thread from a watch of its pull request, saved before this answers. `messageId` makes it once: a line
   * with that id already in the transcript (live, or loaded from disk when the session was made) is not added again. The
   * answer means the line is on disk: `delivered` when this call added it, `already` when it was there. A failed save throws
   * and leaves the line in memory, so the retry finds it, adds and announces nothing a second time, and saves again.
   * Unlike `postThreadNotice`, no inbox row is written, so nothing wakes the agent.
   */
  async noteThreadUpdate(threadId: string, text: string, opts: { messageId: string; kind?: 'warning' }): Promise<'delivered' | 'already'> {
    if (this.lifecycle.stopping) throw new Error('The daemon is stopping')
    if (this.threadStore?.lifecycleStore?.get(threadId)) this.threadStore.assertThreadAdmission(threadId)
    const session = this.getOrCreateSession(threadId)
    return this.sessionAls.run(session, () => {
      const held = session.messages.some((message) => message.id === opts.messageId)
      if (!held) {
        const message: ChatMessage = { id: opts.messageId, role: 'system', ...(opts.kind ? { kind: opts.kind } : {}), content: text, timestamp: new Date().toISOString() }
        session.messages.push(message)
        this.emitMessageAdded(message)
      }
      // Immediate, and not swallowed: the caller records the delivery as done only after this returns.
      this.persist(true)
      return held ? 'already' : 'delivered'
    })
  }

  /**
   * Claude started a turn of its own because background tasks finished (`ClaudeLiveHost`): it
   * becomes a `provider-continuation` run of the thread, queued like a wake. The run and its
   * `turn.start` effect are written in the engine; the effect runs the turn when the thread is free.
   * A host that cannot record the run throws, and the provider reads and drops the turn instead.
   */
  private startProviderContinuation(threadId: string, info: { id: string; taskIds: string[]; summaries: string[] }): void {
    const engine = this.runEngine
    if (!engine || !this.effectsEnabled()) throw new Error('Continuation turns need the run engine worker')
    const note = info.summaries.length
      ? `A background task finished: ${info.summaries.join('; ').slice(0, 600)}`
      : 'A background task finished.'
    // The thread is the continuation's from now on: a message typed before its effect runs sees the
    // thread busy and queues behind it, instead of taking an admission the continuation then waits for.
    const session = this.getOrCreateSession(threadId)
    const reserved = !session.deleted && !session.isTurnRunning() && !engine.getActiveRun(threadId)
    if (reserved) session.turnAdmitted = true
    let settle!: (state: { runId: string | null }) => void
    const done = new Promise<{ runId: string | null }>((resolve) => { settle = resolve })
    // Claude keeps working while the run is made. Mousse tool calls it makes wait for the run to be
    // active, so they act as it, not as a run that just ended or as no one; a run that never comes
    // frees them after a while.
    const timer = setTimeout(() => settle({ runId: null }), this.continuationCallWaitMs)
    timer.unref?.()
    this.pendingContinuations.set(info.id, { threadId, reserved, done, settle: (runId) => { clearTimeout(timer); settle({ runId }) } })
    void engine.dispatch({ kind: 'send', threadId, clientRequestId: `continuation:${info.id}`, source: 'provider-continuation' })
      .then((result) => {
        if (result.status !== 'accepted') throw new Error(result.reason)
        const payload: ContinuationTurnPayload = { kind: 'continuation', threadId, runId: result.runId, continuationId: info.id, note }
        engine.outbox.enqueue({ effectId: `effect:${result.runId}:turn.start:1`, threadId, runId: result.runId, kind: 'turn.start', payload })
      })
      .catch((error: unknown) => {
        console.warn('a provider continuation could not be recorded', { threadId, error: error instanceof Error ? error.message : String(error) })
        // Only this turn: another one waiting on the thread belongs to a run of its own.
        this.harness.discardContinuations(threadId, info.id)
        this.endContinuationHold(info.id, true)
      })
  }

  /**
   * The threads' continuations that wait for their run end with the thread: the engine cancels their
   * effects without executing them, so nothing else would clear the entries or free the calls waiting on them.
   */
  private dropContinuationsOf(threadId: string): void {
    for (const [id, hold] of [...this.pendingContinuations]) if (hold.threadId === threadId) this.endContinuationHold(id, false)
  }

  /**
   * A continuation's hold ends: its run is not going to run (`release`: the admission it reserved goes
   * back and the queue drains), or it is active now (the run owns the admission from here).
   */
  private endContinuationHold(continuationId: string, release: boolean, activeRunId: string | null = null): void {
    const hold = this.pendingContinuations.get(continuationId)
    if (!hold) return
    this.pendingContinuations.delete(continuationId)
    // Calls that waited learn whether, and as which run, the continuation became active.
    hold.settle(activeRunId)
    if (!release || !hold.reserved) return
    // The admission is free: effects waiting for it can look again now.
    this.effectWorker?.notify()
    const session = this.sessions.get(hold.threadId)
    if (!session) return
    if (session.turnAdmitted && !session.activeTurn) {
      session.turnAdmitted = false
      session.admissionRunId = undefined
      session.abortRequested = false
    }
    try {
      this.scheduleQueueDrain(session)
    } catch (error) {
      logDebug('OrchestratorService', 'queue drain after a continuation could not be scheduled', error, { threadId: hold.threadId })
    }
  }

  /** Mousse tool calls of the thread wait for this while a turn the provider started has no active run yet. */
  private continuationGate(threadId: string): Promise<{ runId: string | null }> | undefined {
    // A call is gated only when it comes from a turn Claude started itself that has no run yet. Provider
    // frames say which turn is running: while it is a message of ours, its calls act as the active run
    // at once, whatever continuations wait behind it.
    const flight = this.harness.inFlightContinuation(threadId)
    if (!flight) return undefined
    // A wake nobody could run (discarded) has no run and never will: its calls are refused.
    if (flight.discarded) return Promise.resolve({ runId: null })
    const hold = this.pendingContinuations.get(flight.id)
    return hold && hold.threadId === threadId ? hold.done : undefined
  }

  /**
   * A `provider-continuation` run: the turn Claude started itself, run as an ordinary visible turn
   * of the thread. A run that is no longer queued (stopped, thread deleted), or whose turn Claude no
   * longer holds (it ended folded into a message of ours), ends without running. It holds the thread
   * from the provider's report, so a message queued meanwhile runs after it. If another turn was admitted
   * before the report and its effect waits behind this one in the lane, this one goes first: Claude's
   * turn already exists and cannot be cancelled, and that effect runs as soon as this one ends. Only a turn
   * whose own `turn.start` effect holds the admission is passed (a queue drain's turn gets its effect with
   * the admission held, so it is passable too); a turn that already runs, or one of a channel, finishes first.
   */
  private async executeContinuationEffect(effect: EffectRecord, payload: ContinuationTurnPayload, signal: AbortSignal): Promise<void> {
    const engine = this.requireRunEngine()
    const hold = this.pendingContinuations.get(payload.continuationId)
    const end = (): void => this.endContinuationHold(payload.continuationId, true)
    // A bot thread runs only its bot dispatches: a turn its runtime started on its own is not one.
    if (this.refuseOnBotThread(payload.runId, payload.threadId)) {
      this.harness.discardContinuations(payload.threadId, payload.continuationId)
      end()
      return
    }
    if (engine.getRun(payload.runId)?.status !== 'queued') {
      this.harness.discardContinuations(payload.threadId, payload.continuationId)
      end()
      return
    }
    const session = this.getOrCreateSession(payload.threadId)
    if (session.deleted || !this.harness.hasContinuation(payload.threadId, payload.continuationId)) {
      this.markRun(payload.runId, (runs, id) => runs.markTerminal(id, 'cancelled'))
      end()
      return
    }
    let passedThrough = false
    const passedOwner = session.admissionRunId
    if (!hold?.reserved) {
      const busy = session.isTurnRunning() || engine.getActiveRun(payload.threadId)
      if (busy) {
        // Only a turn whose own turn.start effect holds the admission and is still waiting behind this one
        // may be passed: a send's turn, or a queue drain's (the drain gets its effect with the admission held,
        // and startTurn records that run as the owner). An admission with no owner effect belongs to a turn
        // that does not run through the engine (a channel turn): it finishes first.
        const owner = session.admissionRunId
        const waiting =
          owner !== undefined &&
          engine.outbox.listForThread(payload.threadId).some((other) => other.kind === 'turn.start' && other.runId === owner && other.effectId !== effect.effectId && other.status === 'pending')
        if (!(waiting && session.turnAdmitted && !session.activeTurn && !engine.getActiveRun(payload.threadId)))
          throw new EffectDeferredError(this.wakeBusyDeferMs, 'thread_busy')
        passedThrough = true
      }
    }
    try {
      await this.runTurnOnSession(
        session,
        { content: payload.note, mode: getLastUserChatMode(session.messages) ?? 'agent' },
        false,
        true,
        { source: 'provider-continuation', runId: payload.runId, externalSignal: signal, continuationId: payload.continuationId, admissionHeld: Boolean(hold?.reserved) || passedThrough }
      )
    } catch (error) {
      const run = engine.getRun(payload.runId)
      if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) throw error
    } finally {
      // The run did not become active (it failed before it started): the hold ends here.
      this.endContinuationHold(payload.continuationId, false)
      // The admitted turn that went second still needs its admission, and its place as the owner of it, unless
      // something else has taken the admission since (the turn's own end can schedule a queue drain).
      if (passedThrough && !session.turnAdmitted && session.admissionRunId === undefined) {
        session.turnAdmitted = true
        session.admissionRunId = passedOwner
      }
      this.effectWorker?.notify()
    }
  }

  /**
   * A subagent's question reaches its parent (issue #142). Every question the daemon asks on a
   * subagent's thread (the model's own `ask_user`, a plan question, a provider's approval such as
   * Codex's command approval; they all go through `UserQuestionService`) writes a `child_question`
   * row (a `reconcile_notice`) into the parent's inbox, and rule 4 wakes or steers the parent with
   * it: it answers with `answer_subagent` or asks the user. The user still sees the question under
   * the top-level thread. When the question is answered, dismissed or times out, its row is
   * acknowledged on the `cleared` event; one left from a previous process is acknowledged at boot.
   * Returns the function that removes the listeners.
   */
  private routeSubagentQuestions(engine: RunEngine): () => void {
    const onPending = (event: { requestId: string; threadId: string }): void => {
      try {
        const lineage = engine.delegations.getLineage(event.threadId)
        if (!lineage || lineage.relationship !== 'subagent' || this.titleOf(lineage.parentThreadId) === undefined) return
        const task = engine.delegations.listForChildThread(event.threadId).filter((entry) => entry.parentThreadId === lineage.parentThreadId && entry.status === 'running').at(-1)
        const payload: ChildQuestionPayload = {
          kind: 'child_question',
          childThreadId: event.threadId,
          childRunId: engine.getActiveRun(event.threadId)?.runId ?? null,
          requestId: event.requestId,
          ...(task ? { delegationId: task.delegationId } : {})
        }
        engine.inbox.append({ threadId: lineage.parentThreadId, runId: task?.parentRunId ?? null, kind: 'reconcile_notice', payload })
      } catch (error) {
        console.warn('a subagent\'s question could not be routed to its parent', { threadId: event.threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const onCleared = (event: { requestId: string; threadId: string }): void => {
      try {
        const open = engine.inbox
          .listForChildThread(event.threadId, 'child_question')
          .filter((row) => row.status !== 'acknowledged' && (row.payload as ChildQuestionPayload).requestId === event.requestId)
        if (open.length) engine.store.db.transaction(() => engine.inbox.markAcknowledged(open.map((row) => row.inboxId)))
      } catch (error) {
        console.warn('a cleared question\'s notice could not be acknowledged', { threadId: event.threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    this.questions.on('pending', onPending)
    this.questions.on('cleared', onCleared)
    return () => {
      this.questions.off('pending', onPending)
      this.questions.off('cleared', onCleared)
    }
  }

  /**
   * Before a delivery: a row about a question that is not pending any more (answered, dismissed, timed
   * out, or lost with a restart) is acknowledged instead of delivered, so the parent is never told to
   * answer what nobody can. Returns the rows that are still worth delivering.
   */
  private dropStaleQuestionRows(rows: InboxRecord[]): InboxRecord[] {
    const engine = this.runEngine
    if (!engine) return rows
    const stale = rows.filter((row) => isChildQuestionRow(row) && !this.questions.getPending((row.payload as ChildQuestionPayload).requestId))
    if (stale.length === 0) return rows
    engine.store.db.transaction(() => engine.inbox.markAcknowledged(stale.map((row) => row.inboxId)))
    return rows.filter((row) => !stale.includes(row))
  }

  /**
   * Whether the thread's live turn holds steers nobody has read yet, so its tasks must not publish: a
   * person's plain-text steer lives only in the turn's memory until the turn settles and queues it as a
   * follow-up run (`RunStore.setUnreadSteers`). Once queued, the follow-up is a run of the engine, which
   * holds the thread on its own and survives a restart.
   */
  private hasUnreadSteers(threadId: string): boolean {
    const session = this.boundSession.threadId === threadId ? this.boundSession : this.sessions.get(threadId)
    const turn = session?.activeTurn
    return Boolean(turn && !turn.abort.signal.aborted && turn.pendingSteer.length > 0)
  }

  /**
   * A subagent result could not be delivered after every attempt (`restoreUndeliveredRows`): the
   * thread gets a visible notice, so the result is never silently lost. The result itself is intact
   * and readable with `task_status`.
   */
  private noteUndeliveredResult(event: ThreadEvent): void {
    try {
      const { delegationId, attempts } = event.payload as { delegationId?: string | null; attempts?: number }
      const delegation = delegationId ? this.runEngine?.delegations.get(delegationId) : null
      const title = delegation ? this.titleOf(delegation.childThreadId) : undefined
      const session = this.getOrCreateSession(event.threadId)
      this.sessionAls.run(session, () => this.addSystemMessage(
        `The result of ${title ? `subagent "${title}"` : 'a subagent'} could not be delivered after ${attempts ?? 'several'} attempts. Read it with task_status${delegationId ? ` (${delegationId})` : ''}.`
      ))
    } catch (error) {
      console.warn('undelivered result notice could not be written', { threadId: event.threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Boot reconciliation: runs the previous daemon left active become interrupted. */
  recoverRunEngineOnBoot(): string[] {
    const engine = this.runEngine
    if (!engine) return []
    const { interrupted } = engine.reconcileOnBoot()
    for (const runId of interrupted) {
      this.emit('run-interrupted-on-boot', { threadId: engine.getRun(runId)?.threadId, runId })
    }
    this.recoverQueuedRows()
    this.recoverOrphanedFollowUps()
    this.recoverAgentThreadCreations()
    this.restorePausedTurnStates()
    // After the runs of the earlier daemon are settled: an agent's queue command that never finished is finished now.
    this.recoverQueueCommandsOnBoot()
    return interrupted
  }

  /**
   * Boot: the follow-up of a steer a turn never read is a queued run created just before its queue entry
   * is saved. A crash between the two leaves a queued `steer-followup` run that no queue entry and no
   * `turn.start` will ever start, which would hold its subagent's task for ever. Such a run is cancelled
   * (the steer it was for lived only in the dead process), which releases the hold.
   */
  private recoverOrphanedFollowUps(): void {
    const engine = this.runEngine
    if (!engine || !this.threadStore) return
    for (const run of engine.store.listNonTerminalRuns()) {
      if (run.status !== 'queued') continue
      // A scheduled occurrence has the same window: its run is admitted, then its effect or queue item is written.
      if (run.source === 'steer-followup') {
        if (!this.admissionPending(run.runId, run.threadId)) this.cancelOrphanedAdmission(run.runId, 'The daemon stopped before the follow-up was queued.')
      } else if (run.source === 'schedule') {
        if (!this.admissionPending(run.runId, run.threadId)) this.cancelOrphanedAdmission(run.runId, SCHEDULED_NEVER_STARTED)
      }
    }
  }

  /**
   * True while a queued run still has something that will start it: a `turn.start` effect or a queue
   * item carrying its `runId`. A queue that cannot be read counts as pending (nothing is cancelled on a guess).
   */
  private admissionPending(runId: string, threadId: string): boolean {
    const engine = this.runEngine
    const store = this.threadStore
    if (!engine || !store) return true
    if (engine.outbox.listForRun(runId).some((effect) => effect.kind === 'turn.start')) return true
    try {
      return readDurableQueue(store, threadId).some((item) => item.runId === runId)
    } catch {
      return true
    }
  }

  /**
   * Ends a queued run that nothing can start (the daemon stopped between its admission and the write that
   * would have started it) as cancelled. A stale write or a run that is already terminal changes nothing.
   */
  private cancelOrphanedAdmission(runId: string, error: string): void {
    this.markRun(runId, (runs, id) => {
      if (runs.getRun(id)?.status === 'queued') runs.markTerminal(id, 'cancelled', { interruptedBy: 'daemon_restart', error })
    })
  }

  /** What the scheduler asks the Run Engine about its admitted occurrences (`ScheduledJobStore.setRunProbe`). */
  scheduledRunProbe(): ScheduledRunProbe {
    return {
      runStatus: (runId) => {
        const engine = this.runEngine
        if (!engine) return 'unavailable'
        const run = engine.getRun(runId)
        if (!run) return 'absent'
        const error = run.outcome?.error
          ?? (run.outcome?.interruptedBy === 'daemon_restart' && run.status === 'interrupted' ? 'Interrupted: the daemon restarted while the run was active' : undefined)
        return { status: run.status, threadId: run.threadId, ...(error ? { error } : {}), ...(run.outcome?.usageLimitUntil ? { usageLimitUntil: run.outcome.usageLimitUntil } : {}) }
      },
      admissionPending: (runId, threadId) => this.admissionPending(runId, threadId),
      cancelOrphanedAdmission: (runId) => this.cancelOrphanedAdmission(runId, SCHEDULED_NEVER_STARTED),
      receipt: (clientRequestId) => {
        const receipt = this.runEngine?.store.getReceipt(clientRequestId)
        const result = receipt?.result
        if (receipt?.status !== 'accepted' || !result || typeof result !== 'object') return undefined
        const runId = (result as { runId?: unknown }).runId
        return typeof runId === 'string' && runId ? { runId, threadId: receipt.threadId } : undefined
      }
    }
  }

  /**
   * Boot: a row a queue item carries (`queue:<id>`) whose item is gone (removed or cleared, then a
   * crash) has no delivery left; it goes back to pending for rule 4. A row whose item exists stays with it.
   */
  private recoverQueuedRows(): void {
    const engine = this.runEngine
    const store = this.threadStore
    if (!engine || !store) return
    const items = new Map<string, Set<string>>()
    for (const row of engine.inbox.listDeliveredByQueue()) {
      let ids = items.get(row.threadId)
      if (!ids) {
        try {
          ids = new Set(readDurableQueue(store, row.threadId).map((item) => item.id))
        } catch {
          continue
        }
        items.set(row.threadId, ids)
      }
      if (!ids.has(row.deliveredBy!.slice('queue:'.length))) engine.inbox.release([row.inboxId], row.deliveredBy!)
    }
  }

  /**
   * Stop a specific run. Only the thread's active run is the target; any other run is ignored without
   * cascading. A live target stops like any Stop (`stopThread`): the thread and every subagent below
   * it. The interrupt follows `CommandPolicy.stopStrategy` (`interruptRun`). A replay of an accepted
   * stop (same `clientRequestId`) enqueues the interrupt again when the run is still active and none
   * is pending or running (M4).
   */
  async abortRun(runId: string, clientRequestId: string, threadId?: string): Promise<CommandResult> {
    const engine = this.requireRunEngine()
    const target = threadId ?? engine.getRun(runId)?.threadId
    if (!target) return { status: 'ignored', reason: 'run_not_found', runId, sequence: 0 }
    const result = await this.stopThread(target, 'user', { runId, clientRequestId })
    const sequence = engine.maxSeq(target)
    if (result.status === 'rejected') return { status: 'rejected', reason: result.reason ?? 'rejected', sequence, replayed: result.replayed }
    if (result.status === 'ignored') {
      // The run is not active (its turn ended), so the Stop does not cascade. It still reaches the provider's
      // process, which may be running background work for the thread: only for a run of this thread, and only
      // when no newer run on it is active or queued (a Stop aimed at an old run must not end the process a
      // newer one is using).
      const stale = engine.getRun(runId)
      // A replay of that Stop already did this once; it does not do it again for what has started since.
      if (!result.replayed && stale?.threadId === target && !engine.listRuns(target).some((run) => !TERMINAL_RUN_STATUSES.has(run.status) && !this.isWaitingContinuation(run, engine))) await this.stopProviderWork(target)
      return {
        status: 'ignored',
        reason: result.reason ?? 'run_not_active',
        runId,
        activeRunId: engine.getActiveRun(target)?.runId ?? null,
        sequence,
        ...(result.replayed ? { replayed: true } : {})
      }
    }
    return { status: 'accepted', runId, sequence, replayed: result.replayed }
  }

  /**
   * The one Stop (issue #142): every public Stop (the protocol's `orchestrator.abort`, with or without
   * a `runId`, `abortRun`, the CLI, a channel's `/stop`, the remote hub, Lineage's Stop and Stop all,
   * `task_cancel`, deleting or settling a thread) comes here, and so does nothing else. An internal
   * abort (a steer that restarts the turn, a question that preempts it, a shutdown) stays local, on
   * `abortActiveTurn`, which this wraps and which never calls back.
   *
   * Everything the Stop cancels is decided in one run-store transaction before any await
   * (`RunEngine.stopSubtree`): the subtree of subagents, a higher stop generation for each thread in
   * it, its running delegations, queued runs, active runs and inbox rows. After that, by id: the
   * active runs are aborted locally (only those runs, so a message sent to a subagent after the
   * transaction survives), the queue entries of the subtree are removed, and the providers are told to
   * end what they still run for each thread, whether or not a turn is live. `ok` is true when
   * anything was running or waiting. A stale `runId` returns its outcome and does not cascade; a
   * repeated `clientRequestId` returns the first result.
   */
  async stopThread(
    threadId: string,
    reason: string,
    opts: { runId?: string; clientRequestId?: string; clearQueue?: boolean; requesterThreadId?: string; actor?: AgentActor } = {}
  ): Promise<StopThreadOutcome> {
    const engine = this.runEngine
    if (!engine) {
      // Without a run engine there is only the local turn and its queue.
      const turnAborted = this.abortActiveTurn(threadId, { clearQueue: opts.clearQueue })
      const channelAborted = this.abortChannelTurn(threadId)
      const aborted = turnAborted || channelAborted
      return { ok: aborted, status: 'stopped', replayed: false, threadId, threads: [threadId], activeRuns: [], cancelledRuns: [], delegations: [] }
    }
    const result = engine.stopSubtree({ threadId, reason, ...opts })
    if (result.status !== 'stopped') return { ok: false, ...result }
    // The Stop is recorded (every thread of the subtree has a higher generation): a pull request watch on any of them ends now.
    this.emit('threads-stopped', { threadIds: [...result.threads] })
    // A pause the Stop ended (the engine ends it in the same transaction): the thread no longer shows as paused,
    // and the continue message that waited for the reset is gone (`removeStoppedQueueEntries` for the replayed case).
    if (!result.replayed) {
      for (const run of result.cancelledRuns) {
        if (this.turnStates.get(run.threadId)?.phase === 'paused') this.pauseEndedWithoutTurn(run.threadId, 'Paused run stopped.')
      }
    }
    let aborted = false
    // A Stop closes the saved approval requests of every thread it covers, including the ones a restart
    // left for a run that no longer exists: nothing would answer them any more.
    if (!result.replayed) {
      for (const id of result.threads) {
        try {
          engine.approvals.cancelForThread(id, 'stopped')
          // And what was answered but not yet delivered, or granted but not yet used: nothing before a Stop may act after it.
          engine.approvals.retireDelivery(id)
          // A scheduled prompt that waited behind those approvals may run now.
          const waiting = this.sessions.get(id)
          if (waiting) this.scheduleQueueDrain(waiting)
        } catch (error) {
          console.warn('a Stop could not close approval requests', { threadId: id, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    if (result.replayed) {
      // The first Stop's interrupt may have ended without stopping the run (M4).
      for (const run of engine.reinterruptStopped(result)) aborted = this.interruptNow(run.runId, run.threadId) || aborted
    } else {
      for (const run of result.activeRuns) {
        aborted = this.abortActiveTurn(run.threadId, { runId: run.runId }) || aborted
        // The worker runs the interrupt effect `stopSubtree` queued; without one, the interrupt runs now.
        if (!this.effectsEnabled()) void this.interruptRun(run.runId, run.threadId)
      }
      // A live turn that is not an engine run (a legacy turn, a channel turn) is still the Stop's to end,
      // for the thread the Stop was aimed at; nothing can have started since the transaction.
      if (!result.activeRuns.some((run) => run.threadId === threadId)) aborted = this.abortActiveTurn(threadId) || aborted
      for (const id of result.threads) aborted = this.abortChannelTurn(id) || aborted
      this.removeStoppedQueueEntries(result, opts.clearQueue === true, opts.actor !== undefined)
    }
    // A replayed Stop reaches the provider only for threads that have no work newer than the Stop: a process
    // that a later run started (and its helpers) is not the one this Stop was for.
    const providerThreads = result.replayed ? result.threads.filter((id) => !this.hasWorkAfterStop(id, result.generations[id])) : result.threads
    const worked = await Promise.all(providerThreads.map((id) => this.stopProviderWork(id)))
    // A person's Stop reaches the threads the stopped ones launched while they run work an agent started: a creator
    // that is stopped leaves no fan-out running behind it (an agent's own Stop of a thread does not cascade).
    if (!result.replayed && !opts.actor) await this.stopLaunchedThreads(result.threads)
    const stoppedAnything = aborted || worked.some(Boolean) || result.activeRuns.length + result.cancelledRuns.length + result.delegations.length > 0
    return { ok: stoppedAnything, ...result }
  }

  /**
   * Stops the launched threads (`Thread.createdByThreadId`) of the threads a Stop covered whose live or queued work was
   * started by an agent's message: that work, and the agent messages queued behind it, end with the creator's Stop. A
   * launched thread a person has taken over (their own run is the latest work) is left alone.
   */
  private async stopLaunchedThreads(stoppedThreadIds: readonly string[]): Promise<void> {
    const engine = this.runEngine
    const store = this.threadStore
    if (!engine || !store) return
    try {
      const agentWork = new Set(engine.store.listNonTerminalRuns().filter((run) => run.outcome?.sentByAgent === true).map((run) => run.threadId))
      if (agentWork.size === 0) return
      const creators = new Set(stoppedThreadIds)
      const launched = store.listAllThreads().filter((thread) => thread.createdByThreadId !== undefined && creators.has(thread.createdByThreadId) && agentWork.has(thread.id))
      for (const thread of launched) await this.stopThread(thread.id, 'launcher_stopped')
    } catch (error) {
      console.warn('threads launched by a stopped thread could not be stopped', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Whether the thread has work the replayed Stop did not cover: a run admitted at or after the generation
   * the Stop raised it to (any status; its process may still hold helpers), or any run that is still not
   * terminal (the original Stop already ended its provider work once, and the stale-run Stop uses the same
   * guard). Any turn still in this process counts, whether or not it is an engine run: a channel turn, and
   * also one the first Stop aborted that is still unwinding. That last case is safe, since the first Stop
   * already reached the provider. An unknown generation counts as newer work, so nothing is closed on a guess.
   */
  private hasWorkAfterStop(threadId: string, generation: number | undefined): boolean {
    const engine = this.runEngine
    if (!engine || generation === undefined) return true
    if (this.hasLocalTurn(threadId)) return true
    return engine.listRuns(threadId, { limit: 200 }).some((run) => !TERMINAL_RUN_STATUSES.has(run.status) || runStopGeneration(engine.store, run.runId) >= generation)
  }

  /**
   * A continuation run that Claude's own turn waits on and that nothing has started: queued, with its
   * turn.start effect still pending (or none). Such a run is the process's turn, not newer work. One whose
   * effect is claimed is inside the turn already, and counts as live work.
   */
  private isWaitingContinuation(run: RunRecord, engine: RunEngine): boolean {
    return run.status === 'queued' && run.source === 'provider-continuation' && engine.outbox.listForRun(run.runId).every((effect) => effect.kind !== 'turn.start' || effect.status === 'pending')
  }

  /** A replayed Stop's interrupt, now: through the worker when there is one, else directly. True when a live turn was aborted. */
  private interruptNow(runId: string, threadId: string): boolean {
    const aborted = this.abortActiveTurn(threadId, { runId })
    if (!this.effectsEnabled()) void this.interruptRun(runId, threadId)
    return aborted
  }

  /**
   * After a Stop's transaction: the queue entries that belong to the work it stopped leave the
   * durable queues of the subtree, under each thread's queue lock and after the generation was
   * raised. In a subagent everything queued goes; in the thread the Stop was aimed at only what
   * delivers a subagent's result (a steer that missed its turn, whose notice rows the Stop
   * acknowledged) and the entries of runs it cancelled; what a person queued there stays unless
   * `clearQueue` (as a Stop always did).
   */
  private removeStoppedQueueEntries(result: StopResult, clearQueue: boolean, byAgent = false): void {
    const cancelled = new Set(result.cancelledRuns.map((run) => run.runId))
    for (const id of result.threads) {
      const isRoot = id === result.threadId
      const generation = this.runEngine ? currentStopGeneration(this.runEngine.store, id) : 0
      // What a Stop removes: entries of the runs it cancelled, notices that missed their turn, work started on
      // behalf of a parent before the Stop (a stale `stopGeneration`), and, below the thread it was aimed at,
      // run-less entries of work started on behalf of a parent. A message a person queued stays, at any level, unless asked to clear.
      // A message another thread's agent sent goes too when a person stops the thread, so a runaway exchange ends
      // with the Stop instead of starting its next queued turn; an agent's own Stop clears nothing of the kind.
      const removable = (item: QueuedMessage): boolean => {
        if (item.state === 'claimed') return false
        if (!byAgent && item.origin?.kind === 'agent') return true
        if (item.runId && cancelled.has(item.runId)) return true
        if (item.inboxIds?.length) return true
        if (isFencedSource(item.source) && (item.stopGeneration === undefined || item.stopGeneration < generation)) return true
        if (!isRoot && !item.runId && isFencedSource(item.source)) return true
        return clearQueue && !item.internal
      }
      try {
        this.mutateQueue(id, (items) => {
          const gone = items.filter(removable)
          if (gone.length === 0) return items
          // Their rows were acknowledged by the Stop; any a Stop did not reach go back to pending.
          this.releaseQueuedRows(gone)
          for (const item of gone) if (item.workflowInvocationId) this.workflowChat?.abandon(item.workflowInvocationId, id)
          this.cancelQueuedRuns(gone.map((item) => item.runId))
          return items.filter((item) => !gone.includes(item))
        })
      } catch (error) {
        console.warn('a stopped thread\'s queue could not be cleared', { threadId: id, error: error instanceof Error ? error.message : String(error) })
      }
      // A queued follow-up that left held the thread's tasks (`hasUnreadSteers`).
      this.reevaluateHold(id)
    }
  }

  /** A claimed entry the Stop fence refuses: the notice rows it carried are acknowledged, its claim completes and its run ends. */
  private refuseFencedQueueItem(session: ThreadSession, item: QueuedMessage, claimToken: string | undefined): void {
    const engine = this.runEngine
    try {
      if (engine && item.inboxIds?.length) {
        const own = engine.inbox.getMany(item.inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === queueOwner(item.id))
        engine.store.db.transaction(() => engine.inbox.markAcknowledged(own.map((row) => row.inboxId)))
      }
    } catch (error) {
      console.warn('fenced queue entry rows could not be acknowledged', { itemId: item.id, error: error instanceof Error ? error.message : String(error) })
    }
    this.completeSessionClaim(session, item.id, claimToken)
    this.cancelQueuedRuns([item.runId])
  }

  /** Rewrites a thread's queue (durable under its lock when there is a store) and tells listeners when it changed. */
  private mutateQueue(threadId: string, mutate: (items: QueuedMessage[]) => QueuedMessage[]): void {
    const loaded = threadId === this.boundSession.threadId ? this.boundSession : this.sessions.get(threadId)
    let before = 0
    let after: QueuedMessage[]
    if (this.threadStore) {
      after = mutateDurableQueue(this.threadStore, threadId, (items) => {
        before = items.length
        return mutate(items)
      })
    } else {
      if (!loaded) return
      before = loaded.queue.length
      after = mutate(loaded.queue)
    }
    if (after.length === before) return
    if (loaded) loaded.queue = after
    this.emitQueueUpdated(threadId, after)
  }

  /**
   * SPEC §13.3 Stop by `CommandPolicy.stopStrategy`: `interrupt` aborts the live turn and asks the
   * adapter to interrupt its session; `settle_locally` (a provider that cannot be interrupted)
   * aborts the live turn only. When nothing was live — no in-process turn to abort and the adapter
   * reports `not_active` — the run is settled here, `interrupted` by the user, instead of waiting
   * for reconciler rule 3. The strategy is recorded on the run outcome.
   */
  private async interruptRun(runId: string, threadId: string): Promise<void> {
    const engine = this.runEngine
    const run = engine?.getRun(runId) ?? null
    if (run && TERMINAL_RUN_STATUSES.has(run.status)) return
    // A paused run has no turn to interrupt: the Stop ends its pause (and its timer).
    if (engine && run?.status === 'paused') {
      try {
        engine.endPause(runId, 'stop')
        this.pauseEndedWithoutTurn(threadId, 'Paused run stopped.')
      } catch (error) {
        console.warn('a paused run could not be stopped', { runId, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    const caps = this.capabilitiesForThread(threadId)
    const strategy = caps ? stopStrategy(caps, run) : run ? 'interrupt' : 'noop'
    // Only this run's turn: a later turn of the thread (a message sent after the Stop) is not its to abort.
    const abortedLocally = this.abortActiveTurn(threadId, { runId })
    if (strategy === 'noop' || !engine || !run) return
    // A turn of this process (live, admitted or unwinding) writes the run's terminal state itself.
    let live = abortedLocally || this.hasLocalTurn(threadId)
    if (strategy === 'interrupt') {
      const attempt = run.activeAttemptId ? engine.store.getAttempt(run.activeAttemptId) : null
      const stored = attempt?.providerRef ?? null
      // The attempt's binding names the instance that owns the session.
      const ref = stored && attempt?.executionBinding ? { ...stored, instanceId: attempt.executionBinding.instanceId } : stored
      if (ref) {
        try {
          // A session already running on an instance can still be stopped after it was disabled.
          // A ref of a turn that ran on the unselected default names the bare pi driver.
          if ((await this.harness.interrupt(ref)) === 'interrupted') live = true
        } catch (error) {
          console.warn('adapter interrupt failed', { runId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    if (live) return
    console.warn('stop settled locally: nothing live for the run', { runId, strategy })
    this.markRun(runId, (runs, id) => {
      const current = runs.getRun(id)
      if (current && !TERMINAL_RUN_STATUSES.has(current.status))
        runs.markTerminal(id, 'interrupted', { interruptedBy: 'user', stopStrategy: strategy })
    })
  }

  /**
   * Stop reaches the provider's process for the thread (`HarnessGateway.stopThread`): what it still
   * runs in the background ends, whether or not a turn is live, and a command still running after the
   * Stop's interrupt is killed. True when there was a process to end. What could not be ended is said
   * in the thread, so it never looks stopped while something still runs. Never throws.
   */
  async stopProviderWork(threadId: string): Promise<boolean> {
    try {
      return (await this.harness.stopThread(threadId)) === 'stopped'
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn('provider stop failed', { threadId, error: message })
      this.noteProviderNotice(threadId, `Stop could not end everything this chat started. ${message}`)
      return false
    }
  }

  /** Steer a specific run. Only the thread's active run receives the text; anything else is ignored. */
  async steerRun(runId: string, text: string, clientRequestId: string, threadId?: string, actor?: AgentActor, ceiling?: PermissionMode, deviceLimit?: PermissionMode, sentFrom?: { node: string }): Promise<CommandResult> {
    const engine = this.requireRunEngine()
    const target = threadId ?? engine.getRun(runId)?.threadId
    if (!target) return { status: 'ignored', reason: 'run_not_found', runId, sequence: 0 }
    this.assertNotBotThread(target)
    const result = await engine.dispatch({ kind: 'steer', threadId: target, clientRequestId, runId, ...(actor ? { actor, textLength: text.length, ceiling: ceiling ?? 'ask' } : {}) })
    if (result.status === 'accepted' && !result.replayed) {
      // An agent's steer says so in the transcript row it leaves, and keeps the sender's mode, wherever it ends
      // up: read by the live turn, or (it missed its turn, or was never read) run as a turn of its own.
      const origin = actor ? agentOriginOf(actor) : undefined
      // A person on another computer carries that computer's limit with the text, wherever it ends up.
      const limit = actor ? ceiling ?? 'ask' : deviceLimit
      this.enqueueControlEffect('turn.steer', target, runId, { runId, threadId: target, text, ...(origin ? { origin, permissionMode: limit } : deviceLimit ? { deviceLimit } : {}), ...(sentFrom && !origin ? { sentFrom } : {}) }, () => {
        if (!this.steerThread(target, text, undefined, undefined, origin, limit, undefined, origin ? undefined : sentFrom)) {
          console.warn('run engine steer accepted but the legacy turn did not take it', { runId })
        }
      })
    }
    return result
  }

  /**
   * Phase 2b (SPEC §12.2-§12.3): with a worker attached, turns, interrupts and steers run as
   * durable effects. The profile attaches the worker after boot recovery and detaches it on stop.
   */
  attachEffectWorker(worker: EffectWorker | null): void {
    this.effectWorker = worker
    this.attachInFlightCanceller()
    // Answers committed before the previous process died continue their threads once turns can run.
    if (worker) setImmediate(() => { if (this.effectWorker === worker) this.resumeUndeliveredApprovals() })
  }

  /** C2: the engine aborts a claimed `turn.start` (a cancelled child still provisioning) through the worker. */
  private attachInFlightCanceller(): void {
    const worker = this.effectWorker
    this.runEngine?.setInFlightCanceller(worker ? (effectId) => worker.cancelInFlight(effectId) : null)
  }

  private effectsEnabled(): boolean {
    return Boolean(this.runEngine && this.effectWorker)
  }

  /**
   * Phase 5 (SPEC §15.2): the profile's Mousse MCP server. The harness gateway gives each turn of an
   * MCP-capable instance a bearer under the driver's turn binding (PR 2 §2 `TurnBridge`); deleting
   * the thread or switching its instance revokes it.
   */
  setMcpAttachment(provider: McpAttachmentProvider | null): void {
    this.mcpAttachment = provider
    this.harness.setMcpAttachment(provider)
  }

  /**
   * The credential ceiling of a run on `threadId`: `plan` for a plan-mode turn, and never above the
   * ceiling its delegations gave it (a delegated child inherits its parent's). A subagent's own
   * policy is that of its first task: a later follow-up may narrow it, never widen it.
   */
  private modeCeilingFor(threadId: string, mode: ChatMode): ModeCeiling {
    if (mode === 'plan') return 'plan'
    try {
      const tasks = this.runEngine?.delegations.listForChildThread(threadId) ?? []
      return narrowCeiling(tasks.at(0)?.modeCeiling, tasks.at(-1)?.modeCeiling) === 'plan' ? 'plan' : 'default'
    } catch {
      return 'plan'
    }
  }

  /**
   * The agent access level granted to a run on `threadId` (SPEC §15.1), decided at turn start: the
   * profile's level now, never above what its delegations gave it (the first and the last, as for the
   * ceiling: a follow-up may narrow, never widen), and at most `read` under a `plan` ceiling. What a
   * thread keeps whatever the profile says is `staticAccessCeiling`. Any failure to decide is `lineage`,
   * as `modeCeilingFor` fails to `plan`.
   */
  private grantFor(threadId: string, ceiling: ModeCeiling): AgentAccessLevel {
    try {
      return narrowAgentAccess(this.agentAccessSettings().level, this.staticAccessCeiling(threadId), ceiling === 'plan' ? 'read' : undefined) ?? 'lineage'
    } catch {
      return 'lineage'
    }
  }

  /**
   * The most an agent in `threadId` may be granted whatever the profile says (SPEC §15.1), or undefined
   * when the thread has no limit of its own (a person's thread). It only narrows: the narrowest of
   * - a bot thread: `lineage` (its turns act for a person outside Mousse, who must not reach the owner's
   *   other threads through the setting; takes effect once the bot engine registers its threads);
   * - a read-only subagent: `read`;
   * - the thread's stored ceiling (`Thread.accessCeiling`: a fork's, and a channel thread's);
   * - every delegation that gave the thread work, not just the first and the latest, so a follow-up
   *   never restores a level an earlier one narrowed (a row from before levels existed is `lineage`);
   * - `lineage` for a fork or subagent that has no trustworthy grant (no stored ceiling, no delegation).
   * Throws when it cannot be read; callers treat that as `lineage`.
   */
  private staticAccessCeiling(threadId: string): AgentAccessLevel | undefined {
    if (this.botThreads?.roleOf(threadId)) return 'lineage'
    const stored = this.threadStore?.getThread(threadId)?.accessCeiling
    const tasks = this.runEngine?.delegations.listForChildThread(threadId) ?? []
    const lineage = this.runEngine?.delegations.getLineage(threadId)
    return narrowAgentAccess(
      this.isReadOnlyChild(threadId) ? 'read' : undefined,
      stored === undefined ? undefined : isAgentAccessLevel(stored) ? stored : 'lineage',
      narrowestAccess(tasks),
      lineage && !tasks.length && stored === undefined ? 'lineage' : undefined
    )
  }

  /**
   * A run that continues another (the resume after a usage-limit pause, whether the timer or a person
   * made it, a "Continue" after a restart, or a turn a provider started itself) is never granted more
   * than the run it continues, whatever the setting says now. The earlier run's grant is the one recorded
   * when its turn started (`RunRecord.accessGrant`); one that was never recorded, or a continuation whose original cannot be read,
   * is `lineage`.
   */
  private continuedGrant(runId: string, threadId: string, grant: AgentAccessLevel): AgentAccessLevel {
    try {
      const engine = this.runEngine
      const run = engine?.getRun(runId)
      if (!engine || !run) return grant
      let earlier: RunRecord | null | undefined
      if (run.outcome?.continuationOf) {
        earlier = engine.getRun(run.outcome.continuationOf)
        if (!earlier) return 'lineage'
      } else if (run.source === 'provider-continuation') {
        earlier = engine.listRuns(threadId).filter((candidate) => candidate.ordinal < run.ordinal).sort((a, b) => b.ordinal - a.ordinal)[0]
      }
      if (!earlier) return grant
      const held = earlier.accessGrant
      return narrowAgentAccess(grant, isAgentAccessLevel(held) ? held : 'lineage') ?? 'lineage'
    } catch {
      return 'lineage'
    }
  }

  /** The access level a scheduled job's runs are capped at: its creator's, `lineage` when that is not known. */
  private scheduledAccessCap(cap: AgentAccessLevel | undefined): AgentAccessLevel {
    return isAgentAccessLevel(cap) ? cap : 'lineage'
  }

  /**
   * What a job created or changed by an agent's run may be granted: the access level the run holds (its grant narrowed by
   * the profile's setting now) and the permission mode it is bound to. A run that is not a person's turn (a channel,
   * a bot, a scheduled run, a workflow or a definition) gets the narrowest of both, and so does any run whose
   * origin cannot be read, so a job made by an unattended agent is never wider than that agent was.
   */
  private scheduledCreatorLimits(caller: { threadId: string; runId: string; accessLevel: AgentAccessLevel }): { accessCap: AgentAccessLevel; permissionCeiling: PermissionMode } {
    const person = this.runStartedByPerson(caller)
    return {
      accessCap: person ? this.effectiveAccess(caller.accessLevel) : 'lineage',
      permissionCeiling: person ? this.runPermissionMode(caller.runId) : 'ask'
    }
  }

  /**
   * Whether a person started the run: the run's source and its binding's origin say so (`startedByPerson`, the rule that
   * decides who a standing approval rule may answer). Fails closed on a missing run, a missing binding, a bot's thread
   * and anything that cannot be read.
   */
  private runStartedByPerson(caller: { threadId: string; runId: string }): boolean {
    try {
      if (this.botThreads?.roleOf(caller.threadId)) return false
      const engine = this.runEngine
      const run = engine?.getRun(caller.runId)
      const binding = engine?.bindingForRun(caller.runId)
      return Boolean(run && binding) && startedByPerson({ origin: policyOrigin(binding!.policy), source: run!.source })
    } catch {
      return false
    }
  }

  /**
   * A scheduled run is never granted more than the cap recorded on it when it was admitted (the job
   * creator's level), whatever the profile or its thread allow now. A scheduled run with none recorded
   * is `lineage`; any other run is returned as it is.
   */
  private scheduledGrant(runId: string, grant: AgentAccessLevel): AgentAccessLevel {
    try {
      const run = this.runEngine?.getRun(runId)
      if (run?.source !== 'schedule') return grant
      return narrowAgentAccess(grant, isAgentAccessLevel(run.accessGrant) ? run.accessGrant : 'lineage') ?? 'lineage'
    } catch {
      return 'lineage'
    }
  }

  /** The delegation tools of an in-process turn, holding the grant its registered turn was given at its start. */
  private turnDelegationTools(session: ThreadSession, runId: string, mode: ChatMode, granted: AgentAccessLevel | undefined): DelegationToolHost {
    const ceiling = this.modeCeilingFor(session.threadId, mode)
    return this.delegationTools(session, runId, ceiling, granted ?? 'lineage')
  }

  /** The caller's granted level narrowed by the profile's level now: what its tool calls and delegations may use. */
  private effectiveAccess(granted: AgentAccessLevel): AgentAccessLevel {
    try {
      // An absent or unknown grant is the most restrictive level, never the profile's.
      if (!isAgentAccessLevel(granted)) return 'lineage'
      return narrowAgentAccess(granted, this.agentAccessSettings().level) ?? 'lineage'
    } catch {
      return 'lineage'
    }
  }

  private agentAccessSettings() {
    return normalizeAgentAccessSettings(this.settingsStore.get().agentAccess)
  }

  /** Revokes the thread's Mousse MCP credentials (thread deleted, provider switched). */
  private revokeMcp(threadId: string): void {
    try {
      this.mcpAttachment?.revokeThread(threadId)
    } catch (error) {
      console.warn('Mousse MCP credentials could not be revoked', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Registers a run's app-tool context (PR 2 §2 "Turn context"). A turn the runtime started itself
   * keeps the token of the turn it continues: calls made across that hand-over were stamped with it.
   */
  private registerAppTurn(session: ThreadSession, runId: string, mode: ChatMode, continuation: boolean, bot?: PreparedBotTurn): { turn: AppToolTurn; drop(): void } {
    const projectPath = bot ? undefined : session.projectCwd ?? undefined
    const modeCeiling = this.modeCeilingFor(session.threadId, mode)
    // A bot is held to its grant, which never reaches other threads: it gets the narrowest access
    // level whatever the profile's setting, and nothing continues a bot run as a plain turn.
    const accessLevel: AgentAccessLevel = bot ? 'lineage' : this.scheduledGrant(runId, this.continuedGrant(runId, session.threadId, this.grantFor(session.threadId, modeCeiling)))
    // Kept on the run, so whatever continues it is never granted more than it was.
    try {
      this.runEngine?.recordAccessGrant(runId, accessLevel)
    } catch (error) {
      console.warn('The access grant of the run could not be recorded', { runId, error: error instanceof Error ? error.message : String(error) })
    }
    return this.appToolTurns.register({
      threadId: session.threadId,
      runId,
      mode,
      modeFacts: modeFactsFor(this.modeRegistry, mode, projectPath),
      modeCeiling,
      accessLevel,
      subagent: false,
      discovery: false,
      projectPath,
      actor: defaultIntegrationActor(false),
      enabledSkills: [],
      loadedSkills: [],
      ...(session.sharedWorkspace ? { toolAccess: createAgentToolAccess(SHARED_READER_POLICY, session.sharedWorkspace.path) } : {}),
      // A bot turn: every app-tool call is held to the bot's grant (the registry checks it).
      ...(bot ? { bot: bot.authority } : {}),
      settingsEnabled: (name) => settingsToolEnabled(this.settingsStore.get().integrations?.tools, name)
    }, { continuation })
  }

  /**
   * Completes a registered turn (its browser binding, applet staging and, for a runtime with its own
   * loop, the skills it loads) and returns what the gateway mints its bridge from: the session text
   * and the turn preamble, with the Mousse tools usable now when the server is attached.
   */
  private async completeAppTurn(
    registered: AppToolTurn,
    input: { browser?: AppToolTurn['browser']; onPublishApplet?: AppToolTurn['onPublishApplet']; userContent: string; instanceId: string; model: string; approvals: RunPolicy['approvals']; botInstructions?: string; grants?: EffectiveAgentGrants }
  ): Promise<TurnAppContext> {
    let skills: Pick<AppToolTurn, 'enabledSkills' | 'loadedSkills'> = { enabledSkills: [], loadedSkills: [] }
    try {
      skills = await prepareSkills({
        registry: this.skillsRegistry,
        settings: () => this.settingsStore.get().integrations.skills,
        projectPath: registered.projectPath,
        mode: registered.mode,
        userContent: input.userContent,
        actor: registered.actor,
        // A definition loads only the skills it was granted.
        ...(input.grants ? { grants: input.grants } : {})
      })
    } catch (error) {
      // Skills are optional: a broken registry cannot block the turn.
      console.warn('skills unavailable for the turn', { threadId: registered.threadId, error: error instanceof Error ? error.message : String(error) })
    }
    // The runtime runs the selected model natively: its vision decides whether a browser screenshot
    // can reach the model.
    const browser = input.browser
      ? snapshotBrowserExecutionBinding({ ...input.browser, vision: this.harness.catalog.toolImages(input.instanceId, input.model) })
      : undefined
    const turn = this.appToolTurns.update(registered.runId, {
      ...(browser ? { browser } : {}),
      ...(input.onPublishApplet ? { onPublishApplet: input.onPublishApplet } : {}),
      // A run nobody answers: Mousse tools that wait for the user are refused, on every transport.
      ...(input.approvals === 'never' ? { approvals: 'never' as const } : {}),
      // A bot lists and loads only the skills it was granted.
      ...(registered.bot ? grantedSkills(skills, registered.bot.skills) : skills)
    }) ?? registered
    const descriptor = typeof turn.mode === 'string' ? this.modeRegistry.getModeSync(turn.mode, { projectPath: turn.projectPath }) : undefined
    // Agent and Plan run natively in the runtime; another mode's own instructions go into the preamble.
    const modePrompt = descriptor && !['agent', 'plan', 'build'].includes(descriptor.id) ? descriptor.prompt : undefined
    const appletCatalogue = this.appletStore ? this.appletCatalogue() : undefined
    return {
      turnToken: turn.turnToken,
      modeCeiling: turn.modeCeiling,
      ...(turn.accessLevel ? { accessLevel: turn.accessLevel } : {}),
      mcpEligible: Boolean(this.runEngine),
      ...(turn.definition ? { definition: turn.definition } : {}),
      ...(turn.bot ? { bot: turn.bot } : {}),
      // A definition's turn runs on its own prompt and its granted skills only (`runDefinitionTurn`).
      instructions: (mcpAttached) => turn.definition ? { sessionInstructions: '', turnPreamble: '' } : ({
        sessionInstructions: sessionInstructions({ mcp: mcpAttached, appletGuidance: this.appletStore ? APPLET_GENERATION_GUIDANCE : undefined }),
        turnPreamble: withBotInstructions(input.botInstructions, turnPreamble({
          loadedSkills: turn.loadedSkills,
          modePrompt,
          appletCatalogue,
          usableTools: mcpAttached ? this.usableAppTools(this.appToolTurns.get(turn.runId) ?? turn) : undefined
        }))
      })
    }
  }

  /** The Mousse tools a thread's credential lists that the turn may use now. */
  private usableAppTools(turn: AppToolTurn): string[] {
    return this.mcpToolRegistry()
      .listForThread(turn.threadId, 'default', turn.accessLevel)
      // A Plan turn cannot start threads; everything else listed is usable when available now.
      .filter((tool) => !(turn.modeCeiling === 'plan' && tool.access === 'startsThreads'))
      .filter((tool) => (tool.available?.(turn) ?? true) === true)
      // A run nobody answers does not offer the tools that wait for the user (they are refused if called).
      .filter((tool) => !unattendedRefusal(tool, turn))
      // A screenshot is refused when it cannot reach the model; the preamble does not offer it.
      .filter((tool) => !(tool.name === 'browser_screenshot' && turn.browser && !turn.browser.vision))
      .map((tool) => tool.name)
  }

  /**
   * The app-tool registry the Mousse MCP server serves (PR 2 §2): the same modules the pi loop runs,
   * over this thread owner, with the run engine's thread tools and the turns registered here.
   */
  mcpToolRegistry(): ToolRegistry {
    this.mcpRegistry ??= createAppToolRegistry({
      host: this.mcpToolHost(),
      engine: this.requireRunEngine(),
      turns: this.appToolTurns,
      // The user's own MCP servers, proxied for Pi's agent (`userMcp: 'proxy'`).
      ...(this.mcpManager ? { options: { userMcp: userMcpProxy(this.mcpManager) } } : {})
    }).registry
    return this.mcpRegistry
  }

  /**
   * What the Mousse MCP server's tools need from the thread owner (SPEC §15.1). Every call acts as
   * the credential's caller: its thread's session, run and mode ceiling.
   */
  mcpToolHost(): AppToolHost {
    return {
      delegation: (caller: McpCaller) =>
        this.delegationTools(this.getOrCreateSession(caller.threadId), caller.runId, caller.modeCeiling, caller.accessLevel),
      askUser: (threadId, questions, options) => this.questions.requestAnswers(questions, threadId, options),
      dismissQuestions: (threadId) => this.questions.dismissAllForThread(threadId),
      presentPlan: (threadId, payload) => {
        if (!threadId) return
        const session = this.getOrCreateSession(threadId)
        this.sessionAls.run(session, () => this.presentPlanCard(payload, threadId))
      },
      tasks: (threadId) => (threadId ? this.getTasksForThread(threadId) : null),
      queueSnapshot: (threadId) => this.queueSnapshot(threadId),
      queueCommand: (threadId, command, options) => this.queueCommandAsAgent(threadId, command, options),
      browserRuntime: () => this.browserRuntime,
      skills: () => this.skillsRegistry,
      quickActions: new QuickActionTools(questionApproval(this.questions), (action) => this.emit('quick-action-created', action)),
      web: new WebTools(this.providerAuth.credentials),
      devGui: new DevGuiTools(),
      // The git app tools read the project through their own scoped Git read (`git/scopedRead`).
      projectGit: true,
      toolLedger: (runId) => this.toolLedgerFor(runId),
      readOnlyThread: (threadId) => this.isReadOnlyChild(threadId),
      // The ceiling the thread's delegations gave it: a Plan turn narrows only its own calls.
      threadCeiling: (threadId) => this.modeCeilingFor(threadId, 'agent'),
      // Only a bot's threads list the bot tools (`escalate`; `consult` on its activation thread).
      botRole: (threadId) => this.botThreads?.roleOf(threadId),
      awaitLiveRun: (threadId) => this.continuationGate(threadId),
      permissionModeFor: (runId) => this.runPermissionMode(runId),
      askApproval: (threadId, questions, options) => this.questions.requestAnswers(questions, threadId, options),
      agentAccess: () => this.agentAccessSettings(),
      threadMeta: (threadId) => this.threadStore?.getThread(threadId),
      listThreads: () => this.threadStore?.listAllThreads() ?? [],
      listProjects: () => (this.threadStore?.listProjects() ?? []).map(({ id, name }) => ({ id, name })),
      searchThreads: (query, limit, options) => this.threadStore?.searchThreads(query, limit, { hideSubagents: true, ...options }) ?? [],
      threadMessages: (threadId) => this.visibleMessagesWithoutLoading(threadId),
      threadActivity: (threadId) => this.threadActivity(threadId),
      recordAgentAction: (target, actor, action, details) => this.recordAgentAction(target, actor, action, details),
      showAgentAction: (target, actor, summary) => this.showAgentAction(target.threadId, actor, summary),
      sendToThread: (threadId, input, options) => this.sendToThreadAsAgent(threadId, input, options),
      earlierSend: (threadId, clientRequestId) => this.earlierAgentSend(threadId, clientRequestId),
      createThread: (input, options) => this.createThreadAsAgent(input, options),
      creationStarted: (clientRequestId) => this.agentCreationStarted(clientRequestId),
      noteOnThread: (threadId, text) => this.noteAgentLaunch(threadId, text),
      stopRun: (threadId, runId, options) => this.stopRunAsAgent(threadId, runId, options),
      steerRun: (threadId, runId, text, options) => this.steerRunAsAgent(threadId, runId, text, options),
      approvalRequest: (requestId) => this.approvalRequestInfo(requestId),
      answerApproval: (threadId, requestId, answers, options) => this.answerApprovalAsAgent(threadId, requestId, answers, options),
      ...(this.scheduledJobs ? { schedules: { ...this.scheduledJobs, limits: (caller) => this.scheduledCreatorLimits(caller), startedByPerson: (caller) => this.runStartedByPerson(caller) } } : {})
    }
  }

  /** A request in any state, for `approval_respond` to check before it answers. */
  private approvalRequestInfo(requestId: string): ApprovalRequestInfo | undefined {
    const view = this.questions.getRequest(requestId)
    if (!view) return undefined
    return { requestId, threadId: view.threadId, status: view.status, approval: view.approval !== undefined, questions: view.questions }
  }

  /**
   * `approval_respond`: an agent answers an approval of another thread (SPEC §17). It goes through the settlement every
   * client uses, so the rule `canAnswerApproval` decides (the agent's own permission mode bounds what it may approve,
   * "always" and its own thread are refused, a thread of its own lineage is only its direct subagents'), one answer wins
   * and the loser is told who did. What the profile allows is read here, at the moment of the answer: the agent's
   * granted level narrowed by the setting and by the thread's own cap, the switch for answering approvals, and the
   * project list, so lowering any of them applies to a turn that is already running.
   *
   * The command key is saved as a receipt before the answer. A retry names the same request; the same key for another
   * request is a conflict. A retry that finds its own answer (same thread and tool call) is `replayed`, never a loss.
   */
  private answerApprovalAsAgent(
    threadId: string,
    requestId: string,
    answers: UserQuestionAnswers,
    options: { clientRequestId: string; actor: AgentActor; accessLevel: AgentAccessLevel }
  ): AgentApprovalResult {
    const engine = this.requireRunEngine()
    const request = this.questions.getRequest(requestId)
    if (!request || request.threadId !== threadId) return { ok: false, reason: 'unknown' }
    const { actor } = options
    const key = options.clientRequestId
    const earlier = engine.store.getReceipt(key)
    if (earlier) {
      const named = (earlier.result as { requestId?: unknown } | null)?.requestId
      if (earlier.commandKind !== 'approval_respond' || named !== requestId) return { ok: false, reason: 'client_request_id_conflict' }
    } else {
      // Filed under the caller's thread and run, as its key says (`approval_respond:<caller thread>:<call>`), like the
      // other receipts of a command a thread's run issued; the approval it names is in `result`.
      engine.store.putReceipt({ clientRequestId: key, threadId: actor.threadId, commandKind: 'approval_respond', status: 'accepted', result: { requestId, threadId, runId: actor.runId }, createdAt: new Date().toISOString() })
    }
    // A turn a person started is the person's to answer: they may be reading the card. A request that is already
    // answered or closed is settled below so the loser learns who won.
    const asking = engine.approvals.get(requestId)
    if (asking?.status === 'pending' && this.askedInPersonTurn(asking.runId)) return { ok: false, reason: 'person_turn' }
    let level: AgentAccessLevel
    try {
      // The most the thread may have whatever the profile says (a bot or channel thread is lineage) narrows what the credential was granted.
      level = narrowAgentAccess(this.effectiveAccess(options.accessLevel), this.staticAccessCeiling(actor.threadId)) ?? 'lineage'
    } catch {
      level = 'lineage'
    }
    const answerer: Answerer = {
      kind: 'agent',
      threadId: actor.threadId,
      runId: actor.runId,
      toolCallId: actor.toolCallId,
      // The mode of the run, and of its thread now when that is stricter: a tighter mode applies to the next turn, but an
      // answer for another thread acts like a rule and stops at once, as a rule does.
      permissionMode: this.answeringMode(actor),
      access: {
        level,
        answerApprovals: this.agentAccessSettings().answerApprovals,
        projectAllowed: (id) => {
          const projectIds = this.agentAccessSettings().projectIds
          if (projectIds.length === 0) return true
          const projectId = this.threadStore?.getThread(id)?.projectId
          return projectId !== undefined && projectIds.includes(projectId)
        }
      }
    }
    const settled = this.questions.settle(requestId, answers, answerer)
    if (settled.ok) {
      this.showApprovalAnswer(threadId, actor, settled.decision ?? 'reject', requestId, answers)
      return { ok: true, decision: settled.decision ?? 'reject', replayed: false }
    }
    switch (settled.reason) {
      case 'already_answered': {
        const by = settled.answeredBy
        // The same call, retried: this agent's own answer, found again (the thread and the call id together, since
        // the call id of a retry carries no caller).
        if (by?.kind === 'agent' && by.threadId === actor.threadId && by.toolCallId === actor.toolCallId && settled.decision)
          return { ok: true, decision: settled.decision, replayed: true }
        return { ok: false, reason: 'already_answered', ...(by ? { answeredBy: by } : {}), ...(settled.decision ? { decision: settled.decision } : {}) }
      }
      case 'cancelled':
        return { ok: false, reason: 'cancelled', ...(settled.cancelReason ? { cancelReason: settled.cancelReason } : {}) }
      case 'unknown':
      case 'answerer_required':
        return { ok: false, reason: 'unknown' }
      default:
        return { ok: false, reason: settled.reason }
    }
  }

  /** The mode an answering agent is held to: its run's, narrowed by its thread's own mode now; `ask` when that cannot be read. */
  private answeringMode(actor: AgentActor): PermissionMode {
    try {
      return narrowPermissionMode(this.runPermissionMode(actor.runId), this.requestedPermissionMode(actor.threadId))
    } catch {
      return 'ask'
    }
  }

  /**
   * Whether a person started the run that asked (`startedByPerson`): a request with no run to name is not. An unreadable
   * run counts as a person's, so a failure refuses rather than allows.
   */
  private askedInPersonTurn(runId: string | null): boolean {
    if (!runId) return false
    try {
      const engine = this.requireRunEngine()
      const run = engine.getRun(runId)
      if (!run) return false
      const binding = engine.bindingForRun(runId)
      return startedByPerson({ origin: binding ? policyOrigin(binding.policy) : 'interactive', source: run.source })
    } catch {
      return true
    }
  }

  /**
   * The transcript row of an agent's answer, shown only for the call that won it. It is no message from the user:
   * the person reads who decided, in which thread, and what about. The `approval.answered` event (with the agent's
   * thread, run and call) is the record.
   */
  private showApprovalAnswer(threadId: string, actor: AgentActor, decision: 'allow' | 'reject', requestId: string, answers: UserQuestionAnswers): void {
    try {
      const record = this.requireRunEngine().approvals.get(requestId)
      // What was approved, as the card showed it (the command or the path): redacted, on one line and capped.
      const asked = record ? describeApproval(record) : ''
      const note = record && decision === 'reject' ? agentNoteOf(record.questions, answers) : ''
      const session = this.getOrCreateSession(threadId)
      this.sessionAls.run(session, () => this.addSystemMessage(
        `${decision === 'allow' ? 'Approved' : 'Rejected'} by an agent in thread «${this.titleOf(actor.threadId) ?? actor.threadId}» (${actor.threadId})${asked ? `: ${asked}` : ''}${note ? ` Its note: "${note}"` : ''}`
      ))
    } catch (error) {
      console.warn('the transcript row of an agent\'s approval answer could not be written', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * `thread_send`: another thread's agent writes to this one (SPEC §15.1). The message is labelled as the
   * agent's in what the model reads and in the stored message, runs under the caller's permission mode when
   * that is stricter than the thread's own (`narrowPermissionMode` at the turn, so it can only tighten, and a
   * queued message keeps the mode through a restart), queues behind a running turn, and is never a steer. A
   * thread waiting on a question or approval, or paused, refuses it. The `agent.action` event is written by the
   * engine with the run, in the same transaction.
   */
  private async sendToThreadAsAgent(
    threadId: string,
    input: { content: string; mode: 'agent' | 'plan' },
    options: { clientRequestId: string; actor: AgentActor }
  ): Promise<AgentSendResult> {
    const engine = this.requireRunEngine()
    const sender = this.withAgentHops(options.actor)
    this.assertQueueOpen(threadId)
    // A thread a person keeps in Plan takes the message as a plan turn, whatever mode the sender asked for.
    const mode: 'agent' | 'plan' = this.lastChatModeOf(threadId) === 'plan' ? 'plan' : input.mode
    const response = await this.send(
      { content: agentMessageText(sender.threadId, this.titleOf(sender.threadId), input.content), mode },
      false,
      {
        threadId,
        source: 'mcp',
        clientRequestId: options.clientRequestId,
        awaitMode: 'ack',
        agent: sender,
        permissionMode: this.runPermissionMode(sender.runId),
        preemptQuestions: false,
        refuseWhileAsking: true
      }
    )
    if (!response.runId || response.sequence === undefined) throw new Error('The message was not recorded as a run.')
    const replayed = response.replayed === true
    return {
      runId: response.runId,
      sequence: response.sequence,
      queued: response.queued === true || (replayed && engine.getRun(response.runId)?.status === 'queued'),
      replayed,
      mode
    }
  }

  /** The chat mode of the thread's latest message from a person, from its stored transcript. */
  private lastChatModeOf(threadId: string): ChatMode | undefined {
    try {
      return getLastUserChatMode(this.visibleMessagesWithoutLoading(threadId))
    } catch {
      return undefined
    }
  }

  /**
   * The sender with the count of agent messages in a row that led to this one: its own run's count (0 for a run a
   * person started) plus one. Past `AGENT_MESSAGE_MAX_HOPS` the message is refused, so a chain of agents
   * answering each other stops by itself and needs a person to go on.
   */
  private withAgentHops(actor: AgentActor): AgentActor {
    const hops = (this.requireRunEngine().getRun(actor.runId)?.outcome?.agentHops ?? 0) + 1
    if (hops > AGENT_MESSAGE_MAX_HOPS)
      throw new DomainRpcError('agent_hops_exceeded', `This message would be agent message number ${hops} in a row without a person in between; the limit is ${AGENT_MESSAGE_MAX_HOPS}. Wait for a person to reply before going on.`)
    return { ...actor, hops }
  }

  /**
   * The first result of a send this key already made, for a retry the caller's budget would refuse: found from the
   * receipt, with nothing admitted. Undefined when the key made no send to this thread.
   */
  private earlierAgentSend(threadId: string, clientRequestId: string): AgentSendResult | undefined {
    const engine = this.requireRunEngine()
    const receipt = engine.store.getReceipt(clientRequestId)
    if (!receipt || receipt.threadId !== threadId || receipt.commandKind !== 'send' || receipt.status !== 'accepted') return undefined
    const result = receipt.result as { runId?: unknown; sequence?: unknown } | null
    if (typeof result?.runId !== 'string' || typeof result.sequence !== 'number') return undefined
    return { runId: result.runId, sequence: result.sequence, queued: engine.getRun(result.runId)?.status === 'queued', replayed: true }
  }

  /**
   * `thread_create`: an agent starts a thread (SPEC §15.1). Decided first, made second: the whole launch (id,
   * project, title, workspace, model, mode, level, first message) is validated and written to the command's
   * receipt before any file exists, and every later step, in this call, in a retry or after a restart, is
   * made from that stored intent. The thread is complete once its `agent.action` event exists; a retry
   * finishes a thread a crash left half made (discarding what was made, which no one has used) or returns the
   * complete one. Two calls with one key make one thread.
   */
  private createThreadAsAgent(
    input: AgentThreadRequest,
    options: { clientRequestId: string; actor: AgentActor; accessLevel: AgentAccessLevel }
  ): Promise<AgentCreatedThread> {
    const key = options.clientRequestId
    const fingerprint = agentThreadFingerprint(input)
    const running = this.agentCreations.get(key)
    if (running) {
      if (running.fingerprint !== fingerprint) return Promise.reject(this.creationKeyConflict(key))
      // The second of two calls with one key made nothing: it is told it is a replay.
      return running.task.then((made) => ({ ...made, replayed: true }))
    }
    const entry = { fingerprint, task: undefined as unknown as Promise<AgentCreatedThread> }
    entry.task = this.createThreadAsAgentOnce(input, fingerprint, options).finally(() => this.agentCreations.delete(key))
    this.agentCreations.set(key, entry)
    return entry.task
  }

  private creationKeyConflict(key: string): McpToolError {
    return new McpToolError('mousse_conflict', `clientRequestId ${key} was already used for a different thread_create call; use a new one for a different thread.`, { conflict: 'client_request_id_conflict' })
  }

  private async createThreadAsAgentOnce(
    input: AgentThreadRequest,
    fingerprint: string,
    options: { clientRequestId: string; actor: AgentActor; accessLevel: AgentAccessLevel }
  ): Promise<AgentCreatedThread> {
    const engine = this.requireRunEngine()
    if (!this.threadStore || !this.projectManager) throw new Error('Creating threads needs the thread store and the project manager.')
    // A bot's thread acts for a person outside Mousse and starts no threads.
    if (this.botThreads?.roleOf(options.actor.threadId)) throw new McpToolError('mousse_scope_denied', 'A thread that belongs to a bot cannot create threads.')
    const key = options.clientRequestId
    const stored = engine.store.getReceipt(key)
    let intent: AgentThreadIntent
    if (stored) {
      const earlier = readAgentThreadReceipt(stored)
      if (!earlier || stored.threadId !== options.actor.threadId || earlier.fingerprint !== fingerprint) throw this.creationKeyConflict(key)
      intent = earlier.intent
    } else {
      // Everything that can refuse does so here, before anything is recorded or made.
      intent = this.planAgentThread(input, options)
      engine.store.putReceipt({
        clientRequestId: key,
        threadId: options.actor.threadId,
        commandKind: AGENT_THREAD_COMMAND,
        status: 'accepted',
        result: { threadId: intent.threadId, fingerprint, intent },
        createdAt: new Date().toISOString()
      })
    }
    const replayed = engine.store.hasAgentAction(intent.threadId, AGENT_THREAD_CREATED_ACTION)
    if (!replayed) this.makeAgentThread(intent)
    let firstMessage: AgentCreatedThread['firstMessage']
    if (intent.firstMessage) firstMessage = await this.sendFirstMessage(intent, `${key}:first`)
    return this.agentCreated(intent, firstMessage, replayed)
  }

  /** The launch an agent asked for, checked against the project, the profile and the caller's own limits. Throws what it refuses. */
  private planAgentThread(input: AgentThreadRequest, options: { actor: AgentActor; accessLevel: AgentAccessLevel }): AgentThreadIntent {
    const engine = this.requireRunEngine()
    const project = this.projectManager?.getProject(input.projectId)
    if (!project) throw new Error(`Project ${input.projectId} was not found.`)
    // A worktree needs Git: on any other project a "new worktree" thread would write in the project folder, beside others.
    let gitBacked = false
    try {
      gitBacked = new ThreadWorkspaceManager('').resolveRepository(project.path).capability.gitBacked
    } catch {
      gitBacked = false
    }
    if (input.workspace === 'new_worktree' && !gitBacked)
      throw new Error('workspace "new_worktree" needs a Git project: this project is not backed by a Git repository, so a thread there would work in the project folder. Use workspace "project". No thread was created.')
    // However many runs this thread has made, only so many of its launched threads may be working at once.
    const busy = new Set(engine.store.listNonTerminalRuns().map((run) => run.threadId))
    const working = this.threadStore!.listAllThreads().filter((thread) => thread.createdByThreadId === options.actor.threadId && busy.has(thread.id)).length
    if (working >= THREAD_CREATE_MAX_ACTIVE_PER_THREAD)
      throw new McpToolError('mousse_conflict', `${working} of the threads this thread launched are still working (the limit is ${THREAD_CREATE_MAX_ACTIVE_PER_THREAD}); wait for some to finish (thread_wait) before launching more.`, { conflict: 'creation_limit', working })
    const modelOverride = this.agentThreadModel(input, options.actor.threadId, project.id)
    // The thread runs no wider than its creator, and a looser default later cannot widen it: its mode is the stricter of
    // the creator's and the profile's default, stored as a concrete mode. Its agents are held to a level of their own.
    const callerMode = this.runPermissionMode(options.actor.runId)
    const profileMode = normalizePermissionMode(this.settingsStore.get().permissions.defaultMode)
    // The first message counts as the next agent message in a row: a creation cannot start a chain the limit would stop.
    if (input.firstMessage !== undefined) this.withAgentHops(options.actor)
    return {
      threadId: uuidv4(),
      projectPath: project.path,
      title: input.title?.trim() || 'New Thread',
      worktreeEnabled: input.workspace === 'new_worktree',
      gitBacked,
      modelOverride,
      permissionMode: narrowPermissionMode(profileMode, callerMode),
      accessCeiling: narrowAgentAccess(this.effectiveAccess(options.accessLevel), LAUNCHED_THREAD_ACCESS_CEILING) ?? 'lineage',
      createdByThreadId: options.actor.threadId,
      actor: options.actor,
      request: input,
      firstMessage: input.firstMessage === undefined ? null : { content: input.firstMessage, mode: input.mode ?? 'agent' }
    }
  }

  /**
   * The model a new thread gets. Neither `instanceId` nor `model`: the caller's own selection, if it has one and
   * the new thread's project allows it. A model alone is on the caller's instance (else the default one). Both
   * go through the checks `threads.setModel` makes: the instance must exist and be enabled, and the model must be
   * visible to the project. Null: no selection is stored and the thread follows the profile's default.
   */
  private agentThreadModel(input: AgentThreadRequest, callerThreadId: string, projectId: string): ModelOverride | null {
    const scope = { kind: 'project', projectId } as const
    const callerThread = this.threadStore?.getThread(callerThreadId)
    const inherited = this.harness.instanceMap.migrate(this.getOrCreateSession(callerThreadId).modelOverride ?? callerThread?.modelOverride)
    if (!input.model) {
      if (!inherited) return null
      try {
        this.harness.resolveStored(inherited, { purpose: 'composer', scope })
      } catch (error) {
        throw new Error(`Your own model is not available in this project (${error instanceof Error ? error.message : String(error)}); name an instanceId and model that are.`)
      }
      return structuredClone(inherited)
    }
    const instanceId = input.instanceId ?? this.harness.instanceMap.instanceIdOf(inherited ?? this.defaultAgentModel())
    // An unknown or disabled instance, a hidden model and an instance the project turned off are refused here.
    const override = this.harness.instanceMap.overrideFor({ instanceId, model: input.model })
    this.harness.resolveStored(override, { purpose: 'composer', scope })
    return override
  }

  /**
   * Makes the thread of a stored intent and writes its completion marker. A thread a crash left half made (files
   * without the marker) is discarded and made again, as long as no one has used it. One a person has used is never
   * adopted and never sent the agent's message: the creation is refused and the creator starts a new one.
   */
  private makeAgentThread(intent: AgentThreadIntent): void {
    const engine = this.requireRunEngine()
    const store = this.threadStore!
    if (store.getThread(intent.threadId)) {
      const refused = (): McpToolError => new McpToolError('mousse_conflict', `The thread made for this request (${intent.threadId}) was used by a person before its creation finished, so it was left as it is and nothing was sent to it. Make a new thread with a new clientRequestId.`, { conflict: 'thread_in_use', threadId: intent.threadId })
      if (this.agentThreadUsed(intent)) throw refused()
      try {
        store.discardUnusedThread(intent.threadId)
      } catch (error) {
        if (store.loadThreadData(intent.threadId).messages.length) throw refused()
        throw error
      }
    }
    store.createThread(intent.title, intent.request.projectId, intent.projectPath, {
      id: intent.threadId,
      // Listed from the first write, never an empty draft the app's "New chat" would take over.
      started: true,
      worktreeEnabled: intent.worktreeEnabled,
      ...(intent.modelOverride ? { modelOverride: intent.modelOverride } : {}),
      permissionMode: intent.permissionMode,
      // Launched by the caller's thread, never owned by it: it is neither nested under it nor deleted with it.
      createdByThreadId: intent.createdByThreadId,
      accessCeiling: intent.accessCeiling
    })
    // The marker: a thread is complete only once this event exists. Ids and names, never the message.
    engine.store.appendEvent({
      threadId: intent.threadId,
      runId: null,
      type: 'agent.action',
      payload: {
        action: AGENT_THREAD_CREATED_ACTION,
        actorThreadId: intent.actor.threadId,
        actorRunId: intent.actor.runId,
        toolCallId: intent.actor.toolCallId,
        projectId: intent.request.projectId,
        workspace: intent.request.workspace,
        instanceId: intent.modelOverride?.instanceId ?? null,
        model: intent.modelOverride?.model ?? null,
        permissionMode: intent.permissionMode,
        hasFirstMessage: intent.firstMessage !== null
      }
    })
  }

  /**
   * A thread an agent was creating that a person has used or changed: it is open in this daemon, has a run or a message,
   * or differs from what the creation made (renamed, another mode or model, archived, touched). The app announces a
   * thread as soon as its files are written, before its marker, so this can happen.
   */
  private agentThreadUsed(intent: AgentThreadIntent): boolean {
    if (this.sessions.has(intent.threadId)) return true
    if ((this.runEngine?.listRuns(intent.threadId, { limit: 1 }).length ?? 0) > 0) return true
    const store = this.threadStore
    const meta = store?.getThread(intent.threadId)
    if (!store || !meta) return false
    if (store.loadThreadData(intent.threadId).messages.length > 0) return true
    return meta.name !== intent.title
      || meta.updatedAt !== meta.createdAt
      || Boolean(meta.settledAt)
      || (meta.permissionMode ?? null) !== intent.permissionMode
      || JSON.stringify(meta.modelOverride ?? null) !== JSON.stringify(intent.modelOverride)
  }

  /**
   * The first message, sent as the creator's through `thread_send`'s own path: labelled, under the creator's mode,
   * counted as an agent message in a row. Keyed on the creation's key, so a retry returns the first result. A message
   * that cannot be sent leaves the thread made; the result says why and a retry sends it.
   */
  private async sendFirstMessage(intent: AgentThreadIntent, key: string): Promise<NonNullable<AgentCreatedThread['firstMessage']>> {
    try {
      const sent = this.earlierAgentSend(intent.threadId, key)
        ?? await this.sendToThreadAsAgent(intent.threadId, intent.firstMessage!, { clientRequestId: key, actor: intent.actor })
      return { sent: true, ...sent }
    } catch (error) {
      return { sent: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  private agentCreated(intent: AgentThreadIntent, firstMessage: AgentCreatedThread['firstMessage'], replayed: boolean): AgentCreatedThread {
    const override = intent.modelOverride
    return {
      threadId: intent.threadId,
      projectId: intent.request.projectId,
      title: intent.title,
      workspace: intent.request.workspace,
      // What actually happens: a Git project's editing turn gets a worktree of its own, whichever workspace was asked for;
      // any other project's thread works in the project folder.
      runsIn: intent.gitBacked ? 'own_worktree' : 'project_folder',
      model: override ? { instanceId: override.instanceId ?? this.harness.instanceMap.instanceIdOf(override), model: override.model } : null,
      permissionMode: intent.permissionMode,
      ...(firstMessage ? { firstMessage } : {}),
      replayed
    }
  }

  /** The key has a stored creation: a retry finishes that one thread and needs no new place under the caller's cap. */
  private agentCreationStarted(clientRequestId: string): boolean {
    return readAgentThreadReceipt(this.requireRunEngine().store.getReceipt(clientRequestId)) !== undefined
  }

  /** A row on the creator's thread saying what it launched: where, on which model, in which mode (the person watching sees the agent's choice). */
  private noteAgentLaunch(creatorThreadId: string, text: string): void {
    const session = this.getOrCreateSession(creatorThreadId)
    this.sessionAls.run(session, () => this.addSystemMessage(text))
  }

  /**
   * Boot: a thread an agent was creating when the daemon died has files but no completion marker. While no one has
   * used it, it is discarded (clients are told), so no half-made launched thread is ever listed; the creator's retry
   * makes it again from the stored intent. Nothing is made here. Only the last week's creations are looked at, in one query.
   */
  private recoverAgentThreadCreations(): void {
    const engine = this.runEngine
    const store = this.threadStore
    if (!engine || !store) return
    try {
      for (const receipt of engine.store.listUnfinishedThreadCreations(new Date(Date.now() - AGENT_THREAD_REPAIR_WINDOW_MS).toISOString())) {
        const stored = readAgentThreadReceipt(receipt)
        if (!stored || !store.getThread(stored.intent.threadId) || this.agentThreadUsed(stored.intent)) continue
        try {
          store.discardUnusedThread(stored.intent.threadId)
        } catch (error) {
          console.warn('a half-made thread an agent created was kept', { threadId: stored.intent.threadId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      console.warn('threads agents were creating could not be repaired', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** `thread_interrupt`: the one Stop (`stopThread`), asked for by an agent, aimed at one run. */
  private async stopRunAsAgent(threadId: string, runId: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult> {
    const engine = this.requireRunEngine()
    const result = await this.stopThread(threadId, 'agent', { runId, clientRequestId: options.clientRequestId, requesterThreadId: options.actor.threadId, actor: options.actor })
    return this.agentRunCommandResult(engine, threadId, runId, result)
  }

  /**
   * `thread_steer`: joins a run that is live. A running turn cannot be narrowed, so a caller whose permission
   * mode is stricter than the one the run is bound to is refused: its words would run with more authority than
   * the caller itself has. A run bound to a stricter mode than the caller's takes the steer.
   */
  private async steerRunAsAgent(threadId: string, runId: string, text: string, options: { clientRequestId: string; actor: AgentActor }): Promise<AgentRunCommandResult> {
    const engine = this.requireRunEngine()
    let sender: AgentActor
    try {
      sender = this.withAgentHops(options.actor)
    } catch (error) {
      return { status: 'rejected', reason: (error as { code?: string }).code ?? 'agent_hops_exceeded' }
    }
    // The comparison with the run's own mode is made by the engine, inside the transaction that accepts the
    // steer, against the binding it reads there: a run that has not bound its turn yet is refused, and the
    // sender's mode travels with the steer wherever it ends up (SPEC §15.1).
    const callerMode = this.runPermissionMode(sender.runId)
    const result = await this.steerRun(runId, agentMessageText(sender.threadId, this.titleOf(sender.threadId), text), options.clientRequestId, threadId, sender, callerMode)
    if (result.status === 'rejected' && result.reason === 'ceiling_exceeded') return { status: 'ceiling_exceeded', callerMode, targetMode: this.runPermissionMode(runId) }
    return this.agentRunCommandResult(engine, threadId, runId, result)
  }

  private agentRunCommandResult(engine: RunEngine, threadId: string, runId: string, result: CommandResult | StopThreadOutcome): AgentRunCommandResult {
    const replayed = 'replayed' in result && result.replayed === true
    if (result.status === 'accepted' || result.status === 'stopped') return { status: 'accepted', runId, sequence: engine.maxSeq(threadId), replayed }
    if (result.status === 'rejected') return { status: 'rejected', reason: result.reason ?? 'rejected' }
    return {
      status: 'ignored',
      reason: result.reason ?? 'run_not_active',
      runId,
      activeRunId: engine.getActiveRun(threadId)?.runId ?? null,
      ...(engine.getRun(runId) ? { runStatus: engine.getRun(runId)!.status } : {})
    }
  }

  /** The transcript row of a change an agent made (its `agent.action` event is the record; this is the projection). */
  private showAgentAction(threadId: string, actor: AgentActor, summary: string): void {
    const session = this.getOrCreateSession(threadId)
    this.sessionAls.run(session, () => this.addSystemMessage(`Changed by an agent in thread «${this.titleOf(actor.threadId) ?? actor.threadId}» (${actor.threadId}): ${summary}`))
  }

  /**
   * A thread's visible transcript for a reader that is not working in it: from the live session when it
   * is open, else straight from the store, so reading does not keep every thread it touches in memory.
   */
  private visibleMessagesWithoutLoading(threadId: string): ChatMessage[] {
    if (this.sessions.has(threadId) || !this.threadStore) return this.getMessages(threadId)
    return this.threadStore.loadThreadData(threadId).messages.filter((message) => !message.hidden)
  }

  /** What waits on a thread without loading it: its queued messages (from disk) and unanswered questions. */
  private threadActivity(threadId: string): { queuedCount: number; pendingQuestions: PendingUserQuestions[] } {
    let queuedCount = 0
    try {
      queuedCount = listPendingQueue(this.threadStore?.loadMessageQueue(threadId) ?? []).filter((item) => !item.internal).length
    } catch {
      /* An unreadable queue file counts as empty here; the queue tools report it. */
    }
    // An agent never makes a standing rule, so the requests it reads do not offer "Always for this thread".
    return { queuedCount, pendingQuestions: this.questions.listPendingForThread(threadId).map(withoutStandingRules) }
  }

  /**
   * Records a change an agent made to another thread (SPEC §15.1): an `agent.action` event on the
   * thread, the durable record, and a transcript row "Changed by an agent in thread …" as its
   * projection. `details` hold ids, counts and lengths, never message content; its `summary` is the row's
   * text. Callers add the row only for the call that made the change, not for a replay.
   */
  private recordAgentAction(
    target: { threadId: string; runId?: string },
    actor: AgentActor,
    action: string,
    details: Record<string, string | number | boolean | null> = {}
  ): void {
    this.requireRunEngine().store.appendEvent({
      threadId: target.threadId,
      runId: target.runId ?? null,
      type: 'agent.action',
      payload: { ...details, action, actorThreadId: actor.threadId, actorRunId: actor.runId, toolCallId: actor.toolCallId }
    })
    this.showAgentAction(target.threadId, actor, typeof details.summary === 'string' && details.summary ? details.summary : action)
  }

  /** Executors for the `turn.*` effects; the profile hands them to its `EffectWorker`. */
  effectExecutors(): Partial<Record<EffectKind, EffectExecutor>> {
    return {
      'turn.start': (effect, ctx) => this.executeTurnStartEffect(effect, ctx.signal),
      'turn.interrupt': (effect) => this.executeTurnInterruptEffect(effect),
      'turn.steer': async (effect) => this.executeTurnSteerEffect(effect),
      'run.resume': (effect) => this.executeResumeEffect(effect),
      // SPEC §17.4: an answer committed with this effect reaches the provider callback that waits for it.
      'request.respond': async (effect) => { this.questions.deliver((effect.payload as { requestId: string }).requestId) }
    }
  }

  /**
   * Starts an admitted turn. With effects enabled and a run, the turn becomes a `turn.start`
   * effect whose result the returned promise carries; otherwise it runs directly. The caller
   * may hold admission (`admissionHeld`); the effect path always holds it until the executor runs
   * so a concurrent send still queues.
   */
  private startTurn(session: ThreadSession, payload: TurnStartRequest): Promise<OrchestratorResponse> {
    const direct = (admissionHeld: boolean | undefined): Promise<OrchestratorResponse> => this.settleCarriedRows(payload, this.runTurnOnSession(
      session,
      payload.input,
      payload.reuseLastUser,
      payload.displayUserMessage,
      {
        source: payload.source,
        queueItemId: payload.queueItemId,
        claimOwnerToken: payload.claimOwnerToken,
        suppressAutoQueueDrain: payload.suppressAutoQueueDrain,
        runId: payload.runId,
        admissionHeld,
        subagentNotice: payload.subagentNotice,
        ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
        modelOverride: payload.modelOverride,
        origin: payload.origin,
        schedule: payload.schedule,
        agent: payload.agent
      }
    ))
    const runId = payload.runId
    if (!runId || !this.effectsEnabled()) return direct(payload.admissionHeld)
    if (!payload.admissionHeld) {
      // Let the direct path produce its usual "already running" rejection.
      if (session.turnAdmitted) return direct(false)
      session.turnAdmitted = true
    }
    // The turn.start effect now carries this admission, whoever reserved it (the send, or a queue drain
    // that held it across the await that made the run): the owner is the run the effect starts.
    if (session.turnAdmitted && !session.activeTurn) session.admissionRunId = runId
    try {
      return this.enqueueTurnStart({ ...payload, runId, admissionHeld: true })
    } catch (error) {
      console.warn('turn.start effect could not be recorded; running the turn directly', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
      return direct(true)
    }
  }

  /**
   * A queued turn that runs without a `turn.start` effect (effects are off, or recording the effect
   * failed) has no effect for its rows to follow, so they follow the turn's run. Only its outcome
   * counts, never the shape of the response:
   * - `completed`: the turn consumed the notice; the rows are acknowledged;
   * - not terminal (a lease race put the item back in the queue, or no run was recorded): the rows
   *   stay with the item, which delivers them when it drains again;
   * - interrupted by the user: the rows stay `delivered` and belong to nothing, as a stopped delivery
   *   always has (no redelivery behind a Stop);
   * - anything else (failed, cancelled, cut off by a restart or shutdown): given back, so rule 4 delivers them.
   */
  private settleCarriedRows(payload: TurnStartRequest, turn: Promise<OrchestratorResponse>): Promise<OrchestratorResponse> {
    const engine = this.runEngine
    if (!engine || !payload.inboxIds?.length || !payload.queueItemId) return turn
    const owner = queueOwner(payload.queueItemId)
    const own = (): InboxRecord[] => engine.inbox.getMany(payload.inboxIds!).filter((row) => row.status === 'delivered' && row.deliveredBy === owner)
    const give = (): void => { engine.inbox.release(own().map((row) => row.inboxId), owner) }
    return turn.then((response) => {
      try {
        const run = payload.runId ? engine.getRun(payload.runId) : null
        if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) return response
        if (run.status === 'completed') engine.store.db.transaction(() => acknowledgeRows(engine.store, own()))
        else if (run.status === 'interrupted' && stoppedByPerson(run.outcome)) engine.inbox.detachDelivery(own().map((row) => row.inboxId), owner)
        else give()
      } catch (error) {
        console.warn('queued notice rows could not be settled', { error: error instanceof Error ? error.message : String(error) })
      }
      return response
    }, (error: unknown) => {
      try { give() } catch { /* the rows stay with the item; boot releases them if it is gone */ }
      throw error
    })
  }

  /**
   * Records a `turn.start` effect and the in-memory deferred its executor settles. The run's send
   * already committed; the effect is its own transaction (Phase 2b).
   */
  private enqueueTurnStart(payload: TurnStartPayload): Promise<OrchestratorResponse> {
    const engine = this.requireRunEngine()
    let resolve!: (response: OrchestratorResponse) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<OrchestratorResponse>((done, failed) => {
      resolve = done
      reject = failed
    })
    // Ack-mode sends never await the result; a rejection must not surface as unhandled.
    promise.catch(() => undefined)
    const entry: TurnResult = { promise, resolve, reject, payload, effectId: null, started: false, abandoned: false }
    this.turnResults.set(payload.runId, entry)
    try {
      // One transaction: if the notices cannot be redirected, no effect stays recorded, so the direct run
      // `startTurn` falls back to is the only run of this turn (the effect worker cannot claim it too).
      engine.store.db.transaction(() => {
        entry.effectId = engine.outbox.enqueue({
          threadId: payload.threadId,
          runId: payload.runId,
          kind: 'turn.start',
          payload: { ...payload, input: durableSendInput(payload.input) }
        }).effectId
        // The notices this turn carries now follow its outcome: read when it completes, redelivered when it fails.
        if (payload.inboxIds?.length && payload.queueItemId) engine.inbox.redirectDelivery(payload.inboxIds, entry.effectId, queueOwner(payload.queueItemId))
      })
    } catch (error) {
      this.turnResults.delete(payload.runId)
      throw error
    }
    return promise
  }

  private async executeTurnStartEffect(effect: EffectRecord, signal: AbortSignal): Promise<void> {
    if (isWakeTurnPayload(effect.payload)) return this.executeWakeEffect(effect, effect.payload, signal)
    // Work started on the thread's behalf, or a scheduled occurrence, never runs beside a pause.
    if (this.cancelStartOnPausedThread(effect)) return
    if (isIntegrationTurnPayload(effect.payload)) return this.executeIntegrationEffect(effect.payload, signal)
    if (isContinuationTurnPayload(effect.payload)) return this.executeContinuationEffect(effect, effect.payload, signal)
    if (isBotTurnPayload(effect.payload)) return this.executeBotEffect(effect.payload, signal)
    // A payload of a kind this build does not know is refused, never cast to a send: a later
    // kind is as inert here as a bot payload is in a build without bots.
    if (hasUnknownTurnPayloadKind(effect.payload, KNOWN_TURN_PAYLOAD_KINDS)) {
      const { runId } = effect.payload as { runId?: unknown }
      if (typeof runId === 'string') this.markRun(runId, (engine, id) => {
        if (engine.getRun(id)?.status === 'queued') engine.markTerminal(id, 'cancelled', { error: 'unknown_turn_payload' })
      })
      return
    }
    const stored = effect.payload as TurnStartPayload
    const entry = this.turnResults.get(stored.runId)
    if (entry?.abandoned) return
    // C2: only a queued run starts. One that was cancelled (a delegation cancel, a deleted thread)
    // or is already being executed never reaches workspace provisioning or the provider.
    const run = this.runEngine?.getRun(stored.runId)
    if (run && run.status !== 'queued') {
      this.skipUnstartableTurn(entry?.payload ?? stored, entry, run)
      return
    }
    // The Stop fence at execution: work that starts on behalf of a parent and was admitted before a Stop of its thread is refused.
    if (run && this.runEngine?.isFenced(run.runId)) {
      this.markRun(run.runId, (engine, id) => {
        if (engine.getRun(id)?.status === 'queued') engine.markTerminal(id, 'cancelled', { interruptedBy: 'user' })
      })
      this.skipUnstartableTurn(entry?.payload ?? stored, entry, this.runEngine.getRun(run.runId) ?? run)
      return
    }
    if (entry) entry.started = true
    // The in-memory payload keeps image data the durable payload omits. Without it the sender is
    // gone (another orchestrator instance), so this executor does not inherit its admission.
    const payload = entry?.payload ?? { ...stored, admissionHeld: false }
    try {
      const session = this.getOrCreateSession(payload.threadId)
      if (payload.sharedWorkspace && !session.sharedWorkspace) session.sharedWorkspace = payload.sharedWorkspace
      const response = await this.runTurnOnSession(
        session,
        payload.input,
        payload.reuseLastUser,
        payload.displayUserMessage,
        {
          source: payload.source,
          queueItemId: payload.queueItemId,
          claimOwnerToken: payload.claimOwnerToken,
          suppressAutoQueueDrain: payload.suppressAutoQueueDrain,
          runId: payload.runId,
          admissionHeld: payload.admissionHeld,
          externalSignal: signal,
          subagentNotice: payload.subagentNotice,
          ...(payload.permissionMode ? { permissionMode: payload.permissionMode } : {}),
          modelOverride: payload.modelOverride,
          origin: payload.origin,
          schedule: payload.schedule,
          agent: payload.agent
        }
      )
      entry?.resolve(response)
    } catch (error) {
      entry?.reject(error)
      // An ordinary turn failure is already recorded on the run by the bridge; the effect itself
      // succeeded. Only a run the bridge could not settle is an infrastructure failure.
      const run = this.runEngine?.getRun(payload.runId)
      if (!run || (!TERMINAL_RUN_STATUSES.has(run.status) && run.status !== 'queued')) throw error
    } finally {
      if (this.turnResults.get(payload.runId) === entry) this.turnResults.delete(payload.runId)
    }
  }

  /**
   * A bot dispatch's `turn.start` (PR 6 §4): the bot engine rebuilds the turn from `bots.db` and
   * checks that its grant still holds; only then does the turn start, bound to the compiled policy,
   * with the activation's authority, counts and spend. A refusal cancels the queued run, and
   * nothing is sent. The activation thread is new, so the turn starts with no history; anything
   * else fails it with `bot_state_invalid` before a request.
   */
  private async executeBotEffect(payload: BotTurnPayload, signal: AbortSignal): Promise<void> {
    const engine = this.requireRunEngine()
    const run = engine.getRun(payload.runId)
    if (!run || run.status !== 'queued' || run.threadId !== payload.threadId) return
    const dispatcher = this.botDispatcher
    const cancel = (error: string): void => {
      this.markRun(payload.runId, (runs, id) => {
        if (runs.getRun(id)?.status === 'queued') runs.markTerminal(id, 'cancelled', { error })
      })
      dispatcher?.settle(payload, {})
    }
    if (!dispatcher) return cancel('bots_unavailable')
    const session = this.getOrCreateSession(payload.threadId)
    // A continuation can be sent while the walled turn is still letting go of the thread: wait for
    // it (briefly) before anything is prepared, so no time is charged to a turn that cannot start.
    const busy = (): boolean => session.deleted || session.turnAdmitted || session.isTurnRunning()
    for (let waited = 0; busy() && !session.deleted && waited < 10_000 && !signal.aborted; waited += 50) await new Promise((resolve) => setTimeout(resolve, 50))
    if (busy() || engine.getRun(payload.runId)?.status !== 'queued') return cancel('bot_state_invalid')
    let prepared: ReturnType<BotTurnDispatcher['prepare']>
    try {
      await dispatcher.refresh?.(payload)
      prepared = dispatcher.prepare(payload)
    } catch (error) {
      console.warn('bot dispatch could not be prepared', { runId: payload.runId, error: error instanceof Error ? error.message : String(error) })
      return cancel('bot_prepare_failed')
    }
    if ('refused' in prepared) return cancel(prepared.code)
    // History 'none': a fresh activation thread has no transcript, native context or summary. A
    // continuation or a consult runs on the thread's own history ('thread').
    const fresh = session.messages.length === 0 && getActiveMessages(session.nativeContext).length === 0 && !getCompactionSummary(session.nativeContext)
    if (busy() || (prepared.history !== 'thread' && !fresh)) return cancel('bot_state_invalid')
    let text: string | undefined
    try {
      const response = await this.runTurnOnSession(
        session,
        { content: prepared.prompt, mode: 'agent' },
        false,
        true,
        {
          source: 'bot',
          runId: payload.runId,
          externalSignal: AbortSignal.any([signal, prepared.authority.time.signal]),
          modelOverride: this.harness.instanceMap.overrideFor({ instanceId: prepared.selection.instanceId, model: prepared.selection.model }),
          bot: prepared
        }
      )
      text = response.message
    } catch (error) {
      const settled = engine.getRun(payload.runId)
      if (!settled || (!TERMINAL_RUN_STATUSES.has(settled.status) && settled.status !== 'queued')) throw error
    } finally {
      dispatcher.settle(payload, text !== undefined ? { text } : {})
    }
  }

  /**
   * A claimed `turn.start` whose run is no longer queued: the sender learns it did not start, the
   * admission its send held is released, and a queue item whose run already ended leaves the queue.
   */
  private skipUnstartableTurn(payload: TurnStartPayload, entry: TurnResult | undefined, run: RunRecord): void {
    if (entry && this.turnResults.get(payload.runId) === entry) this.turnResults.delete(payload.runId)
    const session = this.boundSession.threadId === payload.threadId ? this.boundSession : this.sessions.get(payload.threadId)
    if (session && entry?.payload.admissionHeld && !session.activeTurn) {
      session.turnAdmitted = false
      session.admissionRunId = undefined
      session.abortRequested = false
      if (session.drainAfterSettle) {
        session.drainAfterSettle = false
        this.scheduleQueueDrain(session)
      }
    }
    if (session && payload.queueItemId && TERMINAL_RUN_STATUSES.has(run.status))
      this.completeSessionClaim(session, payload.queueItemId, payload.claimOwnerToken)
    entry?.reject(new Error(`Run ${payload.runId} is ${run.status}; its turn did not start.`))
  }

  /**
   * A `turn.start` the worker never claimed before shutdown: cancel the effect, release the
   * admission it held and fail the sender. A queue item keeps its claim settlement to the drain's
   * failure path (its run stays queued with the item); a direct send's run is interrupted.
   */
  private abandonTurnStart(runId: string, entry: TurnResult): void {
    entry.abandoned = true
    this.turnResults.delete(runId)
    const { payload } = entry
    try {
      if (entry.effectId) this.runEngine?.outbox.cancel(entry.effectId, new Date().toISOString(), 'shutdown')
    } catch (error) {
      console.warn('turn.start effect could not be cancelled', { runId, error: error instanceof Error ? error.message : String(error) })
    }
    const session = this.boundSession.threadId === payload.threadId ? this.boundSession : this.sessions.get(payload.threadId)
    if (session && !session.activeTurn) {
      session.turnAdmitted = false
      session.admissionRunId = undefined
    }
    if (!payload.queueItemId) {
      this.markRun(runId, (engine, id) => {
        if (engine.getRun(id)?.status === 'queued') engine.markTerminal(id, 'interrupted', { interruptedBy: 'daemon_restart' })
      })
    }
    entry.reject(Object.assign(new Error('Profile work is shutting down'), { code: 'profile_draining' }))
  }

  /** `turn.interrupt`: stops the run's live turn (`interruptRun`). A run that is no longer live counts as done. */
  private async executeTurnInterruptEffect(effect: EffectRecord): Promise<void> {
    const { runId, threadId } = effect.payload as { runId: string; threadId: string }
    await this.interruptRun(runId, threadId)
  }

  /** The thread has a turn in this process: running, admitted (setting up) or a channel turn. */
  private hasLocalTurn(threadId: string): boolean {
    const session = this.boundSession.threadId === threadId ? this.boundSession : this.sessions.get(threadId)
    return Boolean(session?.activeTurn || session?.turnAdmitted || this.channelTurns.has(threadId))
  }

  /**
   * `turn.steer`: delivers to the live turn; a steer that missed it becomes a new turn (SPEC §5).
   * A steer that carries notices owns only the rows it still delivers: it is rebuilt now from those
   * (a row read since, or taken over by another delivery, is dropped), and with none left nothing is
   * delivered. A live turn that takes it marks the rows delivered to that run; one that does not
   * hands the rows to the queued turn it becomes.
   */
  private executeTurnSteerEffect(effect: EffectRecord): void {
    const { runId, threadId, text, inboxIds, origin, permissionMode, deviceLimit, sentFrom } = effect.payload as { runId: string; threadId: string; text: string; inboxIds?: string[]; origin?: AgentOrigin; permissionMode?: PermissionMode; deviceLimit?: PermissionMode; sentFrom?: { node: string } }
    // An agent's steer always carries its sender's mode; one that lost it (a damaged payload) reads as the strictest.
    // A person's steer from another computer carries that computer's limit.
    const limit = origin ? (isPermissionMode(permissionMode) ? permissionMode : 'ask') : isPermissionMode(deviceLimit) ? deviceLimit : undefined
    const engine = this.requireRunEngine()
    // A steer of a run that a Stop came after belongs to the work that was stopped: it delivers nothing and
    // makes no work (its rows were acknowledged by the Stop).
    if (engine.isStale(runId)) {
      // Rows that reached it after the Stop (newer work) are not part of what the Stop ended: they go back to be delivered.
      if (inboxIds?.length) engine.inbox.release(inboxIds, effect.effectId)
      return
    }
    let content = text
    let notice: SubagentNoticeItem[] | undefined
    let carried: { inboxIds: string[]; effectId: string } | undefined
    if (inboxIds?.length) {
      const rows = this.dropStaleQuestionRows(engine.inbox.getMany(inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === effect.effectId))
      if (rows.length === 0) return
      const planned = planWakeNotice(rows, this.noticeContext())
      engine.inbox.recordNoticeVisibility(rows, planned.items)
      content = planned.text
      notice = planned.items
      carried = { inboxIds: rows.map((row) => row.inboxId), effectId: effect.effectId }
    }
    // The rows stay the steer's until the model reads the text (`drainSteerForSession`) or the turn ends
    // without reading it, when the follow-up turn it leaves takes them.
    const run = engine.getRun(runId)
    if (run && !TERMINAL_RUN_STATUSES.has(run.status) && this.steerThread(threadId, content, notice, carried, origin, limit, undefined, sentFrom)) return
    this.enqueueLateSteer(threadId, content, carried, notice, runId, origin, limit, sentFrom)
  }

  // ---------------------------------------------------------------------------------------------
  // A run paused by a usage limit (docs/run-engine/SPEC.md §5, §16.4). The continue message is a queue
  // item, `resume:<runId>`, written at the front of the thread's queue by the `run.resume` effect (the
  // timer at the reset time, or Resume now). Its drain sends the continue turn and ends the pause in the
  // same transaction that creates the run, so each crash point has one owner: the effect (still running,
  // so re-queued on boot) before the item exists, the message queue (an item on disk is re-drained, a
  // claim reclaimed) after.

  /** A timer that fires this long after the reset it was armed for (Mousse was off over it) does not continue the run by itself. */
  private static readonly RESUME_STALE_MS = 24 * 60 * 60 * 1000

  /** The id of the queue item that continues the paused run `runId`. */
  private resumeItemId(runId: string): string {
    return `resume:${runId}`
  }

  /** What clients show of a paused run. */
  private turnPauseOf(run: RunRecord): NonNullable<TurnState['pause']> | undefined {
    const pause = run.outcome?.pause
    if (!pause) return undefined
    return {
      runId: run.runId,
      until: pause.until,
      estimated: pause.estimated,
      autoResume: pause.autoResume,
      ...(pause.stale ? { stale: true as const } : {}),
      ...(pause.provider ? { provider: pause.provider } : {}),
      ...(pause.limitKind ? { limitKind: pause.limitKind } : {})
    }
  }

  /** Boot: a run a usage limit paused (it survives a restart) shows as paused again until it is continued or ended. */
  restorePausedTurnStates(): void {
    const engine = this.runEngine
    if (!engine) return
    for (const run of engine.store.listNonTerminalRuns()) {
      if (run.status !== 'paused') continue
      const pause = this.turnPauseOf(run)
      if (pause) this.setTurnPhase(run.threadId, 'paused', { turnId: run.runId, pause })
    }
  }

  /** A thread's pause ended without a new turn (Cancel, Stop): its state is idle and, when `text` is given, the transcript says so. */
  private pauseEndedWithoutTurn(threadId: string, text?: string): void {
    if (this.turnStates.get(threadId)?.phase === 'paused') this.setTurnPhase(threadId, 'idle')
    if (text) this.noteInThread(threadId, text)
  }

  /**
   * An automatic timer or continue item that is more than a day past the reset does not continue the run
   * (Mousse was off over it): the run stays paused with auto-resume off, still shown as paused, and a message or
   * Resume now continues it. Only the first call writes the line. A continue item already written is removed.
   */
  private markPauseStale(runId: string, threadId: string): void {
    const engine = this.runEngine
    const run = engine?.getRun(runId)
    if (!engine || !run || run.status !== 'paused' || !run.outcome?.pause) return
    if (!run.outcome.pause.stale) {
      const updated = engine.endPause(runId, 'stale')
      this.noteInThread(threadId, `The usage limit reset while Mousse was off. ${MANUAL_CONTINUE_TEXT}`)
      // Still paused: the display keeps the pause, now without a timer.
      const pause = this.turnPauseOf(updated)
      if (pause) this.setTurnPhase(threadId, 'paused', { turnId: runId, pause })
    }
    this.removeResumeItem(threadId, run.outcome.pause.resumeItemId ?? this.resumeItemId(runId))
  }

  private autoResumeIsStale(pause: RunPause): boolean {
    return Date.now() - Date.parse(pause.until) > OrchestratorService.RESUME_STALE_MS
  }

  /** Writes a system line into the thread. */
  private noteInThread(threadId: string, text: string): void {
    try {
      const session = this.getOrCreateSession(threadId)
      if (session.deleted) return
      this.sessionAls.run(session, () => {
        this.addSystemMessage(text)
        this.persist(true)
      })
    } catch (error) {
      console.warn('the end of a pause could not be written to the thread', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Removes the continue message of a pause while it is still pending, and gives back the rows it owned
   * (they are pending again, for rule 4 or the next continue turn). A claimed item is never removed
   * here: the drain that holds the claim ends it, by admitting the continuation or by its refusal.
   */
  private removeResumeItem(threadId: string, itemId: string): void {
    const owner = queueOwner(itemId)
    try {
      let claimed = false
      this.mutateQueue(threadId, (items) => {
        claimed = items.some((item) => item.id === itemId && item.state === 'claimed')
        const target = items.find((item) => item.id === itemId && item.state !== 'claimed')
        if (!target) return items
        this.releaseQueuedRows([target])
        return items.filter((item) => item !== target)
      })
      // Rows the item owned when it was lost (a crash between the item and its removal): given back as boot does.
      const engine = this.runEngine
      if (engine && !claimed) {
        const owned = engine.inbox.listDeliveredByQueue().filter((row) => row.deliveredBy === owner).map((row) => row.inboxId)
        if (owned.length) engine.inbox.release(owned, owner)
      }
    } catch (error) {
      console.warn('the continue message of a pause could not be removed', { threadId, itemId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * `run.resume`: the timer of a paused run (at its reset time) or Resume now. Idempotent step by step, and
   * re-run after a crash (a running replay-safe effect is queued again on boot):
   * 1. Prepare: a pause that ended is dealt with (superseded: its item goes; handed over: only the drain is
   *    left); a stale timer ends nothing but turns auto-resume off; otherwise queued wakes and the rows the
   *    paused turn delivered go back to pending, and the item's id is recorded on the pause.
   * 2. Item: the continue message is written at the front of the queue, carrying the thread's pending rows, and
   *    the rows are marked as owned by it once the item is on disk.
   * 3. Drain: the queue is drained; the item is the one thing a paused thread's queue lets through.
   */
  private async executeResumeEffect(effect: EffectRecord): Promise<void> {
    const engine = this.requireRunEngine()
    const payload = effect.payload as RunResumePayload
    const { runId, threadId } = payload
    const itemId = this.resumeItemId(runId)
    const owner = queueOwner(itemId)
    const db = engine.store.db
    const run = engine.getRun(runId)
    const pause = run?.outcome?.pause
    const session = this.getOrCreateSession(threadId)
    if (!run || run.status !== 'paused' || !pause) {
      const endedBy = pause?.endedBy
      // Handed over: the item's drain admitted the continuation, so the item and its claim belong to the message
      // queue now. Only a drain is left to do (the queue's own recovery may not have reached it yet).
      if (endedBy === 'resume' || endedBy === 'resume_now') this.scheduleQueueDrain(session)
      // Superseded (a message, Cancel, Stop, delete) or gone: the item is no longer wanted.
      else this.removeResumeItem(threadId, itemId)
      return
    }
    if (session.deleted || (this.threadStore && !this.threadStore.getThread(threadId))) {
      engine.endPause(runId, 'deleted')
      return
    }
    if (!payload.manual && this.autoResumeIsStale(pause)) {
      this.markPauseStale(runId, threadId)
      return
    }
    const manual = payload.manual === true
    db.transaction(() => {
      // A paused thread takes no wake, and the rows the paused turn delivered are for the continue turn.
      cancelQueuedWakes(engine.store, engine.outbox, new Date().toISOString(), threadId)
      engine.inbox.releaseRunDeliveries(runId)
      engine.updatePause(runId, { resumeItemId: itemId, resumeRequested: manual ? 'user' : 'auto' })
    })
    db.checkpoint('resume.afterPrepare')
    const pending = this.dropStaleQuestionRows(engine.inbox.listPending(threadId))
    const planned = pending.length ? planWakeNotice(pending, this.noticeContext()) : undefined
    const written = this.enqueueForThread(
      threadId,
      { content: CONTINUE_TEXT, mode: getLastUserChatMode(session.messages) ?? 'agent' },
      {
        id: itemId,
        atFront: true,
        source: manual ? 'resume_now' : 'resume',
        internal: true,
        continuationOfRunId: runId,
        // The mode the paused run ran in: the continuation is never looser.
        permissionMode: this.runPermissionMode(runId),
        ...(planned ? { inboxIds: pending.map((row) => row.inboxId), subagentNotice: planned.items } : {}),
        afterSave: (item) => {
          db.checkpoint('resume.afterItem')
          // Only while the item is still pending: a claimed one was taken by a drain that took what it owns.
          // Exactly the manifest, and only rows that are still pending; the rest stays for rule 4.
          if (item.state === 'pending' && item.inboxIds?.length) engine.inbox.markDelivered(item.inboxIds, owner)
          db.checkpoint('resume.afterRows')
        }
      }
    )
    // A Resume now that finds the item an automatic timer wrote (not drained yet) makes it a person's resume: the
    // item keeps its id, and so the source it is admitted with is rewritten while it is still pending.
    if (manual && written.source !== 'resume_now') {
      this.mutateQueue(threadId, (items) => items.map((item) => (item.id === itemId && item.state === 'pending' ? { ...item, source: 'resume_now' } : item)))
    }
    this.scheduleQueueDrain(session)
  }

  /** `runs.resumeNow`: continue the paused run `runId` now. Refused `conflict` when it is not paused. */
  async resumePausedRun(runId: string): Promise<{ runId: string; effectId: string }> {
    const engine = this.requireRunEngine()
    const effect = engine.requestResume(runId, true)
    if (this.effectsEnabled()) this.effectWorker?.notify()
    else await this.executeResumeEffect(effect)
    return { runId, effectId: effect.effectId }
  }

  /** `runs.cancelPause`: ends the pause without continuing. The run is cancelled and the thread's held messages go on. */
  async cancelPausedRun(runId: string): Promise<{ runId: string }> {
    const engine = this.requireRunEngine()
    const run = engine.getRun(runId)
    if (!run || run.status !== 'paused') throw new CommandRejection('conflict', `Run ${runId} is not paused.`)
    engine.endPause(runId, 'cancel')
    this.removeResumeItem(run.threadId, run.outcome?.pause?.resumeItemId ?? this.resumeItemId(runId))
    this.pauseEndedWithoutTurn(run.threadId, 'Paused run cancelled.')
    // A claimed continue message is retired by the drain that holds it; what was queued before the pause goes on now.
    this.scheduleQueueDrain(this.getOrCreateSession(run.threadId))
    return { runId }
  }

  /**
   * The continue message of a pause is being drained: sends the continue turn for the paused run. That
   * creates the continuation run and ends the pause in one transaction. Returns the run's id, or undefined
   * when the send is refused for any reason (the pause ended first: a message, Cancel, Stop): the item is
   * retired without ever reaching the provider and the drain goes on. A replay (after a crash) returns the
   * same run. An exception leaves the claim to `settleClaimAfterFailure`.
   */
  private async admitResumeItem(session: ThreadSession, original: QueuedMessage, rebuilt: QueuedMessage, claimToken: string): Promise<string | undefined> {
    const engine = this.requireRunEngine()
    try {
      // The 24-hour rule holds for an item already on disk too (the timer's own check comes before the item
      // exists): an automatic item whose reset is more than a day past is retired, never run. A Resume now item is
      // a person's and stays eligible. The startup drain and the timer's replay both end up here.
      const paused = engine.getRun(original.continuationOfRunId!)
      const pause = paused?.status === 'paused' ? paused.outcome?.pause : undefined
      const stale = Boolean(pause && original.source !== 'resume_now' && (pause.stale || this.autoResumeIsStale(pause)))
      if (stale) this.markPauseStale(original.continuationOfRunId!, original.threadId)
      else {
        const result = await engine.dispatch({
          kind: 'send',
          threadId: original.threadId,
          clientRequestId: queueOwner(original.id),
          source: original.source ?? 'resume',
          continuationOfRunId: original.continuationOfRunId!
        })
        if (result.status === 'accepted') return result.runId
        console.warn('the continue message of a paused run was refused', { itemId: original.id, reason: result.status === 'rejected' ? result.reason : result.status })
      }
    } catch (error) {
      session.turnAdmitted = false
      session.admissionRunId = undefined
      throw error
    }
    session.turnAdmitted = false
    session.admissionRunId = undefined
    this.completeSessionClaim(session, original.id, claimToken)
    this.releaseQueuedRows([original, rebuilt])
    this.scheduleQueueDrain(session)
    return undefined
  }

  /** The continue message of a pause, rebuilt from the rows it still owns (it is never dropped for want of them). */
  private rebuildResumeItem(item: QueuedMessage): QueuedMessage {
    const { inboxIds: _ids, subagentNotice: _notice, ...rest } = item
    const engine = this.runEngine
    if (!engine || !item.inboxIds?.length) return { ...rest, content: CONTINUE_TEXT }
    const owner = queueOwner(item.id)
    const rows = this.dropStaleQuestionRows(engine.inbox.getMany(item.inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === owner))
    if (rows.length === 0) return { ...rest, content: CONTINUE_TEXT }
    const planned = planWakeNotice(rows, this.noticeContext())
    engine.inbox.recordNoticeVisibility(rows, planned.items)
    return { ...rest, content: `${CONTINUE_TEXT}\n\n${planned.text}`, inboxIds: rows.map((row) => row.inboxId), subagentNotice: planned.items }
  }

  /**
   * A queued run that must not start beside a pause (work started on the thread's behalf, a scheduled
   * occurrence) is cancelled instead of waiting in the thread's lane, where it would hold up the continue turn
   * (the lane is first-in, first-out). Returns true when the effect was dealt with.
   */
  private cancelStartOnPausedThread(effect: EffectRecord): boolean {
    const engine = this.runEngine
    const runId = (effect.payload as { runId?: unknown } | null)?.runId
    if (!engine || typeof runId !== 'string') return false
    const run = engine.getRun(runId)
    if (!run || run.status !== 'queued' || isResumeSource(run.source)) return false
    if (!isFencedSource(run.source) && !isPauseHeldSource(run.source)) return false
    if (!engine.store.getPausedRun(run.threadId)) return false
    // An integration that never started says so: the generic row would call its outcome unknown and send the model
    // to check a workspace nothing has touched.
    const integration = isIntegrationTurnPayload(effect.payload) ? effect.payload : undefined
    const notice = integration
      ? {
          kind: 'reconcile_notice' as const,
          payload: {
            type: 'integration_failed' as const,
            delegationId: integration.delegationId,
            text: `Integration of delegated task ${integration.delegationId} did not start because the thread was paused by a usage limit. Nothing was merged; ask for it again.`
          }
        }
      : undefined
    this.markRun(runId, (runs, id) => {
      if (runs.getRun(id)?.status === 'queued') runs.markTerminal(id, 'cancelled', { error: 'The thread is paused by a usage limit.' }, notice ? { notice } : {})
    })
    if (isContinuationTurnPayload(effect.payload)) {
      // The model has not heard that its background task finished: the notice stays for the continuation (or
      // for the wake that follows a message), as a row of the thread's inbox.
      try {
        engine.inbox.append({
          inboxId: `inbox:continuation:${effect.payload.continuationId}`,
          threadId: effect.payload.threadId,
          kind: 'reconcile_notice',
          payload: { type: 'background_task_finished', text: effect.payload.note }
        })
      } catch (error) {
        console.warn('a background task notice could not be kept for the paused thread', { threadId: effect.payload.threadId, error: error instanceof Error ? error.message : String(error) })
      }
      this.harness.discardContinuations(effect.payload.threadId, effect.payload.continuationId)
      this.endContinuationHold(effect.payload.continuationId, true)
    } else if (!integration && !isBotTurnPayload(effect.payload)) {
      const stored = effect.payload as TurnStartPayload
      const entry = this.turnResults.get(stored.runId)
      this.skipUnstartableTurn(entry?.payload ?? stored, entry, engine.getRun(runId) ?? run)
    }
    return true
  }

  /** Titles for the notices this orchestrator writes. */
  private noticeContext(): NoticeContext {
    return {
      titleOf: (threadId) => this.titleOf(threadId),
      questionPrompts: (requestId) => this.questions.getPending(requestId)?.questions.map((question) => question.prompt) ?? null
    }
  }

  /**
   * A steer that missed its turn runs as the next turn. The inbox rows it carries move to the queue
   * item (`queue:<id>`), so exactly one delivery owns them at a time: the reconciler does not hand
   * them to a wake, and the item rebuilds its text from the rows that are still its own when it runs.
   */
  private enqueueLateSteer(threadId: string, text: string, carried?: { inboxIds: string[]; effectId: string }, subagentNotice?: SubagentNoticeItem[], runId?: string, origin?: AgentOrigin, permissionMode?: PermissionMode, sentFrom?: { node: string }): void {
    const content = text.trim()
    const session = this.getOrCreateSession(threadId)
    if (!content || session.deleted) return
    // Stamped with the generation of the run it was meant for, never the current one: the Stop fence must
    // still see a steer of an older run as older.
    const stopGeneration = runId && this.runEngine ? runStopGeneration(this.runEngine.store, runId) : undefined
    this.enqueueCarrying(threadId, { content, mode: getLastUserChatMode(session.messages) ?? 'agent' }, { source: 'steer-late', ...(stopGeneration !== undefined ? { stopGeneration } : {}), ...(origin ? { origin } : {}), ...(permissionMode ? { permissionMode } : {}), ...(sentFrom ? { sentFrom } : {}) }, carried ? [carried] : [], subagentNotice)
    if (session.isTurnRunning()) session.drainAfterSettle = true
    else this.scheduleQueueDrain(session)
  }

  /** Queues a turn that delivers notices: the rows it carries are its own until it runs or is removed. */
  private enqueueCarrying(
    threadId: string,
    input: OrchestratorSendInput,
    opts: { source: string; internal?: boolean; stopGeneration?: number; origin?: QueuedMessage['origin']; permissionMode?: PermissionMode; sentFrom?: QueuedMessage['sentFrom'] },
    carried: ReadonlyArray<{ inboxIds: string[]; effectId: string }>,
    subagentNotice: SubagentNoticeItem[] | undefined
  ): QueuedMessage {
    const inboxIds = carried.flatMap((entry) => entry.inboxIds)
    const item = this.enqueueForThread(threadId, input, { ...opts, ...(inboxIds.length ? { inboxIds, subagentNotice } : {}) })
    // Only rows the carrying steer still delivers move: one a wake took over in the meantime stays that wake's.
    for (const entry of carried) this.requireRunEngine().inbox.redirectDelivery(entry.inboxIds, queueOwner(item.id), entry.effectId)
    return item
  }

  /** A queue item that carried notices is gone without running: its rows are pending again, for rule 4. */
  private releaseQueuedRows(items: ReadonlyArray<QueuedMessage | null | undefined>, attempt = 1): void {
    const engine = this.runEngine
    if (!engine) return
    for (const item of items) {
      if (!item?.inboxIds?.length) continue
      try {
        const own = engine.inbox.getMany(item.inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === queueOwner(item.id))
        if (own.length) engine.inbox.release(own.map((row) => row.inboxId), queueOwner(item.id))
      } catch (error) {
        console.warn('queued notice rows could not be released', { itemId: item.id, attempt, error: error instanceof Error ? error.message : String(error) })
        // The item is gone and its rows belong to nothing that will ever run: they hold the tasks
        // waiting on this thread until they are given back, so the release is tried again. Only this
        // item's own rows move, so it cannot touch the rows of a turn that is running.
        if (attempt < QUEUED_ROW_RELEASE_ATTEMPTS && !this.lifecycle.stopping) {
          const retry = setTimeout(() => {
            this.releaseRetries.delete(retry)
            // A shutdown that began since owns the rows: boot gives back what is left.
            if (this.lifecycle.stopping) return
            this.releaseQueuedRows([item], attempt + 1)
          }, QUEUED_ROW_RELEASE_RETRY_MS)
          retry.unref?.()
          this.releaseRetries.add(retry)
        }
      }
    }
  }

  /** Enqueues a control effect, or runs `fallback` directly without effects or when the write fails. */
  private enqueueControlEffect(
    kind: 'turn.interrupt' | 'turn.steer',
    threadId: string,
    runId: string,
    payload: Record<string, unknown>,
    fallback: () => void
  ): void {
    if (this.effectsEnabled()) {
      try {
        this.requireRunEngine().outbox.enqueue({ threadId, runId, kind, payload })
        return
      } catch (error) {
        console.warn(`${kind} effect could not be recorded; applying it directly`, {
          runId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    fallback()
  }

  // ---------------------------------------------------------------------------------------------
  // Delegation (docs/run-engine/SPEC.md §14): children are threads with lineage, delegation is a
  // row, a child's completion is an inbox row written with its terminal run, and reconciler rule 4
  // wakes the parent. Every caller goes through `delegate_task`.

  /** Capabilities of the instance serving the thread's selected model (reconciler rule 4). */
  capabilitiesForThread(threadId: string): HarnessCaps | null {
    try {
      return this.resolvedForThread(threadId).caps
    } catch {
      return null
    }
  }

  /** The mode a thread was set to, else the profile default. */
  private storedPermissionMode(threadId: string): PermissionMode {
    return normalizePermissionMode(this.threadStore?.getThread(threadId)?.permissionMode ?? this.settingsStore.get().permissions.defaultMode)
  }

  /**
   * The narrowest permission mode on the thread's subagent lineage above it (each ancestor's own
   * mode, not only its parent's, so tightening a grandparent narrows the grandchild on its next
   * turn); `full` for a thread that is nobody's subagent. A fork starts a lineage of its own: it is
   * the user's thread, set from the source's mode. A lineage that cannot be read asks.
   */
  permissionCeilingFor(threadId: string): PermissionMode {
    const engine = this.runEngine
    if (!engine) return 'full'
    let ceiling: PermissionMode = 'full'
    const seen = new Set([threadId])
    try {
      let lineage = engine.delegations.getLineage(threadId)
      while (lineage && lineage.relationship === 'subagent' && !seen.has(lineage.parentThreadId)) {
        const parentId = lineage.parentThreadId
        seen.add(parentId)
        ceiling = narrowPermissionMode(ceiling, this.storedPermissionMode(parentId))
        lineage = engine.delegations.getLineage(parentId)
      }
    } catch (error) {
      console.warn('permission ceiling could not be read; asking', { threadId, error: error instanceof Error ? error.message : String(error) })
      return 'ask'
    }
    return ceiling
  }

  /**
   * The mode a new turn of the thread asks for: its own, never above its lineage's ceiling, and
   * tightened further by `override` (the internal send option a scheduled job uses; it can only tighten).
   */
  requestedPermissionMode(threadId: string, override?: PermissionMode): PermissionMode {
    return narrowPermissionMode(this.permissionCeilingFor(threadId), this.storedPermissionMode(threadId), override)
  }

  /**
   * A run that continues another (the resume after a usage-limit pause, a "Continue" after a restart, a turn a
   * provider started itself) never runs in a looser permission mode than the run it continues was bound to,
   * as it is never granted a wider agent access level (`continuedGrant`). So a turn an agent narrowed stays
   * narrowed when its work carries on, with no person's message in between. Undefined: the run continues
   * nothing, or the earlier run never bound a turn.
   */
  private continuedPermissionMode(runId: string | undefined, threadId: string): PermissionMode | undefined {
    if (!runId) return undefined
    try {
      const engine = this.runEngine
      const run = engine?.getRun(runId)
      if (!engine || !run) return undefined
      let earlier: RunRecord | null | undefined
      if (run.outcome?.continuationOf) {
        earlier = engine.getRun(run.outcome.continuationOf)
        // A continuation whose original cannot be read: the strictest mode, never the thread's own.
        if (!earlier) return 'ask'
      } else if (run.source === 'provider-continuation') {
        earlier = engine.listRuns(threadId).filter((candidate) => candidate.ordinal < run.ordinal).sort((a, b) => b.ordinal - a.ordinal)[0]
      }
      const binding = earlier ? engine.bindingForRun(earlier.runId) : undefined
      return binding ? binding.policy.permissionMode ?? 'ask' : undefined
    } catch {
      return 'ask'
    }
  }

  /** The send option's limit, tightened by what the run continues (`continuedPermissionMode`). */
  private limitedByContinuation(limit: PermissionMode | undefined, runId: string | undefined, threadId: string): PermissionMode | undefined {
    const continued = this.continuedPermissionMode(runId, threadId)
    return continued === undefined ? limit : narrowPermissionMode(limit, continued)
  }

  /**
   * A scheduled turn's limit, tightened by what its job holds now. An occurrence is admitted with the job's mode at
   * that moment; when the job is edited narrower before the run starts (it waits in the queue, or was recovered
   * after a restart), the run takes the narrower mode. A job's edit never widens a run that already has a limit.
   */
  private limitedByJob(limit: PermissionMode | undefined, schedule: ScheduledTurnRef | undefined): PermissionMode | undefined {
    if (!schedule) return limit
    let current: PermissionMode | undefined
    try {
      current = this.scheduledHooks?.currentPermissionRequest?.(schedule.jobId)
    } catch {
      // A job that cannot be read is not a reason to widen: the strictest mode.
      current = 'ask'
    }
    return current === undefined ? limit : narrowPermissionMode(limit, current)
  }

  /**
   * The mode a person holds when they create or edit a scheduled job: the mode of the thread the job is
   * bound to (its own, never above its lineage's ceiling), else the mode threads start in. Whatever
   * cannot be read asks. The job's ceiling is this value; no request carries one.
   */
  scheduledCreatorCeiling(threadId?: string): PermissionMode {
    try {
      if (threadId && this.threadStore?.getThread(threadId)) return this.requestedPermissionMode(threadId)
      return normalizePermissionMode(this.settingsStore.get().permissions.defaultMode)
    } catch (error) {
      console.warn('scheduled job ceiling could not be read; asking', { threadId, error: error instanceof Error ? error.message : String(error) })
      return 'ask'
    }
  }

  /**
   * Sets a thread's permission mode. A subagent's mode never exceeds its lineage's ceiling. Applies
   * from the next turn: a running turn and a pending approval are not touched.
   */
  setThreadPermissionMode(threadId: string, mode: PermissionMode, by?: { node: string; maxPermissionMode: PermissionMode }): Thread {
    const store = this.threadStore
    if (!store) throw new Error('Permission modes need the thread store')
    const thread = store.getThread(threadId)
    if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
    const ceiling = this.permissionCeilingFor(threadId)
    if (isStricter(ceiling, mode))
      throw new DomainRpcError('permission_mode_above_ceiling', `This subagent cannot run above ${describePermissionMode(ceiling)}: a thread it belongs to is set to it.`, { threadId, ceiling })
    // A person on another of the user's computers sets modes up to the limit this computer gave that device.
    if (by && isStricter(by.maxPermissionMode, mode))
      throw new DomainRpcError('permission_mode_above_ceiling', `The computer that runs this thread lets this device set ${describePermissionMode(by.maxPermissionMode)} at most. To allow more, raise the limit for this device on that computer, in Settings, Devices.`, { threadId, limit: by.maxPermissionMode, reason: 'device_limit' })
    const previous = thread.permissionMode
    const updated = store.updateThreadMeta(threadId, { permissionMode: mode }, { touch: false })
    try {
      this.runEngine?.store.appendEvent({ threadId, type: 'thread.permission_mode', payload: { from: previous ?? null, to: mode, ceiling, ...(by ? { node: by.node } : {}) } })
    } catch (error) {
      console.warn('permission mode change could not be recorded as an event', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
    return updated
  }

  /**
   * The thread's "Always for this thread" rules (SPEC §17.8), each with whether it applies at the
   * thread's mode now. A thread without the Run Engine has none.
   */
  listApprovalRules(threadId: string): ApprovalRuleInfo[] {
    const approvals = this.runEngine?.approvals
    if (!approvals) return []
    const mode = this.requestedPermissionMode(threadId)
    return approvals.listRules(threadId).map((rule) => approvalRuleInfo(rule, mode))
  }

  /** The thread's saved approval requests, oldest first, with the answers they got (the newest 200). */
  listApprovalRequests(threadId: string): ThreadApprovalRequest[] {
    return (this.runEngine?.approvals.listForThread(threadId) ?? []).map(threadApprovalRequest)
  }

  /** The "Always for this thread" rules that a person on the computer `node` made, in every thread. */
  listApprovalRulesMadeBy(node: string): Array<{ threadId: string; rule: ApprovalRuleInfo }> {
    return (this.runEngine?.approvals.listRulesMadeBy(node) ?? []).map((rule) => ({
      threadId: rule.threadId,
      rule: approvalRuleInfo(rule, this.requestedPermissionMode(rule.threadId))
    }))
  }

  /** Revokes one rule of the thread (by id) or all of them. Only this thread's rules are reachable. */
  clearApprovalRules(threadId: string, ruleId?: string): { removed: number } {
    const approvals = this.runEngine?.approvals
    return { removed: approvals ? approvals.revokeRules(threadId, ruleId) : 0 }
  }

  /** Revokes every "Always for this thread" rule that a person on the computer `node` made, or only the one named by `only`. */
  clearApprovalRulesMadeBy(node: string, only?: { threadId: string; ruleId: string }): number {
    return this.runEngine?.approvals.revokeRulesMadeBy(node, only ? { threadId: only.threadId, fingerprint: only.ruleId } : undefined) ?? 0
  }

  /**
   * The permission mode a run enforces, read from its attempt's binding (never from a mode ceiling).
   * A binding recorded before permission modes, and a run with no binding, read as `ask`.
   */
  runPermissionMode(runId: string): PermissionMode {
    let binding: ExecutionBinding | undefined
    try {
      binding = this.runEngine?.bindingForRun(runId)
    } catch {
      binding = undefined
    }
    if (!binding) return 'ask'
    return binding.policy.permissionMode ?? 'ask'
  }

  /**
   * The mode a new turn will run in, for the notice and the stamp on its message. A run that
   * already has a binding (a retry or recovery) keeps the binding's; a refused or unreadable
   * selection reads as the requested mode (the turn itself fails at admission).
   */
  private previewTurnPermission(session: ThreadSession, mode: ChatMode, opts?: { runId?: string; modelOverride?: ModelOverride; permissionMode?: PermissionMode; schedule?: ScheduledTurnRef }): PermissionMode {
    const requested = this.requestedPermissionMode(session.threadId, this.limitedByJob(this.limitedByContinuation(opts?.permissionMode, opts?.runId, session.threadId), opts?.schedule))
    try {
      const bound = opts?.runId ? this.runEngine?.bindingForRun(opts.runId) : undefined
      if (bound) return bound.policy.permissionMode ?? 'accept_edits'
      const instance = this.harness.resolveStored(this.turnSelection(session, mode, opts?.modelOverride), {
        purpose: 'turn',
        scope: this.threadScope(session.threadId)
      })
      const effective = this.harness.previewPermissionMode(instance, requested, session.projectCwd)
      return effective.refused ? requested : effective.mode
    } catch {
      return requested
    }
  }

  /** The instance serving the thread's selected model, disabled ones included (work already running). */
  private resolvedForThread(threadId: string): ResolvedTurnSelection {
    const session = this.boundSession.threadId === threadId ? this.boundSession : this.sessions.get(threadId)
    const explicit = session?.modelOverride ?? this.threadStore?.getThread(threadId)?.modelOverride
    return this.harness.resolveStored(explicit ?? this.defaultAgentModel(), { purpose: 'turn', allowDisabled: true })
  }

  private defaultAgentModel(): ModelOverride {
    return this.harness.instanceMap.migrate(resolveModelForMode(this.settingsStore.get(), 'agent', [
      ...(this.providerAuth.credentials?.listProviderIds() ?? []),
      ...this.harness.configuredProviderIds()
    ]))
  }

  /** The scope a thread's selection resolves in: its project's overrides, else the device. */
  private threadScope(threadId: string): ProviderScope {
    const projectId = this.threadStore?.getThread(threadId)?.projectId
    return projectId ? { kind: 'project', projectId } : { kind: 'device' }
  }

  /**
   * The execution binding of a turn: the one its run already recorded (a retry or restart of the
   * run; `resolved` was built from it), else a new one from the resolved selection. Either way it
   * is recorded on the active attempt, so a replacement attempt keeps its run's binding.
   */
  private async bindTurn(runId: string | undefined, existing: ExecutionBinding | undefined, resolved: ResolvedTurnSelection, mode: ChatMode, origin: () => TurnOrigin, permission: Pick<BindInput, 'permissionMode' | 'cwd' | 'approvals'>, policy?: BindPolicy, definition = false): Promise<ExecutionBinding> {
    const engine = this.runEngine
    // The origin is read only for a new binding: a retry or restart keeps the one its run recorded.
    // A bot dispatch binds the policy its grant compiled to, as a bot; a definition turn binds its
    // definition's policy with its own origin. Either way in the strictest mode: the grant or the
    // definition's own approval rules, never a thread's permission mode, decide what it may do.
    const binding = existing ?? await this.harness.bind(resolved, policy
      ? { mode, origin: definition ? origin() : 'bot', policy, permissionMode: 'ask', ...(permission.cwd !== undefined ? { cwd: permission.cwd } : {}) }
      : { mode, origin: origin(), ...permission })
    if (runId && engine) {
      try {
        return engine.recordExecutionBinding(runId, binding)
      } catch (error) {
        console.warn('execution binding could not be recorded', { runId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    return binding
  }

  /**
   * How a new binding answers tool approvals. A channel turn passes `never` (`CHANNEL_POLICY`),
   * whatever the thread's permission mode grants. A provider continuation (a background task the
   * runtime finished later) keeps `never` when the thread's previous binding had it, since nobody in
   * the channel can answer either.
   */
  private turnApprovals(threadId: string, runId: string | undefined, opts?: { approvals?: RunPolicy['approvals']; source?: string }): Pick<BindInput, 'approvals'> {
    if (opts?.approvals) return { approvals: opts.approvals }
    if (opts?.source !== 'provider-continuation' || !runId) return {}
    return this.runEngine?.previousBinding(threadId, runId)?.policy.approvals === 'never' ? { approvals: 'never' } : {}
  }

  /**
   * Who a thread's turn runs for: a bot (any bot thread, ahead of its lineage), a workflow step, a
   * delegated child (its lineage), or a person. The binding records it, so retries, continuations
   * and steers of the turn keep it. An unreadable bot index fails the turn rather than binding a
   * bot thread as the person's own.
   */
  private turnOrigin(threadId: string, workflowInvocationId?: string): TurnOrigin {
    const botRole = this.botThreads?.roleOf(threadId)
    let lineage: string | undefined
    try {
      lineage = this.runEngine?.delegations.getLineage(threadId)?.relationship
    } catch {
      // No lineage readable: the thread is the person's own.
    }
    return threadTurnOrigin({ ...(botRole ? { botRole } : {}), workflow: Boolean(workflowInvocationId), ...(lineage ? { lineage } : {}) })
  }

  /** The parent's workspace path a `shared` child observes, or null when the parent has none. */
  private sharedWorkspaceOf(parentThreadId: string): ThreadSession['sharedWorkspace'] {
    const parent = this.getOrCreateSession(parentThreadId)
    const path = parent.sharedWorkspace?.path ?? parent.workspace?.projectPath ?? parent.projectCwd
    return path ? { path, parentThreadId } : null
  }

  /**
   * Engine host callback (before the delegation transaction; synchronous): the child thread gets the
   * parent's project and model selection, or the requested provider/model.
   */
  private createChildThread(request: DelegationRequest): { threadId: string } {
    if (!this.threadStore) throw new Error('Delegation requires the thread store')
    const parentThread = this.threadStore.getThread(request.parentThreadId)
    if (!parentThread) throw new Error(`Thread not found: ${request.parentThreadId}`)
    const parent = this.getOrCreateSession(request.parentThreadId)
    const title = request.title?.trim() || `Delegated: ${request.prompt.trim().split('\n')[0].slice(0, 60)}`
    const inherited = this.harness.instanceMap.migrate(parent.modelOverride ?? undefined)
    const base = (): ModelOverride => inherited ?? this.defaultAgentModel()
    // The requested instance (already resolved by `delegateTask`) or the parent's. Resolved before the
    // thread exists, so an unknown instance fails loudly without leaving an orphaned thread.
    const override = request.instanceId || request.model
      ? this.harness.instanceMap.overrideFor({
          ...(request.instanceId ? { instanceId: request.instanceId } : { instanceId: base().instanceId, llmProvider: base().llmProvider }),
          model: request.model ?? base().model
        })
      : inherited
    // What the child runs on is fixed now: with no explicit selection it would otherwise follow the
    // global default (or the parent's session) at every later turn.
    const effective = override ?? this.defaultAgentModel()
    const model = effective.model?.trim() && (effective.instanceId?.trim() || effective.llmProvider?.trim()) ? structuredClone(effective) : undefined
    const shared = request.workspace === 'shared' ? this.sharedWorkspaceOf(request.parentThreadId) : null
    const child = this.threadStore.createThread(title, parentThread.projectId, undefined, {
      lineage: lineageForChild(parentThread),
      ownerThreadId: parentThread.id,
      workspaceBinding: { policy: request.workspace === 'shared' ? 'shared' : 'isolated', ...(shared ? { sharedPath: shared.path } : {}) },
      // A child starts at the narrowest of its lineage's ceiling, the parent's saved mode and the mode
      // the delegating run actually enforces (its binding: a provider may have lowered the saved
      // mode, and a per-turn option may have tightened it). It never starts wider than the run that
      // delegated it, and it keeps that mode for its later turns and its own subagents.
      permissionMode: narrowPermissionMode(this.requestedPermissionMode(request.parentThreadId), this.runPermissionMode(request.parentRunId)),
      ...(model ? { modelOverride: model } : {})
    })
    const session = this.getOrCreateSession(child.id)
    session.modelOverride = model ? structuredClone(model) : undefined
    if (shared) session.sharedWorkspace = shared
    return { threadId: child.id }
  }

  /**
   * Engine host callback: the delegation or fork transaction that would have owned `threadId`
   * failed, so the thread `createThread` just made is removed with its in-memory session.
   */
  private discardCreatedThread(threadId: string): void {
    this.sessions.delete(threadId)
    this.threadStore?.discardUnusedThread(threadId)
  }

  /**
   * Issue #142: the policy every turn of a delegated child carries (first or resumed); undefined
   * for a thread that is not a subagent. A `shared` child is read-only.
   */
  private childTurnPolicy(session: ThreadSession): ChildTurnPolicy | undefined {
    if (session.sharedWorkspace) return { readOnly: true }
    try {
      return this.runEngine?.delegations.getLineage(session.threadId)?.relationship === 'subagent' ? { readOnly: false } : undefined
    } catch {
      return undefined
    }
  }

  /** Whether `threadId` is a read-only (`shared`) delegated child; its Mousse tools may not write threads. */
  private isReadOnlyChild(threadId: string): boolean {
    return Boolean(this.getOrCreateSession(threadId).sharedWorkspace)
  }

  /**
   * Issue #142 preflight, before any thread is created: a target whose provider cannot hold a
   * child to its policy gets a structured refusal instead of a child it could not keep read-only.
   * `instanceId` is the requested instance; without one the child runs on the parent's selection.
   */
  private async delegationRefusal(parentThreadId: string, instanceId: string | undefined, workspace: 'shared' | 'isolated') {
    let target: ResolvedTurnSelection
    try {
      target = instanceId
        ? this.harness.resolveStored({ instanceId, llmProvider: '', model: '' }, { purpose: 'delegate_task' })
        : this.resolvedForThread(parentThreadId)
    } catch {
      // An unresolvable target fails loudly when the child is created, as before.
      return null
    }
    const refusal = await this.targetRefusal(target, workspace, this.sharedWorkspaceOf(parentThreadId)?.path ?? null)
    return refusal ? { started: false as const, ...refusal } : null
  }

  /** The static check of the instance's capabilities, then the instance's look at the user's setup. */
  private async targetRefusal(target: ResolvedTurnSelection, workspace: 'shared' | 'isolated', cwd: string | null): Promise<SubagentRefusal | null> {
    return subagentTargetRefusal(target.caps, target.driver, workspace)
      ?? await this.harness.childPreflight(target.instanceId, { workspace, cwd })
  }

  /**
   * SPEC §14.2: a delegated child keeps the workspace policy its delegation recorded. A session
   * built from storage (after a restart, or once evicted) reads it back, so a `shared` read-only
   * child still observes its parent's workspace under `SHARED_READER_POLICY`.
   */
  private restoreDelegatedWorkspace(session: ThreadSession): void {
    const engine = this.runEngine
    if (!engine || session.sharedWorkspace) return
    try {
      const lineage = engine.delegations.getLineage(session.threadId)
      if (lineage?.relationship !== 'subagent') return
      // A child created with a recorded binding keeps exactly that; older children fall back to the
      // delegation row and the parent's current workspace.
      const binding = this.threadStore?.getThread(session.threadId)?.workspaceBinding
      if (binding) {
        if (binding.policy === 'shared' && binding.sharedPath) session.sharedWorkspace = { path: binding.sharedPath, parentThreadId: lineage.parentThreadId }
        return
      }
      const policy = engine.delegations.listForChildThread(session.threadId).filter((delegation) => delegation.workspace).at(-1)
      if (policy?.workspace === 'shared') session.sharedWorkspace = this.sharedWorkspaceOf(lineage.parentThreadId)
    } catch (error) {
      console.warn('delegated workspace policy could not be restored', {
        threadId: session.threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * A scheduled per-run thread on the project's own checkout keeps that binding: a session built from
   * storage (after a restart, or once evicted) reads it back, so its turns never provision a worktree.
   */
  private restoreScheduledWorkspace(session: ThreadSession): void {
    if (session.primaryCheckout || !this.threadStore || !this.projectManager) return
    if (this.threadStore.getThread(session.threadId)?.workspaceBinding?.policy !== 'primary') return
    try {
      const path = resolveThreadProjectPath(this.projectManager, this.threadStore, session.threadId)
      if (path) session.primaryCheckout = { path }
    } catch (error) {
      console.warn('scheduled workspace binding could not be restored', {
        threadId: session.threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
  }

  /**
   * Engine host callback for `thread.fork` (SPEC §16.2; before the fork transaction): the fork gets
   * the source's project, worktree mode and model selection. Its context arrives lazily, with its
   * first message.
   */
  private createForkThread(creation: Extract<ThreadCreation, { kind: 'fork' }>): { threadId: string } {
    if (!this.threadStore) throw new Error('Thread forks require the thread store')
    const sourceThread = this.threadStore.getThread(creation.sourceThreadId)
    if (!sourceThread) throw new Error(`Thread not found: ${creation.sourceThreadId}`)
    const source = this.getOrCreateSession(creation.sourceThreadId)
    const title = creation.title?.trim() || `Fork of ${sourceThread.name}`.slice(0, 120)
    // The fork keeps the source's limits and those of the agent that forks it (SPEC §15.1), stored on the
    // thread so every later turn applies them; a source with no limit of its own stores `manage`, which
    // leaves the profile's setting in charge. A source whose limits cannot be read is `lineage`.
    let sourceCeiling: AgentAccessLevel | undefined
    try {
      sourceCeiling = this.staticAccessCeiling(creation.sourceThreadId)
    } catch {
      sourceCeiling = 'lineage'
    }
    const accessCeiling = narrowAgentAccess(sourceCeiling ?? 'manage', creation.accessLevel === undefined ? undefined : this.effectiveAccess(creation.accessLevel)) ?? 'lineage'
    const fork = this.threadStore.createThread(title, sourceThread.projectId, undefined, {
      ...(sourceThread.worktreeEnabled === undefined ? {} : { worktreeEnabled: sourceThread.worktreeEnabled }),
      accessCeiling
    })
    const override = this.harness.instanceMap.migrate(source.modelOverride ?? sourceThread.modelOverride)
    if (override) this.threadStore.updateThreadMeta(fork.id, { modelOverride: structuredClone(override) })
    // The fork carries the mode the source may run in now: its own, narrowed by its lineage's ceiling
    // (a fork starts a lineage of its own, so a stale wider mode on a narrowed subagent must not
    // come back). A source that never chose a mode and has no ceiling follows the profile default.
    const ceiling = this.permissionCeilingFor(creation.sourceThreadId)
    if (sourceThread.permissionMode || ceiling !== 'full')
      this.threadStore.updateThreadMeta(fork.id, { permissionMode: this.requestedPermissionMode(creation.sourceThreadId) })
    const session = this.getOrCreateSession(fork.id)
    session.modelOverride = override ? structuredClone(override) : undefined
    return { threadId: fork.id }
  }

  /**
   * The thread's visible conversation as handoff items (SPEC §16.1), oldest first. Each item carries
   * the ordinal of the run it belongs to (from the message's `turnId`); messages before the first
   * known run have none. Markers, notes and hidden inputs are not conversation.
   */
  private handoffTranscript(threadId: string): HandoffItem[] {
    const engine = this.runEngine
    const items: HandoffItem[] = []
    let ordinal: number | null = null
    for (const message of this.getMessagesForPersistence(threadId)) {
      if (message.turnId) {
        const run = engine?.getRun(message.turnId)
        if (run && run.threadId === threadId) ordinal = run.ordinal
      }
      if (message.hidden || message.kind || (message.role !== 'user' && message.role !== 'assistant')) continue
      const text = message.content.trim()
      if (!text) continue
      items.push({
        runOrdinal: ordinal,
        role: message.role,
        text,
        ...(message.images?.length ? { attachments: { images: message.images.length } } : {})
      })
    }
    return items
  }

  /** The provider reference of the latest run before `runId` on the thread, when one was recorded. */
  private previousProviderRef(threadId: string, runId: string): ProviderRef | null {
    const engine = this.runEngine
    const current = engine?.getRun(runId)
    if (!engine || !current) return null
    for (const run of engine.listRuns(threadId)) {
      if (run.ordinal >= current.ordinal || !run.activeAttemptId) continue
      const ref = engine.store.getAttempt(run.activeAttemptId)?.providerRef
      if (ref) return ref
    }
    return null
  }

  /**
   * SPEC §16.1-§16.2: the handoffs this turn delivers. A pending fork transfer (the fork's first
   * message) resolves natively when the adapter can branch the source session, otherwise as a
   * `full_summary` of the source up to the fork point; otherwise a provider change since the
   * previous turn plans a switch handoff. A pending merge-back adds the fork's delta. Planning
   * failures are logged and the turn runs with its raw history.
   */
  private async planTurnHandoffs(input: {
    session: ThreadSession
    runId: string | undefined
    resolved: ResolvedTurnSelection
    selection: { llmProvider: string; model: string }
    previousModel: { provider: string; model: string } | undefined
    content: string
    images: ChatImageAttachment[] | undefined
    mode: ChatMode
    modelOverride: ThreadSession['modelOverride']
    /**
     * Set when planning failed and the turn keeps its raw history, and when a native fork branch was
     * made for this turn (its runtime resumes it, planned or not).
     */
    planning?: { failed: boolean; nativeFork?: boolean }
  }): Promise<TurnHandoffs | null> {
    const engine = this.runEngine
    const runId = input.runId
    if (!engine || !runId) return null
    const threadId = input.session.threadId
    const to: ProviderRef = { provider: input.selection.llmProvider, model: input.selection.model }
    const caps = input.resolved.caps
    const current = { text: input.content, ...(input.images?.length ? { attachments: { images: input.images.length } } : {}) }
    const planned: PlannedHandoff[] = []
    try {
      const capacity = this.nativeContext.nativeProviderModel
      const modelWindow = capacity?.selectedModel === to.model ? capacity?.contextWindow : undefined
      // A transfer whose history an earlier (aborted) turn already committed is consumed, not resent.
      const inTranscript = committedTransfers(this.nativeContext.messages)
      const pendingTransfer = (transfer: TransferRecord | undefined | null): TransferRecord | null =>
        transfer && !this.consumeCommittedTransfer(transfer, inTranscript, runId) ? transfer : null
      const fork = pendingTransfer(engine.transfers.listPending(threadId, 'fork')[0])
      if (fork) {
        const sourceRun = engine.getRun(String(fork.payload.sourceRunId ?? ''))
        const sourceRef = sourceRun?.activeAttemptId ? engine.store.getAttempt(sourceRun.activeAttemptId)?.providerRef ?? null : null
        let branched: ProviderRef | null = null
        if (forkStrategy(caps) === 'native' && sourceRef?.sessionId && sourceRef.provider === to.provider) {
          try {
            branched = await this.harness.forkSession(sourceRef, fork.sourceRunOrdinal, { threadId })
            if (branched?.sessionId && input.planning) input.planning.nativeFork = true
          } catch (error) {
            console.warn('native fork failed; using a portable handoff', { runId, error: error instanceof Error ? error.message : String(error) })
          }
        }
        planned.push(branched?.sessionId
          ? { kind: 'fork', transfer: fork, forkStrategy: 'native', plan: engine.handoffs.plan({ threadId, targetRunId: runId, from: branched, to: { ...to, sessionId: branched.sessionId }, caps }) }
          : {
              kind: 'fork',
              transfer: fork,
              forkStrategy: 'portable',
              plan: engine.handoffs.plan({
                threadId, targetRunId: runId, from: sourceRef, to, caps, current, modelWindow,
                sourceThreadId: fork.sourceThreadId, strategy: 'full_summary', throughOrdinal: fork.sourceRunOrdinal
              })
            })
      } else if (input.previousModel && input.previousModel.provider !== to.provider) {
        const from = this.previousProviderRef(threadId, runId) ?? { provider: input.previousModel.provider, model: input.previousModel.model }
        planned.push({ kind: 'switch', plan: engine.handoffs.plan({ threadId, targetRunId: runId, from, to, caps, current, modelWindow }) })
      }
      const merge = pendingTransfer(engine.pendingMergeBack(threadId))
      if (merge) {
        planned.push({
          kind: 'merge_back',
          transfer: merge,
          plan: engine.handoffs.plan({
            threadId, targetRunId: runId, from: null, to, caps, current, modelWindow,
            sourceThreadId: merge.sourceThreadId,
            strategy: 'fork_delta_summary',
            afterOrdinal: Number(merge.payload.fromOrdinal ?? 1) - 1,
            throughOrdinal: Number(merge.payload.toOrdinal ?? merge.sourceRunOrdinal),
            nativeTokens: 0
          })
        })
      }
    } catch (error) {
      if (input.planning) input.planning.failed = true
      console.warn('run engine handoff planning failed; the turn keeps its raw history', {
        runId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    return planned.length ? new TurnHandoffs(engine, planned, false) : null
  }

  /**
   * Idempotent transfer delivery (SPEC §16.2): when the canonical transcript already holds a pending
   * transfer's marked history (a turn committed it, then the consume write was lost), the transfer
   * is consumed now instead of injected twice. True when it was.
   */
  private consumeCommittedTransfer(transfer: TransferRecord, inTranscript: ReadonlyMap<string, { handoffId: string }>, runId: string): boolean {
    const marker = inTranscript.get(transfer.transferId)
    if (!marker) return false
    const engine = this.requireRunEngine()
    try {
      const handoff = engine.handoffs.get(marker.handoffId)
      engine.transfers.setStatus({
        transferId: transfer.transferId,
        from: 'pending',
        to: 'consumed',
        payloadPatch: { handoffId: marker.handoffId, consumedBy: handoff?.targetRunId ?? runId, repairedBy: runId }
      })
    } catch (error) {
      console.warn('run engine transfer repair failed', { transferId: transfer.transferId, error: error instanceof Error ? error.message : String(error) })
    }
    return true
  }

  /**
   * SPEC §16.2: a fork's first turn provisions the fork's own worktree at the source's code
   * checkpoint for the fork run, or at the source worktree's current HEAD when that run has none.
   * The seed is recorded on the fork transfer; failures are recorded and the fork provisions as usual.
   */
  /** The code checkpoint a source run left: its finished, non-conversation thread action. */
  private forkCheckpoint(sourceDir: string, sourceRunId: string) {
    return new ThreadActionService(sourceDir).list().find((action) => action.turnId === sourceRunId && action.scope !== 'conversation' && action.state !== 'running' && action.endSha)
  }

  /** SPEC §16.2 fork point (engine host): a source with a ready workspace needs a checkpoint at the run. */
  private forkPointSeed(sourceThreadId: string, sourceRunId: string): ForkPointSeed {
    const sourceDir = this.resolveThreadDir(sourceThreadId)
    if (!sourceDir) return 'none'
    if (new ThreadWorkspaceManager(sourceDir).load()?.lifecycle !== 'ready') return 'none'
    return this.forkCheckpoint(sourceDir, sourceRunId) ? 'checkpoint' : 'missing'
  }

  private async seedForkWorkspace(threadId: string, projectPath: string, threadDir: string, signal?: AbortSignal, lease?: ThreadSession['executionLease']): Promise<void> {
    const engine = this.runEngine
    const fork = engine?.transfers.listPending(threadId, 'fork')[0]
    if (!engine || !fork || fork.payload.seed) return
    const manager = new ThreadWorkspaceManager(threadDir)
    let seed: Record<string, unknown>
    try {
      if (manager.load()) seed = { kind: 'existing_workspace' }
      else if (!manager.resolveRepository(projectPath).capability.gitBacked) seed = { kind: 'not_git_backed' }
      else {
        const sourceDir = this.resolveThreadDir(fork.sourceThreadId)
        const sourceRunId = String(fork.payload.sourceRunId ?? '')
        const checkpoint = sourceDir ? this.forkCheckpoint(sourceDir, sourceRunId) : undefined
        const sourceWorkspace = sourceDir ? new ThreadWorkspaceManager(sourceDir).load() : undefined
        // M5: the source's current HEAD stands in for a missing checkpoint only when the fork
        // request accepted it (`seedFrom: 'current_head'`).
        const headAccepted = fork.payload.seedFrom === 'current_head'
        if (!checkpoint && sourceWorkspace?.lifecycle === 'ready' && !headAccepted)
          throw new Error('fork_point_unavailable: the fork point has no code checkpoint and the fork did not accept the current head')
        seed = checkpoint
          ? { kind: 'checkpoint', sha: checkpoint.endSha, actionId: checkpoint.id }
          : sourceWorkspace?.lifecycle === 'ready'
            ? { kind: 'source_head', sha: actionGit(sourceWorkspace.worktreePath, ['rev-parse', 'HEAD']) }
            : { kind: 'primary_head' }
        // A checkpoint is a snapshot: the fork's worktree is made at the commit the snapshot was taken on (the source's
        // HEAD then) and the snapshot's files are written over it, so no snapshot commit becomes the fork's branch.
        const seedHead = checkpoint ? snapshotOrigin(sourceWorkspace?.worktreePath ?? projectPath, checkpoint.endSha).head : undefined
        await manager.provision(threadId, 'main', projectPath, signal, lease ?? undefined, checkpoint ? seedHead : typeof seed.sha === 'string' ? seed.sha : undefined, checkpoint ? { snapshot: checkpoint.endSha } : {})
      }
    } catch (error) {
      seed = { kind: 'failed', error: error instanceof Error ? error.message : String(error) }
      console.warn('fork workspace seed failed; the fork provisions from the primary checkout', { threadId, error: seed.error })
    }
    try {
      engine.transfers.patchPayload(fork.transferId, { seed })
    } catch (error) {
      console.warn('fork seed could not be recorded', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * The transcript markers of this turn's handoffs (SPEC §16.1: "context rebuilt (N of M items)"):
   * the provider-switch marker gains the handoff artifact; a fork's first message and a merge-back
   * each get their own marker.
   */
  private recordHandoffMarkers(
    session: ThreadSession,
    handoffs: TurnHandoffs,
    switchMarker: ChatMessage | undefined,
    turnId: string,
    selection: { llmProvider: string; model: string }
  ): void {
    const to = { provider: selection.llmProvider, model: selection.model }
    for (const entry of handoffs.planned) {
      const { plan } = entry
      const artifact = {
        handoffId: plan.handoffId,
        strategy: plan.strategy,
        selectedItems: plan.record.selectedItems,
        omittedItems: plan.record.omittedItems
      }
      if (entry.kind === 'switch') {
        if (!switchMarker?.contextHandoff) continue
        switchMarker.contextHandoff = { ...switchMarker.contextHandoff, ...artifact }
        this.emitMessageUpdated(switchMarker)
        continue
      }
      const from = plan.record.fromRef
      const sourceName = this.threadStore?.getThread(plan.sourceThreadId)?.name ?? plan.sourceThreadId
      const marker: ChatMessage = {
        id: uuidv4(),
        role: 'assistant',
        kind: 'context_handoff',
        content: entry.kind === 'fork' ? `Forked from ${sourceName}` : `Merged back from ${sourceName}`,
        contextHandoff: {
          from: { provider: from?.provider ?? to.provider, model: from?.model ?? to.model },
          to,
          ...artifact,
          transfer: entry.kind
        },
        timestamp: new Date().toISOString(),
        turnId
      }
      session.messages.push(marker)
      this.emitMessageAdded(marker)
    }
    this.persist(true)
  }

  /**
   * Working directories of other threads' live turns (SPEC §16.3 restore safety): a turn running in
   * a path a restore would rewrite makes that restore unsafe.
   */
  liveWorkspaceClaims(excludeThreadId?: string): Array<{ threadId: string; path: string; kind: 'live_cwd' }> {
    const claims: Array<{ threadId: string; path: string; kind: 'live_cwd' }> = []
    for (const session of new Set([this.boundSession, ...this.sessions.values()])) {
      if (session.threadId === excludeThreadId || session.threadId === '__unbound__' || !session.isTurnRunning()) continue
      const path = session.sharedWorkspace?.path ?? session.projectCwd
      if (path) claims.push({ threadId: session.threadId, path, kind: 'live_cwd' })
    }
    return claims
  }

  /** SPEC §16.2: queueing on a thread waiting for a merge-back is refused until its next turn consumes it. */
  assertQueueOpen(threadId: string): void {
    const pending = this.runEngine?.pendingMergeBack(threadId)
    if (pending)
      throw new DomainRpcError('merge_back_pending', `A merge-back from fork ${pending.sourceThreadId} waits for this thread's next turn; send directly to deliver it.`, { transferId: pending.transferId })
  }

  /**
   * The delegation tools of one parent run (SPEC §14.2 `ToolHost`), shared by the in-process pi
   * loop and the Mousse MCP server so both enforce the caller's ceiling the same way (SPEC §15.1):
   * a `plan` caller cannot start a `default` child or integrate (integration writes the workspace).
   */
  private delegationTools(session: ThreadSession, parentRunId: string, callerCeiling?: ModeCeiling, callerAccess?: AgentAccessLevel): DelegationToolHost {
    const parentThreadId = session.threadId
    const delegateTask = (input: DelegateTaskInput, call: DelegationToolCall) =>
      this.delegateTask(parentThreadId, parentRunId, input, call, callerCeiling, callerAccess)
    const continueSubagent = (input: { subagent: string; prompt: string }, call: DelegationToolCall) =>
      this.continueSubagent(parentThreadId, parentRunId, input, call, callerCeiling, callerAccess)
    const integrateDelegation = async (ref: SubagentRef, call: DelegationToolCall) => {
      if (this.isReadOnlyChild(parentThreadId))
        throw new McpToolError('mousse_read_only', 'Integration writes the workspace; a read-only subagent cannot integrate.')
      if (callerCeiling === 'plan')
        throw new McpToolError('mousse_ceiling_exceeded', 'Integration writes the workspace; a plan ceiling cannot integrate.')
      const task = this.resolveTask(parentThreadId, ref, 'finished')
      if (!task.ok) return task.refusal
      return this.integrateDelegation(parentThreadId, parentRunId, task.delegation.delegationId, call)
    }
    const listDelegations = () => this.listDelegations(parentThreadId)
    const named = (request: NamedAgentToolRequest): DelegateTaskInput => {
      const write = request.access === 'write'
      return {
        prompt: request.task,
        title: request.name,
        workspace: write ? 'isolated' : request.workspace ?? 'shared',
        role: write ? 'implement' : 'research',
        wake: 'always'
      }
    }
    return {
      delegateTask,
      continueSubagent,
      answerSubagent: (input) => this.answerSubagent(parentThreadId, parentRunId, input),
      taskStatus: (ref) => this.taskStatus(parentThreadId, ref),
      taskCancel: (ref) => this.taskCancel(parentThreadId, ref),
      listDelegations,
      listSubagents: () => this.listSubagents(parentThreadId),
      integrateDelegation,
      named: {
        create: async (request, call) => ({ name: request.name, ...(await delegateTask(named(request), call)) }),
        createBatch: async (requests, call) => {
          if (requests.length === 0 || requests.length > NAMED_BATCH_LIMIT)
            throw new Error(`Named batches start 1–${NAMED_BATCH_LIMIT} assignments`)
          const results: unknown[] = []
          for (const [index, request] of requests.entries()) {
            try {
              results.push({ name: request.name, ...(await delegateTask(named(request), { toolCallId: `${call.toolCallId}:${index}` })) })
            } catch (error) {
              results.push({ name: request.name, error: error instanceof Error ? error.message : String(error) })
            }
          }
          return { results }
        },
        // The older name for `continue_subagent`.
        recall: async (request, call) => ({ name: request.agent, ...(await continueSubagent({ subagent: request.agent, prompt: request.task }, call) as object) }),
        integrate: ({ agent }, call) => integrateDelegation({ subagent: agent }, call)
      }
    }
  }

  private async delegateTask(parentThreadId: string, parentRunId: string, input: DelegateTaskInput, call: DelegationToolCall, callerCeiling?: ModeCeiling, callerAccess?: AgentAccessLevel) {
    const engine = this.requireRunEngine()
    if (!this.effectsEnabled()) throw new Error('Delegation needs the run engine worker')
    // SPEC §15.1: a child inherits its caller's ceiling and can never exceed it.
    if (callerCeiling === 'plan' && input.modeCeiling === 'default')
      throw new McpToolError('mousse_ceiling_exceeded', 'A plan-ceiling caller cannot start a child with the default ceiling.')
    const modeCeiling = narrowCeiling(callerCeiling, input.modeCeiling)
    // The same for the agent access level (SPEC §15.1): the child is granted the caller's level as it
    // stands now (its grant narrowed by the profile setting), never one the model chose.
    const accessLevel = this.effectiveAccess(callerAccess ?? 'lineage')
    const role = input.role?.trim() || undefined
    if (input.workspace === 'shared' && !(role && SHARED_WORKSPACE_ROLES.has(role)))
      throw new Error('workspace "shared" is allowed only for read-only roles (role "research" or "review"); use workspace "isolated" for work that edits, builds or tests.')
    // SPEC §13.8: the child names an instance; an older `provider` name is mapped to one. An unknown
    // or disabled instance fails the tool call here, before any thread is created.
    const requested = input.instanceId?.trim() || input.provider?.trim()
    const instanceId = requested
      ? this.harness.resolveStored(
          { instanceId: input.instanceId?.trim() || this.harness.instanceMap.instanceIdForLegacyProvider(requested), llmProvider: '', model: input.model?.trim() ?? '' },
          { purpose: 'delegate_task', scope: this.threadScope(parentThreadId) }
        ).instanceId
      : undefined
    // A read-only subagent may start subagents, but only read-only ones: authority only narrows down the tree.
    if (input.workspace !== 'shared' && this.isReadOnlyChild(parentThreadId))
      return { started: false as const, code: 'read_only_caller_requires_shared' as const, message: 'You are a read-only subagent, so your own subagents must be read-only too: start them with workspace "shared" and role "research" or "review".' }
    const refusal = await this.delegationRefusal(parentThreadId, instanceId, input.workspace)
    if (refusal) return refusal
    const title = input.title?.trim() || undefined
    let accepted: Awaited<ReturnType<RunEngine['requestDelegation']>>
    try {
      accepted = await engine.requestDelegation({
        parentThreadId,
        parentRunId,
        clientRequestId: delegationRequestKey(parentThreadId, parentRunId, call.toolCallId),
        prompt: input.prompt,
        instanceId,
        model: input.model?.trim() || undefined,
        role,
        workspace: input.workspace,
        wake: input.wake ?? 'always',
        title,
        ...(modeCeiling ? { modeCeiling } : {}),
        accessLevel
      })
    } catch (error) {
      // A retry already replayed its receipt; what is left is a title that belongs to another subagent.
      if (error instanceof TitleTakenRejection) return this.titleTakenValue(parentThreadId, error)
      if (error instanceof CommandRejection && error.reason === 'parent_stopping')
        return { started: false as const, code: 'parent_stopping' as const, message: error.message }
      throw error
    }
    return {
      delegationId: accepted.delegationId,
      childThreadId: accepted.childThreadId,
      childRunId: accepted.childRunId,
      title: this.titleOf(accepted.childThreadId) ?? title ?? null,
      ...(accepted.replayed ? { replayed: true } : {}),
      note: 'Started. Mousse sends you the result when it finishes; end your turn.'
    }
  }

  /** The value `delegate_task` returns when its title belongs to another of the caller's subagents. */
  private titleTakenValue(parentThreadId: string, taken: TitleTakenRejection) {
    const existing = taken.childThreadIds.map((childThreadId) => {
      const row = this.subagentView(parentThreadId).find((subagent) => subagent.childThreadId === childThreadId)
      return { childThreadId, title: this.titleOf(childThreadId) ?? taken.title, state: row?.state ?? 'unknown', latestDelegationId: row?.latestDelegationId ?? null }
    })
    return {
      started: false as const,
      code: 'title_taken' as const,
      title: taken.title,
      existing,
      message: `You already have a subagent titled "${taken.title}" (${existing[0]?.state ?? 'unknown'}). Use continue_subagent with that title to give it more work, or start a new subagent under a different title.`
    }
  }

  /** The rows of `subagents.list` for one thread: what each subagent is doing and how its tasks ended. */
  private subagentView(parentThreadId: string) {
    const engine = this.requireRunEngine()
    return buildSubagentView({
      delegations: engine.delegations,
      inbox: engine.inbox,
      store: engine.store,
      thread: (threadId) => this.threadStore?.getThread(threadId),
      hasPendingQuestion: (threadId) => this.questions.listPendingForThread(threadId).length > 0
    }, parentThreadId)
  }

  private titleOf(threadId: string): string | undefined {
    return this.threadStore?.getThread(threadId)?.name
  }

  private addressSources(): SubagentAddressSources {
    return { delegations: this.requireRunEngine().delegations, titleOf: (threadId) => this.titleOf(threadId) }
  }

  /** The caller's subagents holding `title`, normalized (engine host callback and the rename guard). */
  private subagentTitleConflicts(parentThreadId: string, title: string): string[] {
    return subagentsTitled(this.addressSources(), parentThreadId, title)
  }

  /**
   * Titles are the address of a subagent, so a rename may not give one subagent another's title.
   * Installed on the thread store; every rename path goes through it.
   */
  private installTitleGuard(): void {
    this.threadStore?.setNameGuard((thread, name) => {
      let lineage: ReturnType<RunEngine['delegations']['getLineage']> = null
      try {
        lineage = this.runEngine?.delegations.getLineage(thread.id) ?? null
      } catch {
        return
      }
      if (lineage?.relationship !== 'subagent') return
      const taken = this.subagentTitleConflicts(lineage.parentThreadId, name).filter((threadId) => threadId !== thread.id)
      if (taken.length)
        throw new DomainRpcError('title_taken', `Another subagent of the same thread is already titled "${name}".`, { title: name, threadIds: taken })
    })
  }

  /** `continue_subagent` and `answer_subagent` act only on the caller's own direct subagent. */
  private resolveSubagentTarget(parentThreadId: string, ref: string) {
    const resolved = resolveSubagent(this.addressSources(), parentThreadId, ref)
    return resolved.ok ? resolved : { ok: false as const, refusal: { started: false as const, code: resolved.code, message: resolved.message, ...(resolved.candidates ? { candidates: resolved.candidates } : {}) } }
  }

  /**
   * `continue_subagent`: a follow-up on the subagent's own thread. It runs in the subagent's native
   * session (the thread, provider, model and workspace never change), so what it read stays warm.
   * The run and its delegation row are one transaction. A busy subagent runs the follow-up after its
   * current task; one waiting for an answer is never auto-rejected, the caller gets the question.
   */
  private async continueSubagent(
    parentThreadId: string,
    parentRunId: string,
    input: { subagent: string; prompt: string },
    call: DelegationToolCall,
    callerCeiling?: ModeCeiling,
    callerAccess?: AgentAccessLevel
  ) {
    const engine = this.requireRunEngine()
    if (!this.effectsEnabled()) throw new Error('Delegation needs the run engine worker')
    const target = this.resolveSubagentTarget(parentThreadId, input.subagent)
    if (!target.ok) return target.refusal
    const childThreadId = target.childThreadId
    const requestId = followUpRequestKey(parentThreadId, parentRunId, call.toolCallId)
    // A retry of an accepted follow-up returns that task, whatever the subagent is doing now.
    const prior = engine.store.getReceipt(requestId)
    if (prior?.status === 'accepted' && prior.threadId === childThreadId) {
      const runId = String((prior.result as { runId?: unknown } | null)?.runId ?? '')
      const task = engine.delegations.getByChildRun(runId)
      if (task) return this.followUpValue(task, target.title, { replayed: true })
    }
    const pending = this.questions.listPendingForThread(childThreadId)
    if (pending.length)
      return {
        started: false as const,
        code: 'needs_answer' as const,
        subagent: target.title,
        childThreadId,
        questions: pending.map(({ requestId: id, questions }) => ({ requestId: id, questions })),
        message: `"${target.title}" is waiting for an answer, so it cannot take new work. Answer it with answer_subagent (or ask the user), then continue it.`
      }
    if (engine.getRun(parentRunId)?.outcome?.stopRequested)
      return { started: false as const, code: 'parent_stopping' as const, message: 'The calling run is being stopped; it cannot continue subagents.' }
    // The follow-up is bound by the subagent's own policy and the caller's authority, whichever is narrower.
    const tasks = engine.delegations.listForChildThread(childThreadId)
    const first = tasks.find((task) => task.parentThreadId === parentThreadId)
    const modeCeiling = narrowCeiling(callerCeiling, first?.modeCeiling)
    // And the access level: the narrower of the caller's now and the narrowest level any earlier task of
    // this subagent was given (a row from before levels existed is `lineage`).
    const accessLevel = narrowAgentAccess(this.effectiveAccess(callerAccess ?? 'lineage'), narrowestAccess(tasks)) ?? 'lineage'
    let response: OrchestratorResponse
    try {
      response = await this.send({ content: input.prompt, mode: modeCeiling === 'plan' ? 'plan' : 'agent' }, false, {
        threadId: childThreadId,
        source: 'delegation',
        clientRequestId: requestId,
        awaitMode: 'ack',
        // The follow-up never runs in a looser permission mode than the run that sends it: an existing
        // subagent is no way around the mode a caller's own turn was narrowed to (a new one starts at it).
        permissionMode: this.runPermissionMode(parentRunId),
        delegation: {
          parentThreadId,
          parentRunId,
          prompt: input.prompt,
          wake: 'always',
          ...(modeCeiling ? { modeCeiling } : {}),
          accessLevel,
          workspace: first?.workspace,
          role: first?.role,
          provider: first?.provider,
          model: first?.model
        }
      })
    } catch (error) {
      if (error instanceof CommandRejection && error.reason === 'parent_stopping')
        return { started: false as const, code: 'parent_stopping' as const, message: error.message }
      throw error
    }
    const task = response.runId ? engine.delegations.getByChildRun(response.runId) : null
    if (!task) throw new Error('The follow-up was not recorded as a task')
    return this.followUpValue(task, target.title, response.queued ? { queued: true } : {})
  }

  private followUpValue(task: DelegationRecord, title: string, extra: { queued?: boolean; replayed?: boolean }) {
    return {
      delegationId: task.delegationId,
      childThreadId: task.childThreadId,
      childRunId: task.childRunId,
      title,
      status: extra.queued ? 'queued' : 'started',
      ...(extra.replayed ? { replayed: true } : {}),
      note: extra.queued
        ? `"${title}" is busy; the follow-up runs after its current task. Mousse sends you the result; end your turn.`
        : 'Started. Mousse sends you the result when it finishes; end your turn.'
    }
  }

  /**
   * `answer_subagent`: the answer of a question one of the caller's subagents asked, in the shape the
   * GUI answers with. The request must be pending on that subagent's thread.
   */
  private answerSubagent(parentThreadId: string, parentRunId: string, input: { subagent: string; requestId: string; answers: Record<string, string | string[]> }) {
    const target = this.resolveSubagentTarget(parentThreadId, input.subagent)
    if (!target.ok) return { answered: false as const, ...target.refusal }
    const pending = this.questions.getPending(input.requestId)
    if (!pending || pending.threadId !== target.childThreadId)
      return {
        answered: false as const,
        code: 'no_such_question' as const,
        message: `"${target.title}" has no pending question ${input.requestId}; it may have been answered or dismissed already.`
      }
    // An approval (a command, a file change, a tool) is answered only within the caller's own
    // permission mode; `settle` applies `canAnswerApproval`. A plain question is answered as before.
    const settled = this.questions.settle(input.requestId, input.answers, { kind: 'agent', threadId: parentThreadId, runId: parentRunId, permissionMode: this.runPermissionMode(parentRunId) })
    if (!settled.ok) {
      if (settled.reason === 'unknown' || settled.reason === 'already_answered' || settled.reason === 'cancelled')
        return { answered: false as const, code: 'no_such_question' as const, message: `Question ${input.requestId} was answered or dismissed first.` }
      const code = settled.reason === 'answerer_required' ? 'not_parent' : settled.reason
      return { answered: false as const, code, message: `"${target.title}" asked for an approval you cannot give. ${describeApprovalRefusal(code)}` }
    }
    // As in the GUI: the model gets the answers as the tool result; the transcript shows what was said.
    this.recordQuestionResponseMessage(target.childThreadId, formatQuestionAnswersMessage(pending.questions, input.answers))
    return { answered: true as const, subagent: target.title, childThreadId: target.childThreadId, requestId: input.requestId }
  }

  private ownedDelegation(parentThreadId: string, delegationId: string): DelegationRecord {
    const delegation = this.requireRunEngine().delegations.get(delegationId)
    if (!delegation || delegation.parentThreadId !== parentThreadId)
      throw new Error(`Unknown delegation ${delegationId} for this thread`)
    return delegation
  }

  /**
   * The task a tool call names. A `delegationId` must be the caller's; a `subagent` is resolved to the
   * caller's direct subagent and its latest task (`finished`: its latest task that completed). A name that
   * resolves to nothing is a refusal value, not an error.
   */
  private resolveTask(parentThreadId: string, ref: SubagentRef, which: 'latest' | 'finished' = 'latest') {
    if (ref.delegationId) return { ok: true as const, delegation: this.ownedDelegation(parentThreadId, ref.delegationId) }
    const target = this.resolveSubagentTarget(parentThreadId, ref.subagent ?? '')
    if (!target.ok) return { ok: false as const, refusal: target.refusal }
    const tasks = this.requireRunEngine().delegations.listForChildThread(target.childThreadId).filter((task) => task.parentThreadId === parentThreadId)
    const pick = which === 'finished'
      ? tasks.filter((task) => (task.status === 'result_available' || task.status === 'acknowledged') && task.result?.runStatus === 'completed').at(-1)
      : tasks.at(-1)
    if (!pick)
      return { ok: false as const, refusal: { started: false as const, code: 'no_task' as const, message: which === 'finished' ? `"${target.title}" has no completed task to integrate yet.` : `"${target.title}" has no task.` } }
    return { ok: true as const, delegation: pick }
  }

  private taskStatus(parentThreadId: string, ref: SubagentRef) {
    const engine = this.requireRunEngine()
    const task = this.resolveTask(parentThreadId, ref)
    if (!task.ok) return task.refusal
    const delegationId = task.delegation.delegationId
    let delegation = task.delegation
    if (delegation.status === 'result_available' || delegation.status === 'failed') delegation = engine.acknowledgeDelegation(delegationId)
    const row = this.subagentView(parentThreadId).find((subagent) => subagent.childThreadId === delegation.childThreadId)
    const pending = this.questions.listPendingForThread(delegation.childThreadId)
    return {
      delegationId,
      childThreadId: delegation.childThreadId,
      title: this.titleOf(delegation.childThreadId) ?? null,
      status: delegation.status,
      childRunStatus: engine.getRun(delegation.childRunId)?.status ?? null,
      ...(row ? { state: row.state } : {}),
      // A task whose subagent is waiting on its own subagents is still `running`; it has no result yet.
      ...(row?.tasks.find((entry) => entry.delegationId === delegationId)?.outcome === 'waiting_for_subagents'
        ? { workState: 'waiting_for_subagents' as const, waitingOn: row.waitingOn }
        : {}),
      ...(pending.length ? { pendingQuestion: pending.map(({ requestId, questions }) => ({ requestId, questions })) } : {}),
      ...(delegation.result ? { result: delegation.result } : {})
    }
  }

  /**
   * `task_cancel` is a Stop of the subagent (`stopThread`): it ends the subagent's work and everything
   * the subagent started. The caller asked, so it gets no notice row for it. A task whose result the
   * caller has not read yet is the exception: naming it explicitly drops that result, as before.
   */
  private async taskCancel(parentThreadId: string, ref: SubagentRef) {
    const engine = this.requireRunEngine()
    if (ref.delegationId) {
      const task = this.ownedDelegation(parentThreadId, ref.delegationId)
      // A task that is still running stops its subagent. A cancelled one stops it again only while the run
      // that task started is still live (a repeat after a partial failure): once that run ended, whatever the
      // subagent does now is newer work (a follow-up) that a repeated cancel must not touch.
      if (task.status === 'running' || (task.status === 'cancelled' && this.isRunLive(task.childRunId))) {
        const stopped = await this.stopThread(task.childThreadId, 'task_cancel', { requesterThreadId: parentThreadId })
        return { delegationId: task.delegationId, status: engine.delegations.get(task.delegationId)?.status, cancelled: stopped.delegations }
      }
      if (task.status === 'cancelled') return { delegationId: task.delegationId, status: task.status, cancelled: [] }
      const cancelled = await engine.cancelDelegation(task.delegationId)
      return { delegationId: task.delegationId, status: engine.delegations.get(task.delegationId)?.status, cancelled }
    }
    // A subagent title cancels everything that subagent still has open.
    const target = this.resolveSubagentTarget(parentThreadId, ref.subagent ?? '')
    if (!target.ok) return target.refusal
    const tasks = engine.delegations.listForChildThread(target.childThreadId).filter((task) => task.parentThreadId === parentThreadId)
    const open = tasks.filter((task) => task.status === 'running')
    // Nothing is stopped when no task is open: a repeat must not touch newer work.
    if (open.length === 0)
      return { subagent: target.title, childThreadId: target.childThreadId, cancelled: [], note: `"${target.title}" has no open task.` }
    const stopped = await this.stopThread(target.childThreadId, 'task_cancel', { requesterThreadId: parentThreadId })
    return { subagent: target.title, childThreadId: target.childThreadId, cancelled: stopped.delegations }
  }

  private isRunLive(runId: string): boolean {
    const run = this.runEngine?.getRun(runId)
    return Boolean(run && !TERMINAL_RUN_STATUSES.has(run.status))
  }

  /**
   * Lineage's Stop all: a Stop of each subagent of `parentThreadId` that is still working, in one call. Each
   * one cascades to its own subagents; the parent's own turn keeps running (it is told, as for a row's Stop).
   */
  async stopSubagents(parentThreadId: string, reason = 'user'): Promise<{ ok: boolean; stopped: string[] }> {
    const running = this.subagentView(parentThreadId).filter(isRunningSubagent).map((row) => row.childThreadId)
    // A parent with no turn running is told nothing: the person who pressed the button is the one who asked.
    const requesterThreadId = this.runEngine?.getActiveRun(parentThreadId) ? undefined : parentThreadId
    const outcomes = await Promise.allSettled(running.map((childThreadId) => this.stopThread(childThreadId, reason, { requesterThreadId })))
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') console.warn('a subagent could not be stopped', { parentThreadId, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) })
    return { ok: outcomes.some((outcome) => outcome.status === 'fulfilled' && outcome.value.ok), stopped: running }
  }

  /** Cancels one of `parentThreadId`'s delegations and everything below it (host API and tests). */
  cancelDelegation(parentThreadId: string, delegationId: string) {
    return this.taskCancel(parentThreadId, { delegationId })
  }

  /** The delegations a thread made, oldest first. */
  listDelegations(parentThreadId: string) {
    const engine = this.requireRunEngine()
    return engine.delegations.listForParentThread(parentThreadId).map((delegation) => ({
      delegationId: delegation.delegationId,
      childThreadId: delegation.childThreadId,
      title: this.threadStore?.getThread(delegation.childThreadId)?.name ?? null,
      status: delegation.status,
      wake: delegation.wake,
      childRunStatus: engine.getRun(delegation.childRunId)?.status ?? null,
      createdAt: delegation.createdAt
    }))
  }

  /** `list_subagents`: one row per subagent, from the same read model the app shows. */
  private listSubagents(parentThreadId: string) {
    return this.subagentView(parentThreadId).map((row) => ({
      title: row.title,
      childThreadId: row.childThreadId,
      state: row.state,
      latestDelegationId: row.latestDelegationId,
      unread: row.unread,
      workspace: row.workspace,
      role: row.role,
      provider: row.provider,
      model: row.model
    }))
  }

  /**
   * `integrate_delegation` (SPEC §14.4): an `integration` run on the parent thread. It is queued
   * behind the calling turn (one active run per thread) and runs as its own `turn.start` effect;
   * its outcome is posted to the parent's inbox.
   */
  private async integrateDelegation(parentThreadId: string, parentRunId: string, delegationId: string, call: DelegationToolCall) {
    const engine = this.requireRunEngine()
    if (!this.effectsEnabled()) throw new Error('Integration needs the run engine worker')
    const delegation = this.ownedDelegation(parentThreadId, delegationId)
    if (delegation.status !== 'result_available' && delegation.status !== 'acknowledged')
      throw new Error(`Delegated task ${delegationId} is ${delegation.status}; only a finished task can integrate`)
    if (delegation.result?.runStatus !== 'completed')
      throw new Error(`Delegated task ${delegationId} ended ${delegation.result?.runStatus ?? 'without a result'}; only a completed task can integrate`)
    const result = await engine.dispatch({
      kind: 'send',
      threadId: parentThreadId,
      clientRequestId: `integration:${parentRunId}:${call.toolCallId}`,
      source: 'integration'
    })
    if (result.status !== 'accepted') throw new Error(result.reason)
    const payload: IntegrationTurnPayload = { kind: 'integration', threadId: parentThreadId, runId: result.runId, delegationId }
    engine.outbox.enqueue({ effectId: `effect:${result.runId}:turn.start:1`, threadId: parentThreadId, runId: result.runId, kind: 'turn.start', payload })
    return { delegationId, integrationRunId: result.runId, status: 'queued', note: 'The integration runs after this turn; Mousse notifies you of the outcome.' }
  }

  /**
   * An `integration` run (SPEC §14.4). Every step after the queued check, the run's own status
   * marks included, is inside the `try`: any failure ends the run `failed` and the parent learns of
   * it through an `integration_failed` notice in its inbox, never through a thrown effect.
   */
  private async executeIntegrationEffect(payload: IntegrationTurnPayload, signal: AbortSignal): Promise<void> {
    const engine = this.requireRunEngine()
    if (engine.getRun(payload.runId)?.status !== 'queued') return
    if (this.refuseOnBotThread(payload.runId, payload.threadId)) return
    // The outcome is a row for this thread, written with the run's terminal state: the thread stays
    // busy until its model reads it, so a task waiting on this thread (it may be a subagent that
    // integrates its own subagent's work) never publishes an answer that predates the outcome.
    const outcomeRow = (text: string, type: 'integration_completed' | 'integration_failed') => ({
      kind: 'reconcile_notice' as const,
      payload: { type, delegationId: payload.delegationId, text }
    })
    // Success is the merge, not the run's terminal write: a run something else ended while the merge
    // was committing (a stop, the reconciler) cannot be marked completed, and the merge still happened.
    let merged: Awaited<ReturnType<OrchestratorService['integrateDelegationResult']>> | undefined
    let notice: string
    try {
      engine.markStarting(payload.runId)
      engine.markRunning(payload.runId)
      merged = await this.lifecycle.run('delegation-integration', () =>
        this.integrateDelegationResult(payload.threadId, payload.delegationId, payload.runId, AbortSignal.any([signal, this.lifecycle.signal])))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      notice = `Integration of delegated task ${payload.delegationId} failed: ${message}`
      this.markRun(payload.runId, (runs, id) => {
        const run = runs.getRun(id)
        if (run && !TERMINAL_RUN_STATUSES.has(run.status)) runs.markTerminal(id, 'failed', { error: message }, { notice: outcomeRow(notice, 'integration_failed') })
      })
    }
    if (merged) {
      notice = `Integration of delegated task ${payload.delegationId} finished: merged ${merged.workerHeadSha.slice(0, 12)} as ${merged.integrationSha.slice(0, 12)} (${merged.changedPaths.length} path(s)).`
      try {
        engine.markTerminal(payload.runId, 'completed', undefined, { resultText: notice, notice: outcomeRow(notice, 'integration_completed') })
      } catch (error) {
        console.warn('integration run could not be marked completed; its merge stands', { runId: payload.runId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    try {
      const session = this.getOrCreateSession(payload.threadId)
      this.sessionAls.run(session, () => this.addSystemMessage(notice))
    } catch (error) {
      console.warn('integration notice could not reach the transcript', { runId: payload.runId, error: error instanceof Error ? error.message : String(error) })
    }
    this.settleIntegrationOutcome(payload, notice!, merged !== undefined)
  }

  /**
   * Makes sure the thread has exactly one right outcome row for an integration run. Normally the
   * terminal write has written it. A run something else ended while the merge was still going
   * (reconciler rule 2, boot) has an "interrupted before its outcome was known" row instead
   * (`writeTerminalRun`), and the merge may then have finished:
   * - the row is still `pending`: it is rewritten in place to the `integration_completed` outcome, in
   *   one write, so the thread never has two rows for one run and never reads the wrong one;
   * - it has been delivered or read already: its text cannot be taken back, so a short correction row
   *   follows, which is actionable and so keeps the thread busy until it has been read.
   * Residual: the thread may have read the interrupted row and the task waiting on it published
   * before the merge returned. That needs a reconciler interrupt in the middle of a live merge.
   * With no row at all (the terminal write failed for another reason) the outcome row is appended.
   */
  private settleIntegrationOutcome(payload: IntegrationTurnPayload, notice: string, merged: boolean): void {
    const engine = this.requireRunEngine()
    const outcomeRow = (text: string, type: 'integration_completed' | 'integration_failed') => ({
      kind: 'reconcile_notice' as const,
      payload: { type, delegationId: payload.delegationId, text }
    })
    engine.store.db.transaction(() => {
      const rows = engine.inbox.listForThread(payload.threadId).filter((row) => row.runId === payload.runId && row.kind === 'reconcile_notice')
      const typeOf = (row: InboxRecord): string => String((row.payload as { type?: unknown } | null)?.type)
      if (!merged) {
        if (!rows.some((row) => typeOf(row).startsWith('integration_')))
          engine.inbox.append({ threadId: payload.threadId, runId: payload.runId, ...outcomeRow(notice, 'integration_failed') })
        return
      }
      if (rows.some((row) => typeOf(row) === 'integration_completed')) return
      const interrupted = rows.find((row) => typeOf(row) === 'integration_failed' && (row.payload as { interrupted?: unknown }).interrupted === true)
      if (!interrupted) {
        engine.inbox.append({ threadId: payload.threadId, runId: payload.runId, ...outcomeRow(notice, 'integration_completed') })
      } else if (interrupted.status === 'pending') {
        engine.inbox.patchPayload(interrupted.inboxId, { type: 'integration_completed', text: notice, interrupted: null })
      } else {
        engine.inbox.append({
          threadId: payload.threadId,
          runId: payload.runId,
          ...outcomeRow(`The integration did finish, after the notice that it was interrupted: ${notice.replace(/^Integration of delegated task \S+ finished: /, '')}`, 'integration_completed')
        })
      }
    })
  }

  private async integrateDelegationResult(parentThreadId: string, delegationId: string, runId: string, signal: AbortSignal) {
    const delegation = this.requireRunEngine().delegations.get(delegationId)
    if (!delegation) throw new Error(`Unknown delegation ${delegationId}`)
    const parentDirectory = this.resolveThreadDir(parentThreadId)
    const childDirectory = this.resolveThreadDir(delegation.childThreadId)
    if (!parentDirectory || !childDirectory || !this.projectManager || !this.threadStore) throw new Error('Integration requires task workspaces')
    const child = new ThreadWorkspaceManager(childDirectory).load()
    if (!child || !existsSync(child.worktreePath)) throw new Error('The delegated task has no isolated workspace to integrate; shared and read-only tasks change nothing.')
    const project = resolveThreadProjectPath(this.projectManager, this.threadStore, parentThreadId)
    if (!project) throw new Error('Integration requires a task project')
    const lease = await waitAcquireExecutionLease(parentDirectory, { source: 'delegation-integration', signal })
    try {
      const target = await new WorkspaceResolver(parentDirectory, parentThreadId, project).resolve('agent', 'main', signal, lease)
      if (!target.capability.checkpointable) throw new Error('Integration requires an owned Git workspace')
      // The task's own checkpoint, not the worktree as it is now: the subagent may have worked on since.
      // The run whose text the task published (it can be a later run than the task's own, once the
      // subagent had waited on its own subagents), and the task's own run for a result that predates `runId`.
      const pinned = taskCheckpoint(new ThreadActionService(childDirectory).list(), delegation.result?.runId ?? delegation.childRunId)
      if (!pinned) throw new Error('The delegated task left no code checkpoint to integrate.')
      return await new ChildAgentIntegrationService(parentDirectory).integrate({
        agentId: delegation.childThreadId,
        operationId: `delegation-integration:${delegationId}:${pinned}`,
        actor: { kind: 'agent', id: delegation.childThreadId },
        workerWorktree: child.worktreePath,
        spawnBaseSha: child.baseSha,
        pinnedWorkerSha: pinned,
        threadWorkspace: target.workspacePath,
        heldThreadLease: lease,
        signal,
        runId,
        externalEffects: [{ kind: 'unknown', reversible: false, description: 'The delegated thread may have performed external effects; integration reverses repository changes only.' }]
      })
    } finally {
      releaseExecutionLeaseHandle(lease)
    }
  }

  /**
   * A wake turn (reconciler rule 4): an ordinary visible turn whose prompt is the server-authored
   * notice for the thread's inbox rows. Rows already acknowledged are skipped; when none remain (or
   * the thread was deleted) the wake run ends `cancelled`. On a busy thread:
   * - another engine turn of the thread is waiting to start (its `turn.start` pending or claimed):
   *   the wake ends `cancelled` with its rows pending again, so that turn goes first and rule 4
   *   queues a new wake behind it;
   * - otherwise (a turn the engine does not schedule holds the thread) the wake stays `queued` and
   *   its effect is deferred `WAKE_BUSY_DEFER_MS` (C4: no cancel-and-recreate loop with rule 4,
   *   which skips threads that already have a queued wake).
   */
  private async executeWakeEffect(effect: EffectRecord, payload: WakeTurnPayload, signal: AbortSignal): Promise<void> {
    const engine = this.requireRunEngine()
    if (engine.getRun(payload.runId)?.status !== 'queued') return
    const rows = this.dropStaleQuestionRows(engine.inbox.getMany(payload.inboxIds).filter((row) => row.status !== 'acknowledged'))
    // A bot thread is never woken as a plain turn; its notices are settled so rule 4 does not wake it again.
    if (this.botThreadRefusal(payload.threadId)) {
      engine.store.db.transaction(() => {
        if (engine.getRun(payload.runId)?.status === 'queued') engine.markTerminal(payload.runId, 'cancelled', { error: 'bot_thread_read_only' })
        engine.inbox.markAcknowledged(rows.map((row) => row.inboxId))
      })
      return
    }
    const session = this.getOrCreateSession(payload.threadId)
    const cancelWake = (restore: boolean): void => {
      engine.store.db.transaction(() => {
        engine.markTerminal(payload.runId, 'cancelled')
        if (restore && rows.length) engine.inbox.markPendingAgain(rows.map((row) => row.inboxId))
      })
    }
    if (engine.isFenced(payload.runId)) {
      // A Stop of this thread came after the wake was admitted: its notices belong to the work that was stopped.
      engine.store.db.transaction(() => {
        engine.markTerminal(payload.runId, 'cancelled', { interruptedBy: 'user' })
        engine.inbox.markAcknowledged(rows.map((row) => row.inboxId))
      })
      return
    }
    if (rows.length === 0 || session.deleted) {
      cancelWake(!session.deleted)
      return
    }
    // A paused thread takes no wake: its rows stay pending and the continue turn carries them. The wake ends
    // here instead of waiting in the thread's lane, which would hold up that turn.
    if (engine.store.getPausedRun(payload.threadId)) {
      cancelWake(true)
      return
    }
    if (session.turnAdmitted || session.isTurnRunning() || engine.getActiveRun(payload.threadId)) {
      const waiting = engine.outbox
        .listForThread(payload.threadId)
        .some((other) => other.kind === 'turn.start' && other.effectId !== effect.effectId && (other.status === 'pending' || other.status === 'running'))
      if (waiting) {
        cancelWake(true)
        return
      }
      throw new EffectDeferredError(this.wakeBusyDeferMs, 'thread_busy')
    }
    // A pull request update asks the agent to change code. While the thread waits on an approval (one a restart left saved
    // included) it must not start a turn of its own, which would also settle that approval: the wake stays queued, as for a
    // busy thread, and runs once nothing waits.
    if (rows.some((row) => row.kind === 'pr_update') && this.threadWaitsOnApproval(payload.threadId)) {
      throw new EffectDeferredError(this.wakeBusyDeferMs, 'approval_waiting')
    }
    const notice = planWakeNotice(rows, this.noticeContext())
    engine.inbox.recordNoticeVisibility(rows, notice.items)
    try {
      await this.runTurnOnSession(
        session,
        { content: notice.text, mode: getLastUserChatMode(session.messages) ?? 'agent' },
        false,
        true,
        { source: 'wake', runId: payload.runId, externalSignal: signal, subagentNotice: notice.items }
      )
    } catch (error) {
      const run = engine.getRun(payload.runId)
      if (!run || !TERMINAL_RUN_STATUSES.has(run.status)) throw error
    }
  }

  /** A saved approval request of the thread is waiting for an answer, or was answered and not yet delivered to its run. */
  private threadWaitsOnApproval(threadId: string): boolean {
    const approvals = this.runEngine?.approvals
    if (!approvals) return false
    return approvals.listPending(threadId).length > 0 || approvals.listUndelivered().some((row) => row.threadId === threadId)
  }

  private requireRunEngine(): RunEngine {
    if (!this.runEngine) throw new Error('Run engine is unavailable')
    return this.runEngine
  }

  /**
   * queued -> starting for the turn about to call its provider. Unlike other bridge writes a
   * failure of any kind throws: the run was cancelled (a delegation cancel, a deleted thread),
   * already ended or is held elsewhere, so the turn must not run. The run keeps whatever state it
   * has; the caller's settlement records nothing over a terminal run.
   */
  private markRunStarting(runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    try {
      engine.markStarting(runId)
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'stale_write') this.staleRuns.add(runId)
      const status = engine.getRun(runId)?.status ?? 'missing'
      throw new Error(`Run ${runId} cannot start (${status}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Bridge writes never fail a user's turn. A stale epoch stops further writes for that run. */
  private markRun(runId: string | undefined, write: (engine: RunEngine, runId: string) => void): void {
    const engine = this.runEngine
    if (!engine || !runId || this.staleRuns.has(runId)) return
    try {
      write(engine, runId)
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'stale_write') {
        this.staleRuns.add(runId)
        console.warn('run engine stale write', { runId, error: error.message })
        return
      }
      console.warn('run engine write failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** SPEC §16.4: a continuation run opens with the run it continues. */
  private deliverContinuationNote(runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    try {
      const continued = engine.getRun(runId)?.outcome?.continuationOf
      const source = continued ? engine.getRun(continued) : null
      if (source) this.addSystemMessage(source.outcome?.pause ? `Continuing run ${source.ordinal} after the usage limit reset.` : `Continuing run ${source.ordinal} after a restart.`)
    } catch (error) {
      console.warn('run engine continuation note failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** SPEC §12.5 step 5: the first turn after a daemon restart shows what was cut off, once. */
  private deliverRestartNote(threadId: string, runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    try {
      const note = engine.takeRestartNote(threadId, runId)
      // The saved items of the cut-off runs, so the note also names Claude and Codex work the tool ledger never saw.
      if (note) this.addSystemMessage(formatRestartNote({ ...note, cutOffActivity: cutOffActivityOf(this.messages, note.runIds) }))
    } catch (error) {
      console.warn('run engine restart note failed', { runId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * SPEC §12.6 tool ledger for an engine run: `started` before a tool runs, `committed|failed`
   * after. A ledger failure is logged and never breaks the tool.
   */
  private toolLedgerFor(runId: string | undefined): ToolHost['toolLedger'] {
    const engine = this.runEngine
    if (!engine || !runId) return undefined
    const now = (): string => new Date().toISOString()
    const warn = (step: string, error: unknown): void => {
      console.warn(`run engine tool ledger ${step} failed`, { runId, error: error instanceof Error ? error.message : String(error) })
    }
    return {
      start: (call, options) => {
        try {
          const attemptId = engine.getRun(runId)?.activeAttemptId
          if (!attemptId) return undefined
          return engine.tools.start({
            invocationId: uuidv4(),
            runId,
            attemptId,
            tool: call.name,
            argsDigest: toolArgsDigest(call.arguments),
            now: now(),
            ...(options?.idempotent !== undefined ? { idempotent: options.idempotent } : {})
          }).invocationId
        } catch (error) {
          warn('start', error)
          return undefined
        }
      },
      commit: (id) => {
        try { engine.tools.commit(id, now()) } catch (error) { warn('commit', error) }
      },
      failed: (id) => {
        try { engine.tools.failed(id, now()) } catch (error) { warn('failed', error) }
      }
    }
  }

  /**
   * Safety net after a legacy turn returns or throws: a run handed to the turn must end terminal
   * unless the turn put it back on the queue (lease race / released claim keep the runId).
   */
  private settleRunAfterTurn(runId: string | undefined, requeued: boolean, failure: unknown): void {
    if (!runId) return
    this.markRun(runId, (engine, id) => {
      const run = engine.getRun(id)
      if (!run || TERMINAL_RUN_STATUSES.has(run.status)) return
      // A paused run waits for its limit to reset; only `endPause` ends it.
      if (run.status === 'paused') return
      if (run.status === 'queued' && requeued) return
      if (failure !== undefined) {
        engine.markTerminal(id, 'failed', { error: failure instanceof Error ? failure.message : String(failure) })
      } else {
        engine.markTerminal(id, 'completed')
      }
      // The run's count record goes with it.
      this.harness.runSettled?.(id)
    })
    this.staleRuns.delete(runId)
  }

  /**
   * Queue items that leave the queue without running (removed, cleared, promoted to steer) end
   * their run `cancelled`. Only still-queued runs: a claimed item's run may already be starting.
   */
  private cancelQueuedRuns(runIds: Array<string | undefined>): void {
    for (const runId of runIds) {
      this.markRun(runId, (engine, id) => {
        if (engine.getRun(id)?.status !== 'queued') return
        engine.markTerminal(id, 'cancelled', { interruptedBy: 'user' })
      })
    }
  }

  /** Pre-upgrade queue items carry no runId; give them one before they run. */
  private async ensureQueueItemRun(item: QueuedMessage): Promise<string | undefined> {
    if (item.runId || !this.runEngine) return item.runId
    try {
      const result = await this.runEngine.dispatch({
        kind: 'send',
        threadId: item.threadId,
        clientRequestId: `queue:${item.id}`,
        source: item.source ?? 'queue',
        // A message an agent queued is still its run: it counts toward the chain of agent messages and is held
        // behind a pause, wherever it was written (the send, or an edit that made it the agent's).
        ...(item.origin?.kind === 'agent' ? { agentOrigin: { hops: item.origin.hops ?? 1 } } : {})
      })
      return result.status === 'accepted' ? result.runId : undefined
    } catch (error) {
      console.warn('run engine could not record a queued item', { queueItemId: item.id, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  setFeatureFlags(flags: MousseFeatureFlags): void {
    this.featureFlags = { ...DEFAULT_FEATURE_FLAGS, ...flags }
  }

  setRuntimeManager(
    manager: import('../runtime/ThreadRuntimeManager').ThreadRuntimeManager | null
  ): void {
    this.runtimeManager = manager
  }

  /** Public access to session agents for a thread (hydrates via runtime manager when present). */
  getAgentsForThread(threadId: string): AgentRegistry {
    if (this.runtimeManager) {
      return this.runtimeManager.getOrHydrate(threadId).agents
    }
    return this.getOrCreateSession(threadId).agents
  }

  getTasksForThread(threadId: string): TaskQueue {
    if (this.runtimeManager) {
      return this.runtimeManager.getOrHydrate(threadId).tasks
    }
    return this.getOrCreateSession(threadId).tasks
  }

  private persist(immediate = false): void {
    const threadId = this.session.threadId === '__unbound__' ? null : this.session.threadId
    const timerKey = threadId ?? '__unbound__'
    if (immediate) {
      const existing = this.persistTimers.get(timerKey)
      if (existing) {
        clearTimeout(existing)
        this.persistTimers.delete(timerKey)
      }
      this.persistFn?.(threadId)
      return
    }

    if (this.persistTimers.has(timerKey)) return
    const timer = setTimeout(() => {
      this.persistTimers.delete(timerKey)
      this.persistFn?.(threadId)
    }, 500)
    this.persistTimers.set(timerKey, timer)
  }

  /** Reload durable queue into the session under the mutation lock. */
  private refreshSessionQueueFromDisk(session: ThreadSession): void {
    if (!this.threadStore || session.threadId === '__unbound__') return
    try {
      if (!this.threadStore.getThread(session.threadId)) return
      session.queue = readDurableQueue(this.threadStore, session.threadId)
    } catch {
      // ignore
    }
  }

  private resolveThreadDir(threadId: string): string | null {
    if (!this.threadStore) return null
    try {
      return this.threadStore.getThreadDir(threadId)
    } catch {
      return null
    }
  }

  /**
   * True when a live peer process owns this thread's execution lease.
   * Used to enqueue instead of starting a second concurrent turn.
   */
  isThreadLeaseHeldExternally(threadId: string, selfToken?: string): boolean {
    const threadDir = this.resolveThreadDir(threadId)
    if (!threadDir) return false
    return isLeaseHeldByLivePeer(threadDir, selfToken).held
  }

  /**
   * Best-effort safe reclaim of a dead owner's execution lease before
   * queue/held decisions. Never touches a live owner (ownership-checked).
   * Without this, a daemon restart that left an execution.lease behind makes
   * every new prompt enqueue behind a ghost owner with nothing draining it.
   */
  private reclaimStaleThreadLease(threadId: string): void {
    const threadDir = this.resolveThreadDir(threadId)
    if (!threadDir) return
    try {
      tryReclaimStaleLease(threadDir)
    } catch {
      // best-effort only; held-check below decides queue vs run
    }
  }

  /**
   * Persist a steer-intent item for the active external owner to drain once.
   * Does not run as a later normal message.
   */
  enqueueExternalSteer(
    threadId: string,
    text: string,
    opts?: { source?: string; permissionMode?: PermissionMode; sentFrom?: { node: string } }
  ): QueuedMessage | null {
    const trimmed = text.trim()
    if (!trimmed) return null
    if (this.threadStore && !this.threadStore.getThread(threadId)) return null
    return this.enqueueForThread(
      threadId,
      { content: trimmed },
      { source: opts?.source ?? 'cli-steer', intent: 'steer', ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}), ...(opts?.sentFrom ? { sentFrom: opts.sentFrom } : {}) }
    )
  }

  /**
   * Ensure a session exists for threadId (loaded from disk if needed).
   * Does not change the bound GUI session unless threadId matches bound.
   */
  /**
   * Attach multi-tenant registries to an existing session (no create).
   * Used by ThreadRuntimeManager to avoid getOrCreateSession recursion.
   */
  bindRuntimeRegistries(
    threadId: string,
    agents: AgentRegistry,
    tasks: TaskQueue
  ): void {
    if (this.boundSession.threadId === threadId) {
      this.boundSession.agents = agents
      this.boundSession.tasks = tasks
      return
    }
    const session = this.sessions.get(threadId)
    if (session) {
      session.agents = agents
      session.tasks = tasks
    }
  }

  getOrCreateSession(threadId: string): ThreadSession {
    if (this.threadStore?.lifecycleStore?.get(threadId)) this.threadStore.assertThreadAdmission(threadId)
    if (this.boundSession.threadId === threadId) {
      if (this.runtimeManager && this.boundSession.threadId !== '__unbound__') {
        const rt = this.runtimeManager.getOrHydrate(threadId)
        this.boundSession.agents = rt.agents
        this.boundSession.tasks = rt.tasks
      }
      return this.boundSession
    }
    let session = this.sessions.get(threadId)
    if (session) {
      if (this.runtimeManager) {
        const rt = this.runtimeManager.getOrHydrate(threadId)
        session.agents = rt.agents
        session.tasks = rt.tasks
      }
      return session
    }
    session = new ThreadSession(threadId)
    if (this.threadStore?.getThread(threadId)) {
      const data = this.threadStore.loadThreadData(threadId)
      this.recoverApplets(threadId, data.messages)
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue,
        data.agents,
        data.tasks,
        this.harness.instanceMap.migrate(this.threadStore.getThread(threadId)?.modelOverride)
      )
      this.closeStaleActivity(session)
      if (this.projectManager) {
        const projectPath = resolveThreadProjectPath(this.projectManager, this.threadStore, threadId)
        session.projectCwd = resolveProjectWorkingDirectory(projectPath)
      }
    }
    // Hydrate runtime after session is registered to avoid re-entrant create.
    this.sessions.set(threadId, session)
    this.restoreDelegatedWorkspace(session)
    this.restoreScheduledWorkspace(session)
    if (this.runtimeManager) {
      const rt = this.runtimeManager.getOrHydrate(threadId)
      session.agents = rt.agents
      session.tasks = rt.tasks
    }
    return session
  }

  /** Return the durable model override for one thread, if configured. */
  getThreadModelOverride(threadId: string): ThreadSession['modelOverride'] {
    return this.getOrCreateSession(threadId).modelOverride
  }

  /** Set one thread's model without mutating global provider settings. */
  setThreadModelOverride(
    threadId: string,
    override: ThreadSession['modelOverride'] | undefined
  ): ThreadSession['modelOverride'] {
    const session = this.getOrCreateSession(threadId)
    // Stored in the instance shape (SPEC §13.8); callers that still pass an `llmProvider` are mapped.
    const next = this.harness.instanceMap.migrate(override)
    const instanceKey = (selection: ModelOverride | undefined) => {
      const migrated = this.harness.instanceMap.migrate(selection)
      return migrated?.instanceId ?? migrated?.llmProvider
    }
    const switched = instanceKey(session.modelOverride) !== instanceKey(next)
    // SPEC §16.1: one provider switch at a time; a pending handoff must be delivered or fail first.
    const pending = switched ? this.runEngine?.handoffs.pendingForThread(threadId) : null
    if (pending)
      throw new DomainRpcError('handoff_pending', `Thread ${threadId} is still handing its context to ${pending.toRef.provider}; switch providers after that turn.`, { handoffId: pending.handoffId })
    // The old provider's process is stopped while the thread still resolves to it; its helpers end with it.
    if (switched) void this.stopProviderWork(threadId)
    session.modelOverride = next ? structuredClone(next) : undefined
    if (this.threadStore) {
      this.threadStore.updateThreadMeta(threadId, { modelOverride: session.modelOverride })
    }
    // SPEC §15.1: a credential belongs to a thread and provider instance; a switch revokes it.
    if (switched) this.revokeMcp(threadId)
    return session.modelOverride
  }

  /** Bind the GUI/CLI active session to a thread (call on thread switch). */
  bindThread(
    threadId: string,
    messages: ChatMessage[],
    nativeContext?: NativeLlmContext,
    queue?: QueuedMessage[]
  ): void {
    // Preserve an in-flight background session for the previous bound thread.
    if (
      this.boundSession.threadId !== '__unbound__' &&
      this.boundSession.threadId !== threadId &&
      this.boundSession.isTurnRunning()
    ) {
      this.sessions.set(this.boundSession.threadId, this.boundSession)
    }

    const existing = this.sessions.get(threadId)
    if (existing) {
      this.boundSession = existing
      this.sessions.delete(threadId)
    } else {
      this.boundSession = new ThreadSession(threadId)
      this.boundSession.load(
        messages,
        nativeContext ?? migrateLegacyContext(messages),
        queue ?? (this.threadStore ? this.threadStore.loadMessageQueue(threadId) : []),
        undefined,
        undefined,
        this.harness.instanceMap.migrate(this.threadStore?.getThread(threadId)?.modelOverride)
      )
      this.closeStaleActivity(this.boundSession)
    }

    this.recoverApplets(threadId, this.boundSession.messages)

    if (this.projectManager && this.threadStore) {
      try {
        const projectPath = resolveThreadProjectPath(this.projectManager, this.threadStore, threadId)
        this.boundSession.projectCwd = resolveProjectWorkingDirectory(projectPath)
        this.worktrees.setRepoRoot(this.boundSession.projectCwd)
      } catch {
        // Project may be unavailable.
      }
    }
  }

  /** Snapshot bound session messages/context/queue for the given thread id. */
  getBoundThreadId(): string | null {
    return this.boundSession.threadId === '__unbound__' ? null : this.boundSession.threadId
  }

  /**
   * Mark thread deleted so pending work will not execute. Deleting is a Stop of the thread and every
   * subagent below it (`stopThread`, H7), queue included; the live turn is aborted here and its MCP
   * credentials revoked.
   */
  markThreadDeleted(threadId: string): void {
    this.revokeMcp(threadId)
    this.appToolTurns.forgetThread(threadId)
    this.dropContinuationsOf(threadId)
    try {
      this.runEngine?.approvals.cancelForThread(threadId, 'thread_deleted')
      // Prompts and answers never outlive the thread they belong to.
      this.runEngine?.approvals.deleteForThread(threadId)
    } catch (error) {
      console.warn('a deleted thread\'s approval requests could not be closed', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
    // A paused run has no turn for the Stop below to end: its pause (and timer) ends with the thread, as deleted.
    try {
      const paused = this.runEngine?.store.getPausedRun(threadId)
      if (paused) this.runEngine!.endPause(paused.runId, 'deleted')
    } catch (error) {
      console.warn('a deleted thread\'s pause could not be ended', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
    if (this.runEngine) {
      // The answers kept for waiters go with the thread; again once its stopped work has written its last one.
      const forgetResults = (): void => {
        try {
          if (this.runEngine) deleteRunResults(this.runEngine.store, threadId)
        } catch (error) {
          console.warn('a deleted thread\'s kept answers could not be removed', { threadId, error: error instanceof Error ? error.message : String(error) })
        }
      }
      forgetResults()
      void this.stopThread(threadId, 'thread_deleted', { clearQueue: true }).catch((error: unknown) => {
        console.warn('a deleted thread\'s work could not be stopped', { threadId, error: error instanceof Error ? error.message : String(error) })
      }).finally(() => setTimeout(forgetResults, 2_000).unref?.())
    }
    const session = this.sessions.get(threadId)
    if (session) {
      session.deleted = true
      if (session.activeTurn && !session.activeTurn.abort.signal.aborted) {
        session.activeTurn.pendingSteer = []
        session.activeTurn.abort.abort()
      }
      session.queue = []
    }
    if (this.boundSession.threadId === threadId) {
      this.boundSession.deleted = true
      if (this.boundSession.activeTurn && !this.boundSession.activeTurn.abort.signal.aborted) {
        this.boundSession.activeTurn.pendingSteer = []
        this.boundSession.activeTurn.abort.abort()
      }
      this.boundSession.queue = []
    }
    try {
      this.threadStore?.saveMessageQueue(threadId, [])
    } catch {
      // deleted on disk already
    }
    this.emitQueueUpdated(threadId, [])
    this.setTurnPhase(threadId, 'idle')
    this.turnStates.delete(threadId)
  }

  /** A restored task starts from durable conversation state without replaying old work. */
  markThreadRestored(threadId: string): void {
    this.sessions.delete(threadId)
    if (this.boundSession.threadId === threadId) this.boundSession = new ThreadSession('__unbound__')
    this.turnStates.delete(threadId)
  }

  loadMessages(messages: ChatMessage[], nativeContext?: NativeLlmContext, queue?: QueuedMessage[]): void {
    this.boundSession.load(
      messages,
      nativeContext ?? migrateLegacyContext(messages),
      queue
    )
  }

  /**
   * Ends the activity items a previous daemon left `running` on a session that was just loaded.
   * With no live turn, a `running` item is always stale (every turn ends its items), so they are
   * tagged `daemon_restart` and the restart note can name them whenever the next turn starts.
   *
   * The disk is authoritative, not the snapshot the session was loaded from: the rows are closed
   * against the saved thread under the data write lock, which also re-checks the lease, and the
   * session then takes the saved rows. A row another process finished meanwhile stays finished,
   * with its output and times; a lease held by another live process (a CLI turn running now)
   * leaves everything as it is. Nothing is written when no saved row is still `running`, so a
   * second hydration, or one from an older snapshot, writes nothing and changes nothing.
   */
  private closeStaleActivity(session: ThreadSession): void {
    if (session.isTurnRunning()) return
    const stale = new Set(session.messages.filter((message) => message.activity?.status === 'running').map((message) => message.id))
    if (!stale.size) return
    const store = this.threadStore
    if (!store || session.threadId === '__unbound__') {
      const closed = closeStaleActivity(session.messages, new Date().toISOString())
      session.messages = session.messages.map((message) => closed.get(message.id) ?? message)
      return
    }
    const threadId = session.threadId
    try {
      const threadDir = store.getThreadDir(threadId)
      if (isLeaseHeldByLivePeer(threadDir).held) return
      let saved = store.loadThreadData(threadId).messages
      if (saved.some((message) => stale.has(message.id) && message.activity?.status === 'running')) {
        saved = store.mutateThreadData(threadId, (current) => {
          // Under the write lock: a peer may have taken the thread, or finished rows, since the read above.
          if (isLeaseHeldByLivePeer(threadDir).held) throw new StaleActivitySkipped()
          const closed = closeStaleActivity(current.messages.filter((message) => stale.has(message.id)), new Date().toISOString())
          if (!closed.size) throw new StaleActivitySkipped()
          return { messages: current.messages.map((message) => closed.get(message.id) ?? message) }
        }).messages
      }
      // The session takes the saved version of each row it held as running. A row the disk does not
      // have (a caller's own messages) is closed from the snapshot.
      const byId = new Map(saved.map((message) => [message.id, message]))
      const leftover = closeStaleActivity(session.messages.filter((message) => stale.has(message.id) && !byId.has(message.id)), new Date().toISOString())
      session.messages = session.messages.map((message) => (stale.has(message.id) ? (byId.get(message.id) ?? leftover.get(message.id) ?? message) : message))
    } catch (error) {
      if (error instanceof StaleActivitySkipped) {
        // Nothing was written, so the session must not diverge from the disk either.
        this.adoptSavedActivity(session, stale)
        return
      }
      // Opening the thread must not fail; the rows stay as loaded and the next hydration retries.
      console.warn('stale activity could not be closed', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The session takes the saved version of the rows it held as `running`, when the disk has them. */
  private adoptSavedActivity(session: ThreadSession, ids: ReadonlySet<string>): void {
    try {
      const byId = new Map(this.threadStore!.loadThreadData(session.threadId).messages.map((message) => [message.id, message]))
      session.messages = session.messages.map((message) => (ids.has(message.id) ? (byId.get(message.id) ?? message) : message))
    } catch {
      // Unreadable: the rows stay as loaded.
    }
  }

  /** Reattach only bundles already durably published by this exact completed turn. */
  private recoverApplets(threadId: string, messages: ChatMessage[]): void {
    if (!this.appletStore || !this.threadStore) return
    const recovered = new Map<string, NonNullable<ChatMessage['presentationParts']>>()
    for (const message of messages) {
      if (message.role !== 'assistant' || message.presentationParts || !message.turnId || message.incomplete || message.streaming) continue
      const parts = recoverAppletPresentation(this.appletStore, {threadId,messageId:message.id,turnId:message.turnId,content:message.content})
      if (parts) { message.presentationParts = parts; recovered.set(message.id, parts) }
    }
    if (recovered.size) this.threadStore.mutateThreadData(threadId, current => ({messages: current.messages.map(message => {
      const parts = recovered.get(message.id)
      const original = messages.find(candidate => candidate.id === message.id)
      return parts && !message.presentationParts && message.content === original?.content && message.turnId === original?.turnId ? {...message, presentationParts: parts} : message
    })}))
  }

  getMessages(threadId?: string): ChatMessage[] {
    return this.getMessagesForPersistence(threadId).filter((message) => !message.hidden)
  }

  /** Full durable transcript, including hidden internal queue inputs used for claim provenance. */
  getMessagesForPersistence(threadId?: string): ChatMessage[] {
    const messages =
      !threadId || threadId === this.boundSession.threadId
        ? this.boundSession.messages
        : this.getOrCreateSession(threadId).messages
    return [...messages]
  }

  getMessageQueue(threadId?: string): QueuedMessage[] {
    const id = threadId ?? this.getBoundThreadId()
    if (!id) return []
    return listPendingQueue(this.getOrCreateSession(id).queue).filter((item) => !item.internal)
  }

  listQueue(threadId: string): QueuedMessage[] {
    return this.getMessageQueue(threadId)
  }

  private emitQueueUpdated(threadId: string, items: QueuedMessage[]): void {
    const pending = listPendingQueue(items).filter((item) => !item.internal)
    this.emit('queue-updated', { threadId, items: pending })
  }

  private emitThreadMessages(threadId: string, messages: ChatMessage[], replace = false): void {
    const visible = messages.filter((message) => !message.hidden)
    this.emit('thread-messages', { threadId, messages: [...visible], ...(replace ? { replace: true } : {}) })
    // Legacy unscoped mirror only for the GUI-bound (selected) thread.
    if (threadId === this.boundSession.threadId) {
      this.emit('messages-sync', [...visible])
    }
  }

  /** Always emit thread-scoped add; legacy `message` only for the bound session. */
  private emitMessageAdded(message: ChatMessage): void {
    const threadId = this.session.threadId
    this.emit('thread-message', { threadId, message })
    if (threadId === this.boundSession.threadId) {
      this.emit('message', message)
    }
  }

  /** Always emit thread-scoped update; legacy `message-updated` only for the bound session. */
  private emitMessageUpdated(message: ChatMessage): void {
    const threadId = this.session.threadId
    this.emit('thread-message-updated', { threadId, message })
    if (threadId === this.boundSession.threadId) {
      this.emit('message-updated', message)
    }
  }

  /**
   * Queues a message and makes sure it runs: after the current turn settles (whoever owns it,
   * including a channel or remote turn that suppresses its own drain), or now when the thread is idle.
   */
  enqueueAndDrain(threadId: string, input: OrchestratorSendInput, source: string): QueuedMessage {
    this.assertQueueOpen(threadId)
    const item = this.enqueueForThread(threadId, input, { source })
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning() || session.turnAdmitted) session.drainAfterSettle = true
    else this.scheduleQueueDrain(session)
    return item
  }

  enqueueForThread(
    threadId: string,
    input: OrchestratorSendInput,
    opts?: {
      source?: string; intent?: 'normal' | 'steer'; internal?: boolean; runId?: string; inboxIds?: string[]; subagentNotice?: SubagentNoticeItem[]; stopGeneration?: number; permissionMode?: PermissionMode; origin?: QueuedMessage['origin']; sentFrom?: QueuedMessage['sentFrom']
      /** A fixed id: an item with it already on the queue is returned as it is (the continue message of a pause). */
      id?: string
      /** Ahead of every pending item. */
      atFront?: boolean
      continuationOfRunId?: string
      /** Runs once the queue holding the item is saved, before the queue lock is released; the item is the saved one, an existing one included. */
      afterSave?: (item: QueuedMessage, saved: QueuedMessage[]) => void
    }
  ): QueuedMessage {
    if (this.threadStore && !this.threadStore.getThread(threadId)) {
      throw new QueueValidationError(`Thread not found: ${threadId}`)
    }
    const session = this.getOrCreateSession(threadId)
    if (session.deleted) {
      throw new QueueValidationError(`Thread deleted: ${threadId}`)
    }
    if (!opts?.internal) this.assertNotBotThread(threadId)
    // User-queued first messages leave drafts so the sidebar keeps them. Internal wakes do not.
    if ((opts?.intent ?? 'normal') === 'normal' && !opts?.internal) {
      this.touchUserActivityAndNotify(threadId)
    }
    const request = normalizeSendRequest(input)
    // Work that starts on behalf of a parent remembers the Stop generation it was queued at (the Stop fence).
    const stopGeneration = opts?.stopGeneration ?? (this.runEngine && isFencedSource(opts?.source) ? currentStopGeneration(this.runEngine.store, threadId) : undefined)
    let item: QueuedMessage
    if (this.threadStore) {
      // Cross-process RMW: load disk, enqueue, save under mutation lock.
      const next = mutateDurableQueue(this.threadStore, threadId, (diskItems) => {
        const result = enqueueMessage(diskItems, {
          threadId,
          content: request.content,
          workflowInvocationId: request.workflowInvocationId,
          mode: request.mode,
          images: request.images,
          intent: opts?.intent ?? 'normal',
          source: opts?.source,
          internal: opts?.internal,
          runId: opts?.runId,
          inboxIds: opts?.inboxIds,
          subagentNotice: opts?.subagentNotice,
          stopGeneration,
          permissionMode: opts?.permissionMode,
          sentFrom: opts?.sentFrom,
          origin: opts?.origin,
          id: opts?.id,
          atFront: opts?.atFront,
          continuationOfRunId: opts?.continuationOfRunId
        })
        item = result.item
        return result.items
      }, opts?.afterSave ? { afterSave: (saved) => opts.afterSave!(saved.find((entry) => entry.id === item!.id) ?? item!, saved) } : undefined)
      session.queue = next
      this.emitQueueUpdated(threadId, session.queue)
      return item!
    }
    const result = enqueueMessage(session.queue, {
      threadId,
      content: request.content,
      workflowInvocationId: request.workflowInvocationId,
      mode: request.mode,
      images: request.images,
      intent: opts?.intent ?? 'normal',
      source: opts?.source,
      internal: opts?.internal,
      runId: opts?.runId,
      inboxIds: opts?.inboxIds,
      subagentNotice: opts?.subagentNotice,
      stopGeneration,
      permissionMode: opts?.permissionMode,
      sentFrom: opts?.sentFrom,
      origin: opts?.origin,
      id: opts?.id,
      atFront: opts?.atFront,
      continuationOfRunId: opts?.continuationOfRunId
    })
    session.queue = result.items
    item = result.item
    opts?.afterSave?.(item, session.queue)
    this.emitQueueUpdated(threadId, session.queue)
    return item
  }

  /**
   * A person's removal (the app, the CLI). `expectedRevision`, when given, is checked against the queue on disk
   * inside the same lock as the change: a queue that changed since it was read refuses with a conflict.
   */
  removeQueuedItem(threadId: string, itemId: string, opts?: { expectedRevision?: string }): QueuedMessage | null {
    const session = this.getOrCreateSession(threadId)
    let removed: QueuedMessage | null = null
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, (diskItems) => {
        assertQueueRevision(diskItems, opts?.expectedRevision)
        const result = removeQueuedMessage(diskItems, itemId)
        if (result.removed?.workflowInvocationId) this.workflowChat?.abandon(result.removed.workflowInvocationId, threadId)
        removed = result.removed
        // Before the removal is saved: a crash in between leaves an item that finds it owns no rows and is skipped.
        this.releaseQueuedRows([result.removed])
        return result.items
      })
    } else {
      assertQueueRevision(session.queue, opts?.expectedRevision)
      const result = removeQueuedMessage(session.queue, itemId)
      if (result.removed?.workflowInvocationId) this.workflowChat?.abandon(result.removed.workflowInvocationId, threadId)
      this.releaseQueuedRows([result.removed])
      session.queue = result.items
      removed = result.removed
    }
    this.emitQueueUpdated(threadId, session.queue)
    this.cancelQueuedRuns([(removed as QueuedMessage | null)?.runId])
    return removed
  }

  reorderQueue(threadId: string, orderedIds: string[], opts?: { expectedRevision?: string }): QueuedMessage[] {
    const session = this.getOrCreateSession(threadId)
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, (diskItems) => {
        assertQueueRevision(diskItems, opts?.expectedRevision)
        return reorderQueuedMessages(diskItems, orderedIds)
      })
    } else {
      assertQueueRevision(session.queue, opts?.expectedRevision)
      session.queue = reorderQueuedMessages(session.queue, orderedIds)
    }
    this.emitQueueUpdated(threadId, session.queue)
    return listPendingQueue(session.queue)
  }

  /**
   * Promote a queued item to steer the active turn on this thread.
   * When accepted, the item stays in the queue as steering until the turn's
   * steer drain consumes its content exactly once; it is never drained as a
   * later normal turn. If the turn ends without draining, the item is
   * demoted back to normal pending instead of being dropped.
   */
  promoteQueueItemToSteer(
    threadId: string,
    itemId: string,
    opts?: { expectedRevision?: string; expectedRunId?: string; permissionCeiling?: PermissionMode }
  ): boolean {
    const session = this.getOrCreateSession(threadId)
    if (session.queue.find((entry) => entry.id === itemId)?.inboxIds?.length)
      throw new QueueValidationError('A queued subagent result is delivered as its own turn; it cannot be sent as a steer.')
    const localActive = session.isTurnActive() || this.isChannelTurnActive(threadId)
    const externalActive = this.isThreadLeaseHeldExternally(
      threadId,
      session.executionLease?.owner.token
    )
    if (!localActive && !externalActive) {
      throw new QueueValidationError('No active turn to steer on this thread.')
    }
    let item: QueuedMessage
    let promotedRunId: string | undefined
    let steerRunId: string | undefined
    // A steer joins the active run, so the promoted item no longer owns a run of its own.
    const promote = (items: QueuedMessage[]): QueuedMessage[] => {
      assertQueueRevision(items, opts?.expectedRevision)
      // A queued result notice is rebuilt when it runs and owns its rows; its stale text must not be sent as a steer.
      if (items.find((entry) => entry.id === itemId)?.inboxIds?.length)
        throw new QueueValidationError('A queued subagent result is delivered as its own turn; it cannot be sent as a steer.')
      // The run the text will join, and the mode it may run in, checked here under the queue lock against the run
      // the engine has now, and written on the item: nothing else can make the text join another run.
      const bind = this.checkPromotion(threadId, items.find((entry) => entry.id === itemId), opts)
      steerRunId = bind.steerRunId
      const result = promoteQueuedMessageToSteer(items, itemId, bind)
      promotedRunId = result.item.runId
      if (!promotedRunId) {
        item = result.item
        return result.items
      }
      const { runId: _runId, ...steer } = result.item
      item = steer
      return result.items.map((entry) => (entry.id === steer.id ? steer : entry))
    }
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, threadId, promote)
    } else {
      session.queue = promote(session.queue)
    }
    this.cancelQueuedRuns([promotedRunId])
    if (
      !localActive &&
      externalActive &&
      this.isThreadLeaseHeldExternally(threadId, session.executionLease?.owner.token)
    ) {
      this.emitQueueUpdated(threadId, session.queue)
      return true
    }

    return this.deliverPromotedItem(session, item!, steerRunId)
  }

  /**
   * Hands a promoted item's text to the live turn, with the item's identity, so the turn that reads it
   * acknowledges the item and a turn that never reads it demotes the item in place. No `await` between the
   * promotion's queue change and this call: the run it was checked against cannot end in between. A turn that
   * is not the run the item is bound to refuses the text; the promotion is then reverted.
   */
  private deliverPromotedItem(session: ThreadSession, item: QueuedMessage, steerRunId: string | undefined, byAgent = false): boolean {
    const threadId = session.threadId
    const steered = this.steerThread(threadId, item.content, undefined, undefined, item.origin?.kind === 'agent' ? item.origin : undefined, item.permissionMode, { id: item.id, ...(steerRunId ? { runId: steerRunId } : {}), ...(item.mode ? { mode: item.mode } : {}), ...(item.images?.length ? { images: item.images } : {}), ...(byAgent ? { byAgent } : {}) })
    if (steered) {
      // The item stays queued as steering until the turn's steer drain consumes its content. Dropping it here
      // would lose the message when the turn is aborted (which discards pendingSteer) before the next drain.
      this.emitQueueUpdated(threadId, session.queue)
      return true
    }
    // Revert promotion if steer was rejected.
    if (this.threadStore) session.queue = mutateDurableQueue(this.threadStore, threadId, (disk) => demoteSteerItems(disk, [item.id]))
    else session.queue = demoteSteerItems(session.queue, [item.id])
    this.emitQueueUpdated(threadId, session.queue)
    return false
  }

  /**
   * Whether a promotion may go ahead now, and what it binds the item to. The run the text will join is the
   * thread's active engine run, which must be the one the caller named (`expectedRunId`); a paused run is not
   * running and takes no steer. The mode the item may run in is its stored one (what the sender allowed),
   * narrowed by the caller's own mode when given: a running turn cannot be narrowed, so a run bound to a looser
   * mode than that never takes the text. A run that has not bound its turn yet is unknown, not strict.
   */
  private checkPromotion(
    threadId: string,
    item: QueuedMessage | undefined,
    opts?: { expectedRunId?: string; permissionCeiling?: PermissionMode }
  ): { steerRunId?: string; permissionMode?: PermissionMode } {
    if (!item) throw new QueueConflictError('queue_item_not_found', 'That message is not in the queue.')
    const engine = this.runEngine
    const active = engine?.getActiveRun(threadId) ?? null
    if (opts?.expectedRunId !== undefined && active?.runId !== opts.expectedRunId) {
      const named = engine?.getRun(opts.expectedRunId)
      const paused = named?.threadId === threadId && named.status === 'paused'
      throw new QueueConflictError(
        paused ? 'run_paused' : 'run_not_active',
        paused
          ? `Run ${opts.expectedRunId} is paused by a usage limit and has no live turn to steer; the message stays queued.`
          : `Run ${opts.expectedRunId} is not the thread's active run${active ? ` (${active.runId} is)` : ' (it has none)'}; nothing was changed.`,
        { expectedRunId: opts.expectedRunId, activeRunId: active?.runId ?? null }
      )
    }
    const limit = strictestMode(item.permissionMode, opts?.permissionCeiling)
    if (limit) {
      if (!active || !engine)
        throw new QueueConflictError('run_not_active', 'This message has a mode limit and can only join a run the engine knows; the thread has none now.', { expectedRunId: opts?.expectedRunId ?? null, activeRunId: null })
      const binding = engine.bindingForRun(active.runId)
      if (!binding)
        throw new QueueConflictError('run_not_ready', `Run ${active.runId} has not started its turn yet, so its mode is not known; try again once it is running.`, { activeRunId: active.runId })
      const targetMode = binding.policy.permissionMode ?? 'ask'
      if (isStricter(limit, targetMode))
        throw new QueueConflictError(
          'ceiling_exceeded',
          `Run ${active.runId} is running under a looser permission mode (${targetMode}) than this message may run in (${limit}); a running turn cannot be narrowed. It stays queued and runs as its own turn.`,
          { callerMode: limit, targetMode, activeRunId: active.runId }
        )
    }
    return { ...(active ? { steerRunId: active.runId } : {}), ...(limit ? { permissionMode: limit } : {}) }
  }

  /**
   * A person's edit of a queued message (the app, the CLI): its text and chat mode. The mode limit the message carries
   * stays (an edit never lets it do more). New text from a person makes it the person's message: an agent's origin and its
   * label no longer apply, so it counts as no agent hop, is not held behind a pause or a question, and a person's Stop keeps
   * it; the queued run made for the agent's message is cancelled and the message gets its own when it drains. A change of
   * chat mode alone leaves it the agent's. `expectedRevision` is checked under the queue lock; a message already steering a
   * turn or started is refused.
   */
  editQueuedItem(threadId: string, itemId: string, patch: { content?: string; mode?: ChatMode }, opts?: { expectedRevision?: string; permissionMode?: PermissionMode; sentFrom?: QueuedMessage['sentFrom'] }): QueuedMessage {
    const session = this.getOrCreateSession(threadId)
    let edited: QueuedMessage | undefined
    let droppedRun: string | undefined
    const edit = (items: QueuedMessage[]): QueuedMessage[] => {
      assertQueueRevision(items, opts?.expectedRevision)
      const current = items.find((entry) => entry.id === itemId)
      const takesOver = patch.content !== undefined && current?.origin?.kind === 'agent'
      // An edit from another computer leaves the message no looser than that computer's limit, whoever queued it
      // (the text is the editor's now), and records where the text came from.
      const limit = opts?.permissionMode ? strictestMode(current?.permissionMode, opts.permissionMode) : undefined
      const result = editQueuedMessage(items, itemId, { content: patch.content, mode: patch.mode, ...(takesOver ? { origin: null, dropRun: true } : {}), ...(limit ? { permissionMode: limit } : {}), ...(opts?.sentFrom ? { sentFrom: opts.sentFrom } : {}) })
      edited = result.item
      droppedRun = takesOver ? current?.runId : undefined
      return result.items
    }
    session.queue = this.threadStore ? mutateDurableQueue(this.threadStore, threadId, edit) : edit(session.queue)
    this.emitQueueUpdated(threadId, session.queue)
    this.cancelQueuedRuns([droppedRun])
    return edited!
  }

  /** The thread's queue and its revision as a reader sees it now (unfinished agent commands finished first). */
  queueSnapshot(threadId: string): QueueSnapshot {
    const store = this.threadStore
    let all: QueuedMessage[]
    if (store) {
      if (store.getQueueJournal()?.commands.listUnfinished(threadId).length) repairQueueJournal(store, threadId)
      all = store.loadMessageQueue(threadId)
    } else {
      all = this.getOrCreateSession(threadId).queue
    }
    let blocked: QueueSnapshot['blockedReason']
    try {
      this.assertQueueOpen(threadId)
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === 'merge_back_pending') blocked = 'merge_back_pending'
    }
    return {
      items: listPendingQueue(all).filter((item) => !item.internal),
      claimed: listClaimedQueue(all).filter((item) => !item.internal),
      revision: queueRevision(all),
      open: blocked === undefined,
      ...(blocked ? { blockedReason: blocked } : {})
    }
  }

  /**
   * The journal of agent commands on queues: set once the thread store and the run engine are both there. A
   * command is written to the run database before the queue file changes, and its effects commit with its
   * marker; `mutateDurableQueue` finishes whatever a crash left before any other change, and the boot repair
   * finishes the rest (SPEC §15.1).
   */
  private installQueueJournal(): void {
    const store = this.threadStore
    const engine = this.runEngine
    if (!store) return
    if (!engine) {
      store.setQueueJournal(undefined)
      return
    }
    store.setQueueJournal({ commands: new QueueCommands(engine.store.db), effects: this.queueEffects(engine) })
  }

  /**
   * Boot: finishes what an earlier daemon left unfinished in the queue command journal, once boot
   * reconciliation has settled the runs its effects touch (any change to a thread's queue finishes that
   * thread's entries first as well, so nothing waits for this).
   */
  recoverQueueCommandsOnBoot(): void {
    const store = this.threadStore
    const journal = store?.getQueueJournal()
    if (!store || !journal) return
    try {
      // Old finished entries go; so do the entries of a thread that no longer exists (nothing is left for them to finish).
      journal.commands.prune()
      for (const threadId of journal.commands.unfinishedThreadIds()) {
        if (!store.getThread(threadId)) {
          journal.commands.deleteForThread(threadId)
          continue
        }
        try {
          repairQueueJournal(store, threadId)
        } catch (error) {
          console.warn('a thread\'s unfinished queue commands could not be finished at boot', { threadId, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      console.warn('the queue command journal could not be read at boot', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  private queueEffects(engine: RunEngine): QueueEffects {
    return {
      activeRunId: (threadId) => engine.getActiveRun(threadId)?.runId ?? null,
      applyEffects: (intent) => {
        // The queued runs the item owned end cancelled (only still-queued ones: a claimed item's run may be starting).
        for (const runId of intent.cancelRunIds) {
          if (engine.getRun(runId)?.status !== 'queued') continue
          try {
            engine.markTerminal(runId, 'cancelled', { interruptedBy: intent.actor ? 'agent' : 'user' })
          } catch (error) {
            // A run from an earlier daemon epoch is the reconciler's; anything else rolls the whole commit back.
            if (!(error instanceof RunStoreError && error.code === 'stale_write')) throw error
          }
        }
        // Notice rows the removed item held go back to pending; only the rows still its own.
        if (intent.releaseInboxIds.length) {
          const owner = queueOwner(intent.itemId)
          const own = engine.inbox.getMany(intent.releaseInboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === owner)
          if (own.length) engine.inbox.release(own.map((row) => row.inboxId), owner)
        }
      },
      abandonWorkflow: (invocationId, threadId) => this.workflowChat?.abandon(invocationId, threadId),
      audit: (intent, entry) => {
        if (!intent.actor) return
        engine.store.appendEvent({
          threadId: intent.threadId,
          runId: null,
          type: 'agent.action',
          payload: { ...entry.details, action: entry.action, actorThreadId: intent.actor.threadId, actorRunId: intent.actor.runId, toolCallId: intent.actor.toolCallId }
        })
      },
      scheduleRepair: (threadId) => this.scheduleQueueRepair(threadId)
    }
  }

  /** An unfinished queue command is tried again in a few seconds, a few times; the next change to the queue and boot try as well. */
  private scheduleQueueRepair(threadId: string): void {
    const attempts = (this.queueRepairAttempts.get(threadId) ?? 0) + 1
    if (this.lifecycle.stopping || attempts > QUEUE_REPAIR_ATTEMPTS) return
    this.queueRepairAttempts.set(threadId, attempts)
    const timer = setTimeout(() => {
      this.releaseRetries.delete(timer)
      const store = this.threadStore
      if (this.lifecycle.stopping || !store) return
      try {
        repairQueueJournal(store, threadId)
        if (!store.getQueueJournal()?.commands.listUnfinished(threadId).length) this.queueRepairAttempts.delete(threadId)
      } catch (error) {
        console.warn('a queue command could not be repaired', { threadId, attempts, error: error instanceof Error ? error.message : String(error) })
      }
    }, QUEUED_ROW_RELEASE_RETRY_MS)
    timer.unref?.()
    this.releaseRetries.add(timer)
  }

  /**
   * One agent command on a thread's queue (`queue_enqueue`, `queue_edit`, `queue_remove`, `queue_reorder`,
   * `queue_promote_to_steer`; SPEC §15.1). Journaled and replayable by `options.clientRequestId`; every command
   * but an enqueue on the caller's own thread carries the revision the caller read and fails with a conflict when
   * the queue is not that any more. An agent can never widen what an item may do or pass its words off as a
   * person's: what it writes is labelled and stored as the agent's, under the stricter of the item's own limit and
   * the agent's mode, and what it promotes joins only the run it was checked against.
   */
  private queueCommandAsAgent(
    threadId: string,
    command: AgentQueueCommand,
    options: { clientRequestId: string; actor: AgentActor; level: AgentAccessLevel }
  ): AgentQueueResult {
    const store = this.threadStore
    this.requireRunEngine()
    if (!store?.getQueueJournal()) throw new Error('Queue commands need the run engine and the thread store.')
    if (!store.getThread(threadId)) throw new QueueConflictError('queue_item_not_found', `Thread ${threadId} is not available.`)
    const { actor } = options
    const cross = threadId !== actor.threadId
    const callerMode = this.runPermissionMode(actor.runId)
    // A bot's thread is driven by its owner and its bot engine: no queue command of an agent reaches it, its own turn included.
    this.assertNotBotThread(threadId)
    if (command.op === 'enqueue') this.assertQueueOpen(threadId)
    // Who wrote the item: this agent (its origin names its thread: an own note or a message it sent) or someone else. A
    // label such as the item's source never decides it: only the origin the daemon stamped on the message does.
    const authoredBy = (item: QueuedMessage): boolean => item.origin?.kind === 'agent' && item.origin.threadId === actor.threadId
    const agentItems = (items: QueuedMessage[]): number => listPendingQueue(items).filter((item) => item.origin?.kind === 'agent').length
    const full = (): never => {
      throw new DomainRpcError('agent_queue_full', `Thread ${threadId} already has ${AGENT_QUEUE_MAX_PER_THREAD} messages from agents waiting; try again later.`)
    }
    const found = (items: QueuedMessage[], itemId: string): QueuedMessage => {
      const item = items.find((entry) => entry.id === itemId)
      if (!item) throw new QueueConflictError('queue_item_not_found', `Queue item ${itemId} is not in the queue.`, { itemId })
      if (item.state === 'claimed' || item.internal) throw new QueueConflictError('item_started', `Queue item ${itemId} already started and can no longer be changed.`, { itemId })
      return item
    }
    const notSteering = (item: QueuedMessage): void => {
      if (item.state === 'steering') throw new QueueConflictError('item_steering', `Queue item ${item.id} is already steering the running turn.`, { itemId: item.id })
    }
    const base = { threadId, actor, cancelRunIds: [] as string[], releaseInboxIds: [] as string[] }
    let delivered: { item: QueuedMessage; steerRunId: string | undefined } | undefined
    let removed: QueuedMessage | undefined
    // What the agent supplied (not the revision it read): the same key with other fields is a mistake, not a retry.
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([command.op, threadId, 'itemId' in command ? command.itemId : null, 'content' in command ? command.content ?? null : null, 'mode' in command ? command.mode ?? null : null, 'orderedIds' in command ? command.orderedIds : null, 'expectedRunId' in command ? command.expectedRunId : null]))
      .digest('hex')
      .slice(0, 16)
    const outcome = runDurableQueueCommand(store, threadId, options.clientRequestId, (items): PlannedQueueCommand => {
      assertQueueRevision(items, command.expectedRevision)
      switch (command.op) {
        case 'enqueue': {
          // Every message an agent queues is the agent's, on its own thread too: it carries the writing run's hop count and
          // mode limit, counts in the cap of three, is held behind a pause and a waiting question, is cleared by a person's
          // Stop and runs as an agent's run (so an agent at its hop limit cannot start a fresh chain through its own queue).
          // On another thread the text is labelled too; on its own an agent reads its own note as written.
          if (agentItems(items) >= AGENT_QUEUE_MAX_PER_THREAD) full()
          const sender = this.withAgentHops(actor)
          const content = cross ? agentMessageText(sender.threadId, this.titleOf(sender.threadId), command.content) : command.content
          const origin = agentOriginOf(sender)
          const permissionMode: PermissionMode = callerMode
          // A thread a person keeps in Plan takes another agent's message as a plan turn, whatever mode it asked for.
          const mode: 'agent' | 'plan' = cross && this.lastChatModeOf(threadId) === 'plan' ? 'plan' : command.mode
          const request = normalizeSendRequest({ content, mode })
          const { item } = enqueueMessage(items, { threadId, content: request.content, mode: request.mode, source: 'mcp', permissionMode, origin })
          return {
            intent: { ...base, op: 'enqueue', itemId: item.id, item, expectedRevision: command.expectedRevision },
            ...(cross ? { audit: { action: 'queued_message', details: { itemId: item.id, length: command.content.length } } } : {})
          }
        }
        case 'edit': {
          const item = found(items, command.itemId)
          notSteering(item)
          const refusal = editRefusal(item)
          if (refusal) throw new QueueValidationError(refusal)
          if (item.origin?.kind === 'schedule') throw new QueueValidationError('A scheduled prompt keeps the text of its job; it cannot be edited by an agent.')
          const authored = authoredBy(item)
          // Changing a message nobody told this agent it wrote (a person's, another agent's) needs manage, on its own thread too.
          if (!authored && options.level !== 'manage')
            throw new QueueAccessError(`Editing a message ${item.origin ? 'another agent' : 'a person'} queued needs the "manage" agent access level (yours is "${options.level}").`)
          if (command.mode === 'agent' && item.mode === 'plan' && !authored)
            throw new QueueAccessError('A message queued as a plan turn cannot be turned into an agent turn by another writer.')
          if (command.mode === 'agent' && cross && this.lastChatModeOf(threadId) === 'plan')
            throw new QueueAccessError('A thread kept in Plan takes messages from other agents as plan turns only.')
          const patch: NonNullable<QueueIntent['patch']> = {}
          let cancelRunIds: string[] = []
          if (command.mode !== undefined) patch.mode = command.mode
          if (command.content !== undefined) {
            // The words are the agent's from here on, with this run's hop count: stored as its own, run under the stricter mode.
            // Another writer's message, or any message on another thread, is labelled; an agent's own note on its own thread is not.
            if (item.origin?.kind !== 'agent' && agentItems(items) >= AGENT_QUEUE_MAX_PER_THREAD) full()
            const sender = this.withAgentHops(actor)
            patch.content = cross || !authored ? agentMessageText(sender.threadId, this.titleOf(sender.threadId), command.content) : command.content
            patch.origin = agentOriginOf(sender)
            patch.permissionMode = strictestMode(item.permissionMode, callerMode)
            // Its queued run was made for the earlier writer: it gets a fresh one, with this sender's count, when it drains.
            patch.dropRun = true
            if (item.runId) cancelRunIds = [item.runId]
            // A thread a person keeps in Plan takes another agent's words as a plan turn, whatever mode the message had.
            if (cross && this.lastChatModeOf(threadId) === 'plan') patch.mode = 'plan'
          }
          if (patch.content === undefined && patch.mode === undefined) throw new QueueValidationError('queue_edit needs content or mode.')
          return {
            intent: { ...base, op: 'edit', itemId: item.id, patch, expectedRevision: command.expectedRevision, cancelRunIds },
            ...(cross || !authored ? { audit: { action: 'edited_queued_message', details: { itemId: item.id, ...(command.content !== undefined ? { length: command.content.length } : {}), changedMode: command.mode !== undefined, wasOrigin: item.origin?.kind ?? (item.source ?? 'person') } } } : {})
          }
        }
        case 'remove': {
          const item = found(items, command.itemId)
          notSteering(item)
          if (item.workflowInvocationId) throw new QueueValidationError('A workflow command can only be removed from the app.')
          // Removing a message nobody told this agent it wrote would replace a person's words as surely as editing it: manage.
          if (!authoredBy(item) && options.level !== 'manage')
            throw new QueueAccessError(`Removing a message ${item.origin ? 'another agent' : 'a person'} queued needs the "manage" agent access level (yours is "${options.level}").`)
          removed = item
          return {
            intent: {
              ...base,
              op: 'remove',
              itemId: item.id,
              expectedRevision: command.expectedRevision,
              cancelRunIds: item.runId ? [item.runId] : [],
              releaseInboxIds: item.inboxIds ?? [],
              ...(item.workflowInvocationId ? { abandonWorkflowInvocationId: item.workflowInvocationId } : {})
            },
            // Every removal is recorded with the text that was removed, so a person can see and recover it.
            audit: { action: 'removed_queued_message', details: { itemId: item.id, length: item.content.length, removedText: item.content.slice(0, REMOVED_TEXT_MAX_CHARS), ...(item.content.length > REMOVED_TEXT_MAX_CHARS ? { removedTextCut: true } : {}), wasOrigin: item.origin?.kind ?? (item.source ?? 'person') } }
          }
        }
        case 'reorder': {
          // Validated now (a permutation of the pending items); the same function applies it.
          reorderQueuedMessages(items, command.orderedIds)
          // Putting anything ahead of a message the agent did not write (it was behind it) postpones that message as surely as
          // removing it replaces it: manage. Moving the agent's own messages behind others', or among themselves, is free.
          if (options.level !== 'manage' && putsAheadOfOthers(items, command.orderedIds, authoredBy))
            throw new QueueAccessError(`Putting a message ahead of one a person or another agent queued needs the "manage" agent access level (yours is "${options.level}").`)
          const touchesOthers = listPendingQueue(items).some((item) => !item.internal && !authoredBy(item))
          return {
            intent: { ...base, op: 'reorder', itemId: command.orderedIds[0] ?? '', orderedIds: command.orderedIds, expectedRevision: command.expectedRevision },
            ...(cross || touchesOthers ? { audit: { action: 'reordered_queue', details: { count: command.orderedIds.length } } } : {})
          }
        }
        case 'promote': {
          const item = found(items, command.itemId)
          notSteering(item)
          if (item.workflowInvocationId) throw new QueueValidationError('A workflow command cannot be promoted to steering input')
          if (item.inboxIds?.length) throw new QueueValidationError('A queued subagent result is delivered as its own turn; it cannot be sent as a steer.')
          // A live provider settles the questions and approvals the user is being asked as the user when it takes a steer, and
          // an agent's promotion must never do that: it waits until the user has answered.
          if (this.questions.listPendingForThread(threadId).length > 0)
            throw new QueueConflictError('questions_pending', `Thread ${threadId} is waiting for the user to answer a question or approval; a steer would settle it for them. Promote the message after they have answered.`, { itemId: item.id })
          // Under the queue lock, against the run the engine has now: the text joins that run or nothing changes.
          const bind = this.checkPromotion(threadId, item, { expectedRunId: command.expectedRunId, permissionCeiling: callerMode })
          const session = this.getOrCreateSession(threadId)
          const turn = session.activeTurn
          if (!turn || turn.abort.signal.aborted || turn.runId !== bind.steerRunId)
            throw new QueueConflictError('run_not_ready', `Run ${command.expectedRunId} has no turn to steer yet (or its turn is not one this daemon runs); the message stays queued.`, { expectedRunId: command.expectedRunId, activeRunId: bind.steerRunId ?? null })
          delivered = { item, steerRunId: bind.steerRunId }
          return {
            intent: {
              ...base,
              op: 'promote',
              itemId: item.id,
              expectedRevision: command.expectedRevision,
              expectedRunId: command.expectedRunId,
              ...(bind.steerRunId ? { steerRunId: bind.steerRunId } : {}),
              ...(bind.permissionMode ? { permissionMode: bind.permissionMode } : {}),
              cancelRunIds: item.runId ? [item.runId] : []
            },
            ...(cross || !authoredBy(item) ? { audit: { action: 'promoted_queued_message', details: { itemId: item.id, runId: command.expectedRunId } } } : {})
          }
        }
      }
    }, fingerprint)
    const session = this.getOrCreateSession(threadId)
    session.queue = outcome.items
    this.emitQueueUpdated(threadId, session.queue)
    const result = outcome.result as unknown as Omit<AgentQueueResult, 'replayed' | 'effectsSettled'>
    if (!outcome.replayed) {
      if (command.op === 'enqueue') {
        this.touchUserActivityAndNotify(threadId)
        if (session.isTurnRunning() || session.turnAdmitted) session.drainAfterSettle = true
        else this.scheduleQueueDrain(session)
      }
      // No `await` since the checks above: the run is still the one the promotion was checked against.
      if (command.op === 'promote' && delivered && result.outcome === 'promoted') {
        const promoted = outcome.items.find((entry) => entry.id === delivered!.item.id)
        if (promoted) this.deliverPromotedItem(session, promoted, delivered.steerRunId, true)
      }
    }
    // The journal keeps the id of an enqueued message, never its text: the message is shown as it is in the queue now (a retry
    // after a turn took it has only the id). The text of a removed message goes back to the caller once and is in the event.
    const item = command.op === 'enqueue' ? outcome.items.find((entry) => entry.id === result.itemId) : undefined
    return {
      ...result,
      ...(item ? { item } : {}),
      ...(removed && !outcome.replayed ? { removedText: removed.content } : {}),
      replayed: outcome.replayed,
      effectsSettled: outcome.effectsSettled
    }
  }

  async generateThreadTitle(messages: ChatMessage[], threadId?: string): Promise<string> {
    const firstUser = messages.find((message) => message.role === 'user' && message.content.trim())
    const firstAssistant = messages.find(
      (message) => message.role === 'assistant' && !message.streaming && message.content.trim()
    )
    if (!firstUser) {
      throw new Error('A user message is required to generate a title.')
    }
    const heuristic =
      firstUser.content.trim().split('\n')[0]?.trim().slice(0, 60).slice(0, 80) || 'New Chat'
    const titleSettings = this.settingsStore.get().title
    const hasExplicitTitleModel = Boolean(titleSettings.llmProvider?.trim() && titleSettings.model?.trim())
    if (!hasExplicitTitleModel) {
      return heuristic
    }
    try {
      return await this.generateTitleText(firstUser.content, firstAssistant?.content, threadId)
    } catch (error) {
      // The chat keeps its first-line title. A failed request is logged; a refused title model was
      // already reported once (`reportTitleModelRefusal`).
      if ((error as { code?: unknown } | undefined)?.code !== 'unsupported')
        console.warn('[titles] the title model could not name the chat', { threadId, error: error instanceof Error ? error.message : String(error) })
      return heuristic
    }
  }

  /**
   * Names a chat with the chosen title model (Automatic never reaches here: it names the chat from
   * its first line). The selection is resolved through the gateway like any other: the instance the
   * picker chose (a legacy record maps to its built-in instance), and exactly that selection runs.
   * A disabled instance, a hidden model or an instance that cannot run a single request (an agent
   * runtime, a Bedrock model) is refused by its typed error, never swapped for another provider.
   */
  private async generateTitleText(userRequest: string, firstResponse: string | undefined, threadId: string | undefined): Promise<string> {
    const prompt = [
      'Write a concise title for this chat (maximum 7 words).',
      'Return only the title: no quotes, markdown, or ending punctuation.',
      '',
      `User request: ${userRequest.slice(0, 4000)}`,
      ...(firstResponse?.trim() ? [`First response: ${firstResponse.slice(0, 6000)}`] : [])
    ].join('\n')
    const text = await this.titleModelText('You name chat threads clearly and specifically.', prompt, {
      task: 'title',
      scope: threadId ? this.threadScope(threadId) : undefined,
      sessionKey: threadId ?? `title:${userRequest}`,
      maxChars: 400
    })
    return text
      .trim()
      .replace(/^["'`]+|["'`]+$/g, '')
      .replace(/[.!?:;]+$/g, '')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
  }

  /**
   * One request with no tools on the title model the user chose, through the gateway's `oneShot`:
   * chat titles, pull request drafts and commit messages. The gateway resolves the selection in
   * `scope`, bounds the wait and never retries; the caller falls back when it throws.
   */
  private async titleModelText(system: string, prompt: string, options: { task: OneShotTask; scope: ProviderScope | undefined; sessionKey: string; maxChars: number }): Promise<string> {
    try {
      const { text } = await this.harness.oneShot({
        selection: this.settingsStore.get().title,
        ...(options.scope ? { scope: options.scope } : {}),
        purpose: 'title',
        system,
        prompt,
        maxChars: options.maxChars,
        sessionKey: options.sessionKey,
        task: options.task
      })
      return text
    } catch (error) {
      this.reportTitleModelRefusal(error)
      throw error
    }
  }

  /**
   * A title model the gateway refuses outright (a Bedrock model, an agent runtime) fails every request
   * the same way. The reason is logged once per kind of refusal, and the thread's title failure event
   * carries it, rather than a warning on every chat; Settings → Agents shows the stored choice as
   * unavailable.
   */
  private reportTitleModelRefusal(error: unknown): void {
    if ((error as { code?: unknown } | undefined)?.code !== 'unsupported') return
    const message = error instanceof Error ? error.message : String(error)
    this.reportedTitleRefusals ??= new Set()
    if (this.reportedTitleRefusals.has(message)) return
    this.reportedTitleRefusals.add(message)
    console.warn('[titles] the title model cannot run this request', { message })
  }

  /**
   * Proposes a title and description for a branch's pull request from the originating thread's
   * conversation, the branch's commits and patch, and the repository's template. The title model writes
   * it when one is chosen (the same guard as `generateThreadTitle`); without one, or on any failure, a
   * plain draft built from the commits and the template is returned instead, so this never throws.
   */
  async draftPullRequest(params: {
    root: string
    branch: string
    base: string
    remote: string | null
    originThreadId: string | null
    /** The folder's project; the title model is resolved in its scope, so an instance turned off there is never used. */
    projectId: string | null
    threadName: string | null
  }): Promise<{ title: string; body: string; source: 'model' | 'heuristic' }> {
    const summary = await (this.gitService?.readBranchSummary(params.root, params).catch(() => null) ?? null)
    const template = await readPullRequestTemplate(params.root).catch(() => null)
    let conversation = ''
    if (params.originThreadId) {
      try {
        conversation = conversationExcerpt(this.getMessages(params.originThreadId))
      } catch {
        // A thread that cannot be read still gets a draft from its commits.
      }
    }
    const name = params.threadName?.trim()
    const inputs: PullRequestDraftInputs = {
      branch: params.branch,
      base: params.base,
      threadName: name && name !== 'New Chat' ? name : null,
      conversation,
      commits: summary?.commits ?? [],
      stat: summary?.stat ?? '',
      patch: summary?.patch ?? '',
      template
    }
    const heuristic = { ...heuristicPullRequestDraft(inputs), source: 'heuristic' as const }
    const titleSettings = this.settingsStore.get().title
    const hasExplicitTitleModel = Boolean(titleSettings.llmProvider?.trim() && titleSettings.model?.trim())
    if (!hasExplicitTitleModel || (!inputs.commits.length && !inputs.patch && !conversation)) return heuristic
    try {
      const prompt = buildPullRequestDraftPrompt(inputs)
      const text = await this.titleModelText(PULL_REQUEST_DRAFT_SYSTEM, prompt, {
        task: 'pull_request',
        scope: params.projectId ? { kind: 'project', projectId: params.projectId } : params.originThreadId ? this.threadScope(params.originThreadId) : { kind: 'device' },
        sessionKey: `pull-request-draft:${params.originThreadId ?? prompt.slice(0, 200)}`,
        maxChars: 40_000
      })
      const parsed = parsePullRequestDraft(text)
      return parsed ? { ...parsed, source: 'model' } : heuristic
    } catch {
      return heuristic
    }
  }

  /**
   * Writes a commit message for what the next commit in `root` would take, with the title model. Only a
   * title model the user chose is used (Automatic never reaches a model, as for chat titles): without one
   * this refuses with `git_suggest_no_model` before reading anything, so the caller can say so. The model
   * is resolved in the folder's project, so an instance turned off there is never used. Nothing is written
   * to the repository; the message is a proposal the user edits.
   */
  async generateCommitMessage(params: {
    root: string
    /** The commit takes every change, as in a thread's worktree; else staged changes when there are any. */
    all: boolean
    /** The folder's project; the title model is resolved in its scope. */
    projectId: string | null
    /** The thread whose worktree this is, when it is one; names the provider's cache session. */
    threadId: string | null
    branch?: string | null
  }): Promise<{ message: string; truncated: boolean }> {
    const titleSettings = this.settingsStore.get().title
    if (!titleSettings.llmProvider?.trim() || !titleSettings.model?.trim()) throw commitSuggestionErrors.create('git_suggest_no_model')
    const input = await this.gitService?.describeCommitInput(params.root, { all: params.all })
    if (!input || input.files.length === 0) throw commitSuggestionErrors.create('git_suggest_empty')
    try {
      const prompt = buildCommitSuggestionPrompt(input, params.branch)
      const text = await this.titleModelText(COMMIT_SUGGESTION_SYSTEM, prompt, {
        task: 'commit_message',
        scope: params.projectId ? { kind: 'project', projectId: params.projectId } : params.threadId ? this.threadScope(params.threadId) : { kind: 'device' },
        sessionKey: `commit-message:${params.threadId ?? prompt.slice(0, 200)}`,
        maxChars: 20_000
      })
      const message = parseCommitSuggestion(text)
      if (!message) throw new Error('The model answered without a commit message')
      return { message, truncated: input.truncated }
    } catch (error) {
      throw commitSuggestionErrors.create('git_suggest_failed', error)
    }
  }

  /**
   * Promote a draft into a sidebar-visible thread as soon as the user commits
   * the first send. Title generation is often slow; without this, switching away
   * mid-title leaves the thread filtered out until a rename arrives.
   */
  private markThreadStartedAndNotify(threadId: string): void {
    if (!this.threadStore || threadId === '__unbound__') return
    try {
      const result = this.threadStore.markThreadStarted(threadId)
      if (result?.newlyStarted) {
        this.emit('thread-started', { threadId, thread: result.thread })
      }
    } catch {
      // Best-effort: message persistence still sets startedAt later.
    }
  }

  /**
   * User send/enqueue: reveal the draft and move it to the top of its group.
   * Agent streaming and internal wakes must not call this.
   */
  private touchUserActivityAndNotify(threadId: string): void {
    if (!this.threadStore || threadId === '__unbound__') return
    try {
      const result = this.threadStore.touchThreadUserActivity(threadId)
      if (result?.newlyStarted) {
        this.emit('thread-started', { threadId, thread: result.thread })
      }
    } catch {
      // Best-effort: message persistence still sets startedAt later.
    }
  }

  /**
   * Name a newly-created thread before its first turn starts. This is deliberately
   * awaited by executeTurn: title generation must not race the first response (or
   * leave the sidebar showing "New Chat" after the turn has already begun).
   *
   * Title generation is best-effort. A missing/unconfigured title provider must not
   * prevent the user's actual message from being sent; the awaited call still makes
   * successful title generation deterministic and visible before the turn runs.
   */
  private async generateInitialThreadTitleForThread(
    threadId: string,
    userContent: string
  ): Promise<void> {
    if (!this.threadStore || threadId === '__unbound__') return

    const thread = this.threadStore.getThread(threadId)
    // Keep retrying while the auto-created label remains. This recovers from a
    // transient title-provider failure on the next send without renaming user titles.
    if (!thread || !isDefaultThreadName(thread.name)) return

    const titleSettings = this.settingsStore.get().title
    const hasExplicitTitleModel = Boolean(titleSettings.llmProvider?.trim() && titleSettings.model?.trim())
    const heuristic = (userContent.trim().split('\n')[0]?.trim().slice(0, 60) || 'New Chat').slice(0, 80)
    if (!hasExplicitTitleModel) {
      if (!heuristic || isDefaultThreadName(heuristic)) return
      const updated = this.threadStore.updateThreadMeta(threadId, { name: heuristic })
      this.emit('thread-title-updated', { threadId, thread: updated })
      return
    }
    let title: string | null = null
    try {
      title = await this.generateTitleText(userContent, undefined, threadId)
    } catch (error) {
      this.emit('thread-title-generation-failed', {
        threadId,
        error: error instanceof Error ? error.message : String(error)
      })
    }
    const finalTitle = (title?.trim() ? title.trim() : heuristic).slice(0, 80)
    if (!finalTitle || isDefaultThreadName(finalTitle)) return
    const updated = this.threadStore.updateThreadMeta(threadId, { name: finalTitle })
    this.emit('thread-title-updated', { threadId, thread: updated })
  }

  private async generateInitialThreadTitle(
    session: ThreadSession,
    userContent: string
  ): Promise<void> {
    await this.generateInitialThreadTitleForThread(session.threadId, userContent)
  }

  getNativeContext(threadId?: string): NativeLlmContext {
    if (!threadId || threadId === this.boundSession.threadId) {
      return structuredClone(this.boundSession.nativeContext)
    }
    return structuredClone(this.getOrCreateSession(threadId).nativeContext)
  }

  private clearLastTurnUsage(): void {
    this.lastMeasuredInput = null
    this.lastMeasuredCacheRead = null
    this.lastMeasuredCacheWrite = null
    this.lastMeasuredContextSignature = null
    this.measuredAtHistoryLength = 0
    if (this.nativeContext.lastTurnUsage) {
      const { lastTurnUsage: _stale, ...rest } = this.nativeContext
      this.nativeContext = rest
    }
  }

  private recordLastTurnUsage(usage: NonNullable<NativeLlmContext['lastTurnUsage']>): void {
    this.lastMeasuredInput = usage.input
    this.lastMeasuredCacheRead = usage.cacheRead
    this.lastMeasuredCacheWrite = usage.cacheWrite
    this.lastMeasuredContextSignature = usage.signature
    this.measuredAtHistoryLength = usage.measuredAtHistoryLength
    this.nativeContext = {
      ...this.nativeContext,
      lastTurnUsage: { ...usage }
    }
  }

  private commitActiveNativeMessages(
    activeMessages: Parameters<typeof commitNativeMessages>[1],
    checkpoint?: NativeMessageCheckpoint
  ): void {
    this.nativeContext = commitNativeMessages(this.nativeContext, activeMessages, checkpoint)
  }

  async getContextUsage(
    input: OrchestratorContextUsageInput = '',
    threadId?: string
  ): Promise<ContextUsageSnapshot> {
    const run = async (): Promise<ContextUsageSnapshot> => {
      const request = normalizeContextUsageRequest(input)
      const modelOverride = this.session.modelOverride
      const selectedModel = modelOverride ?? resolveModelForMode(this.settingsStore.get(), request.mode, [
        ...(this.providerAuth.credentials?.listProviderIds() ?? []),
        ...this.harness.configuredProviderIds()
      ])
      // Nothing to measure against before a model is chosen (a fresh profile): an empty gauge.
      if (!selectedModel.model?.trim() || !(selectedModel.instanceId?.trim() || selectedModel.llmProvider?.trim()))
        return { percent: 0, used: 0, limit: 0, modelName: selectedModel.model ?? '', source: 'estimated', categories: [] }
      // The gauge never fails: a selection that cannot be resolved shows no measurement.
      let caps: HarnessCaps | undefined
      try {
        caps = this.harness.resolveStored(selectedModel, { purpose: 'composer', allowDisabled: true }).caps
      } catch {
        caps = undefined
      }
      // Runtimes own their context. Without a reported window, do not display a fabricated Mousse
      // context measurement.
      if (!caps || contextGauge(caps) !== 'reported') {
        return { percent: 0, used: 0, limit: 0, modelName: selectedModel.model, source: 'estimated', categories: [] }
      }
      const key = `${selectedModel.llmProvider}:${selectedModel.model}`
      const stored = this.nativeContext.lastTurnUsage
      const capacity = this.nativeContext.nativeProviderModel
      const matches = stored?.modelKey === key && stored.contextRevision === (this.nativeContext.revision ?? 0)
      const limit = capacity?.selectedModel === selectedModel.model ? capacity.contextWindow ?? 0 : 0
      const usage = computeContextUsage({
        messages: getActiveMessages(this.nativeContext), draftInput: request.draftInput,
        contextLimit: limit, modelName: capacity?.selectedModel === selectedModel.model ? capacity.modelName : selectedModel.model,
        lastMeasuredInput: matches ? stored.input : null,
        lastMeasuredCacheRead: matches ? stored.cacheRead : null,
        lastMeasuredCacheWrite: matches ? stored.cacheWrite : null,
        measuredAtMessageLength: matches ? stored.measuredAtHistoryLength : 0,
        summaryText: getCompactionSummary(this.nativeContext),
        systemPromptText: '', legacyEstimated: this.nativeContext.fidelity === 'legacy-estimated'
      })
      const latestResponse = [...this.session.messages].reverse().find((message) => message.responseMetadata?.tokensUsed !== undefined)
      return { ...usage, limit, modelLimit: limit, percent: limit > 0 ? usage.percent : 0, processedTokens: latestResponse?.responseMetadata?.tokensUsed }
    }
    if (threadId && threadId !== this.session.threadId) {
      const session = this.getOrCreateSession(threadId)
      return this.sessionAls.run(session, () => run())
    }
    return run()
  }

  private addSystemMessage(content: string): void {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      content,
      timestamp: new Date().toISOString()
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
  }

  private addPlanCardMessage(
    originalRequest: string,
    planMarkdown: string,
    responseMetadata?: ChatMessage['responseMetadata']
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      kind: 'plan_card',
      content: planMarkdown,
      planCard: { originalRequest, planMarkdown },
      responseMetadata,
      timestamp: new Date().toISOString()
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
    return msg
  }

  /** present_plan tool target: emit an inline approval card from any mode
   * (notably Agent mode). The model decides when planning beats answering,
   * editing, or delegating. */
  private presentPlanCard(
    payload: { title: string; markdown: string },
    threadId?: string
  ): void {
    const markdown = payload.markdown?.trim()
    if (!markdown) return
    const title = payload.title?.trim()
    const lastUser = [...this.messages].reverse().find((message) => message.role === 'user')
    const originalRequest = title || lastUser?.content?.trim() || 'Implementation plan'
    this.addPlanCardMessage(originalRequest, markdown)
    if (threadId) this.emitThreadMessages(threadId, this.messages)
  }

  private appletCatalogue(): string {
    const references = this.messages.filter(message => !message.hidden).flatMap(message => message.presentationParts ?? []).filter(part => part.type === 'applet').map(part => part.reference)
    return references.length ? '\nExisting applets in this conversation (use appletId and expectedRevision to revise; latest visible revision per applet):\n' + JSON.stringify([...new Map(references.map(ref => [ref.appletId, ref])).values()].slice(-20)) : ''
  }

  private addMessage(
    role: 'user' | 'assistant',
    content: string,
    images?: ChatImageAttachment[],
    responseMetadata?: ChatMessage['responseMetadata'],
    queueItemId?: string,
    mode?: ChatMode,
    subagentNotice?: SubagentNoticeItem[],
    steered?: boolean,
    origin?: AgentOrigin
  ): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role,
      content,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      responseMetadata,
      queueItemId: role === 'user' && queueItemId ? queueItemId : undefined,
      ...(role === 'user' && mode !== undefined ? { mode: normalizeChatMode(mode) } : {}),
      ...(role === 'user' && subagentNotice?.length ? { subagentNotice } : {}),
      ...(role === 'user' && steered ? { steered: true } : {}),
      ...(role === 'user' && origin ? { origin } : {})
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist(true)
    return msg
  }

  /**
   * Fail-closed transcript provenance for a queue claim.
   * - `accepted` — queueItemId is durably present; may complete, never release/re-execute
   * - `not_accepted` — readable transcript without the id; may release a pre-accept claim
   * - `unavailable` — transcript unreadable; leave claim claimed, never release or re-execute
   */
  private inspectDurableQueueProvenance(
    threadId: string,
    queueItemId: string
  ): 'accepted' | 'not_accepted' | 'unavailable' {
    if (!this.threadStore || threadId === '__unbound__') return 'not_accepted'
    try {
      if (!this.threadStore.getThread(threadId)) return 'not_accepted'
      const data = this.threadStore.loadThreadData(threadId)
      const transcriptAccepted = data.messages.some((message) => message.queueItemId === queueItemId)
      const contextAccepted = data.llmContext?.acceptedQueueItemIds?.includes(queueItemId) === true
      if (transcriptAccepted && contextAccepted) return 'accepted'
      if (!transcriptAccepted && !contextAccepted) return 'not_accepted'
      // A torn/legacy admission is not proof that execution may safely repeat.
      return 'unavailable'
    } catch {
      return 'unavailable'
    }
  }

  /**
   * After a turn/accept failure: only a definite `not_accepted` may release.
   * `accepted` completes; `unavailable` leaves the durable claim untouched.
   */
  private settleClaimAfterFailure(
    session: ThreadSession,
    itemId: string,
    ownerToken: string | undefined,
    context: string
  ): void {
    const status = this.inspectDurableQueueProvenance(session.threadId, itemId)
    if (status === 'accepted') {
      this.completeSessionClaim(session, itemId, ownerToken)
      return
    }
    if (status === 'not_accepted') {
      this.releaseSessionClaim(session, itemId, ownerToken)
      return
    }
    this.emit('queue-drain-failed', {
      threadId: session.threadId,
      queueItemId: itemId,
      error: `transcript provenance unreadable (${context}); durable claim left claimed`
    })
  }

  /**
   * Coherently accept user input into messages + native context with a single persist.
   * On failure without durable provenance: roll back in-memory mutations and resync observers.
   * If transcript provenance is already durable, keep memory state and treat as accepted
   * (do not release/reappend) even when a later part of the write failed.
   * If provenance is unreadable: roll back speculative memory, leave durable claim claimed.
   */
  private acceptTurnUserInput(
    session: ThreadSession,
    userContent: string,
    images: ChatImageAttachment[] | undefined,
    displayUserMessage: boolean,
    queueItemId?: string,
    mode?: ChatMode,
    workflowRun?: WorkflowChatRun,
    subagentNotice?: SubagentNoticeItem[],
    permissionMode?: PermissionMode,
    scheduled?: ScheduledTurnRef,
    approvalNote?: string,
    agent?: AgentOrigin
  ): { claimAccepted: boolean } {
    const messagesBefore = this.messages.length
    const nativeBefore = structuredClone(this.nativeContext)
    // A mid-chat mode switch must reach the model even though the transcript UI
    // shows no marker: inject a hidden notice into both durable stores before
    // the visible user message. Internal wakes (hidden) never advance the
    // tracked mode, so they neither emit nor consume notices.
    let modeNotice: ChatMessage | null = null
    if (displayUserMessage && mode !== undefined) {
      const currentMode = normalizeChatMode(mode)
      const previousMode = getLastUserChatMode(this.messages)
      if (previousMode !== undefined && !chatModeEquals(previousMode, currentMode)) {
        modeNotice = {
          id: uuidv4(),
          role: 'user',
          content: buildModeChangeNotice(previousMode, currentMode),
          timestamp: new Date().toISOString(),
          hidden: true,
          mode: currentMode
        }
      }
    }
    // The same for the permission mode: the notice and the stamp carry the mode the turn runs in
    // (the effective one), so a chosen mode the instance cannot enforce produces no notice and the
    // next comparison is stable.
    let permissionNotice: ChatMessage | null = null
    if (displayUserMessage && permissionMode !== undefined) {
      const previousPermission = getLastUserPermissionMode(this.messages)
      if (previousPermission !== undefined && previousPermission !== permissionMode) {
        permissionNotice = {
          id: uuidv4(),
          role: 'user',
          content: buildPermissionModeChangeNotice(previousPermission, permissionMode),
          timestamp: new Date().toISOString(),
          hidden: true,
          permissionMode
        }
      }
    }
    // Decisions the user made about approval requests while the agent could not be asked reach it
    // with the message that delivers them (SPEC §17.4), before the visible message.
    const decisionNotice: ChatMessage | null = approvalNote
      ? { id: uuidv4(), role: 'user', content: approvalNote, timestamp: new Date().toISOString(), hidden: true }
      : null
    const addedMessage: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: images?.length ? images : undefined,
      queueItemId: queueItemId || undefined,
      workflowInvocationId: workflowRun?.invocationId,
      ...(subagentNotice?.length ? { subagentNotice } : {}),
      // A job's prompt is not something the person typed; the thread can say whose it is.
      ...(scheduled ? { scheduled: { jobId: scheduled.jobId, ...(scheduled.jobName ? { jobName: scheduled.jobName } : {}) } } : {}),
      // A message another thread's agent wrote is stored as that agent's, never as something a person typed.
      ...(agent ? { origin: agentOriginOf(agent) } : {}),
      hidden: displayUserMessage ? undefined : true,
      ...(displayUserMessage && mode !== undefined
        ? { mode: normalizeChatMode(mode) }
        : {}),
      ...(displayUserMessage && permissionMode !== undefined ? { permissionMode } : {})
    }
    // Hidden internal inputs remain in the durable transcript for queue-claim provenance,
    // while presentation APIs and events omit them from the UI.
    if (modeNotice) {
      this.messages.push(modeNotice)
      this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(modeNotice.content))
    }
    if (permissionNotice) {
      this.messages.push(permissionNotice)
      this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(permissionNotice.content))
    }
    if (decisionNotice) {
      this.messages.push(decisionNotice)
      this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(decisionNotice.content))
    }
    this.messages.push(addedMessage)
    this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(userContent, images))
    if (queueItemId) {
      this.nativeContext = {
        ...this.nativeContext,
        acceptedQueueItemIds: Array.from(new Set([
          ...(this.nativeContext.acceptedQueueItemIds ?? []),
          queueItemId
        ]))
      }
    }
    // Queue provenance and the durable run link must become visible together.
    const workflowMessage: ChatMessage | undefined = workflowRun ? {
      id: uuidv4(), role: 'assistant', timestamp: new Date().toISOString(), workflowRun,
      content: `Workflow: ${workflowRun.title}\nRun: ${workflowRun.runId}\nRevision: ${workflowRun.revisionId}\nState at admission: ${workflowRun.state}`
    } : undefined
    if (workflowMessage) {
      this.messages.push(workflowMessage)
      this.nativeContext = appendNativeMessage(
        this.nativeContext,
        userMessage('[Mousse workflow admission]\n' + workflowMessage.content)
      )
    }

    try {
      this.persist(true)
    } catch (err) {
      const status = queueItemId
        ? this.inspectDurableQueueProvenance(session.threadId, queueItemId)
        : 'not_accepted'
      if (status === 'accepted') {
        // Transcript provenance is durable — keep in-memory state; do not roll back or release.
        if (!addedMessage.hidden) this.emitMessageAdded(addedMessage)
        if (workflowMessage) this.emitMessageAdded(workflowMessage)
        throw err
      }
      // Roll back speculative mutations. For unavailable provenance, do not mutate durable claim.
      this.messages.splice(messagesBefore)
      this.nativeContext = nativeBefore
      this.emitThreadMessages(session.threadId, session.messages)
      if (status === 'unavailable' && queueItemId) {
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId,
          error:
            'transcript provenance unreadable after accept failure; durable claim left claimed'
        })
      }
      throw err
    }

    if (!addedMessage.hidden) this.emitMessageAdded(addedMessage)
    if (workflowMessage) this.emitMessageAdded(workflowMessage)
    return { claimAccepted: true }
  }

  private addToolCallMessage(action: OrchestratorAction): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind: 'tool_call',
      content: '',
      timestamp: new Date().toISOString(),
      toolCall: getToolCallDisplay(action)
    }
    this.messages.push(msg)
    this.emitMessageAdded(msg)
    this.persist()
    return msg
  }

  private updateToolTimelineMessage(
    messageId: string,
    toolCall: NonNullable<ChatMessage['toolCall']>,
    immediate = false
  ): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return

    const updated: ChatMessage = {
      ...this.messages[index],
      toolCall
    }
    this.messages[index] = updated
    this.emitMessageUpdated(updated)
    this.persist(immediate)
  }

  /** The current session's streaming transcript assembler (SPEC §13.4 shared builders). */
  private get transcript(): TranscriptAssembler {
    const session = this.session
    let assembler = this.transcripts.get(session)
    if (!assembler) {
      assembler = new TranscriptAssembler(
        {
          getMessage: (id) => session.messages.find((message) => message.id === id),
          addMessage: (message) => {
            session.messages.push(message)
          },
          updateMessage: (message) => {
            const index = session.messages.findIndex((entry) => entry.id === message.id)
            if (index !== -1) session.messages[index] = message
          },
          removeMessage: (id) => this.removeMessage(id),
          emitAdded: (message) => this.emitMessageAdded(message),
          emitUpdated: (message) => this.emitMessageUpdated(message),
          persist: (force) => this.persist(force),
          currentRunId: () => session.activeTurn?.runId,
          setPhase: (phase, patch) => this.setTurnPhase(session.threadId, phase, patch)
        },
        session
      )
      this.transcripts.set(session, assembler)
    }
    return assembler
  }

  private addStreamingAssistantMessage(): ChatMessage {
    return this.transcript.startAssistant()
  }

  private updateStreamingAssistantMessage(
    messageId: string,
    content: string,
    streaming: boolean,
    responseMetadata?: ChatMessage['responseMetadata'],
    incomplete?: boolean
  ): void {
    this.transcript.updateAssistant(messageId, content, streaming, responseMetadata, incomplete)
  }

  private removeMessage(messageId: string): void {
    const index = this.messages.findIndex((message) => message.id === messageId)
    if (index === -1) return
    this.messages.splice(index, 1)
    this.emitThreadMessages(this.session.threadId, this.session.messages)
    this.persist(true)
  }

  private handleStreamingTextEvent(event: StreamingLlmTextEvent): void {
    this.transcript.text(event)
  }

  private handleStreamingThinkingEvent(event: StreamingLlmThinkingEvent): void {
    this.transcript.thinking(event)
  }

  private handleStreamingToolEvent(event: StreamingLlmToolEvent): void {
    this.transcript.tool(event)
  }

  // retained for non-GUI callers (CLI/channels)
  isTurnActive(threadId?: string): boolean {
    if (threadId) {
      const session =
        this.boundSession.threadId === threadId
          ? this.boundSession
          : this.sessions.get(threadId)
      return Boolean(session?.isTurnActive())
    }
    return this.boundSession.isTurnActive()
  }

  /**
   * Abort the active GUI/CLI orchestrator turn for a thread (defaults to bound thread).
   * Does not clear the durable normal message queue unless clearQueue is true. With `runId` only that
   * run's turn is aborted: a Stop of a run must not reach a later turn of the thread (a fresh message
   * sent after the Stop). This is the internal primitive; a public Stop is `stopThread`, which wraps it.
   */
  abortActiveTurn(threadId?: string, opts?: { clearQueue?: boolean; runId?: string }): boolean {
    const id = threadId ?? this.getBoundThreadId()
    const session = id
      ? this.boundSession.threadId === id
        ? this.boundSession
        : this.sessions.get(id)
      : this.boundSession
    if (!session) return false
    const active = session.activeTurn
    // A definition run on the thread (it admits the session without an active turn of its own).
    // A definition run on the thread is stopped (only the one whose record is `runId`, when given),
    // and so is an ordinary turn the Stop also reaches: one does not hide the other.
    let stopped = id ? this.stopDefinitionRuns(id, opts?.runId) : false
    // The session's admission held by a definition run for its whole execution is not an ordinary turn's.
    const fencedByDefinition = Boolean(id && [...(this.definitionStops.get(id) ?? [])].some((entry) => entry.admitted))
    if (!active && session.turnAdmitted && !fencedByDefinition && !session.abortRequested) {
      // Admitted but still in recovery/workspace setup: abort as soon as the turn starts. A turn that has
      // not marked its run starting yet is a queued run, which a Stop cancels by id instead.
      if (!(opts?.runId && id && this.runEngine?.getActiveRun(id)?.runId !== opts.runId)) {
        session.abortRequested = true
        stopped = true
      }
    } else if (active && !active.abort.signal.aborted && !(opts?.runId && active.runId && active.runId !== opts.runId)) {
      active.pendingSteer = []
      active.abort.abort()
      stopped = true
    }
    if (!stopped) return false
    if (opts?.clearQueue && id) {
      let clearedRunIds: Array<string | undefined> = []
      let clearedItems: QueuedMessage[] = []
      const clear = (items: QueuedMessage[]): QueuedMessage[] => {
        const retained = clearPendingQueue(items)
        const retainedIds = new Set(retained.map((item) => item.id))
        clearedItems = items.filter((item) => !retainedIds.has(item.id))
        clearedRunIds = clearedItems.map((item) => item.runId)
        // Before the clear is saved (see removeQueuedItem).
        this.releaseQueuedRows(clearedItems)
        for (const item of items) {
          if (item.workflowInvocationId && !retainedIds.has(item.id)) {
            if (!this.workflowChat) throw new Error('Workflow queue cancellation is unavailable')
            this.workflowChat.abandon(item.workflowInvocationId, id)
          }
        }
        return retained
      }
      if (this.threadStore) {
        // A failed durable clear must not pretend that pending work disappeared.
        session.queue = mutateDurableQueue(this.threadStore, id, clear)
      } else {
        session.queue = clear(session.queue)
      }
      this.emitQueueUpdated(id, session.queue)
      this.cancelQueuedRuns(clearedRunIds)
    }
    this.emit('turn-aborted', { threadId: id ?? undefined })
    return true
  }

  isConversationHistoryBusy(threadId: string): boolean {
    const session = this.getOrCreateSession(threadId)
    this.refreshSessionQueueFromDisk(session)
    return session.isTurnRunning() || listPendingQueue(session.queue).length > 0
  }

  /**
   * Close a turn only after final response persistence and action execution.
   * During that finalizing window, sends must queue and steers must remain
   * attached to the active turn instead of racing a concurrent turn.
   */
  private settleActiveTurn(
    session: ThreadSession,
    turn: NonNullable<ThreadSession['activeTurn']>,
    aborted: boolean,
    opts?: { onTurnSettled?: (aborted: boolean) => void },
    failed = false,
    paused = false
  ): void {
    const wasAborted = aborted || turn.abort.signal.aborted
    const hadUnreadSteers = !wasAborted && turn.pendingSteer.length > 0
    if (hadUnreadSteers) {
      const pending = turn.pendingSteer
      const carried = turn.carriedSteers ?? []
      turn.pendingSteer = []
      turn.carriedSteers = []
      if (session.threadId !== '__unbound__' && !session.deleted) {
        const mode = getLastUserChatMode(session.messages) ?? 'agent'
        // What the turn never read goes on as turns of their own. A steer that carried subagent
        // results is one turn per steer (it owns its rows and is rebuilt when it runs); the user's
        // own text is a plain follow-up that nothing rebuilds.
        // They are queued in the order they arrived.
        const remaining = [...carried]
        let plain: string[] = []
        const flush = (): void => {
          const leftover = plain.join('\n').trim()
          plain = []
          if (!leftover) return
          // The follow-up is a queued run from the start, so the thread stays held without memory (a restart included).
          let runId: string | undefined
          try {
            runId = this.runEngine?.store.createRun({ threadId: session.threadId, source: 'steer-followup' }).runId
          } catch {
            // Without a run the person's text is still queued; the thread is just not held for it.
          }
          try {
            this.enqueueForThread(session.threadId, { content: leftover, mode }, { source: 'steer-followup', internal: true, runId })
          } catch {
            // Best-effort: settlement must not fail if the follow-up cannot queue.
            this.cancelQueuedRuns([runId])
          }
        }
        // A promoted queue item the turn never read goes back to being the queued message it was (or, if the
        // item is gone, is queued again from the entry): the same limits, exactly one turn, in its place.
        const items = pending.filter((entry) => entry.itemId)
        if (items.length) this.settleUnreadItems(session, items, mode)
        for (const steer of pending) {
          if (steer.itemId) continue
          const text = steer.text
          // An agent's steer the turn never read is a turn of its own, never merged into a person's text: it
          // keeps who sent it, and runs under the sender's mode (not the thread's own, which may be looser).
          if (steer.origin) {
            flush()
            let agentRunId: string | undefined
            try {
              agentRunId = this.runEngine?.store.createRun({
                threadId: session.threadId,
                source: 'steer-followup',
                outcome: { sentByAgent: true, agentHops: steer.origin.hops ?? 1 }
              }).runId
            } catch {
              // Without a run the text is still queued; the thread is just not held for it.
            }
            try {
              this.enqueueForThread(session.threadId, { content: steer.text, mode }, { source: 'steer-followup', internal: true, runId: agentRunId, origin: steer.origin, ...(steer.permissionMode ? { permissionMode: steer.permissionMode } : {}) })
            } catch {
              this.cancelQueuedRuns([agentRunId])
            }
            continue
          }
          // A person's steer from another computer that the turn never read keeps that computer's limit: it is a
          // turn of its own at no more than the limit, not merged into text that runs at the thread's mode.
          if (steer.permissionMode) {
            flush()
            let limitedRunId: string | undefined
            try {
              limitedRunId = this.runEngine?.store.createRun({ threadId: session.threadId, source: 'steer-followup' }).runId
            } catch {
              // Without a run the text is still queued; the thread is just not held for it.
            }
            try {
              this.enqueueForThread(session.threadId, { content: steer.text, mode }, { source: 'steer-followup', internal: true, runId: limitedRunId, permissionMode: steer.permissionMode, ...(steer.sentFrom ? { sentFrom: steer.sentFrom } : {}) })
            } catch {
              this.cancelQueuedRuns([limitedRunId])
            }
            continue
          }
          const at = remaining.findIndex((entry) => entry.text === text)
          if (at < 0) {
            plain.push(text)
            continue
          }
          flush()
          const [entry] = remaining.splice(at, 1)
          try {
            this.enqueueCarrying(session.threadId, { content: entry.text, mode }, { source: 'steer-followup', internal: true }, [entry], entry.subagentNotice)
          } catch {
            // Settlement must not fail; the rows go back to pending so rule 4 delivers them instead.
            this.runEngine?.inbox.release(entry.inboxIds, entry.effectId)
          }
        }
        flush()
        for (const entry of remaining) this.runEngine?.inbox.release(entry.inboxIds, entry.effectId)
      }
    }
    if (session.activeTurn === turn) session.activeTurn = null
    // The turn's terminal write saw its unread steers and held the thread's tasks. They are queued as a
    // follow-up turn now (which keeps holding them), or were dropped (which releases them).
    if (hadUnreadSteers) this.reevaluateHold(session.threadId)
    opts?.onTurnSettled?.(wasAborted)
    // A paused run is neither finished nor failed: its thread rests until the limit resets.
    this.emit(wasAborted ? 'turn-interrupted' : paused ? 'turn-paused' : failed ? 'turn-failed' : 'turn-completed', {
      threadId: session.threadId
    })
  }

  /** The user's `runs` settings, read when a run pauses and never afterwards. */
  private runSettings(): ReturnType<typeof normalizeRunSettings> {
    try {
      return normalizeRunSettings(this.settingsStore.get().runs)
    } catch {
      return normalizeRunSettings()
    }
  }

  /** What a failed turn does to its run when it hit a usage limit (`decideUsageLimit`); undefined for any other failure. */
  private usageLimitDecision(error: unknown, runId: string | undefined): UsageLimitDecision | undefined {
    const engine = this.runEngine
    const run = engine && runId ? engine.getRun(runId) : null
    if (!engine || !run) return undefined
    try {
      const settings = this.runSettings()
      return decideUsageLimit({
        error,
        run,
        lookup: (id) => engine.getRun(id),
        cap: settings.usageLimitPauseCap,
        autoResume: settings.resumeAfterUsageLimit,
        nowMs: Date.now()
      })
    } catch (failure) {
      console.warn('the usage limit decision could not be made; the run fails as before', { runId, error: failure instanceof Error ? failure.message : String(failure) })
      return undefined
    }
  }

  /** Pauses the run (and arms its timer when the pause continues by itself). False when the engine refuses: the Stop won the race. */
  private pauseForUsageLimit(runId: string, pause: RunPause): boolean {
    const engine = this.runEngine
    if (!engine || this.staleRuns.has(runId)) return false
    try {
      engine.pauseRun({ runId, pause, ...(pause.autoResume ? { resumeAt: pause.until } : {}) })
      return true
    } catch (error) {
      if (error instanceof RunStoreError && error.code === 'stale_write') this.staleRuns.add(runId)
      console.warn('the run could not be paused', { runId, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /**
   * Promoted queue items whose text the turn never read. One under the queue lock, so no reader sees a half-way
   * state: an item still `steering` on disk is demoted in place (it keeps its place, origin and mode ceiling and
   * is no longer bound to a run); an item that is gone, because an acknowledgement for a drain that was handed back
   * dropped it, is queued again from its entry with the entry's ceiling and origin. An item that already is a
   * pending or claimed message is left alone. Each runs exactly once, as a turn of its own narrowed at admission.
   * Best-effort: settlement must not fail.
   */
  private settleUnreadItems(session: ThreadSession, entries: SteerEntry[], mode: ChatMode): void {
    const threadId = session.threadId
    const apply = (items: QueuedMessage[]): QueuedMessage[] => {
      const byId = new Map(items.map((item) => [item.id, item]))
      const steering = entries.filter((entry) => byId.get(entry.itemId!)?.state === 'steering').map((entry) => entry.itemId!)
      let next = steering.length ? demoteSteerItems(items, steering) : items
      for (const entry of entries) {
        if (byId.has(entry.itemId!)) continue
        next = enqueueMessage(next, {
          threadId,
          content: entry.text,
          // The message as it was: its own chat mode (a plan turn stays one) and its images, not the thread's latest mode.
          mode: entry.mode ?? mode,
          ...(entry.images?.length ? { images: entry.images } : {}),
          source: 'steer-followup',
          ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
          ...(entry.origin ? { origin: entry.origin } : {})
        }).items
      }
      return next
    }
    try {
      if (this.threadStore) session.queue = mutateDurableQueue(this.threadStore, threadId, apply)
      else session.queue = apply(session.queue)
      this.emitQueueUpdated(threadId, session.queue)
    } catch (error) {
      console.warn('unread promoted steers could not be returned to the queue', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The thread's inputs to the hold predicate changed outside the run store: publish the tasks that are no longer held. */
  private reevaluateHold(threadId: string): void {
    try {
      this.runEngine?.store.settleHold(threadId)
    } catch (error) {
      console.warn('held tasks could not be re-evaluated', { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  isActiveTurnRunning(threadId?: string): boolean {
    if (threadId) {
      const session =
        this.boundSession.threadId === threadId
          ? this.boundSession
          : this.sessions.get(threadId)
      return Boolean(session?.isTurnRunning())
    }
    // Any thread has a main turn (used carefully — prefer thread-scoped checks).
    if (this.boundSession.isTurnRunning()) return true
    for (const session of this.sessions.values()) {
      if (session.isTurnRunning()) return true
    }
    return false
  }

  /**
   * Inject mid-turn guidance into the active turn for a thread (bound by default).
   * Accepted steers are not enqueued as later normal turns.
   */
  steerActiveTurn(text: string, threadId?: string): boolean {
    this.assertNotBotThread(threadId ?? this.getBoundThreadId() ?? undefined)
    return this.steerThread(threadId ?? this.getBoundThreadId() ?? undefined, text)
  }

  /**
   * `item`: the queue item this steer is (a promotion), and the run it was checked against. A steer for another
   * run than `item.runId` is refused, so a promotion never reaches a turn it was not checked against.
   */
  steerThread(threadId: string | undefined, text: string, subagentNotice?: SubagentNoticeItem[], carried?: { inboxIds: string[]; effectId: string }, origin?: AgentOrigin, permissionMode?: PermissionMode, item?: { id: string; runId?: string; mode?: ChatMode; images?: ChatImageAttachment[]; byAgent?: boolean }, sentFrom?: { node: string }): boolean {
    const trimmed = text.trim()
    if (!trimmed || !threadId) return false
    // Nothing is steered into a bot's turn: it runs exactly what its dispatch sent.
    if (this.botThreadRefusal(threadId)) return false
    const session =
      this.boundSession.threadId === threadId
        ? this.boundSession
        : this.sessions.get(threadId) ?? null
    if (session?.activeTurn && !session.activeTurn.abort.signal.aborted) {
      if (item?.runId && session.activeTurn.runId !== item.runId) return false
      // An agent's steer is remembered with its sender and the mode it may run in, and a promoted item with its
      // id and what it carried, so a turn that never reads it runs it as a turn of its own with the same limits.
      session.activeTurn.pendingSteer.push({
        text: trimmed,
        ...(item ? { itemId: item.id, ...(item.mode ? { mode: item.mode } : {}), ...(item.images?.length ? { images: item.images } : {}), ...(item.byAgent ? { byAgent: true as const } : {}) } : {}),
        ...(origin ? { origin } : {}),
        ...(origin || permissionMode ? { permissionMode: permissionMode ?? 'ask' } : {}),
        ...(sentFrom ? { sentFrom } : {})
      })
      if (carried) {
        (session.activeTurn.carriedSteers ??= []).push({ ...carried, text: trimmed, subagentNotice })
        // Marked before the turn can end: from here an unread steer is recoverable (`deliveryFailure`).
        this.runEngine?.inbox.markSteerHeld(carried.inboxIds, carried.effectId)
      }
      // Prefer ALS when already inside the turn; otherwise annotate bound if matching.
      const run = (): void => {
        // Mid-turn steers share the turn's mode — preserve tracking so the next
        // real turn does not mistake this UI echo for a legacy agent turn.
        const currentMode = getLastUserChatMode(this.messages)
        this.addMessage('user', trimmed, undefined, undefined, undefined, currentMode, subagentNotice, true, origin)
      }
      if (this.sessionAls.getStore()?.threadId === threadId) {
        run()
      } else if (this.boundSession.threadId === threadId) {
        run()
      } else {
        this.sessionAls.run(session, run)
      }
      this.emit('turn-steered', { threadId, text: trimmed })
      return true
    }
    // Local channel turn for this thread. A steer that carries notices is not given to it: the turn
    // would take the text without the rows' identity, so it is queued as a turn of its own instead. An agent's
    // steer, and a promoted item with a mode ceiling, are not given to it either: the channel turn would run
    // them as a person's text and under its own mode.
    if (!carried && !origin && !permissionMode && this.steerChannelTurn(threadId, trimmed, item)) {
      this.emit('turn-steered', { threadId, text: trimmed })
      return true
    }
    return false
  }

  /**
   * Steer locally when possible; otherwise persist a one-time steer-intent for the
   * external lease owner (cross-process CLI/GUI peers sharing MOUSSE_HOME).
   */
  steerThreadOrEnqueueExternal(
    threadId: string,
    text: string,
    // `permissionMode`: a device's limit. It travels with the text wherever it ends up: a steer the running turn
    // never reads, or one that has to wait, becomes a turn of its own at no more than the limit. A steer the turn
    // does read joins that turn at its mode (the limit cannot narrow a turn that is running).
    opts?: { source?: string; permissionMode?: PermissionMode; sentFrom?: { node: string } }
  ): { steered: boolean; queued: boolean; item?: QueuedMessage } {
    this.assertNotBotThread(threadId)
    if (this.steerThread(threadId, text, undefined, undefined, undefined, opts?.permissionMode, undefined, opts?.sentFrom)) {
      return { steered: true, queued: false }
    }
    if (this.isThreadLeaseHeldExternally(threadId) || this.isChannelTurnActive(threadId)) {
      const item = this.enqueueExternalSteer(threadId, text, opts)
      if (item) return { steered: false, queued: true, item }
    }
    // A paused run has no turn to join. The text is kept as a held message, as a steer that names the paused run is
    // (`executeTurnSteerEffect`): it runs after the continue turn and the pause stays. A person who wants it to run
    // now sends it as a message, which ends the pause.
    const paused = this.runEngine?.store.getPausedRun(threadId)
    if (paused && text.trim()) {
      this.enqueueLateSteer(threadId, text, undefined, undefined, paused.runId, undefined, opts?.permissionMode, opts?.sentFrom)
      return { steered: false, queued: true }
    }
    return { steered: false, queued: false }
  }

  /**
   * Abort an in-flight channel turn for a Mousse thread (Telegram/Discord). The abort is immediate;
   * a channel turn that is an engine run also gets its `stop` recorded against that run.
   */
  abortChannelTurn(threadId: string): boolean {
    const turn = this.channelTurns.get(threadId)
    if (!turn || turn.abort.signal.aborted) return false
    turn.pendingSteer = []
    turn.abort.abort()
    this.recordChannelControl('stop', threadId, turn.runId)
    return true
  }

  /**
   * Steer an in-flight channel turn for a Mousse thread. The text reaches the turn through its own
   * steer queue; an engine-run channel turn also records the `steer` against its run.
   */
  steerChannelTurn(threadId: string, text: string, item?: { id: string; runId?: string }): boolean {
    const trimmed = text.trim()
    const turn = this.channelTurns.get(threadId)
    if (!trimmed || !turn || turn.abort.signal.aborted) return false
    // A promotion checked against a run joins only that run's turn.
    if (item?.runId && turn.runId !== item.runId) return false
    turn.pendingSteer.push({ text: trimmed, ...(item ? { itemId: item.id } : {}) })
    this.recordChannelControl('steer', threadId, turn.runId)
    return true
  }

  /** Records a channel turn's stop or steer as a command on its run (delivery already happened). */
  private recordChannelControl(kind: 'stop' | 'steer', threadId: string, runId: string | undefined): void {
    const engine = this.runEngine
    if (!engine || !runId) return
    void engine.dispatch({ kind, threadId, clientRequestId: `channel-${kind}:${uuidv4()}`, runId }).catch((error: unknown) => {
      console.warn(`channel ${kind} could not be recorded`, { runId, error: error instanceof Error ? error.message : String(error) })
    })
  }

  /**
   * C4: a channel turn is an engine run, created through the same `send` command as any other
   * (`source: 'channel'`), so rule 4 and the rest of the engine see the thread busy. A run that
   * cannot be recorded leaves the turn to run without one, like any other bridge write.
   */
  private async recordChannelRun(threadId: string): Promise<string | undefined> {
    const engine = this.runEngine
    if (!engine) return undefined
    try {
      const result = await engine.dispatch({ kind: 'send', threadId, clientRequestId: `channel:${uuidv4()}`, source: 'channel' })
      return result.status === 'accepted' ? result.runId : undefined
    } catch (error) {
      console.warn('run engine could not record a channel turn', { threadId, error: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }

  isChannelTurnActive(threadId: string): boolean {
    const turn = this.channelTurns.get(threadId)
    return Boolean(turn && !turn.abort.signal.aborted)
  }

  /**
   * Send a message to a thread. Same-thread busy turns enqueue FIFO instead of throwing.
   * Distinct threads may run concurrently without sharing transcript/cwd/active control.
   * Cross-process: if a live peer holds the execution lease, atomically enqueue into the
   * durable MMS queue rather than starting a second turn.
   *
   * A turn blocked on ask_user / plan ask / quick-action approval never strands a
   * fresh message behind the unanswered prompt: the pending question is
   * default-rejected, the blocked turn is stopped, and the new message runs as
   * a fresh turn instead of queueing. The fresh message is always delivered as
   * a visible user prompt (fresh turn or visible queued item) — never steered
   * invisibly into the old turn.
   */
  async send(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    opts?: OrchestratorSendOptions
  ): Promise<OrchestratorResponse> {
    return this.lifecycle.run('send', () => this.sendOwned(input, reuseLastUser, opts))
  }

  private hasPausedRun(threadId: string): boolean {
    try {
      return Boolean(this.runEngine?.store.getPausedRun(threadId))
    } catch {
      return false
    }
  }

  /** How many messages other threads' agents sent that wait in the thread's queue (from disk, so a restart counts them). */
  private queuedAgentMessages(threadId: string): number {
    try {
      const items = this.threadStore ? this.threadStore.loadMessageQueue(threadId) : this.sessions.get(threadId)?.queue ?? []
      return listPendingQueue(items).filter((item) => item.origin?.kind === 'agent').length
    } catch {
      return 0
    }
  }

  /** The model a new turn of the session runs: the given or thread override, else the mode's default. */
  /**
   * The folder a turn that changes files is recorded in when its thread has no worktree of its own (docs/workspace-snapshots.md,
   * "Folders without Git"): the project's folder when the project is not a Git repository (or has no commit yet), and for a
   * thread with no project the private folder its runtime keeps for it. Undefined for a thread with a worktree, a runtime
   * that keeps no such folder, and a project that is a repository Mousse cannot work in (a bare one).
   */
  private snapshotFolderFor(session: ThreadSession, mode: ChatMode, directory: string, projectPath: string | undefined, override?: ModelOverride): SnapshotFolder | undefined {
    if (projectPath) {
      const workspace = session.workspace
      const reason = workspace?.capability.unavailableReason
      if (!workspace || workspace.capability.checkpointable || (reason !== 'not-a-repository' && reason !== 'unborn-head')) return undefined
      const projectId = this.threadStore?.getThread(session.threadId)?.projectId
      return projectId ? { directory, threadId: session.threadId, workTree: session.projectCwd ?? projectPath, projectId } : undefined
    }
    try {
      const selected = this.turnSelection(session, mode, override)
      const resolved = this.harness.resolveStored(selected, { purpose: 'turn', scope: this.threadScope(session.threadId) })
      const workTree = this.harness.standaloneWorkspace?.(resolved.instanceId, session.threadId)
      return workTree ? { directory, threadId: session.threadId, workTree } : undefined
    } catch {
      // The turn reports a model it cannot run when it binds it; here it only means there is no folder to record.
      return undefined
    }
  }

  private turnSelection(session: ThreadSession, mode: ChatMode, override?: ModelOverride): ModelOverride {
    return this.harness.instanceMap.migrate(override ?? session.modelOverride ?? resolveModelForMode(this.settingsStore.get(), mode, [
      ...(this.providerAuth.credentials?.listProviderIds() ?? []),
      ...this.harness.configuredProviderIds()
    ]))
  }

  /**
   * Refuses a new message whose turn could not start because the user hid its model or turned its
   * provider off for the project. Refused before it is a run or a transcript entry, the sender
   * keeps the message and says why, instead of the transcript holding a prompt with no reply.
   * Other resolution failures still fail the turn as before.
   */
  private assertSendableSelection(session: ThreadSession, input: OrchestratorSendInput, override?: ModelOverride, scheduled = false): void {
    const request = normalizeSendRequest(input)
    if (request.workflowInvocationId) return
    try {
      this.harness.resolveStored(this.turnSelection(session, request.mode, override), {
        // A scheduled send is checked as one: a thread's own runtime that approves tools itself cannot
        // run it, and that is found out before the prompt is written into the thread.
        purpose: scheduled ? 'schedule' : 'turn',
        scope: this.threadScope(session.threadId)
      })
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code
      if (code === 'model_hidden' || code === 'instance_disabled' || code === PROVIDER_INSTANCE_ERROR_CODES.disabled) throw error
      if (scheduled && code === 'policy_unenforceable') throw error
    }
  }

  /**
   * Remembers that a person on another of the user's computers sent this: on the thread (the last sender,
   * without moving the thread in the sidebar) and on the run's event log. Best effort: the message is
   * already admitted, and a note that cannot be written is not a reason to refuse it.
   */
  private recordSentFrom(threadId: string, runId: string, node: string): void {
    try {
      this.threadStore?.updateThreadMeta(threadId, { sentFrom: { node } }, { touch: false })
    } catch (error) {
      logDebug('OrchestratorService', 'sender of a message could not be recorded on the thread', error, { threadId })
    }
    this.recordRunSentFrom(threadId, runId, node)
  }

  /** The run's event log says which computer its turn is for, so blocking that computer finds it. */
  private recordRunSentFrom(threadId: string, runId: string, node: string): void {
    try {
      this.runEngine?.store.appendEvent({ threadId, runId, type: 'run.sent_from', payload: { node } })
    } catch (error) {
      logDebug('OrchestratorService', 'sender of a message could not be recorded on the run', error, { threadId, runId })
    }
  }

  private async sendOwned(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    opts?: OrchestratorSendOptions
  ): Promise<OrchestratorResponse> {
    const threadId = opts?.threadId ?? this.getBoundThreadId()
    this.assertNotBotThread(threadId ?? undefined)
    if (!threadId) {
      // Legacy unbound path (tests / early boot): use bound session directly.
      return this.runTurnOnSession(this.boundSession, input, reuseLastUser, opts?.source !== 'wake', { source: opts?.source })
    }

    if (this.threadStore && !this.threadStore.getThread(threadId)) {
      throw new Error(`Thread not found: ${threadId}`)
    }

    const session = this.getOrCreateSession(threadId)
    if (session.deleted) {
      throw new Error(`Thread deleted: ${threadId}`)
    }

    // SPEC §16.2: a send that would queue behind a pending merge-back is refused before it is a run.
    if (opts?.forceQueue || session.isTurnRunning()) this.assertQueueOpen(threadId)
    // Only a new message is checked: a replay of an accepted request returns its run as it was.
    const admit = !reuseLastUser && !opts?.continuationOfRunId && opts?.source !== 'wake'
      ? () => {
          // Inside the engine's admission, before a run exists: a question or approval waiting on the thread
          // refuses a message an agent sent (it never answers one for the user, and never piles up behind it).
          if (opts?.refuseWhileAsking && this.questions.listPendingForThread(threadId).length > 0)
            throw new DomainRpcError('questions_pending', `Thread ${threadId} is waiting for the user to answer a question or approval.`)
          // A thread holds only a few messages from other agents at a time: a fan-out cannot pile up behind it.
          if (opts?.agent && this.queuedAgentMessages(threadId) >= AGENT_QUEUE_MAX_PER_THREAD)
            throw new DomainRpcError('agent_queue_full', `Thread ${threadId} already has ${AGENT_QUEUE_MAX_PER_THREAD} messages from agents waiting; try again later.`)
          this.assertSendableSelection(session, input, opts?.modelOverride, opts?.origin === 'schedule')
        }
      : undefined

    // The sender denies the thread's saved approval requests inside the send's own admission when it
    // may answer them (SPEC §17.3); the message is their reason. A follow-up from a parent
    // (`continue_subagent`) never answers a subagent's question for it, and the continue turn that
    // delivers answered approvals denies nothing.
    // A scheduled run (`preemptQuestions: false`) never answers for the user either: it waits.
    const deniesApprovals = !opts?.forceQueue && !opts?.delegation && !opts?.bindDelivery && opts?.preemptQuestions !== false
    // The run is durable before any queue/run decision or provider I/O (SPEC §2.1).
    let run: { runId: string; sequence: number } | undefined
    if (this.runEngine) {
      const text = normalizeSendRequest(input).content
      const result = await this.runEngine.dispatch({
        kind: 'send',
        threadId,
        clientRequestId: opts?.clientRequestId ?? uuidv4(),
        source: opts?.source ?? 'protocol',
        prompt: text,
        ...(opts?.agent ? { actor: opts.agent } : {}),
        ...(opts?.delegation ? { delegation: opts.delegation } : {}),
        ...(opts?.continuationOfRunId ? { continuationOfRunId: opts.continuationOfRunId, acknowledgeUncertain: opts.acknowledgeUncertain === true } : {}),
        ...(deniesApprovals
          ? { settleApprovals: { ...(opts?.continuationOfRunId || opts?.source === 'wake' || !text.trim() ? {} : { feedback: text }), answeredBy: opts?.actor ?? { kind: 'user' as const } } }
          : {}),
        ...(opts?.bindDelivery ? { bindDelivery: opts.bindDelivery } : {})
      }, { admit })
      if (result.status === 'rejected' && CONTINUATION_REFUSALS.has(result.reason))
        throw new DomainRpcError(result.reason, `Cannot continue run ${opts?.continuationOfRunId}: ${result.reason}.`)
      // Every refusal surfaces with its reason as the error code (S3), e.g. client_request_id_conflict.
      if (result.status !== 'accepted') throw new DomainRpcError(result.reason, `Send refused: ${result.reason}.`)
      if (result.replayed) {
        const replayed = { runId: result.runId, sequence: result.sequence, replayed: true }
        // A replay of a send whose turn is still live waits for the same result (SPEC §12.7).
        const live = this.turnResults.get(result.runId)
        const run = live ? this.runEngine.getRun(result.runId) : null
        if (live && opts?.awaitMode !== 'ack' && run && !TERMINAL_RUN_STATUSES.has(run.status)) {
          return { ...(await live.promise), ...replayed }
        }
        return { message: '', actions: [], ...replayed }
      }
      run = { runId: result.runId, sequence: result.sequence }
      if (opts?.sentFrom) this.recordSentFrom(threadId, run.runId, opts.sentFrom.node)
      // This message ended a usage-limit pause (it is a person's): the continue message that waited for the
      // reset is not wanted any more, and the thread no longer shows as paused.
      if (result.endedPause) {
        if (result.endedPause.resumeItemId) this.removeResumeItem(threadId, result.endedPause.resumeItemId)
        this.pauseEndedWithoutTurn(threadId)
      }
      // The caller records the run before anything is queued or started, so a restart can find it. When it
      // cannot (its claim was lost), the run is cancelled and the send fails: nothing runs unrecorded.
      if (opts?.onAdmitted) {
        try {
          opts.onAdmitted(run.runId)
        } catch (error) {
          logDebug('OrchestratorService', 'admission observer failed', error, { threadId, runId: run.runId })
          this.cancelOrphanedAdmission(run.runId, 'The send was refused: ' + (error instanceof Error ? error.message : String(error)))
          throw error
        }
      }
    } else {
      admit?.()
    }

    // A thread waiting on the user's answer is busy for a send that must not answer it (a scheduled run).
    const waitingOnUser = opts?.preemptQuestions === false && this.questions.listPendingForThread(threadId).length > 0

    if (deniesApprovals) {
      // The saved approvals the send denied inside its admission: their waiting callbacks get the
      // denial now that it is committed. Then the questions that live only in memory.
      // The sender denies the approvals only when it may answer them; otherwise they stay pending
      // and the message queues behind the turn.
      const denied = this.questions.reconcileThread(threadId)
      const preempted = this.questions.autoRejectPendingForThread(threadId, opts?.actor)
      if (denied + preempted.answered + preempted.dismissed > 0 && session.isTurnRunning()) {
        this.abortActiveTurn(threadId)
        await this.waitForTurnToSettle(session)
      }
      // If the blocked turn still has not settled, fall through to the normal
      // queue path below: the message stays a visible queued prompt and drains
      // as a fresh turn. Never steer it invisibly into the dying turn.
    }

    const externalLease =
      !session.isTurnRunning() &&
      !this.isChannelTurnActive(threadId) &&
      (() => {
        // Drop a dead owner's lease first so a restarted daemon does not
        // enqueue behind a ghost instead of running the turn directly.
        this.reclaimStaleThreadLease(threadId)
        return this.isThreadLeaseHeldExternally(threadId, session.executionLease?.owner.token)
      })()

    if (session.isTurnRunning() || opts?.forceQueue || externalLease || waitingOnUser) {
      const item = this.enqueueForThread(threadId, input, {
        source: opts?.source,
        runId: run?.runId,
        permissionMode: opts?.permissionMode,
        origin: opts?.queueOrigin ?? (opts?.agent ? agentOriginOf(opts.agent) : undefined)
      })
      return {
        message: '',
        actions: [],
        queued: true,
        queueItem: item,
        ...run
      }
    }

    if (run && this.effectsEnabled()) {
      // startTurn admits synchronously, right after the busy check, and hands it to the effect.
      const pending = this.startTurn(session, {
        runId: run.runId,
        threadId,
        input,
        reuseLastUser,
        displayUserMessage: opts?.source !== 'wake',
        source: opts?.source,
        ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {}),
        ...(opts?.modelOverride ? { modelOverride: opts.modelOverride } : {}),
        ...(opts?.origin ? { origin: opts.origin } : {}),
        ...(opts?.schedule ? { schedule: opts.schedule } : {}),
        ...(opts?.agent ? { agent: agentOriginOf(opts.agent) } : {})
      })
      if (opts?.awaitMode === 'ack') {
        pending.catch(() => undefined)
        return { message: '', actions: [], ...run, accepted: true }
      }
      return { ...(await pending), ...run }
    }

    const response = await this.runTurnOnSession(session, input, reuseLastUser, opts?.source !== 'wake', {
      source: opts?.source,
      runId: run?.runId,
      modelOverride: opts?.modelOverride,
      origin: opts?.origin,
      schedule: opts?.schedule,
      ...(opts?.agent ? { agent: agentOriginOf(opts.agent) } : {}),
      ...(opts?.permissionMode ? { permissionMode: opts.permissionMode } : {})
    })
    return run ? { ...response, ...run } : response
  }

  /**
   * Wait for an aborted blocked turn to release the session (its tool loop
   * unblocks as soon as the pending question resolves, then exits on the
   * abort flag without further model calls). Bounded so a stuck turn still
   * falls back to the visible queue instead of hanging the send.
   */
  private async waitForTurnToSettle(
    session: ThreadSession,
    timeoutMs = 10_000,
    pollMs = 25
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (session.isTurnRunning() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs))
    }
  }

  /**
   * Record a user's question response (submitted answers or an explicit
   * dismissal) as a visible presentation-only user message, as if they had
   * sent it in chat. The answers already reach the model through the tool
   * result, so this deliberately bypasses native/model context — appending
   * there mid-turn would corrupt the in-flight tool loop. Best-effort:
   * returns null when the thread is gone.
   */
  recordQuestionResponseMessage(threadId: string, content: string): ChatMessage | null {
    const text = content.trim()
    if (!text || threadId === '__unbound__') return null
    if (this.threadStore && !this.threadStore.getThread(threadId)) return null
    const session = this.getOrCreateSession(threadId)
    if (session.deleted) return null
    return this.sessionAls.run(session, () => {
      const msg: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        content: text,
        timestamp: new Date().toISOString(),
        // Presentation-only echo: preserve the tracked mode so the next real
        // turn does not mistake this answer for a legacy agent turn.
        ...((() => {
          const currentMode = getLastUserChatMode(this.messages)
          return currentMode !== undefined ? { mode: currentMode } : {}
        })()),
        ...((() => {
          const currentPermission = getLastUserPermissionMode(this.messages)
          return currentPermission !== undefined ? { permissionMode: currentPermission } : {}
        })())
      }
      this.messages.push(msg)
      this.emitMessageAdded(msg)
      this.persist(true)
      return msg
    })
  }

  private async runTurnOnSession(
    session: ThreadSession,
    input: OrchestratorSendInput,
    reuseLastUser: boolean,
    displayUserMessage = true,
    opts?: {
      source?: string
      queueItemId?: string
      claimOwnerToken?: string
      /** When true, executeTurn must not chain ordinary post-turn queue drains. */
      suppressAutoQueueDrain?: boolean
      externalSignal?: AbortSignal
      /** Steers a channel turn collected: plain text, or entries that keep the queue items they came from. */
      externalDrainSteer?: () => string | SteerEntry[] | undefined
      modelOverride?: ModelOverride
      /** Who the turn runs for, when it is not the thread's own (a scheduled job). */
      origin?: TurnOrigin
      /** The scheduled occurrence this turn is; the scheduler hears when its run ends. */
      schedule?: ScheduledTurnRef
      /** The agent that sent this turn's message (`thread_send`): the stored message says so. */
      agent?: AgentOrigin
      onTurnSettled?: (aborted: boolean) => void
      onUserInputAccepted?: () => void
      /** The caller already admitted this session (see ThreadSession.turnAdmitted) and hands ownership to this turn. */
      admissionHeld?: boolean
      /** Run Engine run this turn executes; also used as the turn id. */
      runId?: string
      /** The subagent results this turn's message delivers (a wake, a queued steer). */
      subagentNotice?: SubagentNoticeItem[]
      /** The turn the provider started that this run is for (`provider-continuation`). */
      continuationId?: string
      /** A mode this turn must not exceed (`OrchestratorSendOptions.permissionMode`). */
      permissionMode?: PermissionMode
      /** A bot dispatch (PR 6 §4): its policy, authority and scratch folder. */
      bot?: PreparedBotTurn
      /** How the turn's binding answers tool approvals; `never` for channel turns (`CHANNEL_POLICY`). */
      approvals?: RunPolicy['approvals']
    }
  ): Promise<OrchestratorResponse> {
    // One guard where every turn starts: a bot's thread runs only its bot dispatches.
    const botRefusal = opts?.bot ? undefined : this.botThreadRefusal(session.threadId)
    if (botRefusal) {
      if (opts?.runId) this.refuseOnBotThread(opts.runId, session.threadId)
      // Nothing of the refused turn is left holding the thread: its claim and the admission it was handed.
      if (opts?.queueItemId) this.releaseSessionClaim(session, opts.queueItemId, opts.claimOwnerToken)
      if (opts?.admissionHeld) {
        session.turnAdmitted = false
        session.admissionRunId = undefined
        session.abortRequested = false
        this.effectWorker?.notify()
      }
      throw botRefusal
    }
    // Admission is synchronous, before any await, so a concurrent send always observes it.
    if (!opts?.admissionHeld) {
      if (session.turnAdmitted) {
        if (opts?.queueItemId) this.releaseSessionClaim(session, opts.queueItemId, opts.claimOwnerToken)
        const error = new Error('An orchestrator turn is already running. Use /stop or the stop button first.')
        // A released claim keeps its runId on the queue item; a direct send's run ends here.
        if (!opts?.queueItemId) this.settleRunAfterTurn(opts?.runId, false, error)
        throw error
      }
      session.turnAdmitted = true
    }
    let turnResponse: OrchestratorResponse | undefined
    let turnFailure: unknown
    try {
      // A bot's turn is named by its thread, so a trash of that thread can tell it from other work.
      turnResponse = await this.lifecycle.run(opts?.bot ? `bot-turn:${session.threadId}` : 'turn', () => this.sessionAls
        .run(session, () =>
          this.executeTurn(input, reuseLastUser, displayUserMessage, { ...opts, externalSignal: opts?.externalSignal ? AbortSignal.any([opts.externalSignal, this.lifecycle.signal]) : this.lifecycle.signal })
        ))
      return turnResponse
    } catch (error) {
      turnFailure = error ?? new Error('Turn failed')
      throw error
    } finally {
      // A queue item that was never accepted stays on the queue and keeps its run queued.
      const requeued = turnResponse?.queued === true ||
        (opts?.queueItemId !== undefined && session.queue.some((item) => item.id === opts.queueItemId))
      this.settleRunAfterTurn(opts?.runId, requeued, turnFailure)
      if (opts?.schedule && opts.runId && !requeued) this.reportScheduledOccurrence(session, opts.schedule, opts.runId, turnResponse)
      this.releaseSessionExecutionLease(session)
      session.turnAdmitted = false
      session.admissionRunId = undefined
      session.abortRequested = false
      this.effectWorker?.notify()
      // Post-turn drains are deferred to here: while admission is held the drain would see a
      // running turn and skip, stranding queued messages.
      if (session.drainAfterSettle) {
        session.drainAfterSettle = false
        try {
          this.scheduleQueueDrain(session)
        } catch (error) {
          logDebug('OrchestratorService', 'post-turn queue drain failed to schedule', error, { threadId: session.threadId })
        }
      }
    }
  }

  /**
   * A scheduled turn's run ended: the scheduler hears the outcome, whichever process drained the turn
   * (every daemon over the profile home runs this hook, and completing an occurrence is idempotent). Only a
   * terminal run reports: a run still `queued` (a peer holds the thread lease, or the item survived a
   * pre-accept failure) keeps its reservation until the execution that does end it. Status and error
   * come from the Run Engine run, the reply text from the turn (or the thread's last reply when the
   * wrapper returned none).
   */
  private reportScheduledOccurrence(
    session: ThreadSession,
    schedule: ScheduledTurnRef,
    runId: string,
    response: OrchestratorResponse | undefined
  ): void {
    const hooks = this.scheduledHooks
    const run = this.runEngine?.getRun(runId)
    if (!hooks || !run || !TERMINAL_RUN_STATUSES.has(run.status)) return
    const result = occurrenceResultOfRun({ status: run.status, error: run.outcome?.error, usageLimitUntil: run.outcome?.usageLimitUntil })
    let text: string | undefined
    if (result.status === 'ok') {
      text = response?.message?.trim()
      if (!text) text = [...session.messages].reverse().find((message) => message.role === 'assistant' && !message.hidden && !message.kind && message.content.trim())?.content.trim()
      text = text || 'Done.'
    }
    let selection: ModelOverride | undefined
    let permissionMode: PermissionMode | undefined
    try {
      const bound = this.runEngine?.bindingForRun(runId)
      if (bound) {
        selection = { ...this.harness.selectionOf(bound) }
        permissionMode = bound.policy.permissionMode
      }
    } catch {
      // A binding that cannot be read leaves the record without a model; the outcome still reports.
    }
    try {
      hooks.onOccurrenceSettled({
        jobId: schedule.jobId,
        occurrenceKey: schedule.occurrenceKey,
        runId,
        status: result.status,
        ...(result.retryAt ? { retryAt: result.retryAt } : {}),
        ...(text !== undefined ? { text } : {}),
        ...(result.error ? { error: result.error } : {}),
        ...(selection ? { selection } : {}),
        ...(permissionMode ? { permissionMode } : {})
      })
    } catch (error) {
      logDebug('OrchestratorService', 'scheduled occurrence observer failed', error, { runId })
    }
  }

  /** Tells an observer the user's input is stored; a throwing observer is logged and never aborts the accepted turn. */
  private notifyUserInputAccepted(threadId: string, observer: (() => void) | undefined): void {
    if (!observer) return
    try {
      observer()
    } catch (error) {
      logDebug('OrchestratorService', 'user input accepted observer failed', error, { threadId })
    }
  }

  /** Honor a stop that arrived while the turn was admitted but not yet running. */
  private applyRequestedAbort(session: ThreadSession, turn: { abort: AbortController }): void {
    if (!session.abortRequested) return
    session.abortRequested = false
    turn.abort.abort()
  }

  private releaseSessionExecutionLease(session: ThreadSession): void {
    if (!session.executionLease) return
    releaseExecutionLeaseHandle(session.executionLease)
    session.executionLease = null
  }

  private async executeWorkflowChatTurn(
    session: ThreadSession,
    request: NormalizedOrchestratorSendRequest,
    opts?: { queueItemId?: string; claimOwnerToken?: string; suppressAutoQueueDrain?: boolean; externalSignal?: AbortSignal; onTurnSettled?: (aborted: boolean) => void; onUserInputAccepted?: () => void }
  ): Promise<OrchestratorResponse> {
    if (!this.workflowChat) throw new Error('Workflow command execution is unavailable')
    const turn = { abort: new AbortController(), pendingSteer: [] as SteerEntry[] }
    const abort = () => turn.abort.abort()
    if (opts?.externalSignal?.aborted) abort()
    else opts?.externalSignal?.addEventListener('abort', abort, { once: true })
    this.activeTurn = turn
    this.applyRequestedAbort(session, turn)
    this.setTurnPhase(session.threadId, 'queued', { turnId: uuidv4() })
    let accepted = false
    let outcome: 'completed' | 'stopped' | 'failed' = 'failed'
    try {
      // Admit durably before transcript provenance completes a queue claim.
      // Replaying after a crash returns the same engine run, never a new dispatch.
      const run = await this.workflowChat.execute(request.workflowInvocationId!, session.threadId, request.content, turn.abort.signal)
      if (!session.messages.some((message) => message.role === 'user' && message.workflowInvocationId === run.invocationId)) {
        this.touchUserActivityAndNotify(session.threadId)
        this.acceptTurnUserInput(session, request.content, undefined, true, opts?.queueItemId, request.mode, run)
      }
      this.notifyUserInputAccepted(session.threadId, opts?.onUserInputAccepted)
      if (!session.messages.some((message) => message.workflowRun?.runId === run.runId)) {
        const content = `Workflow: ${run.title}\nRun: ${run.runId}\nRevision: ${run.revisionId}\nState at admission: ${run.state}`
        const message: ChatMessage = { id: uuidv4(), role: 'assistant', content, workflowRun: run, timestamp: new Date().toISOString() }
        this.messages.push(message)
        this.nativeContext = appendNativeMessage(
          this.nativeContext,
          userMessage('[Mousse workflow admission]\n' + content)
        )
        this.persist(true)
        this.emitMessageAdded(message)
      }
      if (opts?.queueItemId) this.completeSessionClaim(session, opts.queueItemId, opts.claimOwnerToken)
      accepted = true
      const response: OrchestratorResponse = { message: `Workflow ${run.title} admitted as ${run.runId}.`, actions: [], workflowRun: run }
      this.setTurnPhase(session.threadId, turn.abort.signal.aborted ? 'stopped' : 'completed')
      outcome = turn.abort.signal.aborted ? 'stopped' : 'completed'
      this.emit('response', response)
      return response
    } catch (error) {
      this.setTurnPhase(session.threadId, 'failed', { error: error instanceof Error ? error.message : 'Workflow command failed' })
      throw error
    } finally {
      opts?.externalSignal?.removeEventListener('abort', abort)
      this.activeTurn = null
      opts?.onTurnSettled?.(outcome === 'stopped')
      this.emit(
        outcome === 'stopped' ? 'turn-interrupted' : outcome === 'completed' ? 'turn-completed' : 'turn-failed',
        { threadId: session.threadId }
      )
      this.releaseSessionExecutionLease(session)
      if (accepted && !opts?.suppressAutoQueueDrain) session.drainAfterSettle = true
    }
  }

  /** One turn; whatever way it ends, nothing of its app-tool context stays registered. */
  private async executeTurn(...args: Parameters<OrchestratorService['executeTurnBody']>): Promise<OrchestratorResponse> {
    const runId = args[3]?.runId
    try {
      return await this.executeTurnBody(...args)
    } finally {
      if (runId) this.appToolTurns.dropRun(runId)
    }
  }

  private async executeTurnBody(
    input: OrchestratorSendInput,
    reuseLastUser = false,
    displayUserMessage = true,
    opts?: {
      source?: string
      queueItemId?: string
      claimOwnerToken?: string
      suppressAutoQueueDrain?: boolean
      externalSignal?: AbortSignal
      externalDrainSteer?: () => string | SteerEntry[] | undefined
      modelOverride?: ModelOverride
      origin?: TurnOrigin
      schedule?: ScheduledTurnRef
      agent?: AgentOrigin
      onTurnSettled?: (aborted: boolean) => void
      onUserInputAccepted?: () => void
      runId?: string
      subagentNotice?: SubagentNoticeItem[]
      continuationId?: string
      permissionMode?: PermissionMode
      bot?: PreparedBotTurn
      approvals?: RunPolicy['approvals']
    }
  ): Promise<OrchestratorResponse> {
    const session = this.session
    const queueItemId = opts?.queueItemId
    const claimOwnerToken = opts?.claimOwnerToken
    const suppressAutoQueueDrain = opts?.suppressAutoQueueDrain === true
    let claimAccepted = false
    if (session.deleted) {
      throw new Error(`Thread deleted: ${session.threadId}`)
    }
    if (this.activeTurn) {
      // Same-session re-entry should not happen; callers queue first.
      if (queueItemId) {
        this.releaseSessionClaim(session, queueItemId, claimOwnerToken)
      }
      throw new Error('An orchestrator turn is already running. Use /stop or the stop button first.')
    }

    // Load recovery identity before acquiring the writer. Reconcile interrupted
    // operations below under that lease, before workspace verification/dispatch.
    const recoveryDirectory = session.threadId !== '__unbound__' ? this.resolveThreadDir(session.threadId) : undefined
    const recoveryManager = recoveryDirectory ? new ThreadWorkspaceManager(recoveryDirectory) : undefined
    const recoveryWorkspace = recoveryManager?.loadOrSnapshot()
    // Acquire cross-process execution lease before mutating thread state.
    let lease: ThreadLeaseHandle | null = session.executionLease
    if (session.threadId !== '__unbound__') {
      const threadDir = this.resolveThreadDir(session.threadId)
      if (threadDir && !lease) {
        lease = tryAcquireExecutionLease(threadDir, {
          source: 'orchestrator',
          token: claimOwnerToken
        })
        if (!lease) {
          // Peer won the race. For an existing claim, release at original order —
          // never enqueue a replacement UUID at the tail.
          if (queueItemId) {
            const released = this.releaseSessionClaim(session, queueItemId, claimOwnerToken)
            return {
              message: '',
              actions: [],
              queued: true,
              queueItem: released ?? undefined
            }
          }
          // A scheduled turn keeps its model and origin on the item, so the drain that runs it later binds them;
          // an agent's message keeps who sent it.
          const origin = opts?.schedule
            ? { kind: 'schedule' as const, ...opts.schedule, ...(opts.modelOverride ? { selection: opts.modelOverride } : {}) }
            : opts?.agent
              ? agentOriginOf(opts.agent)
              : undefined
          const item = this.enqueueForThread(session.threadId, input, { source: opts?.schedule ? 'schedule' : 'lease-race', runId: opts?.runId, permissionMode: opts?.permissionMode, origin })
          return {
            message: '',
            actions: [],
            queued: true,
            queueItem: item
          }
        }
        session.executionLease = lease
      }
    }

    if (recoveryDirectory && session.executionLease) {
      new ConversationActionService(recoveryDirectory).recover(session.executionLease, (action, kind) => {
        this.validateConversationActionRestore(session.threadId, action, kind)
        if (kind === 'redo') this.restoreConversationActionEnd(session.threadId, action.presentationMessageStart, action.presentationMessageEnd, action.nativeContextBoundary)
        else this.restoreConversationBoundary(session.threadId, action.presentationMessageStart, action.nativeContextStartBoundary!)
      })
    }

    if (recoveryDirectory && recoveryWorkspace && session.executionLease) {
      const heldLease = session.executionLease
      await new ChildAgentIntegrationService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, heldLease)
      const primary = this.projectManager && this.threadStore
        ? resolveThreadProjectPath(this.projectManager, this.threadStore, session.threadId) : undefined
      if (primary) await new PublishService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, primary, heldLease)
      await new ThreadActionService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, heldLease)
      await new CodeRevertService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, heldLease)
      await new UndoService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, (action, kind) => {
        if (!action.nativeContextStartBoundary) return
        if (kind === 'redo') this.restoreConversationActionEnd(session.threadId, action.presentationMessageStart, action.presentationMessageEnd, action.nativeContextBoundary)
        else this.restoreConversationBoundary(session.threadId, action.presentationMessageStart, action.nativeContextStartBoundary)
      }, heldLease)
      await new ConversationBranchService(recoveryDirectory).recoverPending(recoveryWorkspace.worktreePath, (branch) => {
        const path = join(recoveryDirectory, 'conversation-contexts', `${encodeURIComponent(branch.id)}.json`)
        const saved = JSON.parse(readFileSync(path, 'utf8')) as { schemaVersion: number; messages: ChatMessage[]; nativeContext: NativeLlmContext }
        if (saved.schemaVersion !== 1 || !Array.isArray(saved.messages) || !saved.nativeContext) throw new Error('Conversation recovery snapshot is invalid')
        this.replaceConversationState(session.threadId, saved.messages, saved.nativeContext)
      }, heldLease)
    }
    const request = normalizeSendRequest(input)
    // The folder a turn is recorded in when it has no worktree: a project without Git, or a thread with no project.
    let snapshotFolder: SnapshotFolder | undefined
    // Resolve the task binding before dispatch. Provisioning failures must not
    // turn an isolated code request into a write to the registered checkout.
    if (session.sharedWorkspace) {
      // A read-only delegated child observes its parent's workspace (SPEC §14.2 `shared`).
      session.workspace = null
      session.projectCwd = session.sharedWorkspace.path
    } else if (session.primaryCheckout) {
      // A scheduled run on the project's own checkout: never a provisioned worktree, and never `null`,
      // so a tool that needs an owned workspace refuses instead of provisioning one.
      let gitBacked = false
      try {
        const threadDir = this.resolveThreadDir(session.threadId)
        gitBacked = Boolean(threadDir && new ThreadWorkspaceManager(threadDir).resolveRepository(session.primaryCheckout.path).capability.gitBacked)
      } catch {
        // Not a repository the checkout code understands: the context says so.
      }
      session.workspace = unprovisionedContext(session.threadId, session.primaryCheckout.path, gitBacked, 'Scheduled run on the primary checkout')
      session.projectCwd = resolveProjectWorkingDirectory(session.primaryCheckout.path)
    } else if (session.threadId !== '__unbound__' && this.projectManager && this.threadStore) {
        const projectPath = resolveThreadProjectPath(
          this.projectManager,
          this.threadStore,
          session.threadId
        )
        const threadDir = this.resolveThreadDir(session.threadId)
        if (projectPath && threadDir) {
          await this.seedForkWorkspace(session.threadId, projectPath, threadDir, opts?.externalSignal, session.executionLease)
          session.workspace = await new WorkspaceResolver(threadDir, session.threadId, projectPath)
            .resolve(request.mode, 'main', opts?.externalSignal, session.executionLease ?? undefined)
          session.projectCwd = session.workspace.projectPath
        } else {
          session.workspace = null
          session.projectCwd = projectPath ? resolveProjectWorkingDirectory(projectPath) : null
        }
        if (threadDir && !opts?.bot && modeMutatesFiles(request.mode)) snapshotFolder = this.snapshotFolderFor(session, request.mode, threadDir, projectPath, opts?.modelOverride)
        // Only move worktree root when this is the bound session and no concurrent turn
        // is relying on ALS projectCwd alone (GUI tools that still read WorktreeManager).
        if (session.projectCwd && this.boundSession.threadId === session.threadId) {
          this.worktrees.setRepoRoot(session.projectCwd)
        }
    }

    // Pull any messages peers enqueued before we started.
    this.refreshSessionQueueFromDisk(session)
    session.drainedExternalSteerIds.clear()

    const userContent = request.content
    const mode = request.mode
    const images = request.images

    if (request.workflowInvocationId) {
      return await this.executeWorkflowChatTurn(session, request, opts)
    }

    let checkpointEnabled = Boolean(session.workspace?.capability.checkpointable) || snapshotFolder !== undefined
    // The folder the turn's snapshots are taken in: the worktree, or the folder that has none.
    let checkpointCwd: string | null = snapshotFolder?.workTree ?? session.projectCwd
    /** Why this turn's files are not recorded, for Undo to say. */
    let snapshotsOff: string | undefined
    const conversationBranchId = recoveryManager?.load()?.conversationBranchId ?? 'main'
    const externalEffects = mode === 'agent' || mode === 'build' || typeof mode === 'object'
      ? [{ kind: 'unknown' as const, description: 'Agent tools may affect processes, ignored files, or external services; code undo only restores tracked workspace changes.', reversible: false as const }]
      : []
    const previousModel = previousTurnModel(session.messages, this.nativeContext)
    const turnPresentationStart = session.messages.length
    const turnNativeStartBoundary = {
      messageIndex: this.nativeContext.messages.length,
      activeStartIndex: this.nativeContext.activeStartIndex,
      compactionGeneration: this.nativeContext.compaction?.generation ?? 0,
      compaction: this.nativeContext.compaction ? structuredClone(this.nativeContext.compaction) : undefined,
      acceptedQueueItemIds: structuredClone(this.nativeContext.acceptedQueueItemIds ?? []),
      acceptedSteerItemIds: structuredClone(this.nativeContext.acceptedSteerItemIds ?? []),
      fidelity: this.nativeContext.fidelity === 'legacy-estimated'
        ? 'legacy' as const
        : this.nativeContext.compaction ? 'compacted' as const : 'exact' as const,
      safeBoundaryProof: 'captured before admitting the turn user message'
    }
    let turnStartSha: string | undefined
    if (checkpointEnabled && checkpointCwd) {
      // Edits made outside Mousse since the last action become an action of their own, so Undo of this turn leaves them.
      const directory = session.threadId !== '__unbound__' ? this.resolveThreadDir(session.threadId) : undefined
      if (snapshotFolder) {
        // A folder with no worktree: a folder Mousse cannot snapshot (too large, a home folder) never fails the turn;
        // it runs with its conversation recorded alone, and Undo says why the files are not.
        try {
          const prepared = ensureSnapshotWorkspace({ threadDirectory: snapshotFolder.directory, threadId: snapshotFolder.threadId, workTree: snapshotFolder.workTree, projectId: snapshotFolder.projectId })
          checkpointCwd = prepared.record.workTree
          turnStartSha = (await new ThreadActionService(snapshotFolder.directory).recordOutsideChanges({
            threadId: session.threadId, conversationBranchId, workspacePath: checkpointCwd,
            heldThreadLease: session.executionLease ?? undefined,
            presentationMessageStart: turnPresentationStart, nativeContextBoundary: turnNativeStartBoundary
          })).startSha
          setSnapshotsOff(snapshotFolder.directory, undefined)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          snapshotsOff = error instanceof SnapshotRefusedError ? message : `Undo is off for this folder: ${message}`
          try { setSnapshotsOff(snapshotFolder.directory, snapshotsOff, snapshotFolder) } catch { /* The reason still reaches this turn's conversation record. */ }
          checkpointEnabled = false
          snapshotFolder = undefined
        }
      } else if (directory) {
        turnStartSha = (await new ThreadActionService(directory).recordOutsideChanges({
          threadId: session.threadId, conversationBranchId, workspacePath: checkpointCwd,
          heldThreadLease: session.executionLease ?? undefined,
          presentationMessageStart: turnPresentationStart, nativeContextBoundary: turnNativeStartBoundary
        })).startSha
      } else {
        requireCleanWorkspace(checkpointCwd, 'Thread workspace')
        turnStartSha = actionGit(checkpointCwd, ['rev-parse', 'HEAD'])
      }
    }
    // Keep user commits visible in the sidebar. Internal orchestration wakes stay hidden.
    if (!reuseLastUser && displayUserMessage) {
      this.touchUserActivityAndNotify(session.threadId)
    }

    if (!reuseLastUser && displayUserMessage) {
      void this.generateInitialThreadTitle(session, userContent).catch(() => {})
    }

    // The mode the turn runs in is known before its message is admitted, so a change reaches the
    // agent with that message and the message records the mode.
    const turnPermission = !reuseLastUser && displayUserMessage ? this.previewTurnPermission(session, mode, opts) : undefined
    // The approvals this run was started to deliver (a continue turn, or a message that denied them).
    const approvalNote = !reuseLastUser ? this.approvalDecisionNote(opts?.runId) : undefined
    try {
      if (!reuseLastUser) {
        // Automatic orchestration wakes belong in model context, not the user-facing timeline.
        // Queued and direct acceptance both mutate messages + native context then persist once.
        try {
          this.acceptTurnUserInput(
            session,
            userContent,
            images,
            displayUserMessage,
            queueItemId,
            mode,
            undefined,
            opts?.subagentNotice,
            turnPermission,
            opts?.schedule,
            approvalNote,
            opts?.agent
          )
          claimAccepted = true
          this.notifyUserInputAccepted(session.threadId, opts?.onUserInputAccepted)
        } catch (err) {
          if (queueItemId) {
            const status = this.inspectDurableQueueProvenance(
              session.threadId,
              queueItemId
            )
            if (status === 'accepted') {
              // Partial write left durable provenance — never release/reappend.
              claimAccepted = true
              this.completeSessionClaim(session, queueItemId, claimOwnerToken)
            }
            // unavailable / not_accepted: outer catch settles claim fail-closed
          }
          throw err
        }
        // Complete the claim so restart will not re-append or re-execute it.
        if (queueItemId) {
          this.completeSessionClaim(session, queueItemId, claimOwnerToken)
        }
      }
    } catch (err) {
      if (queueItemId && !claimAccepted) {
        // Only definite not_accepted may release; accepted completes; unavailable leaves claim.
        this.settleClaimAfterFailure(
          session,
          queueItemId,
          claimOwnerToken,
          'pre-accept failure'
        )
      }
      throw err
    }
    this.transcript.reset()

    const turnId = opts?.runId ?? uuidv4()
    // Run Engine bridge (SPEC §5): the run id is the turn id; each mark is one CAS write.
    const engineRunId = this.runEngine ? opts?.runId : undefined
    let runTerminalMarked = false
    // `resultText` is the turn's final reply; a delegated child run publishes it (SPEC §14.1).
    const markRunTerminal = (status: 'completed' | 'interrupted' | 'failed', outcome?: { error?: string; interruptedBy?: 'user' | 'daemon_restart' | 'bot_wall'; usageLimitUntil?: string }, resultText?: string): void => {
      if (runTerminalMarked) return
      runTerminalMarked = true
      this.markRun(engineRunId, (engine, id) => engine.markTerminal(id, status, outcome, { resultText }))
      // The run's count record goes with it: no later attempt starts from fresh counts.
      this.harness.runSettled?.(engineRunId ?? turnId)
    }
    // C2: a run that cannot be marked starting (cancelled meanwhile, or held by another turn) is
    // not this turn's to run; it ends here, before any provider I/O.
    this.markRunStarting(engineRunId)
    this.deliverRestartNote(session.threadId, engineRunId)
    this.deliverContinuationNote(engineRunId)
    let conversationToolsUsed = false
    let providerProgress = false
    const conversationDirectory = !checkpointEnabled && !reuseLastUser && displayUserMessage && session.threadId !== '__unbound__' ? this.resolveThreadDir(session.threadId) : undefined
    if (conversationDirectory && session.executionLease) {
      new ConversationActionService(conversationDirectory).begin(turnId, conversationBranchId, turnPresentationStart, turnNativeStartBoundary, session.executionLease)
    }
    if (checkpointEnabled && turnStartSha && checkpointCwd) {
      const directory = this.resolveThreadDir(session.threadId)!
      new ThreadActionService(directory).beginTurn({
        threadId: session.threadId, turnId, conversationBranchId,
        workspacePath: checkpointCwd, heldThreadLease: session.executionLease ?? undefined, externalEffects,
        presentationMessageStart: turnPresentationStart, presentationMessageEnd: session.messages.length,
        nativeContextStartBoundary: turnNativeStartBoundary, nativeContextBoundary: turnNativeStartBoundary
      }, turnStartSha)
    }
    const turn: ActiveTurnControl = {
      abort: new AbortController(),
      pendingSteer: [] as SteerEntry[],
      ...(engineRunId ? { runId: engineRunId } : {})
    }
    const turnAuthority = session.executionLease ? new TaskWriterAuthority(session.executionLease) : undefined
    const turnWriter = turnAuthority?.issue(turnId, { version: 1, workspace: 'shared', access: 'write' })
    // The external signal's reason (a profile shutdown) travels with the abort.
    const mirrorExternalAbort = (): void => turn.abort.abort(opts?.externalSignal?.reason)
    if (opts?.externalSignal?.aborted) {
      mirrorExternalAbort()
    } else {
      opts?.externalSignal?.addEventListener('abort', mirrorExternalAbort, { once: true })
    }
    this.setTurnPhase(session.threadId, 'queued', { turnId })
    this.setTurnPhase(session.threadId, 'thinking', { turnId })
    // The turn's app-tool context (PR 2 §2), registered before the run is active so a call a runtime made
    // while the run was started finds it; the executor completes it before the gateway starts the turn.
    const appTurn = engineRunId ? this.registerAppTurn(session, engineRunId, mode, opts?.source === 'provider-continuation', opts?.bot) : undefined
    this.markRun(engineRunId, (engine, id) => engine.markRunning(id))
    // The run is active: Mousse tool calls Claude made while it was being started act as it.
    if (opts?.continuationId) this.endContinuationHold(opts.continuationId, false, engineRunId ?? null)
    const checkpointTurn = async (state: 'completed' | 'stopped' | 'failed'): Promise<void> => {
      if ((!checkpointEnabled || !turnStartSha || !checkpointCwd) && !conversationDirectory || session.threadId === '__unbound__') return
      const threadDir = this.resolveThreadDir(session.threadId)
      if (!threadDir) return
      const checkpointOptions = {
        threadId: session.threadId,
        turnId,
        heldThreadLease: session.executionLease ?? undefined,
        externalEffects,
        conversationBranchId,
        workspacePath: checkpointCwd!,
        presentationMessageStart: turnPresentationStart,
        presentationMessageEnd: session.messages.length,
        nativeContextStartBoundary: turnNativeStartBoundary,
        nativeContextBoundary: {
          messageIndex: this.nativeContext.messages.length,
          activeStartIndex: this.nativeContext.activeStartIndex,
          compactionGeneration: this.nativeContext.compaction?.generation ?? 0,
          compaction: this.nativeContext.compaction ? structuredClone(this.nativeContext.compaction) : undefined,
          acceptedQueueItemIds: structuredClone(this.nativeContext.acceptedQueueItemIds ?? []),
          acceptedSteerItemIds: structuredClone(this.nativeContext.acceptedSteerItemIds ?? []),
          fidelity: this.nativeContext.fidelity === 'legacy-estimated'
            ? 'legacy' as const
            : this.nativeContext.compaction ? 'compacted' as const : 'exact' as const,
          safeBoundaryProof: state === 'completed'
            ? 'turn completed outside a partial tool call/result boundary'
            : undefined
        }
      }
      const action = conversationDirectory
        ? new ConversationActionService(conversationDirectory).settle(turnId, session.messages.length, checkpointOptions.nativeContextBoundary, state, conversationToolsUsed, session.executionLease!, snapshotsOff)
        : await new ThreadActionService(threadDir).checkpointExistingTurn(checkpointOptions, turnStartSha!, state)
      for (let index = turnPresentationStart; index < session.messages.length; index += 1) {
        session.messages[index] = {
          ...session.messages[index],
          turnId,
          actionId: action.id,
          conversationBranchId
        }
      }
    }
    this.activeTurn = turn
    this.applyRequestedAbort(session, turn)
    // Authoritative turn lifecycle boundary (includes queue/background turns).
    this.emit('turn-started', { threadId: session.threadId })

    const stagedApplets: AppletSubmission[] = []
    let assistantText: string
    let aborted = false
    let responseMetadata: ChatMessage['responseMetadata'] | undefined
    let connectionFailed = false
    let executionFailed = false
    let providerError: AppErrorShape | undefined
    /** Set when the turn failed on a usage limit that pauses the run instead of failing it. */
    let usagePause: RunPause | undefined
    /** A scheduled turn that failed on a usage limit: when it resets (see the catch below). */
    let scheduledLimitUntil: string | undefined
    let failureDiagnostic: Record<string, unknown> | undefined
    let compactionNote: ChatMessage | undefined
    let switchMarker: ChatMessage | undefined
    // A retry or recovery of a run executes the binding its run recorded, never the current
    // selection. Otherwise migrated to the instance shape (SPEC §13.8): `llmProvider` is
    // re-derived from a known instance.
    // A binding made on the retired bare pi route is not kept: the turn resolves the default again.
    const recordedBinding = engineRunId ? this.runEngine?.bindingForRun(engineRunId) : undefined
    const runBinding = recordedBinding && !onRetiredBareRoute(recordedBinding.instanceId) ? recordedBinding : undefined
    const selectedModel = runBinding ? this.harness.selectionOf(runBinding) : this.turnSelection(session, mode, opts?.modelOverride)
    if (displayUserMessage && !reuseLastUser) {
      const selection = { provider: selectedModel.llmProvider, model: selectedModel.model }
      const admittedUser = session.messages.slice(turnPresentationStart).find(message => message.role === 'user' && !message.hidden)
      if (admittedUser) {
        admittedUser.modelSelection = selection
        // The run this message opened; handoff transcripts group messages by run (SPEC §16.1).
        if (engineRunId) admittedUser.turnId = turnId
        this.emitMessageUpdated(admittedUser)
        const handoff = contextHandoff(previousModel, selection)
        if (handoff) {
          const marker: ChatMessage = { id: uuidv4(), role: 'assistant', kind: 'context_handoff',
            content: `${handoff.from.model} → ${handoff.to.model}`, contextHandoff: handoff,
            timestamp: new Date().toISOString(), turnId }
          session.messages.push(marker)
          this.emitMessageAdded(marker)
          switchMarker = marker
        }
        this.persist(true)
      }
    }
    // SPEC §16.1-§16.2: context handed over this turn (provider switch, fork, merge-back).
    let handoffs: TurnHandoffs | null = null
    const onCompaction = (phase: 'start' | 'complete' | 'unchanged'): void => {
      if (phase === 'start') {
        compactionNote = { id: uuidv4(), role: 'assistant', kind: 'context_compaction',
          content: 'Compacting context…', streaming: true, timestamp: new Date().toISOString() }
        session.messages.push(compactionNote)
        this.emitMessageAdded(compactionNote)
      } else if (compactionNote) {
        compactionNote.content = phase === 'complete' ? 'Context compacted' : 'Context checked — no older messages to compact'
        compactionNote.streaming = false
        this.emitMessageUpdated(compactionNote)
        compactionNote = undefined
      }
      this.persist(true)
    }
    /** Finishes a compaction opened with `onCompaction('start')`; true when the transcript changed. */
    const compactTranscript = (): boolean => {
      const compacted = compactNativeContext(this.nativeContext)
      if (compacted === this.nativeContext) {
        onCompaction('unchanged')
        return false
      }
      this.nativeContext = compacted
      this.clearLastTurnUsage()
      this.persist(true)
      onCompaction('complete')
      return true
    }
    const compactedContext = (): RecoveredContext => ({
      messages: getActiveMessages(this.nativeContext),
      contextSummary: getCompactionSummary(this.nativeContext),
      nativeHistory: nativeAgentHistory(this.nativeContext, turnNativeStartBoundary.messageIndex)
    })
    // Prompt-injected runtimes keep their own transcript; their reply and reported metrics reach
    // the canonical transcript once, through `commitPromptTurn`.
    let promptMetrics: ProviderMetrics | undefined
    let promptTurnCommitted = false
    const promptContextKey = `${selectedModel.llmProvider}:${selectedModel.model}`
    const commitPromptTurn = (text: string): void => {
      if (promptTurnCommitted) return
      promptTurnCommitted = true
      const { llmProvider: provider, model } = selectedModel
      this.nativeContext = appendNativeMessage(this.nativeContext, nativeAgentAssistantMessage(text, promptMetrics?.realModelName ?? model, provider, promptMetrics?.usage))
      const context = promptMetrics?.context
      if (context) {
        const previousCapacity = this.nativeContext.nativeProviderModel
        this.nativeContext.nativeProviderModel = { provider, selectedModel: model, modelName: context.modelName ?? promptMetrics?.realModelName ?? model, contextWindow: context.contextWindow ?? (previousCapacity?.selectedModel === model ? previousCapacity.contextWindow : undefined) }
        this.recordLastTurnUsage({
          input: context.input, cacheRead: context.cacheRead, cacheWrite: context.cacheWrite,
          signature: promptContextKey, modelKey: promptContextKey,
          contextRevision: this.nativeContext.revision ?? 0,
          measuredAtHistoryLength: Math.max(0, getActiveMessages(this.nativeContext).length - 1)
        })
      }
      this.persist(true)
    }
    try {
      // Instance id → driver → adapter; an unknown or disabled instance, or a blank explicit
      // override, fails the turn here.
      const instance = this.harness.resolveStored(selectedModel, {
        purpose: 'turn',
        scope: this.threadScope(session.threadId)
      })
      // Issue #142: a read-only child is checked on every turn, not only when it was created. Its
      // provider may have been switched, or the user's setup changed, since then.
      if (session.sharedWorkspace) {
        const refusal = await this.targetRefusal(instance, 'shared', session.sharedWorkspace.path)
        // A known error keeps its message; an unknown one would reach the thread as a generic failure.
        if (refusal) throw new AppError({ code: refusal.code, message: refusal.message, errorInfo: { category: 'unavailable', retryable: false } })
      }
      // The attempt's immutable binding; a retry of the same run keeps the one it already has.
      const binding = await this.bindTurn(engineRunId, runBinding, instance, mode, () => opts?.origin ?? this.turnOrigin(session.threadId, request.workflowInvocationId), {
        permissionMode: this.requestedPermissionMode(session.threadId, this.limitedByJob(this.limitedByContinuation(opts?.permissionMode, engineRunId, session.threadId), opts?.schedule)),
        cwd: opts?.bot ? opts.bot.scratch : session.projectCwd,
        ...this.turnApprovals(session.threadId, engineRunId, opts)
      }, opts?.bot?.policy)
      // Every runtime owns its loop, context and tools and receives prior turns as a prompt preamble.
      const modelOverride = opts?.modelOverride ?? session.modelOverride
      const contextSettings = normalizeContextSettings(this.settingsStore.get().context)
      // Runtimes with their own loop get the browser through Mousse's MCP server.
      const browserExecution = !mcpAttachable(instance.caps)
        ? undefined
        : this.mainBrowserFactory
          ? this.mainBrowserFactory({ threadId: session.threadId, turnId, source: opts?.source, mode })
          : this.mainAgentBrowser?.execution.threadId === session.threadId && this.mainAgentBrowser.execution.turnId === turnId ? this.mainAgentBrowser : undefined
      const planning: { failed: boolean; nativeFork?: boolean } = { failed: false }
      handoffs = await this.planTurnHandoffs({
        session, runId: engineRunId, resolved: instance, selection: selectedModel, previousModel,
        content: userContent, images, mode, modelOverride, planning
      })
      if (handoffs) this.recordHandoffMarkers(session, handoffs, switchMarker, turnId, selectedModel)
      const activeMessages = getActiveMessages(this.nativeContext)
      const turnInput: TurnInput = {
        runId: engineRunId ?? turnId,
        attemptId: (engineRunId ? this.runEngine?.getRun(engineRunId)?.activeAttemptId : undefined) ?? turnId,
        threadId: session.threadId,
        // A bot works in its activation's private scratch folder, never a root or a project folder.
        cwd: opts?.bot ? opts.bot.scratch : session.projectCwd ?? null,
        // The bound model: a moved entry's model may run as the agent's own, and a runtime that
        // resolves `default` itself fixed it when the turn was bound (retries and recovery keep it).
        model: binding.model,
        instanceId: instance.instanceId,
        llmProvider: instance.llmProvider,
        modelPinned: Boolean(modelOverride),
        mode,
        // The mode the instance can enforce, recorded on the binding (a binding from before
        // permission modes reads as `accept_edits`).
        permissionMode: binding.policy.permissionMode ?? 'ask',
        child: this.childTurnPolicy(session),
        ...(opts?.source === 'provider-continuation' ? { continuation: true, continuationId: opts.continuationId } : {}),
        ...(opts?.agent ? { fromAgent: true as const } : {}),
        prompt: handoffs ? handoffs.prompt(userContent) : userContent,
        messages: handoffs ? handoffs.messages(activeMessages) : activeMessages,
        // A switch handoff stands in for the transcript, including its compaction memory.
        contextSummary: handoffs?.replaceHistory ? undefined : getCompactionSummary(this.nativeContext),
        images,
        appletInstructions: this.appletStore ? this.appletCatalogue() : undefined,
        nativeHistory: handoffs?.replaceHistory ? '' : nativeAgentHistory(this.nativeContext, turnNativeStartBoundary.messageIndex),
        ...(handoffs?.historyHandedOver ? { historyHandedOver: true } : {}),
        // A branch forked for this very turn holds the parent's history: it stays trusted even when
        // planning failed after it was made.
        ...(planning.failed && !planning.nativeFork ? { handoffUnplanned: true } : {}),
        signal: turn.abort.signal
      }
      const turnSink: TurnSink = {
        text: (event) => this.handleStreamingTextEvent(event),
        thinking: (event) => this.handleStreamingThinkingEvent(event),
        tool: (event) => {
          if (event.kind !== 'skill_loaded') conversationToolsUsed = true
          this.handleStreamingToolEvent(event)
        },
        nativeMessages: (nativeMessages, checkpoint) => {
          // A completed-turn measurement becomes stale as soon as the live loop
          // appends or compacts native history. Estimate until the final provider
          // response supplies a new authoritative prompt measurement.
          this.clearLastTurnUsage()
          this.commitActiveNativeMessages(handoffs && !checkpoint ? handoffs.canonical(nativeMessages) : nativeMessages, checkpoint)
          if (session.drainedExternalSteerIds.size > 0) {
            this.nativeContext = {
              ...this.nativeContext,
              acceptedSteerItemIds: Array.from(new Set([
                ...(this.nativeContext.acceptedSteerItemIds ?? []),
                ...session.drainedExternalSteerIds
              ]))
            }
          }
          this.persist(true)
          // The fork or merge-back history this turn was handed is canonical now (SPEC §16.2).
          handoffs?.committed()
          this.acknowledgeDrainedSteers(session)
          if (session.executionLease) {
            heartbeatExecutionLease(session.executionLease)
          }
        },
        compaction: onCompaction,
        retry: (attempt) => this.addSystemMessage(`Retrying provider request (${attempt}/5)…`),
        progress: () => { providerProgress = true },
        // Usage statistics, as each runtime reports them.
        usage: (usage) => this.lineEditStats?.recordUsage({
          timestamp: new Date().toISOString(), provider: selectedModel.llmProvider,
          model: promptMetrics?.realModelName ?? selectedModel.model, input: usage.input, output: usage.output,
          cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite
        }),
        providerRef: (ref) => this.markRun(engineRunId, (engine, id) => { engine.recordProviderRef(id, ref) }),
        steerAccepted: (text) => {
          this.nativeContext = appendNativeMessage(this.nativeContext, userMessage(text))
          this.nativeContext.acceptedSteerItemIds = Array.from(new Set([
            ...(this.nativeContext.acceptedSteerItemIds ?? []), ...session.drainedExternalSteerIds
          ]))
          this.persist(true)
          this.acknowledgeDrainedSteers(session)
        },
        providerMetrics: (metrics) => { promptMetrics = metrics },
        lineEdits: (lines) => this.lineEditStats?.record('orchestrator', lines)
      }
      // Every drain is remembered under its own token until the provider has taken the text, so a drain
      // the provider hands back restores exactly what that drain took, whatever was drained since.
      const drained = new Map<string, { entries: SteerEntry[]; carried: NonNullable<ActiveTurnControl['carriedSteers']> }>()
      let drains = 0
      let returnedAhead = 0
      const drainEntry = (): { text: string; token: string } | undefined => {
        // A channel turn's steers, then the thread's own (and the durable queue's).
        const raw = opts?.externalDrainSteer?.()
        const external: SteerEntry[] = typeof raw === 'string' ? (raw.trim() ? [{ text: raw.trim() }] : []) : (raw ?? [])
        for (const steer of external) if (steer.itemId) session.drainedExternalSteerIds.add(steer.itemId)
        const own = this.drainSteerForSession(session, turn)
        const entries = [...external, ...(own?.entries ?? [])].filter((steer) => steer.text.trim())
        if (entries.length === 0) return undefined
        const token = `drain-${++drains}`
        // Each entry is kept as it was drained, identity and all, so a return restores them whole, never by cutting text apart.
        drained.set(token, { entries, carried: own?.carried ?? [] })
        returnedAhead = 0
        return { text: entries.map((steer) => steer.text.trim()).join('\n').trim(), token }
      }
      const turnControl: TurnControl = {
        drainSteer: () => drainEntry()?.text,
        drainSteerEntry: drainEntry,
        steerTaken: (token) => { if (token) drained.delete(token) },
        // Text the provider could not give its turn waits for the turn to end, then runs as the next turn.
        // Rows a steer carried are held again, unread, and follow it into that turn.
        returnSteer: (text, token) => {
          const entry = token ? drained.get(token) : undefined
          if (token) drained.delete(token)
          // Returned drains go ahead of anything steered since, oldest first.
          const put = (...items: SteerEntry[]): void => {
            turn.pendingSteer.splice(returnedAhead, 0, ...items)
            returnedAhead += items.length
          }
          if (!entry) return put({ text })
          // The items these entries stand for are not taken: the next acknowledgement must not drop them.
          for (const steer of entry.entries) if (steer.itemId) session.drainedExternalSteerIds.delete(steer.itemId)
          // In the order they were drained: the external steers first, then the thread's own.
          put(...entry.entries)
          for (const carried of entry.carried) this.runEngine?.inbox.unmarkSteerTaken(carried.inboxIds, carried.effectId)
          turn.carriedSteers = [...entry.carried, ...(turn.carriedSteers ?? [])]
        },
        heartbeat: () => this.heartbeatRun(engineRunId)
      }
      const onPublishApplet = this.appletStore ? (value: unknown) => {
        if (stagedApplets.length >= 3) throw new Error('Only three applets may be published per response.')
        stagedApplets.push(validateAppletSubmission(value))
        return { queued: true, title: stagedApplets[stagedApplets.length - 1].title }
      } : undefined
      const app = appTurn ? await this.completeAppTurn(appTurn.turn, { browser: browserExecution, onPublishApplet,
        // What another thread's agent wrote is never read for `/skill` mentions: only a person invokes a skill.
        userContent: opts?.agent ? '' : userContent,
        instanceId: instance.instanceId, model: selectedModel.model, approvals: opts?.bot ? 'never' : binding.policy.approvals, ...(opts?.bot?.instructions ? { botInstructions: opts.bot.instructions } : {}) }) : undefined
      const adapterHost: AdapterHost = {
        tools: {
          onPublishApplet,
          browser: browserExecution,
          delegation: engineRunId && this.effectsEnabled() ? this.turnDelegationTools(session, engineRunId, mode, appTurn?.turn.accessLevel) : undefined,
          toolAccess: session.sharedWorkspace
            ? createAgentToolAccess(SHARED_READER_POLICY, session.sharedWorkspace.path)
            : turnAuthority && turnWriter ? { allows: () => true, execute: (_name, _args, run) => { conversationToolsUsed = true; return turnAuthority.runWriter(turnWriter, run) } } : undefined,
          toolLedger: this.toolLedgerFor(engineRunId),
          // The app tools act only while this run is the thread's active one.
          ...(engineRunId && this.runEngine ? { runActive: () => this.runEngine?.getActiveRun(session.threadId)?.runId === engineRunId } : {})
        },
        context: {
          recoverOverflow: () => {
            if (conversationToolsUsed || providerProgress || !contextSettings.compactionEnabled) return null
            onCompaction('start')
            return compactTranscript() ? compactedContext() : null
          },
          prepareNativeContext: (provider, model) => {
            const capacity = this.nativeContext.nativeProviderModel
            const knownLimit = capacity?.selectedModel === model ? capacity.contextWindow : undefined
            const threshold = typeof contextSettings.compactionTokens === 'number'
              ? contextSettings.compactionTokens : knownLimit
            const previous = session.lastMeasuredContextSignature === `${provider}:${model}`
              ? (session.lastMeasuredInput ?? 0) + (session.lastMeasuredCacheRead ?? 0) + (session.lastMeasuredCacheWrite ?? 0)
              : 0
            const activeTokens = Math.max(previous, estimateActiveContextTokens(getActiveMessages(this.nativeContext), getCompactionSummary(this.nativeContext)))
            // When the runtime has not reported capacity yet, a numeric Mousse threshold
            // still applies; model-max waits for an actual provider window.
            if (!contextSettings.compactionEnabled || threshold === undefined ||
                !shouldCompactNativeContext(activeTokens, knownLimit ?? threshold, DEFAULT_COMPACTION_RESERVE_TOKENS, threshold)) return null
            onCompaction('start')
            const recovered = compactTranscript() ? compactedContext() : null
            return recovered && handoffs?.replaceHistory ? { ...recovered, nativeHistory: '' } : recovered
          },
          nativeHistoryAfterTurn: (text) => {
            commitPromptTurn(text)
            return nativeAgentHistory(this.nativeContext)
          },
          nativeHistoryNow: () => nativeAgentHistory(this.nativeContext)
        }
      }
      const previous = engineRunId ? this.runEngine?.previousBinding(session.threadId, engineRunId, binding.instanceId) : undefined
      const attemptOrdinal = engineRunId ? this.runEngine?.activeAttemptOrdinal(engineRunId) : undefined
      const result = await this.harness.startTurn({
        binding,
        ...(previous ? { previous } : {}),
        ...(attemptOrdinal ? { attemptOrdinal } : {}),
        input: turnInput,
        sink: turnSink,
        control: turnControl,
        host: adapterHost,
        ...(app ? { app } : {}),
        // A bot turn: the activation's shared counts and spend (its instructions are in the preamble).
        ...(opts?.bot ? {
          counters: opts.bot.authority.counters,
          ...(opts.bot.authority.spend ? { spend: opts.bot.authority.spend } : {})
        } : {})
      }).result
      handoffs?.settle(result.aborted || turn.abort.signal.aborted ? 'aborted' : 'completed')
      assistantText = result.text
      aborted = Boolean(result.aborted)
      responseMetadata = {
        modelName: result.modelName,
        totalResponseTimeMs: result.totalResponseTimeMs,
        tokensUsed: result.totalTokensUsed,
        tokensPerSecond: result.tokensPerSecond
      }
      // No-op when the adapter already committed through `nativeHistoryAfterTurn`.
      commitPromptTurn(result.text)
    } catch (err) {
      const normalized = normalizeAppError(err, 'orchestrator_turn_failed')
      const isAbort = turn.abort.signal.aborted || normalized.errorInfo.category === 'cancelled'
      handoffs?.settle('failed', err instanceof Error ? err.message : String(err))
      if (!isAbort) failureDiagnostic = errorDiagnostic(normalized, 'orchestrator.chat')
      if (isAbort) {
        aborted = true
        assistantText = ''
      } else if (isRetriesExhausted(err) && !usageLimitOf(err)) {
        // A usage limit is never a connection failure, however often the provider's own retries met it: it pauses below.
        connectionFailed = true
        providerError = serializeAppError(normalized)
        assistantText = ''
      } else {
        executionFailed = true
        providerError = serializeAppError(normalized)
        // A plan usage limit pauses the run (it is not an error the run can retry now); once the
        // limit was hit again after the cap, it fails with a message that says why.
        const limit = opts?.bot || opts?.schedule ? undefined : this.usageLimitDecision(err, engineRunId)
        if (limit?.action === 'pause') usagePause = limit.pause
        else if (limit?.action === 'fail') providerError = { ...providerError, message: limit.message }
        // A scheduled occurrence is never paused (its run would outlive the occurrence). It fails, and the run
        // records when the limit resets so the scheduler waits for it instead of taking slots inside the window.
        const scheduled = opts?.schedule ? usageLimitOf(err) : undefined
        if (scheduled) scheduledLimitUntil = (scheduled.estimated ? undefined : boundedResetIso(scheduled.resetsAt, Date.now())) ?? estimatedReset(Date.now())
        assistantText = `[${providerError.code}] ${providerError.message}`
      }
    } finally {
      appTurn?.drop()
      if (compactionNote) onCompaction('unchanged')
      if (turn.abort.signal.aborted) aborted = true
      opts?.externalSignal?.removeEventListener('abort', mirrorExternalAbort)
      // The turn remains active until post-stream persistence/actions finish.
    }

    let turnSettled = false
    const settleOnce = (wasAborted: boolean, failed = false, paused = false): void => {
      if (turnSettled) return
      turnSettled = true
      this.settleActiveTurn(session, turn, wasAborted, opts, failed, paused)
    }
    try {

    this.transcript.closeThinking()
    // No item outlives its turn, and a turn ending is never a tool succeeding: whatever the
    // provider did not close is interrupted, tagged with why the turn ended.
    this.transcript.closeOpenTools(
      providerError
        ? 'stop'
        : aborted
          ? this.isShutdownAbort(turn.abort.signal.reason)
            ? 'daemon_restart'
            : 'stop'
          : 'no_result'
    )

    // A usage limit: the run pauses, in the same write that ends its turn. A Stop that came in first
    // (the engine refuses to pause a stopping run) leaves the ordinary failure below.
    if (providerError && usagePause && engineRunId && !turn.abort.signal.aborted && this.pauseForUsageLimit(engineRunId, usagePause)) {
      runTerminalMarked = true
      this.harness.runSettled?.(engineRunId)
      this.transcript.abandonAssistant(this.transcript.openAssistantContent() ?? '', false)
      const message = pausedLine(usagePause)
      this.addSystemMessage(message)
      this.setTurnPhase(session.threadId, 'paused', {
        turnId: engineRunId,
        pause: {
          runId: engineRunId,
          until: usagePause.until,
          estimated: usagePause.estimated,
          autoResume: usagePause.autoResume,
          ...(usagePause.provider ? { provider: usagePause.provider } : {}),
          ...(usagePause.limitKind ? { limitKind: usagePause.limitKind } : {})
        }
      })
      await checkpointTurn('stopped')
      this.persist(true)
      this.emitThreadMessages(session.threadId, session.messages)
      settleOnce(false, false, true)
      this.releaseSessionExecutionLease(session)
      // The queue is held while the run is paused (`scheduleQueueDrain`); this drain is what picks up the continue
      // message of a pause whose timer or Resume now fired before the turn had finished settling.
      if (!suppressAutoQueueDrain) session.drainAfterSettle = true
      return { message, actions: [] }
    }

    if (providerError) {
      console.error('Orchestrator turn failed', failureDiagnostic ?? errorDiagnostic(providerError, 'orchestrator.chat'))
      this.transcript.abandonAssistant(this.transcript.openAssistantContent() ?? '', false)
      const message = `[${providerError.code}] ${providerError.message}`
      this.addSystemMessage(message)
      const failure = this.messages.at(-1)!
      failure.error = providerError
      this.emitMessageUpdated(failure)
      // A bot turn is never retried as a plain turn (Retry is refused on its thread too).
      if (connectionFailed && !opts?.bot) {
        this.failedConnectionRequest = input
        session.failedConnectionLimit = opts?.permissionMode ?? null
        this.emit('connection-failed', { threadId: session.threadId, error: providerError })
      }
      this.setTurnPhase(session.threadId, 'failed', { error: message, errorDescriptor: providerError })
      markRunTerminal('failed', { error: message, ...(scheduledLimitUntil ? { usageLimitUntil: scheduledLimitUntil } : {}) })
      await checkpointTurn('failed')
      this.persist(true)
      const response: OrchestratorResponse = { message, actions: [], error: providerError }
      this.emit('response', response)
      settleOnce(false, true)
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) session.drainAfterSettle = true
      return response
    }

    if (aborted) {
      const partial =
        stripActionBlocks(assistantText).trim() ||
        this.transcript.openAssistantContent()?.trim() ||
        ''
      if (!this.transcript.abandonAssistant(partial, true) && partial) {
        const stopped = this.addMessage('assistant', partial)
        const index = this.messages.findIndex((message) => message.id === stopped.id)
        if (index !== -1) {
          const updated = { ...this.messages[index], incomplete: true }
          this.messages[index] = updated
          this.emitMessageUpdated(updated)
        }
      }
      // SPEC §12.5: a profile shutdown is a restart, not a user's Stop; the next boot notes it.
      const restart = this.isShutdownAbort(turn.abort.signal.reason)
      // A bot's dispatch that ended at a wall waits for its owner; it was not stopped by a person.
      const wall = !restart && Boolean(opts?.bot) && isBotWallAbort(turn.abort.signal.reason)
      this.addSystemMessage(restart ? 'Turn interrupted by a Mousse restart.' : wall ? 'Paused: waiting for the owner.' : 'Turn stopped.')
      const response: OrchestratorResponse = { message: partial, actions: [] }
      this.setTurnPhase(session.threadId, 'stopped')
      markRunTerminal('interrupted', { interruptedBy: restart ? 'daemon_restart' : wall ? 'bot_wall' : 'user' }, partial)
      await checkpointTurn('stopped')
      this.persist(true)
      // Cross-channel IPC delivery and an in-flight renderer snapshot can otherwise leave
      // the persisted stopped message invisible until the thread is reopened.
      this.emitThreadMessages(session.threadId, session.messages)
      this.emit('response', response)
      settleOnce(true)
      // Stop aborts the active turn but retains normal queued messages.
      return response
    }

    if (mode === 'plan') {
      const planMarkdown = (stripActionBlocks(assistantText) || assistantText.trim() || 'No plan generated.') + stagedApplets.map(source => '\n\n```mousse-applet\n' + JSON.stringify(source) + '\n```').join('')
      if (this.activeAssistantMessageId) {
        const streamingId = this.activeAssistantMessageId
        this.activeAssistantMessageId = null
        this.removeMessage(streamingId)
      }
      const planMsg = this.addPlanCardMessage(userContent, planMarkdown, responseMetadata)
      if (this.appletStore && !executionFailed) {
        planMsg.turnId = turnId
        this.persist(true)
        planMsg.presentationParts = publishAppletPresentation(this.appletStore, {threadId:session.threadId,messageId:planMsg.id,turnId,content:planMsg.content})
        this.persist(true)
        this.emitMessageUpdated(planMsg)
      }
      const response: OrchestratorResponse = {
        message: planMsg.content,
        actions: []
      }
      this.setTurnPhase(session.threadId, 'finalizing')
      this.markRun(engineRunId, (engine, id) => engine.markFinalizing(id))
      await checkpointTurn('completed')
      this.persist(true)
      this.setTurnPhase(session.threadId, 'completed')
      markRunTerminal('completed', undefined, planMsg.content)
      this.emit('response', response)
      this.emitThreadMessages(session.threadId, session.messages)
      settleOnce(false)
      this.releaseSessionExecutionLease(session)
      if (!suppressAutoQueueDrain) session.drainAfterSettle = true
      return response
    }

    // Vendor runtimes act through their own tools; `mousse-actions` blocks are a pi-loop protocol.
    const parsedActions: ReturnType<typeof parseActions> = []
    const actions = filterActionsForChatMode(parsedActions, mode)
    const displayText = stripActionBlocks(assistantText) + stagedApplets.map(source => '\n\n```mousse-applet\n' + JSON.stringify(source) + '\n```').join('')

    if (this.activeAssistantMessageId) {
      this.updateStreamingAssistantMessage(
        this.activeAssistantMessageId,
        displayText || 'Done.',
        false,
        responseMetadata
      )
      this.activeAssistantMessageId = null
    } else if (
      this.lastCompletedAssistantMessageId &&
      stripActionBlocks(this.lastCompletedAssistantContent) === displayText
    ) {
      // Compare stripped-to-stripped: the streamed snapshot is raw (often
      // trailing whitespace / action fences) while displayText is stripped.
      // A raw === stripped comparison fails on whitespace alone and appends
      // a visually identical twin message.
      this.updateStreamingAssistantMessage(
        this.lastCompletedAssistantMessageId,
        displayText,
        false,
        responseMetadata
      )
    } else {
      this.addMessage('assistant', displayText || 'Done.', undefined, responseMetadata)
    }

    if (this.appletStore && !executionFailed) {
      const finalMessage = [...session.messages].reverse().find(message => message.role === 'assistant' && !message.kind && message.content === (displayText || 'Done.'))
      if (finalMessage) {
        finalMessage.turnId = turnId
        this.persist(true)
        finalMessage.presentationParts = publishAppletPresentation(this.appletStore, { threadId: session.threadId, messageId: finalMessage.id, turnId, content: finalMessage.content })
        this.persist(true)
        this.emitMessageUpdated(finalMessage)
      }
    }

    for (const action of actions) {
      if (rejectOrchestrationAction(action, mode)) {
        const modeLabel = getChatModeLabel(mode)
        this.addSystemMessage(
          `[${modeLabel.toLowerCase()}] Blocked orchestration action "${action.type}" — ${modeLabel} mode cannot complete tasks.`
        )
        continue
      }
      conversationToolsUsed = true
      const toolCallMessage = this.addToolCallMessage(action)
      try {
        const logs = await this.executeAction(action)
        const failures = logs.filter(isActionFailureLog)
        this.updateToolTimelineMessage(
          toolCallMessage.id,
          {
            title:
              action.type === 'complete_task'
                ? failures.length > 0
                  ? 'Task completion finished with errors'
                  : 'Task completed'
                : toolCallMessage.toolCall?.title ?? 'Action completed',
            summary:
              failures.at(-1) ??
              logs.at(-1) ??
              (action.type === 'message' ? action.content : 'Action completed successfully.'),
            details: logs.length > 0 ? logs : ['Action completed without additional output.'],
            status: 'complete'
          },
          true
        )
        if (action.type === 'complete_task') {
          const wake = buildCompleteTaskFailureWake(action.agentIds, logs) ?? buildCompleteTaskSuccessWake(action.agentIds, logs)
          if (wake) this.postThreadNotice(wake)
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.updateToolTimelineMessage(
          toolCallMessage.id,
          {
            title: 'Action failed',
            summary: message,
            details: [message],
            status: 'complete'
          },
          true
        )
        this.addSystemMessage(`[action failed] ${message}`)
        if (action.type === 'complete_task') {
          const wakeMessage = buildCompleteTaskFailureWake(action.agentIds, [
            `[complete] Failed: ${message}`
          ])
          if (wakeMessage) this.postThreadNotice(wakeMessage)
        }
      }
    }

    const modeOrchestrates = (() => {
      if (typeof mode === 'string') {
        try {
          const desc = this.modeRegistry.getModeSync(mode, {})
          if (desc) return desc.permission?.['task'] !== 'deny'
        } catch (error) {
          logDebug('OrchestratorService', 'mode lookup failed; falling back to default orchestration rules', error, { mode })
        }
      }
      return allowsOrchestrationActions(mode)
    })()
    if (!modeOrchestrates && parsedActions.length > actions.length) {
      const modeLabel = getChatModeLabel(mode).toLowerCase()
      this.addSystemMessage(`[${modeLabel}] Ignored orchestration actions emitted by the model.`)
    }

    const response: OrchestratorResponse = {
      message: displayText || 'Done.',
      actions
    }
    if (executionFailed) {
      this.setTurnPhase(session.threadId, 'failed', { error: 'LLM error' })
      markRunTerminal('failed', { error: 'LLM error' }, displayText)
    } else {
      this.setTurnPhase(session.threadId, 'finalizing')
      this.markRun(engineRunId, (engine, id) => engine.markFinalizing(id))
    }
    await checkpointTurn(executionFailed ? 'failed' : 'completed')
    this.persist(true)
    if (!executionFailed) {
      this.setTurnPhase(session.threadId, 'completed')
      markRunTerminal('completed', undefined, displayText || 'Done.')
    }
    this.emit('response', response)
    this.emitThreadMessages(session.threadId, session.messages)
    settleOnce(aborted, executionFailed)
    this.releaseSessionExecutionLease(session)
    if (!suppressAutoQueueDrain) session.drainAfterSettle = true
    return response
    } finally {
      settleOnce(aborted, connectionFailed || executionFailed)
    }
  }

  /**
   * Drain local pendingSteer plus any durable external steer-intent items once, as entries.
   * External steers remain durable until the resulting native context checkpoint commits.
   * An entry of a promoted queue item carries the item's id: it is excluded from the external scan and
   * acknowledged exactly once the provider has taken its text.
   *
   * A steering item bound to a run (`steerRunId`, set when an agent or a person's promotion was checked
   * against that run) is taken only by that run and only while the run's mode is no looser than the item
   * allows. Any other run that meets it, because the run ended, the daemon restarted or a replacement run
   * drains, reverts it to a pending message before any text is taken: it runs later as a turn of its own,
   * narrowed at admission, and is never delivered to a run it was not checked against.
   */
  private drainSteerForSession(
    session: ThreadSession,
    turn: { runId?: string; pendingSteer: SteerEntry[]; carriedSteers?: ActiveTurnControl['carriedSteers'] }
  ): { entries: SteerEntry[]; carried: NonNullable<ActiveTurnControl['carriedSteers']> } | undefined {
    const entries: SteerEntry[] = []
    let carried: NonNullable<ActiveTurnControl['carriedSteers']> = []
    // A live provider settles the questions and approvals the user is being asked as the user when it takes a steer
    // (it rejects them to read it). Nothing an agent caused (its own steer, a message it promoted) may do that: it waits in
    // the turn's steer buffer until the user has answered.
    const asking = this.questions.listPendingForThread(session.threadId).length > 0
    const held = asking ? turn.pendingSteer.filter((entry) => entry.origin || entry.byAgent) : []
    const taking = held.length ? turn.pendingSteer.filter((entry) => !held.includes(entry)) : turn.pendingSteer
    if (taking.length > 0) {
      entries.push(...taking)
      // Remembered whole by the caller until the provider has taken the text (`returnSteer`).
      carried = [...(turn.carriedSteers ?? [])]
      turn.pendingSteer = held
      // The model reads them now: the rows their steers carried are delivered to this run.
      for (const entry of turn.carriedSteers ?? []) this.runEngine?.inbox.markSteerTaken(entry.inboxIds, entry.effectId)
      turn.carriedSteers = []
      // These items are drained: the scan below must not take them again, and they are acknowledged with the others.
      for (const entry of entries) if (entry.itemId) session.drainedExternalSteerIds.add(entry.itemId)
    }

    // Refresh durable queue so peer CLI/GUI steers are visible mid-turn.
    this.refreshSessionQueueFromDisk(session)
    const externalSteers = listPendingQueue(session.queue).filter(
      (item) =>
        item.intent === 'steer' &&
        (item.state === 'pending' || item.state === 'steering') &&
        !session.drainedExternalSteerIds.has(item.id) &&
        !held.some((entry) => entry.itemId === item.id) &&
        !(asking && item.origin?.kind === 'agent')
    )
    const revert: string[] = []
    for (const item of externalSteers) {
      if (item.steerRunId && !this.mayTakePromotedItem(item, turn.runId)) {
        revert.push(item.id)
        continue
      }
      entries.push({
        text: item.content,
        itemId: item.id,
        ...(item.permissionMode ? { permissionMode: item.permissionMode } : {}),
        ...(item.origin?.kind === 'agent' ? { origin: item.origin } : {}),
        ...(item.mode ? { mode: item.mode } : {}),
        ...(item.images?.length ? { images: item.images } : {})
      })
      session.drainedExternalSteerIds.add(item.id)
    }
    if (revert.length) {
      try {
        if (this.threadStore) session.queue = mutateDurableQueue(this.threadStore, session.threadId, (disk) => demoteSteerItems(disk, revert))
        else session.queue = demoteSteerItems(session.queue, revert)
        this.emitQueueUpdated(session.threadId, session.queue)
      } catch (error) {
        // Nothing was taken from them: they stay as they are and are met by the next drain or demoted at the next claim.
        console.warn('promoted queue items could not be returned to pending', { threadId: session.threadId, error: error instanceof Error ? error.message : String(error) })
      }
    }

    if (session.executionLease) {
      heartbeatExecutionLease(session.executionLease)
    }

    return entries.length || carried.length ? { entries, carried } : undefined
  }

  /** A promoted item joins only the run it was checked against, and only while that run's mode is no looser than the item allows. */
  private mayTakePromotedItem(item: QueuedMessage, runId: string | undefined): boolean {
    if (!runId || item.steerRunId !== runId) return false
    if (!item.permissionMode) return true
    // A run with no binding yet is unknown, not strict: nothing joins it.
    const binding = this.runEngine?.bindingForRun(runId)
    if (!binding) return false
    return !isStricter(item.permissionMode, binding.policy.permissionMode ?? 'ask')
  }

  /** Remove steer queue entries only after their content and IDs are durable. */
  private acknowledgeDrainedSteers(session: ThreadSession): void {
    const ids = [...session.drainedExternalSteerIds]
    if (ids.length === 0) return
    if (this.threadStore) {
      session.queue = mutateDurableQueue(this.threadStore, session.threadId, (disk) =>
        dropSteerItems(disk, ids)
      )
    } else {
      session.queue = dropSteerItems(session.queue, ids)
    }
    session.drainedExternalSteerIds.clear()
    this.emitQueueUpdated(session.threadId, session.queue)
    const accepted = new Set(this.nativeContext.acceptedSteerItemIds ?? [])
    for (const id of ids) accepted.delete(id)
    this.nativeContext = {
      ...this.nativeContext,
      acceptedSteerItemIds: accepted.size > 0 ? [...accepted] : undefined
    }
    this.persist(true)
  }

  /**
   * After a turn settles, FIFO-claim the next normal queued message for the thread.
   * Steer-intent items are never drained as normal turns.
   * Re-reads durable queue so peer enqueues during the turn are not missed.
   *
   * When `managedByStartup` is true, the started turn suppresses ordinary internal
   * auto-drain so the startup pump retains exclusive control of chaining under the
   * concurrency bound.
   *
   * Accepted provenance is loaded **inside** the queue mutation critical section
   * (loadThreadData does not take the queue lock). Read failures abort the mutation
   * without saving — never reclaim/claim from an empty fallback.
   *
   * `onSettled` receives:
   * - `idle` — nothing claimed
   * - `ran` — turn finished without rejection
   * - `failed` — turn rejected (startup must not infinite-retry the same failure)
   */
  private scheduleQueueDrain(
    session: ThreadSession,
    opts?: {
      onSettled?: (result: 'idle' | 'ran' | 'failed') => void
      managedByStartup?: boolean
    }
  ): void {
    const settle = (result: 'idle' | 'ran' | 'failed'): void => {
      opts?.onSettled?.(result)
    }
    if (this.lifecycle.stopping) { settle('idle'); return }
    if (session.deleted || session.threadId === '__unbound__') {
      settle('idle')
      return
    }
    if (session.isTurnRunning()) {
      settle('idle')
      return
    }
    this.reclaimStaleThreadLease(session.threadId)
    if (this.isThreadLeaseHeldExternally(session.threadId, session.executionLease?.owner.token)) {
      settle('idle')
      return
    }
    // Active owner re-reads durable queue before claim.
    this.refreshSessionQueueFromDisk(session)
    const claimToken = createLeaseToken()
    const claimOwner = {
      ownerPid: process.pid,
      ownerToken: claimToken,
      claimedAt: new Date().toISOString(),
      source: 'orchestrator'
    }
    let claimed: QueuedMessage | null = null
    try {
      if (this.threadStore) {
        const store = this.threadStore
        const threadId = session.threadId
        session.queue = mutateDurableQueue(store, threadId, (disk) => {
          // Provenance inside the same critical section as reclaim/claim (fail closed).
          const data = store.loadThreadData(threadId)
          const nativeAcceptedQueueIds = new Set(data.llmContext?.acceptedQueueItemIds ?? [])
          const transcriptAcceptedQueueIds = new Set(
            data.messages
              .filter((message) => typeof message.queueItemId === 'string')
              .map((message) => message.queueItemId as string)
          )
          const ambiguous = disk.find((item) =>
            transcriptAcceptedQueueIds.has(item.id) !== nativeAcceptedQueueIds.has(item.id)
          )
          if (ambiguous) {
            throw new Error(`QUEUE_PROVENANCE_UNAVAILABLE:${ambiguous.id}`)
          }
          const acceptedIds = new Set(
            data.messages
              .filter((message) =>
                typeof message.queueItemId === 'string' &&
                nativeAcceptedQueueIds.has(message.queueItemId)
              )
              .map((message) => message.queueItemId as string)
          )
          const acceptedSteerIds = new Set(data.llmContext?.acceptedSteerItemIds ?? [])
          // Opportunistically complete accepted claims whose queue-file complete failed earlier.
          // Does not release unaccepted live-owner claims.
          const cleaned = reclaimAbandonedClaims(disk, {
            isOwnerLive: (claim) => isProcessAlive(claim.ownerPid),
            isAccepted: (item) => acceptedIds.has(item.id)
          }).items
          const demoted = demoteSteerItems(dropSteerItems(cleaned, [...acceptedSteerIds]))
          // The queue is held while the thread is paused; only the continue message of the pause goes.
          const result = this.pausedHoldsQueue(threadId, demoted) ? { items: demoted, claimed: null } : claimNextNormal(demoted, claimOwner)
          claimed = result.claimed
          return result.items
        })
      } else {
        const demoted = demoteSteerItems(session.queue)
        const result = this.pausedHoldsQueue(session.threadId, demoted) ? { items: demoted, claimed: null } : claimNextNormal(demoted, claimOwner)
        session.queue = result.items
        claimed = result.claimed
      }
    } catch (err) {
      this.emit('queue-drain-failed', {
        threadId: session.threadId,
        error: err instanceof Error ? err.message : String(err)
      })
      settle('failed')
      return
    }
    this.emitQueueUpdated(session.threadId, session.queue)
    if (!claimed) {
      settle('idle')
      return
    }
    if (this.threadStore && !this.threadStore.getThread(session.threadId)) {
      session.deleted = true
      session.queue = []
      settle('idle')
      return
    }
    let item = claimed as QueuedMessage
    // A scheduled prompt never answers for the user, and never replaces the context a waiting approval was
    // meant to continue: it stays queued while the thread waits on one, at startup too (the approval a restart
    // left has no live turn holding the thread). The claim is given back; it drains once nothing waits.
    // A message another thread's agent sent is held the same way, and also while a run of the thread is paused by a
    // usage limit: only a person's message ends a pause, so it waits until the pause ends on its own.
    const heldBack = ((item.origin?.kind === 'schedule' || item.origin?.kind === 'agent') && this.questions.listPendingForThread(session.threadId).length > 0)
      || (item.origin?.kind === 'agent' && this.hasPausedRun(session.threadId))
    if (heldBack) {
      this.releaseSessionClaim(session, item.id, claimToken)
      this.emitQueueUpdated(session.threadId, session.queue)
      settle('idle')
      return
    }
    const managedByStartup = opts?.managedByStartup === true
    // The Stop fence at promotion: an entry that starts work on behalf of a parent and was queued before a
    // Stop of its thread is refused (a Stop removes such entries itself; this catches one that outlived it).
    if (item.stopGeneration !== undefined && this.runEngine && item.stopGeneration < currentStopGeneration(this.runEngine.store, session.threadId)) {
      this.refuseFencedQueueItem(session, item, claimToken)
      this.scheduleQueueDrain(session, opts)
      return
    }
    // The continue message of a pause is never dropped for want of rows: it is rebuilt from the rows it still
    // owns and always runs, with the fixed text, and ends the pause when its run is admitted.
    const resume = this.runEngine && isResumeSource(item.source) && item.continuationOfRunId ? item : undefined
    if (resume) item = this.rebuildResumeItem(resume)
    else if (item.inboxIds?.length && this.runEngine) {
      // A queued steer that carries notices is rebuilt now: a row acknowledged since it was queued
      // (a `task_status` read) is dropped, and with none left there is nothing to deliver.
      const rows = this.dropStaleQuestionRows(this.runEngine.inbox.getMany(item.inboxIds).filter((row) => row.status === 'delivered' && row.deliveredBy === queueOwner(item.id)))
      if (rows.length === 0) {
        this.completeSessionClaim(session, item.id, claimToken)
        this.scheduleQueueDrain(session, opts)
        return
      }
      const planned = planWakeNotice(rows, this.noticeContext())
      this.runEngine.inbox.recordNoticeVisibility(rows, planned.items)
      item = { ...item, content: planned.text, inboxIds: rows.map((row) => row.inboxId), subagentNotice: planned.items }
    }
    const queued = item
    const startClaimed = (runId: string | undefined, admissionHeld: boolean): Promise<OrchestratorResponse> => {
      // A turn a message from another computer starts is that computer's, whenever the queue drains it.
      if (runId && queued.sentFrom?.node) this.recordRunSentFrom(session.threadId, runId, queued.sentFrom.node)
      return this.startTurn(session, {
      runId,
      threadId: session.threadId,
      input: {
        content: queued.content,
        workflowInvocationId: queued.workflowInvocationId,
        mode: queued.mode,
        images: queued.images
      },
      reuseLastUser: false,
      displayUserMessage: !queued.internal,
      queueItemId: queued.id,
      claimOwnerToken: claimToken,
      source: queued.source,
      suppressAutoQueueDrain: managedByStartup,
      admissionHeld,
      ...(queued.permissionMode ? { permissionMode: queued.permissionMode } : {}),
            ...(queued.inboxIds?.length ? { inboxIds: queued.inboxIds, subagentNotice: queued.subagentNotice } : {}),
      // The item is consumed when the turn accepts its input, so what the run needs travels on the request.
      ...(queued.origin?.kind === 'schedule'
        ? {
            ...(queued.origin.selection ? { modelOverride: queued.origin.selection } : {}),
            origin: 'schedule' as const,
            schedule: { jobId: queued.origin.jobId, occurrenceKey: queued.origin.occurrenceKey, ...(queued.origin.jobName ? { jobName: queued.origin.jobName } : {}) }
          }
        : {}),
      // An agent's message drains as that agent's, whenever it runs.
      ...(queued.origin?.kind === 'agent' ? { agent: agentOriginOf(queued.origin) } : {})
    })
    }
    let started: Promise<OrchestratorResponse | undefined>
    if (resume) {
      // The pause ends in the transaction that admits the continuation. A refusal (the pause ended some other
      // way first) retires the item without ever reaching the provider.
      session.turnAdmitted = true
      started = this.admitResumeItem(session, resume, item, claimToken).then((runId) => {
        if (!runId) return undefined
        try {
          return startClaimed(runId, true)
        } catch (error) {
          // The turn could not be handed on (before any effect took the admission): the item goes back to the queue
          // and the continuation, already admitted, is found again by its replay.
          session.turnAdmitted = false
          session.admissionRunId = undefined
          throw error
        }
      })
    } else if (!item.runId && this.runEngine) {
      // Hold admission across the run-record await so no concurrent send can start a turn.
      session.turnAdmitted = true
      started = this.ensureQueueItemRun(item).then((runId) => startClaimed(runId, true))
    } else {
      // With effects, startTurn admits the claim now and keeps it admitted until the executor runs.
      started = startClaimed(item.runId, false)
    }
    void started
      .then((response) => {
        settle(response ? 'ran' : 'idle')
      })
      .catch((err) => {
        // Fail-closed: only definite not_accepted may release.
        this.settleClaimAfterFailure(
          session,
          item.id,
          claimToken,
          err instanceof Error ? err.message : String(err)
        )
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId: item.id,
          error: err instanceof Error ? err.message : String(err)
        })
        settle('failed')
      })
  }

  /**
   * Whether a drain must leave the queue alone: the thread is paused by a usage limit and the next
   * pending item (the one `claimNextNormal` would take) is not that pause's continue message. What was
   * queued before the pause waits behind it, in its original order, and what is sent during it is
   * either a person's message (which ends the pause) or held the same way.
   */
  private pausedHoldsQueue(threadId: string, items: QueuedMessage[]): boolean {
    let paused: RunRecord | null | undefined
    try {
      paused = this.runEngine?.store.getPausedRun(threadId)
    } catch (error) {
      // A pause that cannot be read is held, never skipped: a drain would start a person's queued run, which ends it.
      console.warn('the pause of a thread could not be read; its queue stays held', { threadId, error: error instanceof Error ? error.message : String(error) })
      return true
    }
    if (!paused) return false
    const next = listPendingQueue(items).find((item) => item.intent === 'normal' && item.state === 'pending')
    return !next || next.id !== paused.outcome?.pause?.resumeItemId
  }

  /**
   * Startup / headless recovery: reclaim abandoned claims then drain pending normal work
   * without requiring the GUI. Bounded and non-blocking — does not steal live ownership.
   */
  scheduleStartupQueueRecovery(): void {
    if (this.lifecycle.stopping) return
    if (!this.threadStore) return
    setImmediate(() => {
      try {
        this.recoverAndDrainPendingQueues()
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: null,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    })
  }

  /**
   * Reclaim abandoned claims, then drain pending work with a small concurrency bound.
   * Every eligible thread is considered in deterministic list order; completion/failure
   * advances the startup queue. Does not block the caller.
   */
  recoverAndDrainPendingQueues(): void {
    if (this.lifecycle.stopping) return
    if (!this.threadStore) return
    const threads = this.threadStore.listAllThreads()
    // Deterministic order for scheduling.
    const ordered = [...threads].sort((a, b) => a.id.localeCompare(b.id))

    for (const thread of ordered) {
      if (thread.settledAt) continue
      try {
        this.reclaimAbandonedClaimsForThread(thread.id)
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    for (const thread of ordered) {
      if (thread.settledAt) continue
      if (this.startupDrainScheduled.has(thread.id)) continue
      try {
        const session = this.getOrCreateSession(thread.id)
        if (session.deleted || session.isTurnRunning()) continue
        this.reclaimStaleThreadLease(thread.id)
        if (this.isThreadLeaseHeldExternally(thread.id, session.executionLease?.owner.token)) {
          continue
        }
        // Only enqueue threads that still have pending normal work after reclaim.
        this.refreshSessionQueueFromDisk(session)
        const hasPendingNormal = listPendingQueue(session.queue).some(
          (item) => item.intent === 'normal' && item.state === 'pending'
        )
        if (!hasPendingNormal || this.pausedHoldsQueue(thread.id, session.queue)) continue
        this.startupDrainScheduled.add(thread.id)
        this.startupDrainPending.push(thread.id)
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: thread.id,
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }

    this.pumpStartupDrainQueue()
  }

  private pumpStartupDrainQueue(): void {
    if (this.lifecycle.stopping) return
    while (
      this.startupDrainActive < OrchestratorService.STARTUP_QUEUE_DRAIN_CONCURRENCY &&
      this.startupDrainPending.length > 0
    ) {
      const threadId = this.startupDrainPending.shift()!
      const session = this.getOrCreateSession(threadId)
      this.reclaimStaleThreadLease(threadId)
      if (
        session.deleted ||
        session.isTurnRunning() ||
        this.isThreadLeaseHeldExternally(threadId, session.executionLease?.owner.token)
      ) {
        this.startupDrainScheduled.delete(threadId)
        continue
      }
      this.startupDrainActive += 1
      // Startup-managed: one turn per slot. Internal auto-drain is suppressed so chaining
      // stays under this pump and concurrency never exceeds STARTUP_QUEUE_DRAIN_CONCURRENCY.
      this.scheduleQueueDrain(session, {
        managedByStartup: true,
        onSettled: (result) => {
          this.startupDrainActive = Math.max(0, this.startupDrainActive - 1)
          this.startupDrainScheduled.delete(threadId)
          // Only chain further items after a successful run. Failures advance the
          // startup queue without infinite-retrying the same pre-accept error.
          if (result === 'ran') {
            try {
              if (!session.deleted && !session.isTurnRunning()) {
                this.refreshSessionQueueFromDisk(session)
                const more = listPendingQueue(session.queue).some(
                  (item) => item.intent === 'normal' && item.state === 'pending'
                )
                if (
                  more &&
                  !this.isThreadLeaseHeldExternally(
                    threadId,
                    session.executionLease?.owner.token
                  ) &&
                  !this.startupDrainScheduled.has(threadId)
                ) {
                  this.startupDrainScheduled.add(threadId)
                  this.startupDrainPending.push(threadId)
                }
              }
            } catch {
              // best-effort requeue
            }
          }
          this.pumpStartupDrainQueue()
        }
      })
    }
  }

  /**
   * Reclaim abandoned claims for a thread.
   * Accepted claims (transcript provenance) complete even while the owner process is live.
   * Unaccepted claims are released only when ownership is demonstrably stale/dead.
   * Provenance is loaded inside the queue mutation lock (fail closed on read errors).
   */
  reclaimAbandonedClaimsForThread(threadId: string): QueuedMessage[] {
    if (!this.threadStore) return []
    if (!this.threadStore.getThread(threadId)) return []

    // Default durable reclaim loads accepted ids inside the mutation critical section.
    const result = reclaimAbandonedClaimsDurable(this.threadStore, threadId, {
      isOwnerLive: (claim) => isProcessAlive(claim.ownerPid)
    })

    const session =
      this.boundSession.threadId === threadId
        ? this.boundSession
        : this.sessions.get(threadId)
    if (session) {
      session.queue = result.items
    }
    this.emitQueueUpdated(threadId, result.items)
    return result.items
  }

  /**
   * Release a claim on the durable store. Durable errors are not masked by session-only
   * mutation — the claim stays for recovery and diagnostics are emitted.
   */
  private releaseSessionClaim(
    session: ThreadSession,
    itemId: string,
    ownerToken?: string
  ): QueuedMessage | null {
    if (this.threadStore && session.threadId !== '__unbound__') {
      try {
        const released = releaseClaimDurable(this.threadStore, session.threadId, itemId, {
          ownerToken
        })
        session.queue = readDurableQueue(this.threadStore, session.threadId)
        this.emitQueueUpdated(session.threadId, session.queue)
        return released
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId: itemId,
          error: `release claim failed: ${err instanceof Error ? err.message : String(err)}`
        })
        try {
          session.queue = readDurableQueue(this.threadStore, session.threadId)
          this.emitQueueUpdated(session.threadId, session.queue)
        } catch {
          // leave session queue untouched rather than lying about disk state
        }
        return null
      }
    }
    const result = releaseClaim(session.queue, itemId, { ownerToken })
    session.queue = result.items
    this.emitQueueUpdated(session.threadId, session.queue)
    return result.released
  }

  /**
   * Complete a claim on the durable store after transcript acceptance.
   * Durable errors keep the claim for provenance-based recovery (no session-only lie).
   */
  private completeSessionClaim(
    session: ThreadSession,
    itemId: string,
    ownerToken?: string
  ): QueuedMessage | null {
    if (this.threadStore && session.threadId !== '__unbound__') {
      try {
        const completed = completeClaimDurable(this.threadStore, session.threadId, itemId, {
          ownerToken
        })
        session.queue = readDurableQueue(this.threadStore, session.threadId)
        this.emitQueueUpdated(session.threadId, session.queue)
        if (completed && session.nativeContext.acceptedQueueItemIds?.includes(itemId)) {
          const remaining = session.nativeContext.acceptedQueueItemIds.filter((id) => id !== itemId)
          session.nativeContext = {
            ...session.nativeContext,
            acceptedQueueItemIds: remaining.length > 0 ? remaining : undefined
          }
          this.persist(true)
        }
        return completed
      } catch (err) {
        this.emit('queue-drain-failed', {
          threadId: session.threadId,
          queueItemId: itemId,
          error: `complete claim failed: ${err instanceof Error ? err.message : String(err)}`
        })
        try {
          session.queue = readDurableQueue(this.threadStore, session.threadId)
          this.emitQueueUpdated(session.threadId, session.queue)
        } catch {
          // leave session queue untouched rather than lying about disk state
        }
        return null
      }
    }
    const result = completeClaim(session.queue, itemId, { ownerToken })
    session.queue = result.items
    this.emitQueueUpdated(session.threadId, session.queue)
    return result.completed
  }

  retryLastConnection(threadId?: string): boolean {
    if (this.lifecycle.stopping) return false
    const session = threadId
      ? this.getOrCreateSession(threadId)
      : this.boundSession
    this.assertNotBotThread(session.threadId)
    if (!session.failedConnectionRequest || session.isTurnRunning()) return false
    const request = session.failedConnectionRequest
    // A request sent under a device's limit is retried under it, whoever presses Retry.
    const limit = session.failedConnectionLimit ?? undefined
    session.failedConnectionRequest = null
    session.failedConnectionLimit = null
    void this.runTurnOnSession(session, request, true, true, limit ? { permissionMode: limit } : undefined).catch((err) => {
      this.emit('queue-drain-failed', {
        threadId: session.threadId === '__unbound__' ? null : session.threadId,
        error: err instanceof Error ? err.message : String(err)
      })
    })
    return true
  }

  private async executeAction(action: OrchestratorAction): Promise<string[]> {
    switch (action.type) {
      case 'complete_task':
        return this.completeTask(action.agentIds, action.merge !== false)
      case 'message':
        return [action.content]
      default:
        return []
    }
  }

  /**
   * An automatic follow-up for this thread (e.g. a `complete_task` outcome) is a stored
   * `reconcile_notice` inbox row; reconciler rule 4 wakes the thread for it (SPEC §14.3). Without
   * the run engine the notice is shown as a system message only.
   */
  private postThreadNotice(text: string): void {
    const threadId = this.session.threadId
    if (this.lifecycle.stopping) return
    const engine = this.runEngine
    if (!engine || threadId === '__unbound__') {
      this.addSystemMessage(text)
      return
    }
    try {
      engine.inbox.append({ threadId, kind: 'reconcile_notice', payload: { text } })
    } catch (error) {
      this.addSystemMessage(`[automatic wake failed] ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async withTaskWriter<T>(session: ThreadSession, work: () => Promise<T>): Promise<T> {
    const directory = this.resolveThreadDir(session.threadId)
    if (!directory || !this.threadStore || !this.projectManager) throw new Error('Isolated agents require an owned task workspace')
    const held = session.executionLease
    const lease = held ?? await waitAcquireExecutionLease(directory, { source: 'agent-workspace', signal: this.lifecycle.signal })
    const heartbeat = setInterval(() => heartbeatExecutionLease(lease), 10_000)
    heartbeat.unref()
    try {
      session.executionLease = lease
      const project = resolveThreadProjectPath(this.projectManager, this.threadStore, session.threadId)
      if (!project) throw new Error('Isolated agents require a project')
      if (!held || !session.workspace) {
        session.workspace = await new WorkspaceResolver(directory, session.threadId, project).resolve('agent', 'main', this.lifecycle.signal, lease)
      }
      if (!session.workspace.capability.checkpointable) throw new Error('Isolated agents require an owned Git workspace')
      session.projectCwd = session.workspace.projectPath
      return await work()
    } finally {
      clearInterval(heartbeat)
      if (!held) { releaseExecutionLeaseHandle(lease); session.executionLease = null }
    }
  }

  private async completeTask(agentIds: string[], merge: boolean): Promise<string[]> {
    const logs: string[] = []
    const agentList: Agent[] = []
    for (const agentId of new Set(agentIds)) {
      // Accept the 8-character ids used throughout the UI when they identify one
      // agent unambiguously, while retaining exact-id behavior for full UUIDs.
      const matches = this.agents.list().filter((candidate) => candidate.id === agentId || candidate.id.startsWith(agentId))
      const agent = matches.length === 1 ? matches[0] : undefined
      if (!agent) {
        logs.push(`[complete] Agent not found or prefix is ambiguous: ${agentId}`)
        continue
      }
      // Normal completion is never a cancellation mechanism. Running agents must
      // finish (or be explicitly stopped through stopAgent) before they are eligible.
      if (agent.status === 'starting' || agent.status === 'running') {
        logs.push(`[complete] Refused active agent ${agent.id.slice(0, 8)} (${agent.status})`)
        continue
      }
      const hasMergeCandidate = requiresMergeCandidateToFinalize(agent.status)
        ? await this.worktrees.hasMergeCandidate({
            path: agent.worktreePath,
            branch: agent.branch,
            repositoryRoot: agent.repositoryRoot
          })
        : false
      if (shouldFinalizeAgent(agent.status, hasMergeCandidate)) agentList.push(agent)
      else logs.push(`[complete] Agent ${agent.id.slice(0, 8)} is not eligible (${agent.status})`)
    }

    if (agentList.length === 0) {
      if (logs.length === 0) logs.push('[complete] No agents selected')
      return logs
    }

    for (const agent of agentList) {
      logs.push(...(await this.finalizeAgent(agent, merge)))
      // The action executor queues one follow-up main-agent turn containing all failure
      // details after the tool timeline has been updated. Stop here so later branches do
      // not mutate a main worktree that is already in a conflicted merge state.
      if (this.agents.get(agent.id)?.status === 'conflict') break
    }

    this.emit('task-completed')
    return logs
  }

  async stopAgentForThread(threadId: string, agentId: string, merge = false): Promise<string[]> {
    const session = this.getOrCreateSession(threadId)
    return this.sessionAls.run(session, () => this.stopAgent(agentId, merge))
  }

  async stopAgent(agentId: string, merge = false): Promise<string[]> {
    const agent = this.agents.get(agentId)
    if (!agent) {
      return [`[agent] Not found: ${agentId}`]
    }
    if (isTerminalAgentStatus(agent.status) && !merge) {
      return [`[agent] Already ${agent.status}: ${agentId.slice(0, 8)}`]
    }
    if (agent.status === 'failed') {
      return [`[agent] Already failed: ${agentId.slice(0, 8)}`]
    }
    if (agent.status === 'starting' && !agent.worktreePath) {
      this.agents.updateStatus(agent.id, 'cancelled')
      const task = this.tasks.findByAgentId(agent.id)
      if (task) this.tasks.updateStatus(task.id, 'cancelled')
      return [`[agent] Cancelled discovery for ${agent.id.slice(0, 8)}`]
    }
    if (isTerminalAgentStatus(agent.status) && merge) {
      const hasMergeCandidate = await this.worktrees.hasMergeCandidate({
        path: agent.worktreePath,
        branch: agent.branch,
        repositoryRoot: agent.repositoryRoot
      })
      if (!shouldFinalizeAgent(agent.status, hasMergeCandidate)) {
        return [`[agent] Already ${agent.status}: ${agentId.slice(0, 8)}`]
      }
    }
    const logs = await this.finalizeAgent(agent, merge)
    this.emit('task-completed')
    return logs
  }

  /**
   * Read-only orphan/ghost scan for `.mousse-worktrees`. Does not delete anything.
   */
  async scanOrphanWorktrees() {
    const known = this.agents.list().map((agent) => ({
      path: agent.worktreePath,
      branch: agent.branch
    }))
    return this.worktrees.scanOrphanWorktrees(known)
  }

  /**
   * Explicit cleanup of validated agent worktrees only. Ghost directories are never deleted.
   * Cancelled/failed/ready worktrees are kept unless their agent ids are listed.
   */
  async cleanupAgentWorktrees(
    agentIds: string[],
    options: { deleteBranch?: boolean } = {}
  ): Promise<string[]> {
    const logs: string[] = []
    const targets = agentIds
      .map((id) => this.agents.get(id))
      .filter((agent): agent is Agent => Boolean(agent))
      .map((agent) => ({ path: agent.worktreePath, branch: agent.branch, id: agent.id }))

    for (const target of targets) {
      const result = await this.worktrees.cleanupValidatedAgentWorktree(
        { path: target.path, branch: target.branch },
        options
      )
      if (result.success) {
        logs.push(`[worktree] Removed validated worktree for ${target.id.slice(0, 8)}`)
      } else {
        logs.push(`[worktree] Cleanup refused/failed for ${target.id.slice(0, 8)}: ${result.error}`)
      }
    }
    return logs
  }

  private async integrateAgentResult(agent: Agent): Promise<{ success: boolean; conflict?: boolean; conflicts?: string[]; error?: string }> {
    const owner = this.agentOwner(agent.id) ?? this.session
    try {
      return await this.withTaskWriter(owner, async () => {
        const directory = this.resolveThreadDir(owner.threadId)!
        const parent = owner.workspace!.workspacePath
        if (agent.repositoryRoot && actionGit(agent.repositoryRoot, ['rev-parse', '--show-toplevel']) !== actionGit(parent, ['rev-parse', '--show-toplevel'])) {
          throw new Error('Child integration target no longer matches its owned task workspace')
        }
        const base = actionGit(agent.worktreePath, ['rev-parse', `refs/mousse/agents/${agent.id}/base`])
        const workerHead = actionGit(agent.worktreePath, ['rev-parse', 'HEAD'])
        if (agent.readyCommit && agent.readyCommit !== workerHead) throw new Error('Worker HEAD changed after readiness validation')
        if (agent.readyCommit) requireCleanWorkspace(agent.worktreePath, 'Ready worker')
        const workerAction = await new ThreadActionService(join(directory, 'agent-changes', agent.id)).checkpointExistingTurn({
          threadId: agent.id, turnId: `worker-result:${agent.id}`, conversationBranchId: 'main',
          actor: { kind: 'agent', id: agent.id }, workspacePath: agent.worktreePath,
          externalEffects: [{ kind: 'unknown', reversible: false, description: 'Child tools may affect ignored files or external services; integrating or undoing code does not reverse those effects.' }],
          presentationMessageStart: 0, presentationMessageEnd: 0,
          nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
        }, base, 'completed')
        await new ChildAgentIntegrationService(directory).integrate({
          agentId: agent.id, operationId: `chat-integration:${agent.id}:${workerAction.endSha}`,
          workerWorktree: agent.worktreePath,
          spawnBaseSha: base,
          pinnedWorkerSha: workerAction.endSha,
          threadWorkspace: parent, heldThreadLease: owner.executionLease ?? undefined,
          externalEffects: workerAction.externalEffects,
          actor: { kind: 'agent', id: agent.id }
        })
        // Retain the worker and pinned result for undo/recovery. GC owns retirement.
        return { success: true }
      })
    } catch (error) {
      const conflicts = error instanceof ChildIntegrationConflictError ? error.files : []
      return { success: false, conflict: conflicts.length > 0, conflicts, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Named agents are retired, but old task data still holds their identities in agent-episodes.json. */
  private isLegacyNamedAgent(agent: Agent): boolean {
    const owner = this.agentOwner(agent.id)
    const directory = owner ? this.resolveThreadDir(owner.threadId) : undefined
    try { return Boolean(directory && new AgentEpisodeStore(directory).resolve(agent.id)) }
    catch { return false }
  }

  private async finalizeAgent(agent: Agent, merge: boolean): Promise<string[]> {
    if (this.isLegacyNamedAgent(agent)) {
      const retired = `${agent.id.slice(0, 8)} is a retired named agent; its result stays on its retained branch and can be merged by hand.`
      if (merge) throw new Error(`Cannot merge ${retired}`)
      return [`[agent] ${retired} Nothing was stopped or changed.`]
    }
    const logs: string[] = []
    // Enter merging before aborting writers so a programmatic abort during finalize
    // is not mis-reported as a user interrupt on a still-ready agent.
    this.agents.updateStatus(agent.id, 'merging')
    const task = this.tasks.findByAgentId(agent.id)

    // Stop all writers before cleanup or Git operations. A legacy GUI session has no live turn
    // to stop, and no headless agent process can exist since that launcher was retired; only
    // terminals can still be writing.
    if (agent.executionMode !== 'gui' && agent.executionMode !== 'headless' && agent.ptyId) {
      this.ptyManager.kill(agent.ptyId)
      logs.push(`[terminal] Closed agent ${agent.id.slice(0, 8)}`)
    }

    if (merge) {
      const result = await this.integrateAgentResult(agent)
      if (result.success) {
        logs.push(`[merge] Merged ${agent.branch}`)
        this.agents.updateStatus(agent.id, 'completed')
        if (task) {
          this.tasks.updateProgress(task.id, {
            progress: 100,
            message: `Merged ${agent.branch}`
          })
          this.tasks.updateStatus(task.id, 'completed')
        }
      } else if (result.conflict) {
        const files = result.conflicts?.join(', ') || 'unknown files'
        logs.push(`[merge] Conflict for ${agent.branch}: ${files}`)
        logs.push(`[merge] Details: ${result.error}`)
        this.agents.updateStatus(agent.id, 'conflict')
        task && this.tasks.updateProgress(task.id, {
          message: `Merge conflict: ${files}`
        })
        // The thread's files are untouched; the worker's worktree, branch and pinned result stay for another try.
        return logs
      } else {
        logs.push(`[merge] Failed for ${agent.branch}: ${result.error}`)
        // A non-conflict Git failure can be transient (locked index, hook failure, etc.).
        // Keep the branch eligible for complete_task retry instead of classifying the
        // worker as failed and silently excluding its surviving commit.
        this.agents.updateStatus(agent.id, 'ready')
        task && this.tasks.updateProgress(task.id, {
          message: `Merge failed; branch preserved for retry: ${result.error}`
        })
      }
    } else {
      // Stop without merge is cancellation — not success. Keep worktree/branch recoverable.
      this.agents.updateStatus(agent.id, 'cancelled')
      if (task) {
        this.tasks.updateStatus(task.id, 'cancelled')
        this.tasks.updateProgress(task.id, {
          message: 'Stopped without merge; worktree and branch retained.'
        })
      }
      logs.push(
        `[cancel] Marked ${agent.id.slice(0, 8)} cancelled; worktree retained at ${agent.worktreePath}`
      )
    }

    return logs
  }

  validateConversationActionRestore(threadId: string, action: import('../../shared/threadActions').ThreadAction, kind: 'undo' | 'redo'): void {
    assertConversationBoundary(action)
    const directory = this.resolveThreadDir(threadId)
    if (directory && (new ThreadWorkspaceManager(directory).load()?.conversationBranchId ?? 'main') !== action.conversationBranchId) throw new Error('Conversation recovery requires the active branch.')
    const session = this.getOrCreateSession(threadId)
    const start = action.nativeContextStartBoundary!, end = action.nativeContextBoundary
    const count = session.nativeContext.messages.length
    const desired = kind === 'undo' ? start.messageIndex : end.messageIndex
    const source = kind === 'undo' ? end.messageIndex : start.messageIndex
    if (count !== desired && count !== source || (session.nativeContext.compaction?.generation ?? 0) !== start.compactionGeneration || session.messages.length !== action.presentationMessageEnd || session.messages.slice(action.presentationMessageStart, action.presentationMessageEnd).some((message) => message.turnId !== action.turnId)) throw new Error('Conversation context no longer matches the recorded turn boundary.')
    if (kind === 'redo' && end.messageIndex - count > (session.nativeContext.retiredMessages?.length ?? 0)) throw new Error('Conversation redo context archive is incomplete.')
  }

  /** Rewind the visible/model lineage after conversation undo without erasing audit events. */
  restoreConversationBoundary(
    threadId: string,
    presentationMessageStart: number,
    boundary: NativeContextBoundary
  ): void {
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning()) throw new Error('Cannot restore conversation context while a turn is running.')
    this.sessionAls.run(session, () => {
      const undoneTurns = new Set<string>()
      for (let index = Math.max(0, presentationMessageStart); index < session.messages.length; index += 1) {
        const turnId = session.messages[index].turnId
        if (turnId) undoneTurns.add(turnId)
        session.messages[index] = {
          ...session.messages[index],
          hiddenBeforeUndo: session.messages[index].hiddenBeforeUndo ?? session.messages[index].hidden === true,
          hidden: true
        }
      }
      // The answers of the undone turns are no longer part of the conversation: what a waiter could read of
      // them goes too (the audit events stay).
      try {
        if (this.runEngine && undoneTurns.size) deleteRunResults(this.runEngine.store, threadId, [...undoneTurns])
      } catch (error) {
        console.warn('the kept answers of an undone turn could not be removed', { threadId, error: error instanceof Error ? error.message : String(error) })
      }
      const cut = Math.max(0, Math.min(boundary.messageIndex, session.nativeContext.messages.length))
      const removed = session.nativeContext.messages.slice(cut)
      session.nativeContext = {
        ...session.nativeContext,
        version: 2,
        messages: session.nativeContext.messages.slice(0, cut),
        retiredMessages: [
          ...(session.nativeContext.retiredMessages ?? []),
          ...removed
        ],
        activeStartIndex: Math.max(0, Math.min(boundary.activeStartIndex ?? 0, cut)),
        revision: (session.nativeContext.revision ?? 0) + 1,
        compaction: boundary.compaction ? structuredClone(boundary.compaction) : undefined,
        acceptedQueueItemIds: structuredClone(boundary.acceptedQueueItemIds ?? []),
        acceptedSteerItemIds: structuredClone(boundary.acceptedSteerItemIds ?? []),
        lastTurnUsage: undefined
      }
      this.persist(true)
      this.emitThreadMessages(threadId, session.messages, true)
    })
  }

  restoreConversationActionEnd(
    threadId: string,
    presentationMessageStart: number,
    presentationMessageEnd: number,
    boundary: NativeContextBoundary
  ): void {
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning()) throw new Error('Cannot redo conversation context while a turn is running.')
    const needed = Math.max(0, boundary.messageIndex - session.nativeContext.messages.length)
    const retired = session.nativeContext.retiredMessages ?? []
    if (needed > retired.length) throw new Error('Conversation redo context archive is incomplete.')
    this.sessionAls.run(session, () => {
      for (
        let index = Math.max(0, presentationMessageStart);
        index < Math.min(presentationMessageEnd, session.messages.length);
        index += 1
      ) {
        if (!('hiddenBeforeUndo' in session.messages[index])) continue
        const { hiddenBeforeUndo, ...message } = session.messages[index]
        session.messages[index] = {
          ...message,
          hidden: hiddenBeforeUndo ? true : undefined
        }
      }
      const restored = needed > 0 ? retired.slice(-needed) : []
      session.nativeContext = {
        ...session.nativeContext,
        messages: [...session.nativeContext.messages, ...structuredClone(restored)],
        retiredMessages: needed > 0 ? retired.slice(0, -needed) : retired,
        activeStartIndex: Math.max(0, Math.min(boundary.activeStartIndex ?? 0, boundary.messageIndex)),
        revision: (session.nativeContext.revision ?? 0) + 1,
        compaction: boundary.compaction ? structuredClone(boundary.compaction) : undefined,
        acceptedQueueItemIds: structuredClone(boundary.acceptedQueueItemIds ?? []),
        acceptedSteerItemIds: structuredClone(boundary.acceptedSteerItemIds ?? []),
        lastTurnUsage: undefined
      }
      this.persist(true)
      this.emitThreadMessages(threadId, session.messages, true)
    })
  }

  replaceConversationState(
    threadId: string,
    messages: ChatMessage[],
    nativeContext: NativeLlmContext
  ): void {
    const session = this.getOrCreateSession(threadId)
    if (session.isTurnRunning()) throw new Error('Cannot activate a conversation branch while a turn is running.')
    this.sessionAls.run(session, () => {
      session.messages = structuredClone(messages)
      session.nativeContext = normalizeNativeContext(nativeContext)
      this.persist(true)
      this.emitThreadMessages(threadId, session.messages, true)
    })
  }

  getActiveAgents(): Agent[] {
    return this.agents.list().filter((a) => a.status === 'running' || a.status === 'starting')
  }

  async runIsolatedScheduledJob(
    prompt: string,
    ingress?: ScheduledJobIngress
  ): Promise<BackgroundWorkflowTurnResult> {
    return this.lifecycle.run('scheduled-turn', () => this.runIsolatedScheduledJobOwned(prompt, ingress))
  }

  private async runIsolatedScheduledJobOwned(prompt: string, ingress?: ScheduledJobIngress): Promise<BackgroundWorkflowTurnResult> {
    try {
      const workflow = prompt.startsWith('/') && ingress
        ? await this.admitBackgroundWorkflowTurn({
            content: prompt,
            source: 'schedule',
            requestId: scheduleWorkflowInvocationId(ingress),
            threadId: this.resolveScheduledWorkflowThread(ingress),
            signal: this.lifecycle.signal,
            terminalOnly: ingress.resumeWaiting === true,
            onWorkflowPrepared: ingress.onWorkflowPrepared
          })
        : null
      if (workflow) return workflow
      if (!ingress) return { text: '', silent: false, error: 'A scheduled run needs its job' }
      return await this.runScheduledTurn(prompt, ingress)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { text: '', silent: false, error: message }
    }
  }

  /**
   * The thread a scheduled occurrence runs on: the one its claim already chose (a retry), the job's own
   * thread, the owner of the job's existing worktree, else a new per-run thread. A bound job runs in its
   * thread's own workspace; a per-run thread works on the project's checkout unless the job asks for a new worktree.
   */
  private chooseScheduledThread(ingress: ScheduledJobIngress): { threadId: string; created: boolean } {
    const store = this.threadStore
    if (!store) throw new Error('Scheduled turns need the thread store')
    const usable = (id?: string): string | undefined => {
      const thread = id ? store.getThread(id) : undefined
      return thread && !thread.settledAt ? thread.id : undefined
    }
    const existing = usable(ingress.claim?.threadId) ?? usable(ingress.threadId)
    // The project and the requested worktree are checked now, for a saved thread as much as for a new one:
    // a removed project can leave its threads readable, and a worktree can change hands.
    const projectId = ingress.projectId ?? (existing ? store.getThread(existing)?.projectId : undefined)
    const projectPath = projectId ? this.projectManager?.getProject(projectId)?.path : undefined
    // A removed project fails the run; it must not quietly become a run with no project.
    if (projectId && !projectPath) throw new Error('The job\'s project no longer exists: ' + projectId)
    if (ingress.workspace?.kind === 'worktree') {
      if (!projectId) throw new Error('A job that runs in an existing worktree needs a project')
      const owner = findWorktreeOwner(
        store.listAllThreads().filter((thread) => thread.projectId === projectId),
        ingress.workspace.path,
        (threadId) => new ThreadWorkspaceManager(store.getThreadDir(threadId)).load()
      )
      if (!owner) throw new Error('No thread owns a ready worktree at ' + ingress.workspace.path + ' any more')
      if (existing && existing !== owner.id) throw new Error('The thread this job runs on no longer owns the worktree at ' + ingress.workspace.path)
      return { threadId: owner.id, created: false }
    }
    if (existing) return { threadId: existing, created: false }
    if (ingress.threadId) throw new Error('Scheduled thread is unavailable')
    // Only a new worktree per run is a resource that piles up; a run on the project's checkout settles its thread when it ends.
    if (ingress.workspace?.kind === 'newWorktree') {
      const open = store.listAllThreads().filter((thread) => thread.scheduledJobId === ingress.jobId && !thread.settledAt).length
      if (open >= MAX_OPEN_SCHEDULED_THREADS) {
        throw new Error(`Job has ${MAX_OPEN_SCHEDULED_THREADS} open per-run worktree threads; settle or delete some, or bind the job to a thread.`)
      }
    }
    // The resolver runs a non-Git project on its own checkout; a job that asked for a new worktree must not.
    if (ingress.workspace?.kind === 'newWorktree' && projectPath) {
      let gitBacked = false
      try {
        gitBacked = new ThreadWorkspaceManager('').resolveRepository(projectPath).capability.gitBacked
      } catch {
        // Not a repository the checkout code understands.
      }
      if (!gitBacked) throw new Error('The job asks for a new worktree, but the project is no longer backed by a Git repository')
    }
    const thread = store.createThread('Scheduled: ' + (ingress.jobName ?? 'job'), ingress.projectId, projectPath, {
      ...(ingress.selection ? { modelOverride: ingress.selection } : {}),
      scheduledJobId: ingress.jobId,
      // What agents in this thread may reach, fixed like a channel thread's: the job creator's level, `lineage` when unknown.
      accessCeiling: this.scheduledAccessCap(ingress.accessCap),
      ...(ingress.projectId && ingress.workspace?.kind !== 'newWorktree' ? { workspaceBinding: { policy: 'primary' as const } } : {})
    })
    return { threadId: thread.id, created: true }
  }

  /**
   * Runs a plain-prompt occurrence as a turn on its thread, through the same admission as any send: the
   * run is durable first (`schedule:<job>:<occurrence>` makes the dispatch idempotent), then it runs now when
   * the thread is idle or waits as one queue item when it is not. Called inside `runIsolatedScheduledJob`'s
   * lifecycle hold, so it uses `sendOwned`: past its claim, an occurrence is fenced by the scheduler's
   * shutdown, not refused as `profile_draining`.
   */
  private async runScheduledTurn(prompt: string, ingress: ScheduledJobIngress): Promise<BackgroundWorkflowTurnResult> {
    const occurrenceKey = ingress.occurrenceKey ?? ingress.occurrenceAt
    const { threadId, created } = this.chooseScheduledThread(ingress)
    let admittedRunId = ingress.claim?.runId
    const discardIfUnused = (): void => {
      if (!created || admittedRunId) return
      try { this.threadStore?.discardUnusedThread(threadId) } catch { /* it has content; it stays */ }
    }
    try {
      ingress.onThreadChosen?.(threadId)
    } catch (error) {
      discardIfUnused()
      throw error
    }
    const selection = ingress.selection
    // The stricter of the job's mode and its ceiling (nothing when the job has neither). The turn builder narrows
    // it by the thread's own mode and lineage, on the direct, queued and recovered paths alike, so it only tightens.
    const permissionMode = jobPermissionRequest(ingress)
    const schedule = { jobId: ingress.jobId, occurrenceKey, ...(ingress.jobName ? { jobName: ingress.jobName } : {}) }
    let response: OrchestratorResponse
    try {
      response = await this.sendOwned({ content: prompt, mode: ingress.mode ?? 'agent' }, false, {
        threadId,
        source: 'schedule',
        clientRequestId: scheduledReceiptId(ingress.jobId, occurrenceKey),
        modelOverride: selection,
        ...(permissionMode ? { permissionMode } : {}),
        origin: 'schedule',
        preemptQuestions: false,
        queueOrigin: { kind: 'schedule', jobId: ingress.jobId, occurrenceKey, ...(ingress.jobName ? { jobName: ingress.jobName } : {}), ...(selection ? { selection } : {}) },
        schedule,
        onAdmitted: (runId) => {
          admittedRunId = runId
          // Recorded on the run before anything starts (only ever narrower); a run with none is granted `lineage`.
          try {
            this.runEngine?.recordAccessGrant(runId, this.scheduledAccessCap(ingress.accessCap))
          } catch (error) {
            logDebug('OrchestratorService', 'scheduled access cap could not be recorded', error, { runId })
          }
          ingress.onAdmitted?.(runId)
        },
        awaitMode: 'turn'
      })
    } catch (error) {
      discardIfUnused()
      return { text: '', silent: false, error: error instanceof Error ? error.message : String(error), threadId, ...(admittedRunId ? { runId: admittedRunId } : {}), transcriptWritten: true }
    }
    const runId = response.runId
    const bound = runId ? this.runEngine?.bindingForRun(runId) : undefined
    const base = {
      threadId,
      ...(runId ? { runId } : {}),
      ...(bound ? { selection: { ...this.harness.selectionOf(bound) } } : {}),
      ...(bound?.policy.permissionMode ? { permissionMode: bound.policy.permissionMode } : {}),
      transcriptWritten: true
    }
    if (response.replayed) return { ...base, text: '', silent: false, status: 'replayed' }
    if (response.queued) return { ...base, text: '', silent: false, status: 'queued', ...(response.queueItem ? { queueItemId: response.queueItem.id } : {}) }
    const text = response.message?.trim() || 'Done.'
    const silent = text === '[SILENT]' || text.startsWith('[SILENT]')
    return { ...base, text, silent }
  }

  async runChannelTurn(
    threadId: string,
    content: string,
    threadStore: ThreadDataStore,
    opts?: {
      modelOverride?: ModelOverride
      signal?: AbortSignal
      drainSteer?: () => string | undefined
      hostIngress?: ChannelWorkflowHostIngress
      /** Remote sends choose a mode and attach images; channel turns run in agent mode without images. */
      mode?: ChatMode
      images?: ChatImageAttachment[]
      /** Called once the user's message is stored on the thread; not called if the turn never starts. */
      onUserInputAccepted?: () => void
      /** Channel turns pass `never` (`CHANNEL_POLICY`): nobody in a channel answers a tool approval. */
      approvals?: RunPolicy['approvals']
    }
  ): Promise<BackgroundWorkflowTurnResult> {
    return this.lifecycle.run('channel-turn', () => this.runChannelTurnOwned(threadId, content, threadStore, opts))
  }

  private async runChannelTurnOwned(
    threadId: string,
    content: string,
    threadStore: ThreadDataStore,
    opts?: {
      modelOverride?: ModelOverride
      signal?: AbortSignal
      drainSteer?: () => string | undefined
      hostIngress?: ChannelWorkflowHostIngress
      /** Remote sends choose a mode and attach images; channel turns run in agent mode without images. */
      mode?: ChatMode
      images?: ChatImageAttachment[]
      /** Called once the user's message is stored on the thread; not called if the turn never starts. */
      onUserInputAccepted?: () => void
      /** Channel turns pass `never` (`CHANNEL_POLICY`): nobody in a channel answers a tool approval. */
      approvals?: RunPolicy['approvals']
    }
  ): Promise<BackgroundWorkflowTurnResult> {
    // The turn registers itself only when the caller passes no signal. Production callers (ChannelRouter and the
    // remote MmsBackend) always pass one, so this path runs only for callers without one (today, tests).
    const ownedTurn = !opts?.signal
    const channelTurn: { abort: AbortController; pendingSteer: SteerEntry[]; runId?: string } | null = ownedTurn
      ? { abort: new AbortController(), pendingSteer: [] }
      : null
    if (channelTurn) this.channelTurns.set(threadId, channelTurn)

    const signal = AbortSignal.any([opts?.signal ?? channelTurn!.abort.signal, this.lifecycle.signal])
    let lease: ThreadLeaseHandle | null = null
    // Session admitted by this channel turn until it hands admission to runTurnOnSession.
    let admittedSession: ThreadSession | null = null

    try {
      if (!threadStore.getThread(threadId)) {
        return { text: '', silent: false, error: `Thread not found: ${threadId}` }
      }
      // A chat bound to a bot's thread (`/threads`) never writes into it: only the bot's own
      // dispatches run there, and a channel reaches the bot through `/bot` (PR 6 §6).
      const botRefusal = this.botThreadRefusal(threadId)
      if (botRefusal) return { text: '', silent: false, error: botRefusal.message }
      // A person outside Mousse drives this thread (a paired chat user, a webhook caller): agents in it
      // reach no other thread through the profile's setting, now or in any later turn, and what they
      // delegate inherits the limit (SPEC §15.1).
      try {
        threadStore.capAccessCeiling(threadId, 'lineage')
      } catch (error) {
        return { text: '', silent: false, error: error instanceof Error ? error.message : String(error) }
      }

      try {
        lease = await waitAcquireExecutionLease(threadStore.getThreadDir(threadId), {
          source: 'channel',
          signal,
          maxAttempts: 240,
          retryDelayMs: 50
        })
      } catch (err) {
        if (signal.aborted || (err instanceof Error && /abort/i.test(err.message))) {
          return { text: '', silent: true, aborted: true }
        }
        return {
          text: '',
          silent: false,
          error: err instanceof Error ? err.message : String(err)
        }
      }

      // Hydrate the canonical live session after acquiring the cross-process lease.
      // This refreshes a GUI session that may have been opened before a channel/CLI write.
      const data = threadStore.loadThreadData(threadId)
      const session = this.getOrCreateSession(threadId)
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue,
        data.agents,
        data.tasks,
        opts?.modelOverride ?? threadStore.getThread(threadId)?.modelOverride
      )
      this.closeStaleActivity(session)
      try {
        const projectPath = this.projectManager
          ? resolveThreadProjectPath(this.projectManager, threadStore, threadId)
          : undefined
        session.projectCwd = projectPath ? resolveProjectWorkingDirectory(projectPath) : null
      } catch {
        session.projectCwd = null
      }
      this.emitThreadMessages(threadId, session.messages)

      // Admit before the workflow/admission awaits below so a concurrent send queues instead of
      // starting a second turn on this session (its own lease token is excluded from the external-lease check).
      if (session.turnAdmitted) {
        return { text: '', silent: false, error: `Thread already has a running turn: ${threadId}` }
      }
      session.turnAdmitted = true
      admittedSession = session
      // Transfer lease ownership to the regular turn path so every exit releases it.
      session.executionLease = lease
      lease = null
      const hostRequestId = opts?.hostIngress ? channelWorkflowInvocationId(opts.hostIngress) : undefined
      const workflow = await this.admitBackgroundWorkflowTurn({
        content,
        source: 'channel',
        requestId: hostRequestId,
        threadId,
        signal,
        session,
        admissionHeld: true,
        onAdmissionHandedOff: () => { admittedSession = null },
        onUserInputAccepted: opts?.onUserInputAccepted
      })
      if (workflow) {
        this.releaseSessionExecutionLease(session)
        return workflow
      }
      let wasAborted = false
      const runId = await this.recordChannelRun(threadId)
      if (channelTurn) channelTurn.runId = runId
      admittedSession = null
      const result = await this.runTurnOnSession(
        session,
        { content, mode: opts?.mode ?? 'agent', ...(opts?.images?.length ? { images: opts.images } : {}) },
        false,
        true,
        {
          admissionHeld: true,
          suppressAutoQueueDrain: true,
          externalSignal: signal,
          runId,
          externalDrainSteer: opts?.drainSteer ?? (channelTurn
            ? () => {
                if (channelTurn.pendingSteer.length === 0) return undefined
                // Entries, so a promoted item keeps its id through the drain, a return and the turn's end.
                const steers = channelTurn.pendingSteer
                channelTurn.pendingSteer = []
                return steers
              }
            : undefined),
          modelOverride: opts?.modelOverride,
          onUserInputAccepted: opts?.onUserInputAccepted,
          ...(opts?.approvals ? { approvals: opts.approvals } : {}),
          onTurnSettled: (aborted) => {
            wasAborted = aborted
            try {
              mutateDurableQueue(threadStore, threadId, (disk) => demoteSteerItems(disk))
            } catch {
              // Best-effort while this turn still owns the execution lease.
            }
          }
        }
      )

      if (wasAborted || signal.aborted) {
        return { text: '', silent: true, aborted: true }
      }

      const text = result.message
      const silent = text.trim() === '[SILENT]' || text.trimStart().startsWith('[SILENT]')
      return { text, silent }
    } catch (err) {
      const isAbort =
        signal.aborted ||
        channelTurn?.abort.signal.aborted ||
        (err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message)))
      if (isAbort) return { text: '', silent: true, aborted: true }
      return { text: '', silent: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      // A later channel turn on this thread may have registered itself while this one ran (it waits for the
      // lease): only this turn's own entry is removed.
      if (channelTurn && this.channelTurns.get(threadId) === channelTurn) this.channelTurns.delete(threadId)
      if (lease) releaseExecutionLeaseHandle(lease)
      if (admittedSession) {
        this.releaseSessionExecutionLease(admittedSession)
        admittedSession.turnAdmitted = false
        admittedSession.admissionRunId = undefined
        admittedSession.abortRequested = false
      }
    }
  }

  private resolveScheduledWorkflowThread(ingress: ScheduledJobIngress): string {
    if (!this.threadStore) throw new Error('Scheduled workflow thread store is unavailable')
    if (ingress.threadId) {
      const thread = this.threadStore.getThread(ingress.threadId)
      if (!thread || thread.settledAt) throw new Error('Scheduled workflow thread is unavailable')
      return thread.id
    }
    return this.threadStore.ensureExecutionThread(
      'schedule:' + ingress.jobId + ':' + ingress.occurrenceAt,
      ('Scheduled: ' + (ingress.jobName ?? 'workflow')).slice(0, 120),
      ingress.projectId
    ).id
  }

  /**
   * Pin and admit a slash workflow through the same durable chat receipt as GUI/CLI.
   * Observation happens after the thread execution lease is released.
   */
  private async admitBackgroundWorkflowTurn(input: {
    content: string
    source: 'channel' | 'schedule'
    requestId?: string
    threadId?: string
    signal: AbortSignal
    session?: ThreadSession
    terminalOnly?: boolean
    onWorkflowPrepared?: (invocationId: string) => void
    /** The caller already admitted `session`; ownership passes to the workflow turn via onAdmissionHandedOff. */
    admissionHeld?: boolean
    onAdmissionHandedOff?: () => void
    /** Called once the workflow command is stored on the thread. */
    onUserInputAccepted?: () => void
  }): Promise<BackgroundWorkflowTurnResult | null> {
    if (!this.workflowChat || !input.content.startsWith('/') || !input.threadId) return null
    let prepared
    try {
      prepared = await this.workflowChat.prepare(input.threadId, { content: input.content, requestId: input.requestId }, input.source)
    } catch (error) {
      if (error instanceof DomainRpcError) return { text: '', silent: false, error: error.message }
      throw error
    }
    if (!prepared.workflowInvocationId) return null
    input.onWorkflowPrepared?.(prepared.workflowInvocationId)
    if (!this.threadStore) return { text: '', silent: false, error: 'Workflow thread store is unavailable' }
    const session = input.session ?? this.getOrCreateSession(input.threadId)
    let observed: ReturnType<WorkflowChatExecutor['observe']> | undefined
    try {
      input.onAdmissionHandedOff?.()
      const response = await this.runTurnOnSession(
        session,
        { content: prepared.content, workflowInvocationId: prepared.workflowInvocationId },
        false,
        true,
        {
          suppressAutoQueueDrain: true,
          externalSignal: input.signal,
          admissionHeld: input.admissionHeld,
          onUserInputAccepted: input.onUserInputAccepted
        }
      )
      if (!response.workflowRun) return { text: response.message, silent: false, transcriptWritten: true }
      this.releaseSessionExecutionLease(session)
      observed = this.workflowChat.observe(response.workflowRun, input.signal, input.terminalOnly)
      const { snapshot, aborted } = await observed
      const run = { ...response.workflowRun, state: snapshot.manifest.state }
      const text = formatBackgroundWorkflowDelivery(run, snapshot)
      await this.persistBackgroundWorkflowObservation(session, run, text)
      if (aborted || input.signal.aborted) {
        return { text, silent: true, aborted: true, waiting: isBackgroundWorkflowWaiting(run.state), transcriptWritten: true }
      }
      return {
        text,
        silent: false,
        waiting: isBackgroundWorkflowWaiting(run.state),
        transcriptWritten: true
      }
    } catch (error) {
      const aborted = input.signal.aborted || (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)))
      if (aborted) return { text: '', silent: true, aborted: true, transcriptWritten: true }
      if (error instanceof DomainRpcError) return { text: '', silent: false, error: error.message }
      throw error
    } finally {
      if (observed) await observed.catch(() => undefined)
    }
  }

  private async persistBackgroundWorkflowObservation(
    session: ThreadSession,
    run: WorkflowChatRun,
    text: string
  ): Promise<void> {
    if (!this.threadStore || session.threadId === '__unbound__') return
    const thread = this.threadStore.getThread(session.threadId)
    if (!thread) return
    const lease = await waitAcquireExecutionLease(this.threadStore.getThreadDir(session.threadId), {
      source: 'workflow-observer',
      signal: this.lifecycle.signal,
      maxAttempts: 240,
      retryDelayMs: 50
    })
    try {
      const data = this.threadStore.loadThreadData(session.threadId)
      session.load(
        data.messages,
        data.llmContext ?? migrateLegacyContext(data.messages),
        data.messageQueue,
        data.agents,
        data.tasks,
        thread.modelOverride
      )
      this.closeStaleActivity(session)
      const message = [...session.messages].reverse().find(
        (entry) => entry.role === 'assistant' && entry.workflowRun?.runId === run.runId
      )
      if (!message) return
      message.content = text
      message.workflowRun = run
      this.sessionAls.run(session, () => this.persist(true))
    } finally {
      releaseExecutionLeaseHandle(lease)
    }
  }
}
