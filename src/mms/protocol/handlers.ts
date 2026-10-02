import { ConversationActionService } from '../actions/ConversationActionService'
import { assertHeldThreadLease, withGitMutationLocks } from '../actions/GitOperationCoordinator'
import { tryAcquireExecutionLease, heartbeatExecutionLease, releaseExecutionLeaseHandle } from '../queue/ThreadExecutionLease'
import { enableVersionedLifecycleWriter } from '../queue/ThreadLifecycleAdmission'
import { assertEpisodePath } from '../agents/WorkspaceAccessPolicy'
import { buildResourceInventory } from '../lifecycle/ResourceInventory'
import { assertLifecyclePath } from '../lifecycle/ResourceLifecycleStore'
import { lifecycleGit, readDirectLifecycleRef, WorktreeRetirementService } from '../lifecycle/WorktreeRetirementService'
/**
 * Method handlers against daemon-owned MousseMainService.
 * All nested mutable payloads are validated before service calls.
 */

import type { MmsProfileServices } from '../MmsProfileServices'
import type { ChatMessage, NativeLlmContext, OrchestratorSendInput, OrchestratorSendRequest } from '../../shared/types'
import { listClaimedQueue } from '../queue/ThreadMessageQueue'
import { formatQuestionAnswersMessage, formatQuestionDismissMessage } from '../orchestrator/OrchestratorService'
import { getPiLlmProviders } from '../orchestrator/piProviders'
import {
  ACCENT_COLORS,
  AGENT_TYPES,
  THEME_OPTIONS,
  buildAgentTypesFromCatalogs,
  lastUsedChatModel,
  type MousseSettingsUpdate
} from '../../shared/settings'
import {
  asAfterSequence,
  asAnswersMap,
  asBoolean,
  asChannelConfigPatch,
  asChannelPlatform,
  asCreateScheduledJobInput,
  asCursorMcpConfigPatch,
  asOptionalBoolean,
  asOptionalBoundedInt,
  asOptionalChannelPlatform,
  asOptionalChatImages,
  asOptionalChatMode,
  asOptionalString,
  asOptionalStringEnvMap,
  asOptionalTaskStatus,
  asProviderLoginResponse,
  asScheduledJobPatch,
  asScope,
  asSettingsPartial,
  asString,
  asStringArray,
  asBoundedInt,
  asControlEnrollParams,
  asControlSetModeParams,
  asPairingApproveParams,
  asPairingCreateParams,
  asPairingRejectParams,
  asPairingRevokeParams,
  isObject
} from './validators'
import { PROTOCOL_CAPABILITIES, PROTOCOL_METHODS, MMS_PROTOCOL_VERSION } from './types'
import { resolveThreadProjectPath } from '../data/resolveActiveProjectPath'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { StaleThreadActionRevisionError, ThreadActionService } from '../actions/ThreadActionService'
import { UndoService } from '../actions/UndoService'
import { UndoRetentionService } from '../actions/UndoRetentionService'
import { ReceiptRefReleaseService } from '../actions/ReceiptRefReleaseService'
import { RedoService } from '../actions/RedoService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { ConversationBranchService } from '../actions/ConversationBranchService'
import { git as workspaceGit } from '../actions/git'
import { randomUUID } from 'node:crypto'
import { ManagedConflictService } from '../actions/ManagedConflictService'
import { ChildAgentIntegrationService } from '../agents/ChildAgentIntegrationService'
import { ChangeReceiptService } from '../actions/ChangeReceiptService'
import { PublishService } from '../actions/PublishService'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { resolveWithinRoot } from '../files/pathGuard'
import { devGuiBridge } from '../devgui/DevGuiBridge'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { DomainConnectionContext } from './domainRegistry'
import { DomainRpcError } from './domainRegistry'
import { WORKFLOW_RUN_CAPABILITY } from '../../shared/workflowRunPlatform'
import { isInstallationMethod } from '../profiles/admission'
import { ChatReferenceMetadataResolver } from '../data/resolveChatReferenceMetadata'
import { parseChatReference } from '../../shared/chatReferences'

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

/** Browser authority uses the authenticated ingress, never a caller's source label. */
function admittedChatSource(ctx: HandlerContext, fallback: string): string {
  if (!ctx.connection) return fallback === 'gui' || fallback === 'cli' ? 'internal' : fallback
  return ctx.connection.clientType === 'gui' ? 'gui' : ctx.connection.clientType === 'cli' ? 'cli' : 'internal'
}

async function prepareChatInput(ctx: HandlerContext, threadId: string, input: OrchestratorSendRequest, raw: Record<string, unknown>): Promise<OrchestratorSendInput> {
  if (Object.hasOwn(raw, 'workflowInvocationId')) throw new DomainRpcError('invalid_params', 'Workflow receipt references are server-owned')
  const bridge = ctx.mms.platform?.workflowChat
  if (!bridge || !ctx.connection) return buildSendInput(input.content, input.mode, input.images)
  const prepared = await bridge.prepare(threadId, { ...input, requestId: asOptionalString(raw.requestId, 64) }, ctx.connection.clientType === 'gui' ? 'gui' : 'cli')
  if (prepared.workflowInvocationId) {
    if (!ctx.connection.capabilities.has(WORKFLOW_RUN_CAPABILITY)) throw new DomainRpcError('capability_required', 'This connection cannot execute workflow commands')
    return prepared
  }
  return buildSendInput(prepared.content, prepared.mode, prepared.images)
}

function asAgentAssignment(v: Record<string, unknown>): {
  cliType: 'mousse' | 'claude-code' | 'codex' | 'opencode' | 'cursor-agents-cli'
  task: string
  provider?: string
  model?: string
  effort?: string
} {
  const allowed = new Set(['threadId', 'cliType', 'task', 'provider', 'model', 'effort'])
  for (const key of Object.keys(v)) {
    if (!allowed.has(key)) throw new Error(`${key} is not allowed`)
  }
  const cliType = asString(v.cliType, 'cliType', 64)
  if (!AGENT_TYPES.some((agent) => agent.id === cliType)) {
    throw new Error('cliType must be a supported agent type')
  }
  const provider = asOptionalString(v.provider, 256)
  const model = asOptionalString(v.model, 512)
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('provider and model must be supplied together')
  }
  const effort = asOptionalString(v.effort, 64)
  return {
    cliType: cliType as 'mousse' | 'claude-code' | 'codex' | 'opencode' | 'cursor-agents-cli',
    task: asString(v.task, 'task'),
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {})
  }
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
  if (!lookup.projectPath) throw new Error(`Thread has no project workspace: ${lookup.threadId}`)
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
    if (workspace && workspace.lifecycle !== 'ready') throw new Error(`Task workspace is ${workspace.lifecycle}; recovery is required.`)
    return workspace ? manager.executionContext(projectPath, workspace).projectPath : projectPath
  }
  if (!projectId) throw new Error('projectId or threadId is required')
  const project = ctx.mms.projects.getProject(projectId)
  if (!project) throw new DomainRpcError('project_not_found', 'Project not found', { projectId })
  return project.path
}

async function ensureOwnedTaskWorkspace(ctx: HandlerContext, params: Record<string, unknown>): Promise<void> {
  if (!params.threadId) return
  const threadId = asString(params.threadId, 'threadId', 256)
  if (!ctx.mms.threads.getThread(threadId)) throw new Error('Task not found')
  const project = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
  if (!project) throw new Error('Task has no project workspace')
  const manager = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId))
  if (!manager.load()) await manager.provision(threadId, 'main', project)
  if (!existsSync(manager.load()!.worktreePath) && manager.hasReconstructionManifest()) await manager.restore(project)
  if (manager.verify().lifecycle !== 'ready') throw new DomainRpcError('workspace_recovery_required', 'Task workspace requires recovery before mutation')
}

function containedPath(root: string, value: unknown): string {
  const path = asOptionalString(value, 4096) ?? ''
  const absolute = resolveWithinRoot(root, path)
  return relative(root, absolute).replace(/\\/g, '/')
}

function requiredContainedPath(root: string, value: unknown): string {
  return containedPath(root, asString(value, 'path', 4096))
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

function lifecycleExpectedGeneration(params: Record<string, unknown>): number | undefined {
  const value = params.expectedGeneration
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('Invalid lifecycle expectedGeneration')
  return value as number
}

export async function dispatchMethod(
  ctx: HandlerContext,
  method: string,
  params: unknown
): Promise<unknown> {
  // Installation lifecycle commands must not wait on themselves in a personal
  // request barrier. Every actual personal service has this ownership method;
  // the fallback preserves legacy isolated handler test doubles.
  if (!isInstallationMethod(method) && ctx.mms.runOwnedRequest) {
    return ctx.mms.runOwnedRequest(method, () => dispatchOwnedMethod(ctx, method, params))
  }
  return dispatchOwnedMethod(ctx, method, params)
}

async function dispatchOwnedMethod(ctx: HandlerContext, method: string, params: unknown): Promise<unknown> {
  if (isObject(params) && typeof params.threadId === 'string' &&
      !['threads.delete', 'threads.trash', 'threads.restore', 'threads.purge', 'threads.inventory'].includes(method) &&
      ctx.mms.threads?.lifecycleStore?.get(params.threadId)) {
    ctx.mms.threads.assertThreadAdmission(params.threadId)
  }
  if (ctx.mms.domains?.has(method)) return ctx.mms.domains.dispatch(ctx, method, params)
  switch (method) {
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
      return { projects: ctx.mms.projects.listProjects() }
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
      return { project, projects }
    }
    case 'projects.remove': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      ctx.mms.projects.removeProject(projectId)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { projects }
    }
    case 'projects.rename': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      const name = asString(p.name, 'name', 512)
      const project = ctx.mms.projects.renameProject(projectId, name)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects }
    }
    case 'projects.pin': {
      const p = isObject(params) ? params : {}
      const projectId = asString(p.projectId, 'projectId', 256)
      const pinned = asOptionalBoolean(p.pinned, 'pinned') === true
      const project = ctx.mms.projects.setProjectPinned(projectId, pinned)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects }
    }
    case 'projects.reorder': {
      const p = isObject(params) ? params : {}
      const projectIds = asStringArray(p.projectIds, 'projectIds', { unique: true })
      const projects = ctx.mms.projects.reorderProjects(projectIds)
      ctx.emitEvent?.('projects.updated', { projects })
      return { projects }
    }
    case 'threads.list': {
      const p = isObject(params) ? params : {}
      const projectId = asOptionalString(p.projectId)
      const threads = projectId
        ? ctx.mms.threads.listThreads(projectId)
        : ctx.mms.threads.listAllThreads()
      return { threads }
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
      const lastUsed = lastUsedChatModel(ctx.mms.settings.get())
      if (lastUsed) {
        thread = ctx.mms.threads.updateThreadMeta(thread.id, { modelOverride: lastUsed })
      }
      const threads = ctx.mms.threads.listAllThreads()
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
      return { threads, lifecycle, operationResult }
    }
    case 'threads.rename': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const name = asString(p.name, 'name', 512)
      const thread = ctx.mms.threads.updateThreadMeta(threadId, { name })
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads }
    }
    case 'threads.pin': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const pinned = asOptionalBoolean(p.pinned, 'pinned') === true
      const thread = ctx.mms.threads.setThreadPinned(threadId, pinned)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads }
    }
    case 'threads.settle': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const settled = asOptionalBoolean(p.settled, 'settled') === true
      const thread = ctx.mms.threads.setThreadSettled(threadId, settled)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads }
    }
    case 'threads.reorder': {
      const p = isObject(params) ? params : {}
      const projectId = asOptionalString(p.projectId, 256)
      const threadIds = asStringArray(p.threadIds, 'threadIds', { unique: true })
      const threads = ctx.mms.threads.reorderThreads(projectId, threadIds)
      const all = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads: all })
      return { threads, all }
    }
    case 'threads.search': {
      const p = isObject(params) ? params : {}
      const query = asString(p.query, 'query', 512)
      const limit =
        typeof p.limit === 'number' && Number.isFinite(p.limit) && p.limit > 0
          ? Math.min(Math.floor(p.limit), 200)
          : 50
      return { results: ctx.mms.threads.searchThreads(query, limit) }
    }
    case 'thread.snapshot': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const thread = ctx.mms.threads.getThread(threadId)
      if (!thread) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const session = ctx.mms.orchestrator.getOrCreateSession(threadId)
      const rt = ctx.mms.threadRuntimes.getOrHydrate(threadId)
      const messages = ctx.mms.orchestrator.getMessages(threadId)
      const queue = ctx.mms.orchestrator.listQueue(threadId)
      const claimed = listClaimedQueue(session.queue).filter((item) => !item.internal)
      const turnActive = ctx.mms.orchestrator.isTurnActive(threadId)
      const turnRunning = ctx.mms.orchestrator.isActiveTurnRunning(threadId)
      const connectionFailed =
        session.failedConnectionRequest !== null || rt.connectionFailed
      const pendingQuestions = ctx.mms.questions.listPendingForThread(threadId)
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
    case 'threads.regenerateTitle': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const messages = ctx.mms.orchestrator.getMessages(threadId)
      const title = await ctx.mms.orchestrator.generateThreadTitle(messages, threadId)
      if (!title) throw new Error('The title model returned an empty title.')
      const thread = ctx.mms.threads.updateThreadMeta(threadId, { name: title })
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads }
    }
    case 'threads.setModel': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const model = p.model
      let override: { llmProvider: string; model: string } | undefined
      if (model !== undefined && model !== null) {
        if (!isObject(model)) throw new Error('model must be an object')
        const llmProvider = asString(model.llmProvider, 'model.llmProvider', 256)
        const modelId = asString(model.model, 'model.model', 512)
        if (!llmProvider || !modelId) throw new Error('Model provider and id are required')
        override = { llmProvider, model: modelId }
      }
      const next = ctx.mms.orchestrator.setThreadModelOverride(threadId, override)
      if (override) {
        ctx.mms.settings.set({ provider: override })
        ctx.emitEvent?.('settings.changed', { settings: ctx.mms.settings.get() })
      }
      const thread = ctx.mms.threads.getThread(threadId)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, modelOverride: next, threads }
    }
    case 'threads.setWorktreeEnabled': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const enabled = asOptionalBoolean(p.enabled, 'enabled') === true
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      // Refuse once an isolated workspace exists — the toggle is new-chat only.
      const workspace = new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(threadId)).load()
      if (workspace?.lifecycle === 'ready' || workspace?.lifecycle === 'provisioning') {
        throw new Error('Worktree mode is locked once a workspace is provisioned.')
      }
      const thread = ctx.mms.threads.setThreadWorktreeEnabled(threadId, enabled)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads }
    }
    case 'orchestrator.send': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const content = asString(p.content, 'content')
      const forceQueue = asOptionalBoolean(p.forceQueue, 'forceQueue') === true
      const source = admittedChatSource(ctx, asOptionalString(p.source, 64) ?? 'protocol')
      const mode = asOptionalChatMode(p.mode, 'mode')
      const images = asOptionalChatImages(p.images, 'images')
      if (!ctx.mms.threads.getThread(threadId)) {
        throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      }
      ctx.mms.orchestrator.getOrCreateSession(threadId)
      const input = await prepareChatInput(ctx, threadId, { content, mode, images }, p)
      return await ctx.mms.orchestrator.send(input, false, {
        threadId,
        source,
        forceQueue
      })
    }
    case 'orchestrator.abort': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const clearQueue = asOptionalBoolean(p.clearQueue, 'clearQueue') === true
      const ok = ctx.mms.orchestrator.abortActiveTurn(threadId, { clearQueue })
      return { ok }
    }
    case 'orchestrator.steer': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const text = asString(p.text, 'text')
      // Prefer mid-turn steer; fall back to external enqueue when no local turn.
      const result = ctx.mms.orchestrator.steerThreadOrEnqueueExternal(threadId, text, {
        source: admittedChatSource(ctx, asOptionalString(p.source, 64) ?? 'protocol-steer')
      })
      return { ok: result.steered || result.queued, steered: result.steered, queued: result.queued }
    }
    case 'orchestrator.retry': {
      const p = isObject(params) ? params : {}
      const threadId = asOptionalString(p.threadId, 256)
      const ok = ctx.mms.orchestrator.retryLastConnection(threadId)
      return { ok }
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
      const session = ctx.mms.orchestrator.getOrCreateSession(threadId)
      return {
        items: ctx.mms.orchestrator.listQueue(threadId),
        claimed: listClaimedQueue(session.queue).filter((item) => !item.internal)
      }
    }
    case 'queue.enqueue': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const content = asString(p.content, 'content')
      const mode = asOptionalChatMode(p.mode, 'mode')
      const images = asOptionalChatImages(p.images, 'images')
      const source = admittedChatSource(ctx, asOptionalString(p.source, 64) ?? 'protocol')
      const item = ctx.mms.orchestrator.enqueueForThread(
        threadId,
        await prepareChatInput(ctx, threadId, { content, mode, images }, p),
        { source }
      )
      return { item, items: ctx.mms.orchestrator.listQueue(threadId) }
    }
    case 'queue.reorder': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const orderedIds = asStringArray(p.orderedIds, 'orderedIds', {
        unique: true,
        maxItems: 10_000
      })
      const items = ctx.mms.orchestrator.reorderQueue(threadId, orderedIds)
      return { items }
    }
    case 'queue.remove': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const itemId = asString(p.itemId, 'itemId', 256)
      const removed = ctx.mms.orchestrator.removeQueuedItem(threadId, itemId)
      if (!removed) {
        const current = ctx.mms.orchestrator
          .getOrCreateSession(threadId)
          .queue.find((item) => item.id === itemId)
        if (current?.state === 'claimed' || current?.state === 'steering') {
          throw new Error('Queued message already started and can no longer be removed.')
        }
        throw new Error('Queued message was not found or is no longer removable.')
      }
      return { outcome: 'removed', removed }
    }
    case 'queue.promoteToSteer': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const itemId = asString(p.itemId, 'itemId', 256)
      const ok = ctx.mms.orchestrator.promoteQueueItemToSteer(threadId, itemId)
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
      const ok = ctx.mms.questions.submitAnswers(requestId, answers)
      if (ok && pending) {
        // Answers reach the model through the tool result; mirror them as a
        // visible user message so the transcript shows what the user said.
        ctx.mms.orchestrator.recordQuestionResponseMessage(
          pending.threadId,
          formatQuestionAnswersMessage(pending.questions, answers)
        )
      }
      return { ok }
    }
    case 'orchestrator.dismissQuestions': {
      const p = isObject(params) ? params : {}
      const requestId = asString(p.requestId, 'requestId', 256)
      const pending = ctx.mms.questions.getPending(requestId)
      const ok = ctx.mms.questions.dismiss(requestId)
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
      if (threadId) {
        return { pending: ctx.mms.questions.listPendingForThread(threadId) }
      }
      return { pending: ctx.mms.questions.listAllPending() }
    }
    case 'agents.list': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      return { agents: ctx.mms.threadRuntimes.listAgents(threadId), threadId }
    }
    case 'agents.listNamed': {
      const p = isObject(params) ? params : {}
      return ctx.mms.orchestrator.listNamedAgents(asString(p.threadId, 'threadId', 256))
    }
    case 'agents.reviewNamed': {
      const p = isObject(params) ? params : {}, lookup = threadLookupContext(ctx, p)
      const agentId = asString(p.agent, 'agent', 128), episodeId = asString(p.episodeId, 'episodeId', 128)
      const state = ctx.mms.orchestrator.listNamedAgents(lookup.threadId)
      const episode = state.episodes.find((entry) => entry.id === episodeId && entry.agentId === agentId)
      const workspace = new ThreadWorkspaceManager(lookup.threadDirectory).load()
      if (!episode || episode.policy.workspace !== 'isolated' || episode.policy.access !== 'write' || !['completed', 'failed', 'interrupted'].includes(episode.state) || !workspace || !lookup.projectPath) throw new Error('Only a settled isolated write result can be reviewed')
      const resultSha = episode.result?.resultSha, baseSha = episode.binding.integrationBaseSha ?? episode.binding.baseSha
      if (!resultSha || !baseSha || ![resultSha, baseSha].every((sha) => /^[a-f0-9]{40,64}$/.test(sha))) throw new Error('Episode has no verified result boundary')
      const retirement = new WorktreeRetirementService(ctx.mms.threads.lifecycleStore)
      const manifestPath = retirement.pathFor(lookup.threadId, episode.binding.worktreePath)
      if (existsSync(manifestPath)) {
        const manifest = retirement.load(manifestPath); retirement.verifyPins(manifest)
        if (manifest.resultSha !== resultSha || manifest.branch !== episode.binding.branch) throw new Error('Retained result no longer matches the episode')
      } else if (readDirectLifecycleRef(lookup.projectPath, `refs/heads/${episode.binding.branch}`) !== resultSha) throw new Error('Episode result branch changed')
      const destinationSha = readDirectLifecycleRef(lookup.projectPath, `refs/heads/${workspace.branch}`)
      if (!destinationSha) throw new Error('Task destination revision is unavailable')
      try {
        return { episodeId, resultSha, baseSha, destinationSha,
          summary: lifecycleGit(lookup.projectPath, ['diff', '--no-ext-diff', '--no-textconv', '--stat', baseSha, resultSha, '--'], undefined, 128 * 1024),
          diff: lifecycleGit(lookup.projectPath, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=3', baseSha, resultSha, '--'], undefined, 512 * 1024) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOBUFS') throw new Error('Result exceeds the desktop review size limit. Inspect the retained result commit in Git before requesting integration through the API.')
        throw error
      }
    }
    case 'agents.createNamed':
    case 'agents.recallNamed': {
      const p = isObject(params) ? params : {}
      const allowed = new Set(['threadId', 'name', 'task', 'operationId', 'workspace', 'access', 'provider', 'model', 'effort', ...(method === 'agents.recallNamed' ? ['agent', 'expectedAgentGeneration', 'contextMode', 'resumeResult'] : [])])
      for (const key of Object.keys(p)) if (!allowed.has(key)) throw new Error(`${key} is not allowed`)
      if (p.workspace !== undefined && p.workspace !== 'shared' && p.workspace !== 'isolated') throw new Error('Invalid workspace policy')
      if (p.access !== undefined && p.access !== 'read-only' && p.access !== 'write') throw new Error('Invalid access policy')
      return ctx.mms.orchestrator.createNamedAgent(asString(p.threadId, 'threadId', 256), {
        name: asString(method === 'agents.recallNamed' ? p.agent : p.name, 'agent name or ID', 128), task: asString(p.task, 'task'),
        resumeResult: asOptionalBoolean(p.resumeResult, 'resumeResult'),
        expectedAgentGeneration: method === 'agents.recallNamed' ? asBoundedInt(p.expectedAgentGeneration, 'expectedAgentGeneration', { min: 0, max: Number.MAX_SAFE_INTEGER }) : undefined,
        contextMode: p.contextMode === undefined || p.contextMode === 'continue' ? undefined : p.contextMode === 'fresh' ? 'fresh' : (() => { throw new Error('Invalid recall context mode') })(),
        operationId: asString(p.operationId, 'operationId', 128),
        policy: { version: 1, workspace: p.workspace, access: p.access },
        provider: asOptionalString(p.provider, 256), model: asOptionalString(p.model, 512), effort: asOptionalString(p.effort, 64)
      })
    }
    case 'agents.integrateNamed': {
      const p = isObject(params) ? params : {}
      return ctx.mms.orchestrator.integrateNamedAgent(asString(p.threadId, 'threadId', 256), {
        agent: asString(p.agent, 'agent', 128), episodeId: asString(p.episodeId, 'episodeId', 128), operationId: asString(p.operationId, 'operationId', 128),
        expectedResultSha: asString(p.expectedResultSha, 'expectedResultSha', 64), expectedDestinationSha: asString(p.expectedDestinationSha, 'expectedDestinationSha', 64)
      })
    }
    case 'agents.spawn': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      const assignment = asAgentAssignment(p)
      const logs = await ctx.mms.orchestrator.spawnAgentsForThread(threadId, [assignment])
      return { threadId, logs }
    }
    case 'agents.stop': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      const merge = asOptionalBoolean(p.merge, 'merge') === true
      if (!ctx.mms.threads.getThread(threadId)) throw new DomainRpcError('thread_not_found', 'Thread not found', { threadId })
      if (!ctx.mms.threadRuntimes.listAgents(threadId).some((agent) => agent.id === agentId)) {
        throw new Error(`Agent not found in thread: ${agentId}`)
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
    case 'mousseAgent.getMessages': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      if (!ctx.mms.threadRuntimes.listAgents(threadId).some((agent) => agent.id === agentId)) {
        return { threadId, agentId, messages: [] }
      }
      return {
        threadId,
        agentId,
        messages: ctx.mms.orchestrator.getMousseAgentMessages(agentId)
      }
    }
    case 'mousseAgent.getAssignment': {
      const p = isObject(params) ? params : {}
      const agentId = asString(p.agentId, 'agentId', 256)
      return {
        agentId,
        assignment: ctx.mms.orchestrator.getMousseAgentAssignment(agentId)
      }
    }
    case 'mousseAgent.contextUsage': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      const draftInput = asOptionalString(p.draftInput) ?? ''
      if (!ctx.mms.threadRuntimes.listAgents(threadId).some((agent) => agent.id === agentId)) {
        return { threadId, agentId, usage: undefined }
      }
      return {
        threadId,
        agentId,
        usage: await ctx.mms.orchestrator.getMousseAgentContextUsage(agentId, draftInput)
      }
    }
    case 'mousseAgent.send': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      const content = asString(p.content, 'content')
      const images = asOptionalChatImages(p.images, 'images')
      if (!ctx.mms.threadRuntimes.listAgents(threadId).some((agent) => agent.id === agentId)) {
        return { threadId, agentId, accepted: false, reason: 'missing' }
      }
      return { threadId, agentId, ...(await ctx.mms.orchestrator.sendMousseAgentMessage(agentId, content, images)) }
    }
    case 'mousseAgent.retry': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      if (!ctx.mms.threadRuntimes.listAgents(threadId).some((agent) => agent.id === agentId)) {
        return { threadId, agentId, ok: false }
      }
      ctx.mms.orchestrator.retryMousseAgent(agentId)
      return { threadId, agentId, ok: true }
    }
    case 'mousseAgent.abort': {
      const p = isObject(params) ? params : {}
      const agentId = asString(p.agentId, 'agentId', 256)
      return { agentId, aborted: ctx.mms.orchestrator.abortMousseAgent(agentId) }
    }
    case 'pty.list': {
      const p = isObject(params) ? params : {}
      const threadId = asOptionalString(p.threadId, 256)
      return { ptys: ctx.mms.ptyManager.list(threadId) }
    }
    case 'pty.create': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      let cwd = asOptionalString(p.cwd, 4096) ?? process.cwd()
      const command = asOptionalString(p.command, 4096)
      const env = asOptionalStringEnvMap(p.env, 'env')
      const shellArgs =
        p.shellArgs === undefined
          ? undefined
          : asStringArray(p.shellArgs, 'shellArgs', { maxItems: 32, maxItemLen: 1024 })
      const task = threadId !== '__unbound__' ? ctx.mms.threads.getThread(threadId) : undefined
      if (threadId !== '__unbound__' && !task) throw new Error('Task not found for terminal')
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
      if (task && ctx.mms.threadRuntimes.listAgents(threadId).find((agent) => agent.id === agentId)?.workspacePolicy?.access === 'read-only') throw new Error('Read-only agents cannot open an arbitrary shell')
      if (metadata) {
        if (manager!.verify(metadata).lifecycle !== 'ready') throw new Error('Task workspace requires recovery before opening a terminal')
        const projectPath = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
        if (p.cwd === undefined || projectPath && cwd === projectPath) cwd = manager!.executionContext(projectPath ?? metadata.worktreePath, metadata).projectPath
        else cwd = assertEpisodePath(metadata.worktreePath, cwd)
      }
      const lease = directory ? tryAcquireExecutionLease(directory, { source: 'task-terminal' }) : undefined
      if (directory && !lease) throw new DomainRpcError('workspace_busy', 'Task writer is busy; wait for it to finish before opening a terminal')
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
        if (actions && actionOptions) actions.beginTurn(actionOptions, metadata!.headSha)
        ptyId = ctx.mms.ptyManager.create(agentId, cwd, command, { threadId, env, shellArgs,
          ownership: lease ? { assert: () => assertHeldThreadLease(directory!, lease), heartbeat: () => { heartbeatExecutionLease(lease) },
            settled: async () => {
              try { if (actions && actionOptions) await actions.checkpointExistingTurn(actionOptions, metadata!.headSha, 'completed') }
              finally { releaseExecutionLeaseHandle(lease) }
            } } : undefined
        })
      } catch (error) { if (lease) releaseExecutionLeaseHandle(lease); throw error }
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
      return { scrollbacks: ctx.mms.ptyManager.getScrollbacks(threadId) }
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
      return { activity: ctx.mms.threadRuntimes.getActivitySnapshot() }
    }
    case 'stats.usage':
      return ctx.mms.lineEditStats.getUsageSnapshot()
    case 'stats.lineEdits':
      return ctx.mms.lineEditStats.getSnapshot()
    case 'stats.recordManualEdits': {
      const p = isObject(params) ? params : {}
      const expectedProfileId = asOptionalString(p.expectedProfileId, 256)
      if (expectedProfileId && expectedProfileId !== ctx.mms.profileId) {
        throw new Error('Profile changed while saving; edit statistics cannot be attributed to another profile')
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
      const job = ctx.mms.scheduled.createJob(input)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.update': {
      const p = isObject(params) ? params : {}
      const id = asString(p.id, 'id', 256)
      const patch = asScheduledJobPatch(p.patch)
      const existing = ctx.mms.scheduled.getJob(id)
      if (!existing) throw new Error(`Job not found: ${id}`)
      const job = ctx.mms.scheduled.updateJob(id, {
        name: patch.name,
        prompt: patch.prompt,
        schedule: patch.schedule,
        enabled: patch.enabled,
        threadId: patch.threadId === null ? undefined : patch.threadId,
        projectId: patch.projectId === null ? undefined : patch.projectId,
        createThread: patch.createThread,
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
      })
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
      const job = ctx.mms.scheduled.triggerJob(id)
      return { job, jobs: ctx.mms.scheduled.listJobs() }
    }
    case 'scheduled.status':
      return { status: ctx.mms.scheduled.getStatus() }
    // ── Channels ──────────────────────────────────────────────────────────
    case 'channels.getSnapshot':
      return { snapshot: ctx.mms.channels.getSnapshot() }
    case 'channels.getConfig':
      return { config: ctx.mms.channels.getConfig() }
    case 'channels.updateConfig': {
      const p = isObject(params) ? params : {}
      const patch = asChannelConfigPatch(p.patch)
      // Validated nested patch; service deep-merges partial platforms.
      const config = ctx.mms.channels.updateConfig(
        patch as Parameters<typeof ctx.mms.channels.updateConfig>[0]
      )
      return { config, snapshot: ctx.mms.channels.getSnapshot() }
    }
    case 'channels.connect': {
      const p = isObject(params) ? params : {}
      const platform = asOptionalChannelPlatform(p.platform)
      await ctx.mms.channels.connect(platform)
      return { snapshot: ctx.mms.channels.getSnapshot() }
    }
    case 'channels.disconnect': {
      const p = isObject(params) ? params : {}
      const platform = asOptionalChannelPlatform(p.platform)
      await ctx.mms.channels.disconnect(platform)
      return { snapshot: ctx.mms.channels.getSnapshot() }
    }
    case 'channels.listPairingRequests':
      return { requests: ctx.mms.channels.listPairingRequests() }
    case 'channels.approvePairing': {
      const p = isObject(params) ? params : {}
      const code = asString(p.code, 'code', 128)
      const ok = await ctx.mms.channels.approvePairing(code)
      return { ok }
    }
    case 'channels.rejectPairing': {
      const p = isObject(params) ? params : {}
      const code = asString(p.code, 'code', 128)
      const ok = await ctx.mms.channels.rejectPairing(code)
      return { ok }
    }
    case 'channels.sendTest': {
      const p = isObject(params) ? params : {}
      const platform = asChannelPlatform(p.platform)
      const chatId = asString(p.chatId, 'chatId', 256)
      const text = asString(p.text, 'text')
      const threadId = asOptionalString(p.threadId, 256)
      const result = await ctx.mms.channels.sendTest(platform, chatId, text, threadId)
      return { result }
    }
    case 'channels.getActivity': {
      const p = isObject(params) ? params : {}
      const limit =
        typeof p.limit === 'number' && Number.isFinite(p.limit)
          ? Math.min(Math.floor(p.limit), 500)
          : undefined
      return { activity: ctx.mms.channels.getRecentActivity(limit) }
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
      const settings = ctx.mms.settings.set(partial)
      // Fan-out so all clients observe the same daemon-owned settings immediately.
      ctx.emitEvent?.('settings.changed', { settings })
      return { settings }
    }
    case 'settings.getOptions': {
      await ctx.mms.providerAuth.init()
      const llmProviders = getPiLlmProviders(ctx.mms.providerAuth)
      const antigravity = ctx.mms.antigravity.llmProvider()
      if (antigravity) llmProviders.push(antigravity)
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
    case 'providers.listConfigured':
      return { providers: [...ctx.mms.providerAuth.getConfiguredProviders(), ...[ctx.mms.antigravity.configuredProvider()].filter((provider) => provider !== undefined)] }
    case 'providers.getUsage':
      return ctx.mms.providerAuth.getUsage()
    case 'providers.getSubscriptionUsage': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      return { usage: await ctx.mms.providerAuth.getSubscriptionUsage(providerId) }
    }
    case 'providers.getLoginOptions': {
      const p = isObject(params) ? params : {}
      const authType = asOptionalString(p.authType, 32) as 'api_key' | 'oauth' | undefined
      return { options: [...ctx.mms.providerAuth.getLoginOptions(authType), ...(authType === 'api_key' || ctx.mms.antigravity.configured() ? [] : [ctx.mms.antigravity.loginOption()])] }
    }
    case 'providers.refreshModels': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      if (providerId === 'antigravity') await ctx.mms.antigravity.refreshModels(ctx.mms.worktrees.getRepoRoot())
      else await ctx.mms.providerAuth.refreshDynamicModels()
      return { options: [...getPiLlmProviders(ctx.mms.providerAuth), ...[ctx.mms.antigravity.llmProvider()].filter((provider) => provider !== undefined)] }
    }
    case 'providers.getAmbientInfo': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      return { info: ctx.mms.providerAuth.getAmbientProviderInfo(providerId) }
    }
    case 'providers.setApiKey': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const apiKey = asString(p.apiKey, 'apiKey', 8192)
      await ctx.mms.providerAuth.setApiKey(providerId, apiKey)
      await ctx.mms.providerAuth.refreshDynamicModels().catch(() => undefined)
      const providers = ctx.mms.providerAuth.getConfiguredProviders()
      ctx.emitEvent?.('providers.changed', { providers })
      return { providers }
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
    case 'providers.verifyAmbient': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const result = await ctx.mms.providerAuth.verifyAmbientProvider(providerId)
      const providers = ctx.mms.providerAuth.getConfiguredProviders()
      if (result?.success) ctx.emitEvent?.('providers.changed', { providers })
      return { result, providers }
    }
    case 'providers.logout': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      if (providerId === 'antigravity') await ctx.mms.antigravity.logout()
      else await ctx.mms.providerAuth.logout(providerId)
      const providers = [...ctx.mms.providerAuth.getConfiguredProviders(), ...[ctx.mms.antigravity.configuredProvider()].filter((provider) => provider !== undefined)]
      ctx.emitEvent?.('providers.changed', { providers })
      return { providers }
    }
    case 'providers.loginOAuth': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const session = ctx.mms.providerAuth.createSession()
      const forward = (event: unknown): void => {
        ctx.emitEvent?.('providers.login-event', {
          sessionId: session.sessionId,
          event
        })
      }
      session.on('event', forward)
      try {
        const result = providerId === 'antigravity'
          ? await ctx.mms.antigravity.login(session, ctx.mms.worktrees.getRepoRoot())
          : await ctx.mms.providerAuth.runOAuthLogin(session, providerId)
        if (result && (result as { success?: boolean }).success !== false) {
          await ctx.mms.providerAuth.refreshDynamicModels().catch(() => undefined)
        }
        const providers = [...ctx.mms.providerAuth.getConfiguredProviders(), ...[ctx.mms.antigravity.configuredProvider()].filter((provider) => provider !== undefined)]
        if (result && (result as { success?: boolean }).success !== false) {
          ctx.emitEvent?.('providers.changed', { providers })
        }
        return {
          result,
          sessionId: session.sessionId,
          providers
        }
      } finally {
        session.off('event', forward)
        ctx.mms.providerAuth.endSession(session.sessionId)
      }
    }
    case 'providers.loginApiKey': {
      const p = isObject(params) ? params : {}
      const providerId = asString(p.providerId, 'providerId', 128)
      const session = ctx.mms.providerAuth.createSession()
      const forward = (event: unknown): void => {
        ctx.emitEvent?.('providers.login-event', {
          sessionId: session.sessionId,
          event
        })
      }
      session.on('event', forward)
      try {
        const result = await ctx.mms.providerAuth.runApiKeyLogin(session, providerId)
        if (result && (result as { success?: boolean }).success !== false) {
          await ctx.mms.providerAuth.refreshDynamicModels().catch(() => undefined)
        }
        const providers = ctx.mms.providerAuth.getConfiguredProviders()
        if (result && (result as { success?: boolean }).success !== false) {
          ctx.emitEvent?.('providers.changed', { providers })
        }
        return {
          result,
          sessionId: session.sessionId,
          providers
        }
      } finally {
        session.off('event', forward)
        ctx.mms.providerAuth.endSession(session.sessionId)
      }
    }
    case 'providers.loginRespond': {
      const p = isObject(params) ? params : {}
      const sessionId = asString(p.sessionId, 'sessionId', 256)
      const response = asProviderLoginResponse(p.response)
      if (response.sessionId !== sessionId) {
        throw new Error('response.sessionId must match sessionId')
      }
      const session = ctx.mms.providerAuth.getSession(sessionId)
      if (!session) return { ok: false }
      session.respond(response)
      return { ok: true }
    }
    case 'providers.loginCancel': {
      const p = isObject(params) ? params : {}
      const sessionId = asString(p.sessionId, 'sessionId', 256)
      ctx.mms.providerAuth.endSession(sessionId)
      return { ok: true }
    }
    case 'workspace.getStatus': {
      const p = isObject(params) ? params : {}
      const lookup = threadLookupContext(ctx, p)
      const manager = new ThreadWorkspaceManager(lookup.threadDirectory)
      const stored = manager.load()
      const metadata = stored && lookup.projectPath ? manager.verify(stored) : stored
      return {
        metadata,
        execution: lookup.projectPath
          ? manager.executionContext(lookup.projectPath, metadata)
          : manager.unboundExecutionContext(lookup.threadId),
        journalGeneration: lookup.currentGeneration
      }
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
    case 'actions.list': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
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
      const redoTarget = eligible && latest.scope === 'conversation' && latest.state === 'undone'
        ? { actionId: latest.id, turnId: latest.turnId, journalGeneration: operation.currentGeneration } : undefined
      return { actions, retentionPolicy: retention.policy(), receipts: new ChangeReceiptService(operation.threadDirectory).list(), activeBranchId, journalGeneration: operation.currentGeneration, undoTarget, redoTarget,
        undoUnavailableReason: undoTarget ? undefined : busy ? 'Wait for active or queued work to finish.' : latest?.retention?.state === 'expired' || latest?.retention?.state === 'blocked' ? latest.retention.reason : 'This prompt has no eligible recorded Undo boundary. Tool effects or older unrecorded turns cannot be undone safely.' }
    }
    case 'actions.sweepRetention':
    case 'actions.configureRetention':
    case 'actions.pin': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      const retention = new UndoRetentionService(operation.threadDirectory)
      if (method === 'actions.sweepRetention') {
        const logical = await retention.sweep(workspace.worktreePath)
        const physical = logical.suspended ? undefined : await new ReceiptRefReleaseService(ctx.mms.threads.lifecycleStore, operation.threadId).release(workspace.worktreePath)
        return { ...logical, physical }
      }
      // CLI/model callers cannot self-assert a human identity in request parameters.
      const human = ctx.connection?.clientType === 'gui'
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
      if (!action) throw new Error(`Action not found: ${actionId}`)
      return { files: action.changedPaths, externalEffects: action.externalEffects }
    }
    case 'actions.undoLatest': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      const branchId = workspace?.conversationBranchId ?? 'main'
      const expectedTurnId = asOptionalString(p.expectedTurnId, 256)
      const validate = (target: import('../../shared/threadActions').ThreadAction): void => {
        if (ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)) throw new Error('Wait for active or queued work to finish.')
        // Generic workspace Undo also serves editor and workflow receipts with no prompt.
        // Prompt-targeted requests and conversation-only receipts require exact provenance.
        if (target.scope !== 'conversation' && expectedTurnId === undefined) return
        if (!target.nativeContextStartBoundary || target.nativeContextStartBoundary.fidelity === 'legacy') throw new DomainRpcError('undo_boundary_unavailable', 'This turn has no exact recorded conversation Undo boundary.')
        if (target.scope === 'conversation') ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, 'undo')
        const messages = ctx.mms.orchestrator.getMessagesForPersistence(operation.threadId)
        const prompt = messages.filter((message) => message.role === 'user' && !message.hidden).at(-1)
        if (!prompt || prompt.turnId !== target.turnId || messages.indexOf(prompt) < target.presentationMessageStart || messages.indexOf(prompt) >= target.presentationMessageEnd) throw new Error('The latest prompt has no eligible Undo boundary.')
      }
      const restore = (target: import('../../shared/threadActions').ThreadAction, kind: 'undo' | 'redo'): void => {
        if (target.scope === 'conversation') ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, kind)
        if (!target.nativeContextStartBoundary) return
        if (kind === 'redo') ctx.mms.orchestrator.restoreConversationActionEnd(operation.threadId, target.presentationMessageStart, target.presentationMessageEnd, target.nativeContextBoundary)
        else ctx.mms.orchestrator.restoreConversationBoundary(operation.threadId, target.presentationMessageStart, target.nativeContextStartBoundary!)
      }
      const latest = new ThreadActionService(operation.threadDirectory).latest(branchId)
      let action
      if (latest?.scope === 'conversation') action = new ConversationActionService(operation.threadDirectory).apply(branchId, 'undo', operation.currentGeneration, expectedTurnId, validate, restore)
      else {
        if (!workspace || workspace.lifecycle !== 'ready') throw new Error('This prompt has no eligible recorded Undo boundary.')
        action = await new UndoService(operation.threadDirectory).undoLatest(branchId, workspace.worktreePath, undefined, operation.currentGeneration, restore, 'undo', expectedTurnId, validate)
      }
      ctx.emitEvent?.('actions.updated', { threadId: operation.threadId, action }, operation.threadId)
      return { action }
    }
    case 'actions.revertCode': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const actionId = asString(p.actionId, 'actionId', 256)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      return { action: await new CodeRevertService(operation.threadDirectory).revertCode(actionId, workspace.worktreePath, operation.currentGeneration) }
    }
    case 'actions.redo': {
      const p = isObject(params) ? params : {}
      const operation = threadLookupContext(ctx, p)
      const branchId = asOptionalString(p.conversationBranchId, 256) ?? new ThreadWorkspaceManager(operation.threadDirectory).load()?.conversationBranchId ?? 'main'
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (new ThreadActionService(operation.threadDirectory).latest(branchId)?.scope === 'conversation') {
        if (branchId !== (workspace?.conversationBranchId ?? 'main')) throw new Error('Conversation history requires the active branch.')
        const action = new ConversationActionService(operation.threadDirectory).apply(branchId, 'redo', operation.currentGeneration, undefined, (target) => {
          ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, 'redo')
          if (ctx.mms.orchestrator.isConversationHistoryBusy(operation.threadId)) throw new Error('Wait for active or queued work to finish.')
        }, (target, kind) => {
          ctx.mms.orchestrator.validateConversationActionRestore(operation.threadId, target, kind)
          if (kind === 'redo') ctx.mms.orchestrator.restoreConversationActionEnd(operation.threadId, target.presentationMessageStart, target.presentationMessageEnd, target.nativeContextBoundary)
          else ctx.mms.orchestrator.restoreConversationBoundary(operation.threadId, target.presentationMessageStart, target.nativeContextStartBoundary!)
        })
        ctx.emitEvent?.('actions.updated', { threadId: operation.threadId, action }, operation.threadId)
        return { action }
      }
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
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
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      const action = new ThreadActionService(operation.threadDirectory).get(actionId)
      if (!action) throw new Error(`Action not found: ${actionId}`)
      saveConversationState(ctx, operation.threadId, operation.threadDirectory, sourceBranchId)
      if (p.codeMode !== undefined && p.codeMode !== 'current' && p.codeMode !== 'historical') throw new Error('Invalid fork code mode')
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
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
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
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      await new ChildAgentIntegrationService(operation.threadDirectory).recoverPending(workspace.worktreePath)
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
      return { ok: true }
    }
    case 'operations.abort': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const operationId = asString(p.operationId, 'operationId', 256)
      const record = new ThreadJournal(operation.threadDirectory).latestByOperation().get(operationId)
      if (!record) throw new Error(`Operation not found: ${operationId}`)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (record.operationType !== 'publish' && !workspace) throw new Error('Thread workspace is missing')
      await new ManagedConflictService(operation.threadDirectory).abort(record.operationType === 'publish' ? operation.projectPath : workspace!.worktreePath, operationId)
      return { ok: true }
    }
    case 'publish.status': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      return { available: Boolean(workspace?.lifecycle === 'ready'), workspace, sourceSha: workspace?.lifecycle === 'ready' ? workspaceGit(workspace.worktreePath, ['rev-parse', 'HEAD']) : undefined, targetSha: workspaceGit(operation.projectPath, ['rev-parse', 'HEAD']), journalGeneration: operation.currentGeneration }
    }
    case 'publish.start': {
      const p = isObject(params) ? params : {}
      // Exact completed-operation replay is checked by PublishService before concurrency validation.
      const operation = threadOperationContext(ctx, { ...p, expectedJournalGeneration: undefined })
      const targetBranch = asString(p.targetBranch, 'targetBranch', 512)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      return await new PublishService(operation.threadDirectory).publish(workspace.worktreePath, operation.projectPath, targetBranch, undefined, { expectedSourceSha: asOptionalString(p.expectedSourceSha, 64), expectedTargetSha: asOptionalString(p.expectedTargetSha, 64), expectedJournalRevision: asOptionalBoundedInt(p.expectedJournalGeneration, 'expectedJournalGeneration', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? operation.currentGeneration, operationId: asOptionalString(p.operationId, 256) })
    }
    case 'files.list': {
      const p = isObject(params) ? params : {}
      const root = projectRootContext(ctx, p)
      return { entries: await ctx.mms.fileService.listDir(root, containedPath(root, p.path)) }
    }
    case 'files.read': {
      const p = isObject(params) ? params : {}
      const root = projectRootContext(ctx, p)
      const path = requiredContainedPath(root, p.path)
      return { path, content: await ctx.mms.fileService.readFile(root, path) }
    }
    case 'files.write': {
      const p = isObject(params) ? params : {}
      await ensureOwnedTaskWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const path = requiredContainedPath(root, p.path)
      const content = asString(p.content, 'content', 512 * 1024)
      const threadId = asOptionalString(p.threadId, 256)
      if (threadId) {
        const operation = threadOperationContext(ctx, p)
        const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
        if (workspace) {
          if (workspace.lifecycle !== 'ready') throw new Error('Task workspace requires recovery before saving.')
          const actions = new ThreadActionService(operation.threadDirectory)
          const latest = actions.latest(workspace.conversationBranchId)
          const { result: lineEdits, action } = await actions.runCheckpointedAction({
            threadId, turnId: randomUUID(), conversationBranchId: workspace.conversationBranchId,
            workspacePath: root, actor: { kind: 'user' }, expectedJournalRevision: operation.currentGeneration,
            presentationMessageStart: latest?.presentationMessageEnd ?? 0, presentationMessageEnd: latest?.presentationMessageEnd ?? 0,
            nativeContextBoundary: latest?.nativeContextBoundary ?? { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' }
          }, () => ctx.mms.fileService.writeFile(root, path, content))
          ctx.emitEvent?.('actions.updated', { threadId, action }, threadId)
          return { path, lineEdits, receiptId: action.receiptId }
        }
      }
      return { path, lineEdits: await ctx.mms.fileService.writeFile(root, path, content) }
    }
    case 'files.stat': {
      const p = isObject(params) ? params : {}
      const root = projectRootContext(ctx, p)
      return { stat: await ctx.mms.fileService.stat(root, requiredContainedPath(root, p.path)) }
    }
    case 'git.status': {
      const p = isObject(params) ? params : {}
      return { status: await ctx.mms.gitService.getStatus(projectRootContext(ctx, p)) }
    }
    case 'git.diff': {
      const p = isObject(params) ? params : {}
      const root = projectRootContext(ctx, p)
      return { diff: await ctx.mms.gitService.getDiff(root, requiredContainedPath(root, p.path), asOptionalBoolean(p.staged, 'staged') === true) }
    }
    case 'git.log': {
      const p = isObject(params) ? params : {}
      const limit = asOptionalBoundedInt(p.limit, 'limit', { min: 1, max: 100 }) ?? 30
      return { commits: await ctx.mms.gitService.getLog(projectRootContext(ctx, p), limit) }
    }
    case 'git.branches': {
      const p = isObject(params) ? params : {}
      return { branches: await ctx.mms.gitService.getBranches(projectRootContext(ctx, p)) }
    }
    case 'git.checkout': {
      const p = isObject(params) ? params : {}
      await ensureOwnedTaskWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      if (p.threadId && new ThreadWorkspaceManager(ctx.mms.threads.getThreadDir(String(p.threadId))).load()) throw new DomainRpcError('task_branch_authoritative', 'Task branches are authoritative. Use the conversation branch controls to switch task revisions.')
      await ctx.mms.gitService.checkout(root, asString(p.branch, 'branch', 512))
      return { status: await ctx.mms.gitService.getStatus(root) }
    }
    case 'git.commit': {
      const p = isObject(params) ? params : {}
      await ensureOwnedTaskWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const message = asString(p.message, 'message', 4096)
      const directory = p.threadId ? ctx.mms.threads.getThreadDir(String(p.threadId)) : undefined
      const workspace = directory ? new ThreadWorkspaceManager(directory).load() : undefined
      if (workspace && directory) {
        await new ThreadActionService(directory).runCheckpointedAction({ threadId: workspace.threadId, turnId: randomUUID(), conversationBranchId: workspace.conversationBranchId,
          workspacePath: root, actor: { kind: 'user' }, allowDirtyInput: true, presentationMessageStart: 0, presentationMessageEnd: 0,
          nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' } }, () => ctx.mms.gitService.commit(root, message))
      } else await ctx.mms.gitService.commit(root, message)
      return { status: await ctx.mms.gitService.getStatus(root) }
    }
    case 'git.push': {
      const p = isObject(params) ? params : {}
      await ensureOwnedTaskWorkspace(ctx, p)
      const root = projectRootContext(ctx, p)
      const directory = p.threadId ? ctx.mms.threads.getThreadDir(String(p.threadId)) : undefined
      const metadata = directory ? new ThreadWorkspaceManager(directory).load() : undefined
      if (metadata && directory) {
        await withGitMutationLocks(directory, root, 'user-git-push', async () => {
          const manager = new ThreadWorkspaceManager(directory)
          if (manager.verify().lifecycle !== 'ready' || manager.load()?.headSha !== metadata.headSha) throw new Error('Task revision changed before push; refresh the reviewed revision')
          if (workspaceGit(root, ['status', '--porcelain'])) throw new Error('Commit task changes before pushing')
          await ctx.mms.gitService.push(root)
        })
      } else await ctx.mms.gitService.push(root)
      return { status: await ctx.mms.gitService.getStatus(root) }
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
      })
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
      })
      const project = ctx.mms.projects.openProject(destination)
      const projects = ctx.mms.projects.listProjects()
      ctx.emitEvent?.('projects.updated', { projects })
      return { project, projects }
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
        return { lifecycles, taskNames, migrationDiagnostics, trashPolicy: ctx.mms.lifecycle.cleanup.policy(), trashSweepStatus: ctx.mms.lifecycle.cleanup.sweepStatus() }
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
      if (p.preview === true) return { preview: await ctx.mms.lifecycle.cleanup.preview(threadId) }
      const lifecycle = await ctx.mms.lifecycle.purge({ taskId: threadId, operationId: asString(p.operationId, 'operationId', 256), expectedGeneration: lifecycleExpectedGeneration(p), previewDigest: asOptionalString(p.previewDigest, 128), discard: asOptionalBoolean(p.discard, 'discard'), human: ctx.connection?.clientType === 'gui' })
      return { ok: true, lifecycle }
    }
    case 'threads.configureTrash': {
      const p = isObject(params) ? params : {}
      return { policy: ctx.mms.lifecycle.cleanup.configure({ schemaVersion: 1, graceDays: asBoundedInt(p.graceDays, 'graceDays', { min: 1, max: 3650 }), automaticPurge: asBoolean(p.automaticPurge, 'automaticPurge') }, ctx.connection?.clientType === 'gui') }
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
    case 'control.status': {
      return ctx.mms.control.getStatus()
    }
    case 'control.login': {
      return ctx.mms.control.loginDesktop()
    }
    case 'control.logout': {
      await ctx.mms.control.logout()
      return { ok: true }
    }
    case 'control.enroll': {
      const p = asControlEnrollParams(params)
      return ctx.mms.control.enrollSelfHosted(p.serverUrl, p.pairingCode)
    }
    case 'control.disconnect': {
      await ctx.mms.control.disconnect()
      return { ok: true }
    }
    case 'control.setMode': {
      const p = asControlSetModeParams(params)
      return ctx.mms.control.setMode(p.mode)
    }
    case 'pairing.create': {
      const p = asPairingCreateParams(params)
      return ctx.mms.control.createPairing(p)
    }
    case 'pairing.list': {
      return { pairings: ctx.mms.control.listPairings() }
    }
    case 'pairing.approve': {
      const p = asPairingApproveParams(params)
      return ctx.mms.control.approvePairing(p.pairingId, p.scopes)
    }
    case 'pairing.reject': {
      const p = asPairingRejectParams(params)
      return ctx.mms.control.rejectPairing(p.pairingId)
    }
    case 'pairing.revoke': {
      const p = asPairingRevokeParams(params)
      return ctx.mms.control.revokePairing(p.pairingIdOrDeviceId)
    }
    default:
      throw new Error(`Unhandled method: ${method}`)
  }
}
