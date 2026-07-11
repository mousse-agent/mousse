import { useCallback, useEffect, useState } from 'react'
import { ArrowUp, Loader2 } from 'lucide-react'
import type { ChatMessage } from '../../shared/types'
import { ChatMessageContent } from './ChatMessageContent'
import { PreThinkingBlock } from './PreThinkingBlock'

interface MousseAgentChatProps {
  agentId: string
}

export function MousseAgentChat({ agentId }: MousseAgentChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)

  const refreshMessages = useCallback(async () => {
    const next = await window.mousse.mousseAgent.getMessages(agentId)
    setMessages(next)
  }, [agentId])

  useEffect(() => {
    void refreshMessages()
    const unsubMessage = window.mousse.mousseAgent.onMessage(({ agentId: id, message }) => {
      if (id !== agentId) return
      setMessages((current) => [...current, message])
    })
    const unsubUpdated = window.mousse.mousseAgent.onMessageUpdated(({ agentId: id, message }) => {
      if (id !== agentId) return
      setMessages((current) => current.map((entry) => (entry.id === message.id ? message : entry)))
    })
    const unsubSync = window.mousse.mousseAgent.onMessagesSync(({ agentId: id, messages: next }) => {
      if (id !== agentId) return
      setMessages(next)
    })
    const unsubComplete = window.mousse.mousseAgent.onComplete(({ agentId: id }) => {
      if (id !== agentId) return
      void refreshMessages()
      setLoading(false)
    })
    return () => {
      unsubMessage()
      unsubUpdated()
      unsubSync()
      unsubComplete()
    }
  }, [agentId, refreshMessages])

  const hasActiveThinking = messages.some(
    (message) => message.kind === 'thinking' && message.thinking?.status === 'processing'
  )
  const hasStreamingAssistant = messages.some(
    (message) => message.role === 'assistant' && message.streaming
  )
  const showPreThinking = loading && !hasActiveThinking && !hasStreamingAssistant

  const handleSend = async () => {
    const trimmed = input.trim()
    if (!trimmed || loading) return
    setInput('')
    setLoading(true)
    await window.mousse.mousseAgent.send(agentId, trimmed)
    setLoading(false)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void handleSend()
    }
  }

  return (
    <div className="mousse-agent-chat">
      <div className="mousse-agent-messages scrollbar-ultra-thin">
        {messages.length === 0 && !showPreThinking ? (
          <div className="mousse-agent-empty">Starting agent…</div>
        ) : (
          messages.map((message) => (
            <ChatMessageContent
              key={message.id}
              role={message.role}
              content={message.content}
              kind={message.kind}
              planCard={message.planCard}
              toolCall={message.toolCall}
              thinking={message.thinking}
              streaming={message.streaming}
            />
          ))
        )}
        {showPreThinking && (
          <div className="message message-system message-thinking message-pre-thinking">
            <PreThinkingBlock />
          </div>
        )}
      </div>
      <div className="mousse-agent-composer">
        <textarea
          className="mousse-agent-input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message to this agent…"
          rows={2}
          disabled={loading}
        />
        <button
          type="button"
          className="mousse-agent-send"
          onClick={() => void handleSend()}
          disabled={!input.trim() || loading}
          aria-label="Send message"
        >
          {loading ? <Loader2 size={16} className="spin" /> : <ArrowUp size={16} />}
        </button>
      </div>
    </div>
  )
}
