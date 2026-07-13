import { useCallback, useEffect, useState } from 'react'
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
}

export function MousseAgentChat({ agentId }: MousseAgentChatProps) {
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

  const refreshMessages = useCallback(async () => {
    const next = await window.mousse.mousseAgent.getMessages(agentId)
    setMessages(next)
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
  const showPreThinking = loading && !hasActiveThinking && !hasStreamingAssistant

  const handleSend = async () => {
    const text = buildComposerMessageContent(input, attachedFiles, voiceMessages)
    const images = await filesToImagePayloads(attachedFiles.map((f) => f.file))
    if ((!text && images.length === 0) || loading) return

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

  return (
    <div className="mousse-agent-chat chat">
      <div className="mousse-agent-messages chat-messages scrollbar-ultra-thin">
        {messages.length === 0 && !showPreThinking ? (
          <div className="mousse-agent-empty">Starting agent…</div>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`message message-${message.role}${
                message.kind === 'plan_card' ? ' message-plan-card' : ''
              }`}
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
              />
            </div>
          ))
        )}
        {showPreThinking && (
          <div className="message message-system message-thinking message-pre-thinking">
            <PreThinkingBlock />
          </div>
        )}
      </div>
      <div className="chat-input-area">
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
