import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from 'ai'
import type { Thread } from '../../../shared/types'
import { isTurnActivePhase, isTurnStoppable, type TurnPhase } from '../../../shared/types'
import { sideChatsOf } from '../../../shared/threadLineage'
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import { openSettingsSection } from '../../lib/settingsNavigation'
import { pickedSelection, pickerModelId } from '../../../shared/modelSelection'
import type { LlmProviderOption } from '../../../shared/settings'
import { MMS_PROTOCOL_MAX_TEXT_LENGTH } from '../../../mms/protocol/types'
import { useAppStore } from '../../stores/appStore'
import { dropSentPrompt, loadSideChat, showSentPrompt, sideChatMessages, sideChatTitle, useOpenSideChat, useSideChatsStore, watchSideChats } from '../../stores/sideChatsStore'
import { MessagesSquare, Plus } from '../../lib/icons'
import { formatAgo } from '../../lib/formatAgo'
import { errorCodeOf } from '../../lib/threadSetup'
import { sendErrorLine } from '../../lib/errorText'
import { stopThreadNow } from '../../lib/stopThread'
import { composerFilePaths, prestageImages } from '../../lib/composerFilePaths'
import { preparedSend } from '../../lib/attachmentPreparation'
import { useAttachmentPreparation } from '../../hooks/useAttachmentPreparation'
import { pickerIdFor, pickerProviders, projectScope, useProviderSnapshots } from '../../lib/providerSnapshots'
import { MousseAgentChatShell } from '../../chat/components/MousseAgentChatShell'
import { chatStatusFromTurn, mousseToUIMessages, reuseUIMessages } from '../../chat/adapters/mousseToUI'
import { usePermissionRequests } from '../../hooks/usePermissionRequests'
import { usePendingQuestions } from '../../hooks/usePendingQuestions'
import { ChatComposer, buildComposerMessageContent, type AttachedFile, type VoiceMessage } from '../ChatComposer'
import { ComposerQuestionModal, describeAnswerOutcome } from '../ComposerQuestionModal'
import { ComposerNoticeProvider, ComposerNoticeSlot } from '../ComposerNotice'
import { ComputerNotice } from '../ComputerNotice'
import { CHAT_TOOL_RENDERERS } from '../automations/inbox/ChatDraftCard'
import '../sideCard/lineage.css'
import './sideChats.css'

const NO_VOICE: VoiceMessage[] = []
const NO_SKILLS: never[] = []
const NO_CONTEXT = { percent: 0, used: 0, limit: 0, modelName: null, source: 'estimated' as const, categories: [] }
/** Relative times are minutes-coarse: a slow tick keeps them fresh. */
const LIST_TICK_MS = 30_000

/**
 * The Side chats panel of the open thread: its side chats (forks of it that live only here), one of them open as a
 * chat, or the list. Nothing said here reaches the thread.
 */
export function SideChatsPanel() {
  const parent = useAppStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId))
  const parentId = parent?.id ?? null
  const open = useOpenSideChat(parentId)
  useEffect(() => watchSideChats(), [])
  if (!parent) return <div className="side-chats-panel"><p className="side-chats-note">Open a thread to ask on the side.</p></div>
  if (parent.node) return <div className="side-chats-panel"><p className="side-chats-note">Side chats are for threads on this computer.</p></div>
  return (
    <div className="side-chats-panel">
      {open
        ? <SideChatColumn key={open.id} thread={open} />
        : <SideChatList parentId={parent.id} />}
    </div>
  )
}

function SideChatList({ parentId }: { parentId: string }) {
  const threads = useAppStore((state) => state.threads)
  const chats = useMemo(() => sideChatsOf(parentId, threads), [parentId, threads])
  const [creating, setCreating] = useState(false)
  // A side chat forks a finished run: until the thread's first one ends there is nothing to fork, so New waits.
  const forkable = useAppStore((state) => {
    if (state.activeThreadId !== parentId) return true
    const asked = state.messages.filter((message) => message.role === 'user').length
    const phase = state.turnStates[parentId]?.phase
    return asked > 1 || (asked === 1 && !(phase && isTurnActivePhase(phase)))
  })
  const newTitle = forkable ? 'Fork this thread into a side chat' : 'Send this thread a message first'
  const [error, setError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), LIST_TICK_MS)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => setError(null), [parentId])

  const create = async () => {
    if (creating) return
    setCreating(true)
    setError(null)
    try {
      const { threadId } = await window.mousse.threads.newSideChat(parentId)
      if (useAppStore.getState().activeThreadId === parentId) useSideChatsStore.getState().open(parentId, threadId)
    } catch (caught) {
      setError(errorCodeOf(caught) === 'no_forkable_run' ? 'Nothing to fork yet: send this thread a message first.' : sendErrorLine(caught))
    } finally {
      setCreating(false)
    }
  }

  if (chats.length === 0) {
    return (
      <div className="side-chats-empty">
        <p>Ask on the side. Nothing here joins this thread.</p>
        <button type="button" className="side-chats-new" title={newTitle} disabled={creating || !forkable} onClick={() => void create()}>
          <Plus size={14} aria-hidden />
          <span>New side chat</span>
        </button>
        {error && <p className="side-chats-error" role="alert">{error}</p>}
      </div>
    )
  }
  return (
    <>
      <ul className="lineage-list side-chats-list" aria-label="Side chats">
        <li className="lineage-item">
          <button type="button" className="lineage-row side-chats-new-row" title={newTitle} disabled={creating || !forkable} onClick={() => void create()}>
            <span className="side-chats-icon"><Plus size={14} aria-hidden /></span>
            <span className="lineage-text"><span className="lineage-name">New side chat</span></span>
          </button>
        </li>
        {chats.map((chat) => {
          const title = sideChatTitle(chat)
          const updated = Date.parse(chat.updatedAt)
          return (
            <li key={chat.id} className="lineage-item">
              <button type="button" className="lineage-row" title={title} onClick={() => useSideChatsStore.getState().open(parentId, chat.id)}>
                <span className="side-chats-icon"><MessagesSquare size={14} aria-hidden /></span>
                <span className="lineage-text">
                  <span className="lineage-name">{title}</span>
                  {chat.lastReply && <span className="lineage-model">{chat.lastReply}</span>}
                </span>
                {Number.isFinite(updated) && <span className="lineage-status">{formatAgo(updated, now)}</span>}
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p className="side-chats-error" role="alert">{error}</p>}
    </>
  )
}

/** Where the fork starts: the time the side chat was made. */
function forkLine(thread: Thread): string {
  const at = new Date(thread.createdAt)
  return Number.isFinite(at.getTime())
    ? `Forked from this thread at ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : 'Forked from this thread'
}

function chatTurnPhase(phase: TurnPhase | undefined): TurnPhase | undefined {
  return phase === 'thinking' || phase === 'tool_running' || phase === 'finalizing' ? 'streaming' : phase
}

/** One side chat: the chat column's transcript and composer, for a thread that is not the open one. */
function SideChatColumn({ thread }: { thread: Thread }) {
  const threadId = thread.id
  const transcript = useSideChatsStore((state) => state.transcripts[threadId])
  useEffect(() => { void loadSideChat(threadId) }, [threadId])
  const messages = useMemo(() => sideChatMessages(transcript ?? []), [transcript])

  const turnPhase = useAppStore((state) => chatTurnPhase(state.turnStates[threadId]?.phase))
  const turnRunId = useAppStore((state) => state.turnStates[threadId]?.turnId)
  const turnState = useMemo(() => (turnPhase === undefined ? undefined : { phase: turnPhase, turnId: turnRunId ?? null }), [turnPhase, turnRunId])
  const [sending, setSending] = useState(false)
  const busy = sending || isTurnActivePhase(turnState?.phase ?? 'idle')
  const [error, setError] = useState<string | null>(null)

  const permissionRequests = usePermissionRequests(threadId, setError, describeAnswerOutcome)
  const [question, setQuestion] = usePendingQuestions(threadId)
  const uiMessages = useMemo(() => mousseToUIMessages(messages), [messages])
  const shownRef = useRef<UIMessage[]>([])
  const shown = useMemo(() => {
    const next = reuseUIMessages(shownRef.current, permissionRequests.place(uiMessages))
    shownRef.current = next
    return next
  }, [uiMessages, permissionRequests])
  const status = useMemo(() => chatStatusFromTurn(turnState), [turnState])

  const input = useAppStore((state) => state.composerDrafts[threadId] ?? '')
  const setInput = useCallback((value: string | ((current: string) => string)) => {
    const state = useAppStore.getState()
    const current = state.composerDrafts[threadId] ?? ''
    state.setComposerDraft(threadId, typeof value === 'function' ? value(current) : value)
  }, [threadId])
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([])
  // Images are made ready as they are attached; Send uses what was prepared.
  const preparation = useAttachmentPreparation(attachedFiles, false)
  // Every inline image also goes as its file: a pasted one is written now, so the send does not wait for it.
  useEffect(() => { prestageImages(attachedFiles, threadId) }, [attachedFiles, threadId])
  const attachRules = useMemo(() => ({ remote: false, onRefused: (line: string) => setError(line) }), [])

  // The model and mode the side chat runs on: its parent's when it was made, and its own once changed here.
  const [catalog, setCatalog] = useState<LlmProviderOption[]>([])
  const [defaultMode, setDefaultMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  useEffect(() => {
    let current = true
    void window.mousse.settings.getOptions().then((options) => { if (current) setCatalog(options.llmProviders) }).catch(() => undefined)
    void window.mousse.settings.get().then((settings) => { if (current) setDefaultMode(normalizePermissionMode(settings.permissions?.defaultMode)) }).catch(() => undefined)
    return () => { current = false }
  }, [])
  const { snapshots } = useProviderSnapshots(projectScope(thread.projectId))
  const providers = useMemo(() => pickerProviders(snapshots, catalog), [snapshots, catalog])
  const model = thread.modelOverride
  const selectedProviderId = model ? pickerIdFor({ instanceId: model.instanceId, llmProvider: model.llmProvider }, providers) : ''
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [contextOpen, setContextOpen] = useState(false)

  // The picker stays open on a model click; a level or speed in it closes it (`modelPickerRunSettings`).
  const selectModel = async (providerId: string, modelId: string) => {
    const provider = providers.find((entry) => entry.id === providerId)
    const instance = provider ? { ...(provider.instanceId ? { instanceId: provider.instanceId } : {}), llmProvider: provider.llmProvider } : { llmProvider: providerId }
    try {
      const updated = await window.mousse.threads.setModel(threadId, { ...instance, ...pickedSelection(modelId) })
      if (updated) useAppStore.getState().upsertThread(updated)
    } catch (caught) {
      setError(sendErrorLine(caught))
    }
  }
  const selectMode = async (mode: PermissionMode) => {
    try {
      const updated = await window.mousse.threads.setPermissionMode(threadId, mode)
      if (updated) useAppStore.getState().upsertThread(updated)
    } catch (caught) {
      setError(sendErrorLine(caught))
    }
  }

  const send = async () => {
    // The images as prepared when attached; one made smaller also goes as its original file.
    const prepared = preparedSend(attachedFiles, preparation.snapshot)
    if (!prepared) return
    const { files, images } = prepared
    let filePaths: Map<string, string>
    try {
      filePaths = await composerFilePaths(files, threadId)
    } catch (caught) {
      setError(sendErrorLine(caught))
      return
    }
    const content = buildComposerMessageContent(input, files, NO_VOICE, [], [], filePaths).trim()
    if (!content && images.length === 0) return
    if (content.length > MMS_PROTOCOL_MAX_TEXT_LENGTH) {
      setError('This message is too long. Attach it as a file instead.')
      return
    }
    const text = content || '[Image attachment]'
    setError(null)
    const sentFiles = attachedFiles
    // Not sent: the text and its files come back to the composer.
    const restoreUnsent = () => {
      setInput((current) => current || content)
      setAttachedFiles((current) => [...sentFiles, ...current])
    }
    setInput('')
    setAttachedFiles([])
    const shownId = busy ? null : showSentPrompt(threadId, text)
    setSending(true)
    try {
      const result = await window.mousse.orchestrator.sendToThread(threadId, {
        requestId: crypto.randomUUID(),
        content: text,
        mode: useAppStore.getState().chatMode,
        ...(images.length ? { images } : {})
      })
      if (result.error) {
        if (shownId) dropSentPrompt(threadId, shownId)
        if (result.requestAcknowledged === false) restoreUnsent()
        setError(sendErrorLine(result.error))
      } else if (result.queued && shownId) {
        dropSentPrompt(threadId, shownId)
      }
    } catch (caught) {
      if (shownId) dropSentPrompt(threadId, shownId)
      restoreUnsent()
      setError(sendErrorLine(caught))
    } finally {
      setSending(false)
    }
  }
  const stop = () => { void stopThreadNow(threadId) }

  return (
    <div className="chat side-chat" data-side-chat>
      <MousseAgentChatShell
        threadId={threadId}
        busy={busy}
        messages={shown}
        status={status}
        toolRenderers={CHAT_TOOL_RENDERERS}
        onSend={() => void send()}
        onStop={stop}
        permissionRequests={permissionRequests.controls}
        enableFind={false}
        beforeTurns={<p className="side-chat-fork">{forkLine(thread)}</p>}
        composer={(
          <div className="chat-input-area">
            <ComposerNoticeProvider>
              {error && <ComputerNotice message={error} onDismiss={() => setError(null)} />}
              {question && (
                <ComposerQuestionModal
                  key={question.requestId}
                  pending={question}
                  onSubmit={(answers, attachments) => {
                    const requestId = question.requestId
                    void window.mousse.orchestrator.answerQuestionsDetailed(requestId, answers, threadId, attachments).then((outcome) => {
                      setQuestion((current) => (current?.requestId === requestId ? null : current))
                      const refusal = describeAnswerOutcome(outcome)
                      if (refusal) setError(refusal)
                    })
                  }}
                  onDismiss={() => {
                    void window.mousse.orchestrator.dismissQuestions(question.requestId, threadId)
                    setQuestion(null)
                  }}
                />
              )}
              <ComposerNoticeSlot />
              <ChatComposer
                input={input}
                onInputChange={setInput}
                attachedFiles={attachedFiles}
                onAttachedFilesChange={setAttachedFiles}
                attachmentStatus={preparation.statuses}
                sendBlocked={preparation.blocked}
                attachRules={attachRules}
                messageLimit={MMS_PROTOCOL_MAX_TEXT_LENGTH}
                voiceMessages={NO_VOICE}
                onVoiceMessagesChange={() => undefined}
                enabledSkills={NO_SKILLS}
                disableSkillsPicker
                slashCommands={false}
                placeholder="Ask in this side chat"
                loading={busy}
                stoppable={busy || isTurnStoppable(turnState)}
                onSend={() => void send()}
                onStop={stop}
                run={{
                  providers,
                  selectedProviderId,
                  ...(model?.instanceId ? { selectedInstanceId: model.instanceId } : {}),
                  selectedModelId: model ? pickerModelId(model) : '',
                  modelMenuOpen,
                  onModelMenuOpenChange: setModelMenuOpen,
                  onModelSelect: (providerId, modelId) => void selectModel(providerId, modelId),
                  onOpenSettings: () => openSettingsSection('providers'),
                  contextUsage: NO_CONTEXT,
                  contextOpen,
                  onContextOpenChange: setContextOpen,
                  contextHidden: true
                }}
                permission={{ mode: normalizePermissionMode(thread.permissionMode ?? defaultMode), onSelect: (mode) => void selectMode(mode) }}
              />
            </ComposerNoticeProvider>
          </div>
        )}
      />
    </div>
  )
}
