import { repositoryIdentitiesFor } from '../bridge/remote/repositoryIdentity'
import { userAction, withGitAccess, withUserRequest, type UserAction } from '../git/gitPolicy'
import { gitAccessOf, USER_REQUEST_LABELS } from './gitAccess'
import type { StorageCleanupPlanToken } from '../../shared/storage'
import { validateAppletAppearance } from '../../shared/appletAppearance'
import { appletJsonBytes, APPLET_STATE_LIMIT } from '../../shared/applets'
import { ConversationActionService } from '../actions/ConversationActionService'
import { assertHeldThreadLease, withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { tryAcquireExecutionLease, heartbeatExecutionLease, releaseExecutionLeaseHandle, getExecutionLeasePath, leaseBusyMessage, readLeaseOwner } from '../queue/ThreadExecutionLease'
import { clearCleanupMarker, readCleanupMarker } from '../lifecycle/StorageCleanupService'
import { enableVersionedLifecycleWriter } from '../queue/ThreadLifecycleAdmission'
import { assertEpisodePath } from '../agents/WorkspaceAccessPolicy'
import { isPermissionMode, PERMISSION_MODES, type PermissionMode } from '../../shared/permissionMode'
import type { Answerer } from '../run/approvalRights'
import { buildResourceInventory } from '../lifecycle/ResourceInventory'
import { assertLifecyclePath } from '../lifecycle/ResourceLifecycleStore'
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
import type { ChatMessage, FileGrepResponse, FileSearchResponse, GitOperationKind, GitOperationOptions, GitPullStrategy, GitStatusSnapshot, NativeLlmContext, OrchestratorSendInput, OrchestratorSendRequest, ScheduledSettings, Thread, ThreadSearchResult } from '../../shared/types'
import { AGENT_JOB_LIMIT_RANGES, AGENT_JOB_LIMIT_SETTINGS, type AgentJobLimitKey } from '../../shared/agentJobLimits'
import type { MousseConfigStore } from '../config/MousseConfigStore'
import type { ScheduledConfigSection } from '../config/types'
import { AppError, createErrorProvider, knownAppError } from '../../shared/errors'
import type { GitOperationHandle } from '../git/GitService'
import { listClaimedQueue, QueueConflictError, QueueValidationError } from '../queue/ThreadMessageQueue'
import { formatQuestionAnswersMessage, formatQuestionDismissMessage } from '../orchestrator/OrchestratorService'
import { withoutStandingRules } from '../orchestrator/UserQuestionService'
import type { ModelOverride } from '../../shared/providerInstances'
import {
  ACCENT_COLORS,
  THEME_OPTIONS,
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
import { listedProjectsFor, listedThreadsFor } from './threadVisibility'
import { isQualifiedId } from '../../shared/threadRef'
import { resolveThreadProjectPath } from '../data/resolveActiveProjectPath'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { resolveEditorFolder } from '../workspace/editorFolder'
import type { NodeId } from '../../shared/net/ids'
import { scheduledJobOptionsDepsFrom, validateScheduledJobOptions, type ScheduledJobOptionsDeps } from '../scheduled/validateJobOptions'
import { isExecutableJobEdit, JobPermissionRefused, permissionAboveCeiling, permissionsAfterEdit } from '../scheduled/jobPermission'
import { ScheduledWebhookError } from '../scheduled/ScheduledJobService'
import { runNowRefusal } from '../scheduled/runNowRefusal'
import { ActionExecutionError, StaleThreadActionRevisionError, ThreadActionService, type RunThreadActionOptions } from '../actions/ThreadActionService'
import { UndoService } from '../actions/UndoService'
import { UndoRetentionService } from '../actions/UndoRetentionService'
import { ReceiptRefReleaseService } from '../actions/ReceiptRefReleaseService'
import { RedoService } from '../actions/RedoService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { ConversationBranchService } from '../actions/ConversationBranchService'
import { discardPendingChanges, git as workspaceGit } from '../actions/git'
import { takeSnapshot } from '../actions/snapshots'
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
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { FILE_ASSET_PIECE_BYTES, SAVE_TOO_LARGE_MESSAGE, saveExceedsRequest } from '../../shared/fileAssets'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { FolderNotAnsweringError, waitForFolderAccess } from '../files/folderAccess'
import type { DomainConnectionContext } from './domainRegistry'
import { DomainRpcError } from './domainRegistry'
import { WORKFLOW_RUN_CAPABILITY } from '../../shared/workflowRunPlatform'
import { isInstallationMethod } from '../profiles/admission'
import { ChatReferenceMetadataResolver } from '../data/resolveChatReferenceMetadata'
import { parseChatReference } from '../../shared/chatReferences'
import type { ReviewFilesResult, ReviewRange, ReviewScope } from '../../shared/review'
import { repoRelativePaths } from '../git/repoPaths'
import { isGitRepository, listChangedFiles, readFileVersions, worktreeRange } from '../git/reviewDiff'
import { resolveReviewScope } from '../actions/reviewRange'

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
 * SPEC §16.3 restore gate for a file-restoring action: refuses (`workspace_shared`) unless the
 * thread owns its worktree and no other thread's worktree or live working directory overlaps it
 * (the other threads' workspaces are listed once per evaluation, and only when ownership holds);
 * for a weak-containment provider, or one whose capabilities are unknown, returns the diff to
 * review with its SHA-256 and appends `restore.review_required` — unless `reviewedDiffSha` names
 * exactly the diff a restore would apply now. Null: go ahead.
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
  const diff = input.target ? restoreDiff(input.workspace.worktreePath, input.target.endSha, input.target.startSha) : ''
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
  source: 'undo' | 'revert',
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
  const prepared = await bridge.prepare(threadId, { ...input, requestId: asOptionalString(raw.requestId, 64) }, isPerson(ctx.connection) ? 'gui' : 'cli')
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
      compaction: boundary?.compaction ? structuredClone(boundary.compaction) : nativeContext.compaction,
      acceptedQueueItemIds: boundary?.acceptedQueueItemIds
        ? structuredClone(boundary.acceptedQueueItemIds)
        : nativeContext.acceptedQueueItemIds,
      acceptedSteerItemIds: boundary?.acceptedSteerItemIds
        ? structuredClone(boundary.acceptedSteerItemIds)
        : nativeContext.acceptedSteerItemIds,
      lastTurnUsage: undefined
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
    return workspace ? manager.executionContext(projectPath, workspace).projectPath : projectPath
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
function localFilesRoot(ctx: HandlerContext, params: Record<string, unknown>): string {
  const threadId = asOptionalString(params.threadId, 256)
  const projectId = asOptionalString(params.projectId, 256)
  // A thread or project that is named but unknown is refused, never answered with the home folder.
  if (threadId && !ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
  if (projectId && !ctx.mms.projects.getProject(projectId)) throw new DomainRpcError('project_not_found', 'Project not found', { projectId })
  const threadProject = threadId ? resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId) : undefined
  if (threadId && threadProject) {
    const manager = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId))
    const stored = manager.load()
    const execution = manager.executionContext(threadProject, stored ? manager.verify(stored) : undefined)
    if (execution.lifecycle === 'ready' && execution.projectPath) return execution.projectPath
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
  return isLocalWindow(ctx) ? localFilesRoot(ctx, params) : projectRootContext(ctx, params)
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
  if (!workspace || existsSync(join(workspace.worktreePath, '.git')) || !manager.hasReconstructionManifest()) return
  // One restore per thread: calls that arrive together (a focus refresh asks for status, files and the pull request at once) share it.
  const key = ctx.mms.threads.getThreadDir(threadId)
  const running = restoresInFlight.get(key)
  if (running) return running
  const projectPath = project ?? resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
  if (!projectPath) return
  const restore = (async () => {
    await manager.restore(projectPath)
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
    trashThread: (threadId) => ctx.mms.trashThread(threadId),
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

async function ensureOwnedTaskWorkspace(ctx: HandlerContext, params: Record<string, unknown>): Promise<void> {
  if (!params.threadId) return
  const threadId = asString(params.threadId, 'threadId', 256)
  if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found')
  const project = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
  if (!project) throw new DomainRpcError('thread_has_no_folder', 'Task has no project workspace')
  const manager = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId))
  if (!manager.load()) await manager.provision(threadId, 'main', project)
  await ensureWorkspaceMaterialized(ctx, threadId, project)
  if (manager.verify().lifecycle !== 'ready') throw new DomainRpcError('workspace_recovery_required', 'Task workspace requires recovery before mutation')
}

/** Refusals that follow from a thread's worktree being the thread's own. Each has a fixed code the GUI can show copy for. */
const gitThreadRules = createErrorProvider({
  task_branch_authoritative: { category: 'denied', retryable: false, message: 'Task branches are authoritative. Use the conversation branch controls to switch task revisions.' },
  thread_worktree_checkpointed: { category: 'denied', retryable: false, message: "Staging is not available in a thread's worktree; a commit there includes every change." },
  git_amend_in_thread: { category: 'denied', retryable: false, message: "Amend is not available in a thread's worktree." }
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
  if (refuseInThread && p.threadId !== undefined && p.threadId !== null) throw gitThreadRules.create(refuseInThread)
  await ensureOwnedTaskWorkspace(ctx, p)
  const root = projectRootContext(ctx, p)
  const threadId = asOptionalString(p.threadId, 256)
  const directory = threadId ? ctx.mms.threads.getThreadDir(threadId) : undefined
  const workspace = directory ? new ThreadWorkspaceManager(directory).load() : undefined
  return { root, directory, workspace }
}

/** Paths as `getStatus` names them (repository-relative), accepted only inside the project folder. */
function gitPaths(ctx: HandlerContext, root: string, value: unknown): string[] {
  const paths = asStringArray(value, 'paths', { unique: true, maxItems: GIT_PATHS_MAX, maxItemLen: 4096 })
  if (paths.length === 0) throw new DomainRpcError('invalid_params', 'paths must name at least one file')
  const top = workspaceGit(root, ['rev-parse', '--show-toplevel'])
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
      const realRoot = realpathSync.native(resolve(root))
      const realTop = realpathSync.native(top)
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
  const resolved = resolveReviewScope(lookup.threadDirectory, scope)
  if (!resolved) {
    return { scope, root: lookup.projectPath ?? '', range: { from: null, to: { kind: 'worktree' } }, unavailable: 'This thread has no worktree of its own, so its changes cannot be reviewed.' }
  }
  return { scope, root: resolved.cwd, range: resolved.range, unavailable: resolved.unavailable }
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
  return access ? withGitAccess(method, access, run) : run()
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

/** `validateScheduledJobOptions` with its plain-text refusals made visible to the caller. */
function checkJobOptions(ctx: HandlerContext, job: Parameters<typeof validateScheduledJobOptions>[0]): ReturnType<typeof validateScheduledJobOptions> {
  try {
    return validateScheduledJobOptions(job, scheduledJobOptionsDeps(ctx))
  } catch (error) {
    if (error instanceof AppError) throw error
    throw jobRefused(error instanceof Error ? error.message : String(error))
  }
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
  'projects.open', 'projects.identity', 'projects.trustGitSettings', 'orchestrator.send', 'orchestrator.retry',
  'thread.fork', 'thread.mergeBack', 'threads.setWorktreeEnabled', 'threads.purge', 'agents.spawn', 'tasks.create',
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
      !['threads.delete', 'threads.trash', 'threads.restore', 'threads.purge', 'threads.inventory', 'threads.focus',
        // These name the thread only so a router can find its computer; they worked for a thread being trashed before.
        'orchestrator.answerQuestions', 'orchestrator.dismissQuestions', 'runs.get', 'runs.resumeNow', 'runs.cancelPause',
        'git.cancelOperation', 'pty.isAlive', 'pty.lookup', 'pty.write', 'pty.resize', 'pty.kill'].includes(method) &&
      ctx.mms.threads?.lifecycleStore?.get(params.threadId)) {
    ctx.mms.threads.assertThreadAdmission(params.threadId)
  }
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
      const worktreeEnabled = asOptionalBoolean(p.worktreeEnabled, 'worktreeEnabled') === true
      const projectPath = projectId
        ? ctx.mms.projects.getProject(projectId)?.path
        : undefined
      let thread = ctx.mms.threads.createThread(name, projectId, projectPath, { worktreeEnabled })
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
      const operationId = ctx.mms.resolveLifecycleOperationId(threadId, 'trash', asOptionalString(p.operationId, 256))
      const lifecycle = await ctx.mms.trashThread(threadId, operationId, lifecycleExpectedGeneration(p))
      const operationResult = ctx.mms.lifecycle.getOperationResult(threadId, operationId)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { threads: listedThreadsFor(ctx, threads), lifecycle, operationResult }
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
      const results = ctx.mms.threads.searchThreads(query, limit, {
        hideSubagents: true,
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
        turnSnapshot: ctx.mms.orchestrator.getTurnSnapshot(),
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
        'clientRequestId', 'await', 'continuationOfRunId', 'acknowledgeUncertain'
      ])
      const threadId = asString(p.threadId, 'threadId', 256)
      const content = asString(p.content, 'content')
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
      const input = await prepareChatInput(ctx, threadId, { content, mode, images }, p)
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
      if (!run) throw new DomainRpcError('run_not_found', 'Run not found', { runId })
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
      const ok = queueRpc(() => ctx.mms.orchestrator.promoteQueueItemToSteer(threadId, itemId, { expectedRevision, expectedRunId, ...(limit ? { permissionCeiling: limit } : {}) }))
      return { ok, items: ctx.mms.orchestrator.listQueue(threadId) }
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
        // Answers reach the model through the tool result; mirror them as a
        // visible user message so the transcript shows what the user said.
        ctx.mms.orchestrator.recordQuestionResponseMessage(
          pending.threadId,
          formatQuestionAnswersMessage(pending.questions, answers)
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
      if (metadata) {
        if (manager!.verify(metadata).lifecycle !== 'ready') throw new DomainRpcError('workspace_recovery_required', 'Task workspace requires recovery before opening a terminal')
        const projectPath = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
        if (routed || p.cwd === undefined || projectPath && cwd === projectPath) cwd = manager!.executionContext(projectPath ?? metadata.worktreePath, metadata).projectPath
        else cwd = assertEpisodePath(metadata.worktreePath, cwd)
      }
      const lease = directory ? tryAcquireExecutionLease(directory, { source: 'task-terminal' }) : undefined
      if (directory && !lease) throw new DomainRpcError('workspace_busy', leaseBusyMessage(readLeaseOwner(getExecutionLeasePath(directory)), 'Task writer is busy; wait for it to finish before opening a terminal'))
      const actions = directory && metadata ? new ThreadActionService(directory) : undefined
      const turnId = `terminal:${randomUUID()}`
      const actionOptions = metadata ? { threadId, turnId, conversationBranchId: metadata.conversationBranchId, workspacePath: metadata.worktreePath,
        actor: { kind: 'user' as const }, heldThreadLease: lease!, presentationMessageStart: 0, presentationMessageEnd: 0,
        nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' as const },
        externalEffects: [{ kind: 'unknown' as const, reversible: false as const, description: 'Interactive terminal commands may affect external services or ignored files.' }] } : undefined
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
        // Edits made outside the terminal are recorded as their own action first; the terminal's action covers only what it changes.
        const startSha = actions && actionOptions ? (await actions.recordOutsideChanges(actionOptions)).startSha : undefined
        if (actions && actionOptions) actions.beginTurn(actionOptions, startSha!)
        ptyId = ctx.mms.ptyManager.create(agentId, cwd, command, { threadId, env, shellArgs,
          ownership: lease ? { assert: () => assertHeldThreadLease(directory!, lease), heartbeat: () => { heartbeatExecutionLease(lease) },
            settled: async () => {
              try { if (actions && actionOptions) await actions.checkpointExistingTurn(actionOptions, startSha!, 'completed') }
              finally { releaseExecutionLeaseHandle(lease) }
            } } : undefined
        })
      } catch (error) { if (lease) releaseExecutionLeaseHandle(lease); throw error }
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
      const activity = ctx.mms.threadRuntimes.getActivitySnapshot()
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
      const input = asCreateScheduledJobInput(p.input)
      // The selection is stored as the profile resolves it; a `worktree` workspace names the thread that owns it.
      const checked = checkJobOptions(ctx, input)
      // The job's ceiling is the mode its creator holds now (the target thread's, else the profile's). It comes
      // from the daemon, never from the request, and the job's own mode may not exceed it.
      const permissionCeiling = ctx.mms.orchestrator.scheduledCreatorCeiling(checked.threadId ?? input.threadId)
      const tooWide = permissionAboveCeiling(input.permissionMode, permissionCeiling)
      if (tooWide) throw jobRefused(tooWide)
      const job = withPermissionRefusals(() => ctx.mms.scheduled.createJob({
        ...input,
        permissionCeiling,
        ...(checked.selection ? { selection: checked.selection } : {}),
        ...(checked.threadId ? { threadId: checked.threadId } : {})
      }))
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.update': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      const patch = asScheduledJobPatch(p.patch)
      const existing = ctx.mms.scheduled.getJob(id)
      if (!existing) throw new Error(`Job not found: ${id}`)
      if (patch.schedule?.kind === 'once' && existing.trigger?.webhook) {
        throw jobRefused('A job with a webhook cannot become a one-time job; disable its webhook first, or use a manual schedule.')
      }
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
      const job = withPermissionRefusals(() => ctx.mms.scheduled.updateJob(id, {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt } : {}),
        ...(patch.schedule !== undefined ? { schedule: patch.schedule } : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
        ...(patch.createThread !== undefined ? { createThread: patch.createThread } : {}),
        ...(patch.threadId !== undefined || checked.threadId ? { threadId: checked.threadId ?? (patch.threadId === null ? undefined : patch.threadId) } : {}),
        ...(patch.projectId !== undefined ? { projectId: patch.projectId === null ? undefined : patch.projectId } : {}),
        ...(patch.selection !== undefined ? { selection: patch.selection === null ? undefined : checked.selection ?? patch.selection } : {}),
        ...(patch.mode !== undefined ? { mode: patch.mode === null ? undefined : patch.mode } : {}),
        ...(patch.workspace !== undefined ? { workspace: patch.workspace === null ? undefined : patch.workspace } : {}),
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
      }, {
        permissions: (current) => permissionsAfterEdit({
          stored: current,
          editor: ctx.mms.orchestrator.scheduledCreatorCeiling(checked.threadId ?? (patch.threadId === undefined ? current.threadId : patch.threadId ?? undefined)),
          patchMode: patch.permissionMode,
          executable,
          canRaise: true
        })
      }))
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.delete': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      const ok = ctx.mms.scheduled.deleteJob(id)
      return { ok, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.pause': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      const reason = asOptionalString(p.reason, 512)
      const job = ctx.mms.scheduled.pauseJob(id, reason)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.resume': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      const job = ctx.mms.scheduled.resumeJob(id)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.run': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      // A job with a run in flight or waiting in a queue has one occurrence outstanding; say so instead of reporting a start.
      const current = ctx.mms.scheduled.getJob(id)
      const refusal = current ? runNowRefusal(current) : undefined
      if (refusal) throw jobRefused(refusal)
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
      // Off means the jobs agents made stop now, visibly paused; turning it on again does not restart them.
      // A lower limit never pauses or removes a job: it only refuses the next create or change.
      if (update.agentJobs === false) ctx.mms.scheduled.pauseAgentJobs()
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
      return {
        options: {
          themes: THEME_OPTIONS,
          accentColors: ACCENT_COLORS,
          llmProviders,
          agentTypes
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
        ctx.mms.harness?.instances.usage({ kind: 'device' }) ?? Promise.resolve([])
      ])
      return {
        ...usage,
        providers: [...usage.providers, ...(claude ? [claude] : []), ...agents],
        fetchedAt: new Date().toISOString()
      }
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
      const metadata = stored && lookup.projectPath ? manager.verify(stored) : stored
      // Never restores: the hover card and the active-project lookup call this for passive reads.
      const marker = stored && !existsSync(stored.worktreePath) ? readCleanupMarker(ctx.mms.threads.lifecycleStore, lookup.threadId) : undefined
      return {
        metadata,
        execution: lookup.projectPath
          ? manager.executionContext(lookup.projectPath, metadata)
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
      return resolveEditorFolder({ threadId: lookup.threadId, threadDirectory: lookup.threadDirectory, projectPath: lookup.projectPath })
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
      const metadata = current
        ? await manager.restore(operation.projectPath)
        : await manager.provision(operation.threadId, branchId, operation.projectPath)
      ctx.emitEvent?.('workspace.updated', { threadId: operation.threadId, metadata }, operation.threadId)
      return { metadata }
    }
    case 'workspace.discardPendingChanges': {
      // The Discard button of a `workspace_conflict` error in a thread worktree. Only ever run on a person's click
      // after a confirmation; it keeps a copy of what it drops under refs/mousse/discarded/.
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'confirmed'])
      if (p.confirmed !== true) throw new DomainRpcError('confirmation_required', 'Discarding changes needs the user’s confirmation.')
      const operation = threadOperationContext(ctx, p)
      if (ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)) throw new DomainRpcError('thread_busy', 'Wait for active or queued work to finish.')
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      // Everything uncommitted goes, the results of the thread's turns included. The files as they are now are recorded
      // as a snapshot first (the turns' receipts keep theirs), and a copy stays under refs/mousse/discarded/.
      return await withGitMutationLocks(operation.threadDirectory, workspace.worktreePath, 'discard-pending-changes', () => {
        let before: string
        // The files are recorded first. When the record cannot be written (a pending operation), a plain snapshot stands in;
        // when even that fails, nothing is discarded. The copy is made inside `discardPendingChanges`, before any reset.
        try { before = new ThreadActionService(operation.threadDirectory).recordOutsideChangesHeld({ threadId: workspace.threadId, conversationBranchId: workspace.conversationBranchId, workspacePath: workspace.worktreePath }).startSha }
        catch {
          try { before = takeSnapshot(workspace.worktreePath, { reason: 'before discard', threadId: workspace.threadId }).sha }
          catch (error) { throw new DomainRpcError('discard_unsafe', `Nothing was discarded: the files could not be recorded first (${(error as Error).message.split(/\r?\n/)[0]}).`) }
          workspaceGit(workspace.worktreePath, ['update-ref', '--no-deref', `refs/mousse/discarded/snapshot-${before}`, before])
        }
        const { backupRef } = discardPendingChanges(workspace.worktreePath)
        return { backupRef, snapshotSha: before, notice: `The files as they were are kept in Git as ${backupRef}. To bring them back, run \`git restore --source=${backupRef} --worktree -- .\` in ${workspace.worktreePath}.` }
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
      const prompt = messages.filter((message) => message.role === 'user' && !message.hidden).at(-1)
      const busy = ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)
      const retained = latest?.retention?.state === 'available' || latest?.retention?.state === 'pinned'
      let contextMatches = true
      if (latest?.scope === 'conversation') {
        try { ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, latest, latest.state === 'undone' ? 'redo' : 'undo') } catch { contextMatches = false }
      }
      const workspaceReady = latest?.scope === 'conversation' || new ThreadWorkspaceManager(operation.threadDirectory).load()?.lifecycle === 'ready'
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
      return { actions, retentionPolicy: retention.policy(), receipts, activeBranchId, journalGeneration: operation.currentGeneration, undoTarget, redoTarget,
        undoUnavailableReason: undoTarget ? undefined : busy ? 'Wait for active or queued work to finish.' : latest?.retention?.state === 'expired' || latest?.retention?.state === 'blocked' ? latest.retention.reason : 'This prompt has no eligible recorded Undo boundary. Tool effects or older unrecorded turns cannot be undone safely.' }
    }
    case 'actions.sweepRetention':
    case 'actions.configureRetention':
    case 'actions.pin': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      const retention = new UndoRetentionService(operation.threadDirectory)
      if (method === 'actions.sweepRetention') {
        const logical = await retention.sweep(workspace.worktreePath)
        const physical = logical.suspended ? undefined : await new ReceiptRefReleaseService(ctx.mms.threads.lifecycleStore, operation.threadId).release(workspace.worktreePath)
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
      return { ...result, ...await listChangedFiles(target.root, target.range) }
    }
    case 'review.file': {
      const p = isObject(params) ? params : {}
      const target = await reviewTarget(ctx, p)
      if (target.unavailable) throw new DomainRpcError('review_unavailable', target.unavailable)
      // The review shows a link at the path as the link text and never reads what it points to.
      const path = requiredContainedPath(ctx, target.root, p.path, 'inspect')
      const oldPath = p.oldPath === undefined ? undefined : requiredContainedPath(ctx, target.root, p.oldPath, 'inspect')
      return await readFileVersions(target.root, target.range, path, oldPath)
    }
    case 'actions.undoLatest': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      // A workspace Undo needs the checkout; a conversation-only Undo does not.
      if (operation.projectPath && new ThreadActionService(operation.threadDirectory).latest(new ThreadWorkspaceManager(operation.threadDirectory).load()?.conversationBranchId ?? 'main')?.scope !== 'conversation') await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
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
        const prompt = messages.filter((message) => message.role === 'user' && !message.hidden).at(-1)
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
        // SPEC §16.3: files are restored only in an owned, unshared worktree; weak containment reviews first.
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
      const operation = threadOperationContext(ctx, p)
      const actionId = asString(p.actionId, 'actionId', 256)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
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
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
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
      saveConversationState(ctx, operation.threadId, operation.threadDirectory, sourceBranchId)
      if (p.codeMode !== undefined && p.codeMode !== 'current' && p.codeMode !== 'historical') throw new DomainRpcError('invalid_params', 'Invalid fork code mode')
      const branch = await new ConversationBranchService(operation.threadDirectory).fork(workspace.worktreePath, sourceBranchId, actionId, name, operation.currentGeneration, p.codeMode === 'current' ? 'current' : 'historical')
      saveConversationState(ctx, operation.threadId, operation.threadDirectory, branch.id, {
        presentationEnd: action.presentationMessageEnd,
        nativeEnd: action.nativeContextBoundary.messageIndex,
        boundary: action.nativeContextBoundary
      })
      return { branch }
    }
    case 'actions.activateBranch': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const branchId = asString(p.conversationBranchId, 'conversationBranchId', 256)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      const branches = new ConversationBranchService(operation.threadDirectory)
      const current = branches.list().find((branch) => branch.lifecycle === 'active')
      const target = loadConversationState(operation.threadDirectory, branchId)
      const branch = await branches.activate(workspace.worktreePath, branchId, operation.currentGeneration, () => {
        if (current) saveConversationState(ctx, operation.threadId, operation.threadDirectory, current.id)
        ctx.mms.orchestrator.replaceConversationState(operation.threadId, target.messages, target.nativeContext)
      })
      return { branch }
    }
    case 'operations.get': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const operationId = asString(p.operationId, 'operationId', 256)
      return { operation: new ThreadJournal(operation.threadDirectory).latestByOperation().get(operationId) }
    }
    case 'operations.recover': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new DomainRpcError('workspace_not_ready', 'Thread workspace is not ready')
      // A merge of a subagent result an older version left unfinished is cancelled, never run again.
      const cancelledIntegrations = cancelPendingIntegrations(operation.threadDirectory, workspace.worktreePath)
      await new PublishService(operation.threadDirectory).recoverPending(workspace.worktreePath, operation.projectPath)
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
      return { ok: true, ...(cancelledIntegrations.length ? { cancelledIntegrations } : {}) }
    }
    case 'operations.abort': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const operationId = asString(p.operationId, 'operationId', 256)
      const record = new ThreadJournal(operation.threadDirectory).latestByOperation().get(operationId)
      if (!record) throw new DomainRpcError('operation_not_found', `Operation not found: ${operationId}`)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (record.operationType !== 'publish' && !workspace) throw new DomainRpcError('workspace_not_ready', 'Thread workspace is missing')
      await new ManagedConflictService(operation.threadDirectory).abort(record.operationType === 'publish' ? operation.projectPath : workspace!.worktreePath, operationId)
      return { ok: true }
    }
    case 'publish.status': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      return { available: Boolean(workspace?.lifecycle === 'ready'), workspace, sourceSha: workspace?.lifecycle === 'ready' ? workspace.snapshotSha ?? workspaceGit(workspace.worktreePath, ['rev-parse', 'HEAD']) : undefined, targetSha: workspaceGit(operation.projectPath, ['rev-parse', 'HEAD']), journalGeneration: operation.currentGeneration }
    }
    case 'publish.start': {
      const p = isObject(params) ? params : {}
      // Exact completed-operation replay is checked by PublishService before concurrency validation.
      const operation = threadOperationContext(ctx, { ...p, expectedJournalGeneration: undefined })
      const targetBranch = asString(p.targetBranch, 'targetBranch', 512)
      await ensureWorkspaceMaterialized(ctx, operation.threadId, operation.projectPath)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
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
      return { root: localFilesRoot(ctx, p) }
    }
    case 'files.list': {
      const p = isObject(params) ? params : {}
      return await fileCall(ctx, async () => {
        const root = await filesRootContext(ctx, p)
        return { entries: await ctx.mms.fileService.listDir(root, containedPath(ctx, root, p.path), guardFor(ctx)) }
      })
    }
    case 'files.read': {
      const p = isObject(params) ? params : {}
      return await fileCall(ctx, async () => {
        const root = await filesRootContext(ctx, p)
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
        const root = await filesRootContext(ctx, p)
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
        // The file was read from the thread's worktree, so a retired one comes back before it is written.
        await materializeRequestedWorkspace(ctx, p)
        const root = localFilesRoot(ctx, p)
        const path = requiredContainedPath(ctx, root, p.path)
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
      return { status: await ctx.mms.gitService.getStatus(projectRootContext(ctx, p)) }
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
      const result = await ctx.mms.gitService.checkout(target.root, gitUserAction(ctx, 'Switch branch'), asString(p.branch, 'branch', 512), { ...(dirty ? { dirty } : {}), ...gitOperationOptions(ctx, p) })
      return gitStatusResult(ctx, target.root, { ...result })
    }
    case 'git.commit': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const message = asString(p.message, 'message', 4096)
      const amend = asOptionalBoolean(p.amend, 'amend') === true
      const expectedBranch = asOptionalString(p.expectedBranch, 512)
      const thread = threadWorktree(target)
      if (thread) {
        // A thread's commits are recorded one by one with the actions that made them, so an amend is refused before Git runs.
        if (amend) throw gitThreadRules.create('git_amend_in_thread')
        // Everything is committed through the user's hooks as one commit; a rejected commit is recorded as a failed action.
        await followedGitAction(ctx, p, target.root, 'commit', (request, signal) =>
          runUserThreadGitAction(ctx, thread, { signal }, () => ctx.mms.gitService.commit(target.root, gitUserAction(ctx, 'Commit'), message, { all: true, expectedBranch, ...request })))
      } else await followedGitAction(ctx, p, target.root, 'commit', (request) => ctx.mms.gitService.commit(target.root, gitUserAction(ctx, amend ? 'Amend the last commit' : 'Commit'), message, { amend, expectedBranch, ...request }))
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
          if (manager.verify().lifecycle !== 'ready' || manager.load()?.headSha !== metadata.headSha) throw new DomainRpcError('task_revision_changed', 'Task revision changed before push; refresh the reviewed revision')
          // A push sends commits. Files that are not committed are not in them, and they are not a reason to hold the commits back.
          const uncommitted = workspaceGit(root, ['status', '--porcelain', '--untracked-files=all']).split(/\r?\n/).filter(Boolean).length
          await ctx.mms.gitService.push(root, gitUserAction(ctx, 'Push'), { expectedBranch, ...toPullRequest, ...request })
          if (uncommitted) notice = uncommittedNotPushedNotice(uncommitted)
        }, signal)
      })
      return gitStatusResult(ctx, root, notice ? { notice } : {})
    }
    case 'git.suggestCommitMessage': {
      const p = isObject(params) ? params : {}
      rejectUnknownKeys(p, ['threadId', 'projectId', 'expectedBranch'])
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
      return await ctx.mms.orchestrator.generateCommitMessage({ root, all: inWorktree, projectId, threadId: inWorktree ? threadId : null, branch: expectedBranch ?? null })
    }
    case 'git.stage':
    case 'git.unstage': {
      const p = isObject(params) ? params : {}
      // A commit in a thread's worktree takes every change, so staging has no effect there.
      const target = await gitMutationTarget(ctx, p, 'thread_worktree_checkpointed')
      const all = asOptionalBoolean(p.all, 'all') === true
      const staging = method === 'git.stage'
      const action = gitUserAction(ctx, staging ? 'Stage' : 'Unstage')
      if (all) await (staging ? ctx.mms.gitService.stageAll(target.root, action) : ctx.mms.gitService.unstageAll(target.root, action))
      else await (staging ? ctx.mms.gitService.stage(target.root, action, gitPaths(ctx, target.root, p.paths)) : ctx.mms.gitService.unstage(target.root, action, gitPaths(ctx, target.root, p.paths)))
      return gitStatusResult(ctx, target.root)
    }
    case 'git.discard': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const paths = gitPaths(ctx, target.root, p.paths)
      const thread = threadWorktree(target)
      if (thread) {
        // The discard is recorded as an action of the person, so the files before it are in a snapshot.
        const effects: ExternalEffect[] = [{ kind: 'unknown', description: `Discarded ${paths.length} ${paths.length === 1 ? 'file' : 'files'}`, reversible: false }]
        await runUserThreadGitAction(ctx, thread, { externalEffects: effects }, () => ctx.mms.gitService.discard(target.root, gitUserAction(ctx, 'Discard changes'), paths))
      } else await ctx.mms.gitService.discard(target.root, gitUserAction(ctx, 'Discard changes'), paths)
      return gitStatusResult(ctx, target.root)
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
      const result = await followedGitAction(ctx, p, target.root, 'pull', (request) => ctx.mms.gitService.pull(target.root, gitUserAction(ctx, 'Pull'), { strategy: strategy as GitPullStrategy, ...request }))
      return gitStatusResult(ctx, target.root, { ...result })
    }
    case 'git.abortInProgress': {
      const p = isObject(params) ? params : {}
      const target = await gitMutationTarget(ctx, p)
      const kind = asString(p.kind, 'kind', 16)
      if (kind !== 'merge' && kind !== 'rebase') throw new DomainRpcError('invalid_params', 'kind must be merge or rebase')
      // A thread worktree allows it: it gives up a merge or rebase a terminal started, back to the recorded head.
      await underThreadLocks(target, 'user-git-abort', () => ctx.mms.gitService.abortInProgress(target.root, gitUserAction(ctx, `Abort the ${kind}`), kind))
      return gitStatusResult(ctx, target.root)
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
        const lifecycles = store.list(), taskNames: Record<string, string> = {}
        for (const record of lifecycles) {
          try {
            const path = join(record.location, 'meta.json'); assertLifecyclePath(record.location, path)
            if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).size > 1024 * 1024) continue
            const meta = JSON.parse(readFileSync(path, 'utf8'))
            if (meta.id === record.taskId && typeof meta.name === 'string' && meta.name.trim()) taskNames[record.taskId] = meta.name
          } catch { /* Missing/invalid metadata remains identified by the stable task ID. */ }
        }
        // Recently deleted also lists what is in the trash of the user's other computers (each with a short
        // deadline). Another caller of this method, such as Storage settings, asks about this computer alone.
        const remote =
          p.includeComputers === true && ctx.connection?.clientType === 'gui' && ctx.mms.remoteLists
            ? await ctx.mms.remoteLists.inventory(ctx.connection.id)
            : undefined
        return {
          lifecycles: remote ? [...lifecycles, ...remote.lifecycles] : lifecycles,
          taskNames: remote ? { ...taskNames, ...remote.taskNames } : taskNames,
          migrationDiagnostics,
          trashPolicy: ctx.mms.lifecycle.cleanup.policy(),
          trashSweepStatus: ctx.mms.lifecycle.cleanup.sweepStatus(),
          ...(remote?.skipped.length ? { skipped: remote.skipped } : {})
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
      return { lifecycle, inventory: buildResourceInventory(store, lifecycle), migrationDiagnostics }
    }
    case 'threads.trash': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const operationId = ctx.mms.resolveLifecycleOperationId(threadId, 'trash', asOptionalString(p.operationId, 256))
      const lifecycle = await ctx.mms.trashThread(threadId, operationId, lifecycleExpectedGeneration(p))
      const operationResult = ctx.mms.lifecycle.getOperationResult(threadId, operationId)
      return { ok: true, lifecycle, operationResult }
    }
    case 'threads.restore': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const operationId = ctx.mms.resolveLifecycleOperationId(threadId, 'restore', asOptionalString(p.operationId, 256))
      const lifecycle = await ctx.mms.restoreThread(threadId, operationId, lifecycleExpectedGeneration(p))
      const operationResult = ctx.mms.lifecycle.getOperationResult(threadId, operationId)
      return { thread: ctx.mms.threads.getThread(threadId), lifecycle, operationResult }
    }
    case 'threads.purge': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (p.preview === true) {
        const preview = await ctx.mms.lifecycle.cleanup.preview(threadId)
        // A display estimate beside the preview; it never enters the preview or its digest.
        return { preview, reclaim: await ctx.mms.lifecycle.cleanup.reclaimEstimate(preview) }
      }
      const lifecycle = await ctx.mms.lifecycle.purge({ taskId: threadId, operationId: asString(p.operationId, 'operationId', 256), expectedGeneration: lifecycleExpectedGeneration(p), previewDigest: asOptionalString(p.previewDigest, 128), discard: asOptionalBoolean(p.discard, 'discard'), human: ctx.connection?.clientType === 'gui' })
      return { ok: true, lifecycle }
    }
    case 'threads.configureTrash': {
      const p = isObject(params) ? params : {}
      return { policy: ctx.mms.lifecycle.cleanup.configure({ schemaVersion: 1, graceDays: asBoundedInt(p.graceDays, 'graceDays', { min: 1, max: 3650 }), automaticPurge: asBoolean(p.automaticPurge, 'automaticPurge') }, ctx.connection?.clientType === 'gui') }
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
      return await ctx.mms.storageUsage.measure({ refresh: asOptionalBoolean(p.refresh, 'refresh') === true })
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
