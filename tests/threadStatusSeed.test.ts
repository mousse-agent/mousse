import { EventEmitter } from 'node:events'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A window's thread statuses (the sidebar's Working, Done, Input and Waiting icons) come from the
// service's status of every thread. The events a window replays when it connects are a bounded ring,
// so they often no longer hold that status: the window must read it, not wait for the next change.

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const windows = vi.hoisted(() => [] as Array<{ isDestroyed: () => boolean; webContents: { id: number; send: (channel: string, data: unknown) => void } }>)

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => windows },
  Notification: class {},
  app: { getPath: () => '', getVersion: () => '0.0.0', on: () => undefined },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeTheme: { on: () => undefined },
  session: {},
  webContents: {}
}))

import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
import type { ProtocolEvent } from '../src/mms/protocol/types'
import type { ThreadActivitySnapshot } from '../src/shared/types'

const WINDOW = 7
/** A second window, which has a thread open. */
const OPEN_WINDOW = 8
let currentSender: number | null = null
/** What the service says every thread is doing. */
let serviceActivity: ThreadActivitySnapshot = {}
const activityReads: Array<{ senderId?: number; clearsGap?: boolean }> = []

const presentation = new PresentationState()
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })
const guiMms = Object.assign(new EventEmitter(), {
  request: vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'activity.snapshot') {
      activityReads.push({})
      return { activity: { ...serviceActivity } }
    }
    return {}
  }),
  activityForSender: vi.fn(async (senderId: number, clearsGap?: boolean): Promise<ThreadActivitySnapshot> => {
    activityReads.push({ senderId, clearsGap })
    return { ...serviceActivity }
  }),
  snapshotThread: vi.fn(async () => ({ messages: [], queue: [], claimed: [], activeTurn: { active: false, running: false }, connectionFailed: false })),
  snapshotThreadForSender: vi.fn(async () => ({ messages: [], queue: [], claimed: [], activeTurn: { active: false, running: false }, connectionFailed: false })),
  // The open thread's turn, read without its transcript after a gap in live events.
  turnStatusForSender: vi.fn(async () => ({ activeTurn: { active: false, running: false }, behind: false })),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => currentSender,
  getWindowBindingForSender: (senderId: number) => (senderId === WINDOW || senderId === OPEN_WINDOW ? { profileId: 'default', epoch: 1 } : undefined),
  getBaseBinding: () => undefined
})

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler({ sender: { id: WINDOW } }, ...args))
}

let received: Array<{ channel: string; data: unknown }> = []
const lastActivitySent = (): unknown => received.filter((message) => message.channel === 'threads:activity').at(-1)?.data

const windowEvent = (type: string, data: unknown, threadId?: string): void => {
  const event: ProtocolEvent = { kind: 'event', sequence: 1, type, data, profileId: 'default', ts: new Date().toISOString(), ...(threadId ? { threadId } : {}) }
  guiMms.emit('window-event', { senderId: WINDOW, event, replay: false })
}

beforeAll(() => {
  registerGuiIpc({ guiMms: inert(guiMms), presentation, settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
})
beforeEach(() => {
  serviceActivity = {}
  activityReads.length = 0
  received = []
  windows.length = 0
  for (const id of [WINDOW, OPEN_WINDOW]) windows.push({ isDestroyed: () => false, webContents: { id, send: (channel, data) => { received.push({ channel, data }) } } })
  presentation.setActiveThreadId(null)
  // Forget what earlier tests told the tracker.
  windowEvent('activity.snapshot', { activity: {} })
  received = []
})

describe('a window shows the status of every thread', () => {
  it('reads it from the service when it opens, though no status changed since', async () => {
    // Threads that finished, or still work, before this window connected; the replayed events held no status.
    serviceActivity = { finished: 'completed', working: 'processing', asks: 'awaiting_input', quiet: 'idle' }
    expect(await invoke('threads:activity')).toEqual({ finished: 'completed', working: 'processing', asks: 'awaiting_input' })
  })

  it('keeps what the events said when the service cannot be read', async () => {
    windowEvent('activity.snapshot', { activity: { finished: 'completed' } })
    guiMms.request.mockRejectedValueOnce(new Error('not connected'))
    expect(await invoke('threads:activity')).toEqual({ finished: 'completed' })
  })

  it('reads it again after the window missed events, with no thread open', async () => {
    serviceActivity = { finished: 'completed' }
    guiMms.emit('window-resnapshot', { senderId: WINDOW })
    await vi.waitFor(() => expect(lastActivitySent()).toEqual({ finished: 'completed' }))
    // With nothing open there is no thread to read, so this read ends the gap.
    expect(activityReads).toEqual([{ senderId: WINDOW, clearsGap: true }])
  })

  it('reads it again after the window missed events, with a thread open', async () => {
    currentSender = OPEN_WINDOW
    try {
      await invoke('threads:select', 'open')
    } finally {
      currentSender = null
    }
    activityReads.length = 0
    serviceActivity = { other: 'completed', open: 'processing' }
    guiMms.emit('window-resnapshot', { senderId: OPEN_WINDOW })
    await vi.waitFor(() => expect(lastActivitySent()).toEqual({ other: 'completed', open: 'processing' }))
    // The open thread's status read ends the gap; its transcript is read again only if the window is behind.
    expect(activityReads).toEqual([{ senderId: OPEN_WINDOW, clearsGap: false }])
    await vi.waitFor(() => expect(guiMms.turnStatusForSender).toHaveBeenCalledWith(OPEN_WINDOW, 'open', true))
  })

  it('drops a status the service no longer has, after missed events', async () => {
    windowEvent('activity', { state: 'processing', activity: { stale: 'processing' } }, 'stale')
    expect(lastActivitySent()).toEqual({ stale: 'processing' })
    // The service restarted, or the turn ended while events were missed.
    serviceActivity = {}
    guiMms.emit('window-resnapshot', { senderId: WINDOW })
    await vi.waitFor(() => expect(lastActivitySent()).toEqual({}))
  })
})
