import type {
  Agent,
  ChatMessage,
  NativeLlmContext,
  QueuedMessage,
  Task,
  Thread
} from '../../shared/types'
import type { ThreadLeaseHandle } from '../queue/ThreadExecutionLease'
import { AgentRegistry } from '../agents/AgentRegistry'
import { TaskQueue } from '../tasks/TaskQueue'
import { createNativeContext, isNativeLastTurnUsage } from './nativeContext'

export interface ActiveTurnControl {
  abort: AbortController
  pendingSteer: string[]
  promotedSteerIds: string[]
}

/** Mutable per-thread execution state owned by MMS. */
export class ThreadSession {
  readonly threadId: string
  messages: ChatMessage[] = []
  nativeContext: NativeLlmContext = createNativeContext()
  /** Per-thread model selection; absent means use global settings. */
  modelOverride: Thread['modelOverride'] | undefined
  activeTurn: ActiveTurnControl | null = null
  activeToolCallMessageIds = new Map<string, string>()
  activeThinkingMessageId: string | null = null
  activeAssistantMessageId: string | null = null
  lastCompletedAssistantMessageId: string | null = null
  lastCompletedAssistantContent = ''
  lastMeasuredInput: number | null = null
  lastMeasuredCacheRead: number | null = null
  lastMeasuredCacheWrite: number | null = null
  lastMeasuredContextSignature: string | null = null
  measuredAtHistoryLength = 0
  failedConnectionRequest: import('../../shared/types').OrchestratorSendInput | null = null
  queue: QueuedMessage[] = []
  /** When true, no further turns/drain may execute for this thread. */
  deleted = false
  /** Project cwd for this thread (resolved path; never process.chdir). */
  projectCwd: string | null = null
  /** Cross-process execution lease held while a main-thread turn runs. */
  executionLease: ThreadLeaseHandle | null = null
  /** Steer item ids already injected this turn (one-time drain). */
  drainedExternalSteerIds = new Set<string>()
  /**
   * Per-thread agent/task registries (Phase 4 multi-tenant).
   * Selection must never swap these between threads.
   */
  agents: AgentRegistry = new AgentRegistry()
  tasks: TaskQueue = new TaskQueue()

  constructor(threadId: string) {
    this.threadId = threadId
  }

  isTurnActive(): boolean {
    return this.activeTurn !== null && !this.activeTurn.abort.signal.aborted
  }

  isTurnRunning(): boolean {
    return this.activeTurn !== null
  }

  load(
    messages: ChatMessage[],
    nativeContext?: NativeLlmContext,
    queue?: QueuedMessage[],
    agents?: Agent[],
    tasks?: Task[],
    modelOverride?: Thread['modelOverride']
  ): void {
    this.messages = [...messages]
    this.modelOverride = modelOverride ? structuredClone(modelOverride) : undefined
    this.nativeContext = nativeContext
      ? structuredClone(nativeContext)
      : createNativeContext()
    this.queue = queue ? structuredClone(queue) : []
    if (agents) this.agents.load(agents)
    if (tasks) this.tasks.load(tasks)
    const lastTurnUsage = isNativeLastTurnUsage(this.nativeContext.lastTurnUsage)
      ? this.nativeContext.lastTurnUsage
      : undefined
    this.lastMeasuredInput = lastTurnUsage?.input ?? null
    this.lastMeasuredCacheRead = lastTurnUsage?.cacheRead ?? null
    this.lastMeasuredCacheWrite = lastTurnUsage?.cacheWrite ?? null
    this.lastMeasuredContextSignature = lastTurnUsage?.signature ?? null
    this.measuredAtHistoryLength = lastTurnUsage?.measuredAtHistoryLength ?? 0
    if (!lastTurnUsage && this.nativeContext.lastTurnUsage) {
      delete this.nativeContext.lastTurnUsage
    }
    this.activeToolCallMessageIds.clear()
    this.activeThinkingMessageId = null
    this.activeAssistantMessageId = null
    this.lastCompletedAssistantMessageId = null
    this.lastCompletedAssistantContent = ''
    this.failedConnectionRequest = null
  }
}
