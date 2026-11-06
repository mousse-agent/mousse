import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from '../lib/icons'
import { EmptyThreadAddProject, offersAddProject } from './EmptyThreadAddProject'
import { EmptyThreadHeading } from './EmptyThreadHeading'
import { emptyThreadHeadline } from '../utils/emptyThreadHeadline'
import type { LlmProviderOption } from '../../shared/settings'
import type {
  BrowserElementAttachment,
  ContextUsageSnapshot,
  PlanCardMetadata,
  PendingUserQuestions,
  QueuedMessage,
  SkillChatMode
} from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import { fileWorkspaceScope } from '../stores/filesStore'
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode, permissionCeilingOf, type PermissionMode } from '../../shared/permissionMode'
import { removeInlineSkillToken } from '../../shared/composerCommands'
import { runSlashCommand, type SlashCommandEnv } from '../lib/slashCommands'
import type { SkillDescriptor } from '../../shared/integrations'
import { isTurnActivePhase, isTurnStoppable } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useCommand } from '../commands/commandRegistry'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { QueuedMessages } from './QueuedMessages'
import {
  APPROVAL_COMPOSER_PLACEHOLDER,
  ComposerQuestionModal,
  QUESTION_COMPOSER_PLACEHOLDER,
  describeAnswerOutcome,
  questionComposerSend,
  type QuestionCardHandle
} from './ComposerQuestionModal'
import { filesToImagePayloads, imagePayloadToDataUrl, imagePayloadToFile, isImageMimeType } from '../utils/imageAttachments'
import { parseUserMessageContent } from '../utils/messageAttachments'
import { stripComposerTransportMarkers } from './QueuedMessages'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { createTurnActions, type TurnActions } from '../chat/components/agent-elements/turn-actions'
import { SubagentParentBar } from './SubagentParentBar'
import { SubagentComposerBanner } from './SubagentComposerBanner'
import { RemoteSubagentNotice } from './RemoteSubagentNotice'
import { ThreadMoveBanner } from './providers/MoveProviderDialog'
import { mousseToUIMessages, chatStatusFromTurn } from '../chat/adapters/mousseToUI'
import { useTurnSenders } from '../hooks/useTurnSenders'
import { usePermissionRequests } from '../hooks/usePermissionRequests'
import { isWaitingPermissionRequest, permissionRequestOptions } from '../chat/components/agent-elements/tools/permission-request'
import { usePendingRequestFocus } from '../stores/chatNavigationStore'
import { ApprovalNotice, DENY_AND_SEND_LABEL } from './ApprovalNotice'
import {
  findQuickActionCardForApproval,
  questionAnswerThreadId,
  type QuickActionApproval,
} from '../chat/components/agent-elements/tools/quick-action-approval'
import '../chat/components/agent-elements/agent-ui.css'
import type { NodeId } from '../../shared/net'
import { qualifyId } from '../../shared/threadRef'
import { prepareComposerThread } from '../lib/createComposerThread'
import { openRemoteProject, remoteErrorMessage, remotePermissionCeiling, remotePermissionView, workspaceOnDevice } from '../lib/remoteComputers'
import { UNKNOWN_COMPUTER_NAME, useComputer } from '../lib/computers'
import { useRemoteComposerOptions, useRunOnDevices } from '../hooks/useRunOnDevices'
import { localProjectsOf } from '../hooks/useLocalProjects'
import { localDeviceName, runOnLabel } from './sideCard/deviceMenu'
import { ComputerNotice } from './ComputerNotice'
import { ThreadComputerBar } from './ThreadComputerBar'
import { EarlierMessagesBar } from './EarlierMessagesBar'
import { forgetMessageImageRequests, hydrateMessageImages } from '../lib/messageImages'
import { isOutcomeUncertain, settleUncertainSend } from '../lib/uncertainSend'
import { SendRetryIds } from '../lib/sendRetryIds'
import { composerAutoModel, fallbackModel, onProviderListingsChanged, pickerOffers, pickerIdFor, pickerProviders, projectScope, useProviderSnapshots, type PickerSelection } from '../lib/providerSnapshots'
import { errorText, sendErrorLine } from '../lib/errorText'
import { PromptUndoNotice } from './PromptUndoControls'
import { pendingChangesDetails, type PendingChangesDetails } from '../../shared/workspace'
import { PendingChangesNotice } from './PendingChangesNotice'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from './ComposerNotice'
import { ServiceLostNotice } from './ServiceLostNotice'
import { PausedRunNotice } from '../chat/components/PausedRunNotice'
import { composerThreadActions } from '../lib/composerThreadActions'
import { composerWorkspaceFor, isComposerWorkspaceLocked, isNewEmptyThread, isWorkspacePending } from '../lib/newThread'
import { ComposerWorkspaceToolbar } from './ComposerWorkspaceToolbar'
import { ChatBrowserAccess } from './chats/ChatBrowserAccess'
import { extractChatReferences, type ChatReference } from '../../shared/chatReferences'
import { resolveChatReference, resolveChatReferences } from '../utils/chatLinks'
import { pickedSelection, pickerModelId } from '../../shared/modelSelection'
import '../styles/compact-composer.css'

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
const EMPTY_REFERENCES: ChatReference[] = []

/** Composer media (files/voice) cannot go in the persisted workspace store — File/Blob + object URLs. */
type ComposerMediaDraft = { files: AttachedFile[]; voice: VoiceMessage[] }
const EMPTY_COMPOSER_MEDIA: ComposerMediaDraft = { files: [], voice: [] }

function composerMediaKey(threadId: string | null): string {
  return threadId ?? '__blank__'
}

function releaseComposerMediaUrls(media: ComposerMediaDraft): void {
  media.files.forEach((file) => {
    if (file.previewUrl) URL.revokeObjectURL(file.previewUrl)
  })
  media.voice.forEach((voice) => URL.revokeObjectURL(voice.url))
}

/** One picker selection as a comparable string. */
function selectionKey(selection: { instanceId?: string; llmProvider: string; pickerId: string }): string {
  return `${selection.instanceId ?? ''}\u0000${selection.llmProvider}\u0000${selection.pickerId}`
}

/**
 * The model catalogue to keep after a read: the current one when the read returned the same providers
 * and models, so a repeated read does not hand the picker a new list.
 */
function keepCatalog(current: LlmProviderOption[], next: LlmProviderOption[]): LlmProviderOption[] {
  return JSON.stringify(current) === JSON.stringify(next) ? current : next
}

/** The thread's model is exactly the wanted one: the same account, model and reasoning level. */
function sameModel(
  has: { instanceId?: string; llmProvider: string; model: string; effort?: string } | undefined,
  wanted: { instanceId?: string; llmProvider: string; model: string; effort?: string }
): boolean {
  return !!has &&
    (has.instanceId ?? '') === (wanted.instanceId ?? '') &&
    has.llmProvider === wanted.llmProvider &&
    has.model === wanted.model &&
    (has.effort ?? '') === (wanted.effort ?? '')
}

export function OrchestratorChat() {
  const messages = useAppStore((s) => s.messages)
  const loading = useAppStore((s) => s.loading)
  const setLoading = useAppStore((s) => s.setLoading)
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen)
  const chatMode = useAppStore((s) => s.chatMode)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const profileReady = useAppStore((s) => s.profileReady)
  const workspaceReady = useAppStore((s) => s.workspaceReady)
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
  const threads = useAppStore((s) => s.threads)
  // The profile default, and the pick made on a blank composer before its thread exists.
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  const [blankPermissionMode, setBlankPermissionMode] = useState<PermissionMode | undefined>(undefined)
  const permissionMode = activeThread?.permissionMode ?? (activeThreadId ? undefined : blankPermissionMode) ?? defaultPermissionMode
  const permissionCeiling = permissionCeilingOf(activeThread, threads, defaultPermissionMode)
  const projects = useAppStore((s) => s.projects)
  const workspaceDraft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const setComposerWorkspaceDraft = useAppStore((s) => s.setComposerWorkspaceDraft)
  const worktreeByDefault = useAppStore((s) => s.worktreeByDefault)
  const workspace = composerWorkspaceFor(workspaceDraft, activeThread, worktreeByDefault)
  const localName = useAppStore((s) => localDeviceName(s.appInfo?.deviceName))
  const { devices: runOnDevices, notSharing, refresh: refreshRunOnDevices } = useRunOnDevices()
  const pickedDeviceName = runOnLabel(localName, runOnDevices, workspace.node)
  // Shared with quick actions and the side card, which also prepare or edit the new chat's workspace.
  const workspacePending = useAppStore(isWorkspacePending)
  const workspaceLocked = useAppStore(isComposerWorkspaceLocked)
  const newChat = isNewEmptyThread(activeThreadId, activeThread, messages.length)
  // Picked once per chat, so it holds while typing; another chat may get another line.
  const emptyHeadline = useMemo(() => emptyThreadHeadline(new Date(), activeThreadId ?? '__blank__'), [activeThreadId])
  const browserElements = useAppStore(
    (s) =>
      s.browserElementAttachmentsByThread[s.activeThreadId ?? '__standalone__'] ??
      EMPTY_BROWSER_ELEMENTS
  )
  const removeBrowserElement = useAppStore((s) => s.removeBrowserElementAttachment)
  const clearBrowserElements = useAppStore((s) => s.clearBrowserElementAttachments)

  const input = useAppStore(
    (s) => s.composerDrafts[s.activeThreadId ?? '__blank__'] ?? ''
  )
  const setComposerDraft = useAppStore((s) => s.setComposerDraft)
  const clearComposerDraft = useAppStore((s) => s.clearComposerDraft)
  const references = useAppStore((s) => s.composerReferences[s.activeThreadId ?? '__blank__'] ?? EMPTY_REFERENCES)
  const removeComposerReference = useAppStore((s) => s.removeComposerReference)
  const clearComposerReferences = useAppStore((s) => s.clearComposerReferences)
  const setInput = useCallback((value: string | ((current: string) => string)) => {
    const state = useAppStore.getState()
    const threadId = state.activeThreadId
    const current = state.composerDrafts[threadId ?? '__blank__'] ?? ''
    setComposerDraft(threadId, typeof value === 'function' ? value(current) : value)
  }, [setComposerDraft])
  const [catalog, setCatalog] = useState<LlmProviderOption[]>([])
  // The picker lists the instances the thread's project allows, from the daemon's snapshots.
  // A chat that runs on another computer (a new one for it, or one of its threads) offers that
  // computer's models, not this one's.
  const remoteDraft = newChat && Boolean(workspace.node)
  const remoteNode = (remoteDraft ? workspace.node : activeThread?.node) as NodeId | undefined
  const remoteOptions = useRemoteComposerOptions(remoteNode)
  const { snapshots: providerSnapshots } = useProviderSnapshots(projectScope(remoteNode ? undefined : workspace.projectId))
  const providers = useMemo(
    () => remoteNode ? pickerProviders(undefined, remoteOptions.providers) : pickerProviders(providerSnapshots, catalog),
    [remoteNode, remoteOptions.providers, providerSnapshots, catalog]
  )
  const remoteNodeRef = useRef(remoteNode)
  remoteNodeRef.current = remoteNode
  // `@` mentions search the thread's own checkout, or the project picked for a blank composer. The
  // project of a draft for another computer is named by its qualified id, which the daemon routes.
  const mentionProjectId = workspace.projectId
  const mentionThreadId = (remoteDraft ? undefined : activeThreadId) ?? undefined
  const searchMentions = useCallback(
    (query: string) => window.mousse.fs.search(query, { limit: 20 }, mentionProjectId ?? undefined, mentionThreadId),
    [mentionProjectId, mentionThreadId]
  )
  const mentionScope = useMemo(
    () => ({
      scopeKey: fileWorkspaceScope(profileId, mentionThreadId ?? null, mentionProjectId),
      threadId: mentionThreadId,
      projectId: mentionProjectId ?? undefined
    }),
    [profileId, mentionThreadId, mentionProjectId]
  )
  /** The selection a picker entry stores: its instance and the provider name that instance reports. */
  const selectionFor = (pickerId: string): { instanceId?: string; llmProvider: string } => {
    const provider = providers.find((entry) => entry.id === pickerId)
    return provider ? { ...(provider.instanceId ? { instanceId: provider.instanceId } : {}), llmProvider: provider.llmProvider } : { llmProvider: pickerId }
  }
  const [selectedLlmProvider, setSelectedLlmProvider] = useState('')
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | undefined>(undefined)
  const selectedProviderId = pickerIdFor({ instanceId: selectedInstanceId, llmProvider: selectedLlmProvider }, providers)
  const [selectedModelId, setSelectedModelId] = useState('')
  // The profile's default model, once settings are read; undefined until then.
  const [profileDefault, setProfileDefault] = useState<PickerSelection | undefined>(undefined)
  // With no thread model and no default the picker offers, the composer starts on the first ready
  // provider's model, and a send stamps it on the thread.
  const autoModel = useMemo(
    () => composerAutoModel({ remote: Boolean(remoteNode), threadModel: activeThreadModelOverride, profileDefault, providers }),
    [remoteNode, activeThreadModelOverride, profileDefault, providers]
  )
  // Also re-applied after a settings refresh puts the unusable default back.
  useEffect(() => {
    if (!autoModel) return
    setSelectedLlmProvider(autoModel.llmProvider)
    setSelectedInstanceId(autoModel.instanceId)
    setSelectedModelId(autoModel.model)
  }, [autoModel, selectedLlmProvider, selectedInstanceId, selectedModelId])
  const [enabledSkills, setEnabledSkills] = useState<SkillDescriptor[]>([])
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  // Pasted/dropped files and voice notes are kept per-thread in memory (not the
  // shared React state that used to leak screenshots into every other chat).
  const mediaByThreadRef = useRef<Record<string, ComposerMediaDraft>>({})
  const activeMediaKeyRef = useRef(composerMediaKey(activeThreadId))
  const [attachedFiles, setAttachedFilesState] = useState<AttachedFile[]>(
    () => mediaByThreadRef.current[activeMediaKeyRef.current]?.files ?? []
  )
  const [voiceMessages, setVoiceMessagesState] = useState<VoiceMessage[]>(
    () => mediaByThreadRef.current[activeMediaKeyRef.current]?.voice ?? []
  )
  const setAttachedFiles = useCallback(
    (update: AttachedFile[] | ((prev: AttachedFile[]) => AttachedFile[])) => {
      setAttachedFilesState((prev) => {
        const next = typeof update === 'function' ? update(prev) : update
        const key = activeMediaKeyRef.current
        const current = mediaByThreadRef.current[key] ?? EMPTY_COMPOSER_MEDIA
        mediaByThreadRef.current[key] = { files: next, voice: current.voice }
        return next
      })
    },
    []
  )
  const setVoiceMessages = useCallback(
    (update: VoiceMessage[] | ((prev: VoiceMessage[]) => VoiceMessage[])) => {
      setVoiceMessagesState((prev) => {
        const next = typeof update === 'function' ? update(prev) : update
        const key = activeMediaKeyRef.current
        const current = mediaByThreadRef.current[key] ?? EMPTY_COMPOSER_MEDIA
        mediaByThreadRef.current[key] = { files: current.files, voice: next }
        return next
      })
    },
    []
  )
  const [contextOpen, setContextOpen] = useState(false)
  const [contextUsage, setContextUsage] = useState<ContextUsageSnapshot>(EMPTY_CONTEXT_USAGE)
  const [pendingQuestions, setPendingQuestions] = useState<PendingUserQuestions | null>(null)
  const [connectionFailed, setConnectionFailed] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /** Discard for a send refused over a conflict in the thread worktree; shown only while `sendError` is that refusal’s line. */
  const [sendChanges, setSendChanges] = useState<{ line: string; message: string; details: PendingChangesDetails } | null>(null)
  const addResolvedReference = useCallback(async (reference: ChatReference) => {
    const expectedProfile = useAppStore.getState().profileId
    const expectedThread = useAppStore.getState().activeThreadId
    const resolved = await resolveChatReference(reference)
    const state = useAppStore.getState()
    if (state.profileId !== expectedProfile || state.activeThreadId !== expectedThread) return
    state.addComposerReference(expectedThread, resolved)
    setSendError(null)
  }, [])
  const sendIds = useRef(new SendRetryIds())
  const blankSendPending = useRef(false)
  useEffect(() => { setSendError(null); setSendChanges(null) }, [profileId, activeThreadId])
  const [optimisticQueueItems, setOptimisticQueueItems] = useState<QueuedMessage[]>([])
  const [lastSteer, setLastSteer] = useState<{ text: string; at: number } | null>(null)

  const turnActivityRequestRef = useRef(0)
  const [renderQuestions, setRenderQuestions] = useState(false)
  const [questionsAnim, setQuestionsAnim] = useState<'enter' | 'open' | 'leave'>('open')
  const questionsSnapshotRef = useRef(pendingQuestions)
  if (pendingQuestions) questionsSnapshotRef.current = pendingQuestions
  const pendingRequestId = pendingQuestions?.requestId
  const inputAreaRef = useRef<HTMLDivElement>(null)

  // Deterministic agent-elements adapter: sorted transcript -> UIMessage[]
  // No custom coalesce/grouping — MessageList handles turn grouping internally with stable keys.
  // A turn that a person on another of the user's computers sent says which one (the sender is kept on the run).
  const userTurns = useMemo(() => messages.reduce((count, message) => count + (message.role === 'user' && message.turnId ? 1 : 0), 0), [messages])
  const turnSenders = useTurnSenders(activeThreadId, Boolean(activeThread?.sentFrom && !activeThread.node), userTurns)
  // Permission requests show inline in the turn that asked them, with the answer they got; agent questions keep the dialog.
  const permissionRequests = usePermissionRequests(activeThreadId, setSendError, describeAnswerOutcome)
  const placePermissionRequests = permissionRequests.place
  const uiMessages = useMemo(() => mousseToUIMessages(messages, turnSenders), [messages, turnSenders])
  // Placed in a separate pass, so a permission request arriving or being answered does not convert the transcript again.
  const shownMessages = useMemo(() => placePermissionRequests(uiMessages), [uiMessages, placePermissionRequests])
  const approvalRequest = permissionRequests.current
  const approvalRowId = approvalRequest ? `permission:${approvalRequest.requestId}` : null
  const approvalPlaced = approvalRowId !== null && shownMessages.some((message) => message.id === approvalRowId)
  // `focusPendingRequest` from the sidebar: once this thread is open, show its waiting request in the transcript.
  usePendingRequestFocus(
    activeThreadId,
    approvalPlaced ? approvalRowId : (shownMessages.find(isWaitingPermissionRequest)?.id ?? null)
  )
  // The older images of a long thread of another computer come by name; their bytes are fetched as the thread is shown.
  const shownRemote = Boolean(activeThread?.node)
  // Opening a thread (also Retry, which opens it again) asks again for images that could not be fetched before.
  useEffect(() => {
    if (activeThreadId) forgetMessageImageRequests(activeThreadId)
  }, [activeThreadId, activeThread?.offline])
  useEffect(() => {
    if (shownRemote && activeThreadId) void hydrateMessageImages(activeThreadId)
  }, [shownRemote, activeThreadId, messages.length])
  const chatStatus = useMemo(() => chatStatusFromTurn(turnState), [turnState])
  const turnActive = isTurnActivePhase(turnState?.phase ?? 'idle')
  // Stop also ends a turn that waits on an approval or an answer (it closes the request).
  const turnStoppable = isTurnStoppable(turnState)
  // Up in an empty composer brings back the last prompt sent in this thread: its text, without attachments.
  const lastPrompt = useCallback(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!
      if (message.role !== 'user') continue
      const text = parseUserMessageContent(message.content).text
      if (text) return text
    }
    return undefined
  }, [messages])

  // Visible steer feedback: the daemon emits turn-steered when prompt text is
  // injected mid-turn. Show the steered text as a notice above the composer so
  // the steer is visible in the transcript even before the next drain.
  useEffect(() => {
    const unsub = window.mousse.orchestrator.onTurnSteered?.((payload) => {
      if (payload.threadId && payload.threadId !== activeThreadId) return
      if (!payload.text?.trim()) return
      setLastSteer({ text: payload.text.trim(), at: Date.now() })
    })
    return () => unsub?.()
  }, [activeThreadId])
  useEffect(() => {
    setLastSteer(null)
  }, [activeThreadId])
  // The "Steered" notice hides once the steered message lands in the transcript, or when the turn ends.
  useEffect(() => {
    if (!lastSteer) return
    if (!turnActive || messages.some((m) => m.role === 'user' && m.content.trim() === lastSteer.text)) {
      setLastSteer(null)
    }
  }, [messages, lastSteer, turnActive])

  // Quick-action approvals render inline on the PlanTool-style card instead
  // of the generic question modal. Bridge the pending question (requestId)
  // to its awaiting card (toolCallId); null keeps the generic modal so an
  // approval is never stranded without UI.
  const submitQuickActionDecision = useCallback(
    (requestId: string, questionThreadId: string | undefined, decision: 'approve' | 'reject') => {
      // The thread that asked, which may be on another computer; the shown one when it did not say.
      const threadId = questionAnswerThreadId({ threadId: questionThreadId }, useAppStore.getState().activeThreadId)
      void window.mousse.orchestrator
        .answerQuestions(requestId, { approval: decision }, threadId)
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
    const match = findQuickActionCardForApproval(shownMessages, pendingQuestions)
    if (!match || !pendingQuestions) return null
    const { requestId, threadId } = pendingQuestions
    return {
      requestId,
      toolCallId: match.toolCallId,
      label: match.label,
      onApprove: () => submitQuickActionDecision(requestId, threadId, 'approve'),
      onReject: () => submitQuickActionDecision(requestId, threadId, 'reject'),
    }
  }, [pendingQuestions, shownMessages, submitQuickActionDecision])

  // The question card opens above the composer, which stays usable: a message sent while the
  // questions are open answers the one the card shows. The card's height animates in and out so there
  // is no layout jump. Inline quick-action approvals have no card (the decision UI lives on the card itself).
  const showQuestions = Boolean(pendingQuestions && !quickActionApproval)
  // Agent questions (not an approval request, whose message denies it) take the composer's message as an answer.
  const questionsTakeMessage = showQuestions && !pendingQuestions?.approval
  // The card's handle for answering its shown question, and whether that answer would be the last one (and submit).
  const questionCardRef = useRef<QuestionCardHandle | null>(null)
  const [questionAnswerSubmits, setQuestionAnswerSubmits] = useState(false)
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
      // Someone typing in the composer keeps it; an empty, unfocused composer hands focus to the first choice.
      const composerInput = inputAreaRef.current?.querySelector<HTMLTextAreaElement>('.composer-input')
      if (composerInput && (document.activeElement === composerInput || composerInput.value.trim())) return
      inputAreaRef.current
        ?.querySelector<HTMLElement>(
          '.composer-question-modal .composer-question-choice[tabindex="0"]'
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

  // Swap staged media with the thread, matching composerDrafts / browser chips.
  useEffect(() => {
    const nextKey = composerMediaKey(activeThreadId)
    const prevKey = activeMediaKeyRef.current
    if (nextKey === prevKey) return
    // Current thread's files/voice are already mirrored into the map by the
    // setters; only the displayed state needs to change.
    activeMediaKeyRef.current = nextKey
    const restored = mediaByThreadRef.current[nextKey] ?? EMPTY_COMPOSER_MEDIA
    setAttachedFilesState(restored.files)
    setVoiceMessagesState(restored.voice)
  }, [activeThreadId])

  useEffect(() => {
    return () => {
      for (const media of Object.values(mediaByThreadRef.current)) {
        releaseComposerMediaUrls(media)
      }
      mediaByThreadRef.current = {}
    }
  }, [])

  useEffect(() => {
    const unsub = window.mousse.orchestrator.onQuestionsPending((payload) => {
      // A permission request is answered inline in the transcript (usePermissionRequests), never in the dialog.
      if (permissionRequestOptions(payload)) return
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
    if (!profileReady) return
    const skillsRequest = window.mousse.skills.list()
    // Rejection is still surfaced by the await below; this only avoids an
    // unhandled rejection when the settings requests fail first.
    skillsRequest.catch(() => undefined)
    // Show the model as soon as settings/options arrive; skill discovery is slower.
    const [settings, options] = await Promise.all([
      window.mousse.settings.get(),
      window.mousse.settings.getOptions()
    ])
    setCatalog((current) => keepCatalog(current, options.llmProviders))
    setDefaultPermissionMode(normalizePermissionMode(settings.permissions?.defaultMode))
    const selectedModel = activeThreadModelOverride ?? settings.provider
    setProfileDefault((current) =>
      current?.llmProvider === settings.provider.llmProvider &&
      current.instanceId === settings.provider.instanceId &&
      current.model === settings.provider.model
        ? current
        : { ...settings.provider }
    )
    // The picker shows the other computer's model while a chat that runs there is open.
    if (!remoteNodeRef.current) {
      setSelectedLlmProvider(selectedModel.llmProvider)
      setSelectedInstanceId(selectedModel.instanceId)
      setSelectedModelId(pickerModelId(selectedModel))
    }

    const skillsSnapshot = await skillsRequest
    const enabled = new Set(settings.integrations.skills.enabledSkills)
    setEnabledSkills(
      skillsSnapshot.skills.filter(
        (skill) =>
          skill.isActive !== false &&
          (enabled.size === 0 || enabled.has(skill.id) || enabled.has(skill.name))
      )
    )
    // activeThreadId: project-scoped skills follow the active thread, so a
    // snapshot fetched for another thread goes stale on switch.
  }, [activeThreadModelOverride, activeThreadId, profileReady, profileId])

  // Picking a computer swaps the picker to its default model (or its first usable one, as on this
  // computer); coming back restores this computer's. A thread of another computer shows the model it
  // has there. That computer is asked again (on focus, after a failed read): an answer that only
  // changes its default keeps a model the person picked meanwhile.
  const remoteDefault = remoteOptions.defaultModel
  const remoteDefaultKey = remoteDefault ? JSON.stringify(remoteDefault) : ''
  const remoteDefaultRef = useRef(remoteDefault)
  remoteDefaultRef.current = remoteDefault
  const providersRef = useRef(providers)
  providersRef.current = providers
  const shownSelectionRef = useRef('')
  shownSelectionRef.current = selectionKey({ instanceId: selectedInstanceId, llmProvider: selectedLlmProvider, pickerId: selectedModelId })
  const remoteAppliedRef = useRef<{ context: string; shown: string } | undefined>(undefined)
  const refreshSelectionRef = useRef(refreshSelection)
  refreshSelectionRef.current = refreshSelection
  // Coming back from another computer reads this computer's settings again. The read also replaces the
  // model catalogue, which `providers` is built from, so this runs on a change of computer only: keyed on
  // `providers` it re-read settings after every read, without end. The first read is the settings effect's.
  const wasRemoteRef = useRef(false)
  useEffect(() => {
    if (remoteNode) {
      wasRemoteRef.current = true
      return
    }
    remoteAppliedRef.current = undefined
    if (!wasRemoteRef.current) return
    wasRemoteRef.current = false
    void refreshSelectionRef.current()
  }, [remoteNode])
  useEffect(() => {
    if (!remoteNode || !remoteOptions.loaded) return
    const own = remoteDraft ? undefined : activeThreadModelOverride
    const remote = remoteDefaultRef.current
    const known = remote?.llmProvider ? { ...remote, llmProvider: remote.llmProvider } : undefined
    const pick = own ?? (known && pickerOffers(known, providersRef.current) ? known : fallbackModel(providersRef.current))
    const context = `${remoteNode}\u0000${remoteDraft}\u0000${own ? JSON.stringify(own) : ''}`
    const applied = remoteAppliedRef.current
    if (applied?.context === context && applied.shown !== shownSelectionRef.current) return
    setSelectedLlmProvider(pick?.llmProvider ?? '')
    setSelectedInstanceId(pick?.instanceId)
    setSelectedModelId(pick ? pickerModelId(pick) : '')
    remoteAppliedRef.current = {
      context,
      shown: pick ? selectionKey({ instanceId: pick.instanceId, llmProvider: pick.llmProvider, pickerId: pickerModelId(pick) }) : selectionKey({ llmProvider: '', pickerId: '' })
    }
  }, [remoteNode, remoteDraft, remoteOptions.loaded, remoteDefaultKey, activeThreadModelOverride, providers])

  useEffect(() => {
    void refreshSelection()
    const unsubSettings = window.mousse.settings.onChanged(() => {
      void refreshSelection()
    })
    // A provider change can only change the model catalogue: read that alone, newest reply kept.
    let catalogRequest = 0
    const unsubProviders = onProviderListingsChanged(() => {
      const request = ++catalogRequest
      void window.mousse.settings
        .getOptions()
        .then((options) => {
          if (request === catalogRequest) setCatalog((current) => keepCatalog(current, options.llmProviders))
        })
        .catch(() => undefined)
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
    const raw = buildComposerMessageContent(input, attachedFiles, voiceMessages, browserElements, references)
    // An inline `@skill` token rides in the typed text: strip it, the skill
    // travels as the per-message mode override instead.
    return removeInlineSkillToken(raw, enabledSkills)
  }, [attachedFiles, browserElements, enabledSkills, input, voiceMessages, references])

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

  // Prefer the closed-over file list so a post-send `clearComposer(false)` +
  // success-path revoke still frees the object URLs that were staged for that send
  // (the per-thread map entry is already empty by then).
  const releaseComposerUrls = useCallback(() => {
    releaseComposerMediaUrls({ files: attachedFiles, voice: voiceMessages })
  }, [attachedFiles, voiceMessages])

  const clearComposer = useCallback((releaseUrls = true) => {
    clearComposerDraft(activeThreadId)
    const currentThreadId = useAppStore.getState().activeThreadId
    clearComposerDraft(currentThreadId)
    clearComposerReferences(currentThreadId)
    clearBrowserElements(currentThreadId)
    setComposerWorkspaceDraft(currentThreadId)
    // Clear the media bucket currently on screen (may still be `__blank__` while a
    // first-send thread is being created).
    const key = activeMediaKeyRef.current
    mediaByThreadRef.current[composerMediaKey(activeThreadId)] = { files: [], voice: [] }
    setComposerWorkspaceDraft(activeThreadId)
    if (releaseUrls) releaseComposerUrls()
    mediaByThreadRef.current[key] = { files: [], voice: [] }
    // Drop a leftover blank bucket after blank → thread promotion so those
    // screenshots cannot reappear if the user opens a fresh blank composer.
    if (key !== '__blank__') {
      const blank = mediaByThreadRef.current.__blank__
      if (blank && (blank.files.length > 0 || blank.voice.length > 0)) {
        if (releaseUrls) releaseComposerMediaUrls(blank)
        delete mediaByThreadRef.current.__blank__
      }
    }
    setAttachedFilesState([])
    setVoiceMessagesState([])
    clearBrowserElements(activeThreadId)
    clearComposerReferences(activeThreadId)
  }, [releaseComposerUrls, activeThreadId, clearBrowserElements, clearComposerDraft, clearComposerReferences, setComposerWorkspaceDraft])

  const sendMessage = useCallback(
    async (
      content: string,
      mode = chatMode,
      images?: Awaited<ReturnType<typeof filesToImagePayloads>>,
      targetThreadId = activeThreadId,
      /** Puts the staged text, files and references back, for a message that turns out not to have arrived. */
      onUnsent?: () => void
    ) => {
      if (!content && !(images && images.length)) return

      setConnectionFailed(false)
      setSendError(null)
      const stillVisible = () => useAppStore.getState().profileId === profileId && useAppStore.getState().activeThreadId === targetThreadId
      // Keep retry identities across navigation without retaining message/image bodies.
      const bytes = new TextEncoder().encode(JSON.stringify({ profileId, threadId: targetThreadId, content, mode, images }))
      const signature = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('')
      if (!stillVisible()) return
      // The service's retry key: a send that may have arrived lends its id to the same message sent again.
      const requestId = sendIds.current.begin(signature)
      const request = {
        requestId,
        content: content || (images?.length ? '[Image attachment]' : ''),
        mode,
        images
      }
      // Paint an ordinary send before IPC/disk/provider work. The App event handler swaps this
      // row for the durable message by matching its content; stale hydration snapshots retain it.
      // The messages the transcript had before this one, to tell it from an identical one sent earlier.
      const seenBefore = new Set(useAppStore.getState().messages.map((message) => message.id))
      const optimisticMessageId = !loading && targetThreadId
        ? `optimistic:${crypto.randomUUID()}`
        : null
      if (optimisticMessageId) {
        useAppStore.getState().addMessage({
          id: optimisticMessageId,
          role: 'user',
          content: request.content,
          timestamp: new Date().toISOString(),
          images
        })
      }
      const optimisticQueueId = loading && targetThreadId ? `optimistic:${crypto.randomUUID()}` : null
      if (optimisticQueueId && targetThreadId) {
        setOptimisticQueueItems((current) => [...current, {
          id: optimisticQueueId,
          threadId: targetThreadId,
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
      // Promote drafts immediately and pin the thread to the top of its group
      // on user send. Agent streaming must not change sidebar order.
      if (targetThreadId) {
        const store = useAppStore.getState()
        const current = store.threads.find((t) => t.id === targetThreadId)
        if (current && !current.settledAt) {
          const siblings = store.threads.filter(
            (entry) => (entry.projectId ?? null) === (current.projectId ?? null) && !entry.settledAt
          )
          const minOrder = siblings.reduce((min, entry) => Math.min(min, entry.order), current.order)
          store.upsertThread({
            ...current,
            startedAt: current.startedAt ?? new Date().toISOString(),
            order: current.order === minOrder ? current.order : minOrder - 1
          })
        }
      }
      try {
        const result = await (targetThreadId
          ? window.mousse.orchestrator.sendToThread(targetThreadId, request)
          : window.mousse.orchestrator.send(request)
        ).finally(() => sendIds.current.replied(requestId))
        if (result.error && result.requestAcknowledged === false) throw result.error
        sendIds.current.settle(signature, requestId, 'answered')
        if (!stillVisible()) return
        // Queued sends return quickly while an earlier turn remains active — do not clear loading.
        if (optimisticQueueId) {
          setOptimisticQueueItems((current) => [
            ...current.filter((item) => item.id !== optimisticQueueId),
            ...(result.queued && result.queueItem ? [result.queueItem] : [])
          ])
        }
        // A message sent while a run is paused by a usage limit waits in the queue: it is shown there, not in the transcript.
        if (result.heldByPause && optimisticMessageId) {
          const current = useAppStore.getState().messages
          useAppStore.getState().setMessages(current.filter((message) => message.id !== optimisticMessageId))
          if (result.queueItem) {
            const held = result.queueItem
            setOptimisticQueueItems((items) => [...items.filter((item) => item.id !== held.id), held])
          }
        }
        if (result.error) {
          // A failed turn shows its error in the transcript, with Retry. Only a lost connection to the service is a notice here.
          if (result.error.code === 'workspace_connection_lost') setSendError(sendErrorLine(result.error))
          const stillActive = await window.mousse.orchestrator.isTurnActive(targetThreadId ?? undefined).catch(() => false)
          if (stillVisible()) setLoading(stillActive)
          // Admission succeeded: the prompt is already saved in the transcript.
          return true
        }
        if (result.queued) {
          const stillActive = await window.mousse.orchestrator.isTurnActive(
            targetThreadId ?? undefined
          ).catch(() => true)
          if (stillVisible()) setLoading(stillActive)
          return true
        }

        const stillActive = await window.mousse.orchestrator.isTurnActive(
          targetThreadId ?? undefined
        ).catch(() => true)
        if (stillVisible()) setLoading(stillActive)
        return true
      } catch (error) {
        // A send the service refused ran nothing: the same text sent again is a new message. One with no
        // answer (a timeout, another computer that did not confirm) keeps its id, so sending it again replays it.
        sendIds.current.settle(signature, requestId, isOutcomeUncertain(error) ? 'unknown' : 'refused')
        if (!stillVisible()) return
        setSendError(sendErrorLine(error))
        const changes = pendingChangesDetails(error)
        setSendChanges(changes ? { line: sendErrorLine(error), message: errorText(error), details: changes } : null)
        if (isOutcomeUncertain(error) && targetThreadId) {
          // No answer came (another computer did not confirm, or the reply timed out): the message may be there. Keep what is shown, read the thread again,
          // and only then say whether it arrived. Sending the same text again replays this request, so it cannot run twice.
          const thread = targetThreadId
          void settleUncertainSend({
            refresh: () => window.mousse.threads.select(thread),
            arrived: async () => {
              if (optimisticQueueId) return (await window.mousse.queue.list(thread)).some((item) => item.content === request.content)
              return useAppStore.getState().messages.some((message) =>
                message.role === 'user' && !message.id.startsWith('optimistic:') && !seenBefore.has(message.id) && message.content === request.content)
            },
            dropOptimistic: () => {
              if (optimisticQueueId) setOptimisticQueueItems((current) => current.filter((item) => item.id !== optimisticQueueId))
              if (optimisticMessageId) {
                const messagesNow = useAppStore.getState().messages
                useAppStore.getState().setMessages(messagesNow.filter((message) => message.id !== optimisticMessageId))
              }
            }
          }).then((outcome) => {
            // It arrived: the same text sent later is a new message, not a repeat of this one.
            sendIds.current.settle(signature, requestId, outcome === 'arrived' ? 'arrived' : 'unknown')
            if (!stillVisible()) return
            if (outcome === 'missing') {
              setSendError(`${sendErrorLine(error)} It did not arrive, so it is back in the composer.`)
              setInput((current) => current || extractChatReferences(content).text)
              onUnsent?.()
            } else if (outcome === 'arrived') setSendError(null)
          })
          return 'uncertain' as const
        }
        setInput((current) => current || extractChatReferences(content).text)
        if (optimisticQueueId) {
          setOptimisticQueueItems((current) => current.filter((item) => item.id !== optimisticQueueId))
        }
        if (optimisticMessageId) {
          const current = useAppStore.getState().messages
          useAppStore.getState().setMessages(current.filter((message) => message.id !== optimisticMessageId))
        }
        const stillActive = await window.mousse.orchestrator.isTurnActive(
          targetThreadId ?? undefined
        ).catch(() => false)
        if (stillVisible()) setLoading(stillActive)
        return false
      }
    },
    [activeThreadId, profileId, chatMode, loading, setLoading]
  )

  const handleStop = useCallback(async () => {
    await window.mousse.orchestrator.abort(activeThreadId ?? undefined)
    await refreshTurnActive()
  }, [activeThreadId, refreshTurnActive])
  // Stop run is bound to a key; the command's own rule limits it to a thread with a run going.
  useCommand('run.stop', () => void handleStop())

  // Retry and Continue on the last turn send through the normal path, never while a run is going.
  const resendBusy = turnActive || loading
  const turnActions = useMemo<TurnActions | null>(() => {
    if (!activeThreadId) return null
    return createTurnActions({
      // Read at use: depending on the transcript would rebuild this on every streamed token.
      prompt: (promptId) => useAppStore.getState().messages.find((message) => message.id === promptId && message.role === 'user'),
      send: (content, images) => {
        if (resendBusy || !useAppStore.getState().workspaceReady) return
        void sendMessage(content, chatMode, images, activeThreadId)
      }
    })
  }, [activeThreadId, resendBusy, sendMessage, chatMode])

  // What composer commands act on: this thread (none yet on a blank chat) and whether a turn is running.
  const slashCommandEnv = (hasAttachments: boolean): SlashCommandEnv => ({
    threadId: newChat ? null : activeThreadId,
    turnActive: turnActive || loading,
    hasAttachments,
    openUsage: () => window.dispatchEvent(new Event('mousse:open-usage')),
    stop: handleStop,
    steer: (text) => window.mousse.orchestrator.steer(text, activeThreadId ?? undefined),
    newThread: async (title) => { await window.mousse.threads.createAndSelect(title) },
    clearContext: async (threadId) => { await window.mousse.threads.clearContext(threadId) },
    compact: async (threadId, focus) => { await window.mousse.threads.compact(threadId, focus) },
    fork: async (threadId) => { await window.mousse.threads.fork(threadId) },
    rename: async (threadId, title) => { await window.mousse.threads.rename(threadId, title) },
    // The sidebar cancels the event when it opened the thread's rename box.
    openRename: (threadId) => !window.dispatchEvent(new CustomEvent('mousse:rename-thread', { detail: { threadId }, cancelable: true }))
  })

  const handleSend = async (skillMode?: SkillChatMode, options?: { steer?: boolean }) => {
    if (!useAppStore.getState().workspaceReady) return
    // Lock before file decoding: a double click on the blank composer must not
    // create two threads or submit the same first message twice.
    if (blankSendPending.current) return
    const startingBlank = newChat
    let targetThreadId = activeThreadId
    // A quick action may already be preparing this new chat; a second send would create another thread.
    if (startingBlank && isWorkspacePending(useAppStore.getState())) return
    if (startingBlank) {
      blankSendPending.current = true
      useAppStore.getState().setWorkspacePending(profileId, activeThreadId, true)
    }
    const releaseWorkspacePending = () => {
      if (!startingBlank) return
      blankSendPending.current = false
      const store = useAppStore.getState()
      store.setWorkspacePending(profileId, activeThreadId, false)
      store.setWorkspacePending(profileId, targetThreadId, false)
    }
    const stillVisible = () => useAppStore.getState().profileId === profileId && useAppStore.getState().activeThreadId === targetThreadId
    try {
    const resolutionProfile = profileId
    const resolutionThread = activeThreadId
    const resolvedReferences = await resolveChatReferences(references)
    if (useAppStore.getState().profileId !== resolutionProfile || useAppStore.getState().activeThreadId !== resolutionThread) return
    let text = removeInlineSkillToken(
      buildComposerMessageContent(input, attachedFiles, voiceMessages, browserElements, resolvedReferences),
      enabledSkills
    )
    const images = await filesToImagePayloads(attachedFiles.map((f) => f.file))
    if (!stillVisible()) return
    const trimmed = text.trim()

    // Composer commands run here before they can become an ordinary agent prompt
    // (`lib/slashCommands.ts`). The usage dialog intentionally contains every configured provider.
    const attached = images.length > 0 || attachedFiles.length > 0 || voiceMessages.length > 0 || browserElements.length > 0 || resolvedReferences.length > 0
    const command = await runSlashCommand(trimmed, slashCommandEnv(attached))
    if (command) {
      if (command.kind === 'done') {
        setInput('')
        return
      }
      if (command.kind === 'keep') return
      if (command.kind === 'refused') {
        if (stillVisible()) setSendError(command.message)
        return
      }
      // A /steer no turn took: next-turn guidance, sent as an ordinary message.
      text = command.text
    } else if (options?.steer && !skillMode && images.length === 0 && trimmed && !trimmed.startsWith('/')) {
      // Alt+Enter during a run: the text goes into the running turn instead of the queue.
      const steered = await window.mousse.orchestrator.steer(trimmed, activeThreadId ?? undefined)
      if (steered) {
        clearComposer()
        return
      }
      // The turn ended meanwhile: send it like Enter would.
    }

    if (!text && images.length === 0) return

    // Questions open above the composer: the message answers the question the card shows, and the card
    // moves on to the next unanswered one. Answering the last one submits all the answers, once.
    // A message with images cannot be an answer; it is sent as usual, which skips the questions.
    const asked = questionsTakeMessage ? pendingQuestions : null
    const card = questionCardRef.current
    if (asked && card && text && questionComposerSend(images.length > 0, false).answers) {
      const answers = card.answerWithMessage(text)
      if (!answers) {
        clearComposer()
        return
      }
      const outcome = await window.mousse.orchestrator.answerQuestionsDetailed(
        asked.requestId,
        answers,
        questionAnswerThreadId(asked, activeThreadId)
      )
      setPendingQuestions((current) => (current?.requestId === asked.requestId ? null : current))
      if (outcome.ok) {
        clearComposer()
        return
      }
      // Another client answered first or the request was closed: say so and keep the message.
      const refusal = describeAnswerOutcome(outcome)
      if (refusal) {
        setSendError(refusal)
        return
      }
      // The questions closed before the answer arrived: the message goes to the thread as usual.
      if (!stillVisible()) return
    }

    if (newChat) {
      // Apply this draft's workspace before sending; a project change creates a
      // new hidden draft instead of moving another thread's transcript storage.
      const id = await prepareComposerThread({
        thread: activeThread,
        workspace,
        ...composerThreadActions(),
        stillVisible,
        activate: (thread) => {
          const store = useAppStore.getState()
          store.upsertThread(thread)
          // Move the staged prompt and media with this draft when its project changes.
          // A selection/model failure must leave the prompt recoverable on the new thread.
          store.setComposerDraft(thread.id, input)
          store.clearComposerDraft(activeThreadId)
          references.forEach((reference) => store.addComposerReference(thread.id, reference))
          store.clearComposerReferences(activeThreadId)
          browserElements.forEach((element) => store.addBrowserElementAttachment(thread.id, element))
          store.clearBrowserElementAttachments(activeThreadId)
          store.setComposerWorkspaceDraft(activeThreadId)
          mediaByThreadRef.current[thread.id] = { files: attachedFiles, voice: voiceMessages }
          mediaByThreadRef.current[composerMediaKey(activeThreadId)] = { files: [], voice: [] }
          activeMediaKeyRef.current = thread.id
          targetThreadId = thread.id
          store.setWorkspacePending(profileId, thread.id, true)
          store.switchToThread(thread.id)
        }
      })
      if (!id) return
      if (!stillVisible()) return
      // Blank composer keeps model in local state only. Stamp it onto the new
      // thread before the first turn so the pick survives without touching the
      // shared settings default used by other threads.
      // Skipped when the new thread already has exactly that model (account, model and level): on
      // another computer each call is a round trip the first message would wait for.
      const wanted = selectedProviderId && selectedModelId
        ? { ...selectionFor(selectedProviderId), ...pickedSelection(selectedModelId) }
        : undefined
      const stamped = useAppStore.getState().threads.find((entry) => entry.id === id)?.modelOverride
      if (wanted && !sameModel(stamped, wanted)) {
        const updated = await window.mousse.threads.setModel(id, wanted)
        if (!stillVisible()) return
        if (updated) useAppStore.getState().upsertThread(updated)
      }
      // The same for a permission mode picked before the thread existed.
      if (blankPermissionMode) {
        const updated = await window.mousse.threads.setPermissionMode(id, blankPermissionMode)
        if (!stillVisible()) return
        setBlankPermissionMode(undefined)
        if (updated) useAppStore.getState().upsertThread(updated)
      }
    } else if (autoModel && activeThreadId) {
      // A thread without a model of its own would run on the unusable default: give it the shown one.
      const updated = await window.mousse.threads.setModel(activeThreadId, autoModel)
      if (!stillVisible()) return
      if (updated) useAppStore.getState().upsertThread(updated)
    }

    // Clear only after we accept the send/queue path (control commands already cleared above).
    // A skill chip attached in the composer applies to this prompt only —
    // the global chat mode is left untouched.
    clearComposer(false)
    // Thread preparation is complete. The send promise lasts for the entire
    // first turn, so it must not keep typing, queueing, or Stop disabled.
    releaseWorkspacePending()
    const restoreUnsent = () => {
      setInput((current) => current === text || !current ? input : current)
      setAttachedFiles((current) => [...attachedFiles, ...current])
      setVoiceMessages((current) => [...voiceMessages, ...current])
      browserElements.forEach((element) => useAppStore.getState().addBrowserElementAttachment(targetThreadId, element))
      resolvedReferences.forEach((reference) => useAppStore.getState().addComposerReference(targetThreadId, reference))
    }
    const sent = await sendMessage(text, skillMode ?? chatMode, images, targetThreadId, restoreUnsent)
    if (sent === false && stillVisible()) {
      restoreUnsent()
    } else if (sent !== 'uncertain') {
      // An unconfirmed send keeps its files: they come back with the text if it did not arrive.
      releaseComposerUrls()
    }
    } catch (error) {
      // Creation and image decoding happen before clearing the draft.
      if (stillVisible()) {
        setSendError(sendErrorLine(error))
        setLoading(false)
      }
    } finally {
      releaseWorkspacePending()
    }
  }

  const handleModelSelect = async (providerId: string, modelId: string) => {
    setModelMenuOpen(false)
    const instance = selectionFor(providerId)
    setSelectedLlmProvider(instance.llmProvider)
    setSelectedInstanceId(instance.instanceId)
    setSelectedModelId(modelId)
    // Stored as the model and its level apart; no level is the model's default.
    const pick = pickedSelection(modelId)

    // Persist as last-used default for new threads. Existing chats keep their
    // own modelOverride, which is stamped at create time from this value.
    if (!activeThreadId) {
      // A chat for another computer takes its model there; this computer's default stays as it is.
      if (!remoteDraft) {
        // The new default wins over the automatic model at once, not after settings reply.
        setProfileDefault({ ...instance, model: pick.model })
        void window.mousse.settings.set({
          provider: { ...instance, model: pick.model, effort: pick.effort }
        })
      }
      return
    }
    // The empty local thread behind a remote draft is not the chat; its model is not the other computer's pick.
    if (remoteDraft) return

    // Optimistic local meta so the composer badge updates before IPC returns.
    const current = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
    if (current) {
      useAppStore.getState().upsertThread({
        ...current,
        modelOverride: { ...instance, ...pick },
        updatedAt: new Date().toISOString()
      })
    }

    const updated = await window.mousse.threads.setModel(activeThreadId, { ...instance, ...pick })
    if (updated) useAppStore.getState().upsertThread(updated)
  }

  // The projects the toolbar offers: this computer's, or the picked computer's, which it lists with its own.
  const toolbarProjects = useMemo(
    () => workspace.node ? projects.filter((project) => project.node === workspace.node) : localProjectsOf(projects),
    [projects, workspace.node]
  )

  /** Opens a folder as a project and makes it the new chat's project. */
  const openProjectForDraft = async () => {
    const project = await window.mousse.projects.open()
    const state = useAppStore.getState()
    if (!project || state.profileId !== profileId || state.activeThreadId !== activeThreadId) return
    if (!state.projects.some((entry) => entry.id === project.id)) state.setProjects([...state.projects, project])
    setComposerWorkspaceDraft(activeThreadId, { ...workspace, projectId: project.id })
  }

  /** Picks where the new chat runs; the project carries over only if the target lists the same Git repository. */
  const selectRunOnDevice = (node: NodeId | undefined) => {
    if (node === workspace.node) return
    setSendError(null)
    setComposerWorkspaceDraft(activeThreadId, workspaceOnDevice(workspace, projects, node))
  }

  /** Asks the picked computer to open a folder; resolves with its refusal, if any. */
  const openProjectOnRunOnDevice = async (path: string): Promise<string | undefined> => {
    const node = workspace.node
    if (!node) return 'Pick a computer first.'
    try {
      const opened = await openRemoteProject(node, path)
      if (!opened.ok) return opened.error
      const state = useAppStore.getState()
      if (state.profileId !== profileId || state.activeThreadId !== activeThreadId) return undefined
      // This computer names the project as it lists it; the list that follows from the other computer replaces this row.
      const id = qualifyId(node, opened.project.id)
      if (!state.projects.some((entry) => entry.id === id)) state.setProjects([...state.projects, { ...opened.project, id, node }])
      // A project picked on this computer replaces the one remembered from here.
      setComposerWorkspaceDraft(activeThreadId, { projectId: id, worktreeEnabled: workspace.worktreeEnabled, node, ...(workspace.localProjectId ? { localProjectId: workspace.localProjectId } : {}) })
      return undefined
    } catch (error) {
      return remoteErrorMessage(error, pickedDeviceName)
    }
  }

  // Applies from the next turn; a running turn and a pending approval keep what they were asked under.
  const handlePermissionSelect = async (mode: PermissionMode) => {
    // A chat for another computer has no thread there yet: the pick waits with the draft, and goes to the new thread.
    if (!activeThreadId || remoteDraft) {
      setBlankPermissionMode(mode)
      return
    }
    const current = useAppStore.getState().threads.find((t) => t.id === activeThreadId)
    if (current) useAppStore.getState().upsertThread({ ...current, permissionMode: mode })
    try {
      const updated = await window.mousse.threads.setPermissionMode(activeThreadId, mode)
      if (updated) useAppStore.getState().upsertThread(updated)
    } catch (error) {
      // The daemon refused (a subagent above its ceiling): show what the thread really has.
      if (current) useAppStore.getState().upsertThread(current)
      setSendError(sendErrorLine(error))
    }
  }

  // A thread of another computer runs in that computer's default mode unless it has its own, and never above what
  // that computer lets this device have: show that, not this computer's default.
  const remoteComputer = useComputer(remoteNode)
  const remoteMode = remoteNode
    ? remotePermissionView({
        threadMode: remoteDraft ? blankPermissionMode : activeThread?.permissionMode,
        permission: remoteOptions.loaded ? remoteOptions.permission : undefined
      })
    : undefined
  const shownPermissionMode = remoteMode ? remoteMode.mode : permissionMode
  const shownCeiling = remoteMode
    ? remotePermissionCeiling(activeThread?.lineage ? permissionCeiling : undefined, remoteMode.limit, remoteComputer?.name ?? UNKNOWN_COMPUTER_NAME)
    : { ceiling: activeThread?.lineage ? permissionCeiling : undefined }

  // Sending while an approval waits denies it (with the message as the reason); the composer says so.
  const approvalWaiting = permissionRequests.waiting || Boolean(pendingQuestions?.approval)
  const composerHasContent = input.trim().length > 0 || attachedFiles.length > 0

  const retryConnection = () => {
    setConnectionFailed(false)
    setLoading(true)
    void window.mousse.orchestrator
      .retryConnection(activeThreadId ?? undefined)
      .then((started) => {
        if (!started) setLoading(false)
        else void refreshTurnActive()
      })
  }

  const emptyThread = shownMessages.length === 0 && !turnActive && !loading && !showQuestions && !sendError && !connectionFailed

  return (
    <div className={`chat${emptyThread ? ' chat--empty' : ''}`} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <SubagentParentBar />
      <ThreadComputerBar />
      <EarlierMessagesBar />
      <ThreadMoveBanner instanceId={selectedInstanceId ?? providers.find((entry) => entry.id === selectedProviderId)?.instanceId} snapshots={providerSnapshots} />
      <MousseAgentChatShell
        key={activeThreadId ?? 'no-thread'}
        threadId={activeThreadId}
        busy={turnActive || loading}
        messages={shownMessages}
        status={chatStatus}
        onSend={() => void handleSend()}
        onStop={() => void handleStop()}
        quickActionApproval={quickActionApproval}
        permissionRequests={permissionRequests.controls}
        turnActions={turnActions}
        composer={(
      <div
        ref={inputAreaRef}
        className={`chat-input-area${showQuestions ? ' has-questions' : ''}`}
      >
        {activeThreadId && !activeThread?.node && <ChatBrowserAccess key={`${profileId}:${activeThreadId}`} threadId={activeThreadId} requireSelectedThread />}
        {emptyThread && <EmptyThreadHeading headline={emptyHeadline} />}
        <ComposerNoticeProvider>
        {sendError && (sendChanges?.line === sendError && activeThreadId
          ? <PendingChangesNotice threadId={activeThreadId} message={sendChanges.message} details={sendChanges.details}
              onResolved={() => { setSendError(null); setSendChanges(null); void handleSend() }}
              onDismiss={() => { setSendError(null); setSendChanges(null) }} />
          : <ComputerNotice message={sendError} onDismiss={() => setSendError(null)} />)}
        <PromptUndoNotice />
        <PausedRunNotice threadId={activeThreadId} />
        <ServiceLostNotice lost={connectionFailed} onReconnect={retryConnection} onDismiss={() => setConnectionFailed(false)} />
        <ComposerNoticeSource notice={lastSteer ? { tone: 'info', title: 'Steered', detail: lastSteer.text, onDismiss: () => setLastSteer(null) } : null} />
        <ApprovalNotice
          request={approvalRequest}
          composerHasText={composerHasContent}
          placed={approvalPlaced}
          isShown={() => !inputAreaRef.current?.closest('[inert]')}
          serviceLost={connectionFailed}
        />
        <div
          className={`composer-question-swap${questionsOpen ? ' is-open' : ''}`}
          aria-hidden={!showQuestions || undefined}
        >
          <div className="composer-question-swap-inner">
            {renderQuestions && questionsSnapshot && !quickActionApproval && (
              <ComposerQuestionModal
                key={questionsSnapshot.requestId}
                pending={questionsSnapshot}
                handleRef={questionCardRef}
                onComposerSubmitsChange={setQuestionAnswerSubmits}
                onSubmit={(answers) => {
                  const requestId = questionsSnapshot.requestId
                  const threadId = questionAnswerThreadId(questionsSnapshot, activeThreadId)
                  void window.mousse.orchestrator.answerQuestionsDetailed(requestId, answers, threadId).then((outcome) => {
                    // The daemon accepted the answers or no longer knows this
                    // question (answered elsewhere / expired / preempted) —
                    // either way the prompt is settled: drop it so a decided
                    // question can never linger as answerable UI. A rejected
                    // promise (IPC failure) keeps the modal so the answer
                    // isn't silently discarded.
                    setPendingQuestions((current) =>
                      current?.requestId === requestId ? null : current
                    )
                    // Another client answered a saved approval request first, or it was closed: say so.
                    const refusal = describeAnswerOutcome(outcome)
                    if (refusal) setSendError(refusal)
                  })
                }}
                onDismiss={() => {
                  void window.mousse.orchestrator.dismissQuestions(questionsSnapshot.requestId, questionAnswerThreadId(questionsSnapshot, activeThreadId))
                  setPendingQuestions(null)
                }}
              />
            )}
          </div>
        </div>

        {/* The dock on the composer's top edge: the top notice, or the queue; one at a time. */}
        <ComposerNoticeSlot />
        <QueuedMessages
          threadId={activeThreadId}
          optimisticItems={optimisticQueueItems}
          onOptimisticItemReconciled={(id) => {
            setOptimisticQueueItems((current) => current.filter((item) => item.id !== id))
          }}
          onEditItem={(item) => {
            void (async () => {
              if (!activeThreadId || item.id.startsWith('optimistic:')) return
              const cleanText = stripComposerTransportMarkers(item.content)
              setInput(cleanText)
              if (item.images?.length) {
                try {
                  const restored = await Promise.all(
                    item.images.map(async (image) => {
                      const file = await imagePayloadToFile(image)
                      return {
                        id: crypto.randomUUID(),
                        file,
                        previewUrl: imagePayloadToDataUrl(image)
                      } satisfies AttachedFile
                    })
                  )
                  setAttachedFiles((current) => [...current, ...restored])
                } catch {
                  setSendError('Could not restore queued images into the composer')
                }
              }
              try {
                await window.mousse.queue.remove(activeThreadId, item.id)
              } catch (err) {
                setSendError(err instanceof Error ? err.message : 'Could not remove queued message')
              }
            })()
          }}
        />

            {newChat && (
              <ComposerWorkspaceToolbar
                key={`${profileId}:${activeThreadId ?? '__blank__'}`}
                projects={toolbarProjects}
                workspace={workspace}
                disabled={workspaceLocked}
                device={{
                  localName,
                  devices: runOnDevices,
                  notSharing,
                  onRefresh: refreshRunOnDevices,
                  onSelect: (node) => void selectRunOnDevice(node),
                  onOpenRemoteProject: openProjectOnRunOnDevice
                }}
                onChange={(next) => setComposerWorkspaceDraft(activeThreadId, next)}
                onOpenProject={openProjectForDraft}
                onError={setSendError}
              />
            )}
            <ChatComposer
              disabled={workspacePending || !workspaceReady}
              input={input}
              onInputChange={setInput}
              attachedFiles={attachedFiles}
              onAttachedFilesChange={setAttachedFiles}
              voiceMessages={voiceMessages}
              onVoiceMessagesChange={setVoiceMessages}
              browserElements={browserElements}
              onRemoveBrowserElement={(id) => removeBrowserElement(activeThreadId, id)}
              references={references}
              onAddReference={addResolvedReference}
              onRemoveReference={(id) => removeComposerReference(activeThreadId, id)}
              onReferenceError={setSendError}
              enabledSkills={enabledSkills}
              providers={providers}
              selectedProviderId={selectedProviderId}
              selectedInstanceId={selectedInstanceId}
              selectedModelId={selectedModelId}
              modelMenuOpen={modelMenuOpen}
              onModelMenuOpenChange={setModelMenuOpen}
              onModelSelect={(providerId, modelId) => void handleModelSelect(providerId, modelId)}
              onOpenSettings={() => setSettingsOpen(true)}
              contextUsage={contextUsage}
              contextOpen={contextOpen}
              onContextOpenChange={setContextOpen}
              loading={turnActive || loading}
              stoppable={turnActive || loading || turnStoppable}
              placeholder={!workspaceReady ? ''
                : questionsTakeMessage ? QUESTION_COMPOSER_PLACEHOLDER
                  : approvalWaiting ? APPROVAL_COMPOSER_PLACEHOLDER : undefined}
              sendLabel={questionsTakeMessage
                ? questionComposerSend(attachedFiles.some((attached) => isImageMimeType(attached.file.type)), questionAnswerSubmits).label
                : approvalWaiting ? DENY_AND_SEND_LABEL : undefined}
              onSend={(skillMode, options) => void handleSend(skillMode, options)}
              onStop={() => void handleStop()}
              lastPrompt={lastPrompt}
              banner={<><RemoteSubagentNotice runsOn={activeThread?.runsOn} /><SubagentComposerBanner threadId={activeThreadId} /></>}
              searchMentions={searchMentions}
              mentionScope={mentionScope}
              permission={{ mode: shownPermissionMode, ceiling: shownCeiling.ceiling, ceilingReason: shownCeiling.reason, onSelect: (mode) => void handlePermissionSelect(mode) }}

            />
        </ComposerNoticeProvider>
        {emptyThread && newChat && offersAddProject(projects.length, workspace.node) && (
          <EmptyThreadAddProject onAdd={() => void openProjectForDraft().catch((error) => setSendError(error instanceof Error ? error.message : String(error)))} />
        )}
      </div>
        )}
      />
    </div>
  )
}
