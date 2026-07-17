import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { ChatImageAttachment, ChatMessage, SubagentAssignment } from '../../shared/types'
import type { Message } from '@earendil-works/pi-ai'
import type {
  LlmClient,
  StreamingLlmThinkingEvent,
  StreamingLlmToolEvent
} from '../orchestrator/LlmClient'
import { parseActions, stripActionBlocks } from '../orchestrator/LlmClient'
import { userMessage } from '../orchestrator/nativeContext'
import {
  ConnectionRetriesExhaustedError,
  retryConnectionFailures
} from '../orchestrator/connectionRetry'

export interface MousseAgentSessionCallbacks {
  spawnAgents: (specs: Array<{ cliType: string; task: string }>) => Promise<string[]>
  completeAgent: (agentId: string, merge: boolean, summary: string) => Promise<void>
}

interface SessionState {
  agentId: string
  worktreePath: string
  messages: ChatMessage[]
  history: Message[]
  running: boolean
  activeAssistantMessageId: string | null
  activeThinkingMessageId: string | null
  activeToolCallMessageIds: Map<string, string>
  assistantStreamBase: string
  assignment: Pick<SubagentAssignment, 'provider' | 'model' | 'effort'>
}

export class MousseAgentService extends EventEmitter {
  private sessions = new Map<string, SessionState>()

  constructor(
    private llm: LlmClient,
    private callbacks: MousseAgentSessionCallbacks
  ) {
    super()
  }

  start(
    agentId: string,
    task: string,
    worktreePath: string,
    assignment: Pick<SubagentAssignment, 'provider' | 'model' | 'effort'> = {}
  ): void {
    const session: SessionState = {
      agentId,
      worktreePath,
      messages: [],
      history: [],
      running: false,
      activeAssistantMessageId: null,
      activeThinkingMessageId: null,
      activeToolCallMessageIds: new Map(),
      assistantStreamBase: '',
      assignment
    }
    this.sessions.set(agentId, session)
    void this.send(agentId, task, undefined, true)
  }

  getMessages(agentId: string): ChatMessage[] {
    return [...(this.sessions.get(agentId)?.messages ?? [])]
  }

  private pushMessage(session: SessionState, message: ChatMessage): void {
    session.messages.push(message)
    this.emit('message', { agentId: session.agentId, message })
  }

  private updateMessage(session: SessionState, message: ChatMessage): void {
    const index = session.messages.findIndex((entry) => entry.id === message.id)
    if (index === -1) return
    session.messages[index] = message
    this.emit('message-updated', { agentId: session.agentId, message })
  }

  private addStreamingAssistantMessage(session: SessionState): ChatMessage {
    const msg: ChatMessage = {
      id: uuidv4(),
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      streaming: true
    }
    this.pushMessage(session, msg)
    return msg
  }

  private handleStreamingTextEvent(session: SessionState, event: { phase: string; content: string }): void {
    if (event.phase === 'start') {
      if (!session.activeAssistantMessageId) {
        const msg = this.addStreamingAssistantMessage(session)
        session.activeAssistantMessageId = msg.id
        session.assistantStreamBase = ''
      }
      return
    }

    if (!session.activeAssistantMessageId) return
    const messageId = session.activeAssistantMessageId
    const existing = session.messages.find((entry) => entry.id === messageId)
    if (!existing) return

    if (event.phase === 'delta') {
      this.updateMessage(session, {
        ...existing,
        content: session.assistantStreamBase + event.content,
        streaming: true
      })
      return
    }

    if (event.phase === 'complete') {
      const combined = session.assistantStreamBase + event.content
      session.assistantStreamBase = combined
      this.updateMessage(session, {
        ...existing,
        content: combined,
        streaming: true
      })
    }
  }

  private handleStreamingThinkingEvent(
    session: SessionState,
    event: StreamingLlmThinkingEvent
  ): void {
    if (event.phase === 'start') {
      if (session.activeAssistantMessageId) {
        const placeholder = session.messages.find(
          (entry) => entry.id === session.activeAssistantMessageId
        )
        if (placeholder?.streaming && !placeholder.content) {
          session.messages = session.messages.filter((entry) => entry.id !== placeholder.id)
          session.activeAssistantMessageId = null
          session.assistantStreamBase = ''
          this.emit('messages-sync', {
            agentId: session.agentId,
            messages: [...session.messages]
          })
        }
      }

      const message: ChatMessage = {
        id: uuidv4(),
        role: 'system',
        kind: 'thinking',
        content: '',
        timestamp: new Date().toISOString(),
        thinking: { content: '', status: 'processing' }
      }
      session.activeThinkingMessageId = message.id
      this.pushMessage(session, message)
      return
    }

    if (!session.activeThinkingMessageId) return
    const existing = session.messages.find(
      (entry) => entry.id === session.activeThinkingMessageId
    )
    if (!existing) return
    this.updateMessage(session, {
      ...existing,
      thinking: {
        content: event.content,
        status: event.phase === 'complete' ? 'complete' : 'processing'
      }
    })
    if (event.phase === 'complete') session.activeThinkingMessageId = null
  }

  private handleStreamingToolEvent(session: SessionState, event: StreamingLlmToolEvent): void {
    const kind =
      event.kind === 'build_tool_call'
        ? 'mcp_tool_call'
        : event.kind === 'build_tool_result'
          ? 'mcp_tool_result'
          : event.kind

    if (event.phase === 'complete' && event.callId) {
      const messageId = session.activeToolCallMessageIds.get(event.callId)
      const existing = messageId
        ? session.messages.find((entry) => entry.id === messageId)
        : undefined
      if (existing) {
        this.updateMessage(session, {
          ...existing,
          toolCall: {
            title: event.title,
            summary: event.summary,
            details: event.details,
            response: event.response,
            status: 'complete'
          }
        })
        session.activeToolCallMessageIds.delete(event.callId)
        return
      }
    }

    const message: ChatMessage = {
      id: uuidv4(),
      role: 'system',
      kind,
      content: '',
      timestamp: new Date().toISOString(),
      toolCall: {
        title: event.title,
        summary: event.summary,
        details: event.details,
        response: event.response,
        status: event.phase === 'start' ? 'processing' : 'complete'
      }
    }
    this.pushMessage(session, message)
    if (event.phase === 'start' && event.callId) {
      session.activeToolCallMessageIds.set(event.callId, message.id)
    }
  }

  async send(
    agentId: string,
    content: string,
    images?: ChatImageAttachment[],
    isBootstrap = false,
    reuseLastUser = false
  ): Promise<void> {
    const session = this.sessions.get(agentId)
    if (!session || session.running) return

    const trimmed = content.trim()
    const imageList = images?.filter((img) => img.data && img.mimeType) ?? []
    if (!reuseLastUser && !trimmed && imageList.length === 0) return

    session.running = true
    session.activeAssistantMessageId = null
    session.activeThinkingMessageId = null
    session.activeToolCallMessageIds.clear()
    session.assistantStreamBase = ''
    if (!reuseLastUser) {
      const userMsg: ChatMessage = {
        id: uuidv4(),
        role: 'user',
        content: trimmed || (imageList.length ? '[Image attachment]' : ''),
        timestamp: new Date().toISOString(),
        images: imageList.length ? imageList : undefined
      }
      this.pushMessage(session, userMsg)
      session.history.push(userMessage(trimmed, imageList))
    }

    try {
      // Subagent: coding tools + no spawn_agents (prevents recursive agent storms).
      const result = await retryConnectionFailures(
        () =>
          this.llm.chat(
            session.history,
            (event) => this.handleStreamingToolEvent(session, event),
            {
          mode: 'build',
          subagent: true,
          llmProvider: session.assignment.provider,
          model: session.assignment.model,
          effort: session.assignment.effort,
          projectPath: session.worktreePath
        },
            (event) => this.handleStreamingThinkingEvent(session, event),
            (event) => this.handleStreamingTextEvent(session, event)
          ),
        (attempt) =>
          this.pushMessage(session, {
            id: uuidv4(),
            role: 'system',
            content: `Retrying (${attempt}/5) ....`,
            timestamp: new Date().toISOString()
          })
      )
      const parsedActions = parseActions(result.text)
      const displayText = stripActionBlocks(result.text)
      // A stopped stream is intentionally retained as partial text, but has no completed-response metadata.
      const responseMetadata = result.aborted
        ? undefined
        : {
            modelName: result.modelName,
            totalResponseTimeMs: result.totalResponseTimeMs,
            tokensUsed: result.totalTokensUsed,
            tokensPerSecond: result.tokensPerSecond
          }
      session.history = result.nativeMessages

      if (session.activeAssistantMessageId) {
        const existing = session.messages.find((entry) => entry.id === session.activeAssistantMessageId)
        if (existing) {
          this.updateMessage(session, {
            ...existing,
            content: displayText || 'Done.',
            streaming: false,
            ...(responseMetadata ? { responseMetadata } : { incomplete: true })
          })
        }
        session.activeAssistantMessageId = null
        session.assistantStreamBase = ''
      } else {
        const assistantMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: displayText || 'Done.',
          timestamp: new Date().toISOString(),
          ...(responseMetadata ? { responseMetadata } : { incomplete: true })
        }
        this.pushMessage(session, assistantMsg)
      }

      for (const action of parsedActions) {
        if (action.type === 'spawn_agents') {
          // Subagents must never spawn — that caused endless recursive agents.
          const note: ChatMessage = {
            id: uuidv4(),
            role: 'system',
            content:
              '[mousse] Ignored spawn_agents from subagent. This agent implements work directly and cannot spawn further agents.',
            timestamp: new Date().toISOString()
          }
          this.pushMessage(session, note)
          continue
        }
        if (action.type === 'complete_task') {
          const summary = displayText || 'Task completed.'
          await this.callbacks.completeAgent(agentId, action.merge !== false, summary)
          this.sessions.delete(agentId)
          this.emit('complete', { agentId, summary })
          return
        }
      }
    } catch (err) {
      if (err instanceof ConnectionRetriesExhaustedError) {
        this.emit('connection-failed', { agentId })
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      if (session.activeAssistantMessageId) {
        const existing = session.messages.find((entry) => entry.id === session.activeAssistantMessageId)
        if (existing) {
          this.updateMessage(session, {
            ...existing,
            content: `Error: ${message}`,
            streaming: false
          })
        }
        session.activeAssistantMessageId = null
      } else {
        const errorMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: `Error: ${message}`,
          timestamp: new Date().toISOString()
        }
        this.pushMessage(session, errorMsg)
      }
    } finally {
      const current = this.sessions.get(agentId)
      if (current) {
        current.running = false
        if (current.activeThinkingMessageId) {
          const thinking = current.messages.find(
            (message) => message.id === current.activeThinkingMessageId
          )
          if (thinking?.thinking?.status === 'processing') {
            this.updateMessage(current, {
              ...thinking,
              thinking: { ...thinking.thinking, status: 'complete' }
            })
          }
          current.activeThinkingMessageId = null
        }
        current.activeToolCallMessageIds.clear()
      }
      if (!isBootstrap) {
        this.emit('idle', { agentId })
      }
    }
  }

  retry(agentId: string): void {
    void this.send(agentId, '', undefined, false, true)
  }

  remove(agentId: string): void {
    this.sessions.delete(agentId)
  }
}
