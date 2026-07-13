import { EventEmitter } from 'events'
import { v4 as uuidv4 } from 'uuid'
import type { ChatImageAttachment, ChatMessage } from '../../shared/types'
import type { LlmClient, LlmMessage } from '../orchestrator/LlmClient'
import { parseActions, stripActionBlocks } from '../orchestrator/LlmClient'

export interface MousseAgentSessionCallbacks {
  spawnAgents: (specs: Array<{ cliType: string; task: string }>) => Promise<string[]>
  completeAgent: (agentId: string, merge: boolean, summary: string) => Promise<void>
}

interface SessionState {
  agentId: string
  worktreePath: string
  messages: ChatMessage[]
  history: LlmMessage[]
  running: boolean
  activeAssistantMessageId: string | null
  assistantStreamBase: string
}

export class MousseAgentService extends EventEmitter {
  private sessions = new Map<string, SessionState>()

  constructor(
    private llm: LlmClient,
    private callbacks: MousseAgentSessionCallbacks
  ) {
    super()
  }

  start(agentId: string, task: string, worktreePath: string): void {
    const session: SessionState = {
      agentId,
      worktreePath,
      messages: [],
      history: [],
      running: false,
      activeAssistantMessageId: null,
      assistantStreamBase: ''
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
    event: { phase: string; content: string }
  ): void {
    if (event.phase !== 'start') return
    if (!session.activeAssistantMessageId) return
    const messageId = session.activeAssistantMessageId
    session.messages = session.messages.filter((entry) => entry.id !== messageId)
    session.activeAssistantMessageId = null
    session.assistantStreamBase = ''
    this.emit('messages-sync', { agentId: session.agentId, messages: [...session.messages] })
  }

  async send(
    agentId: string,
    content: string,
    images?: ChatImageAttachment[],
    isBootstrap = false
  ): Promise<void> {
    const session = this.sessions.get(agentId)
    if (!session || session.running) return

    const trimmed = content.trim()
    const imageList = images?.filter((img) => img.data && img.mimeType) ?? []
    if (!trimmed && imageList.length === 0) return

    session.running = true
    session.activeAssistantMessageId = null
    session.assistantStreamBase = ''
    const userMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: trimmed || (imageList.length ? '[Image attachment]' : ''),
      timestamp: new Date().toISOString(),
      images: imageList.length ? imageList : undefined
    }
    this.pushMessage(session, userMsg)
    session.history.push({
      role: 'user',
      content: trimmed || '(image attachment)',
      images: imageList.map((img) => ({
        mimeType: img.mimeType,
        data: img.data,
        name: img.name
      }))
    })

    try {
      // Subagent: coding tools + no spawn_agents (prevents recursive agent storms).
      const result = await this.llm.chat(
        session.history,
        undefined,
        { mode: 'build', subagent: true },
        (event) => this.handleStreamingThinkingEvent(session, event),
        (event) => this.handleStreamingTextEvent(session, event)
      )
      const parsedActions = parseActions(result.text)
      const displayText = stripActionBlocks(result.text)
      session.history.push({ role: 'assistant', content: result.text })

      if (session.activeAssistantMessageId) {
        const existing = session.messages.find((entry) => entry.id === session.activeAssistantMessageId)
        if (existing) {
          this.updateMessage(session, {
            ...existing,
            content: displayText || 'Done.',
            streaming: false
          })
        }
        session.activeAssistantMessageId = null
        session.assistantStreamBase = ''
      } else {
        const assistantMsg: ChatMessage = {
          id: uuidv4(),
          role: 'assistant',
          content: displayText || 'Done.',
          timestamp: new Date().toISOString()
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
      if (current) current.running = false
      if (!isBootstrap) {
        this.emit('idle', { agentId })
      }
    }
  }

  remove(agentId: string): void {
    this.sessions.delete(agentId)
  }
}
