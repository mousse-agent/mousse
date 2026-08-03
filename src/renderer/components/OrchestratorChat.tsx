import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { LlmProviderOption } from '../../shared/settings'
import type {
  BrowserElementAttachment,
  ContextUsageSnapshot,
  PlanCardMetadata,
  PendingUserQuestions,
  QueuedMessage
} from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import type { SkillDescriptor } from '../../shared/integrations'
import { isToolTimelineMessage } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { ChatMessageContent, resolvePlanCard } from './ChatMessageContent'
import { AssistantMessageActions } from './AssistantMessageActions'
import { parseUserMessageContent } from '../utils/messageAttachments'
import {
  findOverflowingUserMessageIds,
  sameMessageIdSet,
  stickyUserMessagePreview
} from '../utils/stickyUserMessage'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { QueuedMessages } from './QueuedMessages'
import { ComposerQuestionModal } from './ComposerQuestionModal'
import { PreThinkingBlock } from './PreThinkingBlock'
import { ResponseWork } from './ResponseWork'
import { filesToImagePayloads } from '../utils/imageAttachments'
import {
  chunkTimelineIntoTurns,
  groupChatTimeline,
  turnChunkKey,
  type ChatTimelineGroup
} from '../utils/toolTimelineGroups'
import {
  coalesceAssistantMessagesForDisplay,
  getResponseTurnWorkLayouts,
  isResponseWorkMessage
} from '../utils/responseTimeline'
import { formatMessageTime, formatMessageTimeTitle } from '../utils/formatMessageTime'
import { canShowAssistantMessageActions } from '../utils/assistantMessageActions'
import { extractToolCallsFromContent } from '../../shared/toolCallDisplay'

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

export function OrchestratorChat() {
  const messages = useAppStore((s) => s.messages)
  const loading = useAppStore((s) => s.loading)
  const setLoading = useAppStore((s) => s.setLoading)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const chatMode = useAppStore((s) => s.chatMode)
  const setChatMode = useAppStore((s) => s.setChatMode)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  // Subscribe only to the selected thread's activity — the full map used to
  // re-render the chat on every background thread's activity tick.
  const activeThreadActivity = useAppStore((s) =>
    s.activeThreadId ? s.threadActivity[s.activeThreadId] : undefined
  )
  const activeThreadModelOverride = useAppStore((s) =>
    s.threads.find((thread) => thread.id === s.activeThreadId)?.modelOverride
  )
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
  const [stickyOverflowIds, setStickyOverflowIds] = useState<Set<string>>(() => new Set())
  /** Per-message collapse while this conversation surface is mounted. */
  const [stickyCollapsedById, setStickyCollapsedById] = useState<Record<string, boolean>>({})
  const [pendingQuestions, setPendingQuestions] = useState<PendingUserQuestions | null>(null)
  const [connectionFailed, setConnectionFailed] = useState(false)
  const [optimisticQueueItems, setOptimisticQueueItems] = useState<QueuedMessage[]>([])

  const messagesRef = useRef<HTMLDivElement>(null)
  const stickyUpdateTimerRef = useRef<number | null>(null)
  const followLatestRef = useRef(true)
  const touchStartYRef = useRef<number | null>(null)
  const scrollFadeTimerRef = useRef<number | null>(null)
  const turnActivityRequestRef = useRef(0)

  let latestUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      latestUserIndex = index
      break
    }
  }
  const latestTurnMessages = latestUserIndex >= 0 ? messages.slice(latestUserIndex + 1) : []
  const latestTurnId = latestUserIndex >= 0 ? messages[latestUserIndex].id : null
  const hasActiveThinking = latestTurnMessages.some(
    (message) => message.kind === 'thinking' && message.thinking?.status === 'processing'
  )
  const hasStreamingAssistant = latestTurnMessages.some(
    (message) => message.role === 'assistant' && message.streaming
  )
  const hasProcessingWork = latestTurnMessages.some(
    (message) =>
      (message.kind === 'thinking' && message.thinking?.status === 'processing') ||
      (isToolTimelineMessage(message) && message.toolCall?.status === 'processing')
  )
  // A turn can briefly have no processing marker while the provider transitions from
  // thinking to its next text/tool block. Keep the disclosure alive from the unfinished
  // turn trace as well as the transport loading flag.
  const turnAwaitingResponse = latestTurnMessages.some(isResponseWorkMessage) &&
    !latestTurnMessages.some(
      (message) =>
        message.role === 'assistant' &&
        !isToolTimelineMessage(message) &&
        !message.streaming &&
        (message.responseMetadata || message.incomplete)
    )
  const responseActive = loading || hasStreamingAssistant || hasProcessingWork || turnAwaitingResponse
  const showPreThinking = responseActive && !hasActiveThinking && !hasStreamingAssistant
  const displayMessages = useMemo(
    () => coalesceAssistantMessagesForDisplay(messages),
    [messages]
  )
  const timelineGroups = useMemo(() => groupChatTimeline(displayMessages), [displayMessages])
  const workLayouts = useMemo(() => getResponseTurnWorkLayouts(messages), [messages])
  const latestWorkLayout = workLayouts.find((layout) => layout.turnId === latestTurnId)
  const measureStickyOverflow = useCallback(() => {
    const container = messagesRef.current
    if (!container) return

    const next = findOverflowingUserMessageIds(container)
    setStickyOverflowIds((current) => (sameMessageIdSet(current, next) ? current : next))
  }, [])

  const scheduleStickyOverflowMeasure = useCallback(() => {
    if (stickyUpdateTimerRef.current !== null) return
    stickyUpdateTimerRef.current = window.requestAnimationFrame(() => {
      stickyUpdateTimerRef.current = null
      measureStickyOverflow()
    })
  }, [measureStickyOverflow])

  const handleMessagesScroll = useCallback(() => {
    const container = messagesRef.current
    if (!container) return

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    followLatestRef.current = distanceFromBottom <= 24
    container.classList.add('is-scrolling')
    if (scrollFadeTimerRef.current) {
      window.clearTimeout(scrollFadeTimerRef.current)
    }
    scrollFadeTimerRef.current = window.setTimeout(() => {
      container.classList.remove('is-scrolling')
      scrollFadeTimerRef.current = null
    }, 900)
  }, [])

  useEffect(() => {
    const container = messagesRef.current
    if (container && followLatestRef.current) {
      container.scrollTop = container.scrollHeight
    }
    scheduleStickyOverflowMeasure()
  }, [messages, stickyCollapsedById, scheduleStickyOverflowMeasure])

  useEffect(() => {
    const container = messagesRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(scheduleStickyOverflowMeasure)
    const timeline = container.firstElementChild
    observer.observe(timeline ?? container)
    return () => observer.disconnect()
  }, [scheduleStickyOverflowMeasure])

  useEffect(() => {
    return () => {
      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
      attachedFiles.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
      if (stickyUpdateTimerRef.current !== null) window.cancelAnimationFrame(stickyUpdateTimerRef.current)
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
    const selectedModel = activeThreadModelOverride ?? settings.provider
    setSelectedProviderId(selectedModel.llmProvider)
    setSelectedModelId(selectedModel.model)

    const enabled = new Set(settings.integrations.skills.enabledSkills)
    setEnabledSkills(
      skillsSnapshot.skills.filter(
        (skill) =>
          skill.isActive !== false &&
          (enabled.size === 0 || enabled.has(skill.id) || enabled.has(skill.name))
      )
    )
  }, [activeThreadModelOverride])

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
    const requestId = ++turnActivityRequestRef.current
    // Prefer the already-tracked activity map for instant spinner state; only
    // probe the daemon lightly when activity is unknown/idle for the selection.
    if (activeThreadActivity === 'processing') {
      setLoading(true)
      return
    }
    try {
      const active = await window.mousse.orchestrator.isTurnActive(
        activeThreadId ?? undefined
      )
      // An older check must not clear the spinner after a newer check observed the turn.
      if (requestId === turnActivityRequestRef.current) setLoading(active)
    } catch {
      // Keep prior loading state on transient IPC errors.
    }
  }, [activeThreadId, activeThreadActivity, setLoading])

  // Only re-probe on thread switch / this thread's activity changes — not every stream token.
  useEffect(() => {
    void refreshTurnActive()
  }, [activeThreadId, activeThreadActivity, refreshTurnActive])

  useEffect(() => {
    let cancelled = false
    const draft = buildMessageContent()
    // Debounce context metering: typing and stream deltas used to fire an IPC
    // on every keystroke/token and stalled thread switches + model changes.
    const timer = window.setTimeout(() => {
      void window.mousse.orchestrator
        .getContextUsage({ draftInput: draft, mode: chatMode })
        .then((usage) => {
          if (!cancelled) setContextUsage(usage)
        })
    }, 350)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
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
      const request = {
        content: content || (images?.length ? '[Image attachment]' : ''),
        mode,
        images
      }
      const optimisticId = loading && activeThreadId ? `optimistic:${crypto.randomUUID()}` : null
      if (optimisticId && activeThreadId) {
        setOptimisticQueueItems((current) => [...current, {
          id: optimisticId,
          threadId: activeThreadId,
          content: request.content,
          mode,
          images,
          enqueuedAt: new Date().toISOString(),
          order: Number.MAX_SAFE_INTEGER,
          intent: 'normal',
          state: 'pending',
          source: 'gui'
        }])
      }
      // Optimistically mark the selected thread busy; queue accepts keep loading true.
      setLoading(true)
      // Promote drafts immediately so switching away mid-title still lists the thread.
      if (activeThreadId) {
        const current = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
        if (current && !current.startedAt) {
          useAppStore.getState().upsertThread({
            ...current,
            startedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          })
        }
      }
      try {
        const result = activeThreadId
          ? await window.mousse.orchestrator.sendToThread(activeThreadId, request)
          : await window.mousse.orchestrator.send(request)

        // Queued sends return quickly while an earlier turn remains active — do not clear loading.
        if (optimisticId) {
          setOptimisticQueueItems((current) => [
            ...current.filter((item) => item.id !== optimisticId),
            ...(result.queued && result.queueItem ? [result.queueItem] : [])
          ])
        }
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
        if (optimisticId) {
          setOptimisticQueueItems((current) => current.filter((item) => item.id !== optimisticId))
        }
        const stillActive = await window.mousse.orchestrator.isTurnActive(
          activeThreadId ?? undefined
        )
        setLoading(stillActive)
      }
    },
    [activeThreadId, chatMode, loading, setLoading]
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

  const handleImplementPlan = useCallback(async (plan: PlanCardMetadata) => {
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
  }, [sendMessage, setChatMode])

  const handleModelSelect = async (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    setSelectedProviderId(providerId)
    setSelectedModelId(modelId)
    if (activeThreadId) {
      // Optimistic local meta so the composer badge updates before IPC returns.
      const current = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
      if (current) {
        useAppStore.getState().upsertThread({
          ...current,
          modelOverride: { llmProvider: providerId, model: modelId },
          updatedAt: new Date().toISOString()
        })
      }
      const updated = await window.mousse.threads.setModel(activeThreadId, {
        llmProvider: providerId,
        model: modelId
      })
      if (updated) useAppStore.getState().upsertThread(updated)
      return
    }
    await window.mousse.settings.set({
      provider: { llmProvider: providerId, model: modelId }
    })
  }

  const renderTimelineGroup = (group: ChatTimelineGroup, inWork = false) => {
    if (group.type === 'tool-group' && group.messages.length > 1) {
      const first = group.messages[0]
      const isLastMessage = group.messages.some(
        (message) => message.id === displayMessages.at(-1)?.id
      )
      return (
        <div key={first.id} className="message message-system message-tool-call">
          <ChatMessageContent
            role="system"
            content=""
            toolCalls={group.messages.flatMap((message) => message.toolCall ? [message.toolCall] : [])}
          />
          <div
            className={`message-time${isLastMessage ? ' message-time-last' : ''}`}
            title={formatMessageTimeTitle(first.timestamp)}
          >
            {formatMessageTime(first.timestamp)}
          </div>
        </div>
      )
    }

    const msg = group.type === 'tool-group' ? group.messages[0] : group.message
    const isLastMessage = msg.id === displayMessages.at(-1)?.id
    // Every prompt is sticky within its own turn block; nothing here reads scroll state.
    const isStickyUser = msg.role === 'user'
    const isStickyCollapsed = isStickyUser && Boolean(stickyCollapsedById[msg.id])
    const stickyPreview = isStickyCollapsed
      ? stickyUserMessagePreview(parseUserMessageContent(msg.content).text)
      : null

    return (
      <div
        key={msg.id}
        className={`message message-${msg.role}${
          isStickyUser && stickyOverflowIds.has(msg.id) ? ' message-user-sticky-overflow' : ''
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
            onImplementPlan={(plan) => void handleImplementPlan(plan)}
            implementPlanLoading={loading}
          />
        )}
        {(() => {
          const showActions = !inWork && canShowAssistantMessageActions(msg)
          const actionContent = msg.kind === 'plan_card'
            ? resolvePlanCard(msg.kind, msg.planCard, msg.content)?.planMarkdown ?? msg.content
            : extractToolCallsFromContent(msg.content).visibleContent
          const hasTimestamp = msg.kind !== 'plan_card' && !isStickyCollapsed
          if (!showActions && !hasTimestamp) return null
          return (
            <div className="message-footer">
              {hasTimestamp && (
                <div
                  className={`message-time${isLastMessage ? ' message-time-last' : ''}`}
                  title={formatMessageTimeTitle(msg.timestamp)}
                >
                  {formatMessageTime(msg.timestamp)}
                </div>
              )}
              {showActions && (
                <AssistantMessageActions content={actionContent} metadata={msg.responseMetadata} />
              )}
            </div>
          )
        })()}
      </div>
    )
  }

  const handleMessagesWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) followLatestRef.current = false
  }

  const handleMessagesTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    touchStartYRef.current = event.touches[0]?.clientY ?? null
  }

  const handleMessagesTouchMove = (event: React.TouchEvent<HTMLDivElement>) => {
    const currentY = event.touches[0]?.clientY
    if (currentY !== undefined && touchStartYRef.current !== null && currentY > touchStartYRef.current) {
      followLatestRef.current = false
    }
    touchStartYRef.current = currentY ?? null
  }

  const renderTimelineEntry = (group: ChatTimelineGroup) => {
    const entries = group.type === 'tool-group' ? group.messages : [group.message]
    const groupId = group.type === 'tool-group' ? group.messages[0].id : group.message.id
    const workLayout = workLayouts.find((layout) =>
      entries.every((message) => layout.workMessageIds.has(message.id))
    )
    if (workLayout) {
      if (groupId !== workLayout.firstWorkMessageId) return null
      const layoutGroups = timelineGroups.filter((candidate) => {
        const candidateEntries = candidate.type === 'tool-group'
          ? candidate.messages
          : [candidate.message]
        return candidateEntries.every((message) => workLayout.workMessageIds.has(message.id))
      })
      const active = responseActive && workLayout.turnId === latestTurnId
      return (
        <ResponseWork
          key={`response-work:${workLayout.turnId}`}
          active={active}
          startedAt={workLayout.startedAt}
          durationMs={workLayout.durationMs}
        >
          {layoutGroups.map((workGroup) => renderTimelineGroup(workGroup, true))}
          {active && showPreThinking && (
            <div className="message message-system message-thinking message-pre-thinking">
              <PreThinkingBlock />
            </div>
          )}
        </ResponseWork>
      )
    }

    return renderTimelineGroup(group)
  }

  const turnChunks = useMemo(() => chunkTimelineIntoTurns(timelineGroups), [timelineGroups])
  const trailingPreThinking = showPreThinking && !latestWorkLayout ? (
    <ResponseWork
      key="pre-thinking"
      active
      startedAt={latestUserIndex >= 0 ? messages[latestUserIndex].timestamp : null}
    >
      <div className="message message-system message-thinking message-pre-thinking">
        <PreThinkingBlock />
      </div>
    </ResponseWork>
  ) : null

  const timelineContent = turnChunks.map((chunk, index) => (
    // Each turn owns its sticky prompt's containing block.
    <div className="chat-turn-block" key={turnChunkKey(chunk, index)}>
      {chunk.map(renderTimelineEntry)}
      {index === turnChunks.length - 1 && trailingPreThinking}
    </div>
  ))

  return (
    <div className="chat">
      <div
        className="chat-messages"
        ref={messagesRef}
        onScroll={handleMessagesScroll}
        onWheel={handleMessagesWheel}
        onTouchStart={handleMessagesTouchStart}
        onTouchMove={handleMessagesTouchMove}
      >
        <div className="chat-turn">
          {timelineContent}
          {turnChunks.length === 0 && trailingPreThinking}
          <div className="chat-messages-fill" aria-hidden="true" />
        </div>
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
          optimisticItems={optimisticQueueItems}
          onOptimisticItemReconciled={(id) => {
            setOptimisticQueueItems((current) => current.filter((item) => item.id !== id))
          }}
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
