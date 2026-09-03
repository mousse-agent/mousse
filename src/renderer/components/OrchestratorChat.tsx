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
import { isTurnActivePhase } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { QueuedMessages } from './QueuedMessages'
import { ComposerQuestionModal } from './ComposerQuestionModal'
import { filesToImagePayloads } from '../utils/imageAttachments'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { mousseToUIMessages, chatStatusFromPhase } from '../chat/adapters/mousseToUI'
import {
  findQuickActionCardForApproval,
  type QuickActionApproval,
} from '../chat/components/agent-elements/tools/quick-action-approval'
import '../chat/components/agent-elements/agent-ui.css'

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
  const turnState = useAppStore((s) =>
    s.activeThreadId ? s.turnStates[s.activeThreadId] : undefined
  )
  // Subscribe only to the selected thread's activity — the full map used to
  // re-render the chat on every background thread's activity tick.
  const activeThreadActivity = useAppStore((s) =>
    s.activeThreadId ? s.threadActivity[s.activeThreadId] : undefined
  )
  const activeThreadModelOverride = useAppStore((s) =>
    s.threads.find((thread) => thread.id === s.activeThreadId)?.modelOverride
  )
  const activeThread = useAppStore((s) =>
    s.threads.find((thread) => thread.id === s.activeThreadId)
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
  const [pendingQuestions, setPendingQuestions] = useState<PendingUserQuestions | null>(null)
  const [connectionFailed, setConnectionFailed] = useState(false)
  const [optimisticQueueItems, setOptimisticQueueItems] = useState<QueuedMessage[]>([])

  const turnActivityRequestRef = useRef(0)
  const [renderQuestions, setRenderQuestions] = useState(false)
  const [questionsAnim, setQuestionsAnim] = useState<'enter' | 'open' | 'leave'>('open')
  const questionsSnapshotRef = useRef(pendingQuestions)
  if (pendingQuestions) questionsSnapshotRef.current = pendingQuestions
  const pendingRequestId = pendingQuestions?.requestId
  const inputAreaRef = useRef<HTMLDivElement>(null)

  // Deterministic agent-elements adapter: sorted transcript -> UIMessage[]
  // No custom coalesce/grouping — MessageList handles turn grouping internally with stable keys.
  const uiMessages = useMemo(() => mousseToUIMessages(messages), [messages])
  const chatStatus = useMemo(() => chatStatusFromPhase(turnState?.phase ?? 'idle'), [turnState])
  const turnActive = isTurnActivePhase(turnState?.phase ?? 'idle')

  // Quick-action approvals render inline on the PlanTool-style card instead
  // of the generic question modal. Bridge the pending question (requestId)
  // to its awaiting card (toolCallId); null keeps the generic modal so an
  // approval is never stranded without UI.
  const submitQuickActionDecision = useCallback(
    (requestId: string, decision: 'approve' | 'reject') => {
      void window.mousse.orchestrator
        .answerQuestions(requestId, { approval: decision })
        .then(() => {
          // `false` means the daemon no longer knows this question (answered
          // elsewhere, dismissed, timed out, or default-rejected by a
          // preempting send) — drop the stale prompt either way so an already
          // decided approval can never linger as answerable UI. A rejected
          // promise (IPC failure) keeps the prompt so input isn't lost.
          setPendingQuestions((current) =>
            current?.requestId === requestId ? null : current
          )
        })
        .catch(() => {})
    },
    []
  )
  const quickActionApproval = useMemo<QuickActionApproval | null>(() => {
    const match = findQuickActionCardForApproval(uiMessages, pendingQuestions)
    if (!match || !pendingQuestions) return null
    const requestId = pendingQuestions.requestId
    return {
      requestId,
      toolCallId: match.toolCallId,
      label: match.label,
      onApprove: () => submitQuickActionDecision(requestId, 'approve'),
      onReject: () => submitQuickActionDecision(requestId, 'reject'),
    }
  }, [pendingQuestions, uiMessages, submitQuickActionDecision])

  // The question tool replaces the composer while active: the input bar
  // collapses away and re-expands after submit. Both directions animate so
  // there is no layout jump. Inline quick-action approvals keep the composer
  // visible (the decision UI lives on the card itself).
  const showQuestions = Boolean(pendingQuestions && !quickActionApproval)
  useEffect(() => {
    if (!showQuestions) return
    setRenderQuestions(true)
    setQuestionsAnim('enter')
    const raf = requestAnimationFrame(() =>
      requestAnimationFrame(() => setQuestionsAnim('open'))
    )
    return () => cancelAnimationFrame(raf)
  }, [showQuestions, pendingRequestId])
  useEffect(() => {
    if (showQuestions || !renderQuestions) return
    setQuestionsAnim('leave')
    const timer = window.setTimeout(() => setRenderQuestions(false), 300)
    return () => window.clearTimeout(timer)
  }, [showQuestions, renderQuestions])
  const questionsSnapshot = showQuestions
    ? (questionsSnapshotRef.current ?? pendingQuestions)
    : (questionsSnapshotRef.current ?? null)
  const questionsOpen = renderQuestions && questionsAnim === 'open'
  useEffect(() => {
    if (!showQuestions) return
    const timer = window.setTimeout(() => {
      inputAreaRef.current
        ?.querySelector<HTMLElement>(
          '.composer-question-modal button:not([disabled]), .composer-question-modal input'
        )
        ?.focus()
    }, 320)
    return () => window.clearTimeout(timer)
  }, [showQuestions])
  useEffect(() => {
    if (showQuestions || renderQuestions) return
    const active = document.activeElement
    if (
      active === document.body ||
      (active instanceof HTMLElement &&
        inputAreaRef.current?.contains(active))
    ) {
      inputAreaRef.current
        ?.querySelector<HTMLElement>('.composer-input')
        ?.focus()
    }
  }, [showQuestions, renderQuestions])

  useEffect(() => {
    return () => {
      voiceMessages.forEach((v) => URL.revokeObjectURL(v.url))
      attachedFiles.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- cleanup on unmount only
  }, [])

  useEffect(() => {
    const unsub = window.mousse.orchestrator.onQuestionsPending((payload) => {
      if (!payload.threadId || payload.threadId === activeThreadId) {
        setPendingQuestions(payload)
      }
    })
    const unsubCleared = window.mousse.orchestrator.onQuestionsCleared((payload) => {
      if (!payload.threadId || payload.threadId === activeThreadId) {
        // The daemon resolved this prompt without us (answered elsewhere,
        // dismissed, timed out, or default-rejected by a preempting send).
        // Drop the stale modal/inline approval so the fresh user prompt —
        // now a visible message — is the only thing awaiting attention.
        setPendingQuestions((current) =>
          current?.requestId === payload.requestId ? null : current
        )
      }
    })
    const unsubConnection = window.mousse.orchestrator.onConnectionFailed(() => {
      setConnectionFailed(true)
    })
    return () => {
      unsub()
      unsubCleared()
      unsubConnection()
    }
  }, [activeThreadId])

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
    // Authoritative phase wins; activity fallback is for legacy threads without turnState.
    if (turnState) {
      const active = isTurnActivePhase(turnState.phase)
      if (requestId === turnActivityRequestRef.current) setLoading(active)
      return
    }
    if (activeThreadActivity === 'processing') {
      setLoading(true)
      return
    }
    try {
      const active = await window.mousse.orchestrator.isTurnActive(
        activeThreadId ?? undefined
      )
      if (requestId === turnActivityRequestRef.current) setLoading(active)
    } catch {
      // Keep prior loading state on transient IPC errors.
    }
  }, [activeThreadId, activeThreadActivity, turnState, setLoading])

  // Keep store loading in sync with authoritative turnState so spinner never outlives final message.
  useEffect(() => {
    if (!turnState) return
    const active = isTurnActivePhase(turnState.phase)
    // Sync store; optimistic true before phase arrives is allowed briefly.
    if (active !== loading) setLoading(active)
  }, [turnState, loading, setLoading])

  // Only re-probe on thread switch / this thread's activity changes — not every stream token.
  useEffect(() => {
    void refreshTurnActive()
  }, [activeThreadId, activeThreadActivity, turnState, refreshTurnActive])

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

  // A long tool loop can compact native context without adding a presentation message at
  // that exact boundary. Poll lightly while active so the ring drops from a stale 100%
  // even when streaming updates keep resetting the normal message-change debounce.
  useEffect(() => {
    if (!loading) return
    let cancelled = false
    const refresh = () => {
      void window.mousse.orchestrator
        .getContextUsage({ draftInput: buildMessageContent(), mode: chatMode })
        .then((usage) => {
          if (!cancelled) setContextUsage(usage)
        })
    }
    const interval = window.setInterval(refresh, 5_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [loading, chatMode, buildMessageContent])

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

  // Worktree toggle: new chats only (empty transcript), OFF by default.
  // Hidden for standalone threads (no project => no git worktree to provision).
  // Deliberately ignores `startedAt`: the daemon backfills it for merely-named
  // threads with zero messages, which are still new chats. The daemon
  // re-validates against the durable transcript + workspace state.
  const isNewChat = messages.length === 0
  const showWorktreeToggle = Boolean(isNewChat && activeThreadId && activeThread?.projectId)
  const worktreeEnabled = activeThread?.worktreeEnabled === true

  const handleWorktreeEnabledChange = useCallback(async (enabled: boolean) => {
    if (!activeThreadId) return
    const current = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
    if (current) {
      useAppStore.getState().upsertThread({
        ...current,
        worktreeEnabled: enabled ? true : undefined,
        updatedAt: new Date().toISOString()
      })
    }
    try {
      const updated = await window.mousse.threads.setWorktreeEnabled(activeThreadId, enabled)
      if (updated) useAppStore.getState().upsertThread(updated)
    } catch (error) {
      // Revert optimistic update on failure (e.g. workspace already provisioned).
      // Log loudly: a silently-reverting toggle looks like a dead button.
      console.error('[worktree-toggle] setWorktreeEnabled failed:', error)
      const latest = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
      if (latest && current) useAppStore.getState().upsertThread(current)
    }
  }, [activeThreadId])

  const handleSend = async () => {
    const text = buildMessageContent()
    const images = await filesToImagePayloads(attachedFiles.map((f) => f.file))
    const trimmed = text.trim()

    // Desktop-local commands must be handled before they can become an ordinary
    // agent prompt. The usage dialog intentionally contains every configured provider.
    if (trimmed.toLowerCase() === '/usage' && images.length === 0) {
      setInput('')
      window.dispatchEvent(new Event('mousse:open-usage'))
      return
    }

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

    // Worktree opt-in: provision the isolated workspace before the first turn
    // so tools run inside the worktree from the start. Failures fall back to
    // the primary checkout rather than blocking the send.
    if (worktreeEnabled && activeThreadId) {
      try {
        await window.mousse.workspace.restore(activeThreadId)
      } catch {
        // Provision errors (e.g. dirty primary checkout) leave the turn on the
        // primary checkout; the daemon surfaces the failure via workspace status.
      }
    }

    // Clear only after we accept the send/queue path (control commands already cleared above).
    clearComposer()
    await sendMessage(text, chatMode, images)
  }

  const handleModelSelect = async (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    setSelectedProviderId(providerId)
    setSelectedModelId(modelId)

    // Optimistic local meta so the composer badge updates before IPC returns.
    if (activeThreadId) {
      const current = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
      if (current) {
        useAppStore.getState().upsertThread({
          ...current,
          modelOverride: { llmProvider: providerId, model: modelId },
          updatedAt: new Date().toISOString()
        })
      }
    }

    // Persist the selection as the global default too, so a new chat opens on the
    // last used model instead of the first connected provider/model fallback.
    await window.mousse.settings.set({
      provider: { llmProvider: providerId, model: modelId }
    })

    if (activeThreadId) {
      const updated = await window.mousse.threads.setModel(activeThreadId, {
        llmProvider: providerId,
        model: modelId
      })
      if (updated) useAppStore.getState().upsertThread(updated)
    }
  }

  return (
    <div className="chat" style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <MousseAgentChatShell
        messages={uiMessages}
        status={chatStatus}
        onSend={() => void handleSend()}
        onStop={() => void handleStop()}
        quickActionApproval={quickActionApproval}
        composer={(
      <div
        ref={inputAreaRef}
        className={`chat-input-area${showQuestions ? ' has-questions' : ''}`}
      >
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
        <div
          className={`composer-question-swap${questionsOpen ? ' is-open' : ''}`}
          aria-hidden={!showQuestions || undefined}
        >
          <div className="composer-question-swap-inner">
            {renderQuestions && questionsSnapshot && !quickActionApproval && (
              <ComposerQuestionModal
                key={questionsSnapshot.requestId}
                pending={questionsSnapshot}
                onSubmit={(answers) => {
                  const requestId = questionsSnapshot.requestId
                  void window.mousse.orchestrator.answerQuestions(requestId, answers).then(() => {
                    // The daemon accepted the answers or no longer knows this
                    // question (answered elsewhere / expired / preempted) —
                    // either way the prompt is settled: drop it so a decided
                    // question can never linger as answerable UI. A rejected
                    // promise (IPC failure) keeps the modal so the answer
                    // isn't silently discarded.
                    setPendingQuestions((current) =>
                      current?.requestId === requestId ? null : current
                    )
                  })
                }}
                onDismiss={() => {
                  void window.mousse.orchestrator.dismissQuestions(questionsSnapshot.requestId)
                  setPendingQuestions(null)
                }}
              />
            )}
          </div>
        </div>

        <QueuedMessages
          threadId={activeThreadId}
          optimisticItems={optimisticQueueItems}
          onOptimisticItemReconciled={(id) => {
            setOptimisticQueueItems((current) => current.filter((item) => item.id !== id))
          }}
          onUseInComposer={(content) => setInput(content)}
        />

        <div
          className={`composer-collapse${showQuestions ? ' is-collapsed' : ''}`}
          aria-hidden={showQuestions || undefined}
          {...(showQuestions ? { inert: true } : {})}
        >
          <div className="composer-collapse-inner">
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
              loading={turnActive || loading}
              onSend={() => void handleSend()}
              onStop={() => void handleStop()}
              showWorktreeToggle={showWorktreeToggle}
              worktreeEnabled={worktreeEnabled}
              onWorktreeEnabledChange={(enabled) => void handleWorktreeEnabledChange(enabled)}
            />
          </div>
        </div>
      </div>
        )}
      />
    </div>
  )
}
