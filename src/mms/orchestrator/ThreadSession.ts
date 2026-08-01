import type { ChatMessage, NativeLlmContext, QueuedMessage } from '../../shared/types'
import { createNativeContext } from './nativeContext'

export interface ActiveTurnControl {
  abort: AbortController
  pendingSteer: string[]
}

/** Mutable per-thread execution state owned by MMS. */
export class ThreadSession {
  readonly threadId: string
  messages: ChatMessage[] = []
  nativeContext: NativeLlmContext = createNativeContext()
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

  constructor(threadId: string) {
    this.threadId = threadId
  }

  isTurnActive(): boolean {
    return this.activeTurn !== null && !this.activeTurn.abort.signal.aborted
  }

  isTurnRunning(): boolean {
    return this.activeTurn !== null
  }

  load(messages: ChatMessage[], nativeContext?: NativeLlmContext, queue?: QueuedMessage[]): void {
    this.messages = [...messages]
    this.nativeContext = nativeContext
      ? structuredClone(nativeContext)
      : createNativeContext()
    this.queue = queue ? structuredClone(queue) : []
    this.lastMeasuredInput = null
    this.lastMeasuredCacheRead = null
    this.lastMeasuredCacheWrite = null
    this.lastMeasuredContextSignature = null
    this.measuredAtHistoryLength = 0
    this.activeToolCallMessageIds.clear()
    this.activeThinkingMessageId = null
    this.activeAssistantMessageId = null
    this.lastCompletedAssistantMessageId = null
    this.lastCompletedAssistantContent = ''
    this.failedConnectionRequest = null
  }
}
