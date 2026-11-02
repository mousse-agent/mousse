import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from '../lib/icons'
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
import type { SkillDescriptor } from '../../shared/integrations'
import { isTurnActivePhase } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { useCommand } from '../commands/commandRegistry'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  buildComposerMessageContent
} from './ChatComposer'
import { QueuedMessages } from './QueuedMessages'
import { MousseLogoOutline } from './MousseLogoOutline'
import { APPROVAL_COMPOSER_PLACEHOLDER, ComposerQuestionModal, describeAnswerOutcome } from './ComposerQuestionModal'
import { filesToImagePayloads, imagePayloadToDataUrl, imagePayloadToFile } from '../utils/imageAttachments'
import { stripComposerTransportMarkers } from './QueuedMessages'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { SubagentParentBar } from './SubagentParentBar'
import { SubagentComposerBanner } from './SubagentComposerBanner'
import { ThreadMoveBanner } from './providers/MoveProviderDialog'
import { mousseToUIMessages, chatStatusFromTurn } from '../chat/adapters/mousseToUI'
import { useTurnSenders } from '../hooks/useTurnSenders'
import { usePermissionRequests } from '../hooks/usePermissionRequests'
import { permissionRequestOptions } from '../chat/components/agent-elements/tools/permission-request'
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
import { composerAutoModel, onProviderListingsChanged, pickerIdFor, pickerProviders, projectScope, useProviderSnapshots, type PickerSelection } from '../lib/providerSnapshots'
import { errorText, sendErrorLine } from '../lib/errorText'
import { PromptUndoNotice } from './PromptUndoControls'
import { pendingChangesDetails, type PendingChangesDetails } from '../../shared/workspace'
import { PendingChangesNotice } from './PendingChangesNotice'
import { composerThreadActions } from '../lib/composerThreadActions'
import { composerWorkspaceFor, isComposerWorkspaceLocked, isNewEmptyThread, isWorkspacePending } from '../lib/newThread'
import { ComposerWorkspaceToolbar } from './ComposerWorkspaceToolbar'
import { ChatBrowserAccess } from './chats/ChatBrowserAccess'
import { extractChatReferences, type ChatReference } from '../../shared/chatReferences'
import { resolveChatReference, resolveChatReferences } from '../utils/chatLinks'
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
  const workspace = composerWorkspaceFor(workspaceDraft, activeThread)
  const localName = useAppStore((s) => localDeviceName(s.appInfo?.deviceName))
  const { devices: runOnDevices, notSharing, refresh: refreshRunOnDevices } = useRunOnDevices()
  const pickedDeviceName = runOnLabel(localName, runOnDevices, workspace.node)
  // Shared with quick actions and the side card, which also prepare or edit the new chat's workspace.
  const workspacePending = useAppStore(isWorkspacePending)
  const workspaceLocked = useAppStore(isComposerWorkspaceLocked)
  const newChat = isNewEmptyThread(activeThreadId, activeThread, messages.length)
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

  // Visible steer feedback: the daemon emits turn-steered when prompt text is
  // injected mid-turn. Show the steered text as a pill above the composer so
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
  // Clear the pill once the steered user message lands in the transcript.
  useEffect(() => {
    if (!lastSteer) return
    if (messages.some((m) => m.role === 'user' && m.content.trim() === lastSteer.text)) {
      setLastSteer(null)
    }
  }, [messages, lastSteer])

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
    setCatalog(options.llmProviders)
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
      setSelectedModelId(selectedModel.model)
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

  // Picking a computer swaps the picker to its default model; coming back restores this computer's.
  // A thread of another computer shows the model it has there, or that computer's default.
  const remoteDefault = remoteOptions.defaultModel
  const refreshSelectionRef = useRef(refreshSelection)
  refreshSelectionRef.current = refreshSelection
  useEffect(() => {
    if (!remoteNode) {
      void refreshSelectionRef.current()
      return
    }
    if (!remoteOptions.loaded) return
    const pick = remoteDraft ? remoteDefault : (activeThreadModelOverride ?? remoteDefault)
    setSelectedLlmProvider(pick?.llmProvider ?? '')
    setSelectedInstanceId(pick?.instanceId)
    setSelectedModelId(pick?.model ?? '')
  }, [remoteNode, remoteDraft, remoteOptions.loaded, remoteDefault, activeThreadModelOverride])

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
          if (request === catalogRequest) setCatalog(options.llmProviders)
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
        if (result.error) {
          setSendError(sendErrorLine(result.error))
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

  const handleSend = async (skillMode?: SkillChatMode) => {
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
      text = steerText
    }

    if (!text && images.length === 0) return

    const newThreadMatch = trimmed.match(/^\/new(?:\s+(.+))?$/)
    if (newThreadMatch && images.length === 0) {
      setInput('')
      await window.mousse.threads.createAndSelect(newThreadMatch[1]?.trim())
      return
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
      if (selectedProviderId && selectedModelId) {
        const updated = await window.mousse.threads.setModel(id, {
          ...selectionFor(selectedProviderId),
          model: selectedModelId
        })
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

    // Persist as last-used default for new threads. Existing chats keep their
    // own modelOverride, which is stamped at create time from this value.
    if (!activeThreadId) {
      // A chat for another computer takes its model there; this computer's default stays as it is.
      if (!remoteDraft) {
        // The new default wins over the automatic model at once, not after settings reply.
        setProfileDefault({ ...instance, model: modelId })
        void window.mousse.settings.set({
          provider: { ...instance, model: modelId }
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
        modelOverride: { ...instance, model: modelId },
        updatedAt: new Date().toISOString()
      })
    }

    const updated = await window.mousse.threads.setModel(activeThreadId, {
      ...instance,
      model: modelId
    })
    if (updated) useAppStore.getState().upsertThread(updated)
  }

  // The projects the toolbar offers: this computer's, or the picked computer's, which it lists with its own.
  const toolbarProjects = useMemo(
    () => workspace.node ? projects.filter((project) => project.node === workspace.node) : localProjectsOf(projects),
    [projects, workspace.node]
  )

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
        composer={(
      <div
        ref={inputAreaRef}
        className={`chat-input-area${showQuestions ? ' has-questions' : ''}`}
      >
        {activeThreadId && !activeThread?.node && <ChatBrowserAccess key={`${profileId}:${activeThreadId}`} threadId={activeThreadId} requireSelectedThread />}
        {emptyThread && <MousseLogoOutline className="chat-empty-logo" />}
        {emptyThread && <h1 className="chat-empty-title">What should we build?</h1>}
        {sendError && (sendChanges?.line === sendError && activeThreadId
          ? <PendingChangesNotice className="connection-failed-pill" threadId={activeThreadId} message={sendChanges.message} details={sendChanges.details}
              onResolved={() => { setSendError(null); setSendChanges(null); void handleSend() }} />
          : <ComputerNotice message={sendError} />)}
        {!sendError && !connectionFailed && <PromptUndoNotice />}
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
        {lastSteer && (
          <div className="steer-pill" role="status" aria-label="Steered into active turn">
            <span className="steer-pill-label">Steered into active turn</span>
            <span className="steer-pill-text">{lastSteer.text.length > 160 ? `${lastSteer.text.slice(0, 157)}…` : lastSteer.text}</span>
            <button type="button" className="steer-pill-dismiss" aria-label="Dismiss steer notice" onClick={() => setLastSteer(null)}>×</button>
          </div>
        )}

        <div
          className={`composer-collapse${showQuestions ? ' is-collapsed' : ''}`}
          aria-hidden={showQuestions || undefined}
          {...(showQuestions ? { inert: true } : {})}
        >
          <div className="composer-collapse-inner">
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
                onOpenProject={async () => {
                  const project = await window.mousse.projects.open()
                  const state = useAppStore.getState()
                  if (!project || state.profileId !== profileId || state.activeThreadId !== activeThreadId) return
                  if (!state.projects.some((entry) => entry.id === project.id)) state.setProjects([...state.projects, project])
                  setComposerWorkspaceDraft(activeThreadId, { ...workspace, projectId: project.id })
                }}
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
              placeholder={workspaceReady ? (permissionRequests.waiting || pendingQuestions?.approval ? APPROVAL_COMPOSER_PLACEHOLDER : undefined) : 'Loading workspace...'}
              onSend={(skillMode) => void handleSend(skillMode)}
              onStop={() => void handleStop()}
              banner={<SubagentComposerBanner threadId={activeThreadId} />}
              searchMentions={searchMentions}
              mentionScope={mentionScope}
              permission={{ mode: shownPermissionMode, ceiling: shownCeiling.ceiling, ceilingReason: shownCeiling.reason, onSelect: (mode) => void handlePermissionSelect(mode) }}

            />
          </div>
        </div>
      </div>
        )}
      />
    </div>
  )
}
