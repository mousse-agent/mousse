import { registerAppletIpc } from '../applets/registerAppletIpc'
import { AppError, errorDiagnostic, knownAppError, normalizeAppError, serializeAppError } from '../../shared/errors'
import { registerLinuxWindowResizeIpc } from '../linuxWindowResizeIpc'
import type { SubagentSummary } from '../../shared/subagents'
import { CHAT_METHODS } from '../../shared/chats'
import { CHAT_RESOURCE_METHODS } from '../../shared/chatResources'
import { CHAT_NETWORK_METHODS } from '../../shared/chatsNetwork'
import { NET_LOCAL_METHODS } from '../../shared/net/local'
import { BRIDGE_HUB_LOCAL_METHODS } from '../../shared/bridge/types'
import { SPACES_LOCAL_METHODS } from '../../shared/spaces/local'
import { BOTS_LOCAL_METHODS } from '../../shared/bots/space/local'
import { SPACE_ARCHIVE_METHODS } from '../../shared/spaces/archive'
/**
 * Phase 3 GUI IPC: protocol-backed agent-chat/project/thread/queue + Electron-local UI.
 * Does not take a MousseMainService / owner lease.
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, Notification, session, shell } from 'electron'
import { homedir } from 'os'
import { daemonGitParams } from './daemonGitParams'
import { getComputerName } from '../computerName'
import { randomUUID } from 'node:crypto'
import type { GuiMmsController } from '../mms/GuiMmsController'
import { PresentationState } from '../mms/PresentationState'
import { bootstrapPresentation } from '../mms/bootstrapPresentation'
export { bootstrapPresentation } from '../mms/bootstrapPresentation'
import { MmsProtocolError } from '../../mms/protocol/client'
import { guiChatRequestError } from '../mms/requestErrors'
import type { ProtocolEvent } from '../../mms/protocol'
import {
  bridgeProtocolEvent,
  broadcastThreadSnapshot
} from '../mms/protocolEventBridge'
import { SettingsStore } from '../../mms/settings/SettingsStore'
import { FileService } from '../../mms/files/FileService'
import { GitService } from '../../mms/git/GitService'
import { listEditors, openInEditor } from '../editors'
import { refreshApplicationMenu } from '../applicationMenu'
import { setGuestShortcuts } from '../menu/guestShortcutForward'
import type { ShortcutOverrides } from '../../shared/commands'
import { BrowserViewManager } from '../browser/BrowserViewManager'
import type { AttachedBrowserHost } from '../browser/AttachedBrowserHost'
import { domainObject } from '../../mms/protocol/domainRegistry'
import { profileBrowserPartition } from '../browser/browserPolicy'
import { ThreadActivityTracker } from '../data/ThreadActivityTracker'
import type { ProviderLoginEvent } from '../../shared/providerAuth'
import { LOCAL_TTS_MODELS, type ProviderSpeechRequest, type ProviderSpeechResult } from '../../shared/readAloud'
import { SPEECH_HOST_METHODS } from '../../shared/speechRelay'
import {
  LOCAL_STT_MODELS,
  PROVIDER_STT_MAX_BYTES,
  type ProviderTranscriptionRequest,
  type ProviderTranscriptionResult
} from '../../shared/dictation'
import { LocalModelManager, defaultLocalModelsRoot } from '../localModels/LocalModelManager'
import type { PlatformRequestMethod, PlatformResponse } from '../../shared/platform'
import { WORKFLOW_RUN_METHODS } from '../../shared/workflowRunPlatform'
import { BROWSER_GUI_METHODS } from '../../shared/browser/host'
import { BROWSER_ACCESS_METHODS } from '../../shared/browser/access'
import { BROWSER_SETUP_METHODS } from '../../shared/browser/setup'
import {
  appearanceUsesAcrylic,
  normalizeAppearance,
  type MousseSettings,
  type MousseSettingsUpdate
} from '../../shared/settings'
import { surfaceToWindowBackground } from '../../shared/accentPalette'
import { appearanceSurfaceBase } from '../../shared/themeSurfaces'
import { showCopyMenu } from '../contextMenu'
import { pickExecutable } from './pickExecutable'
import { openExternalSafely } from '../safeExternalUrl'
import { dispatchMcpAuthBrowser } from '../mcpAuthBrowser'
import { MousseIdCallbacks, runtimeMousseIdOrigin } from '../mousseIdCallback'
import {
  attachWindowStateListeners,
  beginWindowDrag,
  endWindowDrag,
  isWindowZoomed,
  toggleWindowZoom,
  updateWindowDrag,
  type WindowDragPoint
} from '../windowState'
import { applyWindowMaterial, attachWindowFocusListeners, setWindowProfileSettings } from '../windowMaterial'
import {
  SUBAGENT_QUESTION_BODY,
  getThreadNotificationPresentation,
  type ThreadNotificationKind
} from '../notifications/threadNotification'
import { NotificationThreadIndex } from '../notifications/threadNotificationTarget'
import { playThreadCompletionSound } from '../notifications/completionSound'
import type {
  BrowserBounds,
  ChannelConfig,
  ChannelPlatform,
  CreateScheduledJobInput,
  FileGrepResponse,
  FileSearchResponse,
  GitBranchOptions,
  GitCheckoutOptions,
  GitCommitOptions,
  GitDeleteBranchOptions,
  GitFetchOptions,
  GitPullOptions,
  GitPushOptions,
  GitScope,
  MainView,
  OrchestratorContextUsageInput,
  OrchestratorSendInput,
  PermissionMode,
  ScheduledJob,
  ThreadActivitySnapshot,
  Thread,
  ThreadActivityState,
  TurnState,
  TurnStateSnapshot,
  QuestionAnswerOutcome,
  UserQuestionAnswers
} from '../../shared/types'
import { isThreadActivityActive } from '../../shared/types'
import type {
  CreatePullRequestResult,
  PullRequestBaseBranches,
  PullRequestDetail,
  PullRequestDraft,
  PullRequestFormInput,
  PullRequestListItem,
  PullRequestPushTarget,
  PullRequestRef,
  PullRequestScope,
  PullRequestWatchMode,
  PullRequestWatchStatus,
  ResolvedPullRequestSummary,
  StartPullRequestThreadInput,
  StartPullRequestThreadResult
} from '../../shared/pullRequests'
import { visibleThreads } from '../../shared/threadLineage'
import type { ProviderLoginResponse } from '../../shared/providerAuth'
import type {
  GitHubCloneRepositoryInput,
  GitHubCreateRepositoryInput
} from '../../shared/github'


export interface GuiIpcServices {
  guiMms: GuiMmsController
  presentation: PresentationState
  /**
   * Presentation cache for window chrome only — not an execution settings authority.
   * settings:get/set always route to the daemon; this mirror is updated from protocol.
   */
  settings: SettingsStore
  fileService: FileService
  gitService: GitService
  browserView: BrowserViewManager
  attachedBrowserHost?: AttachedBrowserHost
  repoRoot: string
  requestAppRestart?: () => Promise<void>
}

let activeGuiMms: GuiMmsController | null = null

/**
 * The renderer feature bridge is deliberately smaller than the legacy GUI IPC
 * surface. New profile-scoped feature clients may only invoke registrations
 * owned by the platform domain layer through this list.
 */
export const PLATFORM_REQUEST_METHODS: ReadonlySet<PlatformRequestMethod> = new Set([
  ...CHAT_METHODS,
  ...CHAT_RESOURCE_METHODS,
  ...CHAT_NETWORK_METHODS,
  ...NET_LOCAL_METHODS.filter(method => !['net.plus.bind','net.plus.connect'].includes(method)),
  ...BRIDGE_HUB_LOCAL_METHODS,
  ...SPACES_LOCAL_METHODS,
  ...BOTS_LOCAL_METHODS,
  ...SPACE_ARCHIVE_METHODS,
  ...SPEECH_HOST_METHODS,
  ...BROWSER_ACCESS_METHODS,
  ...BROWSER_GUI_METHODS,
  ...BROWSER_SETUP_METHODS,
  ...WORKFLOW_RUN_METHODS,
  'workflows.list', 'workflows.get', 'workflows.getRevision', 'workflows.create',
  'workflows.saveDraft', 'workflows.publish', 'workflows.archive',
  'workflows.duplicate', 'workflows.importBundle', 'workflows.exportBundle',
  'workflows.validate', 'workflows.listRevisions', 'workflows.restoreRevision',
  'agentDefinitions.list', 'agentDefinitions.get', 'agentDefinitions.create',
  'agentDefinitions.saveDraft', 'agentDefinitions.publish', 'agentDefinitions.archive',
  'agentDefinitions.duplicate', 'agentDefinitions.importBundle',
  'agentDefinitions.exportBundle', 'agentDefinitions.validate', 'agentDefinitions.tryRun',
  'integrations.snapshot',
  'chatReferences.resolve',
  'skills.create', 'skills.update', 'skills.editor', 'skills.enable', 'skills.archive',
  'skills.importPackage', 'skills.exportPackage',
  'mcp.create', 'mcp.update', 'mcp.read', 'mcp.enable', 'mcp.delete',
  'mcp.testConnection', 'mcp.beginAuth', 'mcp.cancelAuth', 'mcp.revokeAuth'
])

class PlatformRequestError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super({ code, message, details, errorInfo: { category: 'invalid', retryable: false } })
    this.name = 'PlatformRequestError'
  }
}

let mousseIdCallbacks: MousseIdCallbacks | undefined

/** The shortcut overrides of each window's bound profile, by the window's webContents id. */
const shortcutsByWindow = new Map<number, ShortcutOverrides>()

/** What the window's before-input gate reads: undefined until the window's settings have arrived. */
export function getWindowShortcuts(senderId: number): ShortcutOverrides | undefined {
  return shortcutsByWindow.get(senderId)
}

function registerHandler(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, (event, ...args) => {
    if (!activeGuiMms) return handler(event, ...args)
    return activeGuiMms.runWithSender(event.sender, () => handler(event, ...args))
  })
}

function registerStorageHandler(channel: string, handler: Parameters<typeof ipcMain.handle>[1]): void {
  registerHandler(channel, async (event, ...args) => {
    try { return { ok: true, value: await handler(event, ...args) } }
    catch (cause) {
      const descriptor = cause instanceof MmsProtocolError
        ? knownAppError({ code: cause.code, message: cause.message, details: cause.details, errorInfo: cause.errorInfo })
        : normalizeAppError(cause, 'storage_request_failed')
      console.error('GUI storage request failed', errorDiagnostic(descriptor, channel))
      return { ok: false, error: serializeAppError(descriptor) }
    }
  })
}

function applyWindowAccentBackground(
  win: BrowserWindow | null | undefined,
  settings: MousseSettings
): void {
  if (!win || win.isDestroyed()) return
  setWindowProfileSettings(win, settings)
  const appearance = normalizeAppearance(settings.appearance)
  const surfaceBase = appearanceSurfaceBase(appearance, nativeTheme?.shouldUseDarkColors ?? true)
  win.setBackgroundColor(
    surfaceToWindowBackground(surfaceBase, process.platform === 'linux' || appearanceUsesAcrylic(appearance) ? 0 : 1)
  )
}

function normalizeSendContent(request: OrchestratorSendInput): {
  content: string
  requestId?: string
  mode?: unknown
  images?: unknown
} {
  if (typeof request === 'string') return { content: request }
  return {
    content: request.content,
    requestId: request.requestId,
    mode: request.mode,
    images: request.images
  }
}

/** The daemon's parameters for a pull request action: its folder, originating thread and the branch it is bound to. */
function pullRequestScopeParams(scope: PullRequestScope | undefined): Record<string, string> {
  return {
    ...(typeof scope?.threadId === 'string' ? { threadId: scope.threadId } : {}),
    ...(typeof scope?.projectId === 'string' ? { projectId: scope.projectId } : {}),
    ...(typeof scope?.originThreadId === 'string' ? { originThreadId: scope.originThreadId } : {}),
    ...(typeof scope?.branch === 'string' ? { expectedBranch: scope.branch } : {})
  }
}

export function registerGuiIpc(
  services: GuiIpcServices,
  getWindow: () => BrowserWindow | null
): { syncDaemonTurnSnapshot: (snap: unknown) => void } {
  const {
    guiMms,
    presentation,
    settings,
    fileService,
    gitService,
    browserView,
    repoRoot
  } = services
  activeGuiMms = guiMms
  registerLinuxWindowResizeIpc(getWindow)
  registerAppletIpc(registerHandler, guiMms, () => [getWindow()])

  const browserHost = (event: Electron.IpcMainInvokeEvent): AttachedBrowserHost => {
    if (event.senderFrame !== event.sender.mainFrame || !services.attachedBrowserHost) throw new Error('In-app browser automation is unavailable')
    return services.attachedBrowserHost
  }
  registerHandler('browser:register-tab', async (event, raw: unknown) => {
    const input = domainObject(raw, ['localTabId', 'webContentsId', 'threadId'])
    return browserHost(event).registerTab(event.sender, input as unknown as Parameters<AttachedBrowserHost['registerTab']>[1])
  })
  registerHandler('browser:select-tab', async (event, raw: unknown) => {
    const input = domainObject(raw, ['localTabId', 'threadId'])
    return browserHost(event).selectTab(event.sender, input.localTabId as string, input.threadId as string)
  })
  registerHandler('browser:take-control', async (event, localTabId: unknown) => browserHost(event).control(event.sender, localTabId as string, 'takeControl'))
  registerHandler('browser:resume-agent', async (event, localTabId: unknown) => browserHost(event).control(event.sender, localTabId as string, 'resume'))

  registerHandler('platform:request', async (_event, request: unknown): Promise<PlatformResponse<unknown>> => {
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request)) {
        throw new PlatformRequestError('platform_invalid_request', 'Expected a platform request object')
      }
      const requestObject = request as Record<string, unknown>
      if (Object.keys(requestObject).some((key) => key !== 'method' && key !== 'params')) {
        throw new PlatformRequestError('platform_invalid_request', 'Unexpected platform request field')
      }
      const method = requestObject.method
      if (typeof method !== 'string' || !PLATFORM_REQUEST_METHODS.has(method as PlatformRequestMethod)) {
        throw new PlatformRequestError('platform_method_not_allowed', 'Platform method is not allowlisted', { method })
      }
      const params = requestObject.params
      let encoded: string
      try { encoded = JSON.stringify(params ?? null) } catch {
        throw new PlatformRequestError('platform_invalid_params', 'Platform parameters must be JSON')
      }
      if (Buffer.byteLength(encoded, 'utf8') > 512 * 1024) {
        throw new PlatformRequestError('platform_params_too_large', 'Platform parameters exceed the size limit')
      }
      const value = await guiMms.request(method, params)
      return {
        ok: true,
        value: method === 'chatReferences.resolve'
          ? (value as { reference: unknown }).reference
          : value
      }
    } catch (error) {
      const descriptor = error instanceof MmsProtocolError
        ? knownAppError({ code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo })
        : normalizeAppError(error, 'platform_request_failed')
      console.error('GUI platform request failed', errorDiagnostic(descriptor, 'platform.call'))
      return { ok: false, error: serializeAppError(descriptor) }
    }
  })

  // Presentation (thread selection, activity and pending question ownership)
  // is window-local. The daemon binding is captured by GuiMmsController from
  // the trusted sender; this map keeps the corresponding chrome state from
  // repainting another profile's window.
  const windowPresentations = new Map<number, PresentationState>()
  const windowSettings = new Map<number, MousseSettings>()
  // The application menu and the key gate show the shortcuts of the profile this window is bound to.
  const rememberWindowSettings = (senderId: number, next: MousseSettings): void => {
    windowSettings.set(senderId, next)
    shortcutsByWindow.set(senderId, next.shortcuts ?? {})
    refreshApplicationMenu(next.shortcuts)
  }
  const currentPresentation = (): PresentationState => {
    const senderId = guiMms.getCurrentSenderId()
    if (senderId === null) return presentation
    let state = windowPresentations.get(senderId)
    if (!state) {
      state = new PresentationState()
      windowPresentations.set(senderId, state)
    }
    return state
  }
  const presentationForSender = (senderId: number): PresentationState => {
    let state = windowPresentations.get(senderId)
    if (!state) {
      state = new PresentationState()
      windowPresentations.set(senderId, state)
    }
    return state
  }

  // Thread rows the main process has seen, so a notification knows whether its thread is a subagent.
  const notificationThreads = new NotificationThreadIndex()

  const broadcast = (channel: string, data: unknown, profileId?: string): void => {
    const senderId = guiMms.getCurrentSenderId()
    const senderProfile = senderId === null ? undefined : guiMms.getWindowBindingForSender(senderId)?.profileId
    // IPC handlers run inside GuiMmsController's trusted sender context. Use
    // that binding as the default for personal replies; daemon events supply
    // activeEventProfileId instead. Installation-wide listeners remain global.
    const targetProfileId = profileId ?? activeEventProfileId ?? senderProfile
    if (channel === 'threads:updated') notificationThreads.note(targetProfileId ?? currentProfileKey(), data)
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        if (targetProfileId) {
          const binding = guiMms.getWindowBindingForSender(win.webContents.id)
          if (!binding || binding.profileId !== targetProfileId) continue
        }
        win.webContents.send(channel, data)
      }
    }
  }

  const notifyThread = (
    threadId: string,
    kind: ThreadNotificationKind,
    activeThreadId: string | null,
    targetWindow = getWindow(),
    profileSettings = settings.get(),
    profileId = currentProfileKey()
  ): void => {
    // Subagents are quiet; one that asks a question is announced under its parent's name.
    const about = notificationThreads.resolve(profileId, threadId, kind)
    if (!about) return
    const content = getThreadNotificationPresentation(kind, profileSettings)
    const win = targetWindow
    const isFocused = win?.isFocused() ?? false
    if (isFocused && (activeThreadId === about.threadId || (about.viaThreadId !== undefined && activeThreadId === about.viaThreadId))) {
      // Banner is suppressed while viewing the thread, but the completion
      // sound is still expected — play the platform completion sound explicitly since no
      // banner exists to carry it (the default alert beep is too harsh).
      if (!content.silent) playThreadCompletionSound()
      return
    }
    if (!Notification.isSupported()) {
      if (!content.silent) playThreadCompletionSound()
      return
    }
    const useWindowsCompletionSound = process.platform === 'win32' && !content.silent
    const notification = new Notification({
      title: about.parentName ?? 'Mousse',
      ...content,
      ...(about.viaThreadId ? { body: SUBAGENT_QUESTION_BODY } : {}),
      // Unpackaged Windows Electron notifications do not reliably play their toast
      // sound. Play Mousse's softer completion chime below and avoid a double sound.
      silent: useWindowsCompletionSound ? true : content.silent
    })
    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    notification.show()
    if (useWindowsCompletionSound) playThreadCompletionSound()
  }

  const setThreadActivity = (threadId: string, state: ThreadActivityState): void => {
    activityTrackerFor().setState(threadId, state)
    broadcast('threads:activity', activityTrackerFor().getSnapshot())
  }

  let activeEventProfileId: string | undefined
  const turnStateMaps = new Map<string, Map<string, TurnState>>()
  const currentProfileKey = (): string => {
    const senderId = guiMms.getCurrentSenderId()
    const senderProfile = senderId === null ? null : guiMms.getWindowBindingForSender(senderId)
    return activeEventProfileId ?? senderProfile?.profileId ?? guiMms.getBaseBinding()?.profileId ?? 'default'
  }
  const activityTrackers = new Map<string, ThreadActivityTracker>()
  const activityTrackerFor = (profileId = currentProfileKey()): ThreadActivityTracker => {
    let tracker = activityTrackers.get(profileId)
    if (!tracker) {
      tracker = new ThreadActivityTracker()
      activityTrackers.set(profileId, tracker)
    }
    return tracker
  }
  const turnStateMapFor = (profileId = currentProfileKey()): Map<string, TurnState> => {
    let map = turnStateMaps.get(profileId)
    if (!map) {
      map = new Map<string, TurnState>()
      turnStateMaps.set(profileId, map)
    }
    return map
  }
  const setTurnState = (state: TurnState, profileId?: string): void => {
    const turnStateMap = turnStateMapFor(profileId)
    turnStateMap.set(state.threadId, state)
    broadcast('orchestrator:turn-state', state)
    broadcast('turns:state', Object.fromEntries(turnStateMap))
  }
  const getTurnSnapshot = (): TurnStateSnapshot => Object.fromEntries(turnStateMapFor())

  /** Update per-profile live state for a window session before bridging it. */
  const routeWindowState = (
    event: ProtocolEvent,
    profileId: string,
    target: (channel: string, data: unknown) => void
  ): void => {
    const tracker = activityTrackerFor(profileId)
    if (event.type === 'activity' || event.type === 'activity.snapshot') {
      const data = event.data as { state?: ThreadActivityState; activity?: ThreadActivitySnapshot } | null
      if (event.type === 'activity' && event.threadId && data?.state) {
        tracker.setState(event.threadId, data.state)
        target('threads:activity', tracker.getSnapshot())
      }
      if (data?.activity && typeof data.activity === 'object' && !Array.isArray(data.activity)) {
        tracker.reconcileSnapshot(data.activity)
        target('threads:activity', tracker.getSnapshot())
      }
    }
    if (event.type === 'turn.state' || event.type === 'turn.snapshot' || event.type === 'turns.state' || event.type === 'turns.snapshot') {
      const raw = event.data as (TurnState & { state?: TurnState; snapshot?: TurnStateSnapshot; turns?: TurnStateSnapshot }) | null
      const state = raw?.state ?? raw
      const snapshot = raw?.snapshot ?? raw?.turns ?? (event.type === 'turn.state' ? undefined : raw as unknown as TurnStateSnapshot)
      const map = turnStateMapFor(profileId)
      if (state && typeof state === 'object' && 'threadId' in state) map.set(state.threadId, state as TurnState)
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        for (const [threadId, value] of Object.entries(snapshot)) {
          if (value && typeof value === 'object' && 'threadId' in value) map.set(threadId, value as TurnState)
        }
      }
      target('turns:state', Object.fromEntries(map))
      if (state && typeof state === 'object' && 'threadId' in state) target('orchestrator:turn-state', state)
    }
  }

  /**
   * Merge a daemon thread.snapshot's authoritative turn state into the local
   * map and forward it to the renderer.
   *
   * The daemon survives GUI restarts (detached process), so after a close +
   * reopen the local map is empty while turns may still be running. Without
   * this sync the chat shows idle while sends correctly queue behind the live
   * turn — the "prompts go to queue but nothing runs" state. Selecting another
   * thread used to paper over it by inferring processing from queue length.
   */
  const syncDaemonTurnSnapshot = (snap: unknown): void => {
    const full = snap as {
      turnState?: TurnState
      turnSnapshot?: TurnStateSnapshot
    } | null
    const single = full?.turnState
    if (single && typeof single === 'object' && single.threadId) {
      turnStateMapFor().set(single.threadId, single)
      broadcast('orchestrator:turn-state', single)
    }
    const multi = full?.turnSnapshot
    if (multi && typeof multi === 'object' && !Array.isArray(multi)) {
      let has = false
      for (const [k, v] of Object.entries(multi)) {
        if (v && typeof v === 'object' && 'threadId' in (v as object)) {
          turnStateMapFor().set(k, v as TurnState)
          has = true
        }
      }
      if (has) broadcast('turns:state', Object.fromEntries(turnStateMapFor()))
    }
  }

  // Protocol events → renderer IPC (exact existing channel names).
  guiMms.on('event', (event) => {
    // Personal events are delivered by each trusted window session below.
    // Keep this base connection as the single installation-event bridge.
    if (event.profileId) return
    activeEventProfileId = event.profileId
    queueMicrotask(() => {
      activeEventProfileId = undefined
    })
    if (event.type === 'activity' && event.threadId) {
      const state = (event.data as { state?: ThreadActivityState } | null)?.state
      if (state) {
        const previousState = activityTrackerFor().getState(event.threadId)
        setThreadActivity(event.threadId, state)
        // Any stop of work needs the user: finished, asked a question / paused
        // for approval (awaiting_input), or went idle (interrupted, aborted, or
        // planning pause). Completion belongs to the whole thread, not merely
        // the parent turn — the daemon keeps this state waiting while an
        // owning subagent is still active. Requiring a previous working or
        // waiting state dings exactly once per work cycle.
        if (isThreadActivityActive(previousState)) {
          if (state === 'completed') {
            notifyThread(event.threadId, 'completed', currentPresentation().getActiveThreadId())
          } else if (state === 'awaiting_input') {
            notifyThread(event.threadId, 'question', currentPresentation().getActiveThreadId())
          } else if (state === 'idle') {
            notifyThread(event.threadId, 'idle', currentPresentation().getActiveThreadId())
          }
        }
      }
    }
    if (event.type === 'questions.pending' && event.threadId) {
      // A question can arrive without (or before) the awaiting_input activity
      // event. If the thread is still tracked as working, flip it and ding;
      // if the activity event already landed, that path already notified.
      if (isThreadActivityActive(activityTrackerFor().getState(event.threadId))) {
        setThreadActivity(event.threadId, 'awaiting_input')
        notifyThread(event.threadId, 'question', currentPresentation().getActiveThreadId())
      }
    }
    // Daemon-wide snapshots describe runtime state, not unread state. Reconcile
    // them through the local tracker so opening/creating a thread cannot revive
    // already-consumed historical completions for every thread in the project.
    let reconciledActivity: ThreadActivitySnapshot | undefined
    if (event.type === 'activity' || event.type === 'activity.snapshot') {
      const activity = (event.data as { activity?: ThreadActivitySnapshot } | null)?.activity
      if (activity && typeof activity === 'object' && !Array.isArray(activity)) {
        activityTrackerFor().reconcileSnapshot(activity)
        reconciledActivity = activityTrackerFor().getSnapshot()
      }
    }
    if (event.type === 'turn.state') {
      const raw = event.data as (TurnState & { state?: TurnState; snapshot?: TurnStateSnapshot }) | null
      const state = (raw as { state?: TurnState } | null)?.state ?? raw
      if (state && typeof state === 'object' && (state as TurnState).threadId) {
        const s = state as TurnState
        const snap =
          (event.data as { snapshot?: TurnStateSnapshot } | null)?.snapshot ??
          (raw as { snapshot?: TurnStateSnapshot } | null)?.snapshot
        if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
          for (const [k, v] of Object.entries(snap)) {
          if (v && typeof v === 'object' && 'threadId' in (v as object))
              turnStateMapFor().set(k, v as TurnState)
          }
        }
        setTurnState(s)
      } else {
        const snap =
          (event.data as { snapshot?: TurnStateSnapshot } | null)?.snapshot ??
          (event.data as TurnStateSnapshot | null)
        if (snap && typeof snap === 'object' && !Array.isArray(snap)) {
          let hasTurn = false
          for (const v of Object.values(snap)) {
            if (v && typeof v === 'object' && 'threadId' in (v as object)) {
              hasTurn = true
              break
            }
          }
          if (hasTurn) {
            for (const [k, v] of Object.entries(snap)) {
              if (v && typeof v === 'object' && 'threadId' in (v as object))
                turnStateMapFor().set(k, v as TurnState)
            }
            broadcast('turns:state', Object.fromEntries(turnStateMapFor()))
          }
        }
      }
    }
    if (
      event.type === 'turn.snapshot' ||
      event.type === 'turns.state' ||
      event.type === 'turns.snapshot'
    ) {
      const snapshot =
        (event.data as { snapshot?: TurnStateSnapshot } | null)?.snapshot ??
        (event.data as { turns?: TurnStateSnapshot } | null)?.turns ??
        (event.data as { activity?: TurnStateSnapshot } | null)?.activity ??
        (event.data as TurnStateSnapshot | null)
      if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
        for (const [k, v] of Object.entries(snapshot)) {
          if (v && typeof v === 'object' && 'threadId' in (v as object))
            turnStateMapFor().set(k, v as TurnState)
        }
        broadcast('turns:state', Object.fromEntries(turnStateMapFor()))
      }
    }
    bridgeProtocolEvent(event, broadcast, presentation, reconciledActivity)
    // Keep chrome SettingsStore in sync with daemon-owned settings from any client.
    if (event.type === 'settings.changed') {
      const next = (event.data as { settings?: MousseSettings } | null)?.settings
      if (next) {
        try {
          settings.set(next)
          applyWindowAccentBackground(getWindow(), next)
        } catch {
          /* chrome mirror best-effort */
        }
      }
    }
    if (event.type === 'ui.focus-intent') {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    }
    if (event.type === 'turn.started' && event.threadId) {
      // Activity is derived and published by the daemon before this lifecycle event.
      activityTrackerFor().setBusyThreadId(event.threadId)
    }
    if (
      (event.type === 'turn.completed' ||
        event.type === 'turn.interrupted' ||
        event.type === 'turn.aborted') &&
      event.threadId
    ) {
      // Do not derive thread-list state from the parent turn alone: background
      // subagents may still own work. The preceding daemon activity event is authoritative.
      if (activityTrackerFor().getBusyThreadId() === event.threadId) {
        activityTrackerFor().setBusyThreadId(null)
      }
    }
  })

  // Window sessions have their own protocol subscription. Route those events
  // directly to the trusted sender instead of the installation-wide broadcast
  // bus; this is what prevents a B window from seeing A's questions, PTY or
  // transcript updates.
  guiMms.on('window-connection-event', ({ senderId, event }: { senderId: number; event: import('../../mms/protocol/types').ProtocolConnectionEvent }) => {
    const win = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.id === senderId)
    const binding = guiMms.getWindowBindingForSender(senderId)
    if (!win || win.isDestroyed() || !binding ||
      event.profileId !== binding.profileId || event.profileEpoch !== binding.epoch) return
    if (event.type === 'mcp.auth-url') {
      void guiMms.runWithSender(win.webContents, () => dispatchMcpAuthBrowser(
        event,
        () => win.isDestroyed() ? null : guiMms.getWindowBindingForSender(senderId),
        target => shell.openExternal(target),
        (attemptId, opened) => guiMms.request('mcp.authBrowserResult', { attemptId, opened })
      )).catch(error => console.warn('MCP browser authorization failed', error instanceof Error ? error.message : 'Unknown error'))
      return
    }
    if (event.type === 'bridge.hub.thread') win.webContents.send('bridge:thread-part', event.data)
    // Live output of a Git action: the daemon sent it on this window's own connection, so only this window gets it.
    if (event.type === 'git.operation') win.webContents.send('git:operation', (event.data as { event?: unknown } | null)?.event)
  })
  guiMms.on('window-event', ({ senderId, event, replay }: { senderId: number; event: ProtocolEvent; replay?: boolean }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === senderId)
    if (!win || win.isDestroyed()) return
    const binding = guiMms.getWindowBindingForSender(senderId)
    if (!binding || (event.profileId && event.profileId !== binding.profileId)) return
    // Installation events are already bridged by the base session. Personal
    // events, including Default, need this exact window's presentation state.
    if (!event.profileId) return
    const target = (channel: string, data: unknown): void => {
      if (!win.isDestroyed()) win.webContents.send(channel, data)
    }
    const tracker = activityTrackerFor(binding.profileId)
    const previousActivity = event.type === 'activity' && event.threadId
      ? tracker.getState(event.threadId)
      : undefined
    routeWindowState(event, binding.profileId, target)
    if (event.type === 'threads.updated') notificationThreads.note(binding.profileId, event.data)
    bridgeProtocolEvent(event, target, presentationForSender(senderId))
    if (event.type === 'activity' && event.threadId) {
      const state = (event.data as { state?: ThreadActivityState } | null)?.state
      // Working → Waiting is still the same work cycle; only its end notifies.
      if (!replay && isThreadActivityActive(previousActivity) && state && !isThreadActivityActive(state)) {
        const kind: ThreadNotificationKind = state === 'completed'
          ? 'completed'
          : state === 'awaiting_input'
            ? 'question'
            : 'idle'
        notifyThread(
          event.threadId,
          kind,
          presentationForSender(senderId).getActiveThreadId(),
          win,
          windowSettings.get(senderId) ?? settings.get(),
          binding.profileId
        )
      }
    }
    if (event.type === 'questions.pending' && event.threadId && isThreadActivityActive(tracker.getState(event.threadId))) {
      tracker.setState(event.threadId, 'awaiting_input')
      target('threads:activity', tracker.getSnapshot())
      if (!replay) notifyThread(
        event.threadId,
        'question',
        presentationForSender(senderId).getActiveThreadId(),
        win,
        windowSettings.get(senderId) ?? settings.get(),
        binding.profileId
      )
    }
    if (event.type === 'settings.changed') {
      const next = (event.data as { settings?: MousseSettings } | null)?.settings
      if (next) {
        rememberWindowSettings(senderId, next)
        if (binding.profileId === guiMms.getBaseBinding()?.profileId) {
          try {
            settings.set(next)
          } catch {
            /* chrome mirror best-effort */
          }
        }
        applyWindowAccentBackground(win, next)
      }
    }
    if (event.type === 'ui.focus-intent') {
      if (win.isMinimized()) win.restore()
      win.show()
      win.focus()
    }
  })

  guiMms.on('window-resnapshot', async ({ senderId }: { senderId: number }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === senderId)
    const binding = guiMms.getWindowBindingForSender(senderId)
    if (!win || win.isDestroyed() || !binding) return
    const activeId = presentationForSender(senderId).getActiveThreadId()
    if (!activeId) return
    try {
      const snap = await guiMms.snapshotThreadForSender(senderId, activeId)
      const target = (channel: string, data: unknown): void => {
        if (!win.isDestroyed()) win.webContents.send(channel, data)
      }
      const full = snap as { agents?: unknown[]; tasks?: unknown[]; pendingQuestions?: Array<{ requestId: string; questions: unknown }> }
      target('queue:updated', { threadId: activeId, items: snap.queue })
      target('agents:updated', full.agents ?? [])
      target('tasks:updated', full.tasks ?? [])
      for (const q of full.pendingQuestions ?? []) target('orchestrator:questionsPending', { requestId: q.requestId, questions: q.questions, threadId: activeId })
      const state = snap.activeTurn?.active ? { threadId: activeId, state: snap.activeTurn.running ? 'processing' : 'idle' } : { threadId: activeId, state: 'idle' }
      turnStateMapFor(binding.profileId).set(activeId, state as unknown as TurnState)
      target('orchestrator:turn-state', state)
      target('turns:state', Object.fromEntries(turnStateMapFor(binding.profileId)))
    } catch (error) {
      console.error('window resnapshot failed:', error)
    }
  })

  guiMms.on('resnapshot', async () => {
    const activeId = currentPresentation().getActiveThreadId()
    if (!activeId || !guiMms.connected) return
    try {
      const snap = await guiMms.snapshotThread(activeId)
      const full = snap as {
        agents?: unknown[]
        tasks?: unknown[]
        pendingQuestions?: Array<{ requestId: string; questions: unknown }>
      }
      syncDaemonTurnSnapshot(snap)
      broadcastThreadSnapshot(
        activeId,
        {
          messages: snap.messages,
          queue: snap.queue,
          connectionFailed: snap.connectionFailed,
          agents: full.agents,
          tasks: full.tasks
        },
        broadcast,
        presentation
      )
      for (const q of full.pendingQuestions ?? []) {
        broadcast('orchestrator:questionsPending', {
          requestId: q.requestId,
          questions: q.questions
        })
      }
      const projects = await guiMms.request<{ projects: unknown[] }>('projects.list')
      const threads = await guiMms.request<{ threads: unknown[] }>('threads.list')
      broadcast('projects:updated', projects.projects)
      broadcast('threads:updated', threads.threads)
      guiMms.clearResnapshotFlag()
    } catch (err) {
      console.error('resnapshot failed:', err)
    }
  })

  browserView.init(getWindow, (state) => broadcast('browser:state', state))

  // ── Orchestrator / queue (protocol) ──────────────────────────────────────

  const runSend = async (
    request: OrchestratorSendInput,
    threadId: string | null
  ): Promise<unknown> => {
    const targetThreadId = threadId ?? currentPresentation().getActiveThreadId()
    if (!targetThreadId) return { message: '', actions: [], requestAcknowledged: false, error: serializeAppError(knownAppError({ code: 'thread_not_selected', message: 'Select a thread before sending.' }, { category: 'invalid', retryable: false })) }
    activityTrackerFor().setBusyThreadId(targetThreadId)
    setThreadActivity(targetThreadId, 'processing')
    try {
      const body = normalizeSendContent(request)
      const result = await guiMms.request<{ queued?: boolean; message?: string }>(
        'orchestrator.send',
        {
          threadId: targetThreadId,
          content: body.content,
          requestId: body.requestId ?? randomUUID(),
          mode: body.mode,
          images: body.images,
          source: 'gui'
        }
      )
      if (result.queued) {
        setThreadActivity(targetThreadId, 'processing')
      }
      return result
    } catch (err) {
      const error = guiChatRequestError(err)
      const disconnected = error.code === 'workspace_connection_lost'
      if (!disconnected) {
        setThreadActivity(targetThreadId, 'idle')
        activityTrackerFor().setBusyThreadId(null)
      }
      console.error('GUI chat request failed', errorDiagnostic(error, 'orchestrator.send'))
      return { message: '', actions: [], ...(disconnected ? {} : { requestAcknowledged: false }), error: serializeAppError(error) }
    }
  }

  registerHandler('orchestrator:send', async (_e, request: OrchestratorSendInput) =>
    runSend(request, currentPresentation().getActiveThreadId())
  )
  registerHandler(
    'orchestrator:sendToThread',
    async (_e, threadId: string, request: OrchestratorSendInput) => runSend(request, threadId)
  )

  registerHandler('orchestrator:getMessages', async (_e, threadId?: string) => {
    const id = threadId ?? currentPresentation().getActiveThreadId()
    if (!id) return []
    const snap = await guiMms.snapshotThread(id)
    return snap.messages
  })

  registerHandler(
    'orchestrator:getContextUsage',
    async (_e, request?: OrchestratorContextUsageInput) => {
      const threadId = currentPresentation().getActiveThreadId()
      const body =
        typeof request === 'string'
          ? { draftInput: request, threadId }
          : {
              draftInput: request?.draftInput ?? '',
              mode: request?.mode,
              threadId
            }
      return guiMms.request('orchestrator.contextUsage', body)
    }
  )

  const answerQuestions = async (requestId: string, answers: UserQuestionAnswers): Promise<QuestionAnswerOutcome> => {
    const res = await guiMms.request<QuestionAnswerOutcome>('orchestrator.answerQuestions', {
      requestId,
      answers
    })
    const busy = activityTrackerFor().getBusyThreadId()
    if (res.ok && busy) setThreadActivity(busy, 'processing')
    return res
  }
  registerHandler(
    'orchestrator:answerQuestions',
    async (_e, requestId: string, answers: UserQuestionAnswers) => (await answerQuestions(requestId, answers)).ok
  )
  // The same answer with its outcome: when another client answered a saved approval request first,
  // the card says who decided what (SPEC §17.4).
  registerHandler(
    'orchestrator:answerQuestionsDetailed',
    async (_e, requestId: string, answers: UserQuestionAnswers) => answerQuestions(requestId, answers)
  )
  registerHandler('orchestrator:dismissQuestions', async (_e, requestId: string) => {
    const res = await guiMms.request<{ ok: boolean }>('orchestrator.dismissQuestions', {
      requestId
    })
    return res.ok
  })

  registerHandler('orchestrator:abort', async (_e, threadId?: string) => {
    const id = threadId ?? currentPresentation().getActiveThreadId()
    if (!id) return false
    const res = await guiMms.request<{ ok: boolean }>('orchestrator.abort', { threadId: id })
    return res.ok
  })

  registerHandler('orchestrator:steer', async (_e, text: string, threadId?: string) => {
    const id = threadId ?? currentPresentation().getActiveThreadId()
    if (!id) return false
    const res = await guiMms.request<{ ok: boolean }>('orchestrator.steer', {
      threadId: id,
      text: String(text ?? ''),
      source: 'gui-steer'
    })
    return res.ok
  })

  registerHandler('orchestrator:isTurnActive', async (_e, threadId?: string) => {
    const id = threadId ?? currentPresentation().getActiveThreadId()
    if (!id) return false
    const res = await guiMms.request<{ active: boolean }>('orchestrator.isTurnActive', {
      threadId: id
    })
    return res.active === true
  })

  registerHandler('turn:getSnapshot', async () => getTurnSnapshot())
  registerHandler('turns:getState', async () => getTurnSnapshot())

  registerHandler('orchestrator:retryConnection', async (_e, threadId?: string) => {
    const res = await guiMms.request<{ ok: boolean }>('orchestrator.retry', {
      threadId: threadId ?? currentPresentation().getActiveThreadId() ?? undefined
    })
    return res.ok
  })

  registerHandler('queue:list', async (_e, threadId: string) => {
    const res = await guiMms.request<{ items: unknown[] }>('queue.list', { threadId })
    return res.items
  })
  registerHandler(
    'queue:enqueue',
    async (_e, threadId: string, request: OrchestratorSendInput) => {
      const body = normalizeSendContent(request)
      const res = await guiMms.request<{ item: unknown }>('queue.enqueue', {
        threadId,
        content: body.content,
        requestId: body.requestId ?? randomUUID(),
        mode: body.mode,
        images: body.images,
        source: 'gui'
      })
      return res.item
    }
  )
  registerHandler('queue:remove', async (_e, threadId: string, itemId: string) => {
    const res = await guiMms.request<{ removed: unknown }>('queue.remove', {
      threadId,
      itemId
    })
    return res.removed
  })
  registerHandler('queue:reorder', async (_e, threadId: string, orderedIds: string[]) => {
    const res = await guiMms.request<{ items: unknown[] }>('queue.reorder', {
      threadId,
      orderedIds
    })
    return res.items
  })
  registerHandler('queue:promoteToSteer', async (_e, threadId: string, itemId: string) => {
    const res = await guiMms.request<{ ok: boolean }>('queue.promoteToSteer', {
      threadId,
      itemId
    })
    return res.ok
  })

  // ── Projects / threads (protocol) ────────────────────────────────────────

  registerHandler('workspace:getStatus', async (_e, threadId: string) =>
    guiMms.request('workspace.getStatus', { threadId })
  )
  registerHandler('workspace:restore', async (_e, threadId: string, expectedJournalGeneration?: number) =>
    guiMms.request('workspace.restore', { threadId, expectedJournalGeneration })
  )
  registerHandler('actions:list', async (_e, threadId: string) =>
    guiMms.request('actions.list', { threadId })
  )
  registerHandler('review:files', async (_e, params: Record<string, unknown>) => guiMms.request('review.files', params))
  registerHandler('review:file', async (_e, params: Record<string, unknown>) => guiMms.request('review.file', params))
  registerHandler('actions:pin', async (_e, params: Record<string, unknown>) => guiMms.request('actions.pin', params))
  registerHandler('actions:configureRetention', async (_e, params: Record<string, unknown>) => guiMms.request('actions.configureRetention', params))
  registerHandler('actions:sweepRetention', async (_e, threadId: string) => guiMms.request('actions.sweepRetention', { threadId }))
  registerHandler('actions:undoLatest', async (_e, threadId: string, expectedJournalGeneration: number, expectedTurnId?: string) =>
    guiMms.request('actions.undoLatest', { threadId, expectedJournalGeneration, expectedTurnId })
  )
  registerHandler('actions:revertCode', async (_e, params: Record<string, unknown>) =>
    guiMms.request('actions.revertCode', params)
  )
  registerHandler('actions:redo', async (_e, threadId: string, expectedJournalGeneration: number) =>
    guiMms.request('actions.redo', { threadId, expectedJournalGeneration })
  )
  registerHandler('actions:fork', async (_e, params: Record<string, unknown>) =>
    guiMms.request('actions.fork', params)
  )
  registerHandler('actions:activateBranch', async (_e, params: Record<string, unknown>) =>
    guiMms.request('actions.activateBranch', params)
  )
  registerHandler('publish:start', async (_e, params: Record<string, unknown>) =>
    guiMms.request('publish.start', params)
  )
  registerHandler('operations:abort', async (_e, params: Record<string, unknown>) =>
    guiMms.request('operations.abort', params)
  )
  registerStorageHandler('threads:restore', async (_e, threadId: string) =>
    guiMms.request('threads.restore', { threadId })
  )
  registerStorageHandler('threads:purge', async (_e, threadId: string, options: Record<string, unknown> = {}) =>
    guiMms.request('threads.purge', { ...options, threadId })
  )
  registerStorageHandler('threads:inventory', async (_e, threadId?: string) => guiMms.request('threads.inventory', { threadId }))
  registerStorageHandler('threads:configureTrash', async (_e, policy: { graceDays: number; automaticPurge: boolean }) => guiMms.request('threads.configureTrash', policy))
  registerStorageHandler('storage:policy', async () => guiMms.request('storage.policy', {}))
  registerStorageHandler('storage:configure', async (_e, policy: unknown) => guiMms.request('storage.configure', { policy }))
  // A run may purge large trees; it must not hit the 60 s default.
  registerStorageHandler('storage:cleanupRun', async () => guiMms.request('storage.cleanup.run', {}, 15 * 60_000))
  registerStorageHandler('storage:cleanupLastReport', async () => guiMms.request('storage.cleanup.lastReport', {}))
  // The first call on a profile measures it, which can take most of the scan budget.
  registerStorageHandler('storage:usage', async (_e, options?: { refresh?: boolean }) =>
    guiMms.request('storage.usage', options?.refresh === true ? { refresh: true } : {}, 120_000)
  )

  registerHandler('projects:list', async () => {
    const res = await guiMms.request<{ projects: unknown[] }>('projects.list')
    return res.projects
  })

  registerHandler('projects:open', async () => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const res = await guiMms.request<{ project: unknown; projects: unknown[] }>(
      'projects.open',
      { path: result.filePaths[0] }
    )
    broadcast('projects:updated', res.projects)
    const threads = await guiMms.request<{ threads: unknown[] }>('threads.list')
    broadcast('threads:updated', threads.threads)
    return res.project
  })

  registerHandler('projects:remove', async (_e, projectId: string) => {
    const res = await guiMms.request<{ projects: unknown[] }>('projects.remove', {
      projectId
    })
    broadcast('projects:updated', res.projects)
  })
  registerHandler('projects:rename', async (_e, projectId: string, name: string) => {
    const res = await guiMms.request<{ project: unknown; projects: unknown[] }>(
      'projects.rename',
      { projectId, name }
    )
    broadcast('projects:updated', res.projects)
    return res.project
  })
  registerHandler('projects:pin', async (_e, projectId: string, pinned: boolean) => {
    const res = await guiMms.request<{ project: unknown; projects: unknown[] }>(
      'projects.pin',
      { projectId, pinned }
    )
    broadcast('projects:updated', res.projects)
    return res.project
  })
  registerHandler('projects:reorder', async (_e, projectIds: string[]) => {
    const res = await guiMms.request<{ projects: unknown[] }>('projects.reorder', {
      projectIds
    })
    broadcast('projects:updated', res.projects)
    return res.projects
  })
  registerHandler('projects:threads', async (_e, projectId: string) => {
    const res = await guiMms.request<{ threads: unknown[] }>('threads.list', { projectId })
    return res.threads
  })

  registerHandler('threads:list', async () => {
    const res = await guiMms.request<{ threads: unknown[] }>('threads.list', {})
    // Standalone only — filter when projectId omitted returns all; match prior listThreads()
    return (res.threads as { projectId?: string }[]).filter((t) => !t.projectId)
  })
  registerHandler('threads:listAll', async () => {
    const res = await guiMms.request<{ threads: unknown[] }>('threads.list')
    return res.threads
  })
  registerHandler('threads:active', () => currentPresentation().getActiveThreadId())
  registerHandler('threads:activity', () => activityTrackerFor().getSnapshot())

  // The renderer calls this after it knows its trusted profile and subscribes.
  // Coalesce Strict Mode's concurrent effects without caching across reloads.
  const presentationBootstraps = new Map<string, Promise<void>>()
  registerHandler('threads:initialize', (event) => {
    const binding = guiMms.getWindowBindingForSender(event.sender.id)
    if (!binding) throw new Error('Window MMS profile binding is unavailable')
    const key = `${event.sender.id}:${binding.profileId}:${binding.epoch}`
    const pending = presentationBootstraps.get(key)
    if (pending) return pending
    const isCurrent = (): boolean => {
      const current = guiMms.getWindowBindingForSender(event.sender.id)
      return !event.sender.isDestroyed() && current?.profileId === binding.profileId && current.epoch === binding.epoch
    }
    const target = (channel: string, data: unknown): void => {
      if (!isCurrent()) return
      if (channel === 'threads:updated') notificationThreads.note(binding.profileId, data)
      event.sender.send(channel, data)
    }
    const promise = bootstrapPresentation(guiMms, currentPresentation(), target, {
      isCurrent,
      onTurnSnapshot: syncDaemonTurnSnapshot
    }).finally(() => presentationBootstraps.delete(key))
    presentationBootstraps.set(key, promise)
    return promise
  })

  /** Monotonic generation so rapid switches drop stale snapshot replies. */
  let selectGeneration = 0

  const selectThread = async (threadId: string): Promise<void> => {
    const gen = ++selectGeneration
    currentPresentation().setActiveThreadId(threadId)
    // Publish selection immediately so the sidebar/highlight updates before the
    // (potentially large) thread.snapshot round-trip completes.
    broadcast('thread:selected', { id: threadId })

    const snap = await guiMms.snapshotThread(threadId)
    // A newer select won the race — discard this snapshot.
    if (gen !== selectGeneration || currentPresentation().getActiveThreadId() !== threadId) {
      return
    }

    const full = snap as {
      activity?: import('../../shared/types').ThreadActivityState
      agents?: unknown[]
      tasks?: unknown[]
      pendingQuestions?: Array<{ requestId: string; questions: unknown }>
    }
    syncDaemonTurnSnapshot(snap)
    // The runtime activity label is normally authoritative. During reconnects or
    // startup it can briefly lag the session snapshot, though; never clear a spinner
    // for a thread whose turn is still active.
    // Selecting a thread must not reset an activity state already tracked for it. The
    // snapshot only fills in a state when this GUI has not observed that thread yet;
    // otherwise an older/partial snapshot can dismiss its sidebar spinner.
    // Skip rebroadcasting the full activity map when we already track this thread —
    // that re-render used to hitch every switch even for idle chats.
    if (activityTrackerFor().getState(threadId) === undefined) {
      const hasPendingWork =
        snap.activeTurn.active ||
        snap.activeTurn.running ||
        snap.queue.length > 0 ||
        snap.claimed.length > 0
      const activity: import('../../shared/types').ThreadActivityState =
        full.activity && full.activity !== 'idle'
          ? full.activity
          : hasPendingWork
            ? 'processing'
            : 'idle'
      setThreadActivity(threadId, activity)
    }
    broadcastThreadSnapshot(
      threadId,
      {
        messages: snap.messages,
        queue: snap.queue,
        connectionFailed: snap.connectionFailed,
        agents: full.agents,
        tasks: full.tasks
      },
      broadcast,
      presentation
    )
    for (const q of full.pendingQuestions ?? []) {
      broadcast('orchestrator:questionsPending', {
        requestId: q.requestId,
        questions: q.questions
      })
    }
    // Selecting a thread does not mutate the thread list — skip threads.list
    // (full project scan) on the hot path.
  }

  registerHandler('threads:create', async (_e, name?: string, projectId?: string, opts?: { worktreeEnabled?: boolean }) => {
    const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>(
      'threads.create',
      { name: name?.trim() || 'New Chat', projectId, worktreeEnabled: opts?.worktreeEnabled === true }
    )
    broadcast('threads:updated', res.threads)
    return res.thread
  })

  registerHandler(
    'threads:createAndSelect',
    async (_e, name?: string, projectId?: string, opts?: { worktreeEnabled?: boolean }) => {
      const res = await guiMms.request<{ thread: { id: string }; threads: unknown[] }>(
        'threads.create',
        { name: name?.trim() || 'New Chat', projectId, worktreeEnabled: opts?.worktreeEnabled === true }
      )
      broadcast('threads:updated', res.threads)
      await selectThread(res.thread.id)
      return res.thread
    }
  )

  registerHandler('threads:select', async (_e, threadId: string) => {
    await selectThread(threadId)
  })

  registerStorageHandler('threads:delete', async (_e, threadId: string) => {
    const res = await guiMms.request<{ threads: Pick<Thread, 'id' | 'settledAt' | 'lineage'>[] }>(
      'threads.delete',
      { threadId }
    )
    broadcast('threads:updated', res.threads)
    if (currentPresentation().getActiveThreadId() === threadId) {
      // Never fall back to a subagent: it sits under its parent in the sidebar.
      const next = visibleThreads(res.threads).find((t) => !t.settledAt)
      if (next) await selectThread(next.id)
      else {
        const created = await guiMms.request<{ thread: { id: string } }>('threads.create', {
          name: 'New Chat'
        })
        await selectThread(created.thread.id)
      }
    }
  })

  registerHandler('threads:rename', async (_e, threadId: string, name: string) => {
    const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>(
      'threads.rename',
      { threadId, name }
    )
    broadcast('threads:updated', res.threads)
    return res.thread
  })

  registerHandler('threads:regenerateTitle', async (_e, threadId: string) => {
    const res = await guiMms.request<{ thread: unknown }>('threads.regenerateTitle', {
      threadId
    })
    const threads = await guiMms.request<{ threads: unknown[] }>('threads.list')
    broadcast('threads:updated', threads.threads)
    return res.thread
  })

  registerHandler(
    'threads:setModel',
    async (
      _e,
      threadId: string,
      model?: { instanceId?: string; llmProvider: string; model: string }
    ) => {
      const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>('threads.setModel', {
        threadId,
        model
      })
      // Prefer full list when present (multi-client cache), but still broadcast
      // so model badge updates without waiting for an extra threads.list.
      broadcast('threads:updated', res.threads)
      return res.thread
    }
  )

  registerHandler('threads:pin', async (_e, threadId: string, pinned: boolean) => {
    const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>(
      'threads.pin',
      { threadId, pinned }
    )
    broadcast('threads:updated', res.threads)
    return res.thread
  })
  registerHandler('threads:setWorktreeEnabled', async (_e, threadId: string, enabled: boolean) => {
    const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>(
      'threads.setWorktreeEnabled',
      { threadId, enabled }
    )
    broadcast('threads:updated', res.threads)
    return res.thread
  })
  registerHandler('threads:setPermissionMode', async (_e, threadId: string, mode: PermissionMode) => {
    const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>(
      'threads.setPermissionMode',
      { threadId, mode }
    )
    broadcast('threads:updated', res.threads)
    return res.thread
  })
  registerHandler('threads:settle', async (_e, threadId: string, settled: boolean) => {
    const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>(
      'threads.settle',
      { threadId, settled }
    )
    broadcast('threads:updated', res.threads)
    return res.thread
  })
  registerHandler(
    'threads:reorder',
    async (_e, projectId: string | undefined, threadIds: string[]) => {
      const res = await guiMms.request<{ threads: unknown[]; all: unknown[] }>(
        'threads.reorder',
        { projectId, threadIds }
      )
      broadcast('threads:updated', res.all)
      return res.threads
    }
  )
  registerHandler('threads:search', async (_e, query: string, limit?: number) => {
    const res = await guiMms.request<{ results: unknown[] }>('threads.search', {
      query,
      limit
    })
    return res.results
  })

  // ── Phase 4: agents / tasks / PTY / Mousse subagents (protocol) ──────────

  registerHandler('agents:list', async (_e, threadId?: string) => {
    const id =
      typeof threadId === 'string' && threadId.trim()
        ? threadId.trim()
        : currentPresentation().getActiveThreadId()
    if (!id) return []
    const res = await guiMms.request<{ agents: unknown[] }>('agents.list', { threadId: id })
    return res.agents
  })
  registerHandler('agents:stop', async (_e, agentId: string, requestedThreadId?: string) => {
    const threadId = requestedThreadId ?? currentPresentation().getActiveThreadId()
    if (!threadId) throw new Error('No active thread')
    const res = await guiMms.request<{ logs: string[] }>('agents.stop', { threadId, agentId })
    return res.logs
  })
  registerHandler('subagents:stopAll', async (_e, threadId: string) => {
    const res = await guiMms.request<{ ok: boolean }>('subagents.stopAll', { threadId })
    return res.ok
  })
  registerHandler('subagents:list', async (_e, threadId: string) => {
    const res = await guiMms.request<{ subagents: SubagentSummary[] }>('subagents.list', { threadId })
    return res.subagents
  })
  registerHandler('tasks:list', async () => {
    const threadId = currentPresentation().getActiveThreadId()
    if (!threadId) return []
    const res = await guiMms.request<{ tasks: unknown[] }>('tasks.list', { threadId })
    return res.tasks
  })
  registerHandler(
    'tasks:create',
    async (
      _e,
      input: { description: string; agentId?: string; status?: import('../../shared/types').TaskStatus }
    ) => {
      const threadId = currentPresentation().getActiveThreadId()
      if (!threadId) throw new Error('No thread selected')
      const res = await guiMms.request<{ task: unknown }>('tasks.create', {
        threadId,
        ...input
      })
      const list = await guiMms.request<{ tasks: unknown[] }>('tasks.list', { threadId })
      broadcast('tasks:updated', list.tasks)
      return res.task
    }
  )
  registerHandler(
    'tasks:update',
    async (
      _e,
      input: {
        id: string
        description?: string
        status?: import('../../shared/types').TaskStatus
        progress?: number
        message?: string
        summary?: string
        agentId?: string | null
      }
    ) => {
      const threadId = currentPresentation().getActiveThreadId()
      if (!threadId) throw new Error('No thread selected')
      const res = await guiMms.request<{ task: unknown }>('tasks.update', {
        threadId,
        ...input
      })
      const list = await guiMms.request<{ tasks: unknown[] }>('tasks.list', { threadId })
      broadcast('tasks:updated', list.tasks)
      return res.task
    }
  )
  registerHandler('pty:write', async (_e, ptyId: string, data: string) => {
    await guiMms.request('pty.write', { ptyId, data })
  })
  registerHandler('pty:resize', async (_e, ptyId: string, cols: number, rows: number) => {
    await guiMms.request('pty.resize', { ptyId, cols, rows })
  })
  registerHandler('pty:list', async () => {
    const threadId = currentPresentation().getActiveThreadId() ?? undefined
    const res = await guiMms.request<{ ptys: unknown[] }>('pty.list', { threadId })
    return res.ptys
  })
  registerHandler('pty:isAlive', async (_e, ptyId: string) => {
    const res = await guiMms.request<{ alive: boolean }>('pty.isAlive', { ptyId })
    return res.alive
  })
  registerHandler('pty:lookup', async (_e, ptyId: string) => {
    return guiMms.request('pty.lookup', { ptyId })
  })
  registerHandler(
    'pty:create',
    async (
      _e,
      request: {
        agentId: string
        cwd?: string
        command?: string
        env?: Record<string, string>
        shellArgs?: string[]
      }
    ) => {
      // Project terminals also exist before a thread is selected. Keep those
      // sessions explicitly unbound instead of making the terminal silently fail.
      const threadId = currentPresentation().getActiveThreadId() ?? '__unbound__'
      const res = await guiMms.request<{ ptyId: string }>('pty.create', {
        threadId,
        agentId: request.agentId,
        cwd: request.cwd,
        command: request.command,
        env: request.env,
        shellArgs: request.shellArgs
      })
      return { ptyId: res.ptyId }
    }
  )
  registerHandler('pty:kill', async (_e, ptyId: string) => {
    await guiMms.request('pty.kill', { ptyId })
  })

  // ── Scheduler / channels / mcp / skills (daemon protocol) ──────────────

  registerHandler('scheduled:list', async () => {
    const res = await guiMms.request<{ jobs: unknown[] }>('scheduled.list')
    return res.jobs
  })
  registerHandler('scheduled:get', async (_e, id: string) => {
    const res = await guiMms.request<{ job: unknown }>('scheduled.get', { id })
    return res.job
  })
  registerHandler('scheduled:create', async (_e, input: CreateScheduledJobInput) => {
    const res = await guiMms.request<{ job: unknown }>('scheduled.create', { input })
    return res.job
  })
  registerHandler(
    'scheduled:update',
    async (_e, id: string, patch: Partial<ScheduledJob>) => {
      const res = await guiMms.request<{ job: unknown }>('scheduled.update', { id, patch })
      return res.job
    }
  )
  registerHandler('scheduled:delete', async (_e, id: string) => {
    const res = await guiMms.request<{ ok: boolean }>('scheduled.delete', { id })
    return res.ok
  })
  registerHandler('scheduled:pause', async (_e, id: string, reason?: string) => {
    const res = await guiMms.request<{ job: unknown }>('scheduled.pause', { id, reason })
    return res.job
  })
  registerHandler('scheduled:resume', async (_e, id: string) => {
    const res = await guiMms.request<{ job: unknown }>('scheduled.resume', { id })
    return res.job
  })
  registerHandler('scheduled:run', async (_e, id: string) => {
    const res = await guiMms.request<{ job: unknown }>('scheduled.run', { id })
    return res.job
  })
  registerHandler('scheduled:status', async () => {
    const res = await guiMms.request<{ status: unknown }>('scheduled.status')
    return res.status
  })

  registerHandler('channels:getSnapshot', async () => {
    const res = await guiMms.request<{ snapshot: unknown }>('channels.getSnapshot')
    return res.snapshot
  })
  registerHandler('channels:getConfig', async () => {
    const res = await guiMms.request<{ config: unknown }>('channels.getConfig')
    return res.config
  })
  registerHandler('channels:updateConfig', async (_e, patch: Partial<ChannelConfig>) => {
    const res = await guiMms.request<{ config: unknown }>('channels.updateConfig', { patch })
    return res.config
  })
  registerHandler('channels:connect', async (_e, platform?: ChannelPlatform) => {
    const res = await guiMms.request<{ snapshot: unknown }>('channels.connect', { platform })
    return res.snapshot
  })
  registerHandler('channels:disconnect', async (_e, platform?: ChannelPlatform) => {
    const res = await guiMms.request<{ snapshot: unknown }>('channels.disconnect', {
      platform
    })
    return res.snapshot
  })
  registerHandler('channels:listPairingRequests', async () => {
    const res = await guiMms.request<{ requests: unknown[] }>(
      'channels.listPairingRequests'
    )
    return res.requests
  })
  registerHandler('channels:approvePairing', async (_e, code: string) => {
    const res = await guiMms.request<{ ok: boolean }>('channels.approvePairing', { code })
    return res.ok
  })
  registerHandler('channels:rejectPairing', async (_e, code: string) => {
    const res = await guiMms.request<{ ok: boolean }>('channels.rejectPairing', { code })
    return res.ok
  })
  registerHandler(
    'channels:sendTest',
    async (_e, platform: ChannelPlatform, chatId: string, text: string, threadId?: string) => {
      const res = await guiMms.request<{ result: unknown }>('channels.sendTest', {
        platform,
        chatId,
        text,
        threadId
      })
      return res.result
    }
  )
  registerHandler('channels:getActivity', async (_e, limit?: number) => {
    const res = await guiMms.request<{ activity: unknown[] }>('channels.getActivity', {
      limit
    })
    return res.activity
  })

  registerHandler('mcp:listServers', async (_e, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ servers: unknown[] }>('mcp.listServers', {
      projectPath
    })
    return res.servers
  })
  registerHandler('mcp:listTools', async (_e, serverId: string, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ tools: unknown[] }>('mcp.listTools', {
      serverId,
      projectPath
    })
    return res.tools
  })
  registerHandler('mcp:testServer', async (_e, serverId: string, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ result: unknown }>('mcp.testServer', {
      serverId,
      projectPath
    })
    return res.result
  })
  registerHandler('mcp:authenticate', async (_e, serverId: string, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ result: unknown }>('mcp.authenticate', {
      serverId,
      projectPath
    })
    return res.result
  })
  registerHandler('mcp:restartServer', async (_e, serverId: string) => {
    await guiMms.request('mcp.restartServer', { serverId })
    broadcast('mcp:changed', null)
  })
  registerHandler('mcp:getConfigSources', async (_e, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ sources: unknown[] }>('mcp.getConfigSources', {
      projectPath
    })
    return res.sources
  })
  registerHandler(
    'mcp:writeCursorConfig',
    async (_e, scope: 'global' | 'project', patch: Record<string, unknown>, projectId?: string) => {
      const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
      await guiMms.request('mcp.writeCursorConfig', { scope, patch, projectPath })
      broadcast('mcp:changed', null)
    }
  )
  registerHandler(
    'mcp:openConfig',
    async (_e, scope: 'global' | 'project', projectId?: string) => {
      const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
      // Daemon returns canonical path from known config roots only.
      const res = await guiMms.request<{ intent: { path?: string; kind?: string } }>(
        'mcp.openConfigIntent',
        { scope, projectPath }
      )
      if (!res.intent?.path || res.intent.kind !== 'open-mcp-config') {
        return 'Config source not found.'
      }
      return shell.openPath(res.intent.path)
    }
  )

  // Project-scoped skills (.opencode/skills etc.) are only discoverable with a
  // project path. Renderer callers rarely know the daemon project id, so fall
  // back to the active thread's project; standalone threads resolve to
  // undefined and keep the previous global-only behavior.
  const resolveSkillsProjectPath = async (projectId?: string): Promise<string | undefined> => {
    if (projectId) return resolveProjectPath(projectId)
    return resolveProjectPath(undefined, currentPresentation().getActiveThreadId())
  }

  registerHandler('skills:list', async (_e, projectId?: string) => {
    const projectPath = await resolveSkillsProjectPath(projectId)
    const res = await guiMms.request<{ snapshot: unknown }>('skills.list', { projectPath })
    return res.snapshot
  })
  registerHandler('skills:read', async (_e, skillId: string, projectId?: string) => {
    const projectPath = await resolveSkillsProjectPath(projectId)
    const res = await guiMms.request<{ result: unknown }>('skills.read', {
      skillId,
      projectPath
    })
    return res.result
  })
  registerHandler('skills:refresh', async (_e, projectId?: string) => {
    const projectPath = await resolveSkillsProjectPath(projectId)
    const res = await guiMms.request<{ snapshot: unknown }>('skills.refresh', {
      projectPath
    })
    broadcast('skills:changed', res.snapshot)
    return res.snapshot
  })
  registerHandler(
    'skills:openFolder',
    async (_e, scope: 'global' | 'project', projectId?: string) => {
      const projectPath = await resolveSkillsProjectPath(projectId)
      const res = await guiMms.request<{ intent: { path?: string; kind?: string } }>(
        'skills.openFolderIntent',
        { scope, projectPath }
      )
      if (!res.intent?.path || res.intent.kind !== 'open-skills-folder') {
        return 'Skills root not found.'
      }
      return shell.openPath(res.intent.path)
    }
  )

  // ── Settings/providers are daemon-owned (above). Electron-local: files/git/browser/window.

  const projectPathCache = new Map<string, string>()

  const resolveProjectPath = async (
    projectId?: string,
    threadId?: string | null
  ): Promise<string | undefined> => {
    if (projectId && projectPathCache.has(projectId)) {
      return projectPathCache.get(projectId)
    }
    try {
      const projects = await guiMms.request<{
        projects: { id: string; path: string }[]
      }>('projects.list')
      // The daemon is authoritative: project ids can be removed or reopened at a new path.
      projectPathCache.clear()
      for (const p of projects.projects) {
        projectPathCache.set(p.id, p.path)
      }
      if (projectId) return projectPathCache.get(projectId)
      if (threadId) {
        const t = await guiMms.request<{ thread: { projectId?: string } }>('threads.get', {
          threadId
        })
        if (t.thread.projectId) return projectPathCache.get(t.thread.projectId)
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  // Mousse ID sign-in runs in the system browser and calls back over loopback.
  mousseIdCallbacks?.dispose()
  mousseIdCallbacks = new MousseIdCallbacks(() => {
    const window = getWindow()
    if (!window || window.isDestroyed()) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })
  const callbackId = (raw: unknown): string => {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(raw)) throw new Error('Invalid Mousse ID callback id')
    return raw
  }
  registerHandler('mousseId:config', () => ({ origin: runtimeMousseIdOrigin() }))
  registerHandler('mousseId:callback.start', () => mousseIdCallbacks!.start())
  registerHandler('mousseId:callback.wait', (_event, id: unknown) => mousseIdCallbacks!.wait(callbackId(id)))
  registerHandler('mousseId:callback.cancel', (_event, id: unknown) => { mousseIdCallbacks!.cancel(callbackId(id)) })

  // The computer name is looked up once; starting it here keeps getInfo fast.
  void getComputerName()
  registerHandler('app:getInfo', async () => ({
    platform: process.platform,
    deviceName: await getComputerName(),
    repoRoot,
    llmProvider: settings.get().provider.llmProvider
  }))

  // Profile operations are installation metadata plus a trusted per-window
  // binding. The renderer supplies only an id/slug; daemon admission resolves
  // the owned profile root and changes the sender's session epoch.
  registerHandler('profiles:list', () => guiMms.request('profiles.list'))
  registerHandler('profiles:status', () => guiMms.request('profiles.status'))
  registerHandler('profiles:bind', (_e, profile: string) => guiMms.request('profiles.bind', { profile }))
  registerHandler('profiles:create', (_e, input: unknown) => guiMms.request('profiles.create', input))
  registerHandler('profiles:update', (_e, input: unknown) => guiMms.request('profiles.update', input))
  registerHandler('profiles:archive', (_e, input: unknown) => guiMms.request('profiles.archive', input))
  registerHandler('profiles:restore', (_e, input: unknown) => guiMms.request('profiles.restore', input))
  registerHandler('profiles:removePreview', (_e, profileId: string) => guiMms.request('profiles.removePreview', { profileId }))
  registerHandler('profiles:remove', (_e, input: unknown) => guiMms.request('profiles.remove', input))

  registerHandler('app:getActiveProjectPath', async (_e, threadId?: string | null) => {
    const id = threadId ?? currentPresentation().getActiveThreadId()
    return (await resolveProjectPath(undefined, id)) ?? null
  })

  registerHandler('app:getFilesRoot', async (_e, threadId?: string | null) => {
    const id = threadId ?? currentPresentation().getActiveThreadId()
    return resolveFilesRoot(undefined, id)
  })

  // Standalone threads intentionally browse the user's home directory. A ready
  // per-thread workspace is authoritative over the project's primary checkout;
  // FileService still applies its existing root guard to the selected root.
  const resolveFilesRoot = async (projectId?: string, threadId?: string | null): Promise<string> => {
    if (threadId) {
      try {
        const status = await guiMms.request<{
          execution?: { projectPath?: string; lifecycle?: string }
        }>('workspace.getStatus', { threadId })
        if (status.execution?.lifecycle === 'ready' && status.execution.projectPath) {
          return status.execution.projectPath
        }
      } catch {
        // Missing/unready workspace falls back to the daemon-authoritative project.
      }
    }
    return (await resolveProjectPath(projectId, threadId)) ?? homedir()
  }

  registerHandler(
    'fs:listDir',
    async (_e, dirPath?: string, projectId?: string, threadId?: string | null) =>
      fileService.listDir(await resolveFilesRoot(projectId, threadId), dirPath ?? '')
  )
  registerHandler(
    'fs:readFile',
    async (_e, filePath: string, projectId?: string, threadId?: string | null) =>
      fileService.readFile(await resolveFilesRoot(projectId, threadId), filePath)
  )
  registerHandler(
    'fs:readAsset',
    async (_e, filePath: string, projectId?: string, threadId?: string | null) =>
      fileService.readAsset(await resolveFilesRoot(projectId, threadId), filePath)
  )
  registerHandler(
    'fs:writeFile',
    async (
      _e,
      filePath: string,
      content: string,
      projectId?: string,
      threadId?: string | null
    ) => {
      const profileId = guiMms.getWindowBinding()?.profileId
      const lines = await fileService.writeFile(
        await resolveFilesRoot(projectId, threadId),
        filePath,
        content
      )
      await guiMms.request('stats.recordManualEdits', { lines, expectedProfileId: profileId })
    }
  )

  // Search runs in the daemon, never in this process. It deliberately skips
  // `resolveFilesRoot`, whose home-directory fallback must never be indexed.
  // The daemon rejects `threadId` and `projectId` together, hence the sequence.
  const searchScoped = async <T>(
    method: string,
    params: Record<string, unknown>,
    projectId?: string,
    threadId?: string | null
  ): Promise<T> => {
    if (!projectId && !threadId) throw new Error('Search needs a project')
    if (threadId) {
      try {
        return await guiMms.request<T>(method, { ...params, threadId })
      } catch (error) {
        // A thread without a project workspace, or with a worktree under
        // recovery, still searches the primary checkout, as the tree shows.
        if (!projectId) throw error
      }
    }
    return guiMms.request<T>(method, { ...params, projectId })
  }
  registerHandler(
    'fs:search',
    (
      _e,
      query: string,
      options?: { limit?: number; kinds?: Array<'file' | 'directory'> },
      projectId?: string,
      threadId?: string | null
    ) => searchScoped<FileSearchResponse>('files.search', { query, ...options }, projectId, threadId)
  )
  registerHandler(
    'fs:grep',
    (
      _e,
      query: string,
      options?: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; limit?: number; timeoutMs?: number },
      projectId?: string,
      threadId?: string | null
    ) =>
      searchScoped<FileGrepResponse>(
        'files.grep',
        {
          query,
          regex: options?.regex,
          caseSensitive: options?.caseSensitive,
          wholeWord: options?.wholeWord,
          limit: options?.limit,
          timeoutMs: options?.timeoutMs
        },
        projectId,
        threadId
      )
  )

  const resolveGitCwd = async (projectId?: string, cwd?: string): Promise<string> => {
    if (cwd) return cwd
    return (await resolveProjectPath(projectId)) ?? homedir()
  }
  registerHandler('git:status', async (_e, projectId?: string, cwd?: string) =>
    gitService.getStatus(await resolveGitCwd(projectId, cwd))
  )
  registerHandler('git:log', async (_e, limit?: number, projectId?: string, cwd?: string) =>
    gitService.getLog(await resolveGitCwd(projectId, cwd), limit)
  )
  registerHandler('git:branches', async (_e, projectId?: string, cwd?: string) =>
    gitService.getBranches(await resolveGitCwd(projectId, cwd))
  )
  registerHandler('git:diffStats', async (_e, projectId?: string, cwd?: string) =>
    gitService.getDiffStats(await resolveGitCwd(projectId, cwd))
  )
  // Every Git mutation runs in the daemon, so the thread-worktree rules and the repository lease apply
  // to the GUI like any other client. Storage handlers keep the daemon's error code across IPC.
  const gitMutation = <A extends unknown[]>(channel: string, method: string, toArgs: (...args: A) => Record<string, unknown> = () => ({})): void => {
    registerStorageHandler(channel, async (_e, scope: GitScope, ...args: unknown[]) =>
      guiMms.request(method, daemonGitParams(scope, toArgs(...(args as A))))
    )
  }
  gitMutation('git:checkout', 'git.checkout', (branch: string, options?: GitCheckoutOptions) => ({ branch, dirty: options?.dirty, operationId: options?.operationId }))
  gitMutation('git:commit', 'git.commit', (message: string, options?: GitCommitOptions) => ({ message, amend: options?.amend, expectedBranch: options?.expectedBranch, operationId: options?.operationId }))
  // A proposal, not a mutation, but it names its folder like one and its error codes (no title model) reach the renderer.
  gitMutation('git:suggestCommitMessage', 'git.suggestCommitMessage', (options?: { expectedBranch?: string }) => ({ expectedBranch: options?.expectedBranch }))
  gitMutation('git:push', 'git.push', (options?: GitPushOptions) => ({ expectedBranch: options?.expectedBranch, operationId: options?.operationId }))
  gitMutation('git:init', 'git.init')
  gitMutation('git:stage', 'git.stage', (input: { paths?: string[]; all?: boolean }) => ({ paths: input?.paths, all: input?.all }))
  gitMutation('git:unstage', 'git.unstage', (input: { paths?: string[]; all?: boolean }) => ({ paths: input?.paths, all: input?.all }))
  gitMutation('git:discard', 'git.discard', (paths: string[]) => ({ paths }))
  gitMutation('git:fetch', 'git.fetch', (options?: GitFetchOptions) => ({ operationId: options?.operationId }))
  gitMutation('git:pull', 'git.pull', (options?: GitPullOptions) => ({ strategy: options?.strategy, operationId: options?.operationId }))
  gitMutation('git:abortInProgress', 'git.abortInProgress', (kind: 'merge' | 'rebase') => ({ kind }))
  gitMutation('git:createBranch', 'git.createBranch', (name: string, options?: GitBranchOptions) => ({ name, from: options?.from, checkout: options?.checkout }))
  gitMutation('git:renameBranch', 'git.renameBranch', (name: string, newName: string) => ({ name, newName }))
  gitMutation('git:deleteBranch', 'git.deleteBranch', (name: string, options?: GitDeleteBranchOptions) => ({ name, force: options?.force }))
  // The daemon only stops an action for the window connection that started it, which is this sender's.
  registerStorageHandler('git:cancelOperation', async (_e, operationId: string) =>
    guiMms.request<{ cancelled: boolean }>('git.cancelOperation', { operationId })
  )
  registerHandler('git:lastCommitMessage', async (_e, projectId?: string, cwd?: string) =>
    gitService.lastCommitMessage(await resolveGitCwd(projectId, cwd))
  )
  registerHandler('pullRequests:get', async (_e, ref: PullRequestRef | undefined, branch?: string, force?: boolean) => {
    const response = await guiMms.request<{ lookup: unknown }>('pullRequests.get', {
      ...(typeof ref?.threadId === 'string' ? { threadId: ref.threadId } : {}),
      ...(typeof ref?.projectId === 'string' ? { projectId: ref.projectId } : {}),
      ...(typeof branch === 'string' ? { branch } : {}),
      ...(force === true ? { force } : {})
    })
    return response.lookup
  })
  registerHandler('pullRequests:detail', async (_e, ref: PullRequestRef | undefined, number: number, force?: boolean) => {
    const response = await guiMms.request<{ detail: PullRequestDetail }>('pullRequests.detail', {
      ...(typeof ref?.threadId === 'string' ? { threadId: ref.threadId } : {}),
      ...(typeof ref?.projectId === 'string' ? { projectId: ref.projectId } : {}),
      number,
      ...(force === true ? { force } : {})
    })
    return response.detail
  })
  registerHandler('pullRequests:draft', async (_e, scope: PullRequestScope, base?: string) => {
    const response = await guiMms.request<{ title: string; body: string; base: string; source: 'model' | 'heuristic' }>(
      'pullRequests.draft',
      { ...pullRequestScopeParams(scope), ...(typeof base === 'string' && base ? { base } : {}) }
    )
    return { title: response.title, body: response.body, base: response.base, source: response.source } satisfies PullRequestDraft
  })
  registerHandler('pullRequests:create', async (_e, scope: PullRequestScope, input: PullRequestFormInput) => {
    const response = await guiMms.request<CreatePullRequestResult>('pullRequests.create', {
      ...pullRequestScopeParams(scope),
      title: input?.title,
      body: input?.body,
      base: input?.base,
      draft: input?.draft === true
    })
    return { pullRequest: response.pullRequest, existing: response.existing === true } satisfies CreatePullRequestResult
  })
  registerHandler('pullRequests:baseBranches', async (_e, ref: PullRequestRef | undefined) => {
    const response = await guiMms.request<{ baseBranches: PullRequestBaseBranches }>('pullRequests.baseBranches', {
      ...(typeof ref?.threadId === 'string' ? { threadId: ref.threadId } : {}),
      ...(typeof ref?.projectId === 'string' ? { projectId: ref.projectId } : {})
    })
    return response.baseBranches
  })
  registerStorageHandler('pullRequests:list', async (_e, projectId: string, force?: boolean) => {
    const response = await guiMms.request<{ pullRequests: PullRequestListItem[] }>('pullRequests.list', {
      projectId,
      ...(force === true ? { force } : {})
    })
    return response.pullRequests
  })
  // The daemon's refusals (wrong repository, closed, already has a thread) carry codes the dialog words itself.
  registerStorageHandler('pullRequests:resolve', async (_e, projectId: string, reference: string) =>
    guiMms.request<ResolvedPullRequestSummary>('pullRequests.resolve', { projectId, reference })
  )
  registerStorageHandler('pullRequests:startThread', async (_e, input: StartPullRequestThreadInput) => {
    // The window opens the thread and fills its composer; sending the seed is for clients that have no composer.
    const response = await guiMms.request<StartPullRequestThreadResult & { thread: Thread; threads: Thread[] }>('pullRequests.startThread', {
      projectId: input?.projectId,
      reference: input?.reference,
      ...(input?.allowClosed === true ? { allowClosed: true } : {}),
      ...(input?.allowDuplicate === true ? { allowDuplicate: true } : {})
    })
    return { thread: response.thread, seed: response.seed, headSha: response.headSha, headMoved: response.headMoved, sent: response.sent, withheld: response.withheld }
  })
  registerHandler('pullRequests:pushTarget', async (_e, threadId: string) => {
    const response = await guiMms.request<{ target: PullRequestPushTarget }>('pullRequests.pushTarget', { threadId })
    return response.target
  })
  // A thread's watch of its pull request: `off`, `notify` (a line in the thread) or `act` (also wakes the agent).
  registerHandler('pullRequests:watch', async (_e, threadId: string, watch: PullRequestWatchMode, number?: number) => {
    const response = await guiMms.request<{ status: PullRequestWatchStatus }>('pullRequests.watch', {
      threadId,
      watch,
      ...(typeof number === 'number' ? { number } : {})
    })
    return response.status
  })
  registerHandler('pullRequests:watchStatus', async (_e, threadId: string) => {
    const response = await guiMms.request<{ status: PullRequestWatchStatus }>('pullRequests.watchStatus', { threadId })
    return response.status
  })
  registerHandler('editors:list', async (_e, options?: { refresh?: boolean }) =>
    listEditors(options)
  )
  registerHandler('editors:open', async (_e, editorId: string, path: string) => {
    await openInEditor(editorId, path)
  })

  registerHandler('github:status', async () => {
    const response = await guiMms.request<{ availability: unknown }>('github.status')
    return response.availability
  })
  registerHandler('github:createRepository', async (_e, input: GitHubCreateRepositoryInput) => {
    const response = await guiMms.request<{ result: unknown }>('github.createRepository', input)
    return response.result
  })
  registerHandler('github:chooseCloneDestination', async () => {
    const win = getWindow()
    const options: Electron.OpenDialogOptions = {
      title: 'Choose an empty folder for the cloned repository',
      buttonLabel: 'Use this folder',
      properties: ['openDirectory', 'createDirectory']
    }
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })
  registerHandler('github:cloneRepository', async (_e, input: GitHubCloneRepositoryInput) => {
    const response = await guiMms.request<{ project: unknown; projects: unknown[] }>(
      'github.cloneRepository',
      input
    )
    broadcast('projects:updated', response.projects)
    return { project: response.project }
  })

  const boundBrowserProfile = (): string => {
    const profileId = guiMms.getWindowBinding()?.profileId
    if (!profileId) throw new Error('Bind this window to a profile before using browser storage')
    return profileId
  }

  registerHandler('browser:navigate', (_e, url: string) => {
    browserView.setProfile(boundBrowserProfile())
    browserView.navigate(url)
    return browserView.getState()
  })
  registerHandler('browser:goBack', () => {
    browserView.setProfile(boundBrowserProfile())
    browserView.goBack()
    return browserView.getState()
  })
  registerHandler('browser:goForward', () => {
    browserView.setProfile(boundBrowserProfile())
    browserView.goForward()
    return browserView.getState()
  })
  registerHandler('browser:reload', () => {
    browserView.setProfile(boundBrowserProfile())
    browserView.reload()
    return browserView.getState()
  })
  registerHandler('browser:getState', () => {
    browserView.setProfile(boundBrowserProfile())
    return browserView.getState()
  })
  registerHandler('browser:clearCookies', async () => {
    const partition = profileBrowserPartition(boundBrowserProfile())
    await session.fromPartition(partition).clearStorageData({
      storages: ['cookies']
    })
  })
  registerHandler('browser:clearCache', async () => {
    const partition = profileBrowserPartition(boundBrowserProfile())
    await session.fromPartition(partition).clearCache()
  })
  registerHandler('browser:setVisible', (_e, visible: boolean) => {
    browserView.setProfile(boundBrowserProfile())
    browserView.setVisible(visible)
  })
  registerHandler('browser:setBounds', (_e, bounds: BrowserBounds) => {
    browserView.setProfile(boundBrowserProfile())
    browserView.setBounds(bounds)
  })

  // Daemon-owned settings/providers — chrome cache is updated from protocol only.
  registerHandler('settings:get', async () => {
    const res = await guiMms.request<{ settings: MousseSettings }>('settings.get')
    const senderId = guiMms.getCurrentSenderId()
    if (senderId !== null) {
      rememberWindowSettings(senderId, res.settings)
      const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.id === senderId)
      applyWindowAccentBackground(win, res.settings)
    }
    if (guiMms.getWindowBinding()?.profileId === guiMms.getBaseBinding()?.profileId) {
      try {
        settings.set(res.settings)
      } catch {
        /* chrome mirror best-effort */
      }
    }
    return res.settings
  })
  registerHandler('settings:set', async (event, partial: MousseSettingsUpdate) => {
    const res = await guiMms.request<{ settings: MousseSettings }>('settings.set', {
      partial
    })
    rememberWindowSettings(event.sender.id, res.settings)
    if (guiMms.getWindowBinding()?.profileId === guiMms.getBaseBinding()?.profileId) {
      try {
        settings.set(res.settings)
      } catch {
        /* ignore */
      }
    }
    applyWindowAccentBackground(BrowserWindow.fromWebContents(event.sender), res.settings)
    return res.settings
  })
  // Chords the renderer can run when they are typed into the browser surface (see menu/guestShortcutForward).
  registerHandler('commands:setGuestShortcuts', (event, entries: unknown) => {
    setGuestShortcuts(event.sender.id, entries)
  })
  registerHandler('settings:getOptions', async () => {
    const res = await guiMms.request<{ options: unknown }>('settings.getOptions')
    return res.options
  })

  registerHandler('lineEdits:getStats', () => guiMms.request('stats.lineEdits'))
  registerHandler('usageStats:getStats', () => guiMms.request('stats.usage'))

  registerHandler('providers:listConfigured', async () => {
    const res = await guiMms.request<{ providers: unknown[] }>('providers.listConfigured')
    return res.providers
  })
  registerHandler('providers:getUsage', async () =>
    guiMms.request('providers.getUsage')
  )
  registerHandler('providers:getSubscriptionUsage', async (_e, providerId: string) => {
    const res = await guiMms.request<{ usage?: string }>('providers.getSubscriptionUsage', {
      providerId
    })
    return res.usage
  })
  registerHandler('providers:getLoginOptions', async (_e, authType?: 'api_key' | 'oauth') => {
    const res = await guiMms.request<{ options: unknown[] }>('providers.getLoginOptions', {
      authType
    })
    return res.options
  })
  registerHandler('providers:refreshModels', async (_e, providerId: string) => {
    const res = await guiMms.request<{ options: unknown[] }>('providers.refreshModels', { providerId })
    const configured = await guiMms.request<{ providers: unknown[] }>('providers.listConfigured')
    broadcast('providers:changed', configured.providers)
    return res.options
  })
  registerHandler('providers:getAmbientInfo', async (_e, providerId: string) => {
    const res = await guiMms.request<{ info: unknown }>('providers.getAmbientInfo', {
      providerId
    })
    return res.info
  })
  registerHandler('providers:setApiKey', async (_e, providerId: string, apiKey: string) => {
    const res = await guiMms.request<{ providers: unknown[] }>('providers.setApiKey', {
      providerId,
      apiKey
    })
    broadcast('providers:changed', res.providers)
  })

  // Read aloud. Local model state is installation-wide, so every window hears about it.
  const localTtsModels = new LocalModelManager({
    rootDir: defaultLocalModelsRoot('tts'),
    models: LOCAL_TTS_MODELS,
    onStatus: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('readAloud:localModelStatus', status)
      }
    }
  })
  registerHandler('readAloud:localModels', () => localTtsModels.list())
  registerHandler('readAloud:downloadLocalModel', (_e, modelId: string) => localTtsModels.download(modelId))
  registerHandler('readAloud:cancelLocalModelDownload', (_e, modelId: string) => localTtsModels.cancel(modelId))
  registerHandler('readAloud:deleteLocalModel', (_e, modelId: string) => localTtsModels.delete(modelId))
  registerHandler('readAloud:readLocalModelFile', (_e, modelId: string, path: string) =>
    localTtsModels.readFile(modelId, path)
  )
  registerHandler('readAloud:synthesizeWithProvider', async (_e, request: ProviderSpeechRequest): Promise<ProviderSpeechResult> => {
    const res = await guiMms.request<{ audioBase64: string; mimeType: string }>('providers.synthesizeSpeech', {
      providerId: request?.providerId,
      modelId: request?.modelId,
      text: request?.text,
      voice: request?.voice
    })
    return { audio: Buffer.from(res.audioBase64, 'base64'), mimeType: res.mimeType }
  })

  // Dictation. Same installation-wide model state as read aloud, for speech-to-text.
  const localSttModels = new LocalModelManager({
    rootDir: defaultLocalModelsRoot('stt'),
    models: LOCAL_STT_MODELS,
    onStatus: (status) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('dictation:localModelStatus', status)
      }
    }
  })
  registerHandler('dictation:localModels', () => localSttModels.list())
  registerHandler('dictation:downloadLocalModel', (_e, modelId: string) => localSttModels.download(modelId))
  registerHandler('dictation:cancelLocalModelDownload', (_e, modelId: string) => localSttModels.cancel(modelId))
  registerHandler('dictation:deleteLocalModel', (_e, modelId: string) => localSttModels.delete(modelId))
  registerHandler('dictation:readLocalModelFile', (_e, modelId: string, path: string) =>
    localSttModels.readFile(modelId, path)
  )
  registerHandler(
    'dictation:transcribeWithProvider',
    async (_e, request: ProviderTranscriptionRequest): Promise<ProviderTranscriptionResult> => {
      const audio = request?.audio
      if (!(audio instanceof Uint8Array)) throw new Error('No recording to transcribe')
      if (audio.byteLength > PROVIDER_STT_MAX_BYTES) throw new Error('The recording is too long to transcribe with this provider. Record a shorter message.')
      const res = await guiMms.request<{ text: string }>('providers.transcribeAudio', {
        providerId: request.providerId,
        modelId: request.modelId,
        mimeType: request.mimeType,
        audioBase64: Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength).toString('base64')
      })
      return { text: res.text }
    }
  )

  registerHandler('webTools:getCredentialStatus', async () => {
    const res = await guiMms.request<{ credentials: { exa: boolean; parallel: boolean } }>(
      'webTools.getCredentialStatus'
    )
    return res.credentials
  })
  registerHandler('webTools:setApiKey', async (_e, service: 'exa' | 'parallel', apiKey: string) => {
    await guiMms.request('webTools.setApiKey', { service, apiKey })
  })
  registerHandler('webTools:clearApiKey', async (_e, service: 'exa' | 'parallel') => {
    await guiMms.request('webTools.clearApiKey', { service })
  })
  registerHandler('providers:verifyAmbient', async (_e, providerId: string) => {
    const res = await guiMms.request<{ result: { success?: boolean }; providers: unknown[] }>(
      'providers.verifyAmbient',
      { providerId }
    )
    if (res.result?.success) {
      broadcast('providers:changed', res.providers)
    }
    return res.result
  })
  registerHandler('providers:logout', async (_e, providerId: string) => {
    const res = await guiMms.request<{ providers: unknown[] }>('providers.logout', {
      providerId
    })
    broadcast('providers:changed', res.providers)
  })
  // Harness gateway. Changes reach every window as `providers:snapshots` and operation progress as
  // `providers:operation` through the protocol event bridge; long operations return an id at once.
  registerHandler('providers:snapshots', async (_e, scope: unknown) => {
    const res = await guiMms.request<{ snapshots: unknown[] }>('providers.snapshots', { scope })
    return res.snapshots
  })
  const instanceCommand = <K extends string>(method: string, key: K) =>
    async (params: Record<string, unknown>): Promise<unknown> =>
      (await guiMms.request<Record<K, unknown>>(method, params))[key]
  const addInstance = instanceCommand('providers.instances.add', 'snapshot')
  const configureInstance = instanceCommand('providers.instances.configure', 'snapshot')
  const setInstanceEnabled = instanceCommand('providers.instances.setEnabled', 'snapshot')
  const installInstance = instanceCommand('providers.instances.install', 'operation')
  const cancelInstanceInstall = instanceCommand('providers.instances.cancelInstall', 'cancelled')
  const updateInstance = instanceCommand('providers.instances.update', 'operation')
  const signInInstance = instanceCommand('providers.instances.signIn', 'operation')
  const respondInstanceSignIn = instanceCommand('providers.instances.respondSignIn', 'ok')
  const signOutInstance = instanceCommand('providers.instances.signOut', 'snapshot')
  const recheckInstance = instanceCommand('providers.instances.recheck', 'snapshot')
  const moveInstance = instanceCommand('providers.instances.move', 'result')
  const removeInstanceInstall = instanceCommand('providers.instances.removeInstall', 'result')
  const searchRegistry = instanceCommand('providers.registry.search', 'agents')
  const refreshInstanceModels = instanceCommand('providers.instances.refreshModels', 'snapshot')
  const refreshAllInstanceModels = instanceCommand('providers.instances.refreshAllModels', 'results')
  const setInstanceModelPrefs = instanceCommand('providers.instances.setModelPrefs', 'snapshot')
  // The daemon validates every payload.
  registerHandler('providers:instances:add', async (_e, input: Record<string, unknown>) => addInstance(input))
  registerHandler('providers:instances:remove', async (_e, instanceId: string) => {
    await guiMms.request('providers.instances.remove', { instanceId })
  })
  registerHandler('providers:instances:configure', async (_e, instanceId: string, patch: unknown) =>
    configureInstance({ instanceId, patch }))
  registerHandler('providers:instances:setEnabled', async (_e, instanceId: string, scope: unknown, enabled: unknown) =>
    setInstanceEnabled({ instanceId, scope, enabled }))
  registerHandler('providers:instances:install', async (_e, instanceId: string) => installInstance({ instanceId }))
  registerHandler('providers:instances:cancelInstall', async (_e, operationId: string) =>
    cancelInstanceInstall({ operationId }))
  registerHandler('providers:instances:update', async (_e, instanceId: string) => updateInstance({ instanceId }))
  registerHandler('providers:instances:signIn', async (_e, instanceId: string, method?: string) =>
    signInInstance({ instanceId, method }))
  registerHandler('providers:instances:respondSignIn', async (_e, operationId: string, response: unknown) =>
    respondInstanceSignIn({ operationId, response }))
  registerHandler('providers:instances:signOut', async (_e, instanceId: string) => signOutInstance({ instanceId }))
  registerHandler('providers:instances:recheck', async (_e, instanceId: string) => recheckInstance({ instanceId }))
  registerHandler('providers:instances:move', async (_e, instanceId: string, toInstanceId: string, options?: { copyKey?: boolean }) =>
    moveInstance({ instanceId, toInstanceId, copyKey: options?.copyKey === true }))
  registerHandler('providers:instances:removeInstall', async (_e, instanceId: string, force: unknown) =>
    removeInstanceInstall({ instanceId, force: force === true }))
  registerHandler('providers:registry:search', async (_e, query: unknown) => searchRegistry({ query: typeof query === 'string' ? query : '' }))
  registerHandler('providers:instances:refreshModels', async (_e, instanceId: string) =>
    refreshInstanceModels({ instanceId }))
  registerHandler('providers:instances:refreshAllModels', async () => refreshAllInstanceModels({}))
  registerHandler('providers:instances:setModelPrefs', async (_e, instanceId: string, patch: unknown) =>
    setInstanceModelPrefs({ instanceId, patch }))
  registerHandler('dialog:pickExecutable', async (event, request: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? getWindow()
    return pickExecutable((options) => (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)), request)
  })
  registerHandler('providers:login:respond', async (_e, response: ProviderLoginResponse) => {
    await guiMms.request('providers.loginRespond', {
      sessionId: response.sessionId,
      response
    })
  })
  registerHandler('providers:login:cancel', async (_e, sessionId: string) => {
    await guiMms.request('providers.loginCancel', { sessionId })
  })
  registerHandler('providers:openLoginUrl', async (_e, url: string) => {
    const ok = await openExternalSafely(
      (target) => shell.openExternal(target),
      url,
      'providers:openLoginUrl'
    )
    return { ok }
  })
  registerHandler('providers:loginOAuth', async (_e, providerId: string) => {
    const handler = (ev: { type?: string; data?: unknown }): void => {
      if (ev?.type === 'providers.login-event') {
        const data = ev.data as { event?: ProviderLoginEvent }
        if (data?.event) broadcast('providers:login:event', data.event)
      }
    }
    guiMms.on('event', handler)
    try {
      const res = await guiMms.request<{
        result: unknown
        providers: unknown[]
      }>('providers.loginOAuth', { providerId })
      if ((res.result as { success?: boolean })?.success) {
        broadcast('providers:changed', res.providers)
      }
      return res.result
    } finally {
      guiMms.off('event', handler)
    }
  })
  registerHandler('providers:loginApiKey', async (_e, providerId: string) => {
    const handler = (ev: { type?: string; data?: unknown }): void => {
      if (ev?.type === 'providers.login-event') {
        const data = ev.data as { event?: ProviderLoginEvent }
        if (data?.event) broadcast('providers:login:event', data.event)
      }
    }
    guiMms.on('event', handler)
    try {
      const res = await guiMms.request<{
        result: unknown
        providers: unknown[]
      }>('providers.loginApiKey', { providerId })
      if ((res.result as { success?: boolean })?.success) {
        broadcast('providers:changed', res.providers)
      }
      return res.result
    } finally {
      guiMms.off('event', handler)
    }
  })

  registerHandler('app:restart', async () => {
    if (services.requestAppRestart) {
      await services.requestAppRestart()
      return { ok: true }
    }
    app.relaunch()
    app.quit()
    return { ok: true }
  })

  registerHandler('window:syncBackground', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return false
    return applyWindowMaterial(win, settings)
  })
  registerHandler('app:navigateMainView', (_e, view: MainView) => {
    broadcast('app:navigateMainView', view)
  })
  registerHandler('window:focusMain', () => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  registerHandler('window:minimize', () => {
    getWindow()?.minimize()
  })
  registerHandler('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    toggleWindowZoom(win, settings)
  })
  registerHandler('window:dragStart', (_e, point: WindowDragPoint) => {
    const win = getWindow()
    if (!win) return
    beginWindowDrag(win, settings, point)
  })
  registerHandler('window:dragMove', (_e, point: WindowDragPoint) => {
    const win = getWindow()
    if (!win) return
    updateWindowDrag(win, settings, point)
  })
  registerHandler('window:dragEnd', () => {
    const win = getWindow()
    if (!win) return
    endWindowDrag(win, settings)
  })
  registerHandler('window:close', () => {
    console.info('[window] Close requested by caption control')
    getWindow()?.close()
  })
  registerHandler('window:isMaximized', () => {
    const win = getWindow()
    return win ? isWindowZoomed(win) : false
  })
  registerHandler('clipboard:showCopyMenu', (_e, x: number, y: number, text: string) => {
    showCopyMenu(getWindow, x, y, text)
  })

  return { syncDaemonTurnSnapshot }
}

export function attachWindowListeners(
  getWindow: () => BrowserWindow | null,
  settings: SettingsStore
): void {
  attachWindowStateListeners(getWindow, settings)
  attachWindowFocusListeners(getWindow, settings)
}
