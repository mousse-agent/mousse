import { repositoryIdentitiesFor } from '../bridge/remote/repositoryIdentity'
import { expiryRefusal, isThreadExpired } from '../../shared/threadExpiry'
import { assertWorktreeFolderConnected, chosenFolderHolding, WorktreeFolderRefused } from '../worktree/worktreeLayout'
import { listKeptWorktrees } from '../lifecycle/keptWorktrees'
import { chooseWorktreeFolder, recordedWorktreePaths, worktreeFolderStatus } from '../worktree/worktreeFolderSetting'
import { userAction, withGitAccess, withUserRequest, type UserAction } from '../git/gitPolicy'
import { gitAccessOf, USER_REQUEST_LABELS } from './gitAccess'
import { projectIconFor, readIconFile, resolveStoredIconPath } from '../data/projectIcon'
import type { ProjectIconChoice } from '../../shared/projectIcon'
import type { StorageCleanupPlanToken } from '../../shared/storage'
import { validateAppletAppearance } from '../../shared/appletAppearance'
import { appletJsonBytes, APPLET_STATE_LIMIT } from '../../shared/applets'
import { ConversationActionService } from '../actions/ConversationActionService'
import { assertHeldThreadLease, withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { tryAcquireExecutionLease, heartbeatExecutionLease, releaseExecutionLeaseHandle, getExecutionLeasePath, leaseBusyMessage, readLeaseOwner } from '../queue/ThreadExecutionLease'
import { clearCleanupMarker, readCleanupMarker } from '../lifecycle/StorageCleanupService'
import { enableVersionedLifecycleWriter, withThreadLifecyclePath } from '../queue/ThreadLifecycleAdmission'
import { ThreadTerminalWriters } from '../terminals/threadTerminalWriter'
import { assertEpisodePath } from '../agents/WorkspaceAccessPolicy'
import { describePermissionMode, isPermissionMode, isStricter, narrowPermissionMode, PERMISSION_MODES, type PermissionMode } from '../../shared/permissionMode'
import type { Answerer } from '../run/approvalRights'
import { buildResourceInventory } from '../lifecycle/ResourceInventory'
import { assertLifecyclePath } from '../lifecycle/ResourceLifecycleStore'
import { ARCHIVE_BEFORE_DELETE } from '../lifecycle/threadDelete'
/**
 * Method handlers against daemon-owned MousseMainService.
 * All nested mutable payloads are validated before service calls.
 */

import type { MmsProfileServices } from '../MmsProfileServices'
import { LocalActionGated, type CommandResult } from '../run/RunEngine'
import { canUndoNatively } from '../run/policy/featureGates'
import type { RunOutcome } from '../run/types'
import { CommandRejection } from '../run/db/RunStoreError'
import { EFFECT_PAGE_MAX } from '../run/EffectOutbox'
import { evaluateRestore, restoreDiff, restoreDiffSha, worktreeClaims, type WorkspaceClaim } from '../run/workspace/restoreSafety'
import { PROVIDER_STT_MAX_BYTES } from '../../shared/dictation'
import { PROVIDER_TTS_MAX_CHARS } from '../../shared/readAloud'
import type { ExternalEffect, ThreadAction } from '../../shared/threadActions'
import type { ThreadWorkspaceMetadata } from '../../shared/workspace'
import { relinked, sameLinkedPullRequest, type GitPullRequestInfo, type PullRequestDetail, type PullRequestMergeMethod, type PullRequestPushTarget, type PullRequestWatchMode, type RepositoryIdentity, type ThreadPullRequestLink } from '../../shared/pullRequests'
import { PULL_REQUEST_EXISTS, PullRequestReadError } from '../git/GitHubCodeHost'
import { PullRequestThreadError, PullRequestThreadService } from '../git/PullRequestThreadService'
import { PullRequestWatchError } from '../git/PullRequestWatchService'
import type { ChatMessage, FileGrepResponse, FileSearchResponse, GitChangesResult, GitCommitSelection, GitIncludeRequest, GitRestoreRevertedResult, GitOperationKind, GitOperationOptions, GitPullStrategy, GitStatusSnapshot, NativeLlmContext, OrchestratorSendInput, OrchestratorSendRequest, ScheduledJob, ScheduledSettings, ScheduledThreadEventTrigger, Thread, ThreadEventKind, ThreadSearchResult } from '../../shared/types'
import { privateThreadOf } from '../automations/sharedAutomations'
import { AGENT_JOB_LIMIT_RANGES, AGENT_JOB_LIMIT_SETTINGS, type AgentJobLimitKey } from '../../shared/agentJobLimits'
import type { MousseConfigStore } from '../config/MousseConfigStore'
import type { ScheduledConfigSection } from '../config/types'
import { AppError, createErrorProvider, knownAppError } from '../../shared/errors'
import type { DiscardedCopy, GitOperationHandle } from '../git/GitService'
import { listClaimedQueue, QueueConflictError, QueueValidationError } from '../queue/ThreadMessageQueue'
import { describeQuestionAnswers, formatQuestionAnswersMessage, formatQuestionDismissMessage } from '../orchestrator/OrchestratorService'
import { withoutStandingRules } from '../orchestrator/UserQuestionService'
import type { ModelOverride } from '../../shared/providerInstances'
import {
  ACCENT_COLORS,
  THEME_OPTIONS,
  botProviderOptions,
  buildAgentTypesFromCatalogs,
  lastUsedChatModel,
  type MousseSettingsUpdate
} from '../../shared/settings'
import type { HarnessGateway } from '../harness/gateway'
import { usageText } from '../providers/usageText'
import { harnessAppError } from '../../shared/harness/types'
import {
  asAddInstanceInput,
  asAfterSequence,
  asAnswersMap,
  asEnabledForScope,
  asInstanceConfigPatch,
  asInstanceId,
  asModelPrefsPatch,
  asProviderScope,
  asSignInResponse,
  asBoolean,
  asCreateScheduledJobInput,
  asCursorMcpConfigPatch,
  asOptionalBoolean,
  asOptionalBoundedInt,
  asOptionalChatImages,
  asOptionalChatMode,
  asOptionalString,
  asOptionalStringEnvMap,
  asOptionalTaskStatus,
  asScheduledJobPatch,
  asScope,
  asSettingsPartial,
  asString,
  asStringArray,
  asBoundedInt,
  isObject
} from './validators'
import { PROTOCOL_CAPABILITIES, PROTOCOL_METHODS, MMS_PROTOCOL_VERSION } from './types'
import { imageAt, messagesBefore, withoutImageBytes } from './transcriptPaging'
import { ROUTED_MESSAGES_PAGE_BYTES } from '../../shared/bridge/routed'
import { buildSubagentView } from '../run/delegation/subagentView'
import { connectionIsLocal, listedProjectsFor, listedThreadsFor } from './threadVisibility'
import { localOnlyThreadIds, threadFolderIsLocalOnly } from '../data/localOnlyThreads'
import { threadFolderExpired } from '../data/expiredThreads'
import { isLocalOnlyThread } from '../../shared/threadLineage'
import { isQualifiedId, parseQualifiedId } from '../../shared/threadRef'
import { resolveThreadProjectPath } from '../data/resolveActiveProjectPath'
import { ThreadJournal } from '../data/ThreadJournal'
import { PROJECT_FOLDER_PUBLISH_REASON, PROJECT_FOLDER_REASON, threadPlacement } from '../workspace/threadPlacement'
import { isProjectFolderWorkspace, ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { clearStaleLeftMerges, liveCheckpointTest, recoveryErrorText, threadRecovery } from '../workspace/workspaceRecovery'
import { resolveEditorFolder } from '../workspace/editorFolder'
import type { NodeId } from '../../shared/net/ids'
import { scheduledJobOptionsDepsFrom, validateScheduledJobOptions, type ScheduledJobOptionsDeps } from '../scheduled/validateJobOptions'
import { isExecutableJobEdit, jobPermissionRequest, JobPermissionRefused, permissionAboveCeiling, permissionsAfterEdit } from '../scheduled/jobPermission'
import { ScheduledWebhookError } from '../scheduled/ScheduledJobService'
import { runNowRefusal } from '../scheduled/runNowRefusal'
import { computeNextRun } from '../scheduled/computeNextRun'
import { BotScheduleError } from '../scheduled/botJobs'
import { ActionExecutionError, StaleThreadActionRevisionError, ThreadActionService, type RunThreadActionOptions } from '../actions/ThreadActionService'
import { UndoService } from '../actions/UndoService'
import { UndoRetentionService } from '../actions/UndoRetentionService'
import { ReceiptRefReleaseService } from '../actions/ReceiptRefReleaseService'
import { releaseSnapshotRefs } from '../actions/SnapshotRefReleaseService'
import { inThreadSnapshotScopeAsync, snapshotsOffReason } from '../workspace/SnapshotWorkspace'
import { RedoService } from '../actions/RedoService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { ConversationBranchService, FIRST_BRANCH_ID } from '../actions/ConversationBranchService'
import { discardPendingChangesAsync, gitAsync as workspaceGitAsync } from '../actions/git'
import { IndexLockedError, leftAsItIsText } from '../actions/provenDiscard'
import { getMousseHomeDir } from '../data/paths'
import { abortKeptNotice, keepCopy, keepExistingCommit, KeepCopyRefusedError, keptCopyNotice, keptCopyWindowMs, projectKeptFilesOwner, registerProjectKeptFilesFolder, type KeptCopy } from '../actions/keptCopies'
import { takeSnapshotAsync } from '../actions/snapshots'
import { randomUUID } from 'node:crypto'
import { ManagedConflictService } from '../actions/ManagedConflictService'
import { cancelPendingIntegrations } from '../agents/ChildAgentIntegrationService'
import { ChangeReceiptService } from '../actions/ChangeReceiptService'
import { PublishService } from '../actions/PublishService'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { lexicalGuard, type GuardedPath, type PathGuard, type PathIntent } from '../files/pathGuard'
import { PathContainmentError, routedGuardFor } from '../files/routedGuard'
import { ROUTED_STAGE_ITEM_BYTES } from '../../shared/bridge/routed'
import { grepWorkspace } from '../files/WorkspaceGrep'
import { getWorkspaceIndexRegistry } from '../files/WorkspaceIndexRegistry'
import { searchWorkspacePaths } from '../files/WorkspaceSearch'
import { devGuiBridge } from '../devgui/DevGuiBridge'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { access, realpath as realpathNative } from 'node:fs/promises'
import { FILE_ASSET_PIECE_BYTES, SAVE_TOO_LARGE_MESSAGE, saveExceedsRequest } from '../../shared/fileAssets'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { clearMarker, type SelectionPlace } from '../git/gitSelection'
import { FolderNotAnsweringError, waitForFolderAccess } from '../files/folderAccess'
import { listFilesPlaces } from '../files/drives'
import { browsedRootRefusal, browsedSaveRefusal, normalizedBrowsedRoot } from '../files/browsedRoot'
import type { DomainConnectionContext } from './domainRegistry'
import { DomainRpcError } from './domainRegistry'
import { keepAccount, keepUsage, steadyAccount, steadyUsage, unreachableUsage, usageSlots, withUsageDeadline } from './usageReads'
import type { UsageAccount } from '../../shared/providerAuth'
import { WORKFLOW_RUN_CAPABILITY } from '../../shared/workflowRunPlatform'
import { isInstallationMethod } from '../profiles/admission'
import { ChatReferenceMetadataResolver } from '../data/resolveChatReferenceMetadata'
import { parseChatReference } from '../../shared/chatReferences'
import type { ReviewFilesResult, ReviewRange, ReviewScope } from '../../shared/review'
import { repoRelativePaths } from '../git/repoPaths'
import { isGitRepository, listChangedFiles, readFileVersions, worktreeRange } from '../git/reviewDiff'
import { resolveReviewScope } from '../actions/reviewRange'

/** The Claude subscription's id on the usage page. */
const CLAUDE_USAGE_ID = 'claude-subscription'

/** The writer holds of open terminals, one per thread and caller (`pty.create`). */
const threadTerminalWriters = new ThreadTerminalWriters()

export interface HandlerContext {
  mms: MmsProfileServices
  /** Trusted local-protocol admission context; absent on legacy internal calls. */
  connection?: DomainConnectionContext
  /** Fenced owner token from protocol server (never from untrusted params). */
  ownerToken?: string
  globalSequence: () => number
  /** Optional: push a protocol event while a handler is running (e.g. auth prompts). */
  emitEvent?: (type: string, data: unknown, threadId?: string) => void
}

/** A map keyed by thread id, without private threads unless the caller is on this computer. */
function withoutLocalOnlyKeys<T>(ctx: HandlerContext, byThread: Record<string, T>): Record<string, T> {
  if (connectionIsLocal(ctx.connection)) return byThread
  const hidden = localOnlyThreadIds(ctx.mms.threads.listAllThreads())
  if (!hidden.size) return byThread
  return Object.fromEntries(Object.entries(byThread).filter(([threadId]) => !hidden.has(threadId)))
}

/**
 * A person at a Mousse window on this computer, or at another of the user's computers (a routed
 * call). Both are the user acting for themselves; the second keeps its computer in `bridgeCaller`.
 */
function isPerson(connection: HandlerContext['connection']): boolean {
  return connection?.clientType === 'gui' || connection?.clientType === 'bridge'
}

/** Browser authority uses the authenticated ingress, never a caller's source label. */
function admittedChatSource(ctx: HandlerContext, fallback: string): string {
  if (!ctx.connection) return fallback === 'gui' || fallback === 'cli' ? 'internal' : fallback
  // A person on another computer sends as a person (`gui`); the computer is kept in `sentFrom`.
  return isPerson(ctx.connection) ? 'gui' : ctx.connection.clientType === 'cli' ? 'cli' : 'internal'
}

/**
 * The most a routed caller's device may run a turn or a rule in, from this computer's policy for it;
 * undefined for every other caller.
 */
function deviceLimit(ctx: HandlerContext): PermissionMode | undefined {
  return ctx.connection?.bridgeCaller?.maxPermissionMode
}

/** The computer a routed call came from, for messages it sends. */
function sentFromOf(ctx: HandlerContext): { node: string } | undefined {
  const caller = ctx.connection?.bridgeCaller
  return caller ? { node: caller.node } : undefined
}

/** Records on the thread that its latest message came from another computer (a routed call), without moving it in the sidebar. */
function noteSentFrom(ctx: HandlerContext, threadId: string): void {
  const sentFrom = sentFromOf(ctx)
  if (!sentFrom) return
  try {
    ctx.mms.threads.updateThreadMeta(threadId, { sentFrom }, { touch: false })
  } catch {
    // The message is already queued; a note that cannot be written is not a reason to refuse it.
  }
}

/**
 * Who a protocol request answers a question as: always the user, through the client the request
 * came in on (a request with no connection of its own arrives over the Bridge). An agent answers
 * only through its own tools, which name it.
 */
function questionAnswerer(ctx: HandlerContext): Answerer {
  if (!ctx.connection) return { kind: 'user', via: 'bridge' }
  const caller = ctx.connection.bridgeCaller
  if (caller) return { kind: 'user', via: 'bridge', node: caller.node, maxPermissionMode: caller.maxPermissionMode }
  return { kind: 'user', via: ctx.connection.clientType === 'gui' ? 'gui' : ctx.connection.clientType === 'cli' ? 'cli' : 'internal' }
}

/** Messages `thread.messages` returns when the caller names no limit, and the most it will. */
const MESSAGES_PAGE_DEFAULT = 100
const MESSAGES_PAGE_MAX = 500

function isMergeMethod(value: unknown): value is PullRequestMergeMethod {
  return value === 'merge' || value === 'squash' || value === 'rebase'
}

function rejectUnknownKeys(p: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(p)) if (!allowed.includes(key)) throw new DomainRpcError('invalid_params', `${key} is not allowed`)
}

/**
 * SPEC §16.3 review confirmation: the SHA-256 of the diff the review response returned. The bare
 * `reviewed: true` of earlier versions confirmed no particular diff and is refused.
 */
function asReviewedDiffSha(p: Record<string, unknown>): string | undefined {
  if (p.reviewed !== undefined)
    throw new DomainRpcError('invalid_params', 'reviewed is replaced by reviewedDiffSha: pass the diffSha of the diff you reviewed')
  const sha = asOptionalString(p.reviewedDiffSha, 64)
  if (sha !== undefined && !/^[0-9a-f]{64}$/.test(sha)) throw new DomainRpcError('invalid_params', 'reviewedDiffSha must be a SHA-256 hex digest')
  return sha
}

/** An idempotency key, when given, is a non-empty string of at most 128 characters (SPEC §6). */
function asOptionalClientRequestId(value: unknown): string | undefined {
  const id = asOptionalString(value, 128)
  if (id !== undefined && id.length < 1) throw new DomainRpcError('invalid_params', 'clientRequestId must be a non-empty string')
  return id
}

function asOptionalSendAwaitMode(value: unknown): 'turn' | 'ack' {
  if (value === undefined) return 'turn'
  if (value === 'turn' || value === 'ack') return value
  throw new Error("await must be 'turn' or 'ack'")
}

/** Engine refusals (SPEC §16) become protocol errors whose code is the refusal reason. */
async function asRpcRejection<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof CommandRejection) throw new DomainRpcError(error.reason, error.message)
    throw error
  }
}

/**
 * A change to the queue that failed because the queue or the run is not as the caller expects (the conflict's code,
 * with the ids to read again), or because the message cannot be changed that way (a message a turn started, a workflow
 * command): the reason reaches the client instead of a generic failure.
 */
function queueRpc<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof QueueConflictError) throw new DomainRpcError(error.code, error.message, error.details)
    if (error instanceof QueueValidationError) throw new DomainRpcError('queue_change_refused', error.message)
    throw error
  }
}

/** What a restore that needs review returns instead of restoring (SPEC §16.3). */
interface RestoreReview {
  requiresReview: true
  diff: string
  /** SHA-256 of `diff`; a reviewed retry passes it back as `reviewedDiffSha`. */
  diffSha: string
  actionId?: string
}

/**
 * A visible message the person sent to start a turn. The answers to an agent's questions are stored as user messages
 * (`questionAnswers`) but shown as a step of the agent's turn, so Undo never names one as the turn's prompt.
 */
function isTurnPrompt(message: ChatMessage): boolean {
  return message.role === 'user' && !message.hidden && !message.questionAnswers?.length
}

/**
 * SPEC §16.3 restore gate for a file-restoring action: refuses (`workspace_shared`) unless the
 * thread owns its worktree and no other thread's worktree or live working directory overlaps it
 * (the other threads' workspaces are listed once per evaluation, and only when ownership holds);
 * for a provider whose capabilities are unknown, returns the diff to review with its SHA-256 and
 * appends `restore.review_required` — unless `reviewedDiffSha` names exactly the diff a restore
 * would apply now. Null: go ahead.
 */
function restoreGate(
  ctx: HandlerContext,
  input: { threadId: string; workspace: ThreadWorkspaceMetadata; target: ThreadAction | undefined; kind: 'undo' | 'revert'; reviewedDiffSha?: string }
): RestoreReview | null {
  let others: WorkspaceClaim[] | undefined
  const otherClaims = (): WorkspaceClaim[] => (others ??= [
    ...worktreeClaims(ctx.mms.threads.listAllThreads().filter((thread) => thread.id !== input.threadId).flatMap((thread) => {
      try {
        return [{ threadId: thread.id, threadDirectory: ctx.mms.threads.getThreadDir(thread.id) }]
      } catch {
        return []
      }
    })),
    ...ctx.mms.orchestrator.liveWorkspaceClaims(input.threadId)
  ])
  const decision = evaluateRestore({
    threadId: input.threadId,
    caps: ctx.mms.orchestrator.capabilitiesForThread(input.threadId),
    metadata: input.workspace,
    others: otherClaims
  })
  if (decision.action === 'refuse') throw new DomainRpcError(decision.reason, decision.message, { conflicts: decision.conflicts })
  if (decision.action === 'proceed') return null
  const diff = input.target ? restoreDiff(ctx.mms.threads.getThreadDir(input.threadId), input.workspace.worktreePath, input.target.endSha, input.target.startSha) : ''
  const diffSha = restoreDiffSha(diff)
  if (input.reviewedDiffSha === diffSha) return null
  ctx.mms.runEngine.store.appendEvent({
    threadId: input.threadId,
    type: 'restore.review_required',
    payload: {
      kind: input.kind,
      actionId: input.target?.id ?? null,
      mode: decision.mode,
      diffBytes: Buffer.byteLength(diff),
      diffSha,
      ...(input.reviewedDiffSha !== undefined ? { staleReview: true } : {})
    }
  })
  return { requiresReview: true, diff, diffSha, ...(input.target ? { actionId: input.target.id } : {}) }
}

/**
 * SPEC §16.3: an undo or revert is its own run on the thread (`source: 'undo' | 'revert'`). `gate`
 * runs under the thread's mutex right before the run is created, so no other run starts between
 * the restore-safety check and the restore; a review it returns comes back as `{ review }` with no
 * run. `outcome` is recorded on the completed run.
 */
async function localActionRun<T>(
  ctx: HandlerContext,
  threadId: string,
  source: 'undo' | 'revert' | 'clear' | 'compact',
  action: () => Promise<T>,
  options: { gate?: () => RestoreReview | null; outcome?: RunOutcome } = {}
): Promise<{ runId: string; result: T } | { review: RestoreReview }> {
  const busy = new DomainRpcError('thread_busy', 'Wait for active or queued work to finish.')
  if (ctx.mms.runEngine.getActiveRun(threadId)) throw busy
  const gate = options.gate
  try {
    return await ctx.mms.runEngine.runLocalAction({ threadId, source }, action, {
      outcome: options.outcome,
      ...(gate ? {
        gate: () => {
          const review = gate()
          if (review) throw new LocalActionGated(review)
        }
      } : {})
    })
  } catch (error) {
    if (error instanceof LocalActionGated) return { review: error.value as RestoreReview }
    if (error instanceof CommandRejection && error.reason === 'thread_busy') throw busy
    throw error
  }
}

/** Run-targeted stop/steer (SPEC §6): `ignored` is a valid answer, not an error. */
function runCommandResponse(result: CommandResult, runId: string): { ok: boolean; ignored: boolean; reason?: string; runId: string } {
  return {
    ok: result.status === 'accepted',
    ignored: result.status === 'ignored',
    ...(result.status !== 'accepted' ? { reason: result.reason } : {}),
    runId
  }
}

async function prepareChatInput(ctx: HandlerContext, threadId: string, input: OrchestratorSendRequest, raw: Record<string, unknown>): Promise<OrchestratorSendInput> {
  if (Object.hasOwn(raw, 'workflowInvocationId')) throw new DomainRpcError('invalid_params', 'Workflow receipt references are server-owned')
  const bridge = ctx.mms.platform?.workflowChat
  if (!bridge || !ctx.connection) return buildSendInput(input.content, input.mode, input.images)
  // A workflow typed on a thread runs under that thread's mode (#338).
  const prepared = await bridge.prepare(threadId, { ...input, requestId: asOptionalString(raw.requestId, 64) }, isPerson(ctx.connection) ? 'gui' : 'cli',
    ctx.mms.orchestrator.workflowPermissionMode(threadId))
  if (prepared.workflowInvocationId) {
    // A workflow's steps run under the workflow's own policy, not under the permission mode of a turn, so a
    // device's limit cannot bind them. Until workflows have a permission mode, a /workflow command typed on
    // another computer is refused (the receipt written while preparing has no effects); the owner's own windows run it.
    if (ctx.connection.bridgeCaller) throw new DomainRpcError('workflow_not_available_remotely', 'Workflows cannot be started from another computer yet. Run the workflow on the computer that runs this thread.')
    if (!ctx.connection.capabilities.has(WORKFLOW_RUN_CAPABILITY)) throw new DomainRpcError('capability_required', 'This connection cannot execute workflow commands')
    return prepared
  }
  return buildSendInput(prepared.content, prepared.mode, prepared.images)
}

function threadLookupContext(ctx: HandlerContext, params: Record<string, unknown>) {
  const threadId = asString(params.threadId, 'threadId', 256)
  const thread = ctx.mms.threads.getThread(threadId)
  if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
  const threadDirectory = ctx.mms.threads.getThreadDir(threadId)
  const projectPath = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
  const expectedGeneration = asOptionalBoundedInt(params.expectedJournalGeneration, 'expectedJournalGeneration', { min: 0, max: Number.MAX_SAFE_INTEGER })
  // The operation journal is the authority for optimistic concurrency. A data
  // generation can legitimately lag a just-completed Git/action mutation.
  const currentGeneration = new ThreadJournal(threadDirectory).latestSequence()
  if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
    throw new StaleThreadActionRevisionError(currentGeneration)
  }
  return { threadId, thread, threadDirectory, projectPath, currentGeneration }
}

const THREAD_BUSY_TEXT = 'The current turn is still running. Try again once it finishes.'

/** Another holder of the thread's execution lease (a turn, a sweep) refused this action after its wait. */
function isLeaseBusy(error: unknown): boolean {
  return /execution lease busy/i.test(error instanceof Error ? error.message : String(error))
}

/** Recovery and Abort wait for no turn: a running one is said at once, instead of after the lease wait times out. */
function assertNoRunningTurn(ctx: HandlerContext, threadId: string): void {
  if (ctx.mms.orchestrator.isTurnActive(threadId)) throw new DomainRpcError('thread_busy', THREAD_BUSY_TEXT)
}

function threadOperationContext(ctx: HandlerContext, params: Record<string, unknown>) {
  const lookup = threadLookupContext(ctx, params)
  if (!lookup.projectPath) throw new DomainRpcError('thread_has_no_folder', `Thread has no project workspace: ${lookup.threadId}`, { threadId: lookup.threadId })
  return { ...lookup, projectPath: lookup.projectPath }
}

interface ConversationStateSnapshot {
  schemaVersion: 1
  messages: ChatMessage[]
  nativeContext: NativeLlmContext
}

function conversationStatePath(threadDirectory: string, branchId: string): string {
  return join(threadDirectory, 'conversation-contexts', `${encodeURIComponent(branchId)}.json`)
}

/**
 * The versions of each edited prompt the conversation now shows. Editing a prompt makes a branch that starts before
 * its turn (`at: 'start'`), whose first turn is the edited prompt; editing that one again is a version of the same
 * prompt. So each prompt's versions are the branch its first version ran on and every edit of it, at any depth, in
 * the order they were made. A version is shown on the active branch's own prompt: the first version's turn on the
 * branch it ran on, or an edit's first turn. An edit with no turn yet (never sent) shows nowhere.
 */
export function promptVersionsOf(
  branches: readonly import('../../shared/threadActions').ConversationBranch[],
  actions: readonly ThreadAction[],
  activeBranchId: string
): Array<{ turnId: string; versions: string[]; current: number }> {
  const edits = branches.filter((branch) => branch.at === 'start' && branch.parentTurnId && branch.lifecycle !== 'tombstoned')
  // Turns a prompt started: not the records of the person's own changes made between turns (`actor: user`).
  const prompts = actions.filter((action) => action.actor?.kind !== 'user' && action.nativeContextStartBoundary)
  const firstTurnOf = (branchId: string) => prompts.find((action) => action.conversationBranchId === branchId)?.turnId
  const branchOfTurn = (turnId: string) => prompts.find((action) => action.turnId === turnId)?.conversationBranchId
  // The first version's turn of the prompt `turnId` is a version of: up through the edits whose first turn it is.
  const rootOf = (turnId: string): string => {
    let root = turnId
    for (let depth = 0; depth < edits.length; depth += 1) {
      const branch = edits.find((edit) => edit.id === branchOfTurn(root))
      if (!branch || firstTurnOf(branch.id) !== root) break
      root = branch.parentTurnId!
    }
    return root
  }
  const groups = new Map<string, string[]>()
  for (const edit of [...edits].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const root = rootOf(edit.parentTurnId!)
    const original = branchOfTurn(root)
    if (!original) continue
    const versions = groups.get(root) ?? [original]
    versions.push(edit.id)
    groups.set(root, versions)
  }
  const shown: Array<{ turnId: string; versions: string[]; current: number }> = []
  for (const [root, versions] of groups) {
    const current = versions.indexOf(activeBranchId)
    if (current < 0) continue
    const onBranch = current === 0 ? root : firstTurnOf(activeBranchId)
    if (onBranch) shown.push({ turnId: onBranch, versions, current })
  }
  return shown
}

/** Finishes a branch switch that stopped (a crash), so a new switch or edit can go ahead after it, never before. */
async function recoverBranchSwitch(ctx: HandlerContext, threadId: string, threadDirectory: string, workspacePath: string): Promise<void> {
  await new ConversationBranchService(threadDirectory).recoverPending(workspacePath, (branch) => {
    const state = loadConversationState(threadDirectory, branch.id)
    ctx.mms.orchestrator.replaceConversationState(threadId, state.messages, state.nativeContext)
  })
}

/** Refuses a change of conversation history (a branch made or switched to) while the thread's turn or queue is busy. */
function assertHistoryIdle(ctx: HandlerContext, threadId: string): void {
  if (ctx.mms.orchestrator.isConversationHistoryBusy(threadId)) throw new DomainRpcError('thread_busy', 'Wait for the current turn to finish.')
}

function saveConversationState(
  ctx: HandlerContext,
  threadId: string,
  threadDirectory: string,
  branchId: string,
  options: { presentationEnd?: number; nativeEnd?: number; boundary?: import('../../shared/threadActions').NativeContextBoundary } = {}
): void {
  const messages = ctx.mms.orchestrator.getMessagesForPersistence(threadId)
  const nativeContext = ctx.mms.orchestrator.getNativeContext(threadId)
  const nativeEnd = Math.max(0, Math.min(options.nativeEnd ?? nativeContext.messages.length, nativeContext.messages.length))
  const boundary = options.boundary
  const snapshot: ConversationStateSnapshot = {
    schemaVersion: 1,
    messages: structuredClone(messages.slice(0, options.presentationEnd ?? messages.length)),
    nativeContext: {
      ...nativeContext,
      messages: structuredClone(nativeContext.messages.slice(0, nativeEnd)),
      activeStartIndex: Math.max(0, Math.min(boundary?.activeStartIndex ?? nativeContext.activeStartIndex, nativeEnd)),
      // A boundary owns its compaction: one from before the first compaction has none, and the summary made later
      // (of the turns cut off) must not come along. Without a boundary the conversation is saved as it is.
      compaction: boundary ? (boundary.compaction ? structuredClone(boundary.compaction) : undefined) : nativeContext.compaction,
      acceptedQueueItemIds: boundary?.acceptedQueueItemIds
        ? structuredClone(boundary.acceptedQueueItemIds)
        : nativeContext.acceptedQueueItemIds,
      acceptedSteerItemIds: boundary?.acceptedSteerItemIds
        ? structuredClone(boundary.acceptedSteerItemIds)
        : nativeContext.acceptedSteerItemIds,
      lastTurnUsage: undefined,
      // The provider's cache held the history as it was when saved, by then possibly cut here; a runtime resumes a
      // branch with a fresh session anyway, so nothing of it is cached when the branch is active again.
      promptCache: undefined
    }
  }
  const directory = join(threadDirectory, 'conversation-contexts')
  mkdirSync(directory, { recursive: true })
  atomicWriteJsonSync(conversationStatePath(threadDirectory, branchId), snapshot)
}

function loadConversationState(threadDirectory: string, branchId: string): ConversationStateSnapshot {
  const path = conversationStatePath(threadDirectory, branchId)
  if (!existsSync(path)) throw new Error(`Conversation context snapshot is unavailable: ${branchId}`)
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConversationStateSnapshot>
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.messages) || !parsed.nativeContext) {
    throw new Error(`Conversation context snapshot is corrupt: ${branchId}`)
  }
  return parsed as ConversationStateSnapshot
}

/** Resolve only daemon-known project or ready thread-worktree roots; never accept a caller cwd. */
function projectRootContext(ctx: HandlerContext, params: Record<string, unknown>): string {
  const threadId = asOptionalString(params.threadId, 256)
  const projectId = asOptionalString(params.projectId, 256)
  if (threadId && projectId) throw new Error('Specify either threadId or projectId, not both')
  if (threadId) {
    const projectPath = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
    if (!projectPath) throw new Error(`Thread has no project workspace: ${threadId}`)
    const manager = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId))
    const workspace = manager.load()
    if (workspace && workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', `Task workspace is ${workspace.lifecycle}; recovery is required.`)
    return workspace ? manager.workingFolder(projectPath, workspace) : projectPath
  }
  if (!projectId) throw new Error('projectId or threadId is required')
  const project = ctx.mms.projects.getProject(projectId)
  if (!project) throw new DomainRpcError('project_not_found', 'Project not found', { projectId })
  return project.path
}

/** Only a Mousse window on this computer browses and saves files the way the Files panel does. */
function isLocalWindow(ctx: HandlerContext): boolean {
  return ctx.connection?.clientType === 'gui'
}

/**
 * Runs a file call for a caller. The Files panel shows the reason a file cannot be opened or saved (too large,
 * no preview for its type, outside the folder, no longer there), so a window of this computer, and the same
 * panel on another of the user's computers, get the call's own message; any other caller keeps the daemon's
 * general error for what it did not expect.
 */
async function fileCall<T>(ctx: HandlerContext, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (rejected) {
    const error = refusedPath(rejected)
    if (!isPerson(ctx.connection) || error instanceof DomainRpcError || error instanceof AppError) throw error
    throw new DomainRpcError('file_unavailable', error instanceof Error ? error.message : String(error))
  }
}

/**
 * The folder the Files panel shows for a thread or project of this computer's own window:
 * - a thread's ready worktree, which wins over the primary checkout;
 * - else the project folder (the named project, or the thread's own);
 * - else the home folder, for an existing thread without a project and for a window with nothing selected.
 * A thread or project that is named but unknown is refused (`thread_not_found`, `project_not_found`).
 * Never provisions or restores a worktree itself; the calls that use the folder restore a retired one first.
 */
async function localFilesRoot(ctx: HandlerContext, params: Record<string, unknown>): Promise<string> {
  const threadId = asOptionalString(params.threadId, 256)
  const projectId = asOptionalString(params.projectId, 256)
  // A thread or project that is named but unknown is refused, never answered with the home folder.
  if (threadId && !ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
  if (projectId && !ctx.mms.projects.getProject(projectId)) throw new DomainRpcError('project_not_found', 'Project not found', { projectId })
  const threadProject = threadId ? resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId) : undefined
  if (threadId && threadProject) {
    const manager = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId))
    const stored = manager.load()
    // A worktree in a worktree folder the person chose is never stood in for by the project folder: while its drive is
    // not connected the panel says so, and a save can never land in the person's own checkout instead.
    const chosen = stored && !isProjectFolderWorkspace(stored) && chosenFolderHolding(stored.worktreePath)
    if (chosen) await assertWorktreeFolderConnected(stored!.worktreePath)
    const verified = stored ? await manager.verify(stored) : undefined
    // A ready workspace's folder, as `executionContext` names it; without a record there is none to use.
    if (verified?.lifecycle === 'ready') return manager.workingFolder(threadProject, verified)
    if (chosen) throw new DomainRpcError('workspace_not_ready', `Task workspace is ${verified?.lifecycle ?? 'missing'}; recovery is required.`)
  }
  if (projectId) return ctx.mms.projects.getProject(projectId)!.path
  return threadProject ?? homedir()
}

/**
 * The folder a `files.list`, `files.read` or `files.readAsset` call works in. A worktree that a storage rule retired
 * comes back first, as for every read of a thread. A window of this computer then gets the Files panel's folder;
 * every other caller gets exactly the thread's or project's own folder.
 */
async function filesRootContext(ctx: HandlerContext, params: Record<string, unknown>): Promise<string> {
  await materializeRequestedWorkspace(ctx, params)
  return isLocalWindow(ctx) ? await localFilesRoot(ctx, params) : projectRootContext(ctx, params)
}

/** The calls that take a browsed folder (`root`). */
const BROWSED_ROOT_METHODS = new Set(['files.list', 'files.read', 'files.readAsset', 'files.writeDirect'])

/**
 * The folder the Files panel of this computer's window browses instead of the thread's (`root`), or undefined
 * when the call names none. Only such a window may name one, never another computer, a phone, the CLI or an
 * agent; the rules for the path are in `files/browsedRoot.ts`. The path guard still holds every path of the call
 * inside it, and its volume has already answered: `root` is one of the folders a request waits for
 * (`waitForRequestFolders`), so a drive that hangs fails the call at once.
 */
function browsedFilesRoot(ctx: HandlerContext, params: Record<string, unknown>): string | undefined {
  const root = asOptionalString(params.root, 4096)
  if (root === undefined) return undefined
  if (!isLocalWindow(ctx) || ctx.connection?.bridgeCaller)
    throw new DomainRpcError('forbidden', 'Only a Mousse window on this computer browses other folders')
  const refusal = browsedRootRefusal(root)
  if (refusal) throw new DomainRpcError('invalid_params', refusal)
  return normalizedBrowsedRoot(root)
}

/** The folder of a `pullRequests.*` call; a missing or doubled reference is the caller's mistake, not an internal error. */
function pullRequestFolder(ctx: HandlerContext, params: Record<string, unknown>): string {
  const threadId = asOptionalString(params.threadId, 256)
  const projectId = asOptionalString(params.projectId, 256)
  if (threadId && projectId) throw new DomainRpcError('invalid_params', 'Specify either threadId or projectId, not both')
  if (!threadId && !projectId) throw new DomainRpcError('invalid_params', 'projectId or threadId is required')
  if (threadId && !ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
  return projectRootContext(ctx, params)
}

function defaultBranchError(): DomainRpcError {
  return new DomainRpcError('pull_request_default_branch', "The repository's default branch cannot get a pull request. Create a branch for your changes first.")
}

/**
 * The folder, branch and originating thread of a pull request action that is bound to the branch its
 * form opened on. The folder's checked-out branch is read before anything else, and a different one
 * (or none) refuses the call with `git_branch_changed`, so a checkout that moved meanwhile is never
 * drafted, looked up or created for.
 */
async function pullRequestBranchContext(
  ctx: HandlerContext,
  p: Record<string, unknown>
): Promise<{ root: string; branch: string; originThreadId: string | null; projectId: string | null }> {
  await materializeRequestedWorkspace(ctx, p)
  const root = pullRequestFolder(ctx, p)
  const branch = asString(p.expectedBranch, 'expectedBranch', 512)
  if (branch.startsWith('-')) throw new DomainRpcError('invalid_params', 'expectedBranch is not a branch name')
  const originThreadId = asOptionalString(p.originThreadId, 256) ?? null
  let projectId: string | null = null
  if (originThreadId) {
    const origin = ctx.mms.threads.getThread(originThreadId)
    if (!origin) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId: originThreadId })
    // Admitted like the thread of any other call: a thread being trashed or purged takes no new work.
    if (ctx.mms.threads.lifecycleStore?.get(originThreadId)) ctx.mms.threads.assertThreadAdmission(originThreadId)
    // Its conversation drafts the description and it receives the link, so it must be the thread whose folder this is:
    // the folder's own thread, or one on the project's checkout.
    const originFolder = projectRootContext(ctx, { threadId: originThreadId })
    if (!samePath(originFolder, root)) {
      throw new DomainRpcError('invalid_params', "originThreadId is not the thread of this folder", { threadId: originThreadId })
    }
    projectId = origin.projectId ?? null
  }
  const git = ctx.mms.gitService
  if (await git.currentBranch(root) === null) throw new DomainRpcError('pull_request_detached_head', 'Check out a branch before creating a pull request.')
  await git.assertBranch(root, branch)
  projectId ??= asOptionalString(p.projectId, 256) ?? (asOptionalString(p.threadId, 256) ? ctx.mms.threads.getThread(String(p.threadId))?.projectId ?? null : null)
  return { root, branch, originThreadId, projectId }
}

function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value))
  return normalize(a) === normalize(b)
}

/** The link a thread keeps to a pull request of its own repository (the lookup lists no forks' pull requests). */
function threadPullRequestLink(identity: RepositoryIdentity, pullRequest: GitPullRequestInfo): ThreadPullRequestLink {
  return {
    number: pullRequest.number,
    url: pullRequest.url,
    host: identity.host,
    nameWithOwner: identity.nameWithOwner,
    headRefName: pullRequest.headRefName ?? '',
    baseRefName: pullRequest.baseRefName ?? '',
    headRepository: identity.nameWithOwner,
    isCrossRepository: false,
    linkedAt: new Date().toISOString()
  }
}

/** The link a thread keeps to a pull request, from the host's full read of it (head and base repositories included). */
function threadPullRequestLinkFromDetail(detail: PullRequestDetail): ThreadPullRequestLink {
  return {
    number: detail.number,
    url: detail.url,
    host: detail.identity.host,
    nameWithOwner: detail.identity.nameWithOwner,
    headRefName: detail.headRefName,
    baseRefName: detail.baseRefName,
    headRepository: detail.headRepository,
    isCrossRepository: detail.isCrossRepository,
    linkedAt: new Date().toISOString()
  }
}

const PULL_REQUEST_READ_CODES = {
  'not-found': 'pull_request_not_found',
  'rate-limited': 'pull_request_rate_limited'
} as const

/**
 * Reads one pull request. A failed read reaches the caller as a domain error carrying the host's own
 * message (a plain error would reach a client as "something went wrong"), with the kind of failure as its code.
 */
async function readPullRequestDetail(ctx: HandlerContext, root: string, number: number, force: boolean): Promise<PullRequestDetail> {
  try {
    return await ctx.mms.gitService.codeHost.getPullRequestDetail(root, number, { force })
  } catch (error) {
    const kind = error instanceof PullRequestReadError ? error.kind : 'error'
    const code = kind === 'not-found' || kind === 'rate-limited' ? PULL_REQUEST_READ_CODES[kind] : 'pull_request_unavailable'
    throw new DomainRpcError(code, error instanceof Error ? error.message : String(error), { number, reason: kind })
  }
}

/**
 * Writes a thread's link. The same pull request keeps its watch; a different one ends the old watch (with its line), since
 * a watch belongs to the pull request it began on and must not resume later with an old cutoff and a backlog.
 */
function writeThreadLink(ctx: HandlerContext, threadId: string, next: ThreadPullRequestLink, keepWatch: boolean): Thread {
  const previous = ctx.mms.threads.getThread(threadId)?.pullRequest
  const thread = ctx.mms.threads.updateThreadMeta(threadId, { pullRequest: keepWatch ? relinked(previous, next) : next })
  if (previous && !sameLinkedPullRequest(previous, next)) ctx.mms.pullRequestWatch.onEnded(threadId, 'unlinked')
  return thread
}

/**
 * Links a pull request to the thread that asked for it. The pull request exists by now, so a link that
 * cannot be written (the host cannot name the repository, the thread is gone) must not fail the call;
 * the side card finds the pull request by its branch meanwhile.
 */
async function linkOriginThread(ctx: HandlerContext, threadId: string | null, root: string, pullRequest: GitPullRequestInfo): Promise<void> {
  if (!threadId) return
  try {
    const identity = await ctx.mms.gitService.codeHost.repositoryIdentity(root)
    writeThreadLink(ctx, threadId, threadPullRequestLink(identity, pullRequest), true)
    ctx.emitEvent?.('threads.updated', { threads: ctx.mms.threads.listAllThreads() })
  } catch {
    // Left unlinked; see above.
  }
}

/**
 * Brings a retired worktree back before a handler uses it. A rule or trash retires a checkout but
 * leaves `workspace.json` ready and keeps a reconstruction manifest, so `restore` rebuilds it
 * exactly. Restoring rewrites `workspace.json`, which counts as activity for the inactive rule.
 * Does nothing for a thread that has no workspace or whose checkout is present.
 */
async function ensureWorkspaceMaterialized(ctx: HandlerContext, threadId: string, project?: string): Promise<void> {
  const manager = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId))
  const workspace = manager.load()
  // A folder without its `.git` file is what a retirement that failed partway leaves; `restore` sets it aside and rebuilds.
  // An unfinished rebuild is finished here too, whatever it left at the worktree's path.
  if (!workspace || existsSync(join(workspace.worktreePath, '.git')) && !manager.rebuildUnfinished(workspace) || !manager.hasReconstructionManifest()) return
  // One restore per thread: calls that arrive together (a focus refresh asks for status, files and the pull request at once) share it.
  const key = ctx.mms.threads.getThreadDir(threadId)
  const running = restoresInFlight.get(key)
  if (running) return running
  const projectPath = project ?? resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
  if (!projectPath) return
  const restore = (async () => {
    // Files a rebuild had to set aside are named in the thread, with the command that brings each back.
    await manager.restore(projectPath, undefined, undefined, (notice) => ctx.mms.orchestrator.noteThreadUpdate(threadId, notice.text, { messageId: notice.id, kind: 'warning' }))
    clearCleanupMarker(ctx.mms.threads.lifecycleStore, threadId)
  })().finally(() => { restoresInFlight.delete(key) })
  restoresInFlight.set(key, restore)
  return restore
}
const restoresInFlight = new Map<string, Promise<void>>()

/** `ensureWorkspaceMaterialized` for a request that names a thread; an unknown thread fails later with its usual error. */
async function materializeRequestedWorkspace(ctx: HandlerContext, params: Record<string, unknown>): Promise<void> {
  const threadId = asOptionalString(params.threadId, 256)
  if (threadId && ctx.mms.threads.getThread(threadId)) await ensureWorkspaceMaterialized(ctx, threadId)
}

/**
 * Where Push goes for a thread linked to a pull request: the pull request's own branch, but only when that is provably
 * the same repository, that is, its head is not in a fork and a remote of this folder points at it. Anything else keeps
 * Push's usual target, with the reason a client can show.
 */
async function pullRequestPushTarget(ctx: HandlerContext, threadId: string, root: string): Promise<PullRequestPushTarget> {
  const link = ctx.mms.threads.getThread(threadId)?.pullRequest
  const usual: PullRequestPushTarget = { remote: null, branch: null, reason: null }
  // Only a thread that was started from the pull request: a link made by hand says nothing about where its branch belongs.
  if (!link || link.startedFromPullRequest !== true) return usual
  const repository = `${link.nameWithOwner}${link.host.toLowerCase() === 'github.com' ? '' : ` on ${link.host}`}`
  const sameRepository = link.isCrossRepository === false && link.headRepository !== null && link.headRepository.toLowerCase() === link.nameWithOwner.toLowerCase()
  if (!sameRepository) return { ...usual, reason: `The pull request's branch is on a fork (${link.headRepository ?? 'deleted'}); push by hand` }
  if (!link.headRefName) return { ...usual, reason: 'The pull request has no head branch to push to; push by hand' }
  // Never straight onto the repository's default branch (a release pull request from develop to main has it as its head).
  const { defaultBranch } = await ctx.mms.gitService.codeHost.listBaseBranches(root)
  if (defaultBranch === null) return { ...usual, reason: `The default branch of ${repository} could not be read, so Push cannot tell whether the pull request's branch is safe to update; push by hand` }
  if (link.headRefName === defaultBranch) return { ...usual, reason: `The pull request's branch is ${repository}'s default branch, which Push never updates; push by hand` }
  // The remote must fetch from and push to the repository: a `pushurl` can name another one.
  const remote = await ctx.mms.gitService.codeHost.remoteForRepository(root, { host: link.host, nameWithOwner: link.nameWithOwner }, { push: true })
  if (!remote) return { ...usual, reason: `No remote of this checkout fetches from and pushes to ${repository}; push by hand` }
  return { remote, branch: link.headRefName, reason: null }
}

/** The service that starts threads from pull requests, over this profile's stores. */
function pullRequestThreadService(ctx: HandlerContext): PullRequestThreadService {
  return new PullRequestThreadService({
    codeHost: ctx.mms.gitService.codeHost,
    projects: ctx.mms.projects,
    threads: ctx.mms.threads,
    // Another device is never told a private thread works on a pull request.
    ...(connectionIsLocal(ctx.connection) ? {} : { hidden: (thread: Thread) => isLocalOnlyThread(thread, ctx.mms.threads.listAllThreads()) }),
    // A failed start's thread goes through the one delete; with unpublished work it stays in Archived.
    trashThread: (threadId) => ctx.mms.deleteThreadForGood(threadId, { human: false, discard: false, internal: true }),
    // Like `threads.create`: a new thread starts on the model last used.
    prepareThread: (thread) => {
      const lastUsed = ctx.mms.providerInstances.migrate(lastUsedChatModel(ctx.mms.settings.get()))
      let prepared = lastUsed ? ctx.mms.threads.updateThreadMeta(thread.id, { modelOverride: lastUsed }) : thread
      // A thread another computer starts says so, as one made with `threads.create` does.
      const sentFrom = sentFromOf(ctx)
      if (sentFrom) prepared = ctx.mms.threads.updateThreadMeta(thread.id, { startedFrom: { node: sentFrom.node } }, { touch: false })
      return prepared
    },
    // A notice from Mousse itself, so the thread shows it even before its first turn.
    note: (threadId, text, messageId) => ctx.mms.orchestrator.noteThreadUpdate(threadId, text, { messageId, kind: 'warning' }),
    send: async (threadId, content) => {
      ctx.mms.orchestrator.getOrCreateSession(threadId)
      const input = await prepareChatInput(ctx, threadId, { content }, {})
      const limit = deviceLimit(ctx)
      const sentFrom = sentFromOf(ctx)
      // `ack`: the call returns once the message is accepted, not when the turn ends. A first message from another
      // computer is that computer's person's: it runs at no more than the device's limit, the thread's default
      // mode notwithstanding, and says who sent it.
      await ctx.mms.orchestrator.send(input, false, {
        threadId,
        source: admittedChatSource(ctx, 'protocol'),
        forceQueue: false,
        awaitMode: 'ack',
        ...(limit ? { permissionMode: limit } : {}),
        ...(sentFrom ? { sentFrom, actor: questionAnswerer(ctx) } : {})
      })
    }
  })
}

/** A refusal of the pull request thread service keeps its code; a failed read reaches the caller with the host's own message. */
async function asDomainError<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof PullRequestThreadError) throw new DomainRpcError(error.code, error.message, error.details)
    if (error instanceof PullRequestReadError) {
      const code = error.kind === 'not-found' || error.kind === 'rate-limited' ? PULL_REQUEST_READ_CODES[error.kind] : 'pull_request_unavailable'
      throw new DomainRpcError(code, error.message, { reason: error.kind })
    }
    throw error
  }
}

/** What a thread's worktree branch is named from when one is made here: its first message, else its name. */
function branchNameSource(ctx: HandlerContext, threadId: string): string | undefined {
  const first = ctx.mms.orchestrator.getMessages(threadId).find((message) => message.role === 'user' && message.content.trim())
  return first?.content ?? ctx.mms.threads.getThread(threadId)?.name
}

/**
 * Makes sure a thread that works in its own worktree has one before a file write, terminal or Git action uses it.
 * A thread in its project's folder (`threadPlacement`) gets none: those actions run in the project folder.
 */
async function ensureOwnedTaskWorkspace(ctx: HandlerContext, params: Record<string, unknown>): Promise<void> {
  if (!params.threadId) return
  const threadId = asString(params.threadId, 'threadId', 256)
  const thread = ctx.mms.threads.getThread(threadId)
  if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found')
  const project = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
  if (!project) throw new DomainRpcError('thread_has_no_folder', 'Task has no project workspace')
  // No worktree for a thread in its project's folder; its record lets file writes and terminals be recorded and undone.
  if (threadPlacement(thread) === 'project-folder') {
    await new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId)).ensureProjectFolder(threadId, 'main', project)
    return
  }
  const manager = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId))
  if (!manager.load()) await manager.provision(threadId, 'main', project, undefined, undefined, undefined, { nameFrom: branchNameSource(ctx, threadId) })
  // On a drive that is not connected: says so, and the worktree is left as it is (`worktreeLayout`).
  await assertWorktreeFolderConnected(manager.load()?.worktreePath)
  await ensureWorkspaceMaterialized(ctx, threadId, project)
  if ((await manager.verify()).lifecycle !== 'ready') throw new DomainRpcError('workspace_recovery_required', 'Task workspace requires recovery before mutation')
}

/** Refusals that follow from a thread's worktree being the thread's own. Each has a fixed code the GUI can show copy for. */
const gitThreadRules = createErrorProvider({
  task_branch_authoritative: { category: 'denied', retryable: false, message: 'Task branches are authoritative. Use the conversation branch controls to switch task revisions.' },
  thread_worktree_checkpointed: { category: 'denied', retryable: false, message: "Staging is not available in a thread's worktree; a commit there includes every change." },
  git_amend_in_thread: { category: 'denied', retryable: false, message: "Amend is not available in a thread's worktree." },
  git_undo_in_thread: { category: 'denied', retryable: false, message: "Use Undo in the chat to take back a commit in a thread's worktree." }
})

const GIT_PATHS_MAX = 5_000

/** The line a push of a thread's branch carries when the worktree holds files that are not committed: they stay out of the push. */
function uncommittedNotPushedNotice(count: number): string {
  return `Pushed the commits. ${count === 1 ? '1 uncommitted file was' : `${count} uncommitted files were`} not pushed.`
}

interface GitMutationTarget {
  root: string
  directory?: string
  /** Set when the folder is the thread's own worktree. */
  workspace?: ThreadWorkspaceMetadata
}

/**
 * Resolves the folder a Git mutation runs in, provisioning the thread's worktree when it has none yet.
 * Actions a thread worktree never allows name their refusal, and it comes first: a refused call must not
 * create a worktree as a side effect.
 */
async function gitMutationTarget(ctx: HandlerContext, p: Record<string, unknown>, refuseInThread?: 'task_branch_authoritative' | 'thread_worktree_checkpointed'): Promise<GitMutationTarget> {
  const threadId = asOptionalString(p.threadId, 256)
  // A thread in its project's folder uses the project's Git as the person does: staging, branches and amend included.
  const inProjectFolder = threadId !== undefined && threadPlacement(ctx.mms.threads.getThread(threadId)) === 'project-folder'
  if (refuseInThread && p.threadId !== undefined && p.threadId !== null && !inProjectFolder) throw gitThreadRules.create(refuseInThread)
  await ensureOwnedTaskWorkspace(ctx, p)
  const root = projectRootContext(ctx, p)
  const directory = threadId && !inProjectFolder ? ctx.mms.threads.getThreadDir(threadId) : undefined
  const loaded = directory ? new ThreadWorkspaceManager(directory).load() : undefined
  const workspace = loaded && !isProjectFolderWorkspace(loaded) ? loaded : undefined
  return { root, directory, workspace }
}

/** Paths as `getStatus` names them (repository-relative), accepted only inside the project folder. */
async function gitPaths(ctx: HandlerContext, root: string, value: unknown): Promise<string[]> {
  const paths = asStringArray(value, 'paths', { unique: true, maxItems: GIT_PATHS_MAX, maxItemLen: 4096 })
  if (paths.length === 0) throw new DomainRpcError('invalid_params', 'paths must name at least one file')
  const top = await workspaceGitAsync(root, ['rev-parse', '--show-toplevel'])
  let named: string[]
  try {
    named = repoRelativePaths(top, root, paths)
  } catch {
    throw new DomainRpcError('git_path_outside', 'That path is outside the project folder.')
  }
  // From another computer a path may not lead out of the folder through a link or junction either: Git on Windows
  // follows junctions, and `discard` deletes what it names. The path is only looked at, never changed, so a `.git` name is no concern here.
  if (ctx.connection?.bridgeCaller) {
    try {
      // `fs/promises`' `realpath` answers like `realpathSync.native`.
      const realRoot = await realpathNative(resolve(root))
      const realTop = await realpathNative(top)
      for (const path of named) containedPath(ctx, root, relative(realRoot, join(realTop, path)), 'inspect')
    } catch (error) {
      throw refusedPath(error)
    }
  }
  return named
}

/**
 * Runs a user's own Git action in a thread worktree as one recorded action. The action keeps whatever
 * error Git raised, so the caller sees the real code instead of a wrapper.
 */
async function runUserThreadGitAction<T>(
  ctx: HandlerContext,
  target: Required<Pick<GitMutationTarget, 'root' | 'directory' | 'workspace'>>,
  extra: Pick<RunThreadActionOptions, 'externalEffects' | 'signal'>,
  mutate: () => Promise<T>
): Promise<T> {
  const { root, directory, workspace } = target
  const announce = (action: ThreadAction) => ctx.emitEvent?.('actions.updated', { threadId: workspace.threadId, action }, workspace.threadId)
  try {
    const { result, action } = await new ThreadActionService(directory).runCheckpointedAction({
      threadId: workspace.threadId, turnId: randomUUID(), conversationBranchId: workspace.conversationBranchId,
      workspacePath: root, actor: { kind: 'user' }, allowDirtyInput: true, presentationMessageStart: 0, presentationMessageEnd: 0,
      nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }, ...extra
    }, mutate)
    announce(action)
    return result
  } catch (error) {
    if (error instanceof ActionExecutionError) {
      announce(error.action)
      throw error.cause ?? error
    }
    throw error
  }
}

/**
 * Runs an action that does not move the thread's branch under the thread's Git locks, like push. Without them
 * it would queue inside GitService ahead of a commit that already holds the repository lease and stall it.
 */
async function underThreadLocks<T>(target: GitMutationTarget, label: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return target.directory && target.workspace ? withGitMutationLocks(target.directory, target.root, label, run, signal) : run()
}

/**
 * Lets the client that sent a long Git request follow it: its events travel on that connection only, never to
 * other clients or windows, and only that connection can cancel it. Without an `operationId` nothing is sent.
 */
/**
 * The request behind a Git panel action: what the user pressed, or the CLI command they ran. The central Git
 * check (`gitPolicy`) allows a change to something Mousse does not own only with one.
 */
function gitUserAction(ctx: HandlerContext, label: string): UserAction {
  return userAction(ctx.connection?.clientType === 'cli' ? 'cli' : 'button', label)
}

function gitOperationOptions(ctx: HandlerContext, p: Record<string, unknown>): GitOperationOptions {
  const operationId = asOptionalString(p.operationId, 64)
  if (!operationId) return {}
  const send = ctx.connection?.emitConnectionEvent
  // Best effort: a backed-up connection drops an update, and the request's own answer still carries the outcome.
  return {
    operationId,
    owner: ctx.connection?.id,
    // The client that started it going away cancels it: nobody could cancel it afterwards, and it would hold the folder.
    lifetime: ctx.connection?.lifetime,
    ...(send ? { onEvent: (event) => { void send('git.operation', { event }).catch(() => undefined) } } : {})
  }
}

/**
 * Runs a long Git action that waits for locks of its own before Git runs. The action is registered first, so its
 * events start and Cancel works while it waits; `signal` is for the waits. Without an `operationId` it just runs.
 */
async function followedGitAction<T>(
  ctx: HandlerContext,
  p: Record<string, unknown>,
  root: string,
  kind: GitOperationKind,
  run: (request: { operation?: GitOperationHandle }, signal?: AbortSignal) => Promise<T>
): Promise<T> {
  const options = gitOperationOptions(ctx, p)
  if (!options.operationId) return run({})
  const operation = ctx.mms.gitService.openOperation(root, kind, options)
  try {
    const result = await run({ operation }, operation.signal)
    operation.end()
    return result
  } catch (error) {
    // A cancel that arrives during a lock wait surfaces as that wait's own abort error.
    const outcome = operation.signal?.aborted && !(error instanceof AppError) ? ctx.mms.gitService.cancelledError() : error
    operation.end(outcome)
    throw outcome
  }
}

function threadWorktree(target: GitMutationTarget): Required<GitMutationTarget> | null {
  return target.directory && target.workspace ? { root: target.root, directory: target.directory, workspace: target.workspace } : null
}

/**
 * The thread whose recorded action a person's Git change in `target` runs as: its own worktree, or its project's folder
 * when it works there (its `project-folder.json` record). Null without a thread, or for one with no ready record.
 */
function recordedThreadTarget(ctx: HandlerContext, p: Record<string, unknown>, target: GitMutationTarget): Required<GitMutationTarget> | null {
  const worktree = threadWorktree(target)
  if (worktree) return worktree
  const threadId = asOptionalString(p.threadId, 256)
  if (!threadId) return null
  const directory = ctx.mms.threads.getThreadDir(threadId)
  const workspace = new ThreadWorkspaceManager(directory).load()
  return workspace && isProjectFolderWorkspace(workspace) && workspace.lifecycle === 'ready' ? { root: target.root, directory, workspace } : null
}

/** The profile folder project data is kept in. */
function profileHome(ctx: HandlerContext): string {
  return ctx.mms.threads.lifecycleStore?.profileHome ?? getMousseHomeDir()
}

/** The project a request names, directly or through its thread. */
function requestProjectId(ctx: HandlerContext, p: Record<string, unknown>): string | undefined {
  const threadId = asOptionalString(p.threadId, 256)
  return asOptionalString(p.projectId, 256) ?? (threadId ? ctx.mms.threads.getThread(threadId)?.projectId ?? undefined : undefined)
}

/** The project's owner of copies a Discard keeps in the person's own checkout at `root`, noted so the sweep finds them. */
function projectKeptFilesOwnerFor(ctx: HandlerContext, p: Record<string, unknown>, root: string): string {
  const projectId = requestProjectId(ctx, p)
  if (!projectId) throw new DomainRpcError('project_not_found', 'A Discard outside a thread needs its project, which keeps the copy.')
  const owner = projectKeptFilesOwner(profileHome(ctx), projectId)
  registerProjectKeptFilesFolder(owner, projectId, root)
  return owner
}

/** A thread's selection (`git.include`) in its worktree, next to its other records. */
const THREAD_SELECTION_FILE = 'git-selection.json'
/** The "everything left out" marker of a project folder, in the project's kept-files owner folder, never in `.git`. */
const PROJECT_SELECTION_MARKER = 'git-selection-marker.json'

/**
 * Where the selection of the folder a request names lives: a thread's own worktree keeps an overlay in the thread's
 * folder; any other folder (a project's, or a thread working in it) uses the real index and the project's marker.
 * `write` is set for a change: the marker's folder is then noted for the sweep, a copy of a staged version the change
 * replaces can be kept, and the change refuses while a turn works in the folder.
 */
function selectionPlaceFor(ctx: HandlerContext, p: Record<string, unknown>, root: string, write = false): SelectionPlace {
  const threadId = asOptionalString(p.threadId, 256)
  const worktree = threadId ? threadWorktreeDirectory(ctx, threadId) : null
  const assertIdle = write ? () => assertSelectionIdle(ctx, worktree ? threadId! : null, requestProjectId(ctx, p)) : undefined
  if (worktree) return { kind: 'thread', overlayFile: join(worktree, THREAD_SELECTION_FILE), ...(assertIdle ? { assertIdle } : {}) }
  const projectId = requestProjectId(ctx, p)
  if (!projectId) throw new DomainRpcError('project_not_found', 'The project of this folder is needed for its selection.')
  const owner = write ? projectKeptFilesOwnerFor(ctx, p, root) : projectKeptFilesOwner(profileHome(ctx), projectId)
  return { kind: 'project', markerFile: join(owner, PROJECT_SELECTION_MARKER), ...(write ? { keepOwner: owner } : {}), ...(assertIdle ? { assertIdle } : {}) }
}

/** The thread's folder when it works in a worktree of its own that is ready; null for a thread in its project's folder. */
function threadWorktreeDirectory(ctx: HandlerContext, threadId: string): string | null {
  if (threadPlacement(ctx.mms.threads.getThread(threadId)) === 'project-folder') return null
  const directory = ctx.mms.threads.getThreadDir(threadId)
  const workspace = new ThreadWorkspaceManager(directory).load()
  return workspace && !isProjectFolderWorkspace(workspace) ? directory : null
}

/**
 * A selection change refuses while a turn works in the folder: the thread's own turn in its worktree, and in a project's
 * folder any thread working there, its chat history work included.
 */
function assertSelectionIdle(ctx: HandlerContext, threadId: string | null, projectId: string | undefined): void {
  if (threadId) {
    if (ctx.mms.orchestrator.isTurnActive(threadId)) throw new DomainRpcError('thread_busy', THREAD_BUSY_TEXT)
    return
  }
  if (!projectId) return
  for (const thread of ctx.mms.threads.listAllThreads()) {
    if (thread.projectId !== projectId || threadPlacement(thread) !== 'project-folder') continue
    if (ctx.mms.orchestrator.isTurnActive(thread.id) || ctx.mms.orchestrator.isConversationHistoryBusy(thread.id)) throw new DomainRpcError('thread_busy', THREAD_BUSY_TEXT)
  }
}

/** Tells every view of the folder to read its selection again. */
function announceSelection(ctx: HandlerContext, p: Record<string, unknown>, place: SelectionPlace): void {
  const threadId = asOptionalString(p.threadId, 256)
  if (place.kind === 'thread' && threadId) ctx.emitEvent?.('git.selectionChanged', { threadId }, threadId)
  else {
    const projectId = requestProjectId(ctx, p)
    if (projectId) ctx.emitEvent?.('git.selectionChanged', { projectId, ...(threadId ? { threadId } : {}) }, threadId)
  }
}

/** `git.commit`'s and `git.suggestCommitMessage`'s `selection`. */
function asCommitSelection(value: unknown): GitCommitSelection | undefined {
  if (value === undefined || value === null) return undefined
  if (!isObject(value)) throw new DomainRpcError('invalid_params', 'selection must be { mode: "all" } or { mode: "chosen", token }')
  const mode = asString(value.mode, 'selection.mode', 16)
  if (mode === 'all') return { mode }
  if (mode === 'chosen') return { mode, token: asString(value.token, 'selection.token', 128) }
  throw new DomainRpcError('invalid_params', 'selection.mode must be all or chosen')
}

/** `git.include`'s `hunks` and `lines`. */
function asIncludeParts(p: Record<string, unknown>): Pick<GitIncludeRequest, 'hunks' | 'lines'> {
  const hunks = p.hunks === undefined ? undefined : asStringArray(p.hunks, 'hunks', { unique: true, maxItems: 5_000, maxItemLen: 128 })
  let lines: GitIncludeRequest['lines']
  if (p.lines !== undefined) {
    if (!Array.isArray(p.lines) || p.lines.length > 5_000) throw new DomainRpcError('invalid_params', 'lines must be a list of { hunk, indexes }')
    lines = p.lines.map((item, at) => {
      if (!isObject(item) || !Array.isArray(item.indexes) || item.indexes.length > 100_000 || !item.indexes.every((index) => Number.isSafeInteger(index) && (index as number) >= 0)) throw new DomainRpcError('invalid_params', `lines[${at}] must be { hunk, indexes }`)
      return { hunk: asString(item.hunk, `lines[${at}].hunk`, 128), indexes: item.indexes as number[] }
    })
  }
  return { ...(hunks?.length ? { hunks } : {}), ...(lines?.length ? { lines } : {}) }
}

/** Methods that rewrite a project folder's files or HEAD from the chat: the "everything left out" marker no longer says what the person chose. */
const CLEARS_PROJECT_SELECTION = new Set(['actions.undoLatest', 'actions.redo', 'actions.revertCode', 'actions.activateBranch'])

/** After chat Undo, Redo, revert or a branch switch of a thread working in its project's folder: the project's marker goes. */
async function clearProjectSelectionAfter(ctx: HandlerContext, method: string, params: unknown): Promise<void> {
  if (!CLEARS_PROJECT_SELECTION.has(method) || !isObject(params)) return
  const threadId = asOptionalString(params.threadId, 256)
  const thread = threadId ? ctx.mms.threads.getThread(threadId) : undefined
  if (!thread?.projectId || threadPlacement(thread) !== 'project-folder') return
  try {
    await clearMarker(join(projectKeptFilesOwner(profileHome(ctx), thread.projectId), PROJECT_SELECTION_MARKER))
    ctx.emitEvent?.('git.selectionChanged', { projectId: thread.projectId, threadId: thread.id }, thread.id)
  } catch {
    /* the marker only remembers "everything left out"; a stale one is cleared by the next index change */
  }
}

/**
 * Runs a switch, pull or abort in a project folder: when it moved HEAD, the project's "everything left out" marker goes
 * (any HEAD change ends it, so switching away and back does not bring it back) and views read the selection again.
 */
async function clearingSelectionWhenHeadMoves<T>(ctx: HandlerContext, p: Record<string, unknown>, target: GitMutationTarget, work: () => Promise<T>): Promise<T> {
  const marker = threadWorktree(target) ? undefined : selectionMarkerOf(() => selectionPlaceFor(ctx, p, target.root))
  const { result, moved } = await ctx.mms.gitService.clearingMarkerWhenHeadMoves(target.root, marker, work)
  const projectId = moved ? requestProjectId(ctx, p) : undefined
  if (projectId) {
    const threadId = asOptionalString(p.threadId, 256)
    ctx.emitEvent?.('git.selectionChanged', { projectId, ...(threadId ? { threadId } : {}) }, threadId)
  }
  return result
}

/** The marker of a project folder's selection, for the index writes that keep it; none in a thread's worktree. */
function selectionMarkerOf(place: () => SelectionPlace): { markerFile: string } | undefined {
  let found: SelectionPlace
  try { found = place() } catch { return undefined }
  return found.kind === 'project' ? { markerFile: found.markerFile } : undefined
}

/**
 * Whose journal records the reverts of the folder a request names, as `git.revert` chooses it (`recordedThreadTarget`):
 * a thread working in its own worktree, or ready in its project's folder; otherwise the project. Only reads.
 */
function revertOwnerFor(ctx: HandlerContext, p: Record<string, unknown>): string | undefined {
  const threadId = asOptionalString(p.threadId, 256)
  if (threadId) {
    const directory = ctx.mms.threads.getThreadDir(threadId)
    const workspace = new ThreadWorkspaceManager(directory).load()
    if (workspace && (!isProjectFolderWorkspace(workspace) ? threadPlacement(ctx.mms.threads.getThread(threadId)) !== 'project-folder' : workspace.lifecycle === 'ready')) return directory
  }
  const projectId = requestProjectId(ctx, p)
  try { return projectId ? projectKeptFilesOwner(profileHome(ctx), projectId) : undefined } catch { return undefined }
}

/**
 * Every journal the reverts of the folder a request names may be in, `revertOwnerFor`'s first: a thread's own and its
 * project's. A thread working in its project's folder records its reverts in its own journal only while it is ready
 * there, and the project records them otherwise, so a revert made in one state is still listed and restored in the
 * other. Each record names its folder, so a journal's reverts of other folders are never taken. Only reads.
 */
function revertJournalsFor(ctx: HandlerContext, p: Record<string, unknown>): string[] {
  const journals: string[] = []
  const first = revertOwnerFor(ctx, p)
  if (first) journals.push(first)
  const threadId = asOptionalString(p.threadId, 256)
  if (threadId) {
    const directory = ctx.mms.threads.getThreadDir(threadId)
    if (new ThreadWorkspaceManager(directory).load()) journals.push(directory)
  }
  const projectId = requestProjectId(ctx, p)
  try { if (projectId) journals.push(projectKeptFilesOwner(profileHome(ctx), projectId)) } catch { /* no project: the thread's journal only */ }
  return [...new Set(journals)]
}

/** Whose Undo window a Discard requested with these parameters keeps its copy for; only reads. */
function discardOwnerFor(ctx: HandlerContext, p: Record<string, unknown>): string | undefined {
  const threadId = asOptionalString(p.threadId, 256)
  if (threadId) {
    const directory = ctx.mms.threads.getThreadDir(threadId)
    if (new ThreadWorkspaceManager(directory).load()) return directory
  }
  const projectId = requestProjectId(ctx, p)
  try { return projectId ? projectKeptFilesOwner(profileHome(ctx), projectId) : undefined } catch { return undefined }
}

async function gitStatusResult(ctx: HandlerContext, root: string, extra: Record<string, unknown> = {}): Promise<{ status: GitStatusSnapshot }> {
  return { status: await ctx.mms.gitService.getStatus(root), ...extra } as { status: GitStatusSnapshot }
}

/**
 * Which paths a caller may name inside a folder. A call from another of the user's computers holds to what is
 * on disk (links, junctions and short names are resolved, `.git` and hook folders cannot be changed); a window of
 * this computer, and the other callers of this computer, keep to how the path is spelled.
 */
function guardFor(ctx: HandlerContext): PathGuard {
  const caller = ctx.connection?.bridgeCaller
  // The device's limit decides which files a save may change (those that start programs by themselves need Full access).
  return caller ? routedGuardFor(caller.maxPermissionMode) : lexicalGuard
}

/** A refusal of the guard is a result with its own code; any other error is left as it is. */
function refusedPath(error: unknown): unknown {
  return error instanceof PathContainmentError ? new DomainRpcError(error.code, error.message) : error
}

/** An action that failed only because the guard refused its path (found out as it wrote) is that refusal. */
function refusalOfAction(error: unknown): never {
  const cause = error instanceof ActionExecutionError ? error.cause : error
  throw cause instanceof PathContainmentError ? refusedPath(cause) : error
}

function containedPath(ctx: HandlerContext, root: string, value: unknown, intent: PathIntent = 'read'): string {
  const path = asOptionalString(value, 4096) ?? ''
  try {
    return guardFor(ctx).resolve(root, path, intent).relative
  } catch (error) {
    throw refusedPath(error)
  }
}

function requiredContainedPath(ctx: HandlerContext, root: string, value: unknown, intent: PathIntent = 'read'): string {
  return containedPath(ctx, root, asString(value, 'path', 4096), intent)
}

function asReviewScope(value: unknown): ReviewScope {
  if (!isObject(value)) throw new DomainRpcError('invalid_params', 'scope is required')
  const kind = asString(value.kind, 'scope.kind', 16)
  if (kind === 'turn') return { kind, turnId: asString(value.turnId, 'scope.turnId', 256) }
  if (kind === 'thread') return { kind }
  if (kind === 'worktree') return asOptionalBoolean(value.staged, 'scope.staged') === true ? { kind, staged: true } : { kind }
  throw new DomainRpcError('invalid_params', 'Unknown review scope')
}

interface ReviewTarget {
  scope: ReviewScope
  root: string
  range: ReviewRange
  unavailable?: string
  /** The thread whose turns are read: Git in `root` goes through its hidden store, when it records turns in one. */
  threadDirectory?: string
}

/** Reads a review target: a thread's turns through its own store, anything else (the working tree) as the folder is. */
function readReview<T>(target: ReviewTarget, read: () => Promise<T>): Promise<T> {
  return target.threadDirectory ? inThreadSnapshotScopeAsync(target.threadDirectory, target.root, read) : read()
}

/** Resolves a review scope to the root it reads from and the Git range it compares. */
async function reviewTarget(ctx: HandlerContext, p: Record<string, unknown>): Promise<ReviewTarget> {
  const scope = asReviewScope(p.scope)
  // Every scope reads the thread's checkout (the turn and thread scopes run Git in it), so bring it back first.
  await materializeRequestedWorkspace(ctx, p)
  if (scope.kind === 'worktree') {
    const root = projectRootContext(ctx, p)
    if (!await isGitRepository(root)) return { scope, root, range: { from: null, to: { kind: 'worktree' } }, unavailable: 'Not a Git repository.' }
    return { scope, root, range: await worktreeRange(root, scope.staged === true) }
  }
  // Turns and the thread's base belong to a thread's own worktree; a project id has neither.
  if (p.projectId !== undefined) throw new DomainRpcError('invalid_params', 'Turn and thread scopes need a threadId, not a projectId')
  const lookup = threadLookupContext(ctx, p)
  const resolved = await resolveReviewScope(lookup.threadDirectory, scope)
  if (!resolved) {
    return { scope, root: lookup.projectPath ?? '', range: { from: null, to: { kind: 'worktree' } }, unavailable: 'This thread has no worktree of its own, so its changes cannot be reviewed.' }
  }
  return { scope, root: resolved.cwd, range: resolved.range, unavailable: resolved.unavailable, threadDirectory: lookup.threadDirectory }
}

function buildSendInput(
  content: string,
  mode: ReturnType<typeof asOptionalChatMode>,
  images: ReturnType<typeof asOptionalChatImages>
): OrchestratorSendInput {
  if (mode !== undefined || images !== undefined) {
    const req: OrchestratorSendRequest = { content }
    if (mode !== undefined) req.mode = mode
    if (images !== undefined) req.images = images
    return req
  }
  return content
}

function badPlan(message: string): AppError {
  return knownAppError({ code: 'storage_plan_invalid', message }, { category: 'invalid', retryable: false })
}

/** The token a dry run issued, as a client returns it. Anything else is refused rather than guessed. */
function asPlanToken(value: unknown): StorageCleanupPlanToken {
  const raw = isObject(value) ? value : {}
  const time = (input: unknown, name: string): number => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) throw badPlan(`Invalid plan ${name}`)
    return input
  }
  if (!Array.isArray(raw.keys) || raw.keys.length > 20_000 || raw.keys.some((key) => typeof key !== 'string' || key.length === 0 || key.length > 512)) throw badPlan('Invalid plan keys')
  return { issuedAt: time(raw.issuedAt, 'time'), expiresAt: time(raw.expiresAt, 'expiry'), policyDigest: asString(raw.policyDigest, 'policyDigest', 128), keys: raw.keys as string[] }
}

/**
 * The matches of this computer and of the others in one list: thread matches, then project matches, then
 * message matches, this computer's first within each kind, cut to `limit`.
 */
function mergeSearchResults(local: ThreadSearchResult[], remote: ThreadSearchResult[], limit: number): ThreadSearchResult[] {
  const out: ThreadSearchResult[] = []
  for (const kind of ['thread', 'project', 'message'] as const)
    for (const result of [...local, ...remote]) if (result.matchType === kind) out.push(result)
  return out.slice(0, limit)
}

/** Transcripts a routed search reads: the newest threads, as the agent tool's search does. */
const ROUTED_SEARCH_MESSAGE_THREADS = 100

function lifecycleExpectedGeneration(params: Record<string, unknown>): number | undefined {
  const value = params.expectedGeneration
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new DomainRpcError('invalid_params', 'Invalid lifecycle expectedGeneration')
  return value as number
}

/**
 * The rules of a delete that hold before anything moves: a listed thread must be archived (it, or the thread at the
 * top of its subagent chain), and deleting is permanent, so it stays on the computer that runs the thread; another
 * computer can archive it. A thread a delete left in the trash is not listed and goes on to be finished.
 */
function refuseDelete(ctx: HandlerContext, threadId: string): void {
  const listed = ctx.mms.threads.getThread(threadId)
  const root = listed?.lineage?.rootThreadId
  if (listed && !listed.settledAt && !(root && root !== threadId && ctx.mms.threads.getThread(root)?.settledAt))
    throw new DomainRpcError('thread_not_archived', ARCHIVE_BEFORE_DELETE, { threadId })
  if (ctx.connection?.clientType === 'bridge') throw new DomainRpcError('not_available_remotely', 'Delete the thread on the computer that runs it.', { threadId })
}

export async function dispatchMethod(
  ctx: HandlerContext,
  method: string,
  params: unknown
): Promise<unknown> {
  // Git commands a method runs are checked against what it declares in GIT_ACCESS; a mismatch is logged.
  const access = gitAccessOf(method)
  // A button whose handler carries out the user's request without passing it down runs as that request.
  const label = (USER_REQUEST_LABELS as Record<string, string | undefined>)[method]
  const run = label ? () => withUserRequest(gitUserAction(ctx, label), () => dispatchAdmitted(ctx, method, params)) : () => dispatchAdmitted(ctx, method, params)
  const result = await (access ? withGitAccess(method, access, run) : run())
  await clearProjectSelectionAfter(ctx, method, params)
  return result
}

function dispatchAdmitted(ctx: HandlerContext, method: string, params: unknown): Promise<unknown> {
  // Installation lifecycle commands must not wait on themselves in a personal
  // request barrier. Every actual personal service has this ownership method;
  // the fallback preserves legacy isolated handler test doubles.
  if (!isInstallationMethod(method) && ctx.mms.runOwnedRequest) {
    return ctx.mms.runOwnedRequest(method, () => dispatchOwnedMethod(ctx, method, params))
  }
  return dispatchOwnedMethod(ctx, method, params)
}

/** The profile's harness gateway; `not_implemented` until it is composed. */
function harnessGateway(ctx: HandlerContext): HarnessGateway {
  if (ctx.mms.harness) return ctx.mms.harness
  throw harnessAppError({ code: 'not_implemented', message: 'Provider instances are not available in this build yet.' })
}


/** A scheduled-job request the profile refuses, with a message the person can act on (a plain Error would be hidden). */
const SCHEDULED_SETTING_KEYS: readonly string[] = ['agentJobs', ...Object.values(AGENT_JOB_LIMIT_SETTINGS)]

function scheduledSettings(config: MousseConfigStore): ScheduledSettings {
  const limits = config.agentJobLimits()
  return {
    agentJobs: config.agentJobsEnabled(),
    agentJobMaxActive: limits.maxActive,
    agentJobMinIntervalMinutes: limits.minIntervalMinutes,
    agentJobLifetimeDays: limits.lifetimeDays
  }
}

function jobRefused(message: string): AppError {
  return knownAppError({ code: 'scheduled_job_refused', message }, { category: 'invalid', retryable: false })
}

/** Runs a webhook request; the service's refusals ("already has a webhook", "agent-created jobs ...") reach the caller as readable errors. */
async function withWebhookRefusals<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (error instanceof ScheduledWebhookError) throw jobRefused(error.message)
    throw error
  }
}

/** A refusal of a job's permission fields reaches the caller as a readable error. */
function withPermissionRefusals<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof JobPermissionRefused) throw jobRefused(error.message)
    throw error
  }
}

/**
 * A thread-event trigger as the daemon stores it: the thread must have a pull request linked (its number is read from
 * the link), and the job runs on demand otherwise. Refusals are readable.
 */
function threadEventTrigger(ctx: HandlerContext, input: { threadId: string; events: ThreadEventKind[]; number?: number }, schedule: { kind: string }): ScheduledThreadEventTrigger {
  if (schedule.kind !== 'manual') throw jobRefused('An automation that wakes on a pull request has no clock: its When is the pull request.')
  const thread = ctx.mms.threads.getThread(input.threadId)
  if (!thread || thread.botOwned) throw jobRefused('That thread is gone.')
  // Another computer never reaches a private thread here, not even as the pull request an automation wakes on.
  if (ctx.connection?.bridgeCaller && privateThreadOf(ctx.mms.threads)(thread.id)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId: input.threadId })
  const link = thread.pullRequest
  if (!link) throw jobRefused('That thread has no pull request linked. Link it from the thread first.')
  // The number the page showed is checked against the link: a thread relinked meanwhile is not watched by surprise.
  if (input.number !== undefined && input.number !== link.number) throw jobRefused(`That thread's pull request is #${link.number} now.`)
  return { threadId: thread.id, number: link.number, events: input.events }
}

/** `validateScheduledJobOptions` with its plain-text refusals made visible to the caller. */
function checkJobOptions(ctx: HandlerContext, job: Parameters<typeof validateScheduledJobOptions>[0]): ReturnType<typeof validateScheduledJobOptions> {
  try {
    return validateScheduledJobOptions(job, scheduledJobOptionsDeps(ctx))
  } catch (error) {
    if (error instanceof AppError) throw error
    throw jobRefused(error instanceof Error ? error.message : String(error))
  }
}

/**
 * Run now and Resume from another computer (also an update that turns it on): the job's runs may not be wider than
 * what this computer lets that device run (its limit may have been lowered since the job was made, or the job may be
 * one a person made here). A run asks for the job's mode, else its thread's. A person here is not limited by it.
 */
function refuseAboveDeviceLimit(ctx: HandlerContext, job: ScheduledJob | undefined): void {
  const limit = deviceLimit(ctx)
  if (!limit || !job) return
  const runs = jobPermissionRequest(job) ?? ctx.mms.orchestrator.scheduledCreatorCeiling(job.threadId)
  if (!isStricter(limit, runs)) return
  throw new DomainRpcError('permission_mode_above_ceiling', `It runs in ${describePermissionMode(runs)}; this computer lets your device run ${describePermissionMode(limit)} at most. Lower its mode there, or raise the limit for this device on that computer, in Settings, Devices.`, { id: job.id, limit, reason: 'device_limit' })
}

/** An automation of another computer () that reached this one's store (routing is off): never acted on here. */
function refuseOtherComputersJob(id: string): void {
  if (parseQualifiedId(id)) throw new DomainRpcError('computer_offline', 'Your other computers are not connected. Turn on working on threads of your other computers in Settings, Devices.', { id })
}

/** The profile services the scheduled-job checks read (model, mode and workspace of a job). */
function scheduledJobOptionsDeps(ctx: HandlerContext): ScheduledJobOptionsDeps {
  return scheduledJobOptionsDepsFrom({
    providerInstances: ctx.mms.providerInstances,
    harness: () => harnessGateway(ctx),
    projects: ctx.mms.projects,
    threads: ctx.mms.threads
  })
}

/**
 * Methods that read or write a project folder synchronously (Git, files, the checkout, project config). They
 * wait for the folder's volume first; every other method (Stop, thread metadata, queues, settings) answers
 * at once whatever a folder is waiting for.
 */
const FOLDER_METHOD_PREFIXES = ['git.', 'files.', 'workspace.', 'review.', 'actions.', 'pullRequests.', 'publish.', 'skills.']
const FOLDER_METHODS = new Set([
  'projects.open', 'projects.identity', 'projects.trustGitSettings', 'projects.icon', 'projects.setIcon', 'orchestrator.send', 'orchestrator.retry',
  'thread.fork', 'thread.mergeBack', 'threads.setWorktreeEnabled', 'threads.delete', 'agents.spawn', 'tasks.create',
  'pty.create', 'editor.folder', 'github.cloneRepository', 'github.createRepository', 'mcp.getConfigSources',
  'mcp.listServers', 'mcp.writeCursorConfig', 'storage.cleanup.plan', 'storage.cleanup.run'
])
/** Methods under those prefixes that only signal work already in memory. */
const FOLDER_FREE_METHODS = new Set(['git.cancelOperation', 'pullRequests.watchStatus'])

/** Methods that start a turn: like the turn, they wait for a volume that is not answering instead of failing. */
const WAIT_WHEN_NOT_ANSWERING = new Set(['orchestrator.send', 'orchestrator.retry'])

function readsFolder(method: string): boolean {
  if (FOLDER_FREE_METHODS.has(method)) return false
  return FOLDER_METHODS.has(method) || FOLDER_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))
}

/**
 * Waits for the folders a request works in. A Stop of its thread or the profile's shutdown ends the wait
 * with an error, so neither waits on a pending macOS permission prompt.
 */
async function waitForRequestFolders(ctx: HandlerContext, method: string, params: unknown): Promise<void> {
  if (!readsFolder(method)) return
  const folders = requestFolders(ctx, params)
  if (folders.length === 0) return
  const threadId = isObject(params) && typeof params.threadId === 'string' ? params.threadId : undefined
  const shutdown = ctx.mms.requestShutdownSignal
  // A volume that stopped answering fails other requests at once, so polls do not pile up behind it.
  const whenNotAnswering = WAIT_WHEN_NOT_ANSWERING.has(method) ? 'wait' as const : 'fail' as const
  let waited: 'ready' | 'stopped' | 'aborted'
  try {
    waited = ctx.mms.orchestrator?.waitForThreadFolders
      ? await ctx.mms.orchestrator.waitForThreadFolders(threadId, folders, shutdown, { whenNotAnswering })
      : await waitForFolderAccess(folders, { signal: shutdown, whenNotAnswering }).then(() => 'ready' as const, (error: unknown) => {
        if (error instanceof FolderNotAnsweringError) throw error
        return 'aborted' as const
      })
  } catch (error) {
    if (error instanceof FolderNotAnsweringError) throw new DomainRpcError('folder_not_answering', error.message, { volume: error.volume })
    throw error
  }
  if (waited === 'stopped') throw new DomainRpcError('thread_stopped', 'The thread was stopped before this request started.', { threadId })
  if (waited === 'aborted') throw Object.assign(new Error('Profile work is shutting down'), { code: 'profile_draining' })
}

/** Parameters that name a folder by its absolute path. A relative `path` is a file inside the project and is skipped. */
const FOLDER_PARAMS = ['path', 'cwd', 'root', 'projectPath', 'workspacePath', 'folder', 'directory'] as const

/** The project folders a request names: its thread's project, its project, or a folder path. */
function requestFolders(ctx: HandlerContext, params: unknown): string[] {
  if (!isObject(params)) return []
  const folders: string[] = []
  try {
    if (typeof params.threadId === 'string') {
      const path = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, params.threadId)
      if (path) folders.push(path)
    }
    if (typeof params.projectId === 'string') {
      const path = ctx.mms.projects.getProject(params.projectId)?.path
      if (path) folders.push(path)
    }
  } catch {
    // An unknown thread or project is the handler's to report.
  }
  for (const key of FOLDER_PARAMS) {
    const value = params[key]
    if (typeof value === 'string' && isAbsolute(value)) folders.push(value)
  }
  return folders
}

async function dispatchOwnedMethod(ctx: HandlerContext, method: string, params: unknown): Promise<unknown> {
  // A call that names a thread (or project) of another of the user's computers goes to that computer.
  // This runs inside the profile's request barrier, so such calls drain with the profile.
  if (ctx.mms.threadRouter) {
    const routed = await ctx.mms.threadRouter.dispatch(ctx, method, params)
    if (routed) return routed.result
  }
  if (isObject(params) && typeof params.threadId === 'string' &&
      !['threads.delete', 'threads.inventory', 'threads.focus',
        // These name the thread only so a router can find its computer; they worked for a thread being trashed before.
        'orchestrator.answerQuestions', 'orchestrator.dismissQuestions', 'runs.get', 'runs.resumeNow', 'runs.cancelPause',
        'git.cancelOperation', 'pty.isAlive', 'pty.lookup', 'pty.write', 'pty.resize', 'pty.kill'].includes(method) &&
      ctx.mms.threads?.lifecycleStore?.get(params.threadId)) {
    ctx.mms.threads.assertThreadAdmission(params.threadId)
  }
  // A browsed folder is checked before its volume is waited for, so one that is refused (a network share, a
  // device path, a caller that is not this computer's window) is never touched.
  if (BROWSED_ROOT_METHODS.has(method) && isObject(params)) browsedFilesRoot(ctx, params)
  // Before any synchronous work in the folder: a pending macOS permission prompt then holds only this request.
  await waitForRequestFolders(ctx, method, params)
  if (ctx.mms.domains?.has(method)) return ctx.mms.domains.dispatch(ctx, method, params)
  switch (method) {
    case 'threads.focus': {
      // A window keeps a thread of another computer in view (the stream its events travel on), or lets go.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'focused'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const focused = asOptionalBoolean(p.focused, 'focused') !== false
      return ctx.mms.threadRouter?.focus(ctx, threadId, focused) ?? { routed: false, focused: false }
    }
    case 'applets.get':
    case 'applets.state.get':
    case 'applets.state.save':
    case 'applets.export': {
      if (!isObject(params)) throw new Error('Expected applet request.')
      if (params.profileId !== undefined && params.profileId !== ctx.mms.profileId) throw new Error('Applet profile binding changed.')
      const allowed = new Set(['profileId', 'threadId', 'appletId', 'revisionId', ...(method === 'applets.state.save' ? ['state'] : []), ...(method === 'applets.export' ? ['format','appearance'] : [])])
      if (Object.keys(params).some(key => !allowed.has(key))) throw new Error('Unexpected applet request field.')
      const threadId = asString(params.threadId, 'threadId', 160)
      const appletId = asString(params.appletId, 'appletId', 80)
      const revisionId = asString(params.revisionId, 'revisionId', 80)
      const messages = ctx.mms.threads.loadThreadData(threadId).messages
      const visible = messages.some(message => !message.hidden && message.role === 'assistant' && !message.incomplete && !message.streaming && message.presentationParts?.some(part => part.type === 'applet' && part.reference.appletId === appletId && part.reference.revisionId === revisionId))
      if (!visible) throw new DomainRpcError('applet_unavailable', 'Applet is not available in this conversation.')
      if (method === 'applets.get') return ctx.mms.applets.load(threadId, appletId, revisionId)
      if (method === 'applets.state.get') return {state: ctx.mms.applets.loadState(threadId, appletId, revisionId)}
      if (method === 'applets.state.save') {
        if (appletJsonBytes(params.state) > APPLET_STATE_LIMIT) throw new DomainRpcError('applet_state_too_large', 'Applet state is too large.')
        ctx.mms.applets.saveState(threadId, appletId, revisionId, params.state)
        return {saved:true}
      }
      if (params.format === 'html') return {content:ctx.mms.applets.exportHtml(threadId, appletId, revisionId, params.appearance===undefined?undefined:validateAppletAppearance(params.appearance))}
      if (params.format === 'source') return {content:ctx.mms.applets.exportSource(threadId, appletId, revisionId)}
      throw new Error('Unsupported applet export format.')
    }
    case 'health':
      return {
        ok: true,
        home: ctx.mms.getHomeDir(),
        owner: ctx.mms.getOwnerRecord()
          ? {
              kind: ctx.mms.getOwnerRecord()!.kind,
              pid: ctx.mms.getOwnerRecord()!.pid,
              protocolVersion: ctx.mms.getOwnerRecord()!.protocolVersion
            }
          : null,
        sequence: ctx.globalSequence()
      }
    case 'capabilities':
      return {
        protocolVersion: MMS_PROTOCOL_VERSION,
        capabilities: [...PROTOCOL_CAPABILITIES, ...(ctx.mms.domains?.capabilities() ?? [])],
        methods: [...PROTOCOL_METHODS, ...(ctx.mms.domains?.methods() ?? [])]
      }
    case 'projects.list':
      return { projects: listedProjectsFor(ctx, ctx.mms.projects.listProjects()) }
    case 'chatReferences.resolve': {
      const p = isObject(params) ? params : {}
      const candidate = parseChatReference(p.reference)
      if (!candidate || (candidate.kind !== 'project' && candidate.kind !== 'thread')) {
        throw new DomainRpcError('invalid_params', 'A valid project or thread reference is required')
      }
      const resolver = new ChatReferenceMetadataResolver(
        ctx.mms.threads,
        ctx.mms.projects,
        ctx.mms.getProfileHomeDir()
      )
      // Another device never learns a private thread's name or project from a reference to it.
      if (candidate.kind === 'thread' && !connectionIsLocal(ctx.connection) && candidate.threadId) {
        const thread = ctx.mms.threads.getThread(candidate.threadId)
        if (thread && isLocalOnlyThread(thread, ctx.mms.threads.listAllThreads())) return { reference: null }
      }
      return { reference: resolver.resolve(candidate) }
    }
    case 'projects.open': {
      const p = isObject(params) ? params : {}
      const path = asString(p.path, 'path', 4096)
      const project = ctx.mms.projects.openProject(path)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects: listedProjectsFor(ctx, projects) }
    }
    case 'projects.identity': {
      // The repository identity of one project, for matching it with a project on another
      // computer; null when it is not a Git repository. Never sent anywhere with its path.
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      const project = ctx.mms.projects.getProject(projectId)
      if (!project) return { identity: null }
      // By the repository the folder is in, so a subfolder or a linked folder has its repository's identity.
      const identity = await repositoryIdentitiesFor(ctx.mms).of(project.path)
      return { identity: identity ? { roots: identity.roots, remotes: identity.remotes } : null }
    }
    case 'projects.remove': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      ctx.mms.projects.removeProject(projectId)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { projects: listedProjectsFor(ctx, projects) }
    }
    case 'projects.rename': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      const name = asString(p.name, 'name', 512)
      const project = ctx.mms.projects.renameProject(projectId, name)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects: listedProjectsFor(ctx, projects) }
    }
    case 'projects.pin': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      const pinned = asOptionalBoolean(p.pinned, 'pinned') === true
      const project = ctx.mms.projects.setProjectPinned(projectId, pinned)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects: listedProjectsFor(ctx, projects) }
    }
    case 'projects.trustGitSettings': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      return ctx.mms.projects.trustGitSettings(projectId)
    }
    case 'projects.icon': {
      // The icon of a project of this computer, as a checked image data URL; null shows the folder glyph. Only a
      // window on this computer reads it: a chosen icon can be any image file the user can read.
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      const project = connectionIsLocal(ctx.connection) ? ctx.mms.projects.getProject(projectId) : undefined
      if (!project) return { icon: null }
      return { icon: await projectIconFor(project, ctx.mms.projects) }
    }
    case 'projects.setIcon': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      if (!connectionIsLocal(ctx.connection)) throw new DomainRpcError('forbidden', 'A project icon is set on its own computer')
      const mode = asString(p.mode, 'mode', 16)
      let choice: ProjectIconChoice
      if (mode === 'auto' || mode === 'off') choice = { mode }
      else if (mode === 'custom') {
        const project = ctx.mms.projects.getProject(projectId)
        if (!project) throw new DomainRpcError('project_not_found', 'Project not found', { projectId })
        const path = asString(p.path, 'path', 4096)
        if (!(await readIconFile(resolveStoredIconPath(project.path, path)))) {
          throw new DomainRpcError('invalid_params', 'Choose an SVG, PNG, ICO, JPEG, WebP or GIF image up to 512 KB')
        }
        choice = { mode, path }
      } else throw new DomainRpcError('invalid_params', 'mode must be auto, off or custom')
      const project = ctx.mms.projects.setProjectIcon(projectId, choice)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects: listedProjectsFor(ctx, projects) }
    }
    case 'projects.reorder': {
      const p = isObject(params) ? params : {}
      // A window sends the whole list, the other computers' projects included; those follow this
      // computer's own and are not reordered here.
      const projectIds = asStringArray(p.projectIds, 'projectIds', { unique: true }).filter(
        (id) => ctx.connection?.clientType !== 'gui' || !isQualifiedId(id)
      )
      const projects = ctx.mms.projects.reorderProjects(projectIds)
      ctx.emitEvent?.('projects.updated', { projects })
      return { projects: listedProjectsFor(ctx, projects) }
    }
    case 'threads.list': {
      const p = isObject(params) ? params : {}
      const projectId = asOptionalString(p.projectId)
      const inventory = ctx.mms.threads.listAllThreads()
      const threads = projectId ? ctx.mms.threads.listThreads(projectId) : inventory
      // One project's list gets only the rows of other computers that belong to that project.
      return { threads: listedThreadsFor(ctx, threads, inventory, projectId ? { projectId } : undefined) }
    }
    case 'threads.get': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const thread = ctx.mms.threads.getThread(threadId)
      if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      return { thread }
    }
    case 'threads.create': {
      const p = isObject(params) ? params : {}
      const name = asString(p.name, 'name', 512)
      const projectId = asOptionalString(p.projectId, 256)
      const worktreeEnabled = asOptionalBoolean(p.worktreeEnabled, 'worktreeEnabled')
      // A private thread is started on this computer only, from its own window or CLI.
      const localOnly = asOptionalBoolean(p.localOnly, 'localOnly') === true
      if (localOnly && !connectionIsLocal(ctx.connection))
        throw new DomainRpcError('invalid_params', 'A private thread can only be started on its own computer')
      const expiresAt = asOptionalString(p.expiresAt, 64)
      const expiryStopsRun = asOptionalBoolean(p.expiryStopsRun, 'expiryStopsRun') === true
      const expiryProblem = expiresAt === undefined ? undefined : expiryRefusal(expiresAt)
      if (expiryProblem) throw new DomainRpcError('invalid_params', expiryProblem)
      const projectPath = projectId
        ? ctx.mms.projects.getProject(projectId)?.path
        : undefined
      // A new worktree started from a branch of the project other than the one its folder is on: its tip, read now.
      const baseBranch = asOptionalString(p.baseBranch, 256)
      let worktreeStart: { sha: string; branch: string } | undefined
      if (baseBranch) {
        if (!projectPath || worktreeEnabled !== true) throw new DomainRpcError('invalid_params', 'A base branch needs a project and a new worktree')
        let sha: string
        try {
          // A plain branch name only: revision syntax such as `main~1` or `main@{1}` would name some other commit.
          await workspaceGitAsync(projectPath, ['check-ref-format', `refs/heads/${baseBranch}`])
          sha = await workspaceGitAsync(projectPath, ['rev-parse', '--verify', '--end-of-options', `refs/heads/${baseBranch}^{commit}`])
        } catch {
          throw new DomainRpcError('invalid_params', `Branch ${baseBranch} was not found`)
        }
        worktreeStart = { sha, branch: baseBranch }
      }
      let thread = ctx.mms.threads.createThread(name, projectId, projectPath, { worktreeEnabled, localOnly, expiresAt, expiryStopsRun, ...(worktreeStart ? { worktreeStart } : {}) })
      if (expiresAt) ctx.mms.threadExpiry?.reschedule()
      const lastUsed = ctx.mms.providerInstances.migrate(lastUsedChatModel(ctx.mms.settings.get()))
      if (lastUsed) {
        thread = ctx.mms.threads.updateThreadMeta(thread.id, { modelOverride: lastUsed })
      }
      const threads = listedThreadsFor(ctx, ctx.mms.threads.listAllThreads())
      return { thread, threads }
    }
    case 'threads.delete': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      // Archive first, then delete: only an archived thread is deleted, and for good. One a delete left in the trash is finished.
      try {
        refuseDelete(ctx, threadId)
        const lifecycle = await ctx.mms.deleteThreadForGood(threadId, {
          human: ctx.connection?.clientType === 'gui',
          discard: asOptionalBoolean(p.discard, 'discard') === true,
          operationId: asOptionalString(p.operationId, 256),
          expectedGeneration: lifecycleExpectedGeneration(p)
        })
        const threads = ctx.mms.threads.listAllThreads()
        return { threads: listedThreadsFor(ctx, threads), lifecycle }
      } finally {
        // Also after a refusal: a thread put back in Archived shows there again.
        ctx.emitEvent?.('threads.updated', { threads: ctx.mms.threads.listAllThreads() })
      }
    }
    case 'threads.rename': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const name = asString(p.name, 'name', 512)
      const thread = ctx.mms.threads.updateThreadMeta(threadId, { name })
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.clearContext': {
      // `/clear`: its own run, like an Undo, so no turn starts while the context is replaced.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      await localActionRun(ctx, threadId, 'clear', async () => ctx.mms.orchestrator.clearConversationContext(threadId))
      return { ok: true }
    }
    case 'threads.compact': {
      // `/compact`: its own run, so a message sent meanwhile waits in the queue instead of racing the compaction.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'focus'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const focus = asOptionalString(p.focus, 2000)?.trim() || undefined
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      let started = false
      try {
        const ran = await localActionRun(ctx, threadId, 'compact', () => {
          started = true
          return ctx.mms.orchestrator.compactConversationContext(threadId, focus)
        })
        return { outcome: 'result' in ran ? ran.result : 'unchanged' }
      } finally {
        // The run has ended: what waited in the queue goes now, however the compaction ended.
        if (started) ctx.mms.orchestrator.drainQueueAfterCompaction(threadId)
      }
    }
    case 'threads.stopCompaction': {
      // The compaction row's Stop: the running `/compact` ends with the full history kept.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      return { stopped: ctx.mms.orchestrator.stopCompaction(threadId) }
    }
    case 'threads.pin': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const pinned = asOptionalBoolean(p.pinned, 'pinned') === true
      const thread = ctx.mms.threads.setThreadPinned(threadId, pinned)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.settle': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const settled = asOptionalBoolean(p.settled, 'settled') === true
      const thread = ctx.mms.threads.setThreadSettled(threadId, settled)
      // Settling a thread (the sidebar's archive) is a Stop: what it still runs ends with it.
      if (settled) {
        // The watch ends as archived, not as stopped.
        ctx.mms.pullRequestWatch.onEnded(threadId, 'settled')
        await ctx.mms.orchestrator.stopThread(threadId, 'settled').catch((error: unknown) => {
          console.warn('settling a thread could not stop its work', { threadId, error: error instanceof Error ? error.message : String(error) })
        })
      }
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.reorder': {
      const p = isObject(params) ? params : {}
      const projectId = asOptionalString(p.projectId, 256)
      const given = asStringArray(p.threadIds, 'threadIds', { unique: true })
      // A window sends the whole group in the order it was left, with the rows of other computers among
      // them. This computer's own rows are reordered here, and the others take places that keep that order.
      const merged = ctx.connection?.clientType === 'gui' ? ctx.mms.remoteLists : undefined
      const threadIds = merged ? given.filter((id) => !isQualifiedId(id)) : given
      const reorderedHere = !(merged && (isQualifiedId(projectId) || !threadIds.length))
      const threads = reorderedHere ? ctx.mms.threads.reorderThreads(projectId, threadIds) : []
      merged?.reorder(given)
      const all = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads: all })
      return {
        threads: listedThreadsFor(ctx, threads, all, { projectId: projectId ?? null }),
        all: listedThreadsFor(ctx, all)
      }
    }
    case 'threads.search': {
      const p = isObject(params) ? params : {}
      const query = asString(p.query, 'query', 512)
      const limit =
        typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit > 0
          ? Math.min(Math.floor(p.limit), 200)
          : 50
      // Search hides subagents for every client, the desktop app included: a subagent is reached
      // through its parent's Lineage, not as a result of its own.
      // A computer asked by another of the user's computers reads the transcripts of its newest threads only,
      // so a search typed on one computer is bounded work on the others.
      const hidden = connectionIsLocal(ctx.connection) ? undefined : localOnlyThreadIds(ctx.mms.threads.listAllThreads())
      // A personal bot's threads are its chat, never a thread result (`Thread.botOwned`).
      const results = ctx.mms.threads.searchThreads(query, limit, {
        hideSubagents: true,
        allow: (thread: Thread) => !thread.botOwned && !hidden?.has(thread.id),
        ...(ctx.connection?.clientType === 'bridge' ? { maxMessageThreads: ROUTED_SEARCH_MESSAGE_THREADS } : {})
      })
      // A window also searches the user's other computers (each with a short deadline) and is told which it could not.
      const remote =
        ctx.connection?.clientType === 'gui' && ctx.mms.remoteLists
          ? await ctx.mms.remoteLists.search(ctx.connection.id, query, limit)
          : undefined
      if (!remote) return { results }
      return {
        results: mergeSearchResults(results, remote.results, limit),
        ...(remote.skipped.length ? { skipped: remote.skipped } : {})
      }
    }
    case 'thread.snapshot': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const thread = ctx.mms.threads.getThread(threadId)
      if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const session = ctx.mms.orchestrator.getOrCreateSession(threadId)
      const rt = ctx.mms.threadRuntimes.getOrHydrate(threadId)
      // `transcript: false` is a routed reader that already holds the messages and the queue on its stream.
      const withTranscript = asOptionalBoolean(p.transcript, 'transcript') !== false
      const messages = withTranscript ? ctx.mms.orchestrator.getMessages(threadId) : []
      const queue = withTranscript ? ctx.mms.orchestrator.listQueue(threadId) : []
      const claimed = listClaimedQueue(session.queue).filter((item) => !item.internal)
      const turnActive = ctx.mms.orchestrator.isTurnActive(threadId)
      const turnRunning = ctx.mms.orchestrator.isActiveTurnRunning(threadId)
      const connectionFailed =
        session.failedConnectionRequest !== null || rt.connectionFailed
      // A person on another computer is offered "Always" only for what that computer's permission limit allows.
      const limit = deviceLimit(ctx)
      const pendingQuestions = limit ? ctx.mms.questions.listPendingForDevice(threadId, limit) : ctx.mms.questions.listPendingForThread(threadId)
      return {
        thread,
        messages,
        queue,
        claimed,
        agents: rt.agents.list(),
        tasks: rt.tasks.list(),
        ptys: ctx.mms.ptyManager.list(threadId),
        activity: rt.activity,
        pendingQuestions,
        activeTurn: { active: turnActive, running: turnRunning },
        connectionFailed,
        turnState: ctx.mms.orchestrator.getTurnState(threadId),
        turnSnapshot: withoutLocalOnlyKeys(ctx, ctx.mms.orchestrator.getTurnSnapshot()),
        revision: ctx.globalSequence()
      }
    }
    case 'thread.messages': {
      // A page of the messages before one, for a reader that was given only the newest part of a long transcript.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'before', 'limit'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const before = asString(p.before, 'before', 256)
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: MESSAGES_PAGE_MAX }) ?? MESSAGES_PAGE_DEFAULT
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const page = messagesBefore(ctx.mms.orchestrator.getMessages(threadId), before, limit, ROUTED_MESSAGES_PAGE_BYTES)
      if (!page) throw new DomainRpcError('message_not_found', 'That message is not in this thread.', { threadId, before })
      // Images are loaded one at a time when they are shown (`thread.messageImage`).
      return { messages: page.messages.map(withoutImageBytes), ...(page.earlier ? { earlier: page.earlier } : {}) }
    }
    case 'thread.messageImage': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'messageId', 'queueItemId', 'index'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const index = asBoundedInt(p.index, 'index', { min: 0, max: 255 })
      const messageId = asOptionalString(p.messageId, 256)
      const queueItemId = asOptionalString(p.queueItemId, 256)
      if ((messageId === undefined) === (queueItemId === undefined)) throw new DomainRpcError('invalid_params', 'Name a messageId or a queueItemId.')
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const owner = messageId !== undefined
        ? ctx.mms.orchestrator.getMessages(threadId).find((message) => message.id === messageId)
        : ctx.mms.orchestrator.listQueue(threadId).find((item) => item.id === queueItemId)
      const image = imageAt(owner, index)
      if (!image) throw new DomainRpcError('image_not_found', 'There is no such image.', { threadId, ...(messageId !== undefined ? { messageId } : { queueItemId }), index })
      return image
    }
    case 'threads.regenerateTitle': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const messages = ctx.mms.orchestrator.getMessages(threadId)
      const title = await ctx.mms.orchestrator.generateThreadTitle(messages, threadId)
      if (!title) throw new DomainRpcError('title_unavailable', 'The title model returned an empty title.')
      const thread = ctx.mms.threads.updateThreadMeta(threadId, { name: title })
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.setModel': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const model = p.model
      let override: ModelOverride | undefined
      if (model !== undefined && model !== null) {
        if (!isObject(model)) throw new DomainRpcError('invalid_params', 'model must be an object')
        // `instanceId` is the selection (SPEC §13.8); the current GUI still sends `llmProvider`.
        const instanceId = asOptionalString(model.instanceId, 256)
        // A supplied provider name is validated even when the instance decides the stored value.
        const llmProvider = instanceId
          ? (model.llmProvider === undefined ? undefined : asString(model.llmProvider, 'model.llmProvider', 256))
          : asString(model.llmProvider, 'model.llmProvider', 256)
        const modelId = asString(model.model, 'model.model', 512)
        const effort = asOptionalString(model.effort, 64)
        if ((!instanceId && !llmProvider) || !modelId) throw new DomainRpcError('invalid_params', 'Model provider and id are required')
        // Unknown or disabled instances are rejected here, before anything is stored. A level
        // packed into the model (an older client) is moved into its own field.
        override = ctx.mms.providerInstances.overrideFor({ instanceId, llmProvider, model: modelId, ...(effort ? { effort } : {}) })
        // Hidden models and instances the thread's project turned off are rejected too.
        const projectId = ctx.mms.threads.getThread(threadId)?.projectId
        ctx.mms.harness?.resolveStored(override, { purpose: 'composer', scope: projectId ? { kind: 'project', projectId } : { kind: 'device' } })
      }
      const next = ctx.mms.orchestrator.setThreadModelOverride(threadId, override)
      if (next) {
        // The global default keeps the instance, so later default turns resolve the same agent.
        ctx.mms.settings.set({ provider: { instanceId: next.instanceId, llmProvider: next.llmProvider, model: next.model, effort: next.effort, name: next.name } })
        ctx.emitEvent?.('settings.changed', { settings: ctx.mms.settings.get() })
      }
      const thread = ctx.mms.threads.getThread(threadId)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, modelOverride: next, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.setWorktreeEnabled': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const enabled = asOptionalBoolean(p.enabled, 'enabled') === true
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      // Refuse once an isolated workspace exists — the toggle is new-chat only.
      const workspace = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId)).load()
      if (workspace?.lifecycle === 'ready' || workspace?.lifecycle === 'provisioning') {
        throw new DomainRpcError('worktree_locked', 'Worktree mode is locked once a workspace is provisioned.')
      }
      const thread = ctx.mms.threads.setThreadWorktreeEnabled(threadId, enabled)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.setPermissionMode': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'mode'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const mode = asString(p.mode, 'mode', 32)
      if (!isPermissionMode(mode)) throw new DomainRpcError('invalid_params', `mode must be one of ${PERMISSION_MODES.join(', ')}`)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      // Applies from the next turn; a running turn and a pending question are not touched.
      const caller = ctx.connection?.bridgeCaller
      const thread = ctx.mms.orchestrator.setThreadPermissionMode(threadId, mode, caller ? { node: caller.node, maxPermissionMode: caller.maxPermissionMode } : undefined)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.setExpiry': {
      // When the thread deletes itself for good (`Thread.expiresAt`), or null to keep it. A subagent follows its root.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'expiresAt', 'stopsRun'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const thread = ctx.mms.threads.getThread(threadId)
      if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      if (thread.lineage) throw new DomainRpcError('invalid_params', 'A subagent expires with the thread that started it')
      const expiresAt = p.expiresAt === null ? null : asString(p.expiresAt, 'expiresAt', 64)
      const problem = expiresAt === null ? undefined : expiryRefusal(expiresAt)
      if (problem) throw new DomainRpcError('invalid_params', problem)
      // An expired thread is already being deleted; it can no longer be kept.
      if (isThreadExpired(thread)) throw new DomainRpcError('thread_expired', 'This thread has expired and is being deleted.', { threadId })
      const updated = ctx.mms.threads.updateThreadMeta(threadId, {
        expiresAt: expiresAt ?? undefined,
        expiryStopsRun: expiresAt !== null && asOptionalBoolean(p.stopsRun, 'stopsRun') === true ? true : undefined
      }, { touch: false })
      ctx.mms.threadExpiry?.reschedule()
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread: updated, threads: listedThreadsFor(ctx, threads) }
    }
    case 'threads.approvalRules': {
      // The thread's "Always for this thread" rules (SPEC §17.8). Not exposed on the Bridge.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      return { threadId, rules: ctx.mms.orchestrator.listApprovalRules(threadId) }
    }
    case 'threads.approvalRequests': {
      // The thread's saved approval requests with the answers they got, for its transcript. Not exposed on the Bridge.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      return { threadId, requests: ctx.mms.orchestrator.listApprovalRequests(threadId) }
    }
    case 'threads.clearApprovalRules': {
      // Revokes one rule (`ruleId`) or every rule of the thread. Not exposed on the Bridge.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'ruleId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const ruleId = asOptionalString(p.ruleId, 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const { removed } = ctx.mms.orchestrator.clearApprovalRules(threadId, ruleId)
      return { threadId, removed, rules: ctx.mms.orchestrator.listApprovalRules(threadId) }
    }
    case 'orchestrator.send': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, [
        'threadId', 'content', 'forceQueue', 'source', 'mode', 'images', 'requestId', 'workflowInvocationId',
        'clientRequestId', 'await', 'continuationOfRunId', 'acknowledgeUncertain', 'refuseWhilePaused', 'conversationBranchId'
      ])
      const threadId = asString(p.threadId, 'threadId', 256)
      const content = asString(p.content, 'content')
      // A parent's follow-up to a subagent on this computer: a paused thread refuses it, as for a parent here.
      const refuseWhilePaused = asOptionalBoolean(p.refuseWhilePaused, 'refuseWhilePaused') === true
      const forceQueue = asOptionalBoolean(p.forceQueue, 'forceQueue') === true
      const source = admittedChatSource(ctx, asOptionalString(p.source, 64) ?? 'protocol')
      const mode = asOptionalChatMode(p.mode, 'mode')
      const images = asOptionalChatImages(p.images, 'images')
      if (!ctx.mms.threads.getThread(threadId)) {
        throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      }
      // Idempotency key (SPEC §6): a repeat with the same id and text answers with the first send's run.
      // It is not taken from `requestId`, which names a slash workflow's receipt and is optional; the
      // app and the CLI pass the same value in both when a repeat must not run twice.
      const clientRequestId = asOptionalClientRequestId(p.clientRequestId)
      // SPEC §12.7: `ack` returns once the send and its turn.start effect are committed.
      const awaitMode = asOptionalSendAwaitMode(p.await)
      // SPEC §16.4: "Continue" after a restart; an uncertain run needs `acknowledgeUncertain`.
      const continuationOfRunId = asOptionalString(p.continuationOfRunId, 256)
      const acknowledgeUncertain = asOptionalBoolean(p.acknowledgeUncertain, 'acknowledgeUncertain') === true
      if (p.acknowledgeUncertain !== undefined && !continuationOfRunId)
        throw new DomainRpcError('invalid_params', 'acknowledgeUncertain applies only with continuationOfRunId')
      ctx.mms.orchestrator.getOrCreateSession(threadId)
      const prepared = await prepareChatInput(ctx, threadId, { content, mode, images }, p)
      // An edited prompt names the branch it was made for; the turn refuses to run on another.
      const conversationBranchId = asOptionalString(p.conversationBranchId, 256)
      const input = conversationBranchId ? { ...(typeof prepared === 'string' ? { content: prepared } : prepared), conversationBranchId } : prepared
      const limit = deviceLimit(ctx)
      const sentFrom = sentFromOf(ctx)
      return await ctx.mms.orchestrator.send(input, false, {
        threadId,
        source,
        forceQueue,
        clientRequestId,
        awaitMode,
        actor: questionAnswerer(ctx),
        // A turn from another computer never runs looser than that computer's limit here, however the thread is set.
        ...(limit ? { permissionMode: limit } : {}),
        ...(sentFrom ? { sentFrom } : {}),
        ...(refuseWhilePaused ? { refuseWhilePaused } : {}),
        ...(continuationOfRunId ? { continuationOfRunId, acknowledgeUncertain } : {})
      })
    }
    case 'orchestrator.abort': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'clearQueue', 'runId', 'clientRequestId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const clearQueue = asOptionalBoolean(p.clearQueue, 'clearQueue') === true
      const runId = asOptionalString(p.runId, 256)
      if (runId) {
        const clientRequestId = asOptionalClientRequestId(p.clientRequestId) ?? randomUUID()
        return runCommandResponse(await ctx.mms.orchestrator.abortRun(runId, clientRequestId, threadId), runId)
      }
      // With or without a runId a Stop is `stopThread`: the thread and every subagent below it.
      const stopped = await ctx.mms.orchestrator.stopThread(threadId, 'user', { clearQueue, clientRequestId: asOptionalClientRequestId(p.clientRequestId) })
      return { ok: stopped.ok }
    }
    case 'orchestrator.steer': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'text', 'runId', 'clientRequestId', 'source'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const text = asString(p.text, 'text')
      const runId = asOptionalString(p.runId, 256)
      if (runId) {
        const clientRequestId = asOptionalClientRequestId(p.clientRequestId) ?? randomUUID()
        const response = runCommandResponse(await ctx.mms.orchestrator.steerRun(runId, text, clientRequestId, threadId, undefined, undefined, deviceLimit(ctx), sentFromOf(ctx)), runId)
        noteSentFrom(ctx, threadId)
        return response
      }
      // Prefer mid-turn steer; fall back to external enqueue when no local turn.
      const limit = deviceLimit(ctx)
      const result = ctx.mms.orchestrator.steerThreadOrEnqueueExternal(threadId, text, {
        source: admittedChatSource(ctx, asOptionalString(p.source, 64) ?? 'protocol-steer'),
        // Text that cannot join the running turn waits as a turn of its own, at no more than the device's limit.
        ...(limit ? { permissionMode: limit } : {}),
        ...(sentFromOf(ctx) ? { sentFrom: sentFromOf(ctx) } : {})
      })
      noteSentFrom(ctx, threadId)
      return { ok: result.steered || result.queued, steered: result.steered, queued: result.queued }
    }
    case 'orchestrator.retry': {
      const p = isObject(params) ? params : {}
      const threadId = asOptionalString(p.threadId, 256)
      const ok = ctx.mms.orchestrator.retryLastConnection(threadId)
      return { ok }
    }
    case 'runs.list': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'limit'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: 200 }) ?? 50
      return { runs: ctx.mms.runEngine.listRuns(threadId, { limit }) }
    }
    case 'runs.get': {
      const p = isObject(params) ? params : {}
      // `threadId` only routes a call to the computer that runs the thread (the owner checks the run is its).
      rejectUnknownKeys(p, ['runId', 'threadId'])
      const runId = asString(p.runId, 'runId', 256)
      const run = ctx.mms.runEngine.getRun(runId)
      // A run named with a thread is that thread's, or there is none.
      const threadId = asOptionalString(p.threadId, 256)
      if (!run || (threadId !== undefined && run.threadId !== threadId)) throw new DomainRpcError('run_not_found', 'Run not found', { runId })
      return { run }
    }
    case 'runs.events': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'afterSeq', 'limit'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const afterSeq = asOptionalBoundedInt(p.afterSeq, 'afterSeq', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: 500 }) ?? 500
      return {
        events: ctx.mms.runEngine.listEvents(threadId, { afterSeq, limit }),
        maxSeq: ctx.mms.runEngine.maxSeq(threadId)
      }
    }
    case 'runs.effects': {
      // The newest effects of the thread (at most EFFECT_PAGE_MAX), oldest first; `before` pages back.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'limit', 'before'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: EFFECT_PAGE_MAX }) ?? EFFECT_PAGE_MAX
      const before = asOptionalBoundedInt(p.before, 'before', { min: 1, max: Number.MAX_SAFE_INTEGER })
      return ctx.mms.runEngine.outbox.pageForThread(threadId, { limit, before })
    }
    case 'runs.credentials': {
      // Mousse MCP credentials minted for the thread's runs (SPEC §15.1); never the token hash.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      return { credentials: ctx.mms.mcpCredentials.listForThread(threadId) }
    }
    case 'runs.transfers': {
      // Fork and merge-back transfers into or out of the thread (SPEC §16.2).
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      return { transfers: ctx.mms.runEngine.transfers.listForThread(threadId) }
    }
    case 'runs.handoffs': {
      // Context handoffs the thread's turns received (SPEC §16.1).
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      return { handoffs: ctx.mms.runEngine.handoffs.listForThread(threadId) }
    }
    case 'runs.resumeNow': {
      // Continue a run a usage limit paused, now instead of at the reset time. A run that is not paused (the
      // banner has not caught up with a hand-over or a Cancel) is refused `conflict`.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['runId', 'threadId'])
      const runId = asString(p.runId, 'runId', 256)
      return asRpcRejection(() => ctx.mms.orchestrator.resumePausedRun(runId))
    }
    case 'runs.cancelPause': {
      // End a pause without continuing: the run is cancelled and the thread's held messages go on.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['runId', 'threadId'])
      const runId = asString(p.runId, 'runId', 256)
      return asRpcRejection(() => ctx.mms.orchestrator.cancelPausedRun(runId))
    }
    case 'thread.fork': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['sourceThreadId', 'atRunOrdinal', 'title', 'clientRequestId', 'seedFrom'])
      const sourceThreadId = asString(p.sourceThreadId, 'sourceThreadId', 256)
      const atRunOrdinal = p.atRunOrdinal === 'latest_stable'
        ? 'latest_stable' as const
        : asOptionalBoundedInt(p.atRunOrdinal, 'atRunOrdinal', { min: 1, max: Number.MAX_SAFE_INTEGER })
      const title = asOptionalString(p.title, 256)
      const clientRequestId = asOptionalClientRequestId(p.clientRequestId) ?? randomUUID()
      if (p.seedFrom !== undefined && p.seedFrom !== 'checkpoint' && p.seedFrom !== 'current_head')
        throw new DomainRpcError('invalid_params', "seedFrom must be 'checkpoint' or 'current_head'")
      const seedFrom = p.seedFrom as 'checkpoint' | 'current_head' | undefined
      if (!ctx.mms.threads.getThread(sourceThreadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId: sourceThreadId })
      const forked = await asRpcRejection(() => ctx.mms.runEngine.forkThread({ sourceThreadId, atRunOrdinal, title, clientRequestId, seedFrom }))
      if (!forked.replayed) ctx.emitEvent?.('threads.updated', { threads: ctx.mms.threads.listAllThreads() })
      return { threadId: forked.threadId, transferId: forked.transferId, replayed: forked.replayed }
    }
    case 'thread.mergeBack': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['forkThreadId', 'clientRequestId'])
      const forkThreadId = asString(p.forkThreadId, 'forkThreadId', 256)
      const clientRequestId = asOptionalClientRequestId(p.clientRequestId) ?? randomUUID()
      if (!ctx.mms.threads.getThread(forkThreadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId: forkThreadId })
      const merged = await asRpcRejection(() => ctx.mms.runEngine.mergeBack({ forkThreadId, clientRequestId }))
      return { transferId: merged.transferId, parentThreadId: merged.parentThreadId, replayed: merged.replayed }
    }
    case 'orchestrator.isTurnActive': {
      // Lightweight turn probe — avoids full thread.snapshot (messages/agents/tasks).
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) {
        throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      }
      return {
        active: ctx.mms.orchestrator.isTurnActive(threadId),
        running: ctx.mms.orchestrator.isActiveTurnRunning(threadId)
      }
    }
    case 'queue.list': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      ctx.mms.orchestrator.getOrCreateSession(threadId)
      // Read from disk (after an agent command a crash left unfinished is finished): the queue a change that names
      // the revision is checked against. `open` is false while a merge-back keeps the queue from taking messages.
      const snapshot = ctx.mms.orchestrator.queueSnapshot(threadId)
      return {
        items: snapshot.items,
        claimed: snapshot.claimed,
        revision: snapshot.revision,
        open: snapshot.open,
        ...(snapshot.blockedReason ? { blockedReason: snapshot.blockedReason } : {})
      }
    }
    case 'queue.enqueue': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const content = asString(p.content, 'content')
      const mode = asOptionalChatMode(p.mode, 'mode')
      const images = asOptionalChatImages(p.images, 'images')
      const source = admittedChatSource(ctx, asOptionalString(p.source, 64) ?? 'protocol')
      ctx.mms.orchestrator.assertQueueOpen(threadId)
      const limit = deviceLimit(ctx)
      // A queued message from another computer carries that computer's limit: it runs later, at no more than that.
      const item = ctx.mms.orchestrator.enqueueForThread(
        threadId,
        await prepareChatInput(ctx, threadId, { content, mode, images }, p),
        { source, ...(limit ? { permissionMode: limit } : {}), ...(sentFromOf(ctx) ? { sentFrom: sentFromOf(ctx) } : {}) }
      )
      noteSentFrom(ctx, threadId)
      return { item, items: ctx.mms.orchestrator.listQueue(threadId) }
    }
    case 'queue.edit': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const itemId = asString(p.itemId, 'itemId', 256)
      const content = asOptionalString(p.content)
      const mode = asOptionalChatMode(p.mode, 'mode')
      if (content === undefined && mode === undefined) throw new DomainRpcError('invalid_params', 'queue.edit needs content or mode.')
      const expectedRevision = asOptionalString(p.expectedRevision, 64)
      // Who wrote the message and the mode limit it carries stay as they are; the edit changes the text and chat mode only.
      // An edit from another computer leaves the message no looser than that computer's limit and records the sender.
      const limit = deviceLimit(ctx)
      const sentFrom = sentFromOf(ctx)
      const item = queueRpc(() => ctx.mms.orchestrator.editQueuedItem(threadId, itemId, { content, mode }, { expectedRevision, ...(limit ? { permissionMode: limit } : {}), ...(sentFrom ? { sentFrom } : {}) }))
      noteSentFrom(ctx, threadId)
      return { item, items: ctx.mms.orchestrator.listQueue(threadId) }
    }
    case 'queue.reorder': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const orderedIds = asStringArray(p.orderedIds, 'orderedIds', {
        unique: true,
        maxItems: 10_000
      })
      const expectedRevision = asOptionalString(p.expectedRevision, 64)
      const items = queueRpc(() => ctx.mms.orchestrator.reorderQueue(threadId, orderedIds, { expectedRevision }))
      return { items }
    }
    case 'queue.remove': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const itemId = asString(p.itemId, 'itemId', 256)
      const expectedRevision = asOptionalString(p.expectedRevision, 64)
      const removed = queueRpc(() => ctx.mms.orchestrator.removeQueuedItem(threadId, itemId, { expectedRevision }))
      if (!removed) {
        const current = ctx.mms.orchestrator
          .getOrCreateSession(threadId)
          .queue.find((item) => item.id === itemId)
        if (current?.state === 'claimed' || current?.state === 'steering') {
          throw new DomainRpcError('item_started', 'Queued message already started and can no longer be removed.')
        }
        throw new DomainRpcError('queue_item_not_found', 'Queued message was not found or is no longer removable.')
      }
      return { outcome: 'removed', removed }
    }
    case 'queue.promoteToSteer': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const itemId = asString(p.itemId, 'itemId', 256)
      const expectedRevision = asOptionalString(p.expectedRevision, 64)
      const expectedRunId = asOptionalString(p.expectedRunId, 256)
      // A message an agent wrote keeps the mode limit it carries: a run that runs looser than that limit refuses it.
      const limit = deviceLimit(ctx)
      const sent = queueRpc(() => ctx.mms.orchestrator.promoteQueueItem(threadId, itemId, { expectedRevision, expectedRunId, ...(limit ? { permissionCeiling: limit } : {}) }))
      return { ok: sent.ok, ...(sent.notice ? { notice: sent.notice } : {}), items: ctx.mms.orchestrator.listQueue(threadId) }
    }
    case 'orchestrator.contextUsage': {
      const p = isObject(params) ? params : {}
      const threadId = asOptionalString(p.threadId, 256)
      const draftInput = asOptionalString(p.draftInput) ?? ''
      const mode = asOptionalChatMode(p.mode, 'mode')
      const input =
        mode !== undefined ? { draftInput, mode } : draftInput
      return await ctx.mms.orchestrator.getContextUsage(input, threadId)
    }
    case 'orchestrator.answerQuestions': {
      const p = isObject(params) ? params : {}
      const requestId = asString(p.requestId, 'requestId', 256)
      const answers = asAnswersMap(p.answers)
      const pending = ctx.mms.questions.getPending(requestId)
      const settled = ctx.mms.questions.settle(requestId, answers, questionAnswerer(ctx))
      if (settled.ok && pending) {
        // Answers reach the model through the tool result; the transcript records them too, shown
        // as a step of the agent's turn (`questionAnswers`).
        ctx.mms.orchestrator.recordQuestionResponseMessage(
          pending.threadId,
          formatQuestionAnswersMessage(pending.questions, answers),
          describeQuestionAnswers(pending.questions, answers)
        )
      }
      // The loser of a race learns who won and what they decided (SPEC §17.4).
      if (!settled.ok && (settled.reason === 'already_answered' || settled.reason === 'cancelled'))
        return {
          ok: false,
          reason: settled.reason,
          ...(settled.answeredBy ? { answeredBy: settled.answeredBy } : {}),
          ...(settled.decision ? { decision: settled.decision } : {}),
          ...(settled.cancelReason ? { cancelReason: settled.cancelReason } : {})
        }
      return { ok: settled.ok }
    }
    case 'orchestrator.dismissQuestions': {
      const p = isObject(params) ? params : {}
      const requestId = asString(p.requestId, 'requestId', 256)
      const pending = ctx.mms.questions.getPending(requestId)
      const ok = ctx.mms.questions.dismiss(requestId, questionAnswerer(ctx))
      if (ok && pending) {
        ctx.mms.orchestrator.recordQuestionResponseMessage(
          pending.threadId,
          formatQuestionDismissMessage(pending.questions)
        )
      }
      return { ok }
    }
    case 'orchestrator.pendingQuestions': {
      const p = isObject(params) ? params : {}
      const threadId = asOptionalString(p.threadId, 256)
      // A request over the Bridge (no connection of its own) is shown without "Always for this thread": a linked
      // device cannot list or revoke rules, so it does not make them.
      const shown = ctx.connection ? <T extends { questions: unknown[] }>(entry: T): T => entry : withoutStandingRules
      if (threadId) {
        // A person on another computer is offered "Always" only for what that computer's permission limit allows.
        const limit = deviceLimit(ctx)
        return { pending: limit ? ctx.mms.questions.listPendingForDevice(threadId, limit) : ctx.mms.questions.listPendingForThread(threadId).map(shown) }
      }
      return { pending: ctx.mms.questions.listAllPending().map(shown) }
    }
    case 'subagents.stopAll': {
      // Lineage's Stop all: every subagent of the thread that is working, each with its own subtree; the thread keeps running.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      return { threadId, ...(await ctx.mms.orchestrator.stopSubagents(threadId)) }
    }
    case 'subagents.list': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const engine = ctx.mms.runEngine
      return {
        threadId,
        subagents: buildSubagentView(
          {
            delegations: engine.delegations,
            inbox: engine.inbox,
            store: engine.store,
            thread: (id) => ctx.mms.threads.getThread(id),
            hasPendingQuestion: (id) => ctx.mms.questions.listPendingForThread(id).length > 0
          },
          threadId
        )
      }
    }
    case 'agents.list': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      return { agents: ctx.mms.threadRuntimes.listAgents(threadId), threadId }
    }
    case 'agents.spawn': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      // SPEC §14.5: one delegation path. Children are started by a turn's `delegate_task`.
      throw new DomainRpcError('deprecated', 'agents.spawn is retired; delegate from a turn with delegate_task.', { threadId })
    }
    case 'agents.stop': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      const merge = asOptionalBoolean(p.merge, 'merge') === true
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      if (!ctx.mms.threadRuntimes.listAgents(threadId).some((agent) => agent.id === agentId)) {
        throw new DomainRpcError('agent_not_found', `Agent not found in thread: ${agentId}`, { agentId })
      }
      const logs = await ctx.mms.orchestrator.stopAgentForThread(threadId, agentId, merge)
      return { threadId, agentId, logs }
    }
    case 'tasks.list': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      return { tasks: ctx.mms.threadRuntimes.listTasks(threadId), threadId }
    }
    case 'tasks.create': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const description = asString(p.description, 'description')
      const agentId = asOptionalString(p.agentId, 256)
      const status = asOptionalTaskStatus(p.status, 'status')
      const task = ctx.mms.threadRuntimes.createTask(threadId, {
        description,
        agentId,
        ...(status !== undefined ? { status } : {})
      })
      return { task, tasks: ctx.mms.threadRuntimes.listTasks(threadId), threadId }
    }
    case 'tasks.update': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const id = asString(p.id, 'id', 256)
      const status = asOptionalTaskStatus(p.status, 'status')
      const progress = asOptionalBoundedInt(p.progress, 'progress', { min: 0, max: 100 })
      const task = ctx.mms.threadRuntimes.updateTask(threadId, id, {
        description: asOptionalString(p.description),
        ...(status !== undefined ? { status } : {}),
        ...(progress !== undefined ? { progress } : {}),
        message: asOptionalString(p.message),
        summary: asOptionalString(p.summary),
        agentId: p.agentId === null ? null : asOptionalString(p.agentId, 256)
      })
      return { task, tasks: ctx.mms.threadRuntimes.listTasks(threadId), threadId }
    }
    case 'pty.list': {
      const p = isObject(params) ? params : {}
      const threadId = asOptionalString(p.threadId, 256)
      const routed = ctx.connection?.bridgeCaller
      const held = ctx.mms.routedTerminals
      // Another computer sees only the terminals it opened. A window of this computer sees who holds each one that
      // another computer opened, so the owner can tell and stop it.
      const ptys = ctx.mms.ptyManager.list(threadId)
        .filter((entry) => !routed || held?.opened(routed.node, entry.ptyId))
        .map((entry) => { const holder = held?.holderOf(entry.ptyId); return holder && !routed ? { ...entry, heldBy: { node: holder.node, name: holder.name, openedAt: holder.openedAt } } : entry })
      return { ptys }
    }
    case 'pty.create': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      // A terminal opened from another computer runs in the owner's default shell and environment, and starts in the
      // thread's own folder: the caller names no folder, shell, arguments or variables.
      const routed = ctx.connection?.bridgeCaller
      if (routed && (p.cwd !== undefined || p.command !== undefined || p.env !== undefined || p.shellArgs !== undefined))
        throw new DomainRpcError('invalid_params', 'A terminal from another computer starts in the thread\u2019s folder, in the default shell and environment.')
      if (routed && threadId === '__unbound__') throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      let cwd = (routed ? undefined : asOptionalString(p.cwd, 4096)) ?? process.cwd()
      const command = asOptionalString(p.command, 4096)
      const env = asOptionalStringEnvMap(p.env, 'env')
      const shellArgs =
        p.shellArgs === undefined
          ? undefined
          : asStringArray(p.shellArgs, 'shellArgs', { maxItems: 32, maxItemLen: 1024 })
      const task = threadId !== '__unbound__' ? ctx.mms.threads.getThread(threadId) : undefined
      if (threadId !== '__unbound__' && !task) throw new DomainRpcError('thread_not_found', 'Task not found for terminal', { threadId })
      const directory = task ? ctx.mms.threads.getThreadDir(threadId) : undefined
      if (task?.projectId) await ensureOwnedTaskWorkspace(ctx, { threadId })
      const manager = directory ? new ThreadWorkspaceManager(directory) : undefined
      const metadata = manager?.load()
      // A project terminal cannot bypass a task's writer ownership by naming its checkout.
      if (!task) for (const candidate of ctx.mms.threads.listAllThreads()) {
        const owned = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(candidate.id)).load()
        const roots = [owned?.worktreePath, join(ctx.mms.threads.getThreadDir(candidate.id), 'terminal-workspace')].filter((root): root is string => !!root && existsSync(root))
        for (const root of roots) {
          try { assertEpisodePath(root, cwd); throw new DomainRpcError('task_terminal_required', 'Use a task-bound terminal for an owned task workspace') }
          catch (error) { if (String(error).includes('task-bound terminal')) throw error }
        }
      }
      if (task && ctx.mms.threadRuntimes.listAgents(threadId).find((agent) => agent.id === agentId)?.workspacePolicy?.access === 'read-only') throw new DomainRpcError('terminal_not_allowed', 'Read-only agents cannot open an arbitrary shell')
      // A thread in its project's folder has no worktree: its terminal starts in the project folder.
      if (!metadata && task?.projectId && (routed || p.cwd === undefined)) cwd = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId) ?? cwd
      if (metadata) {
        await assertWorktreeFolderConnected(metadata.worktreePath)
        if ((await manager!.verify(metadata)).lifecycle !== 'ready') throw new DomainRpcError('workspace_recovery_required', 'Task workspace requires recovery before opening a terminal')
        const projectPath = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
        if (routed || p.cwd === undefined || projectPath && cwd === projectPath) cwd = manager!.workingFolder(projectPath ?? metadata.worktreePath, metadata)
        else cwd = assertEpisodePath(metadata.worktreePath, cwd)
      }
      // The thread's terminals (from this computer, or from one other computer) are one writer under one lease: the
      // first takes it and starts the terminal turn, the others join, and the last to end checkpoints and releases.
      const member = directory ? await threadTerminalWriters.join(`${resolve(directory)}|${routed ? `node:${routed.node}` : 'local'}`, {
        acquire: () => tryAcquireExecutionLease(directory, { source: 'task-terminal' }),
        busy: () => new DomainRpcError('workspace_busy', leaseBusyMessage(readLeaseOwner(getExecutionLeasePath(directory)), 'Task writer is busy; wait for it to finish before opening a terminal')),
        begin: async (lease) => {
          if (!metadata) return async () => undefined
          const actions = new ThreadActionService(directory)
          const actionOptions = { threadId, turnId: `terminal:${randomUUID()}`, conversationBranchId: metadata.conversationBranchId, workspacePath: metadata.worktreePath,
            actor: { kind: 'user' as const }, heldThreadLease: lease, presentationMessageStart: 0, presentationMessageEnd: 0,
            nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const },
            externalEffects: [{ kind: 'unknown' as const, reversible: false as const, description: 'Interactive terminal commands may affect external services or ignored files.' }] }
          // Edits made outside the terminal are recorded as their own action first; the terminal's action covers only what it changes.
          const startSha = (await actions.recordOutsideChanges(actionOptions)).startSha
          // What `beginTurn` checks of the start, read right after the snapshot without blocking; `beginTurn` then runs no Git.
          const startCheck = await actions.checkTurnStart(actionOptions.workspacePath, startSha)
          actions.beginTurn(actionOptions, startSha, startCheck)
          return async (end) => { await actions.checkpointExistingTurn(actionOptions, startSha, end) }
        },
        release: (lease) => { releaseExecutionLeaseHandle(lease) },
        // A terminal joining the hold is admitted like one taking the lease: not while the thread is trashed or deleted.
        admit: (lease) => withThreadLifecyclePath(directory, 'execution', () => assertHeldThreadLease(directory, lease))
      }) : undefined
      let ptyId: string
      try {
        if (task && !task.projectId && !metadata) {
          // Projectless tasks have a durable private scratch root. A caller's
          // generic cwd hint never turns this into an unchecked project shell.
          const descriptor = assertEpisodePath(directory!, 'terminal-workspace.json')
          const binding = { schemaVersion: 1, kind: 'task-terminal-scratch', threadId, workspaceRelativePath: 'terminal-workspace' }
          if (existsSync(descriptor)) {
            const saved = JSON.parse(readFileSync(descriptor, 'utf8'))
            if (JSON.stringify(saved) !== JSON.stringify(binding)) throw new Error('Task terminal scratch binding is invalid')
          } else { enableVersionedLifecycleWriter(directory!); atomicWriteJsonSync(descriptor, binding) }
          cwd = assertEpisodePath(directory!, binding.workspaceRelativePath)
          mkdirSync(cwd, { recursive: true })
          cwd = assertEpisodePath(directory!, binding.workspaceRelativePath)
        }
        ptyId = ctx.mms.ptyManager.create(agentId, cwd, command, { threadId, env, shellArgs,
          ownership: member ? { assert: () => assertHeldThreadLease(directory!, member.lease), heartbeat: () => { heartbeatExecutionLease(member.lease) },
            settled: () => member.leave() } : undefined
        })
        member?.started()
      } catch (error) { if (member) await member.leave(); throw error }
      // A terminal another computer opened is that computer's from the moment it exists.
      routed?.onTerminalCreated?.(ptyId)
      // `__unbound__` is used by project terminals opened without an active
      // chat thread and must not hydrate a fake thread runtime.
      if (threadId !== '__unbound__') {
        ctx.mms.threadRuntimes.registerPty(threadId, ptyId)
      }
      return {
        ptyId,
        ptys: ctx.mms.ptyManager.list(threadId)
      }
    }
    case 'pty.write': {
      const p = isObject(params) ? params : {}
      const ptyId = asString(p.ptyId, 'ptyId', 256)
      if (typeof p.data !== 'string') throw new Error('data must be a string')
      if (p.data.length > 256_000) throw new Error('data exceeds max size')
      ctx.mms.ptyManager.write(ptyId, p.data)
      return { ok: true }
    }
    case 'pty.resize': {
      const p = isObject(params) ? params : {}
      const ptyId = asString(p.ptyId, 'ptyId', 256)
      const cols = asBoundedInt(p.cols ?? 80, 'cols', { min: 1, max: 512 })
      const rows = asBoundedInt(p.rows ?? 24, 'rows', { min: 1, max: 256 })
      ctx.mms.ptyManager.resize(ptyId, cols, rows)
      return { ok: true }
    }
    case 'pty.kill': {
      const p = isObject(params) ? params : {}
      const ptyId = asString(p.ptyId, 'ptyId', 256)
      const lookup = ctx.mms.ptyManager.lookup(ptyId)
      // Stopped by a person here (not by the device that opened it): the audit says so.
      if (!ctx.connection?.bridgeCaller) ctx.mms.routedTerminals?.stoppedByOwner(ptyId)
      await ctx.mms.ptyManager.killAndWait(ptyId)
      if (lookup.alive) {
        ctx.mms.threadRuntimes.unregisterPty(lookup.threadId, ptyId)
      }
      return { ok: true }
    }
    case 'pty.isAlive': {
      const p = isObject(params) ? params : {}
      const ptyId = asString(p.ptyId, 'ptyId', 256)
      return { alive: ctx.mms.ptyManager.isAlive(ptyId), ptyId }
    }
    case 'pty.lookup': {
      const p = isObject(params) ? params : {}
      const ptyId = asString(p.ptyId, 'ptyId', 256)
      return ctx.mms.ptyManager.lookup(ptyId)
    }
    case 'pty.scrollback': {
      const p = isObject(params) ? params : {}
      const ptyId = asOptionalString(p.ptyId, 256)
      const threadId = asOptionalString(p.threadId, 256)
      if (ptyId) {
        return { ptyId, scrollback: ctx.mms.ptyManager.getScrollback(ptyId) }
      }
      const scrollbacks = ctx.mms.ptyManager.getScrollbacks(threadId)
      const routed = ctx.connection?.bridgeCaller
      // Another computer reads the scrollback of the terminals it opened, never the rest of the thread's.
      if (routed) for (const id of Object.keys(scrollbacks)) if (!ctx.mms.routedTerminals?.opened(routed.node, id)) delete scrollbacks[id]
      return { scrollbacks }
    }
    case 'pty.outputSince': {
      const p = isObject(params) ? params : {}
      const ptyId = asString(p.ptyId, 'ptyId', 256)
      const afterSequence = asAfterSequence(p.afterSequence)
      return ctx.mms.ptyManager.getOutputSince(ptyId, afterSequence)
    }
    case 'activity.get': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      return {
        threadId,
        state: ctx.mms.threadRuntimes.getActivity(threadId)
      }
    }
    case 'activity.snapshot': {
      // A personal bot's threads are its chat, not threads anyone counts (`Thread.botOwned`).
      const bots = new Set(ctx.mms.threads.listAllThreads().filter((thread) => thread.botOwned).map((thread) => thread.id))
      const all = ctx.mms.threadRuntimes.getActivitySnapshot()
      const activity = withoutLocalOnlyKeys(ctx, bots.size ? Object.fromEntries(Object.entries(all).filter(([threadId]) => !bots.has(threadId))) : all)
      // A window also gets what the threads of the other computers are doing.
      const remote = ctx.connection?.clientType === 'gui' ? ctx.mms.remoteLists?.activity() : undefined
      return { activity: remote ? { ...activity, ...remote } : activity }
    }
    case 'stats.usage':
      return ctx.mms.lineEditStats.getUsageSnapshot()
    case 'stats.lineEdits':
      return ctx.mms.lineEditStats.getSnapshot()
    case 'stats.recordManualEdits': {
      const p = isObject(params) ? params : {}
      const expectedProfileId = asOptionalString(p.expectedProfileId, 256)
      if (expectedProfileId && expectedProfileId !== ctx.mms.profileId) {
        throw new DomainRpcError('profile_mismatch', 'Profile changed while saving; edit statistics cannot be attributed to another profile')
      }
      return ctx.mms.lineEditStats.record('manual', asBoundedInt(p.lines, 'lines', { min: 0, max: Number.MAX_SAFE_INTEGER }))
    }
    // ── Scheduled ─────────────────────────────────────────────────────────
    case 'scheduled.list':
      return { jobs: ctx.mms.scheduled.listJobs() }
    case 'scheduled.get': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      return { job: ctx.mms.scheduled.getJob(id) }
    }
    case 'scheduled.create': {
      const p = isObject(params) ? params : {}
      // A call for another computer that reached this one's store (routing is off) is refused: it never falls back here.
      if (p.node !== undefined) throw new DomainRpcError('computer_offline', 'Your other computers are not connected. Turn on working on threads of your other computers in Settings, Devices.', { node: p.node })
      const parsed = asCreateScheduledJobInput(p.input)
      // A thread-event job runs on the pull request's thread unless another one is chosen.
      const threadEvent = parsed.threadEvent ? threadEventTrigger(ctx, parsed.threadEvent, parsed.schedule) : undefined
      const input = { ...parsed, threadEvent, ...(threadEvent && !parsed.threadId && !parsed.createThread ? { threadId: threadEvent.threadId } : {}) }
      // The selection is stored as the profile resolves it; a `worktree` workspace names the thread that owns it.
      const checked = checkJobOptions(ctx, input)
      // The job's ceiling is the mode its creator holds now (the target thread's, else the profile's). It comes
      // from the daemon, never from the request, and the job's own mode may not exceed it. A person on another
      // computer holds no more than this computer lets that device run a turn in.
      const permissionCeiling = narrowPermissionMode(ctx.mms.orchestrator.scheduledCreatorCeiling(checked.threadId ?? input.threadId), deviceLimit(ctx))
      const tooWide = permissionAboveCeiling(input.permissionMode, permissionCeiling)
      if (tooWide) throw jobRefused(tooWide)
      const job = withPermissionRefusals(() => ctx.mms.scheduled.createJob({
        ...input,
        permissionCeiling,
        ...(checked.selection ? { selection: checked.selection } : {}),
        ...(checked.threadId ? { threadId: checked.threadId } : {})
      }))
      // Its pull request is read from now on (a Notify watch on the thread serves it as it is).
      if (threadEvent) ctx.mms.syncThreadEventWatch(threadEvent.threadId)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.update': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      refuseOtherComputersJob(id)
      const patch = asScheduledJobPatch(p.patch)
      const existing = ctx.mms.scheduled.getJob(id)
      if (!existing) throw new Error(`Job not found: ${id}`)
      // A bot's schedule: When, Do, its name and Tell me change; Who, Where and May stay the bot's (its grant).
      if (existing.bot) {
        try {
          // On or off is Pause and Resume, as for any automation; the rest is the bot's own edit.
          const { enabled, ...rest } = patch
          let job = Object.values(rest).some((value) => value !== undefined) ? ctx.mms.botSchedules.update(existing, rest) : existing
          if (enabled === false) job = ctx.mms.scheduled.pauseJob(id) ?? job
          if (enabled === true) job = ctx.mms.scheduled.resumeJob(id) ?? job
          return { job, jobs: ctx.mms.scheduled.listJobs() }
        } catch (error) {
          if (error instanceof BotScheduleError) throw jobRefused(error.message)
          throw error
        }
      }
      if (patch.schedule?.kind === 'once' && existing.trigger?.webhook) {
        throw jobRefused('A job with a webhook cannot become a one-time job; disable its webhook first, or use a manual schedule.')
      }
      const wakesOn = existing.trigger?.threadEvent
      if (wakesOn && patch.schedule && patch.schedule.kind !== 'manual') throw jobRefused('It wakes on its pull request, so it has no clock.')
      if (patch.threadEvent && !wakesOn) throw jobRefused('It does not wake on a pull request.')
      // Validate the job as it would be after the change; `null` clears a field.
      const merged = {
        threadId: patch.threadId === undefined ? existing.threadId : patch.threadId ?? undefined,
        projectId: patch.projectId === undefined ? existing.projectId : patch.projectId ?? undefined,
        selection: patch.selection === undefined ? existing.selection : patch.selection ?? undefined,
        mode: patch.mode === undefined ? existing.mode : patch.mode ?? undefined,
        workspace: patch.workspace === undefined ? existing.workspace : patch.workspace ?? undefined
      }
      const touchesOptions = ['selection', 'mode', 'workspace', 'threadId', 'projectId'].some((key) => (patch as Record<string, unknown>)[key] !== undefined)
      const checked = touchesOptions ? checkJobOptions(ctx, merged) : {}
      // An edit never raises the job's ceiling above what the editor holds now. The person editing here may raise it
      // to their own mode by choosing a mode on purpose (see `permissionsAfterEdit`). It is worked out inside the store's
      // lock, against the job as stored at that moment, so two edits at once cannot undo each other's lowering.
      const executable = isExecutableJobEdit(patch)
      const threadAfter = (current: ScheduledJob) => checked.threadId ?? (patch.threadId === undefined ? current.threadId : patch.threadId ?? undefined)
      const permissionEdit = (current: ScheduledJob) => permissionsAfterEdit({
        stored: current,
        editor: narrowPermissionMode(ctx.mms.orchestrator.scheduledCreatorCeiling(threadAfter(current)), deviceLimit(ctx)),
        patchMode: patch.permissionMode,
        executable,
        canRaise: true
      })
      const permissions = (current: ScheduledJob) => {
        const after = permissionEdit(current)
        // An edit that leaves it on with a next run it did not have (turning it on, giving a manual one a clock, giving a
        // finished one a new schedule) is a Resume or a Run now: from another computer, never above that device's limit,
        // with the mode and thread it will have after this edit. Read against the job as stored, under the store's lock.
        const enabledAfter = patch.enabled ?? current.enabled
        const scheduleAfter = patch.schedule ?? current.schedule
        const startsRunning = enabledAfter && ((patch.enabled === true && !current.enabled) || (!current.nextRunAt && computeNextRun(scheduleAfter) !== null))
        if (startsRunning) {
          refuseAboveDeviceLimit(ctx, {
            ...current,
            threadId: threadAfter(current),
            ...(after.ok && after.changed ? { permissionMode: after.permissionMode, permissionCeiling: after.permissionCeiling } : {})
          })
        }
        return after
      }
      const job = withPermissionRefusals(() => ctx.mms.scheduled.updateJob(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.createThread !== undefined ? { createThread: patch.createThread } : {}),
        ...(patch.threadId !== undefined || checked.threadId ? { threadId: checked.threadId ?? (patch.threadId === null ? undefined : patch.threadId) } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId === null ? undefined : patch.projectId } : {}),
        ...(patch.selection !== undefined ? { selection: patch.selection === null ? undefined : checked.selection ?? patch.selection } : {}),
        ...(patch.agent !== undefined ? { agent: patch.agent === null ? undefined : patch.agent } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode === null ? undefined : patch.mode } : {}),
        ...(patch.workspace !== undefined ? { workspace: patch.workspace === null ? undefined : patch.workspace } : {}),
        ...(patch.tellMe !== undefined ? { tellMe: patch.tellMe } : {}),
        ...(patch.keys !== undefined ? { keys: patch.keys?.length ? patch.keys : undefined } : {}),
        ...(patch.threadEvent && wakesOn ? { trigger: { ...existing.trigger, threadEvent: { ...wakesOn, events: patch.threadEvent.events } } } : {}),
        ...(patch.repeat === null
          ? { repeat: undefined }
          : patch.repeat !== undefined
            ? {
                repeat: {
                  times: patch.repeat.times,
                  completed: existing.repeat?.completed ?? 0
                }
              }
            : {})
      }, { permissions }))
      // A draft edited by hand: Turn on reads its problems again.
      if (job?.draft) ctx.mms.automationDrafts?.recheck(id)
      return { job: job?.draft ? ctx.mms.scheduled.getJob(id) ?? job : job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.delete': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      refuseOtherComputersJob(id)
      const watched = ctx.mms.scheduled.getJob(id)?.trigger?.threadEvent?.threadId
      const ok = ctx.mms.scheduled.deleteJob(id)
      // The pull request's watch stops with the last automation that needed it, unless it is a Notify watch.
      if (ok && watched) ctx.mms.syncThreadEventWatch(watched)
      return { ok, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.pause': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      refuseOtherComputersJob(id)
      const reason = asOptionalString(p.reason, 512)
      // `until`: the pause ends by itself then (Pause… → Until tomorrow, Until Monday, Until a date).
      const untilText = asOptionalString(p.until, 64)
      let until: string | undefined
      if (untilText) {
        const at = Date.parse(untilText)
        if (!Number.isFinite(at)) throw jobRefused('until must be a date and time')
        if (at <= Date.now()) throw jobRefused('Pick a time in the future to resume')
        until = new Date(at).toISOString()
      }
      const job = ctx.mms.scheduled.pauseJob(id, reason, until)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.resume': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      refuseOtherComputersJob(id)
      refuseAboveDeviceLimit(ctx, ctx.mms.scheduled.getJob(id))
      const job = ctx.mms.scheduled.resumeJob(id)
      // A watch that ended meanwhile (a Stop on the thread) starts again for it.
      if (job?.trigger?.threadEvent) ctx.mms.syncThreadEventWatch(job.trigger.threadEvent.threadId)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.run': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      refuseOtherComputersJob(id)
      // A job with a run in flight or waiting in a queue has one occurrence outstanding; say so instead of reporting a start.
      const current = ctx.mms.scheduled.getJob(id)
      const refusal = current ? runNowRefusal(current) : undefined
      if (refusal) throw jobRefused(refusal)
      refuseAboveDeviceLimit(ctx, current)
      const job = ctx.mms.scheduled.triggerJob(id)
      // Run now starts within seconds: the scheduler ticks now instead of at the next minute.
      if (job) ctx.mms.scheduled.wake()
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.status':
      return { status: ctx.mms.scheduled.getStatus() }
    case 'scheduled.settings.get':
      return { settings: scheduledSettings(ctx.mms.config) }
    case 'scheduled.settings.set': {
      // A person's call over the protocol or the Scheduled page; no tool an agent holds reaches it (the `schedule_*` tools only read the limits).
      const p = isObject(params) ? params : {}
      for (const key of Object.keys(p)) if (!SCHEDULED_SETTING_KEYS.includes(key)) throw jobRefused(`${key} is not allowed`)
      if (Object.keys(p).length === 0) throw jobRefused('Name at least one setting to change')
      // Every value is checked before any is saved, so a refused one changes nothing.
      const update: Partial<ScheduledConfigSection> = {}
      if (p.agentJobs !== undefined) update.agentJobs = asBoolean(p.agentJobs, 'agentJobs')
      for (const key of Object.keys(AGENT_JOB_LIMIT_SETTINGS) as AgentJobLimitKey[]) {
        const setting = AGENT_JOB_LIMIT_SETTINGS[key]
        if (p[setting] !== undefined) update[setting] = asBoundedInt(p[setting], setting, AGENT_JOB_LIMIT_RANGES[key])
      }
      ctx.mms.config.updateScheduledSection(update)
      // `agentJobs` is legacy: on lets every thread add automations without the first ask; off brings the ask back and
      // stops nothing that exists (a person pauses or deletes those in the inbox). A lower limit never pauses or
      // removes a job: it only refuses the next create or change.
      return { settings: scheduledSettings(ctx.mms.config) }
    }
    case 'scheduled.extend': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      const days = p.days === undefined ? undefined : asBoundedInt(p.days, 'days', { min: 1, max: 365 })
      const job = ctx.mms.scheduled.extendJob(id, days)
      if (!job) throw jobRefused(`Job not found: ${id}`)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    // The secret is in the `enable` and `rotate` answers only; no other method returns it.
    case 'scheduled.webhook.enable': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      const port = p.port === undefined ? undefined : asBoundedInt(p.port, 'port', { min: 1024, max: 65535 })
      return withWebhookRefusals(async () => ({ ...(await ctx.mms.enableScheduledWebhook(id, { port })), jobs: ctx.mms.scheduled.listJobs() }))
    }
    case 'scheduled.webhook.rotate': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      return withWebhookRefusals(async () => ({ ...ctx.mms.scheduled.rotateWebhook(id), url: ctx.mms.scheduledWebhookUrl(id), jobs: ctx.mms.scheduled.listJobs() }))
    }
    case 'scheduled.webhook.disable': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      return withWebhookRefusals(async () => ({ job: ctx.mms.scheduled.disableWebhook(id), jobs: ctx.mms.scheduled.listJobs() }))
    }
    case 'scheduled.webhook.deliveries': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      // The URL lets a page that opens later show where senders post; it carries no secret.
      return withWebhookRefusals(async () => ({ deliveries: ctx.mms.scheduled.listWebhookDeliveries(id), url: ctx.mms.scheduledWebhookUrl(id) }))
    }
    // ── MCP / skills ──────────────────────────────────────────────────────
    case 'mcp.listServers': {
      const p = isObject(params) ? params : {}
      const projectPath = asOptionalString(p.projectPath, 4096)
      const snapshot = await ctx.mms.mcpRegistry.discover({
        projectPath: projectPath ?? undefined,
        redactSecrets: true
      })
      return { servers: snapshot.servers }
    }
    case 'mcp.listTools': {
      const p = isObject(params) ? params : {}
      const serverId = asString(p.serverId, 'serverId', 256)
      const projectPath = asOptionalString(p.projectPath, 4096)
      return {
        tools: await ctx.mms.mcpManager.listTools(serverId, projectPath ?? undefined)
      }
    }
    case 'mcp.testServer': {
      const p = isObject(params) ? params : {}
      const serverId = asString(p.serverId, 'serverId', 256)
      const projectPath = asOptionalString(p.projectPath, 4096)
      return {
        result: await ctx.mms.mcpManager.testServer(serverId, projectPath ?? undefined)
      }
    }
    case 'mcp.authenticate': {
      const p = isObject(params) ? params : {}
      const serverId = asString(p.serverId, 'serverId', 256)
      const projectPath = asOptionalString(p.projectPath, 4096)
      return {
        result: await ctx.mms.mcpManager.authenticateServer(
          serverId,
          projectPath ?? undefined
        )
      }
    }
    case 'mcp.restartServer': {
      const p = isObject(params) ? params : {}
      const serverId = asString(p.serverId, 'serverId', 256)
      await ctx.mms.mcpManager.restartServer(serverId)
      ctx.emitEvent?.('mcp.changed', {})
      return { ok: true }
    }
    case 'mcp.getConfigSources': {
      const p = isObject(params) ? params : {}
      const projectPath = asOptionalString(p.projectPath, 4096)
      const snapshot = await ctx.mms.mcpRegistry.discover({
        projectPath: projectPath ?? undefined,
        redactSecrets: true
      })
      return { sources: snapshot.sources ?? [] }
    }
    case 'mcp.writeCursorConfig': {
      const p = isObject(params) ? params : {}
      const scope = asScope(p.scope)
      const projectPath = asOptionalString(p.projectPath, 4096)
      const patch = asCursorMcpConfigPatch(p.patch)
      await ctx.mms.mcpRegistry.writeCursorMcpConfig(
        scope,
        patch,
        projectPath ?? undefined
      )
      ctx.emitEvent?.('mcp.changed', {})
      return { ok: true }
    }
    case 'mcp.openConfigIntent': {
      const p = isObject(params) ? params : {}
      const scope = asScope(p.scope)
      const projectPath = asOptionalString(p.projectPath, 4096)
      // Resolve path only from known registry sources — never trust caller paths.
      const snapshot = await ctx.mms.mcpRegistry.discover({
        projectPath: projectPath ?? undefined,
        redactSecrets: true
      })
      const source = (snapshot.sources ?? []).find((entry: { source?: string; path?: string }) =>
        scope === 'global'
          ? entry.source === 'cursor-global'
          : entry.source === 'cursor-project'
      )
      if (!source?.path) {
        throw new Error('MCP config source not found for scope')
      }
      return {
        intent: {
          kind: 'open-mcp-config',
          scope,
          path: source.path,
          source: source.source
        }
      }
    }
    case 'skills.list': {
      const p = isObject(params) ? params : {}
      const projectPath = asOptionalString(p.projectPath, 4096)
      const snapshot = await ctx.mms.skillsRegistry.discover({
        projectPath: projectPath ?? undefined
      })
      return { snapshot }
    }
    case 'skills.read': {
      const p = isObject(params) ? params : {}
      const skillId = asString(p.skillId, 'skillId', 256)
      const projectPath = asOptionalString(p.projectPath, 4096)
      return {
        result: await ctx.mms.skillsRegistry.readSkill(skillId, {
          projectPath: projectPath ?? undefined
        })
      }
    }
    case 'skills.refresh': {
      const p = isObject(params) ? params : {}
      const projectPath = asOptionalString(p.projectPath, 4096)
      const snapshot = await ctx.mms.skillsRegistry.refresh({
        projectPath: projectPath ?? undefined
      })
      return { snapshot }
    }
    case 'skills.openFolderIntent': {
      const p = isObject(params) ? params : {}
      const scope = asScope(p.scope)
      const projectPath = asOptionalString(p.projectPath, 4096)
      const snapshot = await ctx.mms.skillsRegistry.discover({
        projectPath: projectPath ?? undefined
      })
      const source = (snapshot.sources ?? []).find(
        (entry: { scope?: string; path?: string }) => entry.scope === scope
      )
      if (!source?.path) {
        throw new Error('Skills folder source not found for scope')
      }
      return {
        intent: {
          kind: 'open-skills-folder',
          scope,
          path: source.path
        }
      }
    }
    // ── Settings / providers (daemon-owned) ───────────────────────────────
    case 'settings.get':
      return { settings: ctx.mms.settings.get() }
    case 'settings.set': {
      const p = isObject(params) ? params : {}
      const partial = asSettingsPartial(p.partial) as MousseSettingsUpdate
      // A default model chosen here carries its name, for the CLI and devices that have no listing of it.
      const chosen = partial.provider
      if (chosen?.model && !chosen.name && ctx.mms.harness)
        partial.provider = { ...chosen, name: ctx.mms.harness.modelName(chosen.instanceId || (chosen.llmProvider ?? ''), chosen.model) }
      const settings = ctx.mms.settings.set(partial)
      // Fan-out so all clients observe the same daemon-owned settings immediately.
      ctx.emitEvent?.('settings.changed', { settings })
      return { settings }
    }
    case 'settings.getOptions': {
      await ctx.mms.providerAuth.init()
      // The first read after start waits for each instance's first check (`awaitFirstChecks`).
      const llmProviders = (await ctx.mms.harness?.llmProviders({ kind: 'device' })) ?? []
      const agentTypes = buildAgentTypesFromCatalogs(ctx.mms.providerAuth.getCatalogLlmProviders())
      // The bot model choices: the listed models that can hold a bot now. A failed read offers only Automatic.
      const holdable = ctx.mms.botModels ? await ctx.mms.botModels.holdable().catch(() => []) : []
      return {
        options: {
          themes: THEME_OPTIONS,
          accentColors: ACCENT_COLORS,
          llmProviders,
          agentTypes,
          botProviders: botProviderOptions(llmProviders, holdable)
        }
      }
    }
    case 'providers.getUsage': {
      await ctx.mms.claudeSubscription.status()
      // Pi providers read the shared pi-ai credentials; agents (Codex) answer for the bound profile.
      const [usage, claude, agents] = await Promise.all([
        // Providers removed from this profile are left out (`providerAccess`).
        ctx.mms.providerAccess.usage(),
        ctx.mms.claudeSubscription.configured()
          ? ctx.mms.claudeSubscription.getUsage(ctx.mms.worktrees.getRepoRoot())
          : Promise.resolve(undefined),
        // The usage page lists a signed-out agent too, so it can offer Reconnect (`signedOut`).
        ctx.mms.harness?.instances.usage({ kind: 'device' }, { includeSignedOut: true }) ?? Promise.resolve([])
      ])
      return {
        ...usage,
        providers: [...usage.providers, ...(claude ? [claude] : []), ...agents],
        fetchedAt: new Date().toISOString()
      }
    }
    // The usage page's progressive reads (`usageReads.ts`): every provider it shows first, with its
    // last reading; then one provider (or one proxy sign-in) at a time, each within its own deadline.
    // Both answer only a window or the CLI on this computer, like the proxy key methods below.
    case 'providers.usageSlots': {
      if (!connectionIsLocal(ctx.connection)) throw new DomainRpcError('forbidden', 'Usage is read on its own computer')
      // Claude turned off in Settings is not shown either.
      const claudeOn = !ctx.mms.providerInstances?.isDisabled?.('claude')
      const claude = claudeOn && ctx.mms.claudeSubscription.configured() ? [{ id: CLAUDE_USAGE_ID, label: 'Claude subscription' }] : []
      const slots = [
        ...ctx.mms.providerAccess.usageSlots(),
        ...claude,
        ...(ctx.mms.harness?.instances.usageSlots({ kind: 'device' }) ?? [])
      ]
      return { slots: usageSlots(ctx.mms, slots) }
    }
    case 'providers.getUsageFor': {
      if (!connectionIsLocal(ctx.connection)) throw new DomainRpcError('forbidden', 'Usage is read on its own computer')
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const accountId = p.accountId === undefined ? undefined : asString(p.accountId, 'accountId', 256)
      const preview = p.preview === true
      if (providerId === CLAUDE_USAGE_ID) {
        // Turned off in Settings: not on the page, so not read either.
        if (ctx.mms.providerInstances?.isDisabled?.('claude')) return {}
        const claude = ctx.mms.claudeSubscription
        if (accountId !== undefined) {
          const read = await withUsageDeadline<UsageAccount | undefined>((signal) => claude.usageAccount(accountId, signal), () => ({ id: accountId, label: accountId, windows: [], problem: 'Not reachable' }))
          const account = read && steadyAccount(ctx.mms, providerId, read)
          if (account) keepAccount(ctx.mms, providerId, account)
          return { ...(account ? { account } : {}) }
        }
        if (preview) {
          const provider = await withUsageDeadline((signal) => claude.usageAccountsPreview(signal), () => undefined)
          if (provider) keepUsage(ctx.mms, provider)
          return { ...(provider ? { provider } : {}) }
        }
        const read = await withUsageDeadline(async () => {
          await claude.status()
          return claude.configured() ? claude.getUsage(ctx.mms.worktrees.getRepoRoot()) : undefined
        }, () => unreachableUsage(providerId, 'Claude subscription'))
        const provider = read && steadyUsage(ctx.mms, read)
        if (provider) keepUsage(ctx.mms, provider)
        return { ...(provider ? { provider } : {}) }
      }
      const slot = ctx.mms.harness?.instances.usageSlots({ kind: 'device' }).find((entry) => entry.id === providerId)
      const listed = slot ?? ctx.mms.providerAccess.usageSlots().find((entry) => entry.id === providerId)
      // Only a provider the page lists is read, so the kept readings never grow past that list.
      if (!listed) return {}
      const label = listed.label
      const provider = await withUsageDeadline(
        async () => (slot ? ctx.mms.harness!.instances.usageFor({ kind: 'device' }, providerId) : ctx.mms.providerAccess.usageFor(providerId)),
        () => unreachableUsage(providerId, label)
      )
      if (provider) keepUsage(ctx.mms, provider)
      return { ...(provider ? { provider } : {}) }
    }
    // Uses one of a provider's limit-reset credits (Codex), asked for by the usage page on this computer only.
    case 'providers.useLimitReset': {
      if (!connectionIsLocal(ctx.connection)) throw new DomainRpcError('forbidden', 'A limit reset is used on its own computer')
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const creditId = p.creditId === undefined ? undefined : asString(p.creditId, 'creditId', 256)
      if (!ctx.mms.harness) throw new Error('Providers are not ready yet')
      return ctx.mms.harness.instances.useLimitReset({ kind: 'device' }, providerId, creditId)
    }
    // The management key of the local CLI-to-API proxy Claude's usage is read through: saved
    // encrypted for that proxy's origin after it accepts the key, and never sent back. Only a window
    // or the CLI on this computer may set or clear it (`providers.*` is never routed either).
    case 'providers.setUsageProxyKey': {
      if (!connectionIsLocal(ctx.connection)) throw new DomainRpcError('forbidden', 'A usage proxy key is set on its own computer')
      const p = isObject(params) ? params : {}
      if (asString(p.providerId, 'providerId', 128) !== 'claude-subscription') throw new Error('Only Claude usage reads through a proxy')
      return ctx.mms.claudeSubscription.setUsageProxyKey(asString(p.key, 'key', 1024))
    }
    case 'providers.clearUsageProxyKey': {
      if (!connectionIsLocal(ctx.connection)) throw new DomainRpcError('forbidden', 'A usage proxy key is cleared on its own computer')
      const p = isObject(params) ? params : {}
      if (asString(p.providerId, 'providerId', 128) !== 'claude-subscription') throw new Error('Only Claude usage reads through a proxy')
      ctx.mms.claudeSubscription.clearUsageProxyKey()
      return { ok: true }
    }
    case 'providers.getSubscriptionUsage': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      // A provider removed from this profile is refused (`providerAccess`).
      const text = await ctx.mms.providerAccess.subscriptionUsage(providerId)
      if (text !== undefined) return { usage: text }
      // An agent instance named by its id (`codex`, `codex:work`).
      const agent = (await ctx.mms.harness?.instances.usage({ kind: 'device' }))?.find((entry) => entry.id === providerId)
      return { usage: agent ? usageText(agent.label, agent) : undefined }
    }
    case 'providers.synthesizeSpeech': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const modelId = asString(p.modelId, 'modelId', 256)
      const text = asString(p.text, 'text', PROVIDER_TTS_MAX_CHARS)
      const voice = p.voice === undefined ? undefined : asString(p.voice, 'voice', 128)
      const { audio, mimeType } = await ctx.mms.providerAccess.synthesizeSpeech({ providerId, modelId, text, voice })
      return { audioBase64: Buffer.from(audio).toString('base64'), mimeType }
    }
    case 'providers.transcribeAudio': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const modelId = asString(p.modelId, 'modelId', 256)
      const mimeType = asString(p.mimeType, 'mimeType', 128)
      if (!mimeType.startsWith('audio/')) throw new Error('mimeType must be an audio type')
      if (typeof p.audioBase64 !== 'string') throw new Error('audioBase64 must be a string')
      const audio = Buffer.from(p.audioBase64, 'base64')
      if (audio.byteLength === 0) throw new Error('The recording is empty')
      if (audio.byteLength > PROVIDER_STT_MAX_BYTES) {
        throw new Error(`The recording is too long to transcribe with ${ctx.mms.providerAuth.getProviderDisplayName(providerId)}. Record a shorter message.`)
      }
      const { text } = await ctx.mms.providerAccess.transcribeAudio({ providerId, modelId, audio, mimeType })
      return { text }
    }
    case 'webTools.getCredentialStatus':
      return {
        credentials: {
          exa: ctx.mms.providerAuth.has('web-tool:exa'),
          parallel: ctx.mms.providerAuth.has('web-tool:parallel')
        }
      }
    case 'webTools.setApiKey': {
      const p = isObject(params) ? params : {}
      const service = asString(p.service, 'service', 32)
      if (service !== 'exa' && service !== 'parallel') throw new Error('Unsupported web tool service')
      const apiKey = asString(p.apiKey, 'apiKey', 8192)
      await ctx.mms.providerAuth.setApiKey(`web-tool:${service}`, apiKey)
      return { configured: true }
    }
    case 'webTools.clearApiKey': {
      const p = isObject(params) ? params : {}
      const service = asString(p.service, 'service', 32)
      if (service !== 'exa' && service !== 'parallel') throw new Error('Unsupported web tool service')
      await ctx.mms.providerAuth.logout(`web-tool:${service}`)
      return { configured: false }
    }
    case 'providers.snapshots': {
      const p = isObject(params) ? params : {}
      const scope = asProviderScope(p.scope)
      const snapshots = await harnessGateway(ctx).instances.snapshots(scope)
      const instancesError = ctx.mms.providerInstances?.storeError()
      // Present while the profile's stored instance map cannot be read (nothing is overwritten).
      return { scope, snapshots, ...(instancesError ? { instancesError } : {}) }
    }
    case 'providers.catalog.addOptions':
      return { options: harnessGateway(ctx).catalog.addOptions() }
    case 'providers.instances.add': {
      // A fixed-id entry that exists already comes back unchanged (`existed`), so adding is idempotent.
      const { snapshot, existed } = await harnessGateway(ctx).instances.addInstance(asAddInstanceInput(params))
      return { snapshot, ...(existed ? { existed: true } : {}) }
    }
    case 'providers.instances.setSecret': {
      const p = isObject(params) ? params : {}
      const instanceId = asInstanceId(p.instanceId)
      return { snapshot: await harnessGateway(ctx).instances.setSecret(instanceId, asString(p.value, 'value', 8192)) }
    }
    case 'providers.instances.remove': {
      const p = isObject(params) ? params : {}
      await harnessGateway(ctx).instances.remove(asInstanceId(p.instanceId))
      return { ok: true }
    }
    case 'providers.instances.configure': {
      const p = isObject(params) ? params : {}
      const instanceId = asInstanceId(p.instanceId)
      return { snapshot: await harnessGateway(ctx).instances.configure(instanceId, asInstanceConfigPatch(p.patch)) }
    }
    case 'providers.instances.setEnabled': {
      const p = isObject(params) ? params : {}
      const instanceId = asInstanceId(p.instanceId)
      const scope = asProviderScope(p.scope)
      const enabled = asEnabledForScope(p.enabled, scope)
      return { snapshot: await harnessGateway(ctx).instances.setEnabled(instanceId, scope, enabled) }
    }
    // Install, update and sign-in return an operation id at once; progress, prompts and the
    // outcome arrive as `providers.operation` events, so no request waits on them.
    case 'providers.instances.install': {
      const p = isObject(params) ? params : {}
      return { operation: await harnessGateway(ctx).instances.install(asInstanceId(p.instanceId)) }
    }
    case 'providers.instances.removeInstall': {
      const p = isObject(params) ? params : {}
      const force = p.force === undefined ? false : asBoolean(p.force, 'force')
      return { result: await harnessGateway(ctx).instances.removeInstall(asInstanceId(p.instanceId), { force }) }
    }
    case 'providers.registry.search': {
      const p = isObject(params) ? params : {}
      return { agents: await harnessGateway(ctx).registry.search(asOptionalString(p.query, 120)?.trim() ?? '') }
    }
    case 'providers.instances.cancelInstall': {
      const p = isObject(params) ? params : {}
      return { cancelled: await harnessGateway(ctx).instances.cancelInstall(asString(p.operationId, 'operationId', 256)) }
    }
    case 'providers.instances.update': {
      const p = isObject(params) ? params : {}
      return { operation: await harnessGateway(ctx).instances.update(asInstanceId(p.instanceId)) }
    }
    case 'providers.instances.signIn': {
      const p = isObject(params) ? params : {}
      const instanceId = asInstanceId(p.instanceId)
      const method = asOptionalString(p.method, 64)
      return { operation: await harnessGateway(ctx).instances.signIn(instanceId, method) }
    }
    case 'providers.instances.respondSignIn': {
      const p = isObject(params) ? params : {}
      const operationId = asString(p.operationId, 'operationId', 256)
      return { ok: await harnessGateway(ctx).instances.respondSignIn(operationId, asSignInResponse(p.response)) }
    }
    case 'providers.instances.signOut': {
      const p = isObject(params) ? params : {}
      return { snapshot: await harnessGateway(ctx).instances.signOut(asInstanceId(p.instanceId)) }
    }
    case 'providers.instances.allowKnownProblem': {
      const p = isObject(params) ? params : {}
      const instanceId = asInstanceId(p.instanceId)
      return { snapshot: await harnessGateway(ctx).instances.allowKnownProblem(instanceId, asString(p.version, 'version', 200)) }
    }
    case 'providers.instances.recheck': {
      const p = isObject(params) ? params : {}
      return { snapshot: await harnessGateway(ctx).instances.recheck(asInstanceId(p.instanceId)) }
    }
    case 'providers.instances.refreshModels': {
      const p = isObject(params) ? params : {}
      return { snapshot: await harnessGateway(ctx).instances.refreshModels(asInstanceId(p.instanceId)) }
    }
    case 'providers.instances.refreshAllModels':
      return { results: await harnessGateway(ctx).instances.refreshAllModels() }
    case 'providers.instances.setModelPrefs': {
      const p = isObject(params) ? params : {}
      const instanceId = asInstanceId(p.instanceId)
      return { snapshot: await harnessGateway(ctx).instances.setModelPrefs(instanceId, asModelPrefsPatch(p.patch)) }
    }
    case 'providers.instances.move': {
      const p = isObject(params) ? params : {}
      return { result: await harnessGateway(ctx).instances.move(asInstanceId(p.instanceId), asInstanceId(p.toInstanceId, 'toInstanceId'), { copyKey: p.copyKey === true }) }
    }
    case 'workspace.getStatus': {
      const p = isObject(params) ? params : {}
      const lookup = threadLookupContext(ctx, p)
      const manager = new ThreadWorkspaceManager(lookup.threadDirectory)
      const stored = manager.load()
      // A turn still recording its end-of-turn checkpoint under its live lease is not waiting on recovery.
      const inFlight = liveCheckpointTest(lookup.threadDirectory)
      const metadata = stored && lookup.projectPath ? await manager.verify(stored, { inFlight }) : stored
      // Never restores: the hover card and the active-project lookup call this for passive reads.
      const marker = stored && !await access(stored.worktreePath).then(() => true, () => false) ? readCleanupMarker(ctx.mms.threads.lifecycleStore, lookup.threadId) : undefined
      // What the thread waits on, for the banner and the CLI; absent while nothing does. A thread recording into a hidden
      // store (no Git of its own) is read through `loadOrSnapshotAsync`, so it shows the banner too.
      const recovery = await threadRecovery(lookup.threadDirectory, lookup.projectPath, { inFlight })
      return {
        metadata,
        ...(recovery ? { recovery } : {}),
        execution: lookup.projectPath
          ? await manager.executionContext(lookup.projectPath, metadata)
          : manager.unboundExecutionContext(lookup.threadId),
        journalGeneration: lookup.currentGeneration,
        ...(marker ? { retiredByCleanup: { at: marker.retiredAt, rule: marker.rule } } : {})
      }
    }
    case 'editor.folder': {
      // Which folder an editor opens for a thread. The thread id is all a caller gives; the folder is this computer's own.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const lookup = threadLookupContext(ctx, p)
      if (!lookup.projectPath) throw new DomainRpcError('thread_has_no_folder', 'This thread has no folder on this computer.', { threadId: lookup.threadId })
      return await resolveEditorFolder({ threadId: lookup.threadId, threadDirectory: lookup.threadDirectory, projectPath: lookup.projectPath })
    }
    case 'editor.ask': {
      // Another computer asks this one to allow its editor connections. Only a routed call carries the caller.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, [])
      const caller = ctx.connection?.bridgeCaller
      if (!caller) throw new DomainRpcError('invalid_params', 'editor.ask asks another computer. Name it with node.')
      const asks = ctx.mms.editorAsks
      if (!asks) throw new DomainRpcError('not_available_remotely', 'This computer is not taking requests from other computers right now.')
      return asks.ask(caller.node as NodeId)
    }
    case 'workspace.restore': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const branchId = asOptionalString(p.conversationBranchId, 256) ?? new ThreadWorkspaceManager(operation.threadDirectory).load()?.conversationBranchId ?? 'main'
      const manager = new ThreadWorkspaceManager(operation.threadDirectory)
      const current = manager.load()
      // Nothing to restore for a thread in its project's folder, and no worktree is made for it here either.
      if (!current && threadPlacement(ctx.mms.threads.getThread(operation.threadId)) === 'project-folder') {
        throw new DomainRpcError('thread_in_project_folder', PROJECT_FOLDER_REASON)
      }
      const metadata = current
        ? await manager.restore(operation.projectPath)
        : await manager.provision(operation.threadId, branchId, operation.projectPath, undefined, undefined, undefined, { nameFrom: branchNameSource(ctx, operation.threadId) })
      ctx.emitEvent?.('workspace.updated', { threadId: operation.threadId, metadata }, operation.threadId)
      return { metadata }
    }
    case 'workspace.discardPendingChanges': {
      // The Discard button of a `workspace_conflict` error in a thread worktree. Only ever run on a person's click
      // after a confirmation; it keeps a copy of what it drops under refs/mousse/preserved/, owned by the thread.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'confirmed'])
      if (p.confirmed !== true) throw new DomainRpcError('confirmation_required', 'Discarding changes needs the user’s confirmation.')
      const operation = threadOperationContext(ctx, p)
      if (ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)) throw new DomainRpcError('thread_busy', 'Wait for active or queued work to finish.')
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      // The project folder's uncommitted changes are the person's own; this button only ever cleans a thread's worktree.
      if (isProjectFolderWorkspace(workspace)) throw new DomainRpcError('thread_in_project_folder', 'This chat works in the project folder, whose uncommitted changes are yours; Mousse does not discard them.')
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      // Everything uncommitted goes, the results of the thread's turns included. The files as they are now are recorded
      // as a snapshot first (the turns' receipts keep theirs), and a copy stays for the thread's Undo window.
      return await withGitMutationLocks(operation.threadDirectory, workspace.worktreePath, 'discard-pending-changes', async () => {
        let before: string
        // The files are recorded first. When the record cannot be written (a pending operation), a plain snapshot stands in,
        // kept as one of the thread's copies so it expires with them; when either fails, nothing is discarded. The copy of
        // what is dropped is made inside `discardPendingChanges`, before any reset.
        try { before = (await new ThreadActionService(operation.threadDirectory).recordOutsideChangesHeld({ threadId: workspace.threadId, conversationBranchId: workspace.conversationBranchId, workspacePath: workspace.worktreePath })).startSha }
        catch {
          try { before = (await takeSnapshotAsync(workspace.worktreePath, { reason: 'before discard', threadId: workspace.threadId })).sha }
          catch (error) { throw new DomainRpcError('discard_unsafe', `Nothing was discarded: the files could not be recorded first (${(error as Error).message.split(/\r?\n/)[0]}).`) }
          try { await keepExistingCommit({ owner: operation.threadDirectory, top: workspace.worktreePath, operationType: 'git-discard', sha: before }) }
          catch (error) { throw new DomainRpcError('discard_unsafe', `Nothing was discarded: the files could not be kept first (${(error as Error).message.split(/\r?\n/)[0]}).`) }
        }
        const kept = await discardPendingChangesAsync(workspace.worktreePath, (top, scope) => keepCopy({ owner: operation.threadDirectory, top, operationType: 'git-discard', action: 'Discard', ...scope }))
          .catch((error: unknown) => {
            if (error instanceof IndexLockedError) throw new DomainRpcError('git_index_locked', error.message, { path: error.lock })
            throw error instanceof KeepCopyRefusedError ? new DomainRpcError(error.code, error.message, { paths: error.paths }) : error
          })
        const left = leftAsItIsText(kept.left)
        return { backupRef: kept.ref, snapshotSha: before, notice: keptCopyNotice(kept), ...(left ? { left } : {}) }
      })
    }
    case 'actions.list': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      // The GUI asks for the history of a selected thread; opening one brings its worktree back.
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      new ConversationActionService(operation.threadDirectory).recoverHistoryIfIdle(
        () => ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId),
        (action, kind) => {
          ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, action, kind)
          if (kind === 'redo') ctx.mms.orchestrator.restoreConversationActionEnd(operation.threadId, action.presentationMessageStart, action.presentationMessageEnd, action.nativeContextBoundary)
          else ctx.mms.orchestrator.restoreConversationBoundary(operation.threadId, action.presentationMessageStart, action.nativeContextStartBoundary!)
        }
      )
      operation.currentGeneration = new ThreadActionService(operation.threadDirectory).currentRevision()
      const retention = new UndoRetentionService(operation.threadDirectory)
      const actions = retention.eligibilityMany(new ThreadActionService(operation.threadDirectory).list())
      const activeBranchId = new ThreadWorkspaceManager(operation.threadDirectory).load()?.conversationBranchId ?? 'main'
      const latest = actions.filter((action) => action.conversationBranchId === activeBranchId).at(-1)
      const messages = ctx.mms.orchestrator.getMessagesForPersistence(operation.threadId)
      const prompt = messages.filter(isTurnPrompt).at(-1)
      const busy = ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)
      const retained = latest?.retention?.state === 'available' || latest?.retention?.state === 'pinned'
      let contextMatches = true
      if (latest?.scope === 'conversation') {
        try { ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, latest, latest.state === 'undone' ? 'redo' : 'undo') } catch { contextMatches = false }
      }
      const workspaceReady = latest?.scope === 'conversation' || (await new ThreadWorkspaceManager(operation.threadDirectory).loadOrSnapshotAsync())?.lifecycle === 'ready'
      const eligible = !busy && contextMatches && workspaceReady && latest?.nativeContextStartBoundary && latest?.reversible && retained
      const matches = latest && prompt && messages.indexOf(prompt) >= latest.presentationMessageStart && messages.indexOf(prompt) < latest.presentationMessageEnd && prompt.turnId === latest.turnId
      const undoTarget = eligible && matches && latest.state === 'completed'
        ? { actionId: latest.id, turnId: latest.turnId, messageId: prompt.id, journalGeneration: operation.currentGeneration } : undefined
      const receipts = new ChangeReceiptService(operation.threadDirectory).list()
      // Workspace Undo appends a completed compensation; its original becomes undone.
      // Only an Undo receipt offers Redo, not another completed forward/Redo action.
      const undoneOriginal = latest && actions.find(action => action.conversationBranchId === activeBranchId
        && action.compensationActionId === latest.id && action.state === 'undone')
      const workspaceRedo = latest?.scope !== 'conversation' && latest?.state === 'completed'
        && receipts.some(receipt => receipt.id === latest.receiptId && receipt.kind === 'undo')
        && undoneOriginal?.reversible && undoneOriginal.nativeContextStartBoundary
        && (undoneOriginal.retention?.state === 'available' || undoneOriginal.retention?.state === 'pinned')
      const redoTarget = eligible && ((latest.scope === 'conversation' && latest.state === 'undone') || workspaceRedo)
        ? { actionId: latest.id, turnId: latest.turnId, journalGeneration: operation.currentGeneration } : undefined
      // A folder Mousse cannot snapshot (too large) says so where Undo would have been offered.
      const filesOff = snapshotsOffReason(operation.threadDirectory)
      const promptVersions = promptVersionsOf(new ConversationBranchService(operation.threadDirectory).list(), actions, activeBranchId)
      return { actions, retentionPolicy: retention.policy(), receipts, activeBranchId, journalGeneration: operation.currentGeneration, undoTarget, redoTarget, promptVersions,
        undoUnavailableReason: undoTarget ? undefined : busy ? 'Wait for active or queued work to finish.' : filesOff && latest?.scope === 'conversation' ? filesOff : latest?.retention?.state === 'expired' || latest?.retention?.state === 'blocked' ? latest.retention.reason : 'This prompt has no eligible recorded Undo boundary. Tool effects or older unrecorded turns cannot be undone safely.' }
    }
    case 'actions.sweepRetention':
    case 'actions.configureRetention':
    case 'actions.pin': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = await new ThreadWorkspaceManager(operation.threadDirectory).loadOrSnapshotAsync()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      const retention = new UndoRetentionService(operation.threadDirectory)
      if (method === 'actions.sweepRetention') {
        const logical = await retention.sweep(workspace.worktreePath)
        const physical = logical.suspended ? undefined
          : workspace.snapshotOnly ? await releaseSnapshotRefs(operation.threadDirectory)
            : await new ReceiptRefReleaseService(ctx.mms.threads.lifecycleStore, operation.threadId).release(workspace.worktreePath)
        return { ...logical, physical }
      }
      // CLI/model callers cannot self-assert a human identity in request parameters.
      const human = isPerson(ctx.connection)
      if (method === 'actions.pin') await retention.pin(workspace.worktreePath, asString(p.actionId, 'actionId', 256), asBoolean(p.pinned, 'pinned'), human, asOptionalString(p.reason, 512))
      else {
        const policy = isObject(p.policy) ? p.policy : {}
        const windowMs = asOptionalBoundedInt(policy.windowMs, 'windowMs', { min: 1, max: 3650 * 86400000 })
        const migrationGraceMs = asOptionalBoundedInt(policy.migrationGraceMs, 'migrationGraceMs', { min: 1, max: 3650 * 86400000 })
        await retention.configure(workspace.worktreePath, { ...(windowMs !== undefined ? { windowMs } : {}), ...(migrationGraceMs !== undefined ? { migrationGraceMs } : {}) }, human, asOptionalBoolean(p.acknowledgeClock, 'acknowledgeClock') ?? false)
      }
      return { ok: true }
    }
    case 'actions.getAffectedFiles': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const actionId = asString(p.actionId, 'actionId', 256)
      const action = new ThreadActionService(operation.threadDirectory).get(actionId)
      if (!action) throw new DomainRpcError('action_not_found', `Action not found: ${actionId}`)
      return { files: action.changedPaths, externalEffects: action.externalEffects }
    }
    case 'review.files': {
      const p = isObject(params) ? params : {}
      const target = await reviewTarget(ctx, p)
      const result: ReviewFilesResult = { root: target.root, scope: target.scope, range: target.range, files: [], truncated: false, mergeCommits: 0 }
      if (target.unavailable) return { ...result, unavailable: target.unavailable }
      return { ...result, ...await readReview(target, () => listChangedFiles(target.root, target.range)) }
    }
    case 'review.file': {
      const p = isObject(params) ? params : {}
      const target = await reviewTarget(ctx, p)
      if (target.unavailable) throw new DomainRpcError('review_unavailable', target.unavailable)
      // The review shows a link at the path as the link text and never reads what it points to.
      const path = requiredContainedPath(ctx, target.root, p.path, 'inspect')
      const oldPath = p.oldPath === undefined ? undefined : requiredContainedPath(ctx, target.root, p.oldPath, 'inspect')
      return await readReview(target, () => readFileVersions(target.root, target.range, path, oldPath))
    }
    case 'actions.undoLatest': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      // A workspace Undo needs the checkout; a conversation-only Undo does not.
      if (operation.projectPath && new ThreadActionService(operation.threadDirectory).latest(new ThreadWorkspaceManager(operation.threadDirectory).load()?.conversationBranchId ?? 'main')?.scope !== 'conversation') await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = await new ThreadWorkspaceManager(operation.threadDirectory).loadOrSnapshotAsync()
      const branchId = workspace?.conversationBranchId ?? 'main'
      const expectedTurnId = asOptionalString(p.expectedTurnId, 256)
      const validate = (target: import('../../shared/threadActions').ThreadAction): void => {
        if (ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)) throw new DomainRpcError('thread_busy', 'Wait for active or queued work to finish.')
        // Generic workspace Undo also serves editor and workflow receipts with no prompt.
        // Prompt-targeted requests and conversation-only receipts require exact provenance.
        if (target.scope !== 'conversation' && expectedTurnId === undefined) return
        if (!target.nativeContextStartBoundary || target.nativeContextStartBoundary.fidelity === 'legacy') throw new DomainRpcError('undo_boundary_unavailable', 'This turn has no exact recorded conversation Undo boundary.')
        if (target.scope === 'conversation') ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, 'undo')
        const messages = ctx.mms.orchestrator.getMessagesForPersistence(operation.threadId)
        const prompt = messages.filter(isTurnPrompt).at(-1)
        if (!prompt || prompt.turnId !== target.turnId || messages.indexOf(prompt) < target.presentationMessageStart || messages.indexOf(prompt) >= target.presentationMessageEnd) throw new DomainRpcError('undo_boundary_unavailable', 'The latest prompt has no eligible Undo boundary.')
      }
      const restore = (target: import('../../shared/threadActions').ThreadAction, kind: 'undo' | 'redo'): void => {
        if (target.scope === 'conversation') ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, kind)
        if (!target.nativeContextStartBoundary) return
        if (kind === 'redo') ctx.mms.orchestrator.restoreConversationActionEnd(operation.threadId, target.presentationMessageStart, target.presentationMessageEnd, target.nativeContextBoundary)
        else ctx.mms.orchestrator.restoreConversationBoundary(operation.threadId, target.presentationMessageStart, target.nativeContextStartBoundary!)
      }
      const latest = new ThreadActionService(operation.threadDirectory).latest(branchId)
      const reviewedDiffSha = asReviewedDiffSha(p)
      let gate: (() => RestoreReview | null) | undefined
      if (latest?.scope !== 'conversation') {
        if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('undo_boundary_unavailable', 'This prompt has no eligible recorded Undo boundary.')
        // SPEC §16.3: files are restored only in an owned, unshared worktree; unknown capabilities review first.
        gate = () => restoreGate(ctx, { threadId: operation.threadId, workspace, target: latest, kind: 'undo', reviewedDiffSha })
      }
      // SPEC §13.2: a provider that rolls its own session back would undo natively; none does yet.
      const caps = ctx.mms.orchestrator.capabilitiesForThread(operation.threadId)
      const undoStrategy = caps && canUndoNatively(caps) ? 'native_rollback' as const : 'checkpoint' as const
      const ran = await localActionRun(ctx, operation.threadId, 'undo', async () =>
        latest?.scope === 'conversation'
          ? new ConversationActionService(operation.threadDirectory).apply(branchId, 'undo', operation.currentGeneration, expectedTurnId, validate, restore)
          : await new UndoService(operation.threadDirectory).undoLatest(branchId, workspace!.worktreePath, undefined, operation.currentGeneration, restore, 'undo', expectedTurnId, validate),
      { gate, outcome: { undoStrategy } })
      if ('review' in ran) return ran.review
      const { runId, result: action } = ran
      ctx.emitEvent?.('actions.updated', { threadId: operation.threadId, action }, operation.threadId)
      return { action, runId }
    }
    case 'actions.revertCode': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      const actionId = asString(p.actionId, 'actionId', 256)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = await new ThreadWorkspaceManager(operation.threadDirectory).loadOrSnapshotAsync()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      const target = new ThreadActionService(operation.threadDirectory).get(actionId)
      const reviewedDiffSha = asReviewedDiffSha(p)
      const ran = await localActionRun(ctx, operation.threadId, 'revert', () =>
        new CodeRevertService(operation.threadDirectory).revertCode(actionId, workspace.worktreePath, operation.currentGeneration),
      { gate: () => restoreGate(ctx, { threadId: operation.threadId, workspace, target, kind: 'revert', reviewedDiffSha }) })
      if ('review' in ran) return ran.review
      const { runId, result: action } = ran
      return { action, runId }
    }
    case 'actions.redo': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      const branchId = asOptionalString(p.conversationBranchId, 256) ?? new ThreadWorkspaceManager(operation.threadDirectory).load()?.conversationBranchId ?? 'main'
      const workspace = await new ThreadWorkspaceManager(operation.threadDirectory).loadOrSnapshotAsync()
      if (new ThreadActionService(operation.threadDirectory).latest(branchId)?.scope === 'conversation') {
        if (branchId !== (workspace?.conversationBranchId ?? 'main')) throw new DomainRpcError('branch_not_active', 'Conversation history requires the active branch.')
        const action = new ConversationActionService(operation.threadDirectory).apply(branchId, 'redo', operation.currentGeneration, undefined, (target) => {
          ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, 'redo')
          if (ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)) throw new DomainRpcError('thread_busy', 'Wait for active or queued work to finish.')
        }, (target, kind) => {
          ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, kind)
          if (kind === 'redo') ctx.mms.orchestrator.restoreConversationActionEnd(operation.threadId, target.presentationMessageStart, target.presentationMessageEnd, target.nativeContextBoundary)
          else ctx.mms.orchestrator.restoreConversationBoundary(operation.threadId, target.presentationMessageStart, target.nativeContextStartBoundary!)
        })
        ctx.emitEvent?.('actions.updated', { threadId: operation.threadId, action }, operation.threadId)
        return { action }
      }
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath ?? undefined)
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      const action = await new RedoService(operation.threadDirectory).redoLatest(branchId, workspace.worktreePath, operation.currentGeneration, (original) => {
        if (original.nativeContextStartBoundary) ctx.mms.orchestrator.restoreConversationActionEnd(operation.threadId, original.presentationMessageStart, original.presentationMessageEnd, original.nativeContextBoundary)
      })
      return { action }
    }
    case 'actions.fork': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const sourceBranchId = asOptionalString(p.conversationBranchId, 256) ?? new ThreadWorkspaceManager(operation.threadDirectory).load()?.conversationBranchId ?? 'main'
      const actionId = asString(p.actionId, 'actionId', 256)
      const name = asOptionalString(p.name, 256) ?? 'Alternate'
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      const action = new ThreadActionService(operation.threadDirectory).get(actionId)
      if (!action) throw new DomainRpcError('action_not_found', `Action not found: ${actionId}`)
      if (p.codeMode !== undefined && p.codeMode !== 'current' && p.codeMode !== 'historical') throw new DomainRpcError('invalid_params', 'Invalid fork code mode')
      // `start`: the branch begins before the action's turn, as an edited version of its prompt; `end` (default): after it.
      if (p.at !== undefined && p.at !== 'start' && p.at !== 'end') throw new DomainRpcError('invalid_params', "at must be 'start' or 'end'")
      const at = p.at === 'start' ? 'start' as const : 'end' as const
      const activate = asOptionalBoolean(p.activate, 'activate') === true
      if (activate && at !== 'start') throw new DomainRpcError('invalid_params', "activate applies to at: 'start' (an edited prompt)")
      const service = new ConversationBranchService(operation.threadDirectory)
      const assertIdle = () => assertHistoryIdle(ctx, operation.threadId)
      // Refused at once while a turn runs (the locks would wait for it), and again under the locks.
      assertIdle()
      const savedFor = (branch: import('../../shared/threadActions').ConversationBranch) => saveConversationState(ctx, operation.threadId, operation.threadDirectory, branch.id, at === 'start'
        ? { presentationEnd: action.presentationMessageStart, nativeEnd: branch.contextBoundary.messageIndex, boundary: branch.contextBoundary }
        : { presentationEnd: action.presentationMessageEnd, nativeEnd: action.nativeContextBoundary.messageIndex, boundary: action.nativeContextBoundary })
      if (activate) {
        await recoverBranchSwitch(ctx, operation.threadId, operation.threadDirectory, workspace.worktreePath)
        operation.currentGeneration = new ThreadActionService(operation.threadDirectory).currentRevision()
        // An edited prompt: the branch is made and switched to in one step under the thread's locks, conversation only.
        const { branch, notice } = await service.edit(workspace.worktreePath, sourceBranchId, actionId, name, {
          expectedJournalRevision: operation.currentGeneration,
          assertIdle,
          saveContext: (leaving) => saveConversationState(ctx, operation.threadId, operation.threadDirectory, leaving),
          created: savedFor,
          restoreContext: (selected) => {
            const state = loadConversationState(operation.threadDirectory, selected.id)
            ctx.mms.orchestrator.replaceConversationState(operation.threadId, state.messages, state.nativeContext)
          }
        })
        return { branch, activated: true, ...(notice ? { notice } : {}) }
      }
      saveConversationState(ctx, operation.threadId, operation.threadDirectory, sourceBranchId)
      const branch = await service.fork(workspace.worktreePath, sourceBranchId, actionId, name, operation.currentGeneration, p.codeMode === 'current' ? 'current' : 'historical', at, assertIdle)
      savedFor(branch)
      return { branch }
    }
    case 'actions.activateBranch': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const branchId = asString(p.conversationBranchId, 'conversationBranchId', 256)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const loaded = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!loaded || loaded.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      // Refused at once while a turn runs (the locks would wait for it), and again under the locks below. A switch
      // that stopped is finished first; the branch being left is read after it.
      assertHistoryIdle(ctx, operation.threadId)
      await recoverBranchSwitch(ctx, operation.threadId, operation.threadDirectory, loaded.worktreePath)
      // Recovery is Mousse's own write: the generation the caller checked against moves past it.
      operation.currentGeneration = new ThreadActionService(operation.threadDirectory).currentRevision()
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load() ?? loaded
      const branches = new ConversationBranchService(operation.threadDirectory)
      const leaving = workspace.conversationBranchId ?? FIRST_BRANCH_ID
      // A branch with no record, a removed one, or one whose conversation was never saved or can't be read is refused
      // before anything changes. The branch being left has its conversation saved by the switch itself.
      const unavailable = (message = `Conversation branch ${branchId} is not available to switch to. Nothing was changed.`) => new DomainRpcError('conversation_branch_unavailable', message, { branchId })
      if (!branches.available(branchId, workspace)) throw unavailable()
      let target: ConversationStateSnapshot | undefined
      if (branchId !== leaving) {
        if (!existsSync(conversationStatePath(operation.threadDirectory, branchId))) throw unavailable()
        try { target = loadConversationState(operation.threadDirectory, branchId) } catch { throw unavailable(`The saved conversation of branch ${branchId} can't be read. Nothing was changed.`) }
      }
      // The conversation being left is saved under its own branch once the switch is known to go ahead, then the selected one's is put in place.
      const { branch, notice } = await branches.activate(workspace.worktreePath, branchId, operation.currentGeneration, () => {
        const state = target ?? loadConversationState(operation.threadDirectory, branchId)
        ctx.mms.orchestrator.replaceConversationState(operation.threadId, state.messages, state.nativeContext)
      }, (left) => saveConversationState(ctx, operation.threadId, operation.threadDirectory, left),
      // Checked under the thread's locks: a turn that started first holds them, and none can start after the check
      // until the switch is done. Before them, a switch could land after a turn, or switch files under it.
      () => assertHistoryIdle(ctx, operation.threadId))
      return { branch, ...(notice ? { notice } : {}) }
    }
    case 'operations.get': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const operationId = asString(p.operationId, 'operationId', 256)
      return { operation: new ThreadJournal(operation.threadDirectory).latestByOperation().get(operationId) }
    }
    case 'operations.recover': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = await new ThreadWorkspaceManager(operation.threadDirectory).loadOrSnapshotAsync()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      assertNoRunningTurn(ctx, operation.threadId)
      let cancelledIntegrations: Awaited<ReturnType<typeof cancelPendingIntegrations>>
      let publish: Awaited<ReturnType<PublishService['recoverPending']>>
      let releaseRetained: string | undefined
      try {
        // A merge of a subagent result an older version left unfinished is cancelled, never run again.
        // This request holds no thread lease: right before each record, after the Git reads, no turn may have started.
        const noTurn = (): void => assertNoRunningTurn(ctx, operation.threadId)
        cancelledIntegrations = await cancelPendingIntegrations(operation.threadDirectory, workspace.worktreePath, noTurn)
        // A left merge that was finished, aborted or replaced since is no longer offered for Abort.
        await clearStaleLeftMerges(operation.threadDirectory, noTurn)
        // A folder with no worktree has nothing to publish, and neither has a thread in its project's own folder: its work
        // is already there, so there is no Publish to recover, and the person's checkout is never treated as one's target.
        publish = operation.projectPath && !workspace.snapshotOnly && !isProjectFolderWorkspace(workspace) ? await new PublishService(operation.threadDirectory).recoverPending(workspace.worktreePath, operation.projectPath) : []
        await new ThreadActionService(operation.threadDirectory).recoverPending(workspace.worktreePath)
        await new CodeRevertService(operation.threadDirectory).recoverPending(workspace.worktreePath)
        await new UndoService(operation.threadDirectory).recoverPending(workspace.worktreePath, (target, kind) => {
          if (kind === 'redo' && target.nativeContextStartBoundary) ctx.mms.orchestrator.restoreConversationActionEnd(operation.threadId, target.presentationMessageStart, target.presentationMessageEnd, target.nativeContextBoundary)
          else if (target.nativeContextStartBoundary) ctx.mms.orchestrator.restoreConversationBoundary(operation.threadId, target.presentationMessageStart, target.nativeContextStartBoundary)
        })
        await new ConversationBranchService(operation.threadDirectory).recoverPending(workspace.worktreePath, (branch) => {
          const target = loadConversationState(operation.threadDirectory, branch.id)
          ctx.mms.orchestrator.replaceConversationState(operation.threadId, target.messages, target.nativeContext)
        })
        // Last, since it waits for every other operation: a release of old Undo history that stopped halfway is finished
        // by the release itself, limited to the ones that stopped.
        // A hidden store's release never leaves one stopped halfway; it refuses whole, and is said below if anything waits.
        const releases = workspace.snapshotOnly ? 0 : [...new ThreadJournal(operation.threadDirectory).latestByOperation().values()].filter((entry) => entry.operationType === 'undo-ref-release' && entry.state === 'prepared').length
        if (releases) {
          try {
            const released = await new ReceiptRefReleaseService(ctx.mms.threads.lifecycleStore, operation.threadId).release(workspace.worktreePath, { limit: releases })
            releaseRetained = released.retained[0]?.reason
          } catch (error) {
            // Refused as a whole (another operation still waits, the clock needs a review): the release stays pending.
            if (isLeaseBusy(error)) throw error
            releaseRetained = recoveryErrorText(error)
          }
        }
      } catch (error) {
        // What stopped recovery is for the person to read in the banner or the CLI, never an internal error.
        if (error instanceof DomainRpcError) throw error
        throw new DomainRpcError(isLeaseBusy(error) ? 'thread_busy' : 'recovery_failed', isLeaseBusy(error) ? THREAD_BUSY_TEXT : recoveryErrorText(error))
      }
      // What still waits after this attempt, in plain words: recovery reports the truth, not only that it ran.
      const left = await threadRecovery(operation.threadDirectory, operation.projectPath)
      const stillWaiting = !left ? undefined
        : publish.some((item) => item.state === 'pending') && left.kind === 'publish' ? "the project folder can't be read, so Mousse can't tell yet whether the Publish reached its branch"
        : releaseRetained && left.operationType === 'undo-ref-release' ? `old Undo history could not be released yet: ${releaseRetained}`
        : left.kind === 'merge' ? 'a merge from an earlier version is still in progress; abort it, or finish it with Git'
        : left.operationType ? `recovery could not finish the ${left.operationType} operation: ${left.reason}` : left.reason
      return {
        ok: true,
        settled: !left,
        ...(left ? { recovery: left, stillWaiting } : {}),
        ...(cancelledIntegrations.length ? { cancelledIntegrations } : {})
      }
    }
    case 'operations.abort': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const operationId = asString(p.operationId, 'operationId', 256)
      const record = new ThreadJournal(operation.threadDirectory).latestByOperation().get(operationId)
      if (!record) throw new DomainRpcError('operation_not_found', `Operation not found: ${operationId}`)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (record.operationType !== 'publish' && !workspace) throw new DomainRpcError('workspace_not_ready', 'Thread workspace is missing')
      assertNoRunningTurn(ctx, operation.threadId)
      let aborted: Awaited<ReturnType<ManagedConflictService['abort']>>
      try {
        aborted = await new ManagedConflictService(operation.threadDirectory).abort(record.operationType === 'publish' ? operation.projectPath : workspace!.worktreePath, operationId)
      } catch (error) {
        // Why the merge could not be aborted is for the person to read in the banner or the CLI.
        throw new DomainRpcError(isLeaseBusy(error) ? 'thread_busy' : 'abort_failed', isLeaseBusy(error) ? THREAD_BUSY_TEXT : recoveryErrorText(error))
      }
      // What the abort wrote over, conflicted files with their edits, is kept under this ref for the thread's Undo window.
      return { ok: true, preservedRef: aborted.preservedRef, notice: abortKeptNotice(aborted.kind, aborted.kept) }
    }
    case 'publish.status': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      // A thread in its project's folder has nothing to publish: its work is already in the primary checkout.
      if (isProjectFolderWorkspace(workspace)) return { available: false, workspace, reason: PROJECT_FOLDER_PUBLISH_REASON }
      const sourceSha = workspace?.lifecycle === 'ready' ? workspace.snapshotSha ?? await workspaceGitAsync(workspace.worktreePath, ['rev-parse', 'HEAD']) : undefined
      return { available: Boolean(workspace?.lifecycle === 'ready'), workspace, sourceSha, targetSha: await workspaceGitAsync(operation.projectPath, ['rev-parse', 'HEAD']), journalGeneration: operation.currentGeneration }
    }
    case 'publish.start': {
      const p = isObject(params) ? params : {}
      // Exact completed-operation replay is checked by PublishService before concurrency validation.
      const operation = threadOperationContext(ctx, { ...p, expectedJournalGeneration: undefined })
      const targetBranch = asString(p.targetBranch, 'targetBranch', 512)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (isProjectFolderWorkspace(workspace)) throw new DomainRpcError('thread_in_project_folder', PROJECT_FOLDER_PUBLISH_REASON)
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      // The thread's name is the commit message in the primary checkout, where the person's own history reads it.
      const message = ctx.mms.threads.getThread(operation.threadId)?.name?.trim() || undefined
      return await new PublishService(operation.threadDirectory).publish(workspace.worktreePath, operation.projectPath, targetBranch, undefined, { message, expectedSourceSha: asOptionalString(p.expectedSourceSha, 64), expectedTargetSha: asOptionalString(p.expectedTargetSha, 64), expectedJournalRevision: asOptionalBoundedInt(p.expectedJournalGeneration, 'expectedJournalGeneration', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? operation.currentGeneration, operationId: asOptionalString(p.operationId, 256) })
    }
    case 'files.root': {
      const p = isObject(params) ? params : {}
      if (!isLocalWindow(ctx)) return { root: projectRootContext(ctx, p) }
      // Restores a retired worktree like the calls that read it, so the header, the terminal's folder,
      // file links and the tree all name the same folder.
      await materializeRequestedWorkspace(ctx, p)
      return { root: await localFilesRoot(ctx, p) }
    }
    case 'files.drives': {
      // The drives (or root and volumes) and home folder the Files panel of this computer's window offers.
      if (!isLocalWindow(ctx) || ctx.connection?.bridgeCaller)
        throw new DomainRpcError('forbidden', 'Only a Mousse window on this computer lists its drives')
      return await listFilesPlaces()
    }
    case 'files.list': {
      const p = isObject(params) ? params : {}
      return await fileCall(ctx, async () => {
        const root = browsedFilesRoot(ctx, p) ?? await filesRootContext(ctx, p)
        return { entries: await ctx.mms.fileService.listDir(root, containedPath(ctx, root, p.path), guardFor(ctx)) }
      })
    }
    case 'files.read': {
      const p = isObject(params) ? params : {}
      return await fileCall(ctx, async () => {
        const root = browsedFilesRoot(ctx, p) ?? await filesRootContext(ctx, p)
        const path = requiredContainedPath(ctx, root, p.path)
        return { path, content: await ctx.mms.fileService.readFile(root, path, guardFor(ctx)) }
      })
    }
    case 'files.readAsset': {
      const p = isObject(params) ? params : {}
      // A preview can be far larger than a message: the caller reads it piece by piece and joins the pieces.
      const offset = asOptionalBoundedInt(p.offset, 'offset', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0
      const length = asOptionalBoundedInt(p.length, 'length', { min: 1, max: FILE_ASSET_PIECE_BYTES }) ?? FILE_ASSET_PIECE_BYTES
      return await fileCall(ctx, async () => {
        const root = browsedFilesRoot(ctx, p) ?? await filesRootContext(ctx, p)
        const path = requiredContainedPath(ctx, root, p.path)
        const piece = await ctx.mms.fileService.readAssetRange(root, path, offset, length, guardFor(ctx))
        return { path, mimeType: piece.mimeType, size: piece.size, offset, data: Buffer.from(piece.data).toString('base64') }
      })
    }
    case 'files.writeDirect': {
      // The editor's save on this computer: it writes the file as it is and records no action, so unlike
      // `files.write` it has no 512 KiB limit and nothing to Undo; a save is limited only by the 4 MiB request frame. Not for other computers.
      if (!isLocalWindow(ctx)) throw new DomainRpcError('forbidden', 'Only a Mousse window on this computer saves files directly')
      const p = isObject(params) ? params : {}
      const expectedProfileId = asOptionalString(p.expectedProfileId, 256)
      if (expectedProfileId && expectedProfileId !== ctx.mms.profileId) {
        throw new DomainRpcError('profile_mismatch', 'Profile changed while saving; the file was not written')
      }
      // An empty file is a valid save, so this is not `asString`.
      if (typeof p.content !== 'string') throw new DomainRpcError('invalid_params', 'content must be a string')
      if (saveExceedsRequest(p.content)) throw new DomainRpcError('file_too_large', SAVE_TOO_LARGE_MESSAGE)
      const content = p.content
      return await fileCall(ctx, async () => {
        const browsed = browsedFilesRoot(ctx, p)
        // The file was read from the thread's worktree, so a retired one comes back before it is written.
        if (!browsed) await materializeRequestedWorkspace(ctx, p)
        const root = browsed ?? await localFilesRoot(ctx, p)
        const path = requiredContainedPath(ctx, root, p.path)
        if (browsed) {
          // A folder the person browsed to is any folder of this computer: Git's own files, the Mousse data
          // folders and the folders of the user's sign-ins and keys are never saved into from there.
          const refusal = browsedSaveRefusal(resolve(root, path), [ctx.mms.getHomeDir(), ctx.mms.getProfileHomeDir()])
          if (refusal) throw new DomainRpcError('path_protected', refusal)
        }
        const lines = await ctx.mms.fileService.writeFile(root, path, content)
        ctx.mms.lineEditStats.record('manual', lines)
        return { path }
      })
    }
    case 'files.write': {
      const p = isObject(params) ? params : {}
      await ensureOwnedTaskWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const guard = guardFor(ctx)
      const wanted = asString(p.path, 'path', 4096)
      // Checked once, before the action is recorded, so a refused path leaves no action behind. What the repository says about
      // hooks and configuration is looked up first, without blocking the daemon.
      await guard.prepare?.(root, wanted, 'write').catch(() => undefined)
      let guarded: GuardedPath
      try {
        guarded = guard.resolve(root, wanted, 'write')
      } catch (error) {
        throw refusedPath(error)
      }
      const path = guarded.relative
      // Another computer sends a large file ahead of the call (a staged value, at most what staging holds); every other caller keeps the 512 KiB limit.
      const content = asString(p.content, 'content', ctx.connection?.bridgeCaller ? ROUTED_STAGE_ITEM_BYTES : 512 * 1024)
      const threadId = asOptionalString(p.threadId, 256)
      if (threadId) {
        const operation = threadOperationContext(ctx, p)
        const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
        if (workspace) {
          if (workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Task workspace requires recovery before saving.')
          const actions = new ThreadActionService(operation.threadDirectory)
          const latest = actions.latest(workspace.conversationBranchId)
          const { result: lineEdits, action } = await actions.runCheckpointedAction({
            threadId, turnId: randomUUID(), conversationBranchId: workspace.conversationBranchId,
            workspacePath: root, actor: { kind: 'user' }, expectedJournalRevision: operation.currentGeneration,
            presentationMessageStart: latest?.presentationMessageEnd ?? 0, presentationMessageEnd: latest?.presentationMessageEnd ?? 0,
            nativeContextBoundary: latest?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' }
          }, () => ctx.mms.fileService.writeFile(root, path, content, guard, guarded)).catch(refusalOfAction)
          // Covers daemon-side writers only: desktop saves and agent edits never reach this method
          // (the search index refreshes on its own 15 s stale rule).
          getWorkspaceIndexRegistry().invalidate(root)
          ctx.emitEvent?.('actions.updated', { threadId, action }, threadId)
          return { path, lineEdits, receiptId: action.receiptId }
        }
      }
      const lineEdits = await ctx.mms.fileService.writeFile(root, path, content, guard, guarded).catch(refusalOfAction)
      getWorkspaceIndexRegistry().invalidate(root)
      return { path, lineEdits }
    }
    case 'files.stat': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      return { stat: await ctx.mms.fileService.stat(root, requiredContainedPath(ctx, root, p.path), guardFor(ctx)) }
    }
    case 'files.search': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const query = asOptionalString(p.query, 512) ?? ''
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: 200 }) ?? 50
      const kinds = p.kinds === undefined || p.kinds === null
        ? undefined
        : asStringArray(p.kinds, 'kinds', { unique: true, maxItems: 2, maxItemLen: 16 }).map((kind) => {
          if (kind !== 'file' && kind !== 'directory') throw new DomainRpcError('invalid_params', "kinds must be 'file' or 'directory'")
          return kind
        })
      const absoluteRoot = resolve(root)
      const { snapshot, indexing } = await getWorkspaceIndexRegistry().get(absoluteRoot)
      if (!snapshot) {
        return { root: absoluteRoot, source: null, results: [], indexed: 0, indexedAt: null, truncated: false, indexing: true, complete: false } satisfies FileSearchResponse
      }
      const ranked = await searchWorkspacePaths(snapshot, query, { limit, kinds })
      // Results only, never the index: a client never receives the path list itself.
      return {
        root: absoluteRoot,
        source: snapshot.source,
        ...(snapshot.fallbackReason ? { fallbackReason: snapshot.fallbackReason } : {}),
        results: ranked.results,
        indexed: snapshot.files.length + snapshot.folders.length,
        indexedAt: new Date(snapshot.builtAt).toISOString(),
        truncated: snapshot.truncated,
        indexing,
        complete: snapshot.complete && ranked.complete
      } satisfies FileSearchResponse
    }
    case 'files.grep': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      // Not `asString`: a query of spaces is a legitimate search, an empty one is not.
      const query = asOptionalString(p.query, 512)
      if (!query) throw new DomainRpcError('invalid_params', 'query must be a non-empty string')
      return await grepWorkspace(root, query, {
        regex: asOptionalBoolean(p.regex, 'regex') === true,
        caseSensitive: asOptionalBoolean(p.caseSensitive, 'caseSensitive'),
        wholeWord: asOptionalBoolean(p.wholeWord, 'wholeWord') === true,
        limit: asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: 2000 }) ?? 500,
        timeoutMs: asOptionalBoundedInt(p.timeoutMs, 'timeoutMs', { min: 100, max: 10_000 }) ?? 1_000
      }) satisfies FileGrepResponse
    }
    case 'git.status': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const status = await ctx.mms.gitService.getStatus(root)
      // How long a Discard here keeps its copy, for the confirmation to say: the owner's Undo window.
      const owner = discardOwnerFor(ctx, p)
      return { status: owner ? { ...status, discardKeptForMs: keptCopyWindowMs(owner) } : status }
    }
    case 'git.diff': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      return { diff: await ctx.mms.gitService.getDiff(root, requiredContainedPath(ctx, root, p.path, 'inspect'), asOptionalBoolean(p.staged, 'staged') === true) }
    }
    case 'git.log': {
      const p = isObject(params) ? params : {}
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: 100 }) ?? 30
      await materializeRequestedWorkspace(ctx, p)
      return { commits: await ctx.mms.gitService.getLog(projectRootContext(ctx, p), limit) }
    }
    case 'git.branches': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      return { branches: await ctx.mms.gitService.getBranches(projectRootContext(ctx, p)) }
    }
    case 'git.diffStats': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      return { stats: await ctx.mms.gitService.getDiffStats(projectRootContext(ctx, p)) }
    }
    case 'git.lastCommitMessage': {
      const p = isObject(params) ? params : {}
      await materializeRequestedWorkspace(ctx, p)
      return { message: await ctx.mms.gitService.lastCommitMessage(projectRootContext(ctx, p)) }
    }
    case 'git.checkout': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p, 'task_branch_authoritative')
      const dirty = asOptionalString(p.dirty, 16)
      if (dirty !== undefined && dirty !== 'carry' && dirty !== 'stash') throw new DomainRpcError('invalid_params', 'dirty must be carry or stash')
      const result = await clearingSelectionWhenHeadMoves(ctx, p, target, () => ctx.mms.gitService.checkout(target.root, gitUserAction(ctx, 'Switch branch'), asString(p.branch, 'branch', 512), { ...(dirty ? { dirty } : {}), ...gitOperationOptions(ctx, p) }))
      return gitStatusResult(ctx, target.root, { ...result })
    }
    case 'git.commit': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const message = asString(p.message, 'message', 4096)
      const amend = asOptionalBoolean(p.amend, 'amend') === true
      const expectedBranch = asOptionalString(p.expectedBranch, 512)
      // Without it (an older client), the rule from before: everything in a thread's worktree, else the index or everything.
      const selection = asCommitSelection(p.selection)
      const thread = threadWorktree(target)
      const place = selectionPlaceFor(ctx, p, target.root, true)
      // Only a chosen commit refuses while a turn works there; the others keep their rules.
      const chosenPlace = selection?.mode === 'chosen' ? place : { ...place, assertIdle: undefined }
      if (thread) {
        // A thread's commits are recorded one by one with the actions that made them, so an amend is refused before Git runs.
        if (amend) throw gitThreadRules.create('git_amend_in_thread')
        // Committed through the user's hooks as one commit; a rejected commit is recorded as a failed action.
        await followedGitAction(ctx, p, target.root, 'commit', (request, signal) =>
          runUserThreadGitAction(ctx, thread, { signal }, () => ctx.mms.gitService.commit(target.root, gitUserAction(ctx, 'Commit'), message, { all: true, expectedBranch, ...(selection ? { selection } : {}), place: chosenPlace, ...request })))
      } else await followedGitAction(ctx, p, target.root, 'commit', (request) => ctx.mms.gitService.commit(target.root, gitUserAction(ctx, amend ? 'Amend the last commit' : 'Commit'), message, { amend, expectedBranch, ...(selection ? { selection } : {}), place: chosenPlace, ...request }))
      announceSelection(ctx, p, place)
      return gitStatusResult(ctx, target.root)
    }
    case 'git.push': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const expectedBranch = asOptionalString(p.expectedBranch, 512)
      const { root, directory, workspace: metadata } = target
      // A thread's own branch goes to its pull request's branch when that is provably the same repository (never a client's choice).
      const threadId = asOptionalString(p.threadId, 256)
      const prTarget = metadata && threadId ? await pullRequestPushTarget(ctx, threadId, root) : null
      let notice: string | undefined
      const toPullRequest = prTarget?.remote && prTarget.branch ? { toRemote: prTarget.remote, toBranch: prTarget.branch } : {}
      await followedGitAction(ctx, p, root, 'push', (request, signal) => {
        if (!metadata || !directory) return ctx.mms.gitService.push(root, gitUserAction(ctx, 'Push'), { expectedBranch, ...request })
        return withGitMutationLocks(directory, root, 'user-git-push', async () => {
          const manager = new ThreadWorkspaceManager(directory)
          if ((await manager.verify()).lifecycle !== 'ready' || manager.load()?.headSha !== metadata.headSha) throw new DomainRpcError('task_revision_changed', 'Task revision changed before push; refresh the reviewed revision')
          // A push sends commits. Files that are not committed are not in them, and they are not a reason to hold the commits back.
          const uncommitted = (await workspaceGitAsync(root, ['status', '--porcelain', '--untracked-files=all'])).split(/\r?\n/).filter(Boolean).length
          await ctx.mms.gitService.push(root, gitUserAction(ctx, 'Push'), { expectedBranch, ...toPullRequest, ...request })
          if (uncommitted) notice = uncommittedNotPushedNotice(uncommitted)
        }, signal)
      })
      return gitStatusResult(ctx, root, notice ? { notice } : {})
    }
    case 'git.suggestCommitMessage': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'expectedBranch', 'selection'])
      const selection = asCommitSelection(p.selection)
      // Reads and proposes only: it never provisions a worktree or changes the repository. A worktree that
      // cleanup retired is restored first, because the draft describes what the folder holds.
      await materializeRequestedWorkspace(ctx, p)
      const root = pullRequestFolder(ctx, p)
      const threadId = asOptionalString(p.threadId, 256) ?? null
      const expectedBranch = asOptionalString(p.expectedBranch, 512)
      await ctx.mms.gitService.assertBranch(root, expectedBranch)
      // A thread's own worktree commits every change (see `git.commit`), so that is what is described there.
      const inWorktree = threadId !== null && new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId)).load() !== null
      const projectId = asOptionalString(p.projectId, 256) ?? (threadId ? ctx.mms.threads.getThread(threadId)?.projectId ?? null : null)
      // A chosen selection is described as the commit would take it, and only while it is the one the person saw.
      const describe = selection?.mode === 'chosen' ? () => ctx.mms.gitService.describeSelection(root, selectionPlaceFor(ctx, p, root), selection.token) : undefined
      return await ctx.mms.orchestrator.generateCommitMessage({ root, all: inWorktree || selection?.mode === 'all', projectId, threadId: inWorktree ? threadId : null, branch: expectedBranch ?? null, ...(describe ? { describe } : {}) })
    }
    case 'git.stage':
    case 'git.unstage': {
      const p = isObject(params) ? params : {}
      // A commit in a thread's worktree takes every change, so staging has no effect there.
      const target = await gitMutationTarget(ctx, p, 'thread_worktree_checkpointed')
      const all = asOptionalBoolean(p.all, 'all') === true
      const staging = method === 'git.stage'
      const action = gitUserAction(ctx, staging ? 'Stage' : 'Unstage')
      // The project's "everything left out" marker stays only when it held right before this write.
      const marker = selectionMarkerOf(() => selectionPlaceFor(ctx, p, target.root))
      if (all) await (staging ? ctx.mms.gitService.stageAll(target.root, action, marker) : ctx.mms.gitService.unstageAll(target.root, action, marker))
      else await (staging ? ctx.mms.gitService.stage(target.root, action, await gitPaths(ctx, target.root, p.paths), marker) : ctx.mms.gitService.unstage(target.root, action, await gitPaths(ctx, target.root, p.paths), marker))
      return gitStatusResult(ctx, target.root)
    }
    case 'git.discard': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const paths = await gitPaths(ctx, target.root, p.paths)
      // A thread's discard, in its worktree or its project's folder, is recorded as an action of the person, so the files
      // before it are in a snapshot, and the thread owns the copy. The person's own checkout, with no thread, keeps the
      // copy for the project.
      const thread = recordedThreadTarget(ctx, p, target)
      const owner = thread?.directory ?? projectKeptFilesOwnerFor(ctx, p, target.root)
      const marker = threadWorktree(target) ? undefined : selectionMarkerOf(() => selectionPlaceFor(ctx, p, target.root))
      const discard = () => ctx.mms.gitService.discard(target.root, gitUserAction(ctx, 'Discard changes'), paths, { owner }, marker)
      let kept: DiscardedCopy | undefined
      if (thread) {
        const effects: ExternalEffect[] = [{ kind: 'unknown', description: `Discarded ${paths.length} ${paths.length === 1 ? 'file' : 'files'}`, reversible: false }]
        kept = await runUserThreadGitAction(ctx, thread, { externalEffects: effects }, discard)
      } else kept = await discard()
      const left = kept ? leftAsItIsText(kept.left) : undefined
      return gitStatusResult(ctx, target.root, kept ? { kept: { ref: kept.ref, windowMs: kept.windowMs, notice: keptCopyNotice(kept), ...(left ? { left } : {}) } } : {})
    }
    case 'git.fetch': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const result = await followedGitAction(ctx, p, target.root, 'fetch', (request, signal) => underThreadLocks(target, 'user-git-fetch', () => ctx.mms.gitService.fetch(target.root, gitUserAction(ctx, 'Fetch'), request), signal))
      return gitStatusResult(ctx, target.root, { ...result })
    }
    case 'git.pull': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p, 'task_branch_authoritative')
      const strategy = asOptionalString(p.strategy, 16) ?? 'ff-only'
      if (strategy !== 'ff-only' && strategy !== 'merge' && strategy !== 'rebase') throw new DomainRpcError('invalid_params', 'strategy must be ff-only, merge or rebase')
      const result = await clearingSelectionWhenHeadMoves(ctx, p, target, () => followedGitAction(ctx, p, target.root, 'pull', (request) => ctx.mms.gitService.pull(target.root, gitUserAction(ctx, 'Pull'), { strategy: strategy as GitPullStrategy, ...request })))
      return gitStatusResult(ctx, target.root, { ...result })
    }
    case 'git.abortInProgress': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const kind = asString(p.kind, 'kind', 16)
      if (kind !== 'merge' && kind !== 'rebase') throw new DomainRpcError('invalid_params', 'kind must be merge or rebase')
      // A thread worktree allows it: it gives up a merge or rebase a terminal started, back to the recorded head. Owned as
      // a Discard's copy is: a thread's abort is a recorded action of the person, so the files before and after it are in
      // snapshots and the thread owns the copy; the person's own checkout keeps the copy for the project.
      const thread = recordedThreadTarget(ctx, p, target)
      const owner = thread?.directory ?? projectKeptFilesOwnerFor(ctx, p, target.root)
      const abortKeeping = () => ctx.mms.gitService.abortInProgress(target.root, gitUserAction(ctx, `Abort the ${kind}`), kind, { owner })
      const kept = await clearingSelectionWhenHeadMoves(ctx, p, target, () => thread
        ? runUserThreadGitAction(ctx, thread, { externalEffects: [{ kind: 'unknown', description: `Aborted the ${kind}`, reversible: false }] }, abortKeeping)
        : abortKeeping())
      return gitStatusResult(ctx, target.root, kept ? { kept: { ref: kept.ref, windowMs: kept.windowMs, notice: abortKeptNotice(kind, kept) } } : {})
    }
    case 'git.createBranch': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p, 'task_branch_authoritative')
      await ctx.mms.gitService.createBranch(target.root, gitUserAction(ctx, 'Create branch'), asString(p.name, 'name', 512), { from: asOptionalString(p.from, 512), checkout: asOptionalBoolean(p.checkout, 'checkout') })
      return gitStatusResult(ctx, target.root)
    }
    case 'git.renameBranch': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p, 'task_branch_authoritative')
      await ctx.mms.gitService.renameBranch(target.root, gitUserAction(ctx, 'Rename branch'), asString(p.name, 'name', 512), asString(p.newName, 'newName', 512))
      return gitStatusResult(ctx, target.root)
    }
    case 'git.deleteBranch': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p, 'task_branch_authoritative')
      await ctx.mms.gitService.deleteBranch(target.root, gitUserAction(ctx, 'Delete branch'), asString(p.name, 'name', 512), { force: asOptionalBoolean(p.force, 'force') === true })
      return gitStatusResult(ctx, target.root)
    }
    case 'git.changes': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'paths'])
      await materializeRequestedWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const paths = p.paths === undefined ? undefined : await gitPaths(ctx, root, p.paths)
      return await ctx.mms.gitService.readChanges(root, selectionPlaceFor(ctx, p, root), paths ? { paths } : {}) satisfies GitChangesResult
    }
    case 'git.include': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'path', 'version', 'include', 'hunks', 'lines', 'all'])
      const target = await gitMutationTarget(ctx, p)
      const place = selectionPlaceFor(ctx, p, target.root, true)
      const include = asBoolean(p.include, 'include')
      const action = gitUserAction(ctx, include ? 'Include in the commit' : 'Leave out of the commit')
      if (asOptionalBoolean(p.all, 'all') === true) {
        if (p.path !== undefined || p.hunks !== undefined || p.lines !== undefined) throw new DomainRpcError('invalid_params', 'all takes no path, hunks or lines')
        const result = await ctx.mms.gitService.includeAll(target.root, action, place, include)
        announceSelection(ctx, p, place)
        return result
      }
      const [path] = await gitPaths(ctx, target.root, [asString(p.path, 'path', 4096)])
      const result = await ctx.mms.gitService.include(target.root, action, place, { path: path!, version: asString(p.version, 'version', 128), include, ...asIncludeParts(p) })
      announceSelection(ctx, p, place)
      return result
    }
    case 'git.undoLastCommit': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'expectedHead'])
      const threadId = asOptionalString(p.threadId, 256)
      // A thread's commits are its recorded actions: Undo in the chat takes one back.
      if (threadId && threadPlacement(ctx.mms.threads.getThread(threadId)) !== 'project-folder') throw gitThreadRules.create('git_undo_in_thread')
      const target = await gitMutationTarget(ctx, p)
      const place = selectionPlaceFor(ctx, p, target.root, true)
      await ctx.mms.gitService.undoLastCommit(target.root, gitUserAction(ctx, 'Undo last commit'), asString(p.expectedHead, 'expectedHead', 128), place)
      announceSelection(ctx, p, place)
      return gitStatusResult(ctx, target.root)
    }
    case 'git.revert': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'path', 'version', 'hunks', 'lines'])
      const target = await gitMutationTarget(ctx, p)
      const [path] = await gitPaths(ctx, target.root, [asString(p.path, 'path', 4096)])
      const place = selectionPlaceFor(ctx, p, target.root, true)
      // Before a snapshot is taken for the recorded action: a running turn refuses at once.
      place.assertIdle?.()
      // Owned as a Discard's copy is: a thread's revert, in its worktree or its project's folder, is a recorded action of
      // the person and the thread keeps the copy; the person's own checkout keeps it for the project.
      const thread = recordedThreadTarget(ctx, p, target)
      const owner = thread?.directory ?? projectKeptFilesOwnerFor(ctx, p, target.root)
      const revertFile = () => ctx.mms.gitService.revert(target.root, gitUserAction(ctx, 'Revert'), place, { path: path!, version: asString(p.version, 'version', 128), ...asIncludeParts(p) }, { owner })
      const result = thread
        ? await runUserThreadGitAction(ctx, thread, { externalEffects: [{ kind: 'unknown', description: `Reverted changes in ${path}`, reversible: false }] }, revertFile)
        : await revertFile()
      announceSelection(ctx, p, place)
      return result
    }
    case 'git.restoreReverted': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'revertId'])
      const target = await gitMutationTarget(ctx, p)
      const revertId = asString(p.revertId, 'revertId', 128)
      const place = selectionPlaceFor(ctx, p, target.root, true)
      place.assertIdle?.()
      const thread = recordedThreadTarget(ctx, p, target)
      const owner = thread?.directory ?? projectKeptFilesOwnerFor(ctx, p, target.root)
      // A revert recorded while the thread stood otherwise in its project's folder is in the other journal.
      const also = revertJournalsFor(ctx, p).filter((journal) => journal !== owner)
      const restoreKept = (check: boolean) => ctx.mms.gitService.restoreReverted(target.root, gitUserAction(ctx, 'Restore reverted changes'), place, revertId, { owner, also }, { check })
      // A thread's restore writes files as a recorded action; one that has nothing to write (already restored, changed,
      // expired) records none.
      let result = await restoreKept(Boolean(thread))
      if ('pending' in result) {
        result = await runUserThreadGitAction(ctx, thread!, { externalEffects: [{ kind: 'unknown', description: 'Restored reverted changes', reversible: false }] }, () => restoreKept(false))
        // Changed in the moment between the check and the action: the answer is still one of the three.
        if ('pending' in result) result = { restored: false, reason: 'changed' }
      }
      if (result.restored) announceSelection(ctx, p, place)
      return result satisfies GitRestoreRevertedResult
    }
    case 'git.revertedList': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId'])
      await materializeRequestedWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const journals = revertJournalsFor(ctx, p)
      return journals.length ? await ctx.mms.gitService.revertedList(root, journals) : []
    }
    case 'git.cancelOperation': {
      const p = isObject(params) ? params : {}
      // Only the connection that started the action can stop it; anyone else is told it is not running.
      return { cancelled: ctx.mms.gitService.cancelOperation(asString(p.operationId, 'operationId', 64), ctx.connection?.id) }
    }
    case 'git.init': {
      const p = isObject(params) ? params : {}
      if (p.threadId !== undefined) throw new DomainRpcError('invalid_params', 'git.init takes a projectId, not a threadId')
      const root = projectRootContext(ctx, p)
      await ctx.mms.gitService.init(root, gitUserAction(ctx, 'Initialize Git'))
      return gitStatusResult(ctx, root)
    }
    case 'github.status':
      return { availability: await ctx.mms.gitService.github.getAvailability() }
    case 'github.createRepository': {
      const p = isObject(params) ? params : {}
      for (const key of Object.keys(p)) {
        if (!['projectId', 'name', 'visibility'].includes(key)) throw new Error(`${key} is not allowed`)
      }
      const projectId = asString(p.projectId, 'projectId', 256)
      const project = ctx.mms.projects.getProject(projectId)
      if (!project) throw new Error(`Project not found: ${projectId}`)
      if (await ctx.mms.gitService.isRepo(project.path)) throw new Error('This project is already a Git repository.')
      const visibility = asString(p.visibility, 'visibility', 16)
      if (visibility !== 'private' && visibility !== 'public') throw new Error('visibility must be private or public')
      const result = await ctx.mms.gitService.github.createRepository(project.path, {
        name: asString(p.name, 'name', 100),
        visibility
      }, gitUserAction(ctx, 'Create GitHub repository'))
      return { result }
    }
    case 'github.cloneRepository': {
      const p = isObject(params) ? params : {}
      for (const key of Object.keys(p)) {
        if (!['repository', 'destination'].includes(key)) throw new Error(`${key} is not allowed`)
      }
      const destination = await ctx.mms.gitService.github.cloneRepository({
        repository: asString(p.repository, 'repository', 512),
        destination: asString(p.destination, 'destination', 4096)
      }, gitUserAction(ctx, 'Clone repository'))
      const project = ctx.mms.projects.openProject(destination)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects: listedProjectsFor(ctx, projects) }
    }
    case 'pullRequests.get': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'branch', 'force'])
      await materializeRequestedWorkspace(ctx, p)
      const lookup = await ctx.mms.gitService.codeHost.lookupPullRequest(
        pullRequestFolder(ctx, p),
        asOptionalString(p.branch, 512),
        { force: asOptionalBoolean(p.force, 'force') === true }
      )
      return { lookup }
    }
    case 'pullRequests.detail': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'number', 'force'])
      const number = asBoundedInt(p.number, 'number', { min: 1, max: Number.MAX_SAFE_INTEGER })
      await materializeRequestedWorkspace(ctx, p)
      const detail = await readPullRequestDetail(ctx, pullRequestFolder(ctx, p), number, asOptionalBoolean(p.force, 'force') === true)
      return { detail }
    }
    case 'pullRequests.draft': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'originThreadId', 'expectedBranch', 'base'])
      const requestedBase = asOptionalString(p.base, 512)?.trim()
      if (requestedBase?.startsWith('-')) throw new DomainRpcError('invalid_params', 'base is not a branch name')
      const { root, branch, originThreadId, projectId } = await pullRequestBranchContext(ctx, p)
      const codeHost = ctx.mms.gitService.codeHost
      const baseBranches = await codeHost.listBaseBranches(root)
      if (baseBranches.defaultBranch === branch) throw defaultBranchError()
      const base = requestedBase || baseBranches.defaultBranch || baseBranches.branches[0] || ''
      const draft = await ctx.mms.orchestrator.draftPullRequest({
        root,
        branch,
        base,
        remote: await codeHost.remoteForRepository(root),
        originThreadId,
        projectId,
        threadName: originThreadId ? ctx.mms.threads.getThread(originThreadId)?.name ?? null : null
      })
      return { ...draft, base }
    }
    case 'pullRequests.create': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'originThreadId', 'expectedBranch', 'title', 'body', 'base', 'draft'])
      const title = asString(p.title, 'title', 256)
      // An empty description is a valid one.
      const body = asOptionalString(p.body, 64 * 1024) ?? ''
      const base = asString(p.base, 'base', 512).trim()
      if (base.startsWith('-')) throw new DomainRpcError('invalid_params', 'base is not a branch name')
      const draft = asOptionalBoolean(p.draft, 'draft') === true
      const { root, branch, originThreadId } = await pullRequestBranchContext(ctx, p)
      const codeHost = ctx.mms.gitService.codeHost
      // Forced: an open pull request made meanwhile, by anyone, must be shown rather than duplicated.
      const lookup = await codeHost.lookupPullRequest(root, branch, { force: true })
      if (lookup.state === 'unavailable') throw new DomainRpcError('pull_request_unavailable', lookup.message, { reason: lookup.reason })
      if (lookup.state === 'none' && lookup.isDefaultBranch === true) throw defaultBranchError()
      if (lookup.state === 'found' && lookup.pullRequest.state === 'open') {
        await linkOriginThread(ctx, originThreadId, root, lookup.pullRequest)
        return { pullRequest: lookup.pullRequest, existing: true }
      }
      // `--head` names the local branch, so the branch must be on the remote under that name: the pull request
      // holds what was pushed, and the draft was written from the local commits.
      const upstream = await ctx.mms.gitService.branchUpstream(root, branch)
      if (!upstream) throw new DomainRpcError('pull_request_unpushed', 'Push the branch first: it has no upstream on the remote yet.')
      if (upstream.branch !== branch) {
        throw new DomainRpcError('pull_request_upstream_renamed', `This branch is pushed as "${upstream.branch}" on the remote. Pull requests from a branch under another name are not supported here; open it on GitHub.`)
      }
      let pullRequest: GitPullRequestInfo
      try {
        // The branch is the one the caller opened the form on and the daemon has just checked out.
        pullRequest = await codeHost.createPullRequest(root, { title, body, base, draft, head: branch }, gitUserAction(ctx, 'Create pull request'))
      } catch (error) {
        // The host's message is what the user needs (gh says why); a plain error would reach the form as "something went wrong".
        const failure = new DomainRpcError('pull_request_create_failed', error instanceof Error ? error.message : String(error))
        if ((error as { code?: unknown } | null)?.code !== PULL_REQUEST_EXISTS) throw failure
        // Another client was first (the lookup above and the create are not one step): show its pull request.
        const again = await codeHost.lookupPullRequest(root, branch, { force: true })
        if (again.state !== 'found' || again.pullRequest.state !== 'open') throw failure
        await linkOriginThread(ctx, originThreadId, root, again.pullRequest)
        return { pullRequest: again.pullRequest, existing: true }
      }
      await linkOriginThread(ctx, originThreadId, root, pullRequest)
      return { pullRequest, existing: false }
    }
    case 'pullRequests.merge': {
      // Merges a pull request of the folder's repository. `method` is the one a person confirmed: it is used exactly,
      // and the host refuses it if the repository does not allow it. Without it (an older client), the method the
      // host's merge button offers, else squash.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'number', 'headSha', 'method'])
      const number = asBoundedInt(p.number, 'number', { min: 1, max: Number.MAX_SAFE_INTEGER })
      const headSha = asOptionalString(p.headSha, 64)
      if (headSha !== undefined && !/^[0-9a-f]{7,64}$/i.test(headSha)) throw new DomainRpcError('invalid_params', 'headSha is not a commit')
      if (p.method !== undefined && !isMergeMethod(p.method)) throw new DomainRpcError('invalid_params', 'method must be merge, squash or rebase')
      await materializeRequestedWorkspace(ctx, p)
      const root = pullRequestFolder(ctx, p)
      const codeHost = ctx.mms.gitService.codeHost
      const method = isMergeMethod(p.method) ? p.method : await codeHost.defaultMergeMethod(root) ?? 'squash'
      try {
        const pullRequest = await codeHost.mergePullRequest(root, number, { method, ...(headSha ? { headSha } : {}) }, gitUserAction(ctx, 'Merge pull request'))
        return { pullRequest, method }
      } catch (error) {
        throw new DomainRpcError('pull_request_merge_failed', error instanceof Error ? error.message : String(error), { number })
      }
    }
    case 'pullRequests.close': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'number'])
      const number = asBoundedInt(p.number, 'number', { min: 1, max: Number.MAX_SAFE_INTEGER })
      await materializeRequestedWorkspace(ctx, p)
      try {
        return { pullRequest: await ctx.mms.gitService.codeHost.closePullRequest(pullRequestFolder(ctx, p), number, gitUserAction(ctx, 'Close pull request')) }
      } catch (error) {
        throw new DomainRpcError('pull_request_close_failed', error instanceof Error ? error.message : String(error), { number })
      }
    }
    case 'pullRequests.baseBranches': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId'])
      await materializeRequestedWorkspace(ctx, p)
      return { baseBranches: await ctx.mms.gitService.codeHost.listBaseBranches(pullRequestFolder(ctx, p)) }
    }
    case 'pullRequests.mergeMethod': {
      // The method the host's merge button offers, for the Merge confirmation to name and then pass to `pullRequests.merge`.
      // Null when it cannot be read: nothing is guessed here.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId'])
      await materializeRequestedWorkspace(ctx, p)
      return { method: await ctx.mms.gitService.codeHost.defaultMergeMethod(pullRequestFolder(ctx, p)) }
    }
    case 'pullRequests.link': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'number'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const number = asBoundedInt(p.number, 'number', { min: 1, max: Number.MAX_SAFE_INTEGER })
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      await ensureWorkspaceMaterialized(ctx, threadId)
      const root = pullRequestFolder(ctx, { threadId })
      const before = ctx.mms.threads.getThread(threadId)?.pullRequest
      // Any pull request of the folder's repository, by number: the full read names the head and base repositories.
      const detail = await readPullRequestDetail(ctx, root, number, true)
      // An unlink or another link that landed while the host was being read wins; this one answers a state that is gone.
      const now = ctx.mms.threads.getThread(threadId)?.pullRequest
      if (now?.number !== before?.number || now?.linkedAt !== before?.linkedAt) {
        throw new DomainRpcError('pull_request_link_changed', "The thread's pull request link changed while it was being read; try again", { threadId, number })
      }
      // The same pull request keeps its watch; another one starts unwatched (a watch belongs to the pull request it began on).
      const thread = writeThreadLink(ctx, threadId, threadPullRequestLinkFromDetail(detail), true)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'pullRequests.list': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['projectId', 'limit', 'force'])
      const root = pullRequestFolder(ctx, { projectId: p.projectId })
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: 200 })
      const pullRequests = await asDomainError(() => ctx.mms.gitService.codeHost.listPullRequests(root, { ...(limit !== undefined ? { limit } : {}), force: asOptionalBoolean(p.force, 'force') === true }))
      return { pullRequests }
    }
    case 'pullRequests.resolve': {
      // What a pasted number, URL or `gh pr checkout` command names, read in full, before a thread is started from it.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['projectId', 'reference'])
      const projectId = asString(p.projectId, 'projectId', 256)
      const resolved = await asDomainError(() => pullRequestThreadService(ctx).resolve(projectId, asString(p.reference, 'reference', 2048)))
      const { detail } = resolved
      return {
        pullRequest: { number: detail.number, title: detail.title, url: detail.url, state: detail.state, isDraft: detail.isDraft, author: detail.author, headRefName: detail.headRefName, isCrossRepository: detail.isCrossRepository },
        threads: resolved.threads,
        enablesWorktreeConfig: resolved.enablesWorktreeConfig
      }
    }
    case 'pullRequests.startThread': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['projectId', 'number', 'reference', 'send', 'message', 'allowClosed', 'allowDuplicate', 'allowWorktreeConfig'])
      const projectId = asString(p.projectId, 'projectId', 256)
      if ((p.number === undefined) === (p.reference === undefined)) throw new DomainRpcError('invalid_params', 'Give either number or reference')
      const reference = p.reference !== undefined
        ? asString(p.reference, 'reference', 2048)
        : String(asBoundedInt(p.number, 'number', { min: 1, max: Number.MAX_SAFE_INTEGER }))
      const send = asOptionalBoolean(p.send, 'send') === true
      const message = asOptionalString(p.message, 64 * 1024)
      if (message !== undefined && !send) throw new DomainRpcError('invalid_params', 'message is only sent with send: true')
      try {
        const started = await asDomainError(() => pullRequestThreadService(ctx).startThread({
          projectId,
          reference,
          send,
          ...(message !== undefined ? { message } : {}),
          allowClosed: asOptionalBoolean(p.allowClosed, 'allowClosed') === true,
          allowDuplicate: asOptionalBoolean(p.allowDuplicate, 'allowDuplicate') === true,
          allowWorktreeConfig: asOptionalBoolean(p.allowWorktreeConfig, 'allowWorktreeConfig') === true
        }, gitUserAction(ctx, 'Start thread from pull request')))
        return { ...started, threads: listedThreadsFor(ctx, ctx.mms.threads.listAllThreads()) }
      } finally {
        // Also after a failure: a thread made and removed, or kept in the trash, must not linger in a client's list.
        ctx.emitEvent?.('threads.updated', { threads: ctx.mms.threads.listAllThreads() })
      }
    }
    case 'pullRequests.pushTarget': {
      // Where Push goes for a thread linked to a pull request, and why it keeps its usual target when it does.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const root = pullRequestFolder(ctx, { threadId })
      const inWorktree = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId)).load() !== undefined
      return { target: inWorktree ? await pullRequestPushTarget(ctx, threadId, root) : { remote: null, branch: null, reason: null } }
    }
    case 'pullRequests.unlink': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const thread = ctx.mms.threads.updateThreadMeta(threadId, { pullRequest: undefined })
      // A watch cannot outlive the link it watches through; it ends with its line.
      ctx.mms.pullRequestWatch.onEnded(threadId, 'unlinked')
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads: listedThreadsFor(ctx, threads) }
    }
    case 'pullRequests.watch': {
      // Turns a thread's watch of its pull request off, or on to notify (a line in the thread). A watch never wakes the agent.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'watch', 'number'])
      const threadId = asString(p.threadId, 'threadId', 256)
      const mode = asString(p.watch, 'watch', 16)
      if (mode !== 'off' && mode !== 'notify') throw new DomainRpcError('invalid_params', 'watch must be off or notify')
      const number = asOptionalBoundedInt(p.number, 'number', { min: 1, max: Number.MAX_SAFE_INTEGER })
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      ctx.mms.threads.assertThreadAdmission(threadId)
      if (mode !== 'off' && number !== undefined && ctx.mms.threads.getThread(threadId)?.pullRequest?.number !== number) {
        // No link to this pull request yet: link it first, from the host's full read, as `pullRequests.link` does.
        await ensureWorkspaceMaterialized(ctx, threadId)
        const detail = await readPullRequestDetail(ctx, pullRequestFolder(ctx, { threadId }), number, true)
        writeThreadLink(ctx, threadId, threadPullRequestLinkFromDetail(detail), false)
      }
      let status
      try {
        status = ctx.mms.pullRequestWatch.setMode(threadId, mode as PullRequestWatchMode)
      } catch (error) {
        if (error instanceof PullRequestWatchError) throw new DomainRpcError(error.code, error.message, { threadId })
        throw error
      }
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { status, thread: ctx.mms.threads.getThread(threadId), threads: listedThreadsFor(ctx, threads) }
    }
    case 'pullRequests.watchStatus': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId'])
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const status = ctx.mms.pullRequestWatch.status(threadId)
      // The account whose own comments are never reported; read without waiting for the host when it is not known yet.
      const link = ctx.mms.threads.getThread(threadId)?.pullRequest
      const folder = link ? pullRequestFolder(ctx, { threadId }) : null
      const viewer = folder && status.state !== 'off' ? await ctx.mms.gitService.codeHost.viewerLogin(folder) : null
      return { status: { ...status, viewer } }
    }
    case 'threads.inventory': {
      const p = isObject(params) ? params : {}
      const migrationDiagnostics = ctx.mms.threads.refreshLegacyTrash()
      const store = ctx.mms.threads.lifecycleStore
      if (p.threadId === undefined) {
        // Another device is never told a private thread is in the trash. A thread its expiry deleted, or is
        // deleting, is never in Recently deleted for anyone.
        const lifecycles = store.list().filter((record) =>
          !record.purge?.expired && !threadFolderExpired(record.location) &&
          (connectionIsLocal(ctx.connection) || !threadFolderIsLocalOnly(record.location, true)))
        const taskNames: Record<string, string> = {}
        for (const record of lifecycles) {
          try {
            const path = join(record.location, 'meta.json'); assertLifecyclePath(record.location, path)
            if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024) continue
            const meta = JSON.parse(readFileSync(path, 'utf8'))
            if (meta.id === record.taskId && typeof meta.name === 'string' && meta.name.trim()) taskNames[record.taskId] = meta.name
          } catch { /* Missing/invalid metadata remains identified by the stable task ID. */ }
        }
        return {
          lifecycles,
          taskNames,
          migrationDiagnostics,
          trashPolicy: ctx.mms.lifecycle.cleanup.policy(),
          trashSweepStatus: ctx.mms.lifecycle.cleanup.sweepStatus()
        }
      }
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!store.get(threadId)) {
        if (migrationDiagnostics.some((entry) => !entry.threadId || entry.threadId === threadId)) {
          return { lifecycle: null, inventory: null, migrationDiagnostics }
        }
        ctx.mms.threads.getThreadDir(threadId)
      }
      const lifecycle = store.require(threadId)
      return { lifecycle, inventory: await buildResourceInventory(store, lifecycle), migrationDiagnostics }
    }
    case 'storage.policy': {
      const cleanup = ctx.mms.lifecycle.cleanup
      return { trash: cleanup.policy(), trashSweepStatus: cleanup.sweepStatus(), policy: ctx.mms.storagePolicy.policy(), clockSuspended: ctx.mms.storageCleanup.clockSuspended(), reviewRecommended: ctx.mms.storagePolicy.reviewPending() }
    }
    // The notice about the recommended rules is dismissed; the rules stay as they are.
    case 'storage.reviewDismiss': {
      ctx.mms.storagePolicy.dismissReview(ctx.connection?.clientType === 'gui')
      return { reviewRecommended: false }
    }
    case 'storage.configure': {
      const p = isObject(params) ? params : {}
      const raw = isObject(p.policy) ? p.policy : {}
      const worktrees = isObject(raw.worktrees) ? raw.worktrees : {}
      const browser = isObject(raw.browser) ? raw.browser : {}
      const days = (value: unknown, name: string): number | null => value === null ? null : asBoundedInt(value, name, { min: 1, max: 3650 })
      const policy = ctx.mms.storagePolicy.configure({
        schemaVersion: 1,
        worktrees: {
          removeWithDeletedThreads: asBoolean(worktrees.removeWithDeletedThreads, 'removeWithDeletedThreads'),
          inactiveDays: days(worktrees.inactiveDays, 'inactiveDays'),
          removeMerged: asBoolean(worktrees.removeMerged, 'removeMerged')
        },
        browser: { captureDays: days(browser.captureDays, 'captureDays') }
      }, ctx.connection?.clientType === 'gui')
      return { policy }
    }
    // Settings → Storage → Worktree folder: where new worktrees go. Existing worktrees stay where they are.
    case 'storage.worktreeFolder':
      return { status: await worktreeFolderStatus(ctx.mms.settings, ctx.mms.getHomeDir()) }
    case 'storage.setWorktreeFolder': {
      if (ctx.connection?.clientType !== 'gui') throw new DomainRpcError('forbidden', 'Only the Storage settings can choose the worktree folder')
      const p = isObject(params) ? params : {}
      if (p.folder !== null && typeof p.folder !== 'string') throw new DomainRpcError('bad_request', 'folder must be a path or null')
      try {
        return { status: await chooseWorktreeFolder(ctx.mms.settings, ctx.mms.getProfileHomeDir(), ctx.mms.getHomeDir(), p.folder, () => recordedWorktreePaths(ctx.mms.threads.lifecycleStore, () => listKeptWorktrees(ctx.mms.getProfileHomeDir()))) }
      } catch (error) {
        if (error instanceof WorktreeFolderRefused) throw new DomainRpcError('invalid_worktree_folder', error.message)
        throw error
      }
    }
    // Any local client may run it: it only applies rules a person already configured.
    // With a `token` from the dry run it removes only what that plan named, and only if it is still eligible.
    case 'storage.cleanup.run': {
      const p = isObject(params) ? params : {}
      return { report: await ctx.mms.storageCleanup.run('manual', p.token === undefined ? undefined : { plan: asPlanToken(p.token) }) }
    }
    // Dry run: what a run would remove or keep now. Changes nothing, so it is open to any local client too.
    // The token is what a confirmed run is bounded by.
    case 'storage.cleanup.plan':
      return await ctx.mms.storageCleanup.planWithToken()
    case 'storage.cleanup.lastReport':
      return { report: ctx.mms.storageCleanup.lastReport() }
    // Totals by project, thread and kind, from the cache (a scan only on `refresh` or the first call). Ids and names, never a path.
    // A remote caller's params are validated to `{}`, so only a local client can force a rescan.
    case 'storage.usage': {
      const p = isObject(params) ? params : {}
      const usage = await ctx.mms.storageUsage.measure({ refresh: asOptionalBoolean(p.refresh, 'refresh') === true })
      if (connectionIsLocal(ctx.connection)) return usage
      // Another device sees a private thread's space only as unattributed, never its name.
      const hidden = localOnlyThreadIds(ctx.mms.threads.listAllThreads())
      if (!hidden.size) return usage
      return {
        ...usage,
        entries: usage.entries.map((entry) => {
          if (!entry.threadId || !hidden.has(entry.threadId)) return entry
          const { threadId: _hidden, ...unattributed } = entry
          return unattributed
        }),
        names: { ...usage.names, threads: Object.fromEntries(Object.entries(usage.names.threads).filter(([id]) => !hidden.has(id))) }
      }
    }
    case 'daemon.shutdown': {
      // Owner-token fencing: connection hello already verified; write uses server token only.
      const p = isObject(params) ? params : {}
      const reason = asOptionalString(p.reason, 256) ?? 'client-request'
      const token =
        ctx.ownerToken ||
        ctx.mms.getOwnerLease()?.owner.token ||
        ''
      const { requestDaemonShutdown } = await import('../../cli/daemonShutdown')
      const result = requestDaemonShutdown(ctx.mms.getHomeDir(), token, reason)
      ctx.emitEvent?.('server.shutdown', { reason: result.reason })
      return { accepted: result.accepted, reason: result.reason }
    }
    case 'events.subscribe': {
      const p = isObject(params) ? params : {}
      const afterSequence = asAfterSequence(p.afterSequence)
      return { afterSequence, subscribed: true }
    }
    case 'gui.devtoolsPoll': {
      // Dev-only: the Electron GUI takes pending self-inspection requests
      // (screenshot / console / reload / devtools / evaluate) for execution.
      return { requests: devGuiBridge.poll() }
    }
    case 'gui.devtoolsRespond': {
      const p = isObject(params) ? params : {}
      const requestId = asString(p.requestId, 'requestId', 128)
      const ok = asBoolean(p.ok, 'ok')
      const text = asOptionalString(p.text, 512 * 1024)
      // Screenshot PNG base64 stays under the 4 MiB protocol frame budget.
      const dataUrl = asOptionalString(p.dataUrl, 3 * 1024 * 1024 + 64)
      const savedPath = asOptionalString(p.savedPath, 4096)
      const width = asOptionalBoundedInt(p.width, 'width', { min: 1, max: 16384 })
      const height = asOptionalBoundedInt(p.height, 'height', { min: 1, max: 16384 })
      const error = asOptionalString(p.error, 8192)
      const found = devGuiBridge.respond(requestId, {
        ok,
        ...(text !== undefined ? { text } : {}),
        ...(dataUrl !== undefined ? { dataUrl } : {}),
        ...(savedPath !== undefined ? { savedPath } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
        ...(error !== undefined ? { error } : {})
      })
      return { ok: found }
    }
    default:
      throw new Error(`Unhandled method: ${method}`)
  }
}
