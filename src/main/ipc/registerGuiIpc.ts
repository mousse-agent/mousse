/**
 * Phase 3 GUI IPC: protocol-backed agent-chat/project/thread/queue + Electron-local UI.
 * Does not take a MousseMainService / owner lease.
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron'
import { homedir } from 'os'
import { randomUUID } from 'node:crypto'
import type { GuiMmsController } from '../mms/GuiMmsController'
import { PresentationState } from '../mms/PresentationState'
import type { ProtocolEvent } from '../../mms/protocol'
import {
  bridgeProtocolEvent,
  broadcastThreadSnapshot
} from '../mms/protocolEventBridge'
import { SettingsStore } from '../../mms/settings/SettingsStore'
import { FileService } from '../../mms/files/FileService'
import { GitService } from '../../mms/git/GitService'
import { BrowserViewManager } from '../browser/BrowserViewManager'
import type { AttachedBrowserHost } from '../browser/AttachedBrowserHost'
import { domainObject } from '../../mms/protocol/domainRegistry'
import { profileBrowserPartition } from '../browser/browserPolicy'
import { ThreadActivityTracker } from '../data/ThreadActivityTracker'
import type { ProviderLoginEvent } from '../../shared/providerAuth'
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
import { buildAccentCssVars, surfaceToWindowBackground } from '../../shared/accentPalette'
import { showCopyMenu } from '../contextMenu'
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
import { closeAgentsTasksWindow, openAgentsTasksWindow } from '../agentsTasksWindow'
import {
  getThreadNotificationPresentation,
  type ThreadNotificationKind
} from '../notifications/threadNotification'
import { playThreadCompletionSound } from '../notifications/completionSound'
import type {
  BrowserBounds,
  ChannelConfig,
  ChannelPlatform,
  ChatImageAttachment,
  ContextUsageSnapshot,
  CreateScheduledJobInput,
  MainView,
  OrchestratorContextUsageInput,
  OrchestratorSendInput,
  ScheduledJob,
  ThreadActivitySnapshot,
  ThreadActivityState,
  TurnState,
  TurnStateSnapshot,
  UserQuestionAnswers
} from '../../shared/types'
import type { RemoteScope } from '../../shared/controlTypes'
import type { ProviderLoginResponse } from '../../shared/providerAuth'


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
  'skills.create', 'skills.update', 'skills.editor', 'skills.enable', 'skills.archive',
  'skills.importPackage', 'skills.exportPackage',
  'mcp.create', 'mcp.update', 'mcp.read', 'mcp.enable', 'mcp.delete',
  'mcp.testConnection', 'mcp.beginAuth', 'mcp.cancelAuth', 'mcp.revokeAuth'
])

class PlatformRequestError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'PlatformRequestError'
    this.code = code
    this.details = details
  }
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

function applyWindowAccentBackground(
  win: BrowserWindow | null | undefined,
  settings: MousseSettings
): void {
  if (!win || win.isDestroyed()) return
  setWindowProfileSettings(win, settings)
  const appearance = normalizeAppearance(settings.appearance)
  const surfaceBase = buildAccentCssVars(appearance.accentColor)['--surface-base']
  if (!surfaceBase) return
  win.setBackgroundColor(
    surfaceToWindowBackground(surfaceBase, appearanceUsesAcrylic(appearance) ? 0 : 1)
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
      return { ok: true, value: await guiMms.request(method, params) }
    } catch (error) {
      if (error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string') {
        return {
          ok: false,
          error: {
            code: (error as { code: string }).code,
            message: error instanceof Error ? error.message : 'Platform request failed',
            ...((error as { details?: unknown }).details === undefined ? {} : { details: (error as { details: unknown }).details })
          }
        }
      }
      return { ok: false, error: { code: 'platform_request_failed', message: error instanceof Error ? error.message : String(error) } }
    }
  })

  // Presentation (thread selection, activity and pending question ownership)
  // is window-local. The daemon binding is captured by GuiMmsController from
  // the trusted sender; this map keeps the corresponding chrome state from
  // repainting another profile's window.
  const windowPresentations = new Map<number, PresentationState>()
  const windowSettings = new Map<number, MousseSettings>()
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

  const broadcast = (channel: string, data: unknown, profileId?: string): void => {
    const senderId = guiMms.getCurrentSenderId()
    const senderProfile = senderId === null ? undefined : guiMms.getWindowBindingForSender(senderId)?.profileId
    // IPC handlers run inside GuiMmsController's trusted sender context. Use
    // that binding as the default for personal replies; daemon events supply
    // activeEventProfileId instead. Installation-wide listeners remain global.
    const targetProfileId = profileId ?? activeEventProfileId ?? senderProfile
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
    profileSettings = settings.get()
  ): void => {
    const content = getThreadNotificationPresentation(kind, profileSettings)
    const win = targetWindow
    const isFocused = win?.isFocused() ?? false
    if (isFocused && activeThreadId === threadId) {
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
      title: 'Mousse',
      ...content,
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
        // the parent turn — the daemon keeps this state processing while an
        // owning subagent is still active. Requiring previous === processing
        // dings exactly once per work cycle.
        if (previousState === 'processing') {
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
      if (activityTrackerFor().getState(event.threadId) === 'processing') {
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
    if (event.type === 'control.status-changed') {
      broadcast('control:status-changed', event.data)
    }
    if (event.type === 'control.pairing-request') {
      broadcast('control:pairing-request', event.data)
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
    bridgeProtocolEvent(event, target, presentationForSender(senderId))
    if (event.type === 'activity' && event.threadId) {
      const state = (event.data as { state?: ThreadActivityState } | null)?.state
      if (!replay && previousActivity === 'processing' && state && state !== 'processing') {
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
          windowSettings.get(senderId) ?? settings.get()
        )
      }
    }
    if (event.type === 'questions.pending' && event.threadId && tracker.getState(event.threadId) === 'processing') {
      tracker.setState(event.threadId, 'awaiting_input')
      target('threads:activity', tracker.getSnapshot())
      if (!replay) notifyThread(
        event.threadId,
        'question',
        presentationForSender(senderId).getActiveThreadId(),
        win,
        windowSettings.get(senderId) ?? settings.get()
      )
    }
    if (event.type === 'settings.changed') {
      const next = (event.data as { settings?: MousseSettings } | null)?.settings
      if (next) {
        windowSettings.set(senderId, next)
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
    if (event.type === 'control.status-changed') target('control:status-changed', event.data)
    if (event.type === 'control.pairing-request') target('control:pairing-request', event.data)
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
      target('orchestrator:messages', snap.messages)
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
    if (!targetThreadId) throw new Error('No thread selected')
    activityTrackerFor().setBusyThreadId(targetThreadId)
    setThreadActivity(targetThreadId, 'processing')
    const body = normalizeSendContent(request)
    try {
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
      setThreadActivity(targetThreadId, 'idle')
      activityTrackerFor().setBusyThreadId(null)
      throw err
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

  registerHandler(
    'orchestrator:answerQuestions',
    async (_e, requestId: string, answers: UserQuestionAnswers) => {
      const res = await guiMms.request<{ ok: boolean }>('orchestrator.answerQuestions', {
        requestId,
        answers
      })
      const busy = activityTrackerFor().getBusyThreadId()
      if (res.ok && busy) setThreadActivity(busy, 'processing')
      return res.ok
    }
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
  registerHandler('actions:pin', async (_e, params: Record<string, unknown>) => guiMms.request('actions.pin', params))
  registerHandler('actions:configureRetention', async (_e, params: Record<string, unknown>) => guiMms.request('actions.configureRetention', params))
  registerHandler('actions:sweepRetention', async (_e, threadId: string) => guiMms.request('actions.sweepRetention', { threadId }))
  registerHandler('actions:undoLatest', async (_e, threadId: string, expectedJournalGeneration: number) =>
    guiMms.request('actions.undoLatest', { threadId, expectedJournalGeneration })
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
  registerHandler('threads:restore', async (_e, threadId: string) =>
    guiMms.request('threads.restore', { threadId })
  )
  registerHandler('threads:purge', async (_e, threadId: string, options: Record<string, unknown> = {}) =>
    guiMms.request('threads.purge', { ...options, threadId })
  )
  registerHandler('threads:inventory', async (_e, threadId?: string) => guiMms.request('threads.inventory', { threadId }))
  registerHandler('threads:configureTrash', async (_e, policy: { graceDays: number; automaticPurge: boolean }) => guiMms.request('threads.configureTrash', policy))

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

  /** Monotonic generation so rapid switches drop stale snapshot replies. */
  let selectGeneration = 0

  const selectThread = async (threadId: string): Promise<void> => {
    const gen = ++selectGeneration
    currentPresentation().setActiveThreadId(threadId)
    // Publish selection immediately so the sidebar/highlight updates before the
    // (potentially large) thread.snapshot round-trip completes.
    broadcast('thread:selected', { id: threadId })

    // A completed state is an unread-style notification. Viewing the thread
    // acknowledges it, while processing and awaiting-input states remain visible.
    // Clear it before the snapshot round-trip so the glow vanishes immediately.
    if (activityTrackerFor().getState(threadId) === 'completed') {
      setThreadActivity(threadId, 'idle')
    }

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
      let activity: import('../../shared/types').ThreadActivityState =
        full.activity && full.activity !== 'idle'
          ? full.activity
          : hasPendingWork
            ? 'processing'
            : 'idle'
      // The daemon keeps reporting completed until the next turn starts, so a
      // snapshot fill must never light the completion glow: a live completion
      // was already acknowledged (and cleared) above, and any older label is
      // consumed history. Fresh completions arrive as activity events, which
      // the tracker observes directly — the fill only covers threads this GUI
      // never saw finish.
      if (activity === 'completed') {
        activity = 'idle'
      }
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

  registerHandler('threads:delete', async (_e, threadId: string) => {
    const res = await guiMms.request<{ threads: { id: string; settledAt?: string }[] }>(
      'threads.delete',
      { threadId }
    )
    broadcast('threads:updated', res.threads)
    if (currentPresentation().getActiveThreadId() === threadId) {
      const next = res.threads.find((t) => !t.settledAt)
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
      model?: { llmProvider: string; model: string }
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
  registerHandler('agents:stop', async (_e, agentId: string) => {
    const threadId = currentPresentation().getActiveThreadId()
    if (!threadId) throw new Error('No active thread')
    const res = await guiMms.request<{ logs: string[] }>('agents.stop', { threadId, agentId })
    return res.logs
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
  registerHandler('mousseAgent:getMessages', async (_e, agentId: string) => {
    const threadId = currentPresentation().getActiveThreadId()
    if (!threadId) return []
    const res = await guiMms.request<{ messages: unknown[] }>('mousseAgent.getMessages', {
      threadId,
      agentId
    })
    return res.messages
  })
  registerHandler('mousseAgent:getAssignment', async (_e, agentId: string) => {
    const res = await guiMms.request<{ assignment?: unknown }>('mousseAgent.getAssignment', {
      agentId
    })
    return res.assignment
  })
  registerHandler('mousseAgent:getContextUsage', async (_e, agentId: string, draftInput = '') => {
    const threadId = currentPresentation().getActiveThreadId()
    if (!threadId) return undefined
    const res = await guiMms.request<{ usage?: ContextUsageSnapshot }>('mousseAgent.contextUsage', {
      threadId,
      agentId,
      draftInput
    })
    return res.usage
  })
  registerHandler('mousseAgent:retryConnection', async (_e, agentId: string) => {
    const threadId = currentPresentation().getActiveThreadId()
    if (!threadId) return
    await guiMms.request('mousseAgent.retry', { threadId, agentId })
  })
  registerHandler('mousseAgent:abort', async (_e, agentId: string) => {
    const res = await guiMms.request<{ aborted: boolean }>('mousseAgent.abort', { agentId })
    return res.aborted
  })
  registerHandler(
    'mousseAgent:send',
    async (
      _e,
      agentId: string,
      content: string,
      images?: ChatImageAttachment[]
    ) => {
      const threadId = currentPresentation().getActiveThreadId()
      if (!threadId) return { accepted: false, reason: 'missing' as const }
      return guiMms.request<{ accepted: boolean; reason?: string }>('mousseAgent.send', {
        threadId,
        agentId,
        content,
        images
      })
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

  registerHandler('app:getInfo', () => ({
    platform: process.platform,
    repoRoot,
    macroProviders: [],
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
    return (await resolveProjectPath(undefined, id)) ?? homedir()
  })

  // Standalone threads intentionally browse the user's home directory. Always resolve
  // project-backed operations from the supplied thread instead of reusing GUI selection.
  const resolveFilesRoot = async (projectId?: string, threadId?: string | null): Promise<string> =>
    (await resolveProjectPath(projectId, threadId)) ?? homedir()

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
  registerHandler(
    'fs:stat',
    async (_e, targetPath: string, projectId?: string, threadId?: string | null) =>
      fileService.stat(await resolveFilesRoot(projectId, threadId), targetPath)
  )

  const resolveGitCwd = async (projectId?: string, cwd?: string): Promise<string> => {
    if (cwd) return cwd
    return (await resolveProjectPath(projectId)) ?? homedir()
  }
  registerHandler('git:status', async (_e, projectId?: string, cwd?: string) =>
    gitService.getStatus(await resolveGitCwd(projectId, cwd))
  )
  registerHandler(
    'git:diff',
    async (_e, filePath: string, staged: boolean, projectId?: string, cwd?: string) =>
      gitService.getDiff(await resolveGitCwd(projectId, cwd), filePath, staged)
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
  registerHandler(
    'git:checkout',
    async (_e, branch: string, projectId?: string, cwd?: string) => {
      await gitService.checkout(await resolveGitCwd(projectId, cwd), branch)
    }
  )
  registerHandler(
    'git:commit',
    async (_e, message: string, projectId?: string, cwd?: string) => {
      await gitService.commit(await resolveGitCwd(projectId, cwd), message)
    }
  )
  registerHandler('git:push', async (_e, projectId?: string, cwd?: string) => {
    await gitService.push(await resolveGitCwd(projectId, cwd))
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
      windowSettings.set(senderId, res.settings)
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
    windowSettings.set(event.sender.id, res.settings)
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
  registerHandler('providers:login:respond', async (_e, response: ProviderLoginResponse) => {
    await guiMms.request('providers.loginRespond', {
      sessionId: response.sessionId,
      response
    })
  })
  registerHandler('providers:login:cancel', async (_e, sessionId: string) => {
    await guiMms.request('providers.loginCancel', { sessionId })
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
    closeAgentsTasksWindow()
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
  registerHandler('window:closeAgentsTasks', () => {
    closeAgentsTasksWindow()
  })
  registerHandler('window:openAgentsTasks', (e, anchor?: { x: number; y: number }) => {
    openAgentsTasksWindow(
      settings,
      BrowserWindow.fromWebContents(e.sender) ?? getWindow() ?? undefined,
      anchor
    )
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
    getWindow()?.close()
  })
  registerHandler('window:isMaximized', () => {
    const win = getWindow()
    return win ? isWindowZoomed(win) : false
  })
  registerHandler('clipboard:showCopyMenu', (_e, x: number, y: number, text: string) => {
    showCopyMenu(getWindow, x, y, text)
  })

  // --- Control Protocol 2.0 / Remote & Mobile IPC handlers ---
  registerHandler('control:status', async () => {
    return guiMms.controlStatus()
  })
  registerHandler('control:login', async () => {
    return guiMms.controlLogin()
  })
  registerHandler('control:logout', async () => {
    return guiMms.controlLogout()
  })
  registerHandler('control:enroll', async (_e, serverUrl: string, pairingCode: string) => {
    return guiMms.controlEnroll(serverUrl, pairingCode)
  })
  registerHandler('control:disconnect', async () => {
    return guiMms.controlDisconnect()
  })
  registerHandler('control:setMode', async (_e, mode: 'hosted' | 'self-hosted') => {
    return guiMms.controlSetMode(mode)
  })
  registerHandler('control:pairing:create', async (_e, options?: { scopes?: RemoteScope[]; ttlMs?: number }) => {
    return guiMms.pairingCreate(options)
  })
  registerHandler('control:pairing:list', async () => {
    return guiMms.pairingList()
  })
  registerHandler('control:pairing:approve', async (_e, pairingId: string, scopes?: RemoteScope[]) => {
    return guiMms.pairingApprove(pairingId, scopes)
  })
  registerHandler('control:pairing:reject', async (_e, pairingId: string) => {
    return guiMms.pairingReject(pairingId)
  })
  registerHandler('control:pairing:revoke', async (_e, pairingIdOrDeviceId: string) => {
    return guiMms.pairingRevoke(pairingIdOrDeviceId)
  })
  registerHandler('control:openDashboard', async (_e, url?: string) => {
    const targetUrl = url || 'https://mousse.plus'
    await shell.openExternal(targetUrl)
    return { ok: true }
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

/**
 * Ensure the GUI has an active presentation thread after connect/reload.
 */
export async function bootstrapPresentation(
  guiMms: GuiMmsController,
  presentation: PresentationState,
  broadcast: (channel: string, data: unknown) => void,
  opts?: { onTurnSnapshot?: (snap: unknown) => void }
): Promise<void> {
  const threadsRes = await guiMms.request<{
    threads: { id: string; settledAt?: string; name?: string }[]
  }>('threads.list')
  const projectsRes = await guiMms.request<{ projects: unknown[] }>('projects.list')
  broadcast('projects:updated', projectsRes.projects)
  broadcast('threads:updated', threadsRes.threads)

  let activeId = presentation.getActiveThreadId()
  const usable = threadsRes.threads.filter((t) => !t.settledAt)
  if (activeId && !usable.some((t) => t.id === activeId)) {
    activeId = null
  }
  if (!activeId) {
    if (usable.length > 0) {
      activeId = usable[0].id
    } else {
      const created = await guiMms.request<{ thread: { id: string } }>('threads.create', {
        name: 'New Chat'
      })
      activeId = created.thread.id
      const refreshed = await guiMms.request<{ threads: unknown[] }>('threads.list')
      broadcast('threads:updated', refreshed.threads)
    }
  }
  presentation.setActiveThreadId(activeId)
  const snap = await guiMms.snapshotThread(activeId)
  const bootFull = snap as {
    agents?: unknown[]
    tasks?: unknown[]
    pendingQuestions?: Array<{ requestId: string; questions: unknown }>
  }
  opts?.onTurnSnapshot?.(snap)
  broadcastThreadSnapshot(
    activeId,
    {
      messages: snap.messages,
      queue: snap.queue,
      connectionFailed: snap.connectionFailed,
      agents: bootFull.agents,
      tasks: bootFull.tasks
    },
    broadcast,
    presentation
  )
  for (const q of bootFull.pendingQuestions ?? []) {
    broadcast('orchestrator:questionsPending', {
      requestId: q.requestId,
      questions: q.questions
    })
  }
  broadcast('thread:selected', { id: activeId })
}
