import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { LlmProviderOption } from '../../shared/settings'
import type {
  BrowserElementAttachment,
  ContextUsageSnapshot,
  PlanCardMetadata,
  PendingUserQuestions
} from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import type { SkillDescriptor } from '../../shared/integrations'
import { isToolTimelineMessage } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { ChatMessageContent } from './ChatMessageContent'
import { parseUserMessageContent } from '../utils/messageAttachments'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { QueuedMessages } from './QueuedMessages'
import { ComposerQuestionModal } from './ComposerQuestionModal'
import { PreThinkingBlock } from './PreThinkingBlock'
import { filesToImagePayloads } from '../utils/imageAttachments'
import { groupChatTimeline, type ChatTimelineGroup } from '../utils/toolTimelineGroups'
import { formatWorkedFor, getFinalResponseLayout } from '../utils/responseTimeline'
import { formatMessageTime, formatMessageTimeTitle } from '../utils/formatMessageTime'

const EMPTY_CONTEXT_USAGE: ContextUsageSnapshot = {
  percent: 0,
  used: 0,
  limit: 128_000,
  modelName: null,
  source: 'estimated',
  categories: []
}

/** Stable empty list — `?? []` in a Zustand selector causes infinite re-renders. */
const EMPTY_BROWSER_ELEMENTS: BrowserElementAttachment[] = []

const STICKY_USER_DEBOUNCE_MS = 60

export function OrchestratorChat() {
  const messages = useAppStore((s) => s.messages)
  const loading = useAppStore((s) => s.loading)
  const setLoading = useAppStore((s) => s.setLoading)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const chatMode = useAppStore((s) => s.chatMode)
  const setChatMode = useAppStore((s) => s.setChatMode)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const browserElements = useAppStore(
    (s) =>
      s.browserElementAttachmentsByThread[s.activeThreadId ?? '__standalone__'] ??
      EMPTY_BROWSER_ELEMENTS
  )
  const removeBrowserElement = useAppStore((s) => s.removeBrowserElementAttachment)
  const clearBrowserElements = useAppStore((s) => s.clearBrowserElementAttachments)

  const [input, setInput] = useState('')
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [selectedProviderId, setSelectedProviderId] = useState('')
  const [selectedModelId, setSelectedModelId] = useState('')
  const [enabledSkills, setEnabledSkills] = useState<SkillDescriptor[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  const [voiceMessages, setVoiceMessages] = useState<VoiceMessage[]>([])
  const [contextOpen, setContextOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot>(EMPTY_CONTEXT_USAGE)
  const [stickyUserId, setStickyUserId] = useState<string | null>(null)
  /** Per-message collapse while this conversation surface is mounted. */
  const [stickyCollapsedById, setStickyCollapsedById] = useState<Record<string, boolean>>({})
  const [pendingQuestions, setPendingQuestions] = useState<PendingUserQuestions | null>(null)
  const [connectionFailed, setConnectionFailed] = useState(false)

  const messagesRef = useRef<HTMLDivElement>(null)
  const stickyUpdateTimerRef = useRef<number | null>(null)
  const scrollFadeTimerRef = useRef<number | null>(null)

  const hasActiveThinking = messages.some(
    (message) => message.kind === 'thinking' && message.thinking?.status === 'processing'
  )
  const hasStreamingAssistant = messages.some(
    (message) => message.role === 'assistant' && message.streaming
  )
  const showPreThinking = loading && !hasActiveThinking && !hasStreamingAssistant
  const timelineGroups = groupChatTimeline(messages)
  const finalResponseLayout = getFinalResponseLayout(messages)
  const workGroups = timelineGroups.filter((group) => {
    const entries = group.type === 'tool-group' ? group.messages : [group.message]
    return entries.every((message) => finalResponseLayout.workMessageIds.has(message.id))
  })
  const firstWorkId = workGroups.length > 0
    ? (workGroups[0].type === 'tool-group' ? workGroups[0].messages[0].id : workGroups[0].message.id)
    : null

  const updateStickyUser = useCallback(() => {
    const container = messagesRef.current
    if (!container) return

    const stickyThreshold = container.scrollTop + 1
    let nextStickyId: string | null = null

    for (const message of container.querySelectorAll<HTMLElement>('[data-message-role="user"]')) {
      if (message.offsetTop <= stickyThreshold) {
        nextStickyId = message.dataset.messageId ?? null
      }
    }

    setStickyUserId((current) => (current === nextStickyId ? current : nextStickyId))
  }, [])

  const scheduleStickyUserUpdate = useCallback(() => {
    if (stickyUpdateTimerRef.current) {
      window.clearTimeout(stickyUpdateTimerRef.current)
    }

    stickyUpdateTimerRef.current = window.setTimeout(() => {
      stickyUpdateTimerRef.current = null
      updateStickyUser()
    }, STICKY_USER_DEBOUNCE_MS)
  }, [updateStickyUser])

  const handleMessagesScroll = useCallback(() => {
    scheduleStickyUserUpdate()

    const container = messagesRef.current
    if (!container) return

    container.classList.add('is-scrolling')
    if (scrollFadeTimerRef.current) {
      window.clearTimeout(scrollFadeTimerRef.current)
    }
    scrollFadeTimerRef.current = window.setTimeout(() => {
      container.classList.remove('is-scrolling')
      scrollFadeTimerRef.current = null
    }, 900)
  }, [scheduleStickyUserUpdate])

  useEffect(() => {
    messagesRef.current?.scrollTo({
      top: messagesRef.current.scrollHeight,
      behavior: 'smooth'
    })
    scheduleStickyUserUpdate()
  }, [messages, scheduleStickyUserUpdate])

  useEffect(() => {
    return () => {
      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
      attachedFiles.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
      if (stickyUpdateTimerRef.current) window.clearTimeout(stickyUpdateTimerRef.current)
      if (scrollFadeTimerRef.current) window.clearTimeout(scrollFadeTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
  }, [])

  useEffect(() => {
    const unsub = window.mousse.orchestrator.onQuestionsPending((payload) => {
      setPendingQuestions(payload)
    })
    const unsubConnection = window.mousse.orchestrator.onConnectionFailed(() => {
      setConnectionFailed(true)
    })
    return () => {
      unsub()
      unsubConnection()
    }
  }, [])

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
    void refreshSelection()
    const unsubSettings = window.mousse.settings.onChanged(() => {
      void refreshSelection()
    })
    const unsubProviders = window.mousse.providers.onChanged(() => {
      void refreshSelection()
    })
    const unsubSkills = window.mousse.skills.onChanged(() => {
      void refreshSelection()
    })
    return () => {
      unsubSettings()
      unsubProviders()
      unsubSkills()
    }
  }, [refreshSelection])

  const buildMessageContent = useCallback((): string => {
    return buildComposerMessageContent(input, attachedFiles, voiceMessages, browserElements)
  }, [attachedFiles, browserElements, input, voiceMessages])

  const refreshTurnActive = useCallback(async () => {
    try {
      const active = await window.mousse.orchestrator.isTurnActive(
        activeThreadId ?? undefined
      )
      setLoading(active)
    } catch {
      // Keep prior loading state on transient IPC errors.
    }
  }, [activeThreadId, setLoading])

  useEffect(() => {
    void refreshTurnActive()
  }, [activeThreadId, messages, refreshTurnActive])

  useEffect(() => {
    let cancelled = false
    const draft = buildMessageContent()

    void window.mousse.orchestrator
      .getContextUsage({ draftInput: draft, mode: chatMode })
      .then((usage) => {
        if (!cancelled) setContextUsage(usage)
      })

    return () => {
      cancelled = true
    }
  }, [
    messages,
    input,
    attachedFiles,
    voiceMessages,
    selectedProviderId,
    selectedModelId,
    chatMode,
    loading,
    buildMessageContent
  ])

  const clearComposer = useCallback(() => {
    setInput('')
    attachedFiles.forEach((f) => {
      if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
    })
    setAttachedFiles([])
    voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
    setVoiceMessages([])
    clearBrowserElements(activeThreadId)
  }, [attachedFiles, voiceMessages, activeThreadId, clearBrowserElements])

  const sendMessage = useCallback(
    async (
      content: string,
      mode = chatMode,
      images?: Awaited<ReturnType<typeof filesToImagePayloads>>
    ) => {
      if (!content && !(images && images.length)) return

      setConnectionFailed(false)
      // Optimistically mark the selected thread busy; queue accepts keep loading true.
      setLoading(true)
      try {
        const request = {
          content: content || (images?.length ? '[Image attachment]' : ''),
          mode,
          images
        }
        const result = activeThreadId
          ? await window.mousse.orchestrator.sendToThread(activeThreadId, request)
          : await window.mousse.orchestrator.send(request)

        // Queued sends return quickly while an earlier turn remains active — do not clear loading.
        if (result.queued) {
          const stillActive = await window.mousse.orchestrator.isTurnActive(
            activeThreadId ?? undefined
          )
          setLoading(stillActive)
          return
        }

        const stillActive = await window.mousse.orchestrator.isTurnActive(
          activeThreadId ?? undefined
        )
        setLoading(stillActive)
      } catch {
        const stillActive = await window.mousse.orchestrator.isTurnActive(
          activeThreadId ?? undefined
        )
        setLoading(stillActive)
      }
    },
    [activeThreadId, chatMode, setLoading]
  )

  const handleStop = useCallback(async () => {
    await window.mousse.orchestrator.abort(activeThreadId ?? undefined)
    await refreshTurnActive()
  }, [activeThreadId, refreshTurnActive])

  const handleSend = async () => {
    const text = buildMessageContent()
    const images = await filesToImagePayloads(attachedFiles.map((f) => f.file))
    const trimmed = text.trim()

    // Immediate mid-run controls
    if (trimmed === '/stop' || trimmed.startsWith('/stop ')) {
      setInput('')
      await handleStop()
      return
    }
    if (trimmed.startsWith('/steer ') || trimmed === '/steer') {
      const steerText = trimmed.replace(/^\/steer\s*/, '').trim()
      if (!steerText) return
      setInput('')
      const steered = await window.mousse.orchestrator.steer(
        steerText,
        activeThreadId ?? undefined
      )
      if (steered) return
      // No active turn: treat as a normal user message (next-turn guidance).
      await sendMessage(steerText, chatMode)
      return
    }

    if (!text && images.length === 0) return

    const newThreadMatch = trimmed.match(/^\/new(?:\s+(.+))?$/)
    if (newThreadMatch && images.length === 0) {
      setInput('')
      await window.mousse.threads.createAndSelect(newThreadMatch[1]?.trim())
      return
    }

    // Clear only after we accept the send/queue path (control commands already cleared above).
    clearComposer()
    await sendMessage(text, chatMode, images)
  }

  const handleImplementPlan = async (plan: PlanCardMetadata) => {
    const content = [
      'Original request:',
      plan.originalRequest,
      '',
      'Implement the following plan:',
      '',
      plan.planMarkdown
    ].join('\n')

    setChatMode(DEFAULT_CHAT_MODE)
    await sendMessage(content, DEFAULT_CHAT_MODE)
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
            toolCalls={group.messages.flatMap((message) => message.toolCall ? [message.toolCall] : [])}
          />
          <div className="message-time" title={formatMessageTimeTitle(first.timestamp)}>
            {formatMessageTime(first.timestamp)}
          </div>
        </div>
      )
    }

    const msg = group.type === 'tool-group' ? group.messages[0] : group.message
    const isStickyUser = msg.role === 'user' && stickyUserId === msg.id
    // Keep collapsed geometry stable if a neighboring card takes over the sticky slot.
    // Re-expanding here would move that neighbor back across the sticky threshold and oscillate.
    const isStickyCollapsed = msg.role === 'user' && Boolean(stickyCollapsedById[msg.id])
    const stickyPreview = isStickyCollapsed
      ? parseUserMessageContent(msg.content).text.trim() || 'Message'
      : null

    return (
      <div
        key={msg.id}
        className={`message message-${msg.role}${
          isStickyUser ? ' message-user-sticky-active' : ''
        }${isStickyCollapsed ? ' message-user-sticky-collapsed' : ''}${
          isToolTimelineMessage(msg) ? ' message-tool-call' : ''
        }${msg.kind === 'plan_card' ? ' message-plan-card' : ''}`}
        data-message-id={msg.id}
        data-message-role={msg.role}
      >
        {isStickyUser && (
          <button
            type="button"
            className="message-user-sticky-toggle"
            aria-label={isStickyCollapsed ? 'Expand sticky message' : 'Collapse sticky message'}
            aria-expanded={!isStickyCollapsed}
            title={isStickyCollapsed ? 'Expand message' : 'Collapse message'}
            onClick={(event) => {
              // Keep scroll position stable; only toggle local collapse state.
              event.preventDefault()
              event.stopPropagation()
              setStickyCollapsedById((current) => ({
                ...current,
                [msg.id]: !current[msg.id]
              }))
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {isStickyCollapsed ? (
              <ChevronDown size={16} strokeWidth={2} aria-hidden="true" />
            ) : (
              <ChevronUp size={16} strokeWidth={2} aria-hidden="true" />
            )}
          </button>
        )}
        {isStickyCollapsed ? (
          <div className="message-body message-user-sticky-preview">
            <div className="message-text message-user-sticky-preview-text">{stickyPreview}</div>
          </div>
        ) : (
          <ChatMessageContent
            role={msg.role}
            content={msg.content}
            kind={msg.kind}
            planCard={msg.planCard}
            toolCall={msg.toolCall}
            thinking={msg.thinking}
            streaming={msg.streaming}
            images={msg.images}
            responseMetadata={msg.responseMetadata}
            incomplete={msg.incomplete}
            showResponseActions={!inWork && msg.id === finalResponseLayout.finalResponseId}
            onImplementPlan={(plan) => void handleImplementPlan(plan)}
            implementPlanLoading={loading}
          />
        )}
        {msg.kind !== 'plan_card' && !isStickyCollapsed && (
          <div className="message-time" title={formatMessageTimeTitle(msg.timestamp)}>
            {formatMessageTime(msg.timestamp)}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="chat-messages" ref={messagesRef} onScroll={handleMessagesScroll}>
        <div className="chat-turn">
          {timelineGroups.map((group) => {
            const entries = group.type === 'tool-group' ? group.messages : [group.message]
            const isWork = entries.every((message) => finalResponseLayout.workMessageIds.has(message.id))
            if (!isWork) return renderTimelineGroup(group)
            const groupId = group.type === 'tool-group' ? group.messages[0].id : group.message.id
            if (groupId !== firstWorkId) return null
            return (
              <details key="final-response-work" className="response-work-pill">
                <summary>{formatWorkedFor(finalResponseLayout.workedForMs)}</summary>
                <div className="response-work-content">
                  {workGroups.map((workGroup) => renderTimelineGroup(workGroup, true))}
                </div>
              </details>
            )
          })}
          {showPreThinking && (
            <div className="message message-system message-thinking message-pre-thinking">
              <PreThinkingBlock />
            </div>
          )}
        </div>
        <div className="chat-messages-fill" aria-hidden="true" />
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
                void window.mousse.orchestrator
                  .retryConnection(activeThreadId ?? undefined)
                  .then((started) => {
                    if (!started) setLoading(false)
                    else void refreshTurnActive()
                  })
              }}
            >
              Retry
            </button>
          </div>
        )}
        {pendingQuestions && (
          <ComposerQuestionModal
            pending={pendingQuestions}
            onSubmit={(answers) => {
              void window.mousse.orchestrator.answerQuestions(pendingQuestions.requestId, answers)
              setPendingQuestions(null)
            }}
            onDismiss={() => {
              void window.mousse.orchestrator.dismissQuestions(pendingQuestions.requestId)
              setPendingQuestions(null)
            }}
          />
        )}

        <QueuedMessages
          threadId={activeThreadId}
          onUseInComposer={(content) => setInput(content)}
        />

        <ChatComposer
          input={input}
          onInputChange={setInput}
          attachedFiles={attachedFiles}
          onAttachedFilesChange={setAttachedFiles}
          voiceMessages={voiceMessages}
          onVoiceMessagesChange={setVoiceMessages}
          browserElements={browserElements}
          onRemoveBrowserElement={(id) => removeBrowserElement(activeThreadId, id)}
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
          onSend={() => void handleSend()}
          onStop={() => void handleStop()}
        />
      </div>
    </div>
  )
}
