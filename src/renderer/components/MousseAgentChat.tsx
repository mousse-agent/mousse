import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatMessage, ContextUsageSnapshot } from '../../shared/types'
import type { LlmProviderOption } from '../../shared/settings'
import type { SkillDescriptor } from '../../shared/integrations'
import { useAppStore } from '../stores/appStore'
import { ChatMessageContent } from './ChatMessageContent'
import { PreThinkingBlock } from './PreThinkingBlock'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { filesToImagePayloads } from '../utils/imageAttachments'
import { formatWorkedFor, getFinalResponseLayout } from '../utils/responseTimeline'
import { formatMessageTime, formatMessageTimeTitle } from '../utils/formatMessageTime'
import { groupChatTimeline, type ChatTimelineGroup } from '../utils/toolTimelineGroups'
import { isToolTimelineMessage } from '../../shared/types'

const EMPTY_CONTEXT_USAGE: ContextUsageSnapshot = {
  percent: 0,
  used: 0,
  limit: 128_000,
  modelName: null,
  source: 'estimated',
  categories: []
}

interface MousseAgentChatProps {
  agentId: string
  active?: boolean
}

/**
 * IPC history reads are snapshots and can arrive after a newer message event.
 * Keep stable timeline entries already rendered by this tab when reconciling
 * such a snapshot. The backend only removes a superseded streaming placeholder.
 */
export function reconcileAgentMessages(
  current: ChatMessage[],
  incoming: ChatMessage[]
): ChatMessage[] {
  const incomingById = new Map(incoming.map((message) => [message.id, message]))
  const currentIds = new Set(current.map((message) => message.id))

  return [
    ...current
      .filter((message) => incomingById.has(message.id) || !message.streaming)
      .map((message) => incomingById.get(message.id) ?? message),
    ...incoming.filter((message) => !currentIds.has(message.id))
  ]
}

export function upsertAgentMessage(current: ChatMessage[], message: ChatMessage): ChatMessage[] {
  const index = current.findIndex((entry) => entry.id === message.id)
  if (index === -1) return [...current, message]
  return current.map((entry) => (entry.id === message.id ? message : entry))
}

export function isAgentAwaitingResponse(messages: ChatMessage[]): boolean {
  let lastUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      lastUserIndex = index
      break
    }
  }
  if (lastUserIndex < 0) return false
  return !messages.slice(lastUserIndex + 1).some(
    (message) =>
      message.role === 'assistant' &&
      !isToolTimelineMessage(message) &&
      !message.streaming
  )
}

export function MousseAgentChat({ agentId, active = true }: MousseAgentChatProps) {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const chatMode = useAppStore((s) => s.chatMode)
  const setChatMode = useAppStore((s) => s.setChatMode)

  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [voiceMessages, setVoiceMessages] = useState<VoiceMessage[]>([])
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [enabledSkills, setEnabledSkills] = useState<SkillDescriptor[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot>(EMPTY_CONTEXT_USAGE)
  const [connectionFailed, setConnectionFailed] = useState(false)
  const messagesRef = useRef<HTMLDivElement>(null)

  const refreshMessages = useCallback(async () => {
    const next = await window.mousse.mousseAgent.getMessages(agentId)
    setMessages((current) => reconcileAgentMessages(current, next))
  }, [agentId])

  const refreshSelection = useCallback(async () => {
    const [settings, options, skillsSnapshot] = await Promise.all([
      window.mousse.settings.get(),
      window.mousse.settings.getOptions(),
      window.mousse.skills.list()
    ])
    setProviders(options.llmProviders)
    setSelectedProviderId(settings.provider.llmProvider)
    setSelectedModelId(settings.provider.model)
    const enabled = new Set(settings.integrations.skills.enabledSkills)
    setEnabledSkills(
      skillsSnapshot.skills.filter(
        (skill) =>
          skill.isActive !== false &&
          (enabled.size === 0 || enabled.has(skill.id) || enabled.has(skill.name))
      )
    )
  }, [])

  useEffect(() => {
    let active = true
    void refreshMessages()
    const unsubMessage = window.mousse.mousseAgent.onMessage(({ agentId: id, message }) => {
      if (id !== agentId) return
      setMessages((current) => upsertAgentMessage(current, message))
    })
    const unsubUpdated = window.mousse.mousseAgent.onMessageUpdated(({ agentId: id, message }) => {
      if (id !== agentId) return
      setMessages((current) => upsertAgentMessage(current, message))
    })
    const unsubSync = window.mousse.mousseAgent.onMessagesSync(({ agentId: id, messages: next }) => {
      if (id !== agentId) return
      setMessages((current) => reconcileAgentMessages(current, next))
    })
    const unsubConnection = window.mousse.mousseAgent.onConnectionFailed(({ agentId: id }) => {
      if (id !== agentId) return
      setLoading(false)
      setConnectionFailed(true)
    })
    const unsubComplete = window.mousse.mousseAgent.onComplete(({ agentId: id }) => {
      if (id !== agentId) return
      if (active) void refreshMessages()
      setLoading(false)
    })
    return () => {
      active = false
      unsubMessage()
      unsubUpdated()
      unsubSync()
      unsubConnection()
      unsubComplete()
    }
  }, [agentId, refreshMessages])

  useEffect(() => {
    void refreshSelection()
    const unsubSettings = window.mousse.settings.onChanged(() => {
      void refreshSelection()
    })
    const unsubProviders = window.mousse.providers.onChanged(() => {
      void refreshSelection()
    })
    return () => {
      unsubSettings()
      unsubProviders()
    }
  }, [refreshSelection])

  useEffect(() => {
    if (!active) return
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth'
    })
  }, [active, messages])

  useEffect(() => {
    return () => {
      attachedFiles.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
  }, [])

  const hasActiveThinking = messages.some(
    (message) => message.kind === 'thinking' && message.thinking?.status === 'processing'
  )
  const hasStreamingAssistant = messages.some(
    (message) => message.role === 'assistant' && message.streaming
  )
  const awaitingResponse = loading || isAgentAwaitingResponse(messages)
  const showPreThinking = active && awaitingResponse && !hasActiveThinking && !hasStreamingAssistant
  const timelineGroups = groupChatTimeline(messages)
  const finalResponseLayout = getFinalResponseLayout(messages)
  const workGroups = timelineGroups.filter((group) => {
    const entries = group.type === 'tool-group' ? group.messages : [group.message]
    return entries.every((message) => finalResponseLayout.workMessageIds.has(message.id))
  })
  const firstWorkId = workGroups.length > 0
    ? (workGroups[0].type === 'tool-group' ? workGroups[0].messages[0].id : workGroups[0].message.id)
    : null

  const handleSend = async () => {
    const text = buildComposerMessageContent(input, attachedFiles, voiceMessages)
    const images = await filesToImagePayloads(attachedFiles.map((f) => f.file))
    if ((!text && images.length === 0) || loading) return

    setConnectionFailed(false)
    setInput('')
    attachedFiles.forEach((f) => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
    })
    setAttachedFiles([])
    voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
    setVoiceMessages([])
    setLoading(true)
    try {
      await window.mousse.mousseAgent.send(agentId, text || '[Image attachment]', images)
    } finally {
      setLoading(false)
    }
  }

  const handleModelSelect = async (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    await window.mousse.settings.set({
      provider: { llmProvider: providerId, model: modelId }
    })
  }

  const renderTimelineGroup = (group: ChatTimelineGroup, inWork = false) => {
    if (group.type === 'tool-group' && group.messages.length > 1) {
      const first = group.messages[0]
      return (
        <div key={first.id} className="message message-system message-tool-call">
          <ChatMessageContent
            role="system"
            content=""
            toolCalls={group.messages.flatMap((message) =>
              message.toolCall ? [message.toolCall] : []
            )}
          />
          <div className="message-time" title={formatMessageTimeTitle(first.timestamp)}>
            {formatMessageTime(first.timestamp)}
          </div>
        </div>
      )
    }

    const message = group.type === 'tool-group' ? group.messages[0] : group.message
    return (
      <div
        key={message.id}
        className={`message message-${message.role}${
          isToolTimelineMessage(message) ? ' message-tool-call' : ''
        }${message.kind === 'plan_card' ? ' message-plan-card' : ''}`}
      >
        <ChatMessageContent
          role={message.role}
          content={message.content}
          kind={message.kind}
          planCard={message.planCard}
          toolCall={message.toolCall}
          thinking={message.thinking}
          streaming={message.streaming}
          images={message.images}
          responseMetadata={message.responseMetadata}
          incomplete={message.incomplete}
          showResponseActions={!inWork && message.id === finalResponseLayout.finalResponseId}
        />
        {message.kind !== 'plan_card' && (
          <div className="message-time" title={formatMessageTimeTitle(message.timestamp)}>
            {formatMessageTime(message.timestamp)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={`mousse-agent-chat chat${active ? '' : ' hidden'}`} aria-hidden={!active}>
      <div
        className="mousse-agent-messages chat-messages scrollbar-ultra-thin"
        ref={messagesRef}
      >
        {messages.length === 0 && !showPreThinking ? (
          <div className="mousse-agent-empty">Starting agent…</div>
        ) : (
          timelineGroups.map((group) => {
            const entries = group.type === 'tool-group' ? group.messages : [group.message]
            const isWork = entries.every((message) =>
              finalResponseLayout.workMessageIds.has(message.id)
            )
            if (!isWork) return renderTimelineGroup(group)
            const groupId = group.type === 'tool-group'
              ? group.messages[0].id
              : group.message.id
            if (groupId !== firstWorkId) return null
            return (
              <details key="final-response-work" className="response-work-pill">
                <summary>{formatWorkedFor(finalResponseLayout.workedForMs)}</summary>
                <div className="response-work-content">
                  {workGroups.map((workGroup) => renderTimelineGroup(workGroup, true))}
                </div>
              </details>
            )
          })
        )}
        {showPreThinking && (
          <div className="message message-system message-thinking message-pre-thinking">
            <PreThinkingBlock />
          </div>
        )}
      </div>
      <div className="chat-input-area">
        {connectionFailed && (
          <div className="connection-failed-pill" role="alert">
            <span>Connection Failed</span>
            <button
              type="button"
              onClick={() => {
                setConnectionFailed(false)
                setLoading(true)
                void window.mousse.mousseAgent.retryConnection(agentId)
              }}
            >
              Retry
            </button>
          </div>
        )}
        <ChatComposer
          input={input}
          onInputChange={setInput}
          attachedFiles={attachedFiles}
          onAttachedFilesChange={setAttachedFiles}
          voiceMessages={voiceMessages}
          onVoiceMessagesChange={setVoiceMessages}
          chatMode={chatMode}
          onChatModeChange={setChatMode}
          enabledSkills={enabledSkills}
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModelId={selectedModelId}
          modelMenuOpen={modelMenuOpen}
          onModelMenuOpenChange={setModelMenuOpen}
          onModelSelect={(providerId, modelId) => void handleModelSelect(providerId, modelId)}
          onOpenSettings={() => setSettingsOpen(true)}
          contextUsage={contextUsage}
          contextOpen={contextOpen}
          onContextOpenChange={setContextOpen}
          loading={loading}
          placeholder="Message this agent…"
          onSend={() => void handleSend()}
          hideModePicker
        />
      </div>
    </div>
  )
}
