import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ChatMessage, ContextUsageSnapshot } from '../../shared/types'
import type { LlmProviderOption } from '../../shared/settings'
import type { SkillDescriptor } from '../../shared/integrations'
import { useAppStore } from '../stores/appStore'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { filesToImagePayloads } from '../utils/imageAttachments'
import {
  isAgentAwaitingResponse,
  reconcileAgentMessages,
  resolveMousseAgentModelSelection,
  upsertAgentMessage
} from '../utils/agentChatMessages'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { mousseToUIMessages } from '../chat/adapters/mousseToUI'
import type { ChatReference } from '../../shared/chatReferences'
import { resolveChatReference, resolveChatReferences } from '../utils/chatLinks'
import '../chat/components/agent-elements/agent-ui.css'

const EMPTY_REFERENCES: ChatReference[] = []

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

export function MousseAgentChat({ agentId, active = true }: MousseAgentChatProps) {
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const chatMode = useAppStore((s) => s.chatMode)
  const setChatMode = useAppStore((s) => s.setChatMode)
  const referenceKey = `agent:${agentId}`
  const references = useAppStore((s) => s.composerReferences[referenceKey] ?? EMPTY_REFERENCES)
  const profileId = useAppStore((s) => s.profileId)
  const removeComposerReference = useAppStore((s) => s.removeComposerReference)
  const clearComposerReferences = useAppStore((s) => s.clearComposerReferences)

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
  const [referenceError, setReferenceError] = useState<string | null>(null)
  const addResolvedReference = useCallback(async (reference: ChatReference) => {
    const expectedProfile = useAppStore.getState().profileId
    const expectedThread = useAppStore.getState().activeThreadId
    const resolved = await resolveChatReference(reference)
    const state = useAppStore.getState()
    if (state.profileId !== expectedProfile || state.activeThreadId !== expectedThread) return
    state.addComposerReference(referenceKey, resolved)
    setReferenceError(null)
  }, [referenceKey])
  const refreshMessages = useCallback(async () => {
    const next = await window.mousse.mousseAgent.getMessages(agentId)
    setMessages((current) => reconcileAgentMessages(current, next))
  }, [agentId])

  const refreshSelection = useCallback(async () => {
    const [settings, options, skillsSnapshot, assignment] = await Promise.all([
      window.mousse.settings.get(),
      window.mousse.settings.getOptions(),
      window.mousse.skills.list(),
      window.mousse.mousseAgent.getAssignment(agentId)
    ])
    setProviders(options.llmProviders)
    const selected = resolveMousseAgentModelSelection(assignment, {
      provider: settings.provider.llmProvider,
      model: settings.provider.model
    })
    setSelectedProviderId(selected.provider)
    setSelectedModelId(selected.model)
    const enabled = new Set(settings.integrations.skills.enabledSkills)
    setEnabledSkills(
      skillsSnapshot.skills.filter(
        (skill) =>
          skill.isActive !== false &&
          (enabled.size === 0 || enabled.has(skill.id) || enabled.has(skill.name))
      )
    )
  }, [agentId])

  const uiMessages = useMemo(() => mousseToUIMessages(messages), [messages])
  const chatStatus = useMemo(() => {
    if (loading) return 'streaming' as const
    return isAgentAwaitingResponse(messages) ? 'streaming' as const : 'ready' as const
  }, [loading, messages])
  const awaitingResponse = chatStatus === 'streaming'

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
    setContextUsage(EMPTY_CONTEXT_USAGE)
  }, [agentId])

  useEffect(() => {
    if (!active) return
    let cancelled = false
    const draft = buildComposerMessageContent(input, attachedFiles, voiceMessages, [], references)
    const timer = window.setTimeout(() => {
      void window.mousse.mousseAgent.getContextUsage(agentId, draft).then((usage) => {
        if (!cancelled && usage) setContextUsage(usage)
      }).catch(() => undefined)
    }, 350)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [active, agentId, messages, input, attachedFiles, voiceMessages, references, selectedProviderId, selectedModelId, loading])

  useEffect(() => {
    if (!active || !awaitingResponse) return
    let cancelled = false
    const refresh = () => {
      const draft = buildComposerMessageContent(input, attachedFiles, voiceMessages, [], references)
      void window.mousse.mousseAgent.getContextUsage(agentId, draft).then((usage) => {
        if (!cancelled && usage) setContextUsage(usage)
      }).catch(() => undefined)
    }
    const interval = window.setInterval(refresh, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [active, agentId, awaitingResponse, input, attachedFiles, voiceMessages, references])

  useEffect(() => {
    return () => {
      attachedFiles.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
  }, [])

  const handleSend = async () => {
    if (awaitingResponse) return
    const expectedProfile = profileId
    const expectedThread = useAppStore.getState().activeThreadId
    const expectedAgent = agentId
    setConnectionFailed(false)
    setReferenceError(null)
    setLoading(true)
    try {
      const resolvedReferences = await resolveChatReferences(references)
      if (useAppStore.getState().profileId !== expectedProfile || useAppStore.getState().activeThreadId !== expectedThread || agentId !== expectedAgent) return
      const text = buildComposerMessageContent(input, attachedFiles, voiceMessages, [], resolvedReferences)
      const images = await filesToImagePayloads(attachedFiles.map((f) => f.file))
      if (!text && images.length === 0) return
      const result = await window.mousse.mousseAgent.send(agentId, text || '[Image attachment]', images)
      // Keep the composer intact when delivery is rejected (busy, archived, or missing).
      if (!result.accepted) return
      setInput('')
      attachedFiles.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
      setAttachedFiles([])
      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
      setVoiceMessages([])
      clearComposerReferences(referenceKey)
    } catch (error) {
      if (useAppStore.getState().profileId === expectedProfile && useAppStore.getState().activeThreadId === expectedThread && agentId === expectedAgent) {
        setReferenceError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      setLoading(false)
    }
  }

  const handleStop = async () => {
    await window.mousse.mousseAgent.abort(agentId)
  }

  return (
    <div className={`mousse-agent-chat chat${active ? '' : ' hidden'}`} aria-hidden={!active} style={{ display: active ? 'flex' : 'none', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <MousseAgentChatShell
        messages={uiMessages}
        status={chatStatus}
        onSend={() => void handleSend()}
        onStop={() => void handleStop()}
        composer={(
      <div className="chat-input-area">
        {referenceError && <div className="connection-failed-pill" role="alert">{referenceError}</div>}
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
          references={references}
          onAddReference={addResolvedReference}
          onRemoveReference={(id) => removeComposerReference(referenceKey, id)}
          onReferenceError={setReferenceError}
          chatMode={chatMode}
          onChatModeChange={setChatMode}
          enabledSkills={enabledSkills}
          providers={providers}
          selectedProviderId={selectedProviderId}
          selectedModelId={selectedModelId}
          modelMenuOpen={modelMenuOpen}
          onModelMenuOpenChange={setModelMenuOpen}
          onModelSelect={() => {}}
          modelReadOnly
          onOpenSettings={() => setSettingsOpen(true)}
          contextUsage={contextUsage}
          contextOpen={contextOpen}
          onContextOpenChange={setContextOpen}
          loading={awaitingResponse}
          placeholder="Message this agent…"
          onSend={() => void handleSend()}
          onStop={() => void handleStop()}
          hideModePicker
          disableSkillsPicker
        />
      </div>
        )}
      />
    </div>
  )
}
