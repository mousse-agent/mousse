import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ChatMessage, ContextUsageSnapshot } from '../../shared/types'
import type { LlmProviderOption } from '../../shared/settings'
import type { SkillDescriptor } from '../../shared/integrations'
import { useAppStore } from '../stores/appStore'
import { ChatMessageContent, resolvePlanCard } from './ChatMessageContent'
import { AssistantMessageActions } from './AssistantMessageActions'
import { PreThinkingBlock } from './PreThinkingBlock'
import { ResponseWork } from './ResponseWork'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { filesToImagePayloads } from '../utils/imageAttachments'
import {
  coalesceAssistantMessagesForDisplay,
  getResponseTurnWorkLayouts,
  isResponseWorkMessage
} from '../utils/responseTimeline'
import { formatMessageTime, formatMessageTimeTitle } from '../utils/formatMessageTime'
import { canShowAssistantMessageActions } from '../utils/assistantMessageActions'
import { extractToolCallsFromContent } from '../../shared/toolCallDisplay'
import {
  chunkTimelineIntoTurns,
  groupChatTimeline,
  turnChunkKey,
  type ChatTimelineGroup
} from '../utils/toolTimelineGroups'
import { isToolTimelineMessage } from '../../shared/types'
import { parseUserMessageContent } from '../utils/messageAttachments'
import {
  findOverflowingUserMessageIds,
  findPinnedUserMessageIds,
  sameMessageIdSet,
  scrollToUserMessage,
  stickyUserMessagePreview
} from '../utils/stickyUserMessage'
import {
  isAgentAwaitingResponse,
  reconcileAgentMessages,
  resolveMousseAgentModelSelection,
  upsertAgentMessage
} from '../utils/agentChatMessages'

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
  const [stickyOverflowIds, setStickyOverflowIds] = useState<Set<string>>(() => new Set())
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(() => new Set())
  const [stickyCollapsedById, setStickyCollapsedById] = useState<Record<string, boolean>>({})
  const messagesRef = useRef<HTMLDivElement>(null)
  const stickyUpdateTimerRef = useRef<number | null>(null)
  const followLatestRef = useRef(true)
  const touchStartYRef = useRef<number | null>(null)
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
    // Existing subagents retain their launch assignment even when global settings change.
    // Legacy sessions without one follow the same global fallback used by LlmClient.
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

  const measureStickyOverflow = useCallback(() => {
    const container = messagesRef.current
    if (!container) return
    const next = findOverflowingUserMessageIds(container)
    setStickyOverflowIds((current) => (sameMessageIdSet(current, next) ? current : next))
    const pinned = findPinnedUserMessageIds(container)
    setPinnedIds((current) => (sameMessageIdSet(current, pinned) ? current : pinned))
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
    const pinned = findPinnedUserMessageIds(container)
    setPinnedIds((current) => (sameMessageIdSet(current, pinned) ? current : pinned))
  }, [])

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

  useEffect(() => {
    if (!active) return
    const container = messagesRef.current
    if (container && followLatestRef.current) {
      container.scrollTop = container.scrollHeight
    }
    scheduleStickyOverflowMeasure()
  }, [active, messages, stickyCollapsedById, scheduleStickyOverflowMeasure])

  useEffect(() => {
    const container = messagesRef.current
    if (!container || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(scheduleStickyOverflowMeasure)
    observer.observe(container.firstElementChild ?? container)
    return () => observer.disconnect()
  }, [scheduleStickyOverflowMeasure])

  useEffect(() => {
    return () => {
      attachedFiles.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
      if (stickyUpdateTimerRef.current !== null) window.cancelAnimationFrame(stickyUpdateTimerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
  }, [])

  // The composer is controlled by this component, so every keystroke renders this function.
  // Keep all transcript-length work behind the messages boundary; otherwise typing cost grows
  // with the conversation and the controlled textarea cannot paint until the timeline finishes.
  const timelineState = useMemo(() => {
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
    const turnAwaitingResponse = latestTurnMessages.some(isResponseWorkMessage) &&
      !latestTurnMessages.some(
        (message) =>
          message.role === 'assistant' &&
          !isToolTimelineMessage(message) &&
          !message.streaming &&
          (message.responseMetadata || message.incomplete)
      )
    const awaitingResponse = loading || isAgentAwaitingResponse(messages) || turnAwaitingResponse
    const displayMessages = coalesceAssistantMessagesForDisplay(messages)
    const timelineGroups = groupChatTimeline(displayMessages)
    const workLayouts = getResponseTurnWorkLayouts(messages)

    return {
      latestUserIndex,
      latestTurnId,
      awaitingResponse,
      showPreThinking: active && awaitingResponse && !hasActiveThinking && !hasStreamingAssistant,
      displayMessages,
      timelineGroups,
      workLayouts,
      latestWorkLayout: workLayouts.find((layout) => layout.turnId === latestTurnId)
    }
  }, [active, loading, messages])
  const {
    latestUserIndex,
    latestTurnId,
    awaitingResponse,
    showPreThinking,
    displayMessages,
    timelineGroups,
    workLayouts,
    latestWorkLayout
  } = timelineState

  const handleSend = async () => {
    const text = buildComposerMessageContent(input, attachedFiles, voiceMessages)
    const images = await filesToImagePayloads(attachedFiles.map((f) => f.file))
    if ((!text && images.length === 0) || awaitingResponse) return

    setConnectionFailed(false)
    setLoading(true)
    try {
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
    } finally {
      setLoading(false)
    }
  }

  const handleStop = async () => {
    await window.mousse.mousseAgent.abort(agentId)
  }

  const timelineContent = useMemo(() => {
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
              toolCalls={group.messages.flatMap((message) =>
                message.toolCall ? [message.toolCall] : []
              )}
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

      const message = group.type === 'tool-group' ? group.messages[0] : group.message
      const isLastMessage = message.id === displayMessages.at(-1)?.id
      const isStickyUser = message.role === 'user'
      const isStickyCollapsed = isStickyUser && Boolean(stickyCollapsedById[message.id])
      const stickyPreview = isStickyCollapsed
        ? stickyUserMessagePreview(parseUserMessageContent(message.content).text)
        : null
      const isPinned = isStickyUser && pinnedIds.has(message.id)
      return (
        <div
          key={message.id}
          className={`message message-${message.role}${
            isStickyUser && stickyOverflowIds.has(message.id) ? ' message-user-sticky-overflow' : ''
          }${isStickyCollapsed ? ' message-user-sticky-collapsed' : ''}${
            isToolTimelineMessage(message) ? ' message-tool-call' : ''
          }${message.kind === 'plan_card' ? ' message-plan-card' : ''}${isPinned ? ' message-user-pinned' : ''}`}
          data-message-id={message.id}
          data-message-role={message.role}
          onClick={isPinned ? () => {
            const container = messagesRef.current
            if (container) scrollToUserMessage(container, message.id)
          } : undefined}
          onKeyDown={isPinned ? (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              const container = messagesRef.current
              if (container) scrollToUserMessage(container, message.id)
            }
          } : undefined}
          role={isPinned ? 'button' : undefined}
          tabIndex={isPinned ? 0 : undefined}
          title={isPinned ? 'Scroll to prompt' : undefined}
        >
          {isStickyUser && (
            <button
              type="button"
              className="message-user-sticky-toggle"
              aria-label={isStickyCollapsed ? 'Expand sticky message' : 'Collapse sticky message'}
              aria-expanded={!isStickyCollapsed}
              onClick={(event) => {
                event.preventDefault()
                event.stopPropagation()
                setStickyCollapsedById((current) => ({
                  ...current,
                  [message.id]: !current[message.id]
                }))
              }}
            >
              {isStickyCollapsed ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
            </button>
          )}
          {isStickyCollapsed ? (
            <div className="message-body message-user-sticky-preview">
              <div className="message-text message-user-sticky-preview-text">{stickyPreview}</div>
            </div>
          ) : (
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
            />
          )}
          {(() => {
            const showActions = !inWork && canShowAssistantMessageActions(message)
            const actionContent = message.kind === 'plan_card'
              ? resolvePlanCard(message.kind, message.planCard, message.content)?.planMarkdown ?? message.content
              : extractToolCallsFromContent(message.content).visibleContent
            const hasTimestamp = message.kind !== 'plan_card' && !isStickyCollapsed
            if (!showActions && !hasTimestamp) return null
            return (
              <div className="message-footer">
                {hasTimestamp && (
                  <div
                    className={`message-time${isLastMessage ? ' message-time-last' : ''}`}
                    title={formatMessageTimeTitle(message.timestamp)}
                  >
                    {formatMessageTime(message.timestamp)}
                  </div>
                )}
                {showActions && (
                  <AssistantMessageActions content={actionContent} metadata={message.responseMetadata} />
                )}
              </div>
            )
          })()}
        </div>
      )
    }

    const renderTimelineEntry = (group: ChatTimelineGroup) => {
      const entries = group.type === 'tool-group' ? group.messages : [group.message]
      const workLayout = workLayouts.find((layout) =>
        entries.every((message) => layout.workMessageIds.has(message.id))
      )
      const groupId = group.type === 'tool-group' ? group.messages[0].id : group.message.id
      if (workLayout) {
        if (groupId !== workLayout.firstWorkMessageId) return null
        const layoutGroups = timelineGroups.filter((candidate) => {
          const candidateEntries = candidate.type === 'tool-group'
            ? candidate.messages
            : [candidate.message]
          return candidateEntries.every((message) => workLayout.workMessageIds.has(message.id))
        })
        const workActive = awaitingResponse && workLayout.turnId === latestTurnId
        return (
          <ResponseWork
            key={`response-work:${workLayout.turnId}`}
            active={workActive}
            startedAt={workLayout.startedAt}
            durationMs={workLayout.durationMs}
          >
            {layoutGroups.map((workGroup) => renderTimelineGroup(workGroup, true))}
            {workActive && showPreThinking && (
              <div className="message message-system message-thinking message-pre-thinking">
                <PreThinkingBlock />
              </div>
            )}
          </ResponseWork>
        )
      }

      return renderTimelineGroup(group)
    }

    const turnChunks = chunkTimelineIntoTurns(timelineGroups)
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

    return (
      <>
        {messages.length === 0 && !showPreThinking ? (
          <div className="mousse-agent-empty">Starting agent…</div>
        ) : (
          turnChunks.map((chunk, index) => (
            // Each turn owns its sticky prompt's containing block.
            <div className="chat-turn-block" key={turnChunkKey(chunk, index)}>
              {chunk.map(renderTimelineEntry)}
              {index === turnChunks.length - 1 && trailingPreThinking}
            </div>
          ))
        )}
        {turnChunks.length === 0 && trailingPreThinking}
        <div className="chat-messages-fill" aria-hidden="true" />
      </>
    )
  }, [
    awaitingResponse,
    displayMessages,
    latestTurnId,
    latestUserIndex,
    latestWorkLayout,
    messages,
    showPreThinking,
    stickyCollapsedById,
    stickyOverflowIds,
    pinnedIds,
    timelineGroups,
    workLayouts
  ])

  return (
    <div className={`mousse-agent-chat chat${active ? '' : ' hidden'}`} aria-hidden={!active}>
      <div
        className="mousse-agent-messages chat-messages scrollbar-ultra-thin"
        ref={messagesRef}
        onScroll={handleMessagesScroll}
        onWheel={handleMessagesWheel}
        onTouchStart={handleMessagesTouchStart}
        onTouchMove={handleMessagesTouchMove}
      >
        <div className="chat-turn">{timelineContent}</div>
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
        />
      </div>
    </div>
  )
}
