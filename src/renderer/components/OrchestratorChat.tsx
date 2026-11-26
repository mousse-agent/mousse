import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { stopThreadNow } from '../lib/stopThread'
import type { UIMessage } from 'ai'
import { expiryPresetMs } from '../../shared/threadExpiry'
import { ChevronDown, ChevronUp } from '../lib/icons'
import { EmptyThreadAddProject, offersAddProject } from './EmptyThreadAddProject'
import { ChatWallpaper } from './ChatWallpaper'
import { AmbientGlow } from './AmbientGlow'
import { EmptyThreadHeading } from './EmptyThreadHeading'
import { endWarmEmptyView, warmEmptyViewOf } from '../lib/warmHandover'
import { emptyThreadHeadline } from '../utils/emptyThreadHeadline'
import { normalizeContextSettings, type ContextSettings, type LlmProviderOption } from '../../shared/settings'
import type {
  BrowserElementAttachment,
  ChatImageAttachment,
  ChatMessage,
  ChatMode,
  ContextUsageSnapshot,
  QueuedMessage,
  SendExpectation,
  SkillChatMode,
  Thread
} from '../../shared/types'
import { DEFAULT_CHAT_MODE } from '../../shared/types'
import { fileWorkspaceScope } from '../stores/filesStore'
import { DEFAULT_PERMISSION_MODE, normalizePermissionMode, permissionCeilingOf, type PermissionMode } from '../../shared/permissionMode'
import { removeInlineSkillToken } from '../../shared/composerCommands'
import { runSlashCommand, type SlashCommandEnv } from '../lib/slashCommands'
import type { SkillDescriptor } from '../../shared/integrations'
import { isThreadActivityActive, isTurnActivePhase, isTurnStoppable, type TurnPhase } from '../../shared/types'
import { deletedThreadIds, useAppStore } from '../stores/appStore'
import { holdModelPick, isSupersededModelPick, modelPickSaved, settleModelPick, withSavedModel } from '../lib/modelPicks'
import { useCommand } from '../commands/commandRegistry'
import {
  ChatComposer,
  type AttachedFile,
  type VoiceMessage,
  attachedFileName,
  buildComposerMessageContent
} from './ChatComposer'
import { MMS_PROTOCOL_MAX_TEXT_LENGTH } from '../../mms/protocol/types'
import { attachedFilesIn, formatAttachedFilesMarker } from '../../shared/attachedFilesMarker'
import { QUEUE_DRAFT_MOVED_NOTICE, sameQueuedSend, useThreadQueue, type RecoveredQueueDraft } from '../hooks/useThreadQueue'
import { turnTakesSteer, withSteersOnTheWay } from '../lib/steersOnTheWay'
import { nextSteerableQueueItem } from '../lib/queuedContent'
import { lostImagesLine, restoreQueuedDraft } from '../lib/queuedDraftRecovery'
import { historyTokens as historyTokensOf } from '../lib/promptCache'
import { cachedContextUsage, contextUsageKey, rememberContextUsage } from '../lib/threadContextUsage'
import {
  APPROVAL_COMPOSER_PLACEHOLDER,
  ComposerQuestionModal,
  QUESTION_COMPOSER_PLACEHOLDER,
  describeAnswerOutcome,
  questionComposerSendLabel,
  type QuestionCardHandle
} from './ComposerQuestionModal'
import { filesToImagePayloads, isImageMimeType } from '../utils/imageAttachments'
import { composerFilePaths, fileAttachments, prestageImages, MESSAGE_TOO_LONG, REMOTE_FILES_REFUSAL, REMOTE_PASTE_TOO_LONG } from '../lib/composerFilePaths'
import { preparedSend } from '../lib/attachmentPreparation'
import { useAttachmentPreparation } from '../hooks/useAttachmentPreparation'
import { parseUserMessageContent } from '../utils/messageAttachments'
import { MousseAgentChatShell } from '../chat/components/MousseAgentChatShell'
import { createTurnActions, type TurnActions } from '../chat/components/agent-elements/turn-actions'
import { countRender } from '../chat/components/agent-elements/render-counts'
import { SubagentParentBar } from './SubagentParentBar'
import { SubagentComposerBanner } from './SubagentComposerBanner'
import { findSubagentEntry, isSubagentStartingOptimistically } from './subagentStatus'
import { useSubagents } from '../hooks/useSubagents'
import { useBackgroundWork } from '../hooks/useBackgroundWork'
import { BackgroundWorkRow } from './BackgroundWorkRow'
import { NativeSubagentPage } from './NativeSubagentPage'
import { isRunningSubagent, isWorkingSubagent } from '../../shared/subagents'
import { stopAllSubagents } from './sideCard/lineageLogic'
import { RemoteSubagentNotice } from './RemoteSubagentNotice'
import { isWatchOnlyThread, NativeHelperNotice } from './NativeHelperNotice'
import { ThreadMoveBanner } from './providers/MoveProviderDialog'
import { mousseToUIMessages, chatStatusFromTurn, reuseUIMessages } from '../chat/adapters/mousseToUI'
import { useTurnSenders } from '../hooks/useTurnSenders'
import { usePermissionRequests } from '../hooks/usePermissionRequests'
import { usePendingQuestions } from '../hooks/usePendingQuestions'
import { isWaitingPermissionRequest } from '../chat/components/agent-elements/tools/permission-request'
import { usePendingRequestFocus } from '../stores/chatNavigationStore'
import { ApprovalNotice, DENY_AND_SEND_LABEL } from './ApprovalNotice'
import {
  findQuickActionCardForApproval,
  questionAnswerThreadId,
  type QuickActionApproval,
} from '../chat/components/agent-elements/tools/quick-action-approval'
import '../chat/components/agent-elements/agent-ui.css'
import type { NodeId } from '../../shared/net'
import { isQualifiedId, qualifyId } from '../../shared/threadRef'
import { composerCreatesThread, prepareComposerThread } from '../lib/createComposerThread'
import { boundSendRefusal, errorCodeOf, needsSetup, sendIsFirst, setupRefusalLine, type ThreadSetup } from '../lib/threadSetup'
import { openRemoteProject, refreshRemoteComposerOptions, remoteErrorMessage, remotePermissionCeiling, remotePermissionView, workspaceOnDevice } from '../lib/remoteComputers'
import { UNKNOWN_COMPUTER_NAME, useComputer } from '../lib/computers'
import { useRemoteComposerOptions, useRunOnDevices } from '../hooks/useRunOnDevices'
import { localProjectsOf } from '../hooks/useLocalProjects'
import { localDeviceName, runOnLabel } from './sideCard/deviceMenu'
import { ComputerNotice } from './ComputerNotice'
import { ThreadComputerBar } from './ThreadComputerBar'
import { ThreadStartedByBar } from './ThreadStartedByBar'
import { ThreadModeBar } from './ThreadModeBar'
import { EarlierMessagesBar } from './EarlierMessagesBar'
import { forgetMessageImageRequests, hydrateMessageImages, missingImages } from '../lib/messageImages'
import { isOutcomeUncertain, settleUncertainSend } from '../lib/uncertainSend'
import { SendRetryIds, type SendRetry } from '../lib/sendRetryIds'
import { composerAutoModel, composerSelection, fallbackModel, onProviderListingsChanged, pickerListsModel, pickerOffers, pickerIdFor, pickerProviders, projectScope, useProviderSnapshots, type PickerSelection } from '../lib/providerSnapshots'
import { compactNowFailureLine, errorText, isRequestTimeout, readableError, sendErrorLine } from '../lib/errorText'
import { openSettingsSection } from '../lib/settingsNavigation'
import { showToast } from './ui/Toast'
import { editablePrompt, PromptUndoNotice } from './PromptUndoControls'
import { invalidateThreadActionHistory, readThreadActionHistory } from '../utils/threadActionHistory'
import { pendingChangesDetails, type PendingChangesDetails } from '../../shared/workspace'
import { PendingChangesNotice } from './PendingChangesNotice'
import { ComposerNoticeProvider, ComposerNoticeSlot, ComposerNoticeSource } from './ComposerNotice'
import { ComputerUseSetupCard } from './ComputerUseSetupCard'
import { ServiceLostNotice } from './ServiceLostNotice'
import { PausedRunNotice } from '../chat/components/PausedRunNotice'
import { SetupFailureNotice } from '../chat/components/SetupFailureNotice'
import { CommandInfoNotice, GoalNotice } from '../chat/components/GoalNotice'
import { composerThreadActions } from '../lib/composerThreadActions'
import { addPendingThreadRow, afterNextPaint, claimPendingThreadRow, dropPendingThreadRows, holdNewChat, isPendingRowId, pendingThreadRow, typedAfterSend, type PendingThreadRow } from '../lib/pendingThreadRows'
import { type ComposerWorkspace, composerWorkspaceFor, projectToAddThere, workspaceWithAddedProject, isComposerWorkspaceLocked, isNewEmptyThread, isWorkspacePending, newThreadWorktree, rememberedChoiceOf, withoutPicks, workspaceWithExpiry, workspaceWithPrivate } from '../lib/newThread'
import { ComposerProjectPicker, ComposerThreadSettings, type ComposerDeviceProps } from './ComposerWorkspaceToolbar'
import { openAddToComputer } from '../lib/addToComputer'
import { extractChatReferences, type ChatReference } from '../../shared/chatReferences'
import { resolveChatReference, resolveChatReferences } from '../utils/chatLinks'
import { threadReferenceRefusal } from '../lib/threadReference'
import { isLocalOnlyThread, isSubagentThread } from '../../shared/threadLineage'
import { pickedSelection, pickerModelId } from '../../shared/modelSelection'
import '../styles/compact-composer.css'
import { CHAT_TOOL_RENDERERS } from './automations/inbox/ChatDraftCard'
import { SecretRequestActionsContext, withSecretRequests, type SecretRequestActions } from './secrets/secretRequestPart'
import { SecretRequestRow } from './secrets/SecretRequestRow'
import { usePendingSecretRequests } from '../hooks/usePendingSecretRequests'
import { createSecretsClient } from '../services/secretsClient'

/** The chat's custom tool rows: drafts and run reports, and a secret request's row (#595). */
const THREAD_TOOL_RENDERERS = { ...CHAT_TOOL_RENDERERS, secret_request: SecretRequestRow }

/** A steer whose request got no answer: it may have reached the reply, so it is not sent again. */
export const STEER_UNCONFIRMED = 'The steer was not confirmed. Checking whether it reached the reply…'
/** The running turn could not take the steer: it was queued at the end instead. */
export const STEER_QUEUED = 'The reply could not take that steer, so it was queued instead.'
/** That steer did not arrive: its text is back in the composer. */
export const STEER_NOT_ARRIVED = 'The steer did not reach the reply, so it is back in the composer.'

/** Before the first measurement arrives: no capacity, so the composer shows no ring. */
const EMPTY_CONTEXT_USAGE: ContextUsageSnapshot = {
  percent: 0,
  used: 0,
  limit: 0,
  modelName: null,
  source: 'estimated',
  categories: []
}

/** Stable empty list — `?? []` in a Zustand selector causes infinite re-renders. */
const EMPTY_BROWSER_ELEMENTS: BrowserElementAttachment[] = []
const EMPTY_REFERENCES: ChatReference[] = []
const NO_ATTACHED_FILES: AttachedFile[] = []
const NO_VOICE_MESSAGES: VoiceMessage[] = []

/** Composer media (files/voice) cannot go in the persisted workspace store — File/Blob + object URLs. */
type ComposerMediaDraft = { files: AttachedFile[]; voice: VoiceMessage[] }
const EMPTY_COMPOSER_MEDIA: ComposerMediaDraft = { files: [], voice: [] }

/** A saved model pick reaches the thread's row as it is now: only the model and the settings revision change (`withSavedModel`). */
function storeSavedModel(threadId: string, saved: Thread): void {
  const store = useAppStore.getState()
  const row = store.threads.find((entry) => entry.id === threadId)
  store.upsertThread(row ? withSavedModel(row, saved) : saved)
}

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

/**
 * A turn's phase as the chat reads it: thinking, a tool and finalizing are the same running reply as streaming (the
 * same chat status, active and stoppable alike). Only the line under Working tells them apart.
 */
function chatTurnPhase(phase: TurnPhase | undefined): TurnPhase | undefined {
  return phase === 'thinking' || phase === 'tool_running' || phase === 'finalizing' ? 'streaming' : phase
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

/**
 * A new chat's first message as shown in the transcript from the click on Send, before its thread is made: its id and
 * the click's time, which its turn's Working time counts from. `taken` once the send paints it as its own.
 */
type ShownFirstPrompt = { id: string; at: string; taken: boolean }
type SteerRetry = SendRetry<string> & { signature: string }

/** A retry belongs to the original message even when the visible turn changes. */
async function sendSignature(profileId: string, threadId: string | null, content: string, mode: ChatMode, images: ChatImageAttachment[] | undefined, steer?: boolean): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({ profileId, threadId, content, mode, images, steer }))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** The transcript shows a prompt with these words that was not there before the send (`seenBefore`): its turn started. */
function startedAsPrompt(messages: readonly ChatMessage[], seenBefore: ReadonlySet<string>, content: string): boolean {
  // New rows come last: read back to the first one that was already there.
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (seenBefore.has(message.id)) return false
    if (message.role === 'user' && !message.id.startsWith('optimistic:') && message.content === content) return true
  }
  return false
}

export function OrchestratorChat() {
  countRender('OrchestratorChat')
  const messages = useAppStore((s) => s.messages)
  const loading = useAppStore((s) => s.loading)
  const transcriptPending = useAppStore((s) => s.transcriptPending)
  const setLoading = useAppStore((s) => s.setLoading)
  const chatMode = useAppStore((s) => s.chatMode)
  const activeThreadId = useAppStore((s) => s.activeThreadId)
  const profileId = useAppStore((s) => s.profileId)
  const profileReady = useAppStore((s) => s.profileReady)
  const workspaceReady = useAppStore((s) => s.workspaceReady)
  // The turn as the chat reads it: its phase, with the running ones as one (`chatTurnPhase`), and its run. Its step,
  // times and the running phase change all through a reply; only the line under Working shows them
  // (MousseAgentChatShell's progress provider), so they do not render the chat.
  const turnPhase = useAppStore((s) => (s.activeThreadId ? chatTurnPhase(s.turnStates[s.activeThreadId]?.phase) : undefined))
  const turnRunId = useAppStore((s) => (s.activeThreadId ? s.turnStates[s.activeThreadId]?.turnId : undefined))
  const turnState = useMemo(
    () => (turnPhase === undefined ? undefined : { phase: turnPhase, turnId: turnRunId ?? null }),
    [turnPhase, turnRunId]
  )
  // Subscribe only to the selected thread's activity — the full map used to
  // re-render the chat on every background thread's activity tick. With a turn state, the chat reads only whether
  // it is active, so Working and Waiting are one.
  const activeThreadActivity = useAppStore((s) => {
    if (!s.activeThreadId) return undefined
    const activity = s.threadActivity[s.activeThreadId]
    return s.turnStates[s.activeThreadId] && isThreadActivityActive(activity) ? 'processing' : activity
  })
  const activeThreadModelOverride = useAppStore((s) =>
    s.threads.find((thread) => thread.id === s.activeThreadId)?.modelOverride
  )
  const activeThread = useAppStore((s) =>
    s.threads.find((thread) => thread.id === s.activeThreadId)
  )
  // If the open thread is a subagent listed under any parent in Nest (local by id, or remote by ref), recognise it
  // immediately on click — even before threads:updated or its first turn-state lands.
  // Select only the entry for the open thread (never the whole `subagentsByParent` map) so updates to other
  // parents' subagents do not re-render an unrelated chat.
  const ownSubagent = useAppStore(
    useShallow((s) => findSubagentEntry(s.subagentsByParent, s.activeThreadId))
  )
  const ownSubagentParentId = activeThread?.lineage?.parentThreadId ?? ownSubagent?.parentThreadId ?? null
  useSubagents(ownSubagentParentId && messages.length === 0 ? ownSubagentParentId : null)
  const isSubagent = Boolean((activeThread && isSubagentThread(activeThread)) || ownSubagent)
  // The profile default.
  const [defaultPermissionMode, setDefaultPermissionMode] = useState<PermissionMode>(DEFAULT_PERMISSION_MODE)
  // Derive the ceiling inside the selector so unrelated threads' touches or updates do not re-render this chat.
  const permissionCeiling = useAppStore((s) => {
    const active = s.threads.find((thread) => thread.id === s.activeThreadId)
    return permissionCeilingOf(active, s.threads, defaultPermissionMode)
  })
  const projects = useAppStore((s) => s.projects)
  const workspaceDraft = useAppStore((s) => s.composerWorkspaceDrafts[s.activeThreadId ?? '__blank__'])
  const setComposerWorkspaceDraft = useAppStore((s) => s.setComposerWorkspaceDraft)
  const privateThreadExpiry = useAppStore((s) => s.privateThreadExpiry)
  const privateDefaultMs = privateThreadExpiry === 'never' ? undefined : expiryPresetMs(privateThreadExpiry)
  const workspace = composerWorkspaceFor(workspaceDraft, activeThread, projects)
  // What was picked for this new chat, kept with its draft (so quick actions see it too) until a send applies it.
  const pickedMode = workspace.permissionMode
  const pickedModel = workspace.model
  const localName = useAppStore((s) => localDeviceName(s.appInfo?.deviceName))
  const { devices: runOnDevices, notSharing, refresh: refreshRunOnDevices } = useRunOnDevices()
  const pickedDeviceName = runOnLabel(localName, runOnDevices, workspace.node)
  // Shared with quick actions and the side card, which also prepare or edit the new chat's workspace.
  const workspacePending = useAppStore(isWorkspacePending)
  const workspaceLocked = useAppStore(isComposerWorkspaceLocked)
  // The first message of a new chat, shown in the transcript from the click while its thread is made and set up
  // (`handleSend`). Each first send keeps its own prompt while the composer moves between threads.
  const [firstSendIds, setFirstSendIds] = useState<ReadonlySet<string>>(() => new Set())
  const firstSendShown = messages.some((message) => firstSendIds.has(message.id))
  const hasAdmittedTurn = isTurnStoppable(turnState)
  const newChat = !hasAdmittedTurn && !firstSendShown && !ownSubagent && isNewEmptyThread(activeThreadId, activeThread, messages.length)
  // A new chat whose thread a send still has to make (none yet, or the empty one shown is of another project or
  // computer): it shows what its project remembers from the last pick there, and a pick waits with the draft.
  const createsThread = newChat && composerCreatesThread(activeThread, workspace)
  // A new chat on its own empty thread of this computer: the checkout it shows is given to that thread at once, so the
  // service prepares its worktree while the message is typed, or removes the prepared one when the project folder is
  // picked. The send applies the pick as before.
  const shownCheckout = newChat && activeThreadId && activeThread && !createsThread && !activeThread.node && workspace.projectId && !workspaceLocked ? workspace.worktreeEnabled : undefined
  const threadCheckout = activeThread ? activeThread.worktreeEnabled ?? newThreadWorktree(projects, activeThread.projectId) : undefined
  useEffect(() => {
    if (shownCheckout === undefined || !activeThreadId || shownCheckout === threadCheckout) return
    void window.mousse.threads.setWorktreeEnabled(activeThreadId, shownCheckout).catch(() => undefined)
  }, [activeThreadId, shownCheckout, threadCheckout])
  const remembered = createsThread && !workspace.node ? rememberedChoiceOf(projects, workspace.projectId) : undefined
  const permissionMode = createsThread
    ? pickedMode ?? remembered?.permissionMode ?? defaultPermissionMode
    : activeThread?.permissionMode ?? defaultPermissionMode
  // Picked once per chat, so it holds while typing; another chat may get another line.
  const emptyHeadline = useMemo(() => emptyThreadHeadline(new Date(), activeThreadId ?? '__blank__'), [activeThreadId])
  // The warm start showed this same empty chat: its logo and glow carry on rather than playing in again. Only for the
  // chat it showed, until another one opens.
  const [warmEmpty] = useState(() => warmEmptyViewOf(activeThreadId ?? '__blank__'))
  const warmEmptyLeft = useRef(false)
  if (warmEmpty && warmEmpty.threadKey !== (activeThreadId ?? '__blank__')) warmEmptyLeft.current = true
  const continuesWarmEmpty = warmEmpty !== null && !warmEmptyLeft.current
  useEffect(() => endWarmEmptyView(), [])
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
  const providersRef = useRef(providers)
  providersRef.current = providers
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
  // A thread with a model shows it from the first paint, before settings are read.
  const [selectedLlmProvider, setSelectedLlmProvider] = useState(() => activeThreadModelOverride?.llmProvider ?? '')
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | undefined>(() => activeThreadModelOverride?.instanceId)
  const selectedProviderId = pickerIdFor({ instanceId: selectedInstanceId, llmProvider: selectedLlmProvider }, providers)
  const [selectedModelId, setSelectedModelId] = useState(() => activeThreadModelOverride ? pickerModelId(activeThreadModelOverride) : '')
  // The profile's default model, once settings are read; undefined until then.
  const [profileDefault, setProfileDefault] = useState<PickerSelection | undefined>(undefined)
  // The model the composer shows as the chat's own: the thread's, or for a chat whose thread is still to be made,
  // the one picked for it, else its project's remembered model while the picker lists that model (its instance is on
  // for the project and the model is not hidden; unknown until the provider snapshots arrive). Without one the
  // composer shows the profile's default, as the daemon falls back to it, and a send stamps what is shown.
  const rememberedModel = remembered?.model
  const rememberedOffered = useMemo(
    () => rememberedModel && providerSnapshots && pickerListsModel(rememberedModel, providers) ? rememberedModel : undefined,
    [rememberedModel, providerSnapshots, providers]
  )
  const selectionThreadModel = createsThread && !remoteNode ? (pickedModel ?? rememberedOffered) : activeThreadModelOverride
  // With no thread model and no default the picker offers, the composer starts on the first ready
  // provider's model, and a send stamps it on the thread.
  const autoModel = useMemo(
    () => composerAutoModel({ remote: Boolean(remoteNode), threadModel: selectionThreadModel, profileDefault, providers }),
    [remoteNode, selectionThreadModel, profileDefault, providers]
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
  // Attached images are made ready as they are attached: their chips say how each goes, and Send uses what was prepared.
  const preparation = useAttachmentPreparation(attachedFiles, Boolean(remoteNode))
  // Every inline image also goes as its file: a pasted one is written now, so the send does not wait for it. A thread
  // on another computer takes no files.
  useEffect(() => { if (!remoteNode) prestageImages(attachedFiles, activeThreadId) }, [attachedFiles, activeThreadId, remoteNode])
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
  // The open thread's context, as last measured. A thread opened again shows its own ring and Full/Compact chip
  // in the same frame as its transcript, and never the ones of the thread shown before; a thread not measured
  // yet shows neither until its measurement arrives.
  const contextKey = contextUsageKey(profileId, activeThreadId)
  const contextVersion = useAppStore((s) => (s.activeThreadId ? s.threads.find((thread) => thread.id === s.activeThreadId)?.updatedAt : undefined))
  const [measuredContext, setMeasuredContext] = useState<{ key: string; usage: ContextUsageSnapshot }>()
  const contextUsage = useMemo(
    () => (measuredContext?.key === contextKey ? measuredContext.usage : cachedContextUsage(contextKey, contextVersion) ?? EMPTY_CONTEXT_USAGE),
    [measuredContext, contextKey, contextVersion]
  )
  // Only the newest measurement asked for is shown: an older one that answers later is dropped.
  const contextRequest = useRef(0)
  const measureContext = useCallback((threadId: string | null, key: string, version: string | undefined, draftInput: string) => {
    const request = ++contextRequest.current
    void window.mousse.orchestrator
      .getContextUsage({ draftInput, mode: chatMode, ...(threadId && !isPendingRowId(threadId) ? { threadId } : {}) })
      .then((usage) => {
        if (request !== contextRequest.current) return
        rememberContextUsage(key, usage, version)
        setMeasuredContext({ key, usage })
      }, () => undefined)
  }, [chatMode])
  /** The thread measured last; a thread opened since is measured at once, without the typing debounce. */
  const measuredContextKey = useRef<string | undefined>(undefined)
  const [contextCompactionSetting, setContextCompactionSetting] = useState<ContextSettings>()
  // The open thread's agent questions; a question from another thread never shows or takes a message here.
  const [pendingQuestions, setPendingQuestions] = usePendingQuestions(activeThreadId)
  // The open thread's secret cards (#595): an agent asked for a secret; the value goes only to this computer's daemon.
  const secretsClient = useMemo(() => createSecretsClient(window.mousse?.platformRequest), [])
  const { requests: secretRequests, refresh: refreshSecretRequests } = usePendingSecretRequests(activeThreadId, secretsClient)
  const [connectionFailed, setConnectionFailed] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  /** A line a composer command answered with (`/goal` alone), until dismissed or the thread changes. */
  const [commandInfo, setCommandInfo] = useState<string | null>(null)
  useEffect(() => setCommandInfo(null), [activeThreadId])
  /** Discard for a send refused over a conflict in the thread worktree; shown only while `sendError` is that refusal’s line. */
  const [sendChanges, setSendChanges] = useState<{ line: string; message: string; details: PendingChangesDetails } | null>(null)
  /** Why this thread may not point at `threadId` (a private thread from a shared one), else null. */
  const pastedThreadRefusal = useCallback((threadId: string) => {
    const { threads, activeThreadId: here } = useAppStore.getState()
    const thread = threads.find((entry) => entry.id === here)
    return threadReferenceRefusal(threadId, { privateThread: Boolean(thread && isLocalOnlyThread(thread, threads)) })
  }, [])
  const addResolvedReference = useCallback(async (reference: ChatReference) => {
    const expectedProfile = useAppStore.getState().profileId
    const expectedThread = useAppStore.getState().activeThreadId
    if (reference.kind === 'thread' && reference.threadId) {
      const refused = pastedThreadRefusal(reference.threadId)
      if (refused) throw new Error(refused)
    }
    const resolved = await resolveChatReference(reference)
    const state = useAppStore.getState()
    if (state.profileId !== expectedProfile || state.activeThreadId !== expectedThread) return
    state.addComposerReference(expectedThread, resolved)
    setSendError(null)
  }, [pastedThreadRefusal])
  const sendIds = useRef(new SendRetryIds<string>())
  // Prompts sent here and still on their way, by thread (their send answers when the turn ends). A message sent
  // meanwhile is queued behind them, even before the thread reports the turn running.
  const promptsOnTheWay = useRef(new Map<string, number>())
  // The threads with a prompt on its way, for the composer: it works as during the reply from the send, so a steer made
  // before the thread reports the turn running is a steer (it joins the turn once it runs), not a queued message.
  const [promptThreadsOnTheWay, setPromptThreadsOnTheWay] = useState<ReadonlySet<string>>(() => new Set())
  const notePromptOnTheWay = useCallback((threadId: string, change: 1 | -1) => {
    const left = (promptsOnTheWay.current.get(threadId) ?? 0) + change
    if (left > 0) promptsOnTheWay.current.set(threadId, left)
    else promptsOnTheWay.current.delete(threadId)
    setPromptThreadsOnTheWay((current) => {
      if (current.has(threadId) === left > 0) return current
      const next = new Set(current)
      if (left > 0) next.add(threadId)
      else next.delete(threadId)
      return next
    })
  }, [])
  // Steers sent here and still on their way, by their request ids. One the running turn could not take yet is queued
  // and then sent now: it shows in the reply it joins, never for a moment in the queue too.
  const [steersOnTheWay, setSteersOnTheWay] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => { setSendError(null); setSendChanges(null) }, [profileId, activeThreadId])
  const [optimisticQueueItems, setOptimisticQueueItems] = useState<QueuedMessage[]>([])
  const [lastSteer, setLastSteer] = useState<{ text: string; at: number } | null>(null)
  // Once a push has shown the saved row, the queue owns its lifetime. A send reply can still carry that row
  // after the queue has taken it, including when the thread was hidden for both updates.
  const sendsAwaitingQueue = useRef(new Map<string, { threadId: string; observed: boolean }>())
  const onQueueObserved = useCallback((id: string, items: QueuedMessage[]) => {
    for (const item of items) {
      const sent = item.clientRequestId && sendsAwaitingQueue.current.get(item.clientRequestId)
      if (sent && sent.threadId === id) sent.observed = true
    }
    if (items.length) setOptimisticQueueItems((current) => {
      const remaining = current.filter((optimistic) => optimistic.threadId !== id || !items.some((item) => sameQueuedSend(item, optimistic)))
      return remaining.length === current.length ? current : remaining
    })
  }, [])
  // A compaction the person started is running: a message sent now waits in the queue until it ends.
  const compactionRunning = useMemo(
    () => messages.some((message) => message.kind === 'context_compaction' && message.streaming === true && message.compaction?.manual === true),
    [messages]
  )
  // The history Send now keeps when it skips the compaction ("182K"), from the context snapshot.
  const historyTokens = historyTokensOf(contextUsage) || undefined
  const queueHold = useMemo(() => (compactionRunning ? { historyTokens } : null), [compactionRunning, historyTokens])
  // An unsaved edit of a queued message that started meanwhile goes to its thread's composer (shown or not) with the
  // message's images, browser elements and references. Files are kept by thread here, like a paste.
  const addComposerFiles = useCallback((threadId: string, files: AttachedFile[]) => {
    const key = composerMediaKey(threadId)
    if (key === activeMediaKeyRef.current) { setAttachedFiles((current) => [...current, ...files]); return }
    const current = mediaByThreadRef.current[key] ?? EMPTY_COMPOSER_MEDIA
    mediaByThreadRef.current[key] = { files: [...current.files, ...files], voice: current.voice }
  }, [setAttachedFiles])
  const onQueueDraftToComposer = useCallback((threadId: string, recovered: RecoveredQueueDraft) => {
    // Images that could not be fetched are said above the composer (or in a toast for a thread not shown), never dropped silently.
    void restoreQueuedDraft(threadId, recovered, addComposerFiles, (count) => {
      if (useAppStore.getState().activeThreadId === threadId) setSendError(lostImagesLine(count))
      else showToast({ tone: 'error', message: lostImagesLine(count) })
    })
  }, [addComposerFiles])
  // The transcript's last prompt: the queue keeps a message that starts its turn until that turn's prompt shows.
  let lastUserMessage: (typeof messages)[number] | undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.role === 'user') { lastUserMessage = messages[index]; break }
  }
  // The transcript's last turn is the one a message sent now joins: a turn that takes steers runs, or a prompt sent
  // here is on its way (shown last). Otherwise, while a turn is set up (a wake, the queue's next message, a prompt from
  // another window), it would land in the previous turn's finished reply: it waits first in the queue instead.
  const replyTakesSteer = useAppStore((s) => (s.activeThreadId ? turnTakesSteer(s.turnStates[s.activeThreadId]) : false))
  const replyOpen = replyTakesSteer || (activeThreadId ? promptThreadsOnTheWay.has(activeThreadId) : false)
  const replyOpenRef = useRef(replyOpen)
  replyOpenRef.current = replyOpen
  const queue = useThreadQueue({
    threadId: activeThreadId,
    replyOpen,
    turnActive: isTurnStoppable(turnState),
    turnSettingUp: turnState?.phase === 'queued',
    optimisticItems: optimisticQueueItems,
    onQueueObserved,
    hold: queueHold,
    onDraftToComposer: onQueueDraftToComposer,
    lastPromptId: lastUserMessage?.id ?? null,
    lastPromptQueueItemId: lastUserMessage?.queueItemId ?? null,
    hiddenRequestIds: steersOnTheWay
  })
  // Read when a message is sent: whether something waits in the queue ahead of it.
  const queueItemsRef = useRef(queue.items)
  queueItemsRef.current = queue.items
  // The notice about the moved edit goes once the composer is empty again (sent or cleared).
  const { draftMoved: queueDraftMoved, dismissDraftMoved } = queue
  useEffect(() => { if (queueDraftMoved && !input.trim()) dismissDraftMoved() }, [queueDraftMoved, input, dismissDraftMoved])

  const turnActivityRequestRef = useRef(0)
  const [renderQuestions, setRenderQuestions] = useState(false)
  const [questionsAnim, setQuestionsAnim] = useState<'enter' | 'open' | 'leave'>('open')
  const questionsSnapshotRef = useRef(pendingQuestions)
  if (pendingQuestions) questionsSnapshotRef.current = pendingQuestions
  // The card closing on a thread switch belongs to the thread left behind: it does not play in the new one.
  else if (questionsSnapshotRef.current && (questionsSnapshotRef.current.threadId || undefined) !== (activeThreadId || undefined)) {
    questionsSnapshotRef.current = null
  }
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
  // Steers sent here show in the reply from the click, until the copy the service writes there arrives.
  const transcript = useMemo(() => withSteersOnTheWay(messages, queue.steersOnTheWay, queue.threadId), [messages, queue.steersOnTheWay, queue.threadId])
  const uiMessages = useMemo(() => mousseToUIMessages(transcript, turnSenders), [transcript, turnSenders])
  // Placed in a separate pass, so a permission request arriving or being answered does not convert the transcript again.
  // Messages a delta did not change stay the same objects, so only the turn that changed renders again.
  const shownMessagesRef = useRef<UIMessage[]>([])
  const shownMessages = useMemo(() => {
    // An open secret request is the form at the end of the turn that asked for it.
    const next = reuseUIMessages(shownMessagesRef.current, placePermissionRequests(withSecretRequests(uiMessages, secretRequests)))
    shownMessagesRef.current = next
    return next
  }, [uiMessages, placePermissionRequests, secretRequests])
  const secretActions = useMemo((): SecretRequestActions => ({
    save: async (request, value, keep) => { await secretsClient.answer(request.threadId, request.requestId, value, keep); refreshSecretRequests() },
    useSaved: async (request) => { await secretsClient.useSaved(request.threadId, request.requestId); refreshSecretRequests() },
    decline: async (request) => { await secretsClient.decline(request.threadId, request.requestId); refreshSecretRequests() }
  }), [secretsClient, refreshSecretRequests])
  const approvalRequest = permissionRequests.current
  const approvalRowId = approvalRequest ? `permission:${approvalRequest.requestId}` : null
  const approvalPlaced = approvalRowId !== null && shownMessages.some((message) => message.id === approvalRowId)
  // `focusPendingRequest` from the sidebar: once this thread is open, show its waiting request in the transcript.
  usePendingRequestFocus(
    activeThreadId,
    approvalPlaced ? approvalRowId : (shownMessages.find(isWaitingPermissionRequest)?.id ?? null)
  )
  // Images can come by name only (older ones of a long thread of another computer, or large ones of a message as it is
  // written); their bytes are fetched as the thread shows them.
  const imagesMissing = useMemo(() => missingImages(messages, 1).length > 0, [messages])
  // Opening a thread (also Retry, which opens it again) asks again for images that could not be fetched before.
  useEffect(() => {
    if (activeThreadId) forgetMessageImageRequests(activeThreadId)
  }, [activeThreadId, activeThread?.offline])
  useEffect(() => {
    if (imagesMissing && activeThreadId) void hydrateMessageImages(activeThreadId)
  }, [imagesMissing, activeThreadId, messages.length])
  const optimisticSubagentStarting = isSubagentStartingOptimistically({
    subagent: ownSubagent?.subagent,
    turnPhase: turnState?.phase,
    messageCount: shownMessages.length,
    hasSetupFailure: Boolean(activeThread?.setupFailure)
  })
  const chatStatus = useMemo(() => {
    const base = chatStatusFromTurn(turnState)
    return optimisticSubagentStarting && base === 'ready' ? 'submitted' : base
  }, [turnState, optimisticSubagentStarting])
  const turnActive = isTurnActivePhase(turnState?.phase ?? 'idle') || optimisticSubagentStarting
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
    [setPendingQuestions]
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

  // A deleted thread's staged files and voice notes (a recovered queued edit's images among them) are let go.
  useEffect(() => useAppStore.subscribe((state, previous) => {
    for (const threadId of deletedThreadIds(previous, state)) {
      const key = composerMediaKey(threadId)
      const media = mediaByThreadRef.current[key]
      if (!media || key === activeMediaKeyRef.current) continue
      releaseComposerMediaUrls(media)
      delete mediaByThreadRef.current[key]
    }
  }), [])

  useEffect(() => {
    return () => {
      for (const media of Object.values(mediaByThreadRef.current)) {
        releaseComposerMediaUrls(media)
      }
      mediaByThreadRef.current = {}
    }
  }, [])

  useEffect(() => {
    const unsubConnection = window.mousse.orchestrator.onConnectionFailed(() => {
      setConnectionFailed(true)
    })
    return () => {
      unsubConnection()
    }
  }, [activeThreadId])

  // The newest read of the shown model (or pick) decides the picker: an older read that answers late changes nothing.
  const selectionRequestRef = useRef(0)
  // Saves of model picks run one after another, in the order picked.
  const modelSaveRef = useRef<Promise<void>>(Promise.resolve())
  const refreshSelection = useCallback(async () => {
    if (!profileReady) return
    const selectionRequest = ++selectionRequestRef.current
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
    const compaction = normalizeContextSettings(settings.context)
    setContextCompactionSetting((current) =>
      current?.compactionEnabled === compaction.compactionEnabled && current.compactionTokens === compaction.compactionTokens &&
        current.idleCompaction === compaction.idleCompaction
        ? current
        : compaction
    )
    // The thread's model, else the one the composer starts on; with neither yet, the shown model stays.
    // Only the newest read (and no pick since it began) sets the model shown: settings read before a pick are older than it.
    if (selectionRequest === selectionRequestRef.current) {
      const selectedModel = composerSelection({ threadModel: selectionThreadModel, profileDefault: settings.provider, providers: providersRef.current })
      setProfileDefault((current) =>
        current?.llmProvider === settings.provider.llmProvider &&
        current.instanceId === settings.provider.instanceId &&
        current.model === settings.provider.model
          ? current
          : { ...settings.provider }
      )
      // The picker shows the other computer's model while a chat that runs there is open.
      if (!remoteNodeRef.current && selectedModel) {
        setSelectedLlmProvider(selectedModel.llmProvider)
        setSelectedInstanceId(selectedModel.instanceId)
        setSelectedModelId(pickerModelId(selectedModel))
      }
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
  }, [selectionThreadModel, activeThreadId, profileReady, profileId])

  // Picking a computer swaps the picker to its default model (or its first usable one, as on this
  // computer); coming back restores this computer's. A thread of another computer shows the model it
  // has there. That computer is asked again (on focus, after a failed read): an answer that only
  // changes its default keeps a model the person picked meanwhile.
  const remoteDefault = remoteOptions.defaultModel
  const remoteDefaultKey = remoteDefault ? JSON.stringify(remoteDefault) : ''
  const remoteDefaultRef = useRef(remoteDefault)
  remoteDefaultRef.current = remoteDefault
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
  // The local empty thread behind a draft for that computer is not the chat; a thread already made there is.
  const remoteThreadModel = activeThread && (activeThread.node ?? undefined) === remoteNode ? activeThreadModelOverride : undefined
  useEffect(() => {
    if (!remoteNode || !remoteOptions.loaded) return
    const own = pickedModel ?? remoteThreadModel
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
  }, [remoteNode, remoteDraft, remoteOptions.loaded, remoteDefaultKey, remoteThreadModel, pickedModel, providers])

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
    const draft = buildMessageContent()
    // Debounce context metering: typing and stream deltas used to fire an IPC
    // on every keystroke/token and stalled thread switches + model changes.
    // A thread just opened is measured at once, so its ring and chip come with its transcript.
    const timer = window.setTimeout(() => {
      measuredContextKey.current = contextKey
      measureContext(activeThreadId, contextKey, contextVersion, draft)
    }, measuredContextKey.current === contextKey ? 350 : 0)

    return () => window.clearTimeout(timer)
  }, [
    activeThreadId,
    contextKey,
    contextVersion,
    measureContext,
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
    const refresh = () => measureContext(activeThreadId, contextKey, contextVersion, buildMessageContent())
    const interval = window.setInterval(refresh, 5_000)
    return () => window.clearInterval(interval)
  }, [loading, activeThreadId, contextKey, contextVersion, measureContext, buildMessageContent])

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
      onUnsent?: () => void,
      /** The conversation branch the message must land on (an edited prompt's); refused on another. */
      conversationBranchId?: string,
      /** The settings the composer showed, which the turn must run on (a new chat's first send). */
      expect?: SendExpectation,
      /**
       * Steer: a message the running turn could not take yet (it is still being set up) is sent now once queued. `row`:
       * the copy painted in the reply since the click, which the send keeps instead of painting it again.
       */
      steer?: boolean | { row: string | null },
      /** The copy of this message shown since the click (a new chat's first message): it is kept, not painted again. */
      firstPrompt?: ShownFirstPrompt,
      steerTarget?: { runId?: string; retry?: SteerRetry }
    ) => {
      if (!content && !(images && images.length)) return

      setConnectionFailed(false)
      setSendError(null)
      const stillVisible = () => useAppStore.getState().profileId === profileId && useAppStore.getState().activeThreadId === targetThreadId
      const steerRunId = steerTarget?.runId
      const request = {
        content: content || (images?.length ? '[Image attachment]' : ''),
        mode,
        images,
        ...(conversationBranchId ? { conversationBranchId } : {}),
        ...(expect ? { expect } : {}),
        // Steer goes with the message: the service sends it into the turn, or keeps it first to join the turn being set
        // up, whatever this window shows by the time the send answers. Another computer's thread is asked below instead.
        ...(steer && targetThreadId && !isQualifiedId(targetThreadId) ? { steer: true, ...(steerRunId ? { steerRunId } : {}) } : {})
      }
      // Everything below up to the first await paints the message, in the same frame as the composer clears: it is
      // never off the screen. Its retry id is read after it shows (`requestId`).
      // Paint an ordinary send before IPC/disk/provider work. The App event handler swaps this
      // row for the durable message by matching its content; stale hydration snapshots retain it.
      // The messages the transcript had before this one, to tell it from an identical one sent earlier.
      const seenBefore = new Set(useAppStore.getState().messages.map((message) => message.id))
      // During a reply or a compaction the message goes to the queue, so it is painted there; so does one sent while
      // an earlier prompt is still on its way (its turn is not reported running yet), or while messages wait in the
      // queue (between two queued turns). Messages a Stop held wait for the person: a send starts its turn at once.
      const onTheWay = targetThreadId ? promptsOnTheWay.current.get(targetThreadId) ?? 0 : 0
      const queueWaiting = Boolean(targetThreadId) && targetThreadId === queue.threadId && queueItemsRef.current.some((item) => !item.heldAfterStop)
      const queuesNow = loading || turnActive || compactionRunning || onTheWay > 0 || queueWaiting
      const optimisticMessageId = !queuesNow && targetThreadId
        ? firstPrompt?.id ?? `optimistic:${crypto.randomUUID()}`
        : null
      if (firstPrompt) {
        firstPrompt.taken = true
        // Shown since the click: it stays as it is (the same row, the same start), or goes to the queue with the send.
        if (optimisticMessageId !== firstPrompt.id) useAppStore.getState().dropMessage(targetThreadId, firstPrompt.id)
      }
      const promptThread = optimisticMessageId ? targetThreadId : null
      if (promptThread) notePromptOnTheWay(promptThread, 1)
      // A steer queued first shows in the reply from now on, not only once it is sent now. One painted since the click
      // stays the same row; it goes if the message starts a turn of its own instead. While the transcript's last turn
      // is not the one it joins (a turn is still being set up), it shows in the queue, first, until a turn takes it.
      const shownRow = typeof steer === 'object' ? steer.row : null
      const paintsSteer = Boolean(steer) && queuesNow && targetThreadId === queue.threadId && replyOpenRef.current && (!request.steer || replyTakesSteer)
      if (shownRow && !paintsSteer) queue.endComposerSteer(shownRow, false)
      const steerRow = paintsSteer ? shownRow ?? queue.beginComposerSteer(request.content, images) : null
      if (optimisticMessageId) {
        useAppStore.getState().addMessage({
          id: optimisticMessageId,
          role: 'user',
          content: request.content,
          timestamp: optimisticMessageId === firstPrompt?.id ? firstPrompt.at : new Date().toISOString(),
          images
        })
      }
      // A steered message painted in the reply is not painted in the queue too.
      const optimisticQueueId = queuesNow && targetThreadId && !paintsSteer ? `optimistic:${crypto.randomUUID()}` : null
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
          ...(request.steer ? { sendsNext: true as const } : {}),
          source: 'gui'
        }])
      }
      // Painted in the queue, but the service started its turn at once: the copy leaves the queue as the transcript
      // shows the message, not when the send answers (at the end of that turn).
      const stopWatchingStart = optimisticQueueId && targetThreadId
        ? useAppStore.subscribe((state, previous) => {
          if (state.messages === previous.messages || state.activeThreadId !== targetThreadId) return
          if (!startedAsPrompt(state.messages, seenBefore, request.content)) return
          stopWatchingStart?.()
          setOptimisticQueueItems((current) => current.filter((item) => item.id !== optimisticQueueId))
        })
        : undefined
      // Optimistically mark the selected thread busy; queue accepts keep loading true.
      setLoading(true)
      // Promote drafts immediately and pin the thread to the top of its group
      // on user send. Agent streaming must not change sidebar order.
      if (targetThreadId) {
        const store = useAppStore.getState()
        const current = store.threads.find((t) => t.id === targetThreadId)
        if (current && !current.archivedAt) {
          const siblings = store.threads.filter(
            (entry) => (entry.projectId ?? null) === (current.projectId ?? null) && !entry.archivedAt
          )
          const minOrder = siblings.reduce((min, entry) => Math.min(min, entry.order), current.order)
          store.upsertThread({
            ...current,
            startedAt: current.startedAt ?? new Date().toISOString(),
            order: current.order === minOrder ? current.order : minOrder - 1
          })
        }
      }
      let signature = ''
      let requestId = ''
      try {
        // Keep retry identities across navigation without retaining message/image bodies. The message is sent even if
        // its thread was left meanwhile: it is already shown there.
        signature = steerTarget?.retry?.signature ?? await sendSignature(profileId, targetThreadId, content, mode, images, request.steer)
        const retry = steerTarget?.retry ?? sendIds.current.retry(signature)
        if (request.steer && retry) request.steerRunId = retry.context
        // The service's retry key: a send that may have arrived lends its id to the same message sent again.
        requestId = sendIds.current.begin(signature, request.steerRunId, retry)
        const sentId = requestId
        const pendingQueue = targetThreadId ? { threadId: targetThreadId, observed: false } : undefined
        if (pendingQueue) sendsAwaitingQueue.current.set(sentId, pendingQueue)
        if (paintsSteer) setSteersOnTheWay((current) => new Set(current).add(sentId))
        // The daemon's item carries the same id: whichever arrives first, the queue shows one.
        if (optimisticQueueId) setOptimisticQueueItems((current) => current.map((item) => item.id === optimisticQueueId ? { ...item, clientRequestId: sentId } : item))
        const result = await (targetThreadId
          ? window.mousse.orchestrator.sendToThread(targetThreadId, { requestId: sentId, ...request })
          : window.mousse.orchestrator.send({ requestId: sentId, ...request })
        ).finally(() => sendIds.current.replied(sentId))
        if (result.error && result.requestAcknowledged === false) throw result.error
        sendIds.current.settle(signature, requestId, 'answered')
        if (useAppStore.getState().profileId !== profileId) return
        // Another computer's thread needs a separate Send now for the original thread.
        if (steer && !request.steer && result.queued && result.queueItem && !result.steerApplied && targetThreadId && targetThreadId === queue.threadId) {
          if (stillVisible()) void queue.steer(result.queueItem.id, result.queueItem)
          else if (useAppStore.getState().profileId === profileId) void window.mousse.queue.promoteToSteer(targetThreadId, result.queueItem.id).catch(() => undefined)
        }
        // A queue push can replace the copy before the send answers. Reconcile it even after navigation.
        if (optimisticQueueId) {
          setOptimisticQueueItems((current) => current.flatMap((item) =>
            item.id !== optimisticQueueId ? [item] : !pendingQueue?.observed && result.queued && result.queueItem ? [result.queueItem] : []
          ))
        }
        // A queued message is shown in the queue. A replay of a delivered Steer already has its own transcript row.
        if (optimisticMessageId && (result.queued || (request.steer && result.accepted && result.steerApplied))) {
          useAppStore.getState().dropMessage(targetThreadId, optimisticMessageId)
          if (result.queueItem && !pendingQueue?.observed) {
            const held = result.queueItem
            setOptimisticQueueItems((items) => [...items.filter((item) => item.id !== held.id), held])
          }
        }
        if (!stillVisible()) return
        if (steerRow) queue.endComposerSteer(steerRow, false)
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
        const observed = sendsAwaitingQueue.current.get(requestId)?.observed
        const uncertain = isOutcomeUncertain(error)
        sendIds.current.settle(signature, requestId, observed ? 'arrived' : uncertain ? 'unknown' : 'refused')
        if (useAppStore.getState().profileId !== profileId) return
        if (observed) return true
        if (!stillVisible()) {
          if (uncertain) return 'uncertain' as const
          if (optimisticMessageId) useAppStore.getState().dropMessage(targetThreadId, optimisticMessageId)
          if (optimisticQueueId) setOptimisticQueueItems((current) => current.filter((item) => item.id !== optimisticQueueId))
          return false
        }
        setSendError(boundSendRefusal(error, Boolean(expect)) ?? sendErrorLine(error))
        // Settings changed since they were shown: the composer shows what the thread really runs now, and for a thread of
        // another computer that computer's default mode and this device's limit too, which the thread may run in.
        const refusedCode = errorCodeOf(error)
        if ((refusedCode === 'thread_settings_changed' || refusedCode === 'first_send_unbound') && targetThreadId) {
          void window.mousse.threads.get(targetThreadId).then((thread) => { if (thread && stillVisible()) useAppStore.getState().upsertThread(thread) }).catch(() => undefined)
          const node = useAppStore.getState().threads.find((thread) => thread.id === targetThreadId)?.node
          if (node) void refreshRemoteComposerOptions(node as NodeId).catch(() => undefined)
        }
        const changes = pendingChangesDetails(error)
        setSendChanges(changes ? { line: sendErrorLine(error), message: errorText(error), details: changes } : null)
        if (uncertain && targetThreadId) {
          // No answer came (another computer did not confirm, or the reply timed out): the message may be there. Keep what is shown, read the thread again,
          // and only then say whether it arrived. Sending the same text again replays this request, so it cannot run twice.
          const thread = targetThreadId
          void settleUncertainSend({
            refresh: () => window.mousse.threads.select(thread),
            arrived: async () => {
              // A steer can leave the queue before this window sees it. Admission is still in the send receipt.
              if (request.steer) {
                const { accepted } = await window.mousse.platformRequest.request<{ accepted: boolean }>(
                  'orchestrator.sendAccepted', { threadId: thread, clientRequestId: requestId }
                )
                return accepted
              }
              if (optimisticQueueId) return (await window.mousse.queue.list(thread)).some((item) => item.clientRequestId === requestId)
              return useAppStore.getState().messages.some((message) =>
                message.role === 'user' && !message.id.startsWith('optimistic:') && !seenBefore.has(message.id) && message.content === request.content)
            },
            dropOptimistic: () => {
              if (optimisticQueueId) setOptimisticQueueItems((current) => current.filter((item) => item.id !== optimisticQueueId))
              if (optimisticMessageId) useAppStore.getState().dropMessage(targetThreadId, optimisticMessageId)
            }
          }).then((outcome) => {
            // It arrived: the same text sent later is a new message, not a repeat of this one.
            sendIds.current.settle(signature, requestId, outcome === 'arrived' ? 'arrived' : 'unknown')
            if (!stillVisible()) return
            if (outcome === 'missing' && sendIds.current.retry(signature)?.id === requestId) {
              setSendError(`${sendErrorLine(error)} It did not arrive, so it is back in the composer.`)
              if (onUnsent) onUnsent()
              else setInput((current) => current || extractChatReferences(content).text)
            } else if (outcome === 'arrived') setSendError(null)
          })
          return 'uncertain' as const
        }
        if (!onUnsent) setInput((current) => current || extractChatReferences(content).text)
        if (optimisticQueueId) {
          setOptimisticQueueItems((current) => current.filter((item) => item.id !== optimisticQueueId))
        }
        if (optimisticMessageId) useAppStore.getState().dropMessage(targetThreadId, optimisticMessageId)
        const stillActive = await window.mousse.orchestrator.isTurnActive(
          targetThreadId ?? undefined
        ).catch(() => false)
        if (stillVisible()) setLoading(stillActive)
        return false
      } finally {
        sendsAwaitingQueue.current.delete(requestId)
        if (steer) setSteersOnTheWay((current) => { const next = new Set(current); next.delete(requestId); return next })
        if (steerRow) queue.endComposerSteer(steerRow, false)
        if (promptThread) notePromptOnTheWay(promptThread, -1)
        stopWatchingStart?.()
      }
    },
    [activeThreadId, profileId, chatMode, loading, turnActive, compactionRunning, replyTakesSteer, setLoading, notePromptOnTheWay, queue.threadId, queue.items.length, queue.steer, queue.beginComposerSteer, queue.endComposerSteer]
  )

  // The thread's subagents, and whether any still runs: the chat then shows "Waiting for subagents…".
  const threadSubagents = useSubagents(newChat ? null : activeThreadId)
  const subagentsRunning = threadSubagents.some(isRunningSubagent)
  // What else it runs in the background (monitors, commands, holds, the provider's own work).
  const backgroundWork = useBackgroundWork(newChat ? null : activeThreadId)
  const handleStop = useCallback(async () => {
    // A thread whose own turn has ended but that waits for its subagents only: Stop stops them, as Lineage's Stop all.
    // With background work as well, the thread's Stop ends all of it, its subagents included.
    if (activeThreadId && !turnStoppable && !turnActive && !loading && subagentsRunning && !backgroundWork) {
      await stopAllSubagents({ stopAll: window.mousse.subagents.stopAll, abort: window.mousse.orchestrator.abort }, activeThreadId, threadSubagents)
      return
    }
    // The thread shows stopped at the click; the daemon confirms it.
    if (activeThreadId) await stopThreadNow(activeThreadId)
    else await window.mousse.orchestrator.abort()
    await refreshTurnActive()
  }, [activeThreadId, refreshTurnActive, turnStoppable, turnActive, loading, subagentsRunning, threadSubagents, backgroundWork])
  // Stop run is bound to a key; the command's own rule limits it to a thread with a run going.
  useCommand('run.stop', () => void handleStop())

  // Retry and Continue on the last turn send through the normal path, never while a run is going.
  const resendBusy = turnActive || loading
  const turnActions = useMemo<TurnActions | null>(() => {
    if (!activeThreadId) return null
    const actions = createTurnActions({
      // Read at use: depending on the transcript would rebuild this on every streamed token.
      prompt: (promptId) => useAppStore.getState().messages.find((message) => message.id === promptId && message.role === 'user'),
      send: (content, images) => {
        if (resendBusy || !useAppStore.getState().workspaceReady) return
        void sendMessage(content, chatMode, images, activeThreadId)
      },
      // SPEC §16.4: a run a restart left uncertain continues as itself, with the tools the person confirmed acknowledged.
      continueRunOf: (runId) => {
        if (resendBusy || !useAppStore.getState().workspaceReady) return
        void window.mousse.orchestrator.sendToThread(activeThreadId, { content: 'Continue where you left off.', mode: chatMode, continuationOfRunId: runId, acknowledgeUncertain: true })
          .then((result) => {
            if (result.error) showToast({ tone: 'error', message: readableError(result.error, "The run couldn't be continued. Try again.") })
          })
          .catch((error: unknown) => showToast({ tone: 'error', message: readableError(error, "The run couldn't be continued. Try again.") }))
      },
      // The fork opens once it is made; a turn that can't be forked says why.
      forkFrom: (turnId) => {
        void window.mousse.threads.fork(activeThreadId, { atRunId: turnId }).catch((error: unknown) => {
          showToast({ tone: 'error', message: readableError(error, "This turn couldn't be forked. Try again.") })
        })
      },
      // An edited prompt: the conversation goes back to before that prompt on a new branch, made and switched to in
      // one step by the daemon; the files stay as they are. The edited text is sent there, naming that branch, with the
      // prompt's images and attached files. The original stays a version to switch back to.
      editPrompt: async (promptId, turnId, text) => {
        try {
          const history = await readThreadActionHistory(activeThreadId, true)
          const action = editablePrompt(history, turnId)
          if (!action) throw new Error("This message can't be edited now.")
          // The prompt's images and files go with the edit. They are read now, before the switch puts back the
          // conversation from before the prompt; an image known here by name only (another computer's thread) is
          // fetched first. The editor shows only the text, so the files are named again after it.
          const prompt = useAppStore.getState().messages.find((message) => message.id === promptId && message.role === 'user')
          const original = prompt?.images ?? []
          const files = attachedFilesIn(prompt?.content ?? '')
          const content = files.length ? [text.trim(), formatAttachedFilesMarker(files)].filter(Boolean).join('\n\n') : text
          const images = await Promise.all(original.map(async (image, index) => image.data ? image
            : { ...image, ...await window.mousse.threads.messageImage(activeThreadId, promptId, index) }))
          const { branch } = await window.mousse.actions.fork({
            threadId: activeThreadId, actionId: action.id, at: 'start', activate: true, name: 'Edited', expectedJournalGeneration: history.journalGeneration
          }) as { branch: { id: string } }
          invalidateThreadActionHistory(activeThreadId)
          await sendMessage(content, chatMode, images.length ? images : undefined, activeThreadId, undefined, branch.id)
        } catch (error) {
          showToast({ tone: 'error', message: readableError(error, "The edited message wasn't sent. Try again.") })
          throw error
        }
      }
    })
    return { ...actions, stopCompaction: () => void window.mousse.threads.stopCompaction(activeThreadId).catch(() => undefined) }
  }, [activeThreadId, resendBusy, sendMessage, chatMode])

  // Compact now (the composer's chip, the context popover): it starts at once and runs while the person types.
  // Until the daemon's compaction row arrives, and while the request is out, the chip reads Compacting….
  // Never offered beside work in progress: a running turn, or working subagents whose results come back to this thread.
  const subagentsWorking = threadSubagents.some(isWorkingSubagent)
  // The composer works as the thread shows: while it is working or waiting (its subagents, a turn ending, a turn that
  // started elsewhere), it offers Queue and Steer and a send follows them, even when this window has no running turn.
  // A prompt sent here counts from the send: its turn may not be reported running for a moment yet.
  const promptOnTheWay = activeThreadId !== null && promptThreadsOnTheWay.has(activeThreadId)
  const composerWorking = turnActive || loading || promptOnTheWay || isThreadActivityActive(activeThreadActivity) || subagentsRunning
  const [compactingThread, setCompactingThread] = useState<string | null>(null)
  const handleCompactNow = useCallback(() => {
    const threadId = activeThreadId
    if (!threadId || turnActive || loading || subagentsWorking) return
    setCompactingThread(threadId)
    // The compaction rows already in the conversation: a new one means this compaction started, and its row says how it ended.
    const compactionRows = () => useAppStore.getState().messages.filter((message) => message.kind === 'context_compaction').map((message) => message.id)
    const rowsBefore = new Set(compactionRows())
    void window.mousse.threads.compact(threadId)
      .catch((error: unknown) => {
        // Only a refusal before the compaction started is said here, and only on the thread that asked.
        const line = compactNowFailureLine(error)
        if (!line) console.warn('[compact] Compact now got no answer', { threadId, error: errorText(error) })
        else if (useAppStore.getState().activeThreadId === threadId && compactionRows().every((id) => rowsBefore.has(id))) setSendError(line)
      })
      .finally(() => setCompactingThread((current) => (current === threadId ? null : current)))
  }, [activeThreadId, turnActive, loading, subagentsWorking])

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
    // A compaction that got no answer in time may still be running; its row in the conversation says how it ends.
    compact: async (threadId, focus) => {
      try {
        await window.mousse.threads.compact(threadId, focus)
      } catch (error) {
        if (!isRequestTimeout(error)) throw error
        console.warn('[compact] /compact got no answer', { threadId, error: errorText(error) })
      }
    },
    fork: async (threadId) => { await window.mousse.threads.fork(threadId) },
    rename: async (threadId, title) => { await window.mousse.threads.rename(threadId, title) },
    // The sidebar cancels the event when it opened the thread's rename box.
    openRename: (threadId) => !window.dispatchEvent(new CustomEvent('mousse:rename-thread', { detail: { threadId }, cancelable: true })),
    goal: (threadId, action, text) => window.mousse.platformRequest.request<{ text?: string }>('threads.goal', { threadId, action, ...(text !== undefined ? { text } : {}) })
  })

  // A message sent from the warm start (WarmChat) while the window was connecting goes once, as an ordinary send of the
  // thread's draft, as soon as this chat has read the profile's settings. A send held for another thread is dropped;
  // its text stays in that thread's draft.
  const handleSendRef = useRef<typeof handleSend | null>(null)
  const selectionRead = profileDefault !== undefined
  useEffect(() => {
    if (!workspaceReady || !selectionRead) return
    if (useAppStore.getState().takeWarmSend(activeThreadId)) void handleSendRef.current?.()
  }, [workspaceReady, selectionRead, activeThreadId])
  const handleSend = async (skillMode?: SkillChatMode, options?: { steer?: boolean; skipQuestions?: boolean }) => {
    if (!useAppStore.getState().workspaceReady) return
    // A file is sent as its path on this computer, which the agent of a thread on another computer can't read. A long
    // paste is text, so there it goes in the message itself.
    const inlinePastes = remoteNode ? attachedFiles.filter((attached) => attached.pastedText && !attached.path) : []
    const sentFiles = inlinePastes.length ? attachedFiles.filter((attached) => !inlinePastes.includes(attached)) : attachedFiles
    if (remoteNode && fileAttachments(sentFiles).length) {
      setSendError(REMOTE_FILES_REFUSAL)
      return
    }
    const startingBlank = newChat
    let targetThreadId = activeThreadId
    // A quick action may already be preparing this new chat; a second send would create another thread.
    if (firstSendShown || isWorkspacePending(useAppStore.getState())) return
    // Held from the click, without a render: a quick action or a second Send for this chat is refused until it ends.
    const releaseHold = startingBlank ? holdNewChat(profileId, activeThreadId) : undefined
    if (startingBlank && !releaseHold) return
    // Only this send's own lock is cleared, never one a quick action set.
    let locked = false
    const lockWorkspace = () => {
      locked = true
      useAppStore.getState().setWorkspacePending(profileId, activeThreadId, true)
    }
    const releaseWorkspacePending = () => {
      if (!startingBlank) return
      releaseHold?.()
      if (!locked) return
      locked = false
      const store = useAppStore.getState()
      store.setWorkspacePending(profileId, activeThreadId, false)
      store.setWorkspacePending(profileId, targetThreadId, false)
    }
    const stillVisible = () => useAppStore.getState().profileId === profileId && useAppStore.getState().activeThreadId === targetThreadId
    let pendingRow: PendingThreadRow | undefined
    // The message as shown in the transcript from the click, and the threads it was shown in (the chat at the click,
    // then the thread made for it).
    let firstPrompt: ShownFirstPrompt | undefined
    const firstPromptIn = new Set<string | null>([activeThreadId])
    // What was typed while the row's frame was drawn (the composer is not locked yet): kept when the send clears it.
    let typedMeanwhile = ''
    // On a thread already made, what was typed after the click while the send was still being prepared (references,
    // files, a command, the model it runs on): the clear keeps it as the start of the next message.
    const typedSince = () => startingBlank ? '' : typedAfterSend(input, useAppStore.getState().composerDrafts[activeThreadId ?? '__blank__'] ?? '')
    let keptTyped = ''
    const clearSent = (releaseUrls?: boolean) => {
      keptTyped = typedSince()
      clearComposer(releaseUrls)
      if (keptTyped) setInput(keptTyped)
    }
    // A message that did not go comes back to the composer: ahead of what the clear kept, as the draft was; never over
    // a message typed since.
    const unsentText = (current: string, sent: string) =>
      !current || current === sent ? input : keptTyped && current === keptTyped ? input + keptTyped : current
    try {
    // The thread this send starts is listed now, before anything below awaits: the sidebar paints its row in the next
    // frame, named from the prompt and Working, and the thread's own row takes its place when the service lists it.
    pendingRow = startingBlank
      ? pendingThreadRow({
        profileId,
        text: input,
        attached: attachedFiles.length > 0 || voiceMessages.length > 0 || browserElements.length > 0 || references.length > 0,
        shown: activeThread,
        reuses: Boolean(activeThread) && !composerCreatesThread(activeThread, workspace),
        workspace,
        threads: useAppStore.getState().threads
      })
      : undefined
    if (pendingRow) {
      addPendingThreadRow(pendingRow)
      // The message shows in the transcript in the same frame, under Working (from the click) and Starting…, while its
      // thread is made and set up. Its files and images join it when the send paints it with them.
      const shown = removeInlineSkillToken(buildComposerMessageContent(input, [], voiceMessages, browserElements), enabledSkills).trim()
      if (shown) {
        firstPrompt = { id: `optimistic:${crypto.randomUUID()}`, at: new Date(pendingRow.at).toISOString(), taken: false }
        useAppStore.getState().addMessage({ id: firstPrompt.id, role: 'user', content: shown, timestamp: firstPrompt.at })
        const shownId = firstPrompt.id
        setFirstSendIds((current) => new Set(current).add(shownId))
      }
      // Locking the composer redraws the whole chat, so it waits for the row's frame; the hold above stops a second send.
      await afterNextPaint()
      lockWorkspace()
      typedMeanwhile = typedAfterSend(input, useAppStore.getState().composerDrafts[activeThreadId ?? '__blank__'] ?? '')
    } else if (startingBlank) lockWorkspace()
    const resolutionProfile = profileId
    const resolutionThread = activeThreadId
    const resolvedReferences = await resolveChatReferences(references)
    if (useAppStore.getState().profileId !== resolutionProfile || useAppStore.getState().activeThreadId !== resolutionThread) return
    // The images as prepared when they were attached (nothing is fitted again here); one made smaller also goes as its
    // original file. Send is disabled until they are ready, so this is null only after a change in the same moment.
    const fitted = preparedSend(sentFiles, preparation.snapshot)
    if (!fitted) return
    // Files other than images go as paths: a pasted one is written to a temporary file first.
    const filePaths = await composerFilePaths(fitted.files, activeThreadId)
    const pastedTexts = await Promise.all(inlinePastes.map(async (attached) => ({ name: attachedFileName(attached), text: await attached.file.text() })))
    if (useAppStore.getState().profileId !== resolutionProfile || useAppStore.getState().activeThreadId !== resolutionThread) return
    let text = removeInlineSkillToken(
      buildComposerMessageContent(input, fitted.files, voiceMessages, browserElements, resolvedReferences, filePaths, pastedTexts),
      enabledSkills
    )
    // The service refuses a longer message with a raw error; say what to do instead.
    if (text.length > MMS_PROTOCOL_MAX_TEXT_LENGTH) {
      setSendError(pastedTexts.length ? REMOTE_PASTE_TOO_LONG : MESSAGE_TOO_LONG)
      return
    }
    const images = fitted.images
    if (!stillVisible()) return
    const trimmed = text.trim()

    // Composer commands run here before they can become an ordinary agent prompt
    // (`lib/slashCommands.ts`). The usage dialog intentionally contains every configured provider.
    const attached = images.length > 0 || attachedFiles.length > 0 || voiceMessages.length > 0 || browserElements.length > 0 || resolvedReferences.length > 0
    const command = await runSlashCommand(trimmed, slashCommandEnv(attached))
    // A command's earlier answer (`/goal` alone) is about what was true then.
    if (command) setCommandInfo(null)
    // A retry of a send-with-Steer must take the receipt-based path even if the reply now takes direct Steer.
    let retrySteer: SteerRetry | undefined
    if (!command && activeThreadId && !isQualifiedId(activeThreadId) && sendIds.current.hasRetry) {
      const signature = await sendSignature(profileId, activeThreadId, text, skillMode ?? chatMode, images, true)
      if (!stillVisible()) return
      const retry = sendIds.current.retry(signature)
      if (retry) retrySteer = { signature, ...retry }
    }
    let steerQueued = false
    // A steer the turn could not take yet, painted in the reply since the click: the send below keeps that row.
    let steerShown: string | null = null
    // `/goal <text>` on a new chat: the text is the first message, and the goal of the thread the send makes.
    let goalToAdopt: string | undefined
    if (command) {
      if (command.kind === 'done') {
        setInput(typedSince())
        return
      }
      if (command.kind === 'info') {
        setInput(typedSince())
        if (stillVisible()) setCommandInfo(command.message)
        return
      }
      if (command.kind === 'keep') return
      if (command.kind === 'refused') {
        if (stillVisible()) setSendError(command.message)
        return
      }
      // A /steer no turn took: next-turn guidance, sent as an ordinary message.
      text = command.text
      if (command.adoptGoal) goalToAdopt = command.text
    } else if (retrySteer || (options?.steer && !skillMode && !trimmed.startsWith('/') && (
      images.length > 0 || (activeThreadId && !isQualifiedId(activeThreadId) &&
        (turnState?.phase === 'queued' || (promptThreadsOnTheWay.has(activeThreadId) && !replyTakesSteer)))
    ))) {
      // While the run starts, send the Steer with the message. The same send also carries images.
      steerQueued = true
    } else if (options?.steer && !skillMode && images.length === 0 && trimmed && !trimmed.startsWith('/')) {
      // Steer (Ctrl/Cmd+Enter) during a run: the text goes into the running turn instead of the queue. The composer
      // clears at once, as a send does: what is typed while this steer is on its way is the next message, and a clear
      // when the steer answers would wipe it.
      clearSent(false)
      const steerThread = activeThreadId
      const seenBefore = new Set(useAppStore.getState().messages.map((message) => message.id))
      // It shows in the reply at once, as sent, until the copy the service writes there arrives.
      const steerRow = steerThread && steerThread === queue.threadId ? queue.beginComposerSteer(trimmed) : null
      let steered: boolean | 'queued' | 'uncertain'
      try {
        steered = await window.mousse.orchestrator.steer(trimmed, steerThread ?? undefined)
      } catch {
        // No answer: the steer may have reached the reply. It is not sent again (it would run twice); the thread is
        // read again, and the text comes back to the composer only if it did not arrive.
        steered = 'uncertain'
      }
      // Not taken yet: it stays in the reply while it is queued and sent now below (a timer takes it out if no send follows).
      if (steerRow) queue.endComposerSteer(steerRow, steered === true || steered === false)
      if (steerRow && steered === false) steerShown = steerRow
      if (steered === 'uncertain') {
        setSendError(STEER_UNCONFIRMED)
        if (steerThread) {
          void settleUncertainSend({
            refresh: () => window.mousse.threads.select(steerThread),
            arrived: async () =>
              useAppStore.getState().messages.some((message) => message.role === 'user' && !seenBefore.has(message.id) && message.content.trim() === trimmed) ||
              (await window.mousse.queue.list(steerThread)).some((item) => item.content.trim() === trimmed),
            dropOptimistic: () => {}
          }).then((outcome) => {
            if (!stillVisible()) return
            if (outcome === 'missing') {
              setSendError(STEER_NOT_ARRIVED)
              setInput((current) => unsentText(current, trimmed))
            } else if (outcome === 'arrived') {
              setSendError(null)
              releaseComposerUrls()
            }
          })
        }
        return
      }
      if (steered === 'queued') {
        // Not steered: the running turn could not take it, so it waits at the end of the queue. Said, not hidden.
        setSendError(STEER_QUEUED)
        releaseComposerUrls()
        return
      }
      if (steered) {
        releaseComposerUrls()
        return
      }
      // The turn cannot take it yet (it is still being set up, or it was stopped): it is queued and sent now, so it
      // goes into the turn as soon as it runs, or first.
      steerQueued = true
    }

    if (!text && images.length === 0) return

    // Questions open above the composer: the message, with its images and files, answers the question the card
    // shows, and the card moves on to the next unanswered one. Answering the last one submits all the answers, once,
    // each question with its own images. The card's "Skip questions and send" sends it as usual instead.
    const asked = questionsTakeMessage && !options?.skipQuestions && !retrySteer ? pendingQuestions : null
    const card = questionCardRef.current
    if (asked && card && (text || images.length > 0)) {
      // It answers a question instead: it is not on its way into the reply.
      if (steerShown) queue.endComposerSteer(steerShown, false)
      const answered = card.answerWithMessage(text, images)
      if (!answered) {
        clearSent()
        return
      }
      const outcome = await window.mousse.orchestrator.answerQuestionsDetailed(
        asked.requestId,
        answered.answers,
        questionAnswerThreadId(asked, activeThreadId),
        answered.attachments
      )
      setPendingQuestions((current) => (current?.requestId === asked.requestId ? null : current))
      if (outcome.ok) {
        clearSent()
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

    // What the first turn of a new chat is bound to (`expect`): the daemon runs nothing on other settings.
    let bound: SendExpectation | undefined
    let autoModelRevision: number | undefined
    if (newChat && !retrySteer) {
      // What the composer shows at this click, read before anything below awaits.
      const wanted = selectedProviderId && selectedModelId
        ? { ...selectionFor(selectedProviderId), ...pickedSelection(selectedModelId) }
        : undefined
      const shownMode = shownPermissionMode
      const shownThread = activeThread
      const picked: Array<'model' | 'permissionMode'> = [...(pickedModel ? ['model' as const] : []), ...(pickedMode ? ['permissionMode' as const] : [])]
      const computer = workspace.node ? pickedDeviceName : 'this computer'
      let made: Thread | undefined
      const actions = composerThreadActions()
      const row = pendingRow
      // A thread made after the composer moved on is listed as made until the service pushes it.
      const listIfMissing = (thread: Thread) => {
        const store = useAppStore.getState()
        if (store.profileId === profileId && !store.threads.some((entry) => entry.id === thread.id)) store.upsertThread(thread)
      }
      // Apply this draft's workspace before sending; a project change creates a
      // new hidden draft instead of moving another thread's transcript storage.
      // A thread made on this computer is made with the shown model and permission mode, so nothing is left to set.
      const id = await prepareComposerThread({
        thread: activeThread,
        workspace,
        started: true,
        ...actions,
        // The pending row becomes the made thread's row, whatever the composer shows by the time it is made.
        ...(row ? { create: async (...args: Parameters<typeof actions.create>) => claimPendingThreadRow(row.key, await actions.create(...args), listIfMissing) } : {}),
        shown: { ...(wanted ? { model: wanted } : {}), ...(!remoteDraft ? { permissionMode } : {}) },
        picked,
        stillVisible,
        activate: (thread) => {
          made = thread
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
          // The message shown since the click moves with the chat to its thread.
          const carried = firstPrompt ? store.messages.find((message) => message.id === firstPrompt?.id) : undefined
          if (carried) firstPromptIn.add(thread.id)
          store.switchToThread(thread.id, carried ? { carry: [carried] } : undefined)
        }
      })
      if (!id) return
      if (!stillVisible()) return
      // The thread as read once: what its creation answered, else the empty thread shown at the click. Never the store
      // after an await, where another window's update would stand in for what was shown. Without a revision, it is
      // read from the computer that runs it first.
      let base: Thread | undefined = made ?? (shownThread?.id === id ? shownThread : undefined)
      if (typeof base?.settingsRevision !== 'number') {
        const fresh = await window.mousse.threads.get(id).catch(() => null)
        if (!stillVisible()) return
        if (!fresh || typeof fresh.settingsRevision !== 'number') {
          setSendError(setupRefusalLine(fresh ? 'computer_outdated' : 'failed', computer))
          return
        }
        base = fresh
      }
      let revision = base.settingsRevision!
      // In this same send, the thread is given what was picked for it and it lacks (the shown model on a thread made on
      // another computer, and a mode picked for it there), each set only on the revision this send last read. Any refusal
      // sends nothing, drops the picks, and leaves the composer showing what the thread really has.
      const setup: ThreadSetup = {
        ...(wanted && !sameModel(base.modelOverride, wanted) ? { model: wanted } : {}),
        ...(remoteDraft && pickedMode && base.permissionMode !== pickedMode ? { permissionMode: pickedMode } : {})
      }
      if (needsSetup(setup)) {
        const result = await window.mousse.threads.applySettings(id, setup, revision)
        if (!stillVisible()) return
        if (result.thread) useAppStore.getState().upsertThread(result.thread)
        const draft = useAppStore.getState().composerWorkspaceDrafts[id]
        if (draft) useAppStore.getState().setComposerWorkspaceDraft(id, withoutPicks(draft))
        if (!result.ok || typeof result.thread?.settingsRevision !== 'number') {
          setSendError(setupRefusalLine(result.ok ? 'computer_outdated' : result.code, computer))
          return
        }
        revision = result.thread.settingsRevision
      }
      bound = { permissionMode: shownMode, ...(wanted ? { model: wanted } : {}), settingsRevision: revision }
    } else if (!retrySteer && autoModel && activeThreadId) {
      // A thread without a model of its own would run on the unusable default: give it the shown one.
      const updated = await window.mousse.threads.setModel(activeThreadId, autoModel)
      if (!stillVisible()) return
      if (updated) storeSavedModel(activeThreadId, updated)
      if (typeof updated?.settingsRevision === 'number') autoModelRevision = updated.settingsRevision
    }
    // A thread made for its first message is listed at once, so after a failed selection, a reload or another route in
    // it is no longer a "new chat" here; its first message is bound all the same (`Thread.firstSendPending`). Bound to
    // what this composer showed at the click (render-time values, never the store after an await): a change made in
    // another window since is refused by the service, and the composer then shows it.
    // The service clears the flag once the first message is saved, so it, not the transcript this window holds, decides.
    // A turn already under way (the first one still setting up its worktree, say) means this message is not the first:
    // it is sent unbound and queued, as any other.
    if (!bound && !newChat && !retrySteer && activeThreadId && activeThread && sendIsFirst(activeThread, turnState?.phase, activeThreadActivity)) {
      const shownModel = autoModel ?? (selectedProviderId && selectedModelId
        ? { ...selectionFor(selectedProviderId), ...pickedSelection(selectedModelId) }
        : undefined)
      const revision = autoModelRevision ?? activeThread.settingsRevision
      bound = {
        permissionMode: shownPermissionMode,
        ...(shownModel ? { model: shownModel } : {}),
        ...(typeof revision === 'number' ? { settingsRevision: revision } : {})
      }
    }

    // Clear only after we accept the send/queue path (control commands already cleared above).
    // A skill chip attached in the composer applies to this prompt only —
    // the global chat mode is left untouched.
    clearSent(false)
    // Thread preparation is complete. The send promise lasts for the entire
    // first turn, so it must not keep typing, queueing, or Stop disabled.
    releaseWorkspacePending()
    const restoreUnsent = () => {
      const state = useAppStore.getState()
      if (state.profileId !== profileId) return
      const key = composerMediaKey(targetThreadId)
      const current = state.composerDrafts[key] ?? ''
      state.setComposerDraft(targetThreadId, current && current !== text && current !== keptTyped ? [input, current].filter(Boolean).join('\n\n') : unsentText(current, text))
      if (key === activeMediaKeyRef.current) {
        setAttachedFiles((files) => [...attachedFiles, ...files])
        setVoiceMessages((voice) => [...voiceMessages, ...voice])
      } else {
        const media = mediaByThreadRef.current[key] ?? EMPTY_COMPOSER_MEDIA
        mediaByThreadRef.current[key] = { files: [...attachedFiles, ...media.files], voice: [...voiceMessages, ...media.voice] }
      }
      browserElements.forEach((element) => state.addBrowserElementAttachment(targetThreadId, element))
      resolvedReferences.forEach((reference) => state.addComposerReference(targetThreadId, reference))
    }
    if (typedMeanwhile) setInput(typedMeanwhile)
    // `/goal` on a new chat: the goal is set before its text is sent, so the first turn runs under it and its end decides.
    const goalThread = goalToAdopt ? targetThreadId : null
    if (goalToAdopt && goalThread) {
      try {
        await window.mousse.platformRequest.request('threads.goal', { threadId: goalThread, action: 'adopt', text: goalToAdopt })
      } catch (error) {
        if (stillVisible()) {
          setSendError(sendErrorLine(error))
          restoreUnsent()
        }
        return
      }
    }
    // The composer is clear and the send paints the message from here: the chat is no longer a new one.
    if (firstPrompt) {
      const shownId = firstPrompt.id
      setFirstSendIds((current) => new Set([...current].filter((id) => id !== shownId)))
    }
    const sent = await sendMessage(text, skillMode ?? chatMode, images, targetThreadId, restoreUnsent, undefined, bound,
      steerShown ? { row: steerShown } : steerQueued, firstPrompt, {
        runId: hasAdmittedTurn ? turnRunId ?? undefined : undefined,
        retry: retrySteer
      })
    // Refused: nothing runs, so the goal set for it goes too. (An unconfirmed send may have arrived; it keeps the goal.)
    if (goalThread && sent === false) void window.mousse.platformRequest.request('threads.goal', { threadId: goalThread, action: 'clear' }).catch(() => undefined)
    if (sent === false) {
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
      // Not sent (a failed create or setup, a refusal, the chat left): the message leaves the transcript, so its
      // Working time stops, and the composer, which kept it with its files, shows it again.
      if (firstPrompt && !firstPrompt.taken) {
        const shownId = firstPrompt.id
        for (const threadId of firstPromptIn) useAppStore.getState().dropMessage(threadId, shownId)
        setFirstSendIds((current) => new Set([...current].filter((id) => id !== shownId)))
      }
      // Sent (this lasts the first turn) or not: the thread list lists the thread from now on. A send that stopped
      // first (a failed create, a refusal shown above the composer, which keeps the prompt) takes the row away; a
      // thread the service made already is listed (claimed above).
      if (pendingRow) dropPendingThreadRows([pendingRow.key])
    }
  }

  // The picker stays open on a model click; a level or speed in it closes it (`modelPickerRunSettings`).
  const handleModelSelect = async (providerId: string, modelId: string) => {
    // A read of the shown model that began before this pick must not put the previous model back.
    selectionRequestRef.current += 1
    const instance = selectionFor(providerId)
    setSelectedLlmProvider(instance.llmProvider)
    setSelectedInstanceId(instance.instanceId)
    setSelectedModelId(modelId)
    // Stored as the model and its level apart; no level is the model's default.
    const pick = pickedSelection(modelId)

    // A chat whose thread is still to be made keeps the pick until a send stamps it on the new thread, which
    // also makes it what the project's next new thread starts with.
    if (createsThread || !activeThreadId || remoteDraft) {
      setComposerWorkspaceDraft(activeThreadId, { ...workspace, model: { ...instance, ...pick } })
      // Without a project it is the last-used default for new threads at once, as a send would make it. A chat for
      // another computer takes its model there; this computer's default stays as it is.
      if (!remoteDraft && !workspace.projectId) {
        // The new default wins over the automatic model at once, not after settings reply.
        setProfileDefault({ ...instance, model: pick.model })
        void window.mousse.settings.set({
          provider: { ...instance, model: pick.model, effort: pick.effort }
        })
      }
      return
    }

    // Optimistic local meta so the composer badge updates before IPC returns. It is held until the newest pick is
    // saved: a thread list that arrives meanwhile keeps it (`setThreads`), and picks are saved in the order made.
    const threadId = activeThreadId
    const override = { ...instance, ...pick }
    const current = useAppStore.getState().threads.find((t) => t.id === threadId)
    const ticket = current ? holdModelPick(current, override) : 0
    if (current) {
      useAppStore.getState().upsertThread({
        ...current,
        modelOverride: override,
        updatedAt: new Date().toISOString()
      })
    }

    const save = async (): Promise<void> => {
      // Picked again before this one's turn: only the newest pick is sent.
      if (current && isSupersededModelPick(threadId, ticket)) return
      try {
        const updated = await window.mousse.threads.setModel(threadId, override)
        if (!current) {
          if (updated) useAppStore.getState().upsertThread(updated)
          return
        }
        modelPickSaved(threadId, updated ?? undefined)
        if (settleModelPick(threadId, ticket).latest && updated) storeSavedModel(threadId, updated)
      } catch (error) {
        if (!current) {
          setSendError(sendErrorLine(error))
          return
        }
        // The daemon refused: show the model the thread really has, and why. A newer pick decides its own outcome.
        const { latest, baseline } = settleModelPick(threadId, ticket)
        if (!latest) return
        // Only the model goes back: the rest of the row may have changed since the pick (title, status).
        const row = useAppStore.getState().threads.find((t) => t.id === threadId)
        if (baseline && row) useAppStore.getState().upsertThread({ ...row, modelOverride: baseline.modelOverride })
        setSendError(sendErrorLine(error))
      }
    }
    const saved = modelSaveRef.current.then(save)
    modelSaveRef.current = saved
    await saved
  }

  // The projects the toolbar offers: this computer's, or the picked computer's, which it lists with its own.
  const toolbarProjects = useMemo(
    () => workspace.node ? projects.filter((project) => project.node === workspace.node) : localProjectsOf(projects),
    [projects, workspace.node]
  )

  /** Sets the new chat's draft; a project picked on this computer is remembered for the next new thread. */
  const pickDraftProject = (next: ComposerWorkspace) => {
    setComposerWorkspaceDraft(activeThreadId, next)
    if (!next.node && next.projectId !== workspace.projectId) useAppStore.getState().setLastNewThreadProjectId(next.projectId ?? null)
  }

  /** Opens a folder as a project and makes it the new chat's project. */
  const openProjectForDraft = async () => {
    const project = await window.mousse.projects.open()
    const state = useAppStore.getState()
    if (!project || state.profileId !== profileId || state.activeThreadId !== activeThreadId) return
    if (!state.projects.some((entry) => entry.id === project.id)) state.setProjects([...state.projects, project])
    pickDraftProject({ ...workspace, projectId: project.id })
  }

  /** Picks where the new chat runs; the project carries over only if the target lists the same Git repository. */
  const selectRunOnDevice = (node: NodeId | undefined) => {
    if (node === workspace.node) return
    setSendError(null)
    setComposerWorkspaceDraft(activeThreadId, workspaceOnDevice(workspace, projects, node))
  }

  // The project the draft had here, when the computer picked does not have it: offered to add there instead of dropped.
  const carriedProject = projectToAddThere(workspace, projects)
  const addCarriedProject = () => {
    const node = workspace.node
    if (!node || !carriedProject) return
    const threadId = activeThreadId
    openAddToComputer({
      node,
      projectId: carriedProject.id,
      name: carriedProject.name,
      onAdded: (project) => {
        const state = useAppStore.getState()
        if (state.profileId !== profileId) return
        const draft = composerWorkspaceFor(state.composerWorkspaceDrafts[threadId ?? '__blank__'], state.threads.find((t) => t.id === threadId), state.projects)
        const next = workspaceWithAddedProject(draft, node, project.id)
        if (next !== draft) setComposerWorkspaceDraft(threadId, next)
      }
    })
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
    // A chat whose thread is still to be made (here or on another computer): the pick waits with the draft, and goes
    // to the new thread.
    if (createsThread || remoteDraft || !activeThreadId) {
      setComposerWorkspaceDraft(activeThreadId, { ...workspace, permissionMode: mode })
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
        threadMode: pickedMode ?? (activeThread && (activeThread.node ?? undefined) === remoteNode ? activeThread.permissionMode : undefined),
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
    const retryProfile = profileId
    const retryThread = activeThreadId
    // The busy state and the notice belong to the shown thread: an answer for another one changes neither.
    const shown = () => useAppStore.getState().profileId === retryProfile && useAppStore.getState().activeThreadId === retryThread
    setConnectionFailed(false)
    setLoading(true)
    void window.mousse.orchestrator
      .retryConnection(retryThread ?? undefined)
      .then((started) => {
        if (!shown()) return
        if (!started) setLoading(false)
        else void refreshTurnActive()
      })
      .catch(() => {
        // The service could not be asked: still not reachable.
        if (!shown()) return
        setLoading(false)
        setConnectionFailed(true)
      })
  }

  // A thread whose transcript is still loading is not empty: it shows the plain chat (no headline, logo or glow) until it lands.
  // A subagent thread is never the new-chat empty screen either.
  const newChatAnimations = useAppStore((s) => s.newChatAnimations)
  const hidePermissionsWhileRunning = useAppStore((s) => s.hidePermissionsWhileRunning)
  const emptyThread = !isSubagent && shownMessages.length === 0 && !transcriptPending && !turnActive && !loading && !showQuestions && !sendError && !connectionFailed
  // A new thread's settings (project above the composer, where it runs and Private / Archive after below) leave once the first send starts.
  const newThreadSettings = newChat && !turnActive && !loading && !firstSendShown
  // The first message shows in the transcript while its thread is made: the locked composer that still holds it (to
  // show it again if the send does not go ahead) looks empty meanwhile, so the message is not shown twice.
  const composerHeld = firstSendShown && workspacePending
  // A file the message can't take is refused as it is attached, with a line naming it above the composer.
  const attachRules = useMemo(() => ({ remote: Boolean(remoteNode), onRefused: setSendError }), [remoteNode])
  const newThreadKey = `${profileId}:${activeThreadId ?? '__blank__'}`
  const composerDevice: ComposerDeviceProps = {
    localName,
    devices: runOnDevices,
    notSharing,
    onRefresh: refreshRunOnDevices,
    onSelect: (node) => void selectRunOnDevice(node),
    onOpenRemoteProject: openProjectOnRunOnDevice
  }

  handleSendRef.current = handleSend

  return (
    <div data-mousse="chat" className={`chat${emptyThread ? ' chat--empty' : ''}`} data-new-chat-motion={emptyThread && !newChatAnimations ? 'off' : undefined} style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <ChatWallpaper />
      {emptyThread && newChatAnimations && <AmbientGlow since={continuesWarmEmpty ? warmEmpty.since : undefined} />}
      <SubagentParentBar />
      <ThreadComputerBar />
      <ThreadStartedByBar />
      <ThreadModeBar />
      <EarlierMessagesBar />
      <ThreadMoveBanner instanceId={selectedInstanceId ?? providers.find((entry) => entry.id === selectedProviderId)?.instanceId} snapshots={providerSnapshots} />
      <SecretRequestActionsContext.Provider value={secretActions}>
      <MousseAgentChatShell
        key={activeThreadId ?? 'no-thread'}
        threadId={activeThreadId}
        busy={turnActive || loading}
        messages={shownMessages}
        status={chatStatus}
        toolRenderers={THREAD_TOOL_RENDERERS}
        onSend={() => void handleSend()}
        onStop={() => void handleStop()}
        quickActionApproval={quickActionApproval}
        permissionRequests={permissionRequests.controls}
        turnActions={turnActions}
        queue={queue}
        startingSince={optimisticSubagentStarting ? ownSubagent?.subagent.createdAt : undefined}
        composer={(
      <div
        ref={inputAreaRef}
        className={`chat-input-area${showQuestions ? ' has-questions' : ''}`}
      >
        {emptyThread && <EmptyThreadHeading headline={emptyHeadline} animate={newChatAnimations} continued={continuesWarmEmpty} />}
        <ComposerNoticeProvider>
        {sendError && (sendChanges?.line === sendError && activeThreadId
          ? <PendingChangesNotice threadId={activeThreadId} message={sendChanges.message} details={sendChanges.details}
              onResolved={() => { setSendError(null); setSendChanges(null); void handleSend() }}
              onDismiss={() => { setSendError(null); setSendChanges(null) }} />
          : <ComputerNotice message={sendError} onDismiss={() => setSendError(null)} />)}
        <PromptUndoNotice />
        <PausedRunNotice threadId={activeThreadId} />
        <SetupFailureNotice threadId={activeThreadId} />
        {/* A goal is the computer's that runs the thread (`threads.goal` is not routed): none for another computer's thread. */}
        <GoalNotice threadId={newChat || remoteNode ? null : activeThreadId} />
        {commandInfo && <CommandInfoNotice message={commandInfo} onDismiss={() => setCommandInfo(null)} />}
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
                onSubmit={(answers, attachments) => {
                  const requestId = questionsSnapshot.requestId
                  const threadId = questionAnswerThreadId(questionsSnapshot, activeThreadId)
                  void window.mousse.orchestrator.answerQuestionsDetailed(requestId, answers, threadId, attachments).then((outcome) => {
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
                {...(composerHasContent ? { onSkipAndSend: () => void handleSend(undefined, { skipQuestions: true }) } : {})}
              />
            )}
          </div>
        </div>

        {/* Computer use the agent asked to set up: nothing waits on it, it applies from the agent's next turn. */}
        <ComputerUseSetupCard threadId={activeThreadId} remoteNode={remoteNode} remoteHostName={remoteComputer?.name} messages={messages} />
        <ComposerNoticeSource notice={queue.error ? { tone: 'error', title: queue.error, onDismiss: queue.clearError } : null} />
        <ComposerNoticeSource notice={queue.draftMoved ? { tone: 'info', title: QUEUE_DRAFT_MOVED_NOTICE, shortTitle: 'Your edit is in the composer', onDismiss: queue.dismissDraftMoved } : null} />
        <ComposerNoticeSource notice={queue.notice ? { tone: 'info', title: queue.notice, onDismiss: queue.clearNotice } : null} />
        {/* The dock on the composer's top edge: the top notice, one at a time. */}
        <ComposerNoticeSlot />

        {newThreadSettings && (
          <ComposerProjectPicker
            key={`${newThreadKey}:project`}
            projects={toolbarProjects}
            workspace={workspace}
            disabled={workspaceLocked}
            device={composerDevice}
            onChange={pickDraftProject}
            onOpenProject={openProjectForDraft}
            onError={setSendError}
            {...(carriedProject ? { addThere: { name: carriedProject.name, onAdd: addCarriedProject } } : {})}
          />
        )}
            <ChatComposer
              disabled={workspacePending || !workspaceReady || isWatchOnlyThread(activeThread)}
              input={composerHeld ? '' : input}
              onInputChange={setInput}
              attachedFiles={composerHeld ? NO_ATTACHED_FILES : attachedFiles}
              onAttachedFilesChange={setAttachedFiles}
              attachmentStatus={preparation.statuses}
              sendBlocked={composerHeld ? null : preparation.blocked}
              attachRules={attachRules}
              messageLimit={MMS_PROTOCOL_MAX_TEXT_LENGTH}
              voiceMessages={composerHeld ? NO_VOICE_MESSAGES : voiceMessages}
              onVoiceMessagesChange={setVoiceMessages}
              browserElements={composerHeld ? EMPTY_BROWSER_ELEMENTS : browserElements}
              onRemoveBrowserElement={(id) => removeBrowserElement(activeThreadId, id)}
              references={composerHeld ? EMPTY_REFERENCES : references}
              onAddReference={addResolvedReference}
              onRemoveReference={(id) => removeComposerReference(activeThreadId, id)}
              onReferenceError={setSendError}
              pastedThreadRefusal={pastedThreadRefusal}
              enabledSkills={enabledSkills}
              run={{
                providers,
                selectedProviderId,
                selectedInstanceId,
                selectedModelId,
                modelMenuOpen,
                onModelMenuOpenChange: setModelMenuOpen,
                onModelSelect: (providerId, modelId) => void handleModelSelect(providerId, modelId),
                onOpenSettings: () => openSettingsSection('providers'),
                contextUsage,
                contextCompactionSetting,
                contextOpen,
                onContextOpenChange: setContextOpen,
                ...(!newChat && activeThreadId && !subagentsWorking ? { onCompactNow: handleCompactNow } : {}),
                workInProgress: turnActive || loading || turnStoppable || subagentsWorking,
                compacting: compactionRunning || (activeThreadId !== null && compactingThread === activeThreadId),
                ...(activeThread?.botOwned ? { contextHidden: true } : {})
              }}
              loading={composerWorking}
              stoppable={composerWorking || turnStoppable}
              placeholder={!workspaceReady ? ''
                : questionsTakeMessage ? QUESTION_COMPOSER_PLACEHOLDER
                  : approvalWaiting ? APPROVAL_COMPOSER_PLACEHOLDER : undefined}
              sendLabel={questionsTakeMessage
                ? questionComposerSendLabel(questionAnswerSubmits)
                : approvalWaiting ? DENY_AND_SEND_LABEL : undefined}
              onSend={(skillMode, options) => void handleSend(skillMode, options)}
              onSteerQueued={() => {
                // A waiting approval or question is answered first; a steer then would deny it.
                if (approvalWaiting || questionsTakeMessage) return false
                const next = nextSteerableQueueItem(queue.items, queue.busyIds, queue.sendingNext)
                if (!next) return false
                void queue.steer(next.id)
                return true
              }}
              onStop={() => void handleStop()}
              lastPrompt={lastPrompt}
              banner={<>
                <RemoteSubagentNotice runsOn={activeThread?.runsOn} />
                <NativeHelperNotice thread={activeThread} />
                <SubagentComposerBanner threadId={activeThreadId} />
                {!newChat && activeThreadId && (
                  <BackgroundWorkRow key={activeThreadId} threadId={activeThreadId} subagents={threadSubagents} work={backgroundWork} onStopAll={() => void handleStop()} />
                )}
              </>}
              searchMentions={searchMentions}
              mentionScope={mentionScope}
              permission={hidePermissionsWhileRunning && firstSendShown ? undefined : { mode: shownPermissionMode, ceiling: shownCeiling.ceiling, ceilingReason: shownCeiling.reason, onSelect: (mode) => void handlePermissionSelect(mode) }}
              sendModeThreadId={activeThreadId ?? undefined}

            />
        {newThreadSettings && (
          <ComposerThreadSettings
            key={`${newThreadKey}:settings`}
            workspace={workspace}
            disabled={workspaceLocked}
            device={composerDevice}
            onChange={(next) => setComposerWorkspaceDraft(activeThreadId, next)}
            onPrivateChange={(localOnly) =>
              setComposerWorkspaceDraft(activeThreadId, workspaceWithPrivate(workspace, localOnly, projects.filter((entry) => !entry.node), privateDefaultMs))}
            onExpiryChange={(ms, stopsRun) => setComposerWorkspaceDraft(activeThreadId, workspaceWithExpiry(workspace, ms, stopsRun))}
          />
        )}
        </ComposerNoticeProvider>
        {emptyThread && newChat && offersAddProject(projects.length, workspace.node) && (
          <EmptyThreadAddProject onAdd={() => void openProjectForDraft().catch((error) => setSendError(error instanceof Error ? error.message : String(error)))} />
        )}
      </div>
        )}
      />
      </SecretRequestActionsContext.Provider>
      <NativeSubagentPage threadId={activeThreadId} />
    </div>
  )
}
