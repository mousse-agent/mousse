/**
 * Phase 3 GUI IPC: protocol-backed agent-chat/project/thread/queue + Electron-local UI.
 * Does not take a MousseMainService / owner lease.
 */

import { app, BrowserWindow, dialog, ipcMain, Notification, session, shell } from 'electron'
import { homedir } from 'os'
import type { GuiMmsController } from '../mms/GuiMmsController'
import type { PresentationState } from '../mms/PresentationState'
import {
  bridgeProtocolEvent,
  broadcastThreadSnapshot
} from '../mms/protocolEventBridge'
import { SettingsStore } from '../../mms/settings/SettingsStore'
import { FileService } from '../../mms/files/FileService'
import { GitService } from '../../mms/git/GitService'
import { LineEditStatsStore } from '../../mms/stats/LineEditStatsStore'
import { BrowserViewManager } from '../browser/BrowserViewManager'
import { MOUSSE_BROWSER_PARTITION } from '../browser/browserPolicy'
import { threadActivityTracker } from '../data/ThreadActivityTracker'
import type { ProviderLoginEvent } from '../../shared/providerAuth'
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
import { applyWindowMaterial, attachWindowFocusListeners } from '../windowMaterial'
import { closeAgentsTasksWindow, openAgentsTasksWindow } from '../agentsTasksWindow'
import {
  getThreadNotificationPresentation,
  type ThreadNotificationKind
} from '../notifications/threadNotification'
import type {
  BrowserBounds,
  ChannelConfig,
  ChannelPlatform,
  ChatImageAttachment,
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
  lineEditStats: LineEditStatsStore
  browserView: BrowserViewManager
  repoRoot: string
  requestAppRestart?: () => Promise<void>
}

function registerHandler(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}

function applyWindowAccentBackground(
  win: BrowserWindow | null | undefined,
  settings: MousseSettings
): void {
  if (!win || win.isDestroyed()) return
  const appearance = normalizeAppearance(settings.appearance)
  const surfaceBase = buildAccentCssVars(appearance.accentColor)['--surface-base']
  if (!surfaceBase) return
  win.setBackgroundColor(
    surfaceToWindowBackground(surfaceBase, appearanceUsesAcrylic(appearance) ? 0 : 1)
  )
}

function normalizeSendContent(request: OrchestratorSendInput): {
  content: string
  mode?: unknown
  images?: unknown
} {
  if (typeof request === 'string') return { content: request }
  return {
    content: request.content,
    mode: request.mode,
    images: request.images
  }
}

export function registerGuiIpc(
  services: GuiIpcServices,
  getWindow: () => BrowserWindow | null
): void {
  const {
    guiMms,
    presentation,
    settings,
    fileService,
    gitService,
    lineEditStats,
    browserView,
    repoRoot
  } = services

  const broadcast = (channel: string, data: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  const notifyThread = (
    threadId: string,
    kind: ThreadNotificationKind,
    activeThreadId: string | null
  ): void => {
    const win = getWindow()
    const isFocused = win?.isFocused() ?? false
    if (isFocused && activeThreadId === threadId) return
    if (!Notification.isSupported()) return
    const presentation = getThreadNotificationPresentation(kind, settings.get())
    const useWindowsCompletionBeep =
      process.platform === 'win32' && kind === 'completed' && !presentation.silent
    const notification = new Notification({
      title: 'Mousse',
      ...presentation,
      // Unpackaged Windows Electron notifications do not reliably play their toast
      // sound. Use the OS alert beep below instead, and avoid a possible double sound.
      silent: useWindowsCompletionBeep ? true : presentation.silent
    })
    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
    })
    notification.show()
    if (useWindowsCompletionBeep) shell.beep()
  }

  const setThreadActivity = (threadId: string, state: ThreadActivityState): void => {
    threadActivityTracker.setState(threadId, state)
    broadcast('threads:activity', threadActivityTracker.getSnapshot())
  }

  const turnStateMap = new Map<string, TurnState>()
  const setTurnState = (state: TurnState): void => {
    turnStateMap.set(state.threadId, state)
    broadcast('orchestrator:turn-state', state)
    broadcast('turns:state', Object.fromEntries(turnStateMap))
  }
  const getTurnSnapshot = (): TurnStateSnapshot => Object.fromEntries(turnStateMap)

  // Protocol events → renderer IPC (exact existing channel names).
  guiMms.on('event', (event) => {
    if (event.type === 'activity' && event.threadId) {
      const state = (event.data as { state?: ThreadActivityState } | null)?.state
      if (state) {
        const previousState = threadActivityTracker.getState(event.threadId)
        setThreadActivity(event.threadId, state)
        // Completion belongs to the whole thread, not merely the parent turn. The
        // daemon keeps this state processing while an owning subagent is still active.
        if (state === 'completed' && previousState === 'processing') {
          notifyThread(event.threadId, 'completed', presentation.getActiveThreadId())
        }
      }
    }
    // Daemon-wide snapshots describe runtime state, not unread state. Reconcile
    // them through the local tracker so opening/creating a thread cannot revive
    // already-consumed historical completions for every thread in the project.
    let reconciledActivity: ThreadActivitySnapshot | undefined
    if (event.type === 'activity' || event.type === 'activity.snapshot') {
      const activity = (event.data as { activity?: ThreadActivitySnapshot } | null)?.activity
      if (activity && typeof activity === 'object' && !Array.isArray(activity)) {
        threadActivityTracker.reconcileSnapshot(activity)
        reconciledActivity = threadActivityTracker.getSnapshot()
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
              turnStateMap.set(k, v as TurnState)
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
                turnStateMap.set(k, v as TurnState)
            }
            broadcast('turns:state', Object.fromEntries(turnStateMap))
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
            turnStateMap.set(k, v as TurnState)
        }
        broadcast('turns:state', Object.fromEntries(turnStateMap))
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
      threadActivityTracker.setBusyThreadId(event.threadId)
    }
    if (
      (event.type === 'turn.completed' ||
        event.type === 'turn.interrupted' ||
        event.type === 'turn.aborted') &&
      event.threadId
    ) {
      // Do not derive thread-list state from the parent turn alone: background
      // subagents may still own work. The preceding daemon activity event is authoritative.
      if (threadActivityTracker.getBusyThreadId() === event.threadId) {
        threadActivityTracker.setBusyThreadId(null)
      }
    }
  })

  guiMms.on('resnapshot', async () => {
    const activeId = presentation.getActiveThreadId()
    if (!activeId || !guiMms.connected) return
    try {
      const snap = await guiMms.snapshotThread(activeId)
      const full = snap as {
        agents?: unknown[]
        tasks?: unknown[]
        pendingQuestions?: Array<{ requestId: string; questions: unknown }>
      }
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
    const targetThreadId = threadId ?? presentation.getActiveThreadId()
    if (!targetThreadId) throw new Error('No thread selected')
    threadActivityTracker.setBusyThreadId(targetThreadId)
    setThreadActivity(targetThreadId, 'processing')
    const body = normalizeSendContent(request)
    try {
      const result = await guiMms.request<{ queued?: boolean; message?: string }>(
        'orchestrator.send',
        {
          threadId: targetThreadId,
          content: body.content,
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
      threadActivityTracker.setBusyThreadId(null)
      throw err
    }
  }

  registerHandler('orchestrator:send', async (_e, request: OrchestratorSendInput) =>
    runSend(request, presentation.getActiveThreadId())
  )
  registerHandler(
    'orchestrator:sendToThread',
    async (_e, threadId: string, request: OrchestratorSendInput) => runSend(request, threadId)
  )

  registerHandler('orchestrator:getMessages', async (_e, threadId?: string) => {
    const id = threadId ?? presentation.getActiveThreadId()
    if (!id) return []
    const snap = await guiMms.snapshotThread(id)
    return snap.messages
  })

  registerHandler(
    'orchestrator:getContextUsage',
    async (_e, request?: OrchestratorContextUsageInput) => {
      const threadId = presentation.getActiveThreadId()
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
      const busy = threadActivityTracker.getBusyThreadId()
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
    const id = threadId ?? presentation.getActiveThreadId()
    if (!id) return false
    const res = await guiMms.request<{ ok: boolean }>('orchestrator.abort', { threadId: id })
    return res.ok
  })

  registerHandler('orchestrator:steer', async (_e, text: string, threadId?: string) => {
    const id = threadId ?? presentation.getActiveThreadId()
    if (!id) return false
    const res = await guiMms.request<{ ok: boolean }>('orchestrator.steer', {
      threadId: id,
      text: String(text ?? ''),
      source: 'gui-steer'
    })
    return res.ok
  })

  registerHandler('orchestrator:isTurnActive', async (_e, threadId?: string) => {
    const id = threadId ?? presentation.getActiveThreadId()
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
      threadId: threadId ?? presentation.getActiveThreadId() ?? undefined
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
  registerHandler('threads:purge', async (_e, threadId: string) =>
    guiMms.request('threads.purge', { threadId })
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
  registerHandler('threads:active', () => presentation.getActiveThreadId())
  registerHandler('threads:activity', () => threadActivityTracker.getSnapshot())

  /** Monotonic generation so rapid switches drop stale snapshot replies. */
  let selectGeneration = 0

  const selectThread = async (threadId: string): Promise<void> => {
    const gen = ++selectGeneration
    presentation.setActiveThreadId(threadId)
    // Publish selection immediately so the sidebar/highlight updates before the
    // (potentially large) thread.snapshot round-trip completes.
    broadcast('thread:selected', { id: threadId })

    // A completed state is an unread-style notification. Viewing the thread
    // acknowledges it, while processing and awaiting-input states remain visible.
    if (threadActivityTracker.getState(threadId) === 'completed') {
      setThreadActivity(threadId, 'idle')
    }

    const snap = await guiMms.snapshotThread(threadId)
    // A newer select won the race — discard this snapshot.
    if (gen !== selectGeneration || presentation.getActiveThreadId() !== threadId) {
      return
    }

    const full = snap as {
      activity?: import('../../shared/types').ThreadActivityState
      agents?: unknown[]
      tasks?: unknown[]
      pendingQuestions?: Array<{ requestId: string; questions: unknown }>
    }
    // The runtime activity label is normally authoritative. During reconnects or
    // startup it can briefly lag the session snapshot, though; never clear a spinner
    // for a thread whose turn is still active.
    // Selecting a thread must not reset an activity state already tracked for it. The
    // snapshot only fills in a state when this GUI has not observed that thread yet;
    // otherwise an older/partial snapshot can dismiss its sidebar spinner.
    // Skip rebroadcasting the full activity map when we already track this thread —
    // that re-render used to hitch every switch even for idle chats.
    if (threadActivityTracker.getState(threadId) === undefined) {
      const hasPendingWork =
        snap.activeTurn.active ||
        snap.activeTurn.running ||
        snap.queue.length > 0 ||
        snap.claimed.length > 0
      const activity = full.activity && full.activity !== 'idle'
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

  registerHandler('threads:create', async (_e, name?: string, projectId?: string) => {
    const res = await guiMms.request<{ thread: unknown; threads: unknown[] }>(
      'threads.create',
      { name: name?.trim() || 'New Chat', projectId }
    )
    broadcast('threads:updated', res.threads)
    return res.thread
  })

  registerHandler(
    'threads:createAndSelect',
    async (_e, name?: string, projectId?: string) => {
      const res = await guiMms.request<{ thread: { id: string }; threads: unknown[] }>(
        'threads.create',
        { name: name?.trim() || 'New Chat', projectId }
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
    if (presentation.getActiveThreadId() === threadId) {
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

  registerHandler('agents:list', async () => {
    const threadId = presentation.getActiveThreadId()
    if (!threadId) return []
    const res = await guiMms.request<{ agents: unknown[] }>('agents.list', { threadId })
    return res.agents
  })
  registerHandler('agents:stop', async (_e, agentId: string) => {
    const threadId = presentation.getActiveThreadId()
    if (!threadId) throw new Error('No active thread')
    const res = await guiMms.request<{ logs: string[] }>('agents.stop', { threadId, agentId })
    return res.logs
  })
  registerHandler('tasks:list', async () => {
    const threadId = presentation.getActiveThreadId()
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
      const threadId = presentation.getActiveThreadId()
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
      const threadId = presentation.getActiveThreadId()
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
    const threadId = presentation.getActiveThreadId()
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
  registerHandler('mousseAgent:retryConnection', async (_e, agentId: string) => {
    const threadId = presentation.getActiveThreadId()
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
      const threadId = presentation.getActiveThreadId()
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
    const threadId = presentation.getActiveThreadId() ?? undefined
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
      const threadId = presentation.getActiveThreadId()
      if (!threadId) throw new Error('No thread selected')
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

  registerHandler('skills:list', async (_e, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ snapshot: unknown }>('skills.list', { projectPath })
    return res.snapshot
  })
  registerHandler('skills:read', async (_e, skillId: string, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ result: unknown }>('skills.read', {
      skillId,
      projectPath
    })
    return res.result
  })
  registerHandler('skills:refresh', async (_e, projectId?: string) => {
    const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
    const res = await guiMms.request<{ snapshot: unknown }>('skills.refresh', {
      projectPath
    })
    broadcast('skills:changed', res.snapshot)
    return res.snapshot
  })
  registerHandler(
    'skills:openFolder',
    async (_e, scope: 'global' | 'project', projectId?: string) => {
      const projectPath = projectId ? await resolveProjectPath(projectId) : undefined
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

  registerHandler('app:getActiveProjectPath', async (_e, threadId?: string | null) => {
    const id = threadId ?? presentation.getActiveThreadId()
    return (await resolveProjectPath(undefined, id)) ?? null
  })

  registerHandler('app:getFilesRoot', async (_e, threadId?: string | null) => {
    const id = threadId ?? presentation.getActiveThreadId()
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
    'fs:writeFile',
    async (
      _e,
      filePath: string,
      content: string,
      projectId?: string,
      threadId?: string | null
    ) => {
      const lines = await fileService.writeFile(
        await resolveFilesRoot(projectId, threadId),
        filePath,
        content
      )
      lineEditStats.record('manual', lines)
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

  registerHandler('browser:navigate', (_e, url: string) => {
    browserView.navigate(url)
    return browserView.getState()
  })
  registerHandler('browser:goBack', () => {
    browserView.goBack()
    return browserView.getState()
  })
  registerHandler('browser:goForward', () => {
    browserView.goForward()
    return browserView.getState()
  })
  registerHandler('browser:reload', () => {
    browserView.reload()
    return browserView.getState()
  })
  registerHandler('browser:getState', () => browserView.getState())
  registerHandler('browser:clearCookies', async () => {
    await session.fromPartition(MOUSSE_BROWSER_PARTITION).clearStorageData({
      storages: ['cookies']
    })
  })
  registerHandler('browser:clearCache', async () => {
    await session.fromPartition(MOUSSE_BROWSER_PARTITION).clearCache()
  })
  registerHandler('browser:setVisible', (_e, visible: boolean) => {
    browserView.setVisible(visible)
  })
  registerHandler('browser:setBounds', (_e, bounds: BrowserBounds) => {
    browserView.setBounds(bounds)
  })

  // Daemon-owned settings/providers — chrome cache is updated from protocol only.
  registerHandler('settings:get', async () => {
    const res = await guiMms.request<{ settings: MousseSettings }>('settings.get')
    try {
      settings.set(res.settings)
    } catch {
      /* chrome mirror best-effort */
    }
    return res.settings
  })
  registerHandler('settings:set', async (_e, partial: MousseSettingsUpdate) => {
    const res = await guiMms.request<{ settings: MousseSettings }>('settings.set', {
      partial
    })
    try {
      settings.set(res.settings)
    } catch {
      /* ignore */
    }
    applyWindowAccentBackground(getWindow(), res.settings)
    broadcast('settings:changed', res.settings)
    return res.settings
  })
  registerHandler('settings:getOptions', async () => {
    const res = await guiMms.request<{ options: unknown }>('settings.getOptions')
    return res.options
  })

  registerHandler('lineEdits:getStats', () => lineEditStats.getSnapshot())
  lineEditStats.on('updated', (snapshot) => broadcast('lineEdits:updated', snapshot))

  registerHandler('providers:listConfigured', async () => {
    const res = await guiMms.request<{ providers: unknown[] }>('providers.listConfigured')
    return res.providers
  })
  registerHandler('providers:getUsage', async () =>
    guiMms.request('providers.getUsage')
  )
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

  void shell
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
  broadcast: (channel: string, data: unknown) => void
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
  const bootFull = snap as { agents?: unknown[]; tasks?: unknown[] }
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
  broadcast('thread:selected', { id: activeId })
}
