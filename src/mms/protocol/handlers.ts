/**
 * Method handlers against daemon-owned MousseMainService.
 * All nested mutable payloads are validated before service calls.
 */

import type { MousseMainService } from '../MousseMainService'
import type { OrchestratorSendInput, OrchestratorSendRequest } from '../../shared/types'
import { listClaimedQueue } from '../queue/ThreadMessageQueue'
import { getPiLlmProviders } from '../orchestrator/piProviders'
import {
  ACCENT_COLORS,
  AGENT_TYPES,
  THEME_OPTIONS,
  buildOpencodeAgentModels,
  type MousseSettingsUpdate
} from '../../shared/settings'
import {
  asAfterSequence,
  asAnswersMap,
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
  isObject
} from './validators'
import { PROTOCOL_CAPABILITIES, PROTOCOL_METHODS, MMS_PROTOCOL_VERSION } from './types'
import { resolveThreadProjectPath } from '../data/resolveActiveProjectPath'
import { ThreadGenerationStore } from '../data/ThreadGenerationStore'
import { ThreadJournal } from '../data/ThreadJournal'
import { ThreadWorkspaceManager } from '../workspace/ThreadWorkspaceManager'
import { ThreadActionService } from '../actions/ThreadActionService'
import { UndoService } from '../actions/UndoService'
import { RedoService } from '../actions/RedoService'
import { CodeRevertService } from '../actions/CodeRevertService'
import { ConversationBranchService } from '../actions/ConversationBranchService'
import { PublishService } from '../actions/PublishService'

export interface HandlerContext {
  mms: MousseMainService
  /** Fenced owner token from protocol server (never from untrusted params). */
  ownerToken?: string
  globalSequence: () => number
  /** Optional: push a protocol event while a handler is running (e.g. auth prompts). */
  emitEvent?: (type: string, data: unknown, threadId?: string) => void
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

function threadOperationContext(ctx: HandlerContext, params: Record<string, unknown>) {
  const threadId = asString(params.threadId, 'threadId', 256)
  const thread = ctx.mms.threads.getThread(threadId)
  if (!thread) throw new Error(`Thread not found: ${threadId}`)
  const threadDirectory = ctx.mms.threads.getThreadDir(threadId)
  const projectPath = resolveThreadProjectPath(ctx.mms.projects, ctx.mms.threads, threadId)
  if (!projectPath) throw new Error(`Thread has no project workspace: ${threadId}`)
  const expectedGeneration = asOptionalBoundedInt(params.expectedJournalGeneration, 'expectedJournalGeneration', { min: 0, max: Number.MAX_SAFE_INTEGER })
  const currentGeneration = new ThreadGenerationStore(threadDirectory).getManifest()?.journalSequence ?? 0
  if (expectedGeneration !== undefined && expectedGeneration !== currentGeneration) {
    throw new Error(`STALE_JOURNAL_GENERATION:${currentGeneration}`)
  }
  return { threadId, thread, threadDirectory, projectPath, currentGeneration }
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

export async function dispatchMethod(
  ctx: HandlerContext,
  method: string,
  params: unknown
): Promise<unknown> {
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
        capabilities: [...PROTOCOL_CAPABILITIES],
        methods: [...PROTOCOL_METHODS]
      }
    case 'projects.list':
      return { projects: ctx.mms.projects.listProjects() }
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
      if (!thread) throw new Error(`Thread not found: ${threadId}`)
      return { thread }
    }
    case 'threads.create': {
      const p = isObject(params) ? params : {}
      const name = asString(p.name, 'name', 512)
      const projectId = asOptionalString(p.projectId, 256)
      const projectPath = projectId
        ? ctx.mms.projects.getProject(projectId)?.path
        : undefined
      const thread = ctx.mms.threads.createThread(name, projectId, projectPath)
      const threads = ctx.mms.threads.listAllThreads()
      return { thread, threads }
    }
    case 'threads.delete': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      // Daemon-authoritative fence: refuse while turn/agent/PTY/question work is live.
      ctx.mms.threadRuntimes.assertDeletable(threadId)
      ctx.mms.orchestrator.markThreadDeleted(threadId)
      ctx.mms.threadRuntimes.disposeRuntime(threadId)
      ctx.mms.threads.deleteThread(threadId)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { threads }
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
      if (!thread) throw new Error(`Thread not found: ${threadId}`)
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
        revision: ctx.globalSequence()
      }
    }
    case 'threads.regenerateTitle': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const messages = ctx.mms.orchestrator.getMessages(threadId)
      const title = await ctx.mms.orchestrator.generateThreadTitle(messages)
      if (!title) throw new Error('The title model returned an empty title.')
      const thread = ctx.mms.threads.updateThreadMeta(threadId, { name: title })
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, threads }
    }
    case 'threads.setModel': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new Error(`Thread not found: ${threadId}`)
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
      const thread = ctx.mms.threads.getThread(threadId)
      const threads = ctx.mms.threads.listAllThreads()
      ctx.emitEvent?.('threads.updated', { threads })
      return { thread, modelOverride: next, threads }
    }
    case 'orchestrator.send': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const content = asString(p.content, 'content')
      const forceQueue = asOptionalBoolean(p.forceQueue, 'forceQueue') === true
      const source = asOptionalString(p.source, 64) ?? 'protocol'
      const mode = asOptionalChatMode(p.mode, 'mode')
      const images = asOptionalChatImages(p.images, 'images')
      if (!ctx.mms.threads.getThread(threadId)) {
        throw new Error(`Thread not found: ${threadId}`)
      }
      ctx.mms.orchestrator.getOrCreateSession(threadId)
      const input = buildSendInput(content, mode, images)
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
        source: asOptionalString(p.source, 64) ?? 'protocol-steer'
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
        throw new Error(`Thread not found: ${threadId}`)
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
      const source = asOptionalString(p.source, 64) ?? 'protocol'
      const item = ctx.mms.orchestrator.enqueueForThread(
        threadId,
        buildSendInput(content, mode, images),
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
      return { removed }
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
      const ok = ctx.mms.questions.submitAnswers(requestId, answers)
      return { ok }
    }
    case 'orchestrator.dismissQuestions': {
      const p = isObject(params) ? params : {}
      const requestId = asString(p.requestId, 'requestId', 256)
      const ok = ctx.mms.questions.dismiss(requestId)
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
    case 'agents.spawn': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      if (!ctx.mms.threads.getThread(threadId)) throw new Error(`Thread not found: ${threadId}`)
      const assignment = asAgentAssignment(p)
      const logs = await ctx.mms.orchestrator.spawnAgentsForThread(threadId, [assignment])
      return { threadId, logs }
    }
    case 'agents.stop': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      const agentId = asString(p.agentId, 'agentId', 256)
      const merge = asOptionalBoolean(p.merge, 'merge') === true
      if (!ctx.mms.threads.getThread(threadId)) throw new Error(`Thread not found: ${threadId}`)
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
    case 'agents.stop': {
      const p = isObject(params) ? params : {}
      const agentId = asString(p.agentId, 'agentId', 256)
      const logs = await ctx.mms.orchestrator.stopAgent(agentId, false)
      return { agentId, logs }
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
      const cwd = asOptionalString(p.cwd, 4096) ?? process.cwd()
      const command = asOptionalString(p.command, 4096)
      const env = asOptionalStringEnvMap(p.env, 'env')
      const shellArgs =
        p.shellArgs === undefined
          ? undefined
          : asStringArray(p.shellArgs, 'shellArgs', { maxItems: 32, maxItemLen: 1024 })
      const ptyId = ctx.mms.ptyManager.create(agentId, cwd, command, {
        threadId,
        env,
        shellArgs
      })
      ctx.mms.threadRuntimes.registerPty(threadId, ptyId)
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
      ctx.mms.ptyManager.kill(ptyId)
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
      const snapshot = await ctx.mms.skillsRegistry.discover({
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
      const llmProviders = getPiLlmProviders(ctx.mms.providerAuth)
      const opencodeModels =
        llmProviders.find((provider) => provider.id === 'opencode')?.models ?? []
      const opencodeGoModels =
        llmProviders.find((provider) => provider.id === 'opencode-go')?.models ?? []
      const opencodeAgentModels = buildOpencodeAgentModels(opencodeModels, opencodeGoModels)
      const agentTypes = AGENT_TYPES.map((agent) =>
        agent.id === 'opencode' ? { ...agent, models: opencodeAgentModels } : agent
      )
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
      return { providers: ctx.mms.providerAuth.getConfiguredProviders() }
    case 'providers.getUsage':
      return ctx.mms.providerAuth.getUsage()
    case 'providers.getLoginOptions': {
      const p = isObject(params) ? params : {}
      const authType = asOptionalString(p.authType, 32) as 'api_key' | 'oauth' | undefined
      return { options: ctx.mms.providerAuth.getLoginOptions(authType) }
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
      const providers = ctx.mms.providerAuth.getConfiguredProviders()
      ctx.emitEvent?.('providers.changed', { providers })
      return { providers }
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
      await ctx.mms.providerAuth.logout(providerId)
      const providers = ctx.mms.providerAuth.getConfiguredProviders()
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
        const result = await ctx.mms.providerAuth.runOAuthLogin(session, providerId)
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
      const operation = threadOperationContext(ctx, p)
      const manager = new ThreadWorkspaceManager(operation.threadDirectory)
      const metadata = manager.load()
      return {
        metadata: metadata ? manager.verify(metadata) : undefined,
        execution: manager.executionContext(operation.projectPath),
        journalGeneration: operation.currentGeneration
      }
    }
    case 'workspace.restore': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const branchId = asOptionalString(p.conversationBranchId, 256) ?? 'main'
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
      const operation = threadOperationContext(ctx, p)
      return { actions: new ThreadActionService(operation.threadDirectory).list(), journalGeneration: operation.currentGeneration }
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
      const operation = threadOperationContext(ctx, p)
      const branchId = asOptionalString(p.conversationBranchId, 256) ?? 'main'
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      const action = await new UndoService(operation.threadDirectory).undoLatest(branchId, workspace.worktreePath)
      ctx.emitEvent?.('actions.updated', { threadId: operation.threadId, action }, operation.threadId)
      return { action }
    }
    case 'actions.revertCode': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const actionId = asString(p.actionId, 'actionId', 256)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      return { action: await new CodeRevertService(operation.threadDirectory).revertCode(actionId, workspace.worktreePath) }
    }
    case 'actions.redo': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const branchId = asOptionalString(p.conversationBranchId, 256) ?? 'main'
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      return { action: await new RedoService(operation.threadDirectory).redoLatest(branchId, workspace.worktreePath) }
    }
    case 'actions.fork': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const sourceBranchId = asOptionalString(p.conversationBranchId, 256) ?? 'main'
      const actionId = asString(p.actionId, 'actionId', 256)
      const name = asOptionalString(p.name, 256) ?? 'Alternate'
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      return { branch: await new ConversationBranchService(operation.threadDirectory).fork(workspace.worktreePath, sourceBranchId, actionId, name) }
    }
    case 'actions.activateBranch': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const branchId = asString(p.conversationBranchId, 'conversationBranchId', 256)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      return { branch: await new ConversationBranchService(operation.threadDirectory).activate(workspace.worktreePath, branchId) }
    }
    case 'operations.get': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const operationId = asString(p.operationId, 'operationId', 256)
      return { operation: new ThreadJournal(operation.threadDirectory).latestByOperation().get(operationId) }
    }
    case 'operations.abort': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const operationId = asString(p.operationId, 'operationId', 256)
      const record = new ThreadJournal(operation.threadDirectory).latestByOperation().get(operationId)
      if (!record) throw new Error(`Operation not found: ${operationId}`)
      if (record.operationType === 'publish') await new PublishService(operation.threadDirectory).abortConflict(operation.projectPath, operationId)
      else if (record.operationType === 'undo') {
        const branchId = asOptionalString(p.conversationBranchId, 256) ?? 'main'
        const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
        if (!workspace) throw new Error('Thread workspace is missing')
        await new UndoService(operation.threadDirectory).abortConflict(branchId, workspace.worktreePath)
      } else throw new Error(`Abort is unavailable for ${record.operationType}`)
      return { ok: true }
    }
    case 'publish.status': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      return { available: Boolean(workspace?.lifecycle === 'ready'), workspace, journalGeneration: operation.currentGeneration }
    }
    case 'publish.start': {
      const p = isObject(params) ? params : {}
      const operation = threadOperationContext(ctx, p)
      const targetBranch = asString(p.targetBranch, 'targetBranch', 512)
      const workspace = new ThreadWorkspaceManager(operation.threadDirectory).load()
      if (!workspace || workspace.lifecycle !== 'ready') throw new Error('Thread workspace is not ready')
      return await new PublishService(operation.threadDirectory).publish(workspace.worktreePath, operation.projectPath, targetBranch)
    }
    case 'threads.trash': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      ctx.mms.threads.deleteThread(threadId)
      return { ok: true }
    }
    case 'threads.restore': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      return { thread: ctx.mms.threads.restoreThreadFromTrash(threadId) }
    }
    case 'threads.purge': {
      const p = isObject(params) ? params : {}
      const threadId = asString(p.threadId, 'threadId', 256)
      ctx.mms.threads.purgeThreadFromTrash(threadId)
      return { ok: true }
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
    default:
      throw new Error(`Unhandled method: ${method}`)
  }
}
