/**
 * A window always catches up with the service (#1042). Main reads a thread again the way opening it does when the
 * window missed updates (a gap, a connection opened again, an update it could not hand over) or when a turn that looks
 * active there goes quiet, and checks it when the window shows again or its renderer or graphics process is replaced.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const sent = vi.hoisted(() => [] as Array<{ channel: string; data: unknown }>)
const appEvents = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>())
const windows = vi.hoisted(() => [] as unknown[])

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => windows },
  Notification: Object.assign(class { on() { return this } show() { return undefined } }, { isSupported: () => false }),
  app: {
    getPath: () => '',
    getVersion: () => '0.0.0',
    on: (event: string, listener: (...args: unknown[]) => void) => { appEvents.set(event, [...(appEvents.get(event) ?? []), listener]) }
  },
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
import type { ChatMessage, ThreadActivitySnapshot, TurnState } from '../src/shared/types'
import { useAppStore } from '../src/renderer/stores/appStore'

const WINDOW = 7
const PROFILE = 'profile-1'
const REPLY_TEXT = 'the secret reply text'

// The window: a BrowserWindow with its webContents, both able to raise events.
const win = Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  isFocused: () => true,
  isMinimized: () => false,
  webContents: Object.assign(new EventEmitter(), {
    id: WINDOW,
    isDestroyed: () => false,
    send: (channel: string, data: unknown) => void sent.push({ channel, data })
  })
})
windows.push(win)

// The service: what it really has for thread t1.
const at = (second: number): string => `2026-11-13T10:00:${String(second).padStart(2, '0')}.000Z`
const message = (id: string, role: 'user' | 'assistant', content: string, second: number): ChatMessage =>
  ({ id, role, content, timestamp: at(second) }) as ChatMessage
const idle: TurnState = { threadId: 't1', turnId: 'run:1', phase: 'completed', updatedAt: at(1) }
const service = {
  turn: idle as TurnState,
  activity: {} as ThreadActivitySnapshot,
  messages: [message('u1', 'user', 'first question', 0), message('a1', 'assistant', 'first answer', 1)],
  revision: 10
}
const snapshot = () => ({
  messages: [...service.messages],
  queue: [],
  claimed: [],
  activeTurn: { active: service.turn.phase === 'thinking', running: service.turn.phase === 'thinking' },
  turnState: service.turn,
  connectionFailed: false,
  revision: service.revision
})

// Like the controller, a read that answers the gap clears the window connection's gap flag as it starts.
async function statusAnswer(_senderId: number, _threadId: string, clearsGap?: boolean) {
  if (clearsGap) gapFlag = false
  return { turnState: service.turn, activeTurn: snapshot().activeTurn, activity: service.activity.t1 ?? 'idle', revision: service.revision }
}

const listeners = new Map<string, Array<(payload: unknown) => void>>()
let binding: { profileId: string; epoch: number } | null = { profileId: PROFILE, epoch: 1 }
let profileChanging = false
let eventsReceived = 10
// The window connection's gap flag: while it is set, the controller reports a gap on every update it receives.
let gapFlag = false
// The window's lists as the service has them.
const lists = { projects: [{ id: 'p1', name: 'Project' }], threads: [{ id: 't1', name: 'Thread' }] }
const guiMms = {
  on: (event: string, listener: (payload: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
  },
  request: vi.fn(async (method: string) => method === 'projects.list' ? { projects: lists.projects } : method === 'threads.list' ? { threads: lists.threads } : {}),
  snapshotThread: vi.fn(async () => snapshot()),
  snapshotThreadForSender: vi.fn(async () => snapshot()),
  // Every answer says the event number at which the service read (`revision`).
  activityForSender: vi.fn(async () => ({ activity: { ...service.activity }, revision: service.revision })),
  turnStatusForSender: vi.fn(statusAnswer),
  prepareWindow: vi.fn(async () => binding),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => WINDOW,
  getWindowBindingForSender: () => binding,
  isProfileChanging: () => profileChanging,
  notePersonInput: vi.fn(),
  getBaseBinding: () => undefined,
  // The base connection's own resnapshot is not what these tests follow.
  connected: false
}
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })
const logLines: Array<{ event: string; fields: Record<string, unknown> }> = []
const undelivered: Array<{ window: number; reason: string; type: string; threadId?: string }> = []
const connectionLog = {
  write: (event: string, fields: Record<string, unknown> = {}) => void logLines.push({ event, fields }),
  undeliverable: (window: number, reason: string, type: string, threadId?: string) => void undelivered.push({ window, reason, type, threadId })
}

/** The service pushes an update to the window's connection. */
function push(type: string, data: unknown, threadId: string | undefined = 't1'): void {
  eventsReceived += 1
  service.revision = Math.max(service.revision, eventsReceived)
  const event = { kind: 'event', sequence: eventsReceived, type, threadId, profileId: PROFILE, data, ts: at(0) } as ProtocolEvent
  for (const listener of listeners.get('window-event') ?? []) listener({ senderId: WINDOW, event })
  if (gapFlag) liveGap()
}
/** The controller reports a gap in live events (a waiting update was replaced by its newer copy). */
function liveGap(): void {
  gapFlag = true
  for (const listener of listeners.get('window-resnapshot') ?? []) listener({ senderId: WINDOW })
}
/** The service changes without the window hearing of it: the update is dropped on purpose. */
function dropped(): void {
  service.revision += 1
}
const ofChannel = <T,>(channel: string): T[] => sent.filter((entry) => entry.channel === channel).map((entry) => entry.data as T)
const listReads = () => guiMms.request.mock.calls.map(([method]) => method).filter((method) => method === 'projects.list' || method === 'threads.list')
const views = () => ofChannel<{ threadId: string; messages: ChatMessage[] }>('thread:view')
const lastTurn = () => ofChannel<TurnState>('orchestrator:turn-state').at(-1)
const lastActivity = () => ofChannel<ThreadActivitySnapshot>('threads:activity').at(-1)

/** A turn starts and streams its first second, as the window sees it. */
function startTurn(): TurnState {
  const running: TurnState = { threadId: 't1', turnId: 'run:2', phase: 'thinking', startedAt: at(2), updatedAt: at(2) }
  service.turn = running
  service.activity = { t1: 'processing' }
  service.messages.push(message('u2', 'user', 'second question', 2))
  push('activity', { state: 'processing' })
  push('turn.state', running)
  push('thread.message', { message: service.messages.at(-1) })
  push('thread.message-updated', { message: message('a2', 'assistant', 'partial', 3) })
  return running
}
/** The turn ends in the service: its reply saved, its turn and activity finished. The window is told nothing. */
function finishTurnSilently(): void {
  service.messages.push(message('a2', 'assistant', REPLY_TEXT, 4))
  service.turn = { threadId: 't1', turnId: 'run:2', phase: 'completed', startedAt: at(2), updatedAt: at(4) }
  service.activity = { t1: 'completed' }
  dropped() // turn.state completed
  dropped() // thread.message-updated with the whole reply
  dropped() // activity completed
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  vi.setSystemTime(new Date('2026-11-13T10:00:05.000Z'))
  registerGuiIpc({
    guiMms: inert(guiMms),
    presentation: new PresentationState(),
    settings: inert({ get: () => ({ notifications: {} }) }),
    browserView: inert(),
    repoRoot: '',
    connectionLog
  } as unknown as GuiIpcServices, () => null)
  await handlers.get('threads:select')!({ sender: { id: WINDOW } }, 't1')
})
afterAll(() => {
  vi.useRealTimers()
})

beforeEach(async () => {
  // Each test starts from a finished turn the window knows about.
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  service.turn = idle
  service.activity = {}
  service.messages = service.messages.slice(0, 2)
  binding = { profileId: PROFILE, epoch: 1 }
  profileChanging = false
  gapFlag = false
  push('activity', { state: 'idle' })
  push('turn.state', idle)
  service.revision = eventsReceived
  await vi.advanceTimersByTimeAsync(0)
  sent.length = 0
  logLines.length = 0
  undelivered.length = 0
  vi.clearAllMocks()
})

describe('a window that missed the end of a turn', () => {
  it('shows the reply and the finished turn by itself within 30 seconds when the "turn finished" update is dropped', async () => {
    startTurn()
    finishTurnSilently()
    expect(lastTurn()?.phase).toBe('thinking')
    expect(lastActivity()).toMatchObject({ t1: 'processing' })

    await vi.advanceTimersByTimeAsync(29_000)
    expect(views()).toEqual([])
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(views()).toHaveLength(1))

    // The reply, from the same read opening the thread uses.
    expect(views()[0].messages.map((entry) => entry.id)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(views()[0].messages.at(-1)?.content).toBe(REPLY_TEXT)
    // The turn reads finished; the sidebar's Working mark is gone and its Done mark is the service's.
    expect(lastTurn()).toMatchObject({ threadId: 't1', phase: 'completed' })
    expect(lastActivity()).toEqual({ t1: 'completed' })
    // The view comes before the turn's end, so the turn never shows ended without its reply.
    const order = sent.map((entry) => entry.channel)
    expect(order.lastIndexOf('thread:view')).toBeLessThan(order.lastIndexOf('orchestrator:turn-state'))
  })

  it('logs the check and the catch-up: which thread, why and what changed, with no conversation text', async () => {
    startTurn()
    finishTurnSilently()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.waitFor(() => expect(logLines.some((line) => line.event === 'catch-up')).toBe(true))
    expect(logLines.find((line) => line.event === 'check.behind')?.fields).toMatchObject({ window: WINDOW, thread: 't1', reasons: ['quiet'] })
    expect(logLines.find((line) => line.event === 'check.behind')?.fields.found).toEqual(['turn-differs', 'ended'])
    expect(logLines.find((line) => line.event === 'catch-up')?.fields).toMatchObject({
      window: WINDOW,
      thread: 't1',
      reasons: ['quiet'],
      turn: 'thinking→completed',
      activity: 'processing→completed',
      changed: expect.arrayContaining(['turn']),
      messages: 4
    })
    const written = JSON.stringify(logLines)
    expect(written).not.toContain(REPLY_TEXT)
    expect(written).not.toContain('second question')
  })

  it('a gap found while subscribing (the replay lost events) reads the thread at once, with its transcript', async () => {
    startTurn()
    finishTurnSilently()
    for (const listener of listeners.get('window-resnapshot') ?? []) listener({ senderId: WINDOW, subscribed: true })
    await vi.waitFor(() => expect(views()).toHaveLength(1))
    expect(guiMms.turnStatusForSender).not.toHaveBeenCalled()
    expect(views()[0].messages.at(-1)?.content).toBe(REPLY_TEXT)
    expect(lastTurn()?.phase).toBe('completed')
    expect(logLines.find((line) => line.event === 'catch-up')?.fields.reasons).toEqual(['gap'])
  })

  it('a gap in live events that lost the end of the turn is found by the status read at once and read in full', async () => {
    startTurn()
    finishTurnSilently()
    for (const listener of listeners.get('window-resnapshot') ?? []) listener({ senderId: WINDOW })
    await vi.waitFor(() => expect(views()).toHaveLength(1))
    // The status read answers the gap flag.
    expect(guiMms.turnStatusForSender).toHaveBeenCalledWith(WINDOW, 't1', true)
    expect(views()[0].messages.at(-1)?.content).toBe(REPLY_TEXT)
    expect(lastTurn()?.phase).toBe('completed')
    expect(logLines.find((line) => line.event === 'check.behind')?.fields.reasons).toEqual(['gap'])
    // A live gap only replaced updates with their newer copies: the lists lost nothing and are not read again.
    await vi.waitFor(() => expect(logLines.some((line) => line.event === 'catch-up')).toBe(true))
    expect(listReads()).toEqual([])
    expect(ofChannel('projects:updated')).toEqual([])
    expect(ofChannel('threads:updated')).toEqual([])
    expect(ofChannel('bots:changed')).toEqual([])
    expect(ofChannel('chats:changed')).toEqual([])
  })

  it('a live gap is checked once, though updates keep arriving while the statuses are read', async () => {
    startTurn()
    let release!: () => void
    guiMms.activityForSender.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { activity: { ...service.activity }, revision: service.revision }
    })
    liveGap()
    await vi.waitFor(() => expect(guiMms.activityForSender).toHaveBeenCalled())
    for (let i = 0; i < 3; i += 1) push('thread.message-updated', { message: message('a2', 'assistant', `partial ${i}`, 3) })
    release()
    await vi.waitFor(() => expect(guiMms.turnStatusForSender).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(0)
    expect(guiMms.turnStatusForSender).toHaveBeenCalledTimes(1)
    expect(guiMms.activityForSender).toHaveBeenCalledTimes(1)
  })

  it('a gap in live events that lost nothing (a streamed update replaced by its newer copy) sends nothing and reads no transcript', async () => {
    startTurn()
    sent.length = 0
    for (let i = 0; i < 5; i += 1) {
      push('thread.message-updated', { message: message('a2', 'assistant', `partial ${i}`, 3) })
      for (const listener of listeners.get('window-resnapshot') ?? []) listener({ senderId: WINDOW })
    }
    await vi.waitFor(() => expect(guiMms.turnStatusForSender).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(0)
    expect(guiMms.snapshotThreadForSender).not.toHaveBeenCalled()
    expect(views()).toEqual([])
    expect(ofChannel('orchestrator:turn-state')).toEqual([])
    // A burst of gaps is at most one read running and one after it.
    expect((guiMms.turnStatusForSender as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(2)
  })

  it("a window whose own connection was opened again reads its thread, and its lists and bot chats again", async () => {
    startTurn()
    finishTurnSilently()
    for (const listener of listeners.get('window-session-reopened') ?? []) listener({ senderId: WINDOW })
    await vi.waitFor(() => expect(views()).toHaveLength(1))
    expect(lastTurn()?.phase).toBe('completed')
    await vi.waitFor(() => expect(logLines.find((line) => line.event === 'catch-up')?.fields.reasons).toEqual(['reconnected']))
    // A restarted service replays only what it sent since it started: the sidebar and the bot chats read again.
    expect(ofChannel('projects:updated').at(-1)).toEqual(lists.projects)
    expect(ofChannel('threads:updated').at(-1)).toEqual(lists.threads)
    expect(ofChannel('bots:changed').at(-1)).toEqual({ reread: true })
    expect(ofChannel('chats:changed')).toHaveLength(1)
    expect(logLines.find((line) => line.event === 'catch-up')?.fields.changed).toEqual(expect.arrayContaining(['lists']))
  })

  it('a catch-up asked while the window\'s connection is down waits for its reopening and never opens it itself', async () => {
    startTurn()
    finishTurnSilently()
    binding = null
    for (const listener of listeners.get('window-resnapshot') ?? []) listener({ senderId: WINDOW, subscribed: true })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(guiMms.prepareWindow).not.toHaveBeenCalled()
    expect(views()).toEqual([])
    expect(logLines.filter((line) => line.event === 'catch-up.waiting')).toHaveLength(1)
    binding = { profileId: PROFILE, epoch: 1 }
    for (const listener of listeners.get('window-session-reopened') ?? []) listener({ senderId: WINDOW })
    await vi.waitFor(() => expect(lastTurn()?.phase).toBe('completed'))
    await vi.waitFor(() => expect(logLines.find((line) => line.event === 'catch-up')?.fields.reasons).toEqual(['gap', 'reconnected']))
  })

  it('an update main could not hand over (the connection changing) is logged and followed by a catch-up', async () => {
    startTurn()
    binding = null
    push('turn.state', { threadId: 't1', turnId: 'run:2', phase: 'completed', updatedAt: at(4) })
    expect(undelivered).toEqual([{ window: WINDOW, reason: 'connection-changing', type: 'turn.state', threadId: 't1' }])
    finishTurnSilently()
    binding = { profileId: PROFILE, epoch: 1 }
    await vi.advanceTimersByTimeAsync(1_000)
    await vi.waitFor(() => expect(lastTurn()?.phase).toBe('completed'))
    expect(logLines.find((line) => line.event === 'catch-up')?.fields.reasons).toEqual(['undelivered'])
  })

  it("a catch-up asked before the window's first connection is dropped once that connection opens", async () => {
    binding = null
    push('turn.state', { threadId: 't1', turnId: 'run:1', phase: 'completed', updatedAt: at(1) })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(logLines.filter((line) => line.event === 'catch-up.waiting')).toHaveLength(1)
    binding = { profileId: PROFILE, epoch: 1 }
    // The window's first connection: the window reads everything as it starts.
    for (const listener of listeners.get('window-subscribed') ?? []) listener({ senderId: WINDOW, profileId: PROFILE, sequence: eventsReceived, how: 'opened' })
    for (const listener of listeners.get('window-session-reopened') ?? []) listener({ senderId: WINDOW })
    await vi.waitFor(() => expect(logLines.some((line) => line.event === 'catch-up')).toBe(true))
    expect(logLines.find((line) => line.event === 'catch-up')?.fields.reasons).toEqual(['reconnected'])
  })

  it('a profile switch is not a fault: the new profile\'s replay is neither logged as undelivered nor caught up', async () => {
    binding = null
    profileChanging = true
    push('threads.updated', { threads: [] }, undefined)
    push('activity', { state: 'idle' })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(undelivered).toEqual([])
    expect(guiMms.activityForSender).not.toHaveBeenCalled()
    expect(guiMms.snapshotThreadForSender).not.toHaveBeenCalled()
    expect(logLines).toEqual([])
  })
})

describe('an answer older than an update the window already has', () => {
  it('a "turn finished" update that arrived before an older status answer is not undone by it, nor read in full', async () => {
    startTurn()
    // The service read the turn while it ran (event 1 of the answer), then the turn ended and its update arrived first.
    const readAt = eventsReceived
    service.turn = { threadId: 't1', turnId: 'run:2', phase: 'completed', startedAt: at(2), updatedAt: at(4) }
    push('turn.state', service.turn)
    push('activity', { state: 'completed' })
    const running = { threadId: 't1', turnId: 'run:2', phase: 'thinking', startedAt: at(2), updatedAt: at(2) } as TurnState
    guiMms.turnStatusForSender.mockResolvedValueOnce({ turnState: running, activeTurn: { active: true, running: true }, activity: 'processing', revision: readAt })
    sent.length = 0
    win.emit('responsive')
    await vi.waitFor(() => expect(guiMms.turnStatusForSender).toHaveBeenCalled())
    await vi.advanceTimersByTimeAsync(0)
    expect(guiMms.snapshotThreadForSender).not.toHaveBeenCalled()
    expect(ofChannel('orchestrator:turn-state')).toEqual([])
    expect(logLines.filter((line) => line.event === 'check.behind')).toEqual([])
  })

  it('a full read whose answer is older keeps the turns the window already has, for its thread and for others', async () => {
    startTurn()
    push('turn.state', { threadId: 't2', turnId: 'run:9', phase: 'thinking', startedAt: at(2), updatedAt: at(2) }, 't2')
    const readAt = eventsReceived
    // Both turns end after the service read; their updates arrive before its answer.
    push('turn.state', { threadId: 't1', turnId: 'run:2', phase: 'completed', startedAt: at(2), updatedAt: at(4) })
    push('turn.state', { threadId: 't2', turnId: 'run:9', phase: 'completed', startedAt: at(2), updatedAt: at(4) }, 't2')
    const stale = {
      ...snapshot(),
      turnState: { threadId: 't1', turnId: 'run:2', phase: 'thinking', startedAt: at(2), updatedAt: at(2) },
      activeTurn: { active: true, running: true },
      turnSnapshot: { t2: { threadId: 't2', turnId: 'run:9', phase: 'thinking', startedAt: at(2), updatedAt: at(2) } },
      revision: readAt
    }
    guiMms.snapshotThreadForSender.mockResolvedValueOnce(stale)
    for (const listener of listeners.get('window-session-reopened') ?? []) listener({ senderId: WINDOW })
    await vi.waitFor(() => expect(views()).toHaveLength(1))
    await vi.waitFor(() => expect(logLines.some((line) => line.event === 'catch-up')).toBe(true))
    expect(lastTurn()).toMatchObject({ threadId: 't1', phase: 'completed' })
    const map = ofChannel<Record<string, TurnState>>('turns:state').at(-1)!
    expect(map.t1?.phase).toBe('completed')
    expect(map.t2?.phase).toBe('completed')
    expect(logLines.find((line) => line.event === 'catch-up')?.fields.kept).toEqual(['turn'])
  })
})

describe('the same check on other occasions', () => {
  const triggers: Array<[string, () => void, string]> = [
    ['the window is focused again', () => win.emit('focus'), 'focused'],
    ['the window is shown again', () => win.emit('show'), 'shown'],
    ['the window is restored', () => win.emit('restore'), 'restored'],
    ['the window answers again after hanging', () => { win.emit('unresponsive'); win.emit('responsive') }, 'responsive-again'],
    ['the graphics process is replaced', () => { for (const listener of appEvents.get('child-process-gone') ?? []) listener({}, { type: 'GPU', reason: 'killed', exitCode: 0 }) }, 'gpu-replaced'],
    ['the service connection is re-established', () => { for (const listener of listeners.get('resnapshot') ?? []) listener({ reason: 'reconnect:disconnect' }) }, 'service-reconnected']
  ]
  for (const [occasion, raise, reason] of triggers) {
    it(`${occasion}: a window behind the service catches up`, async () => {
      startTurn()
      finishTurnSilently()
      raise()
      await vi.waitFor(() => expect(lastTurn()?.phase).toBe('completed'))
      expect(views().at(-1)?.messages.at(-1)?.content).toBe(REPLY_TEXT)
      expect(logLines.find((line) => line.event === 'check.behind')?.fields.reasons).toEqual([reason])
    })
  }

  it('the renderer process is replaced: the new page is checked once it has loaded', async () => {
    startTurn()
    finishTurnSilently()
    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    win.webContents.emit('did-finish-load')
    expect(guiMms.turnStatusForSender).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(3_000)
    await vi.waitFor(() => expect(lastTurn()?.phase).toBe('completed'))
    expect(logLines.find((line) => line.event === 'renderer.gone')?.fields).toMatchObject({ window: WINDOW, reason: 'crashed' })
    expect(logLines.find((line) => line.event === 'check.behind')?.fields.reasons).toEqual(['renderer-replaced'])
  })

  it("tells main of the person's own keys and clicks, not of anything else the window receives", () => {
    win.webContents.emit('input-event', {}, { type: 'mouseMove' })
    expect(guiMms.notePersonInput).not.toHaveBeenCalled()
    win.webContents.emit('input-event', {}, { type: 'mouseDown' })
    win.webContents.emit('input-event', {}, { type: 'rawKeyDown' })
    expect(guiMms.notePersonInput).toHaveBeenCalledTimes(2)
    expect(guiMms.notePersonInput).toHaveBeenCalledWith(WINDOW)
  })

  it('a window that is current sends nothing when it is focused again', async () => {
    win.emit('focus')
    await vi.waitFor(() => expect(guiMms.turnStatusForSender).toHaveBeenCalledTimes(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toEqual([])
  })
})

describe('a thread with no turn that the window shows idle', () => {
  // The service stamps a thread with no turn with the time of each read (services before 0.1.4): its idle always
  // looked newer than the one the window holds.
  const idleNow = (): TurnState => ({ threadId: 't1', turnId: null, phase: 'idle', updatedAt: new Date().toISOString() })
  beforeEach(async () => {
    service.turn = idleNow()
    push('turn.state', service.turn)
    service.revision = eventsReceived
    await vi.advanceTimersByTimeAsync(10_000)
    guiMms.turnStatusForSender.mockImplementation(async (_senderId: number, _threadId: string, clearsGap?: boolean) => {
      if (clearsGap) gapFlag = false
      return { turnState: idleNow(), activeTurn: { active: false, running: false }, activity: 'idle', revision: service.revision }
    })
    sent.length = 0
    logLines.length = 0
  })
  afterAll(() => {
    guiMms.turnStatusForSender.mockImplementation(statusAnswer)
  })

  const occasions: Array<[string, () => void]> = [
    ['the window is focused again', () => win.emit('focus')],
    ['the window is restored', () => win.emit('restore')],
    ['a live gap', () => liveGap()]
  ]
  for (const [occasion, raise] of occasions) {
    it(`${occasion}: is not behind, so neither its transcript nor the lists are read again`, async () => {
      await vi.advanceTimersByTimeAsync(10_000)
      raise()
      await vi.waitFor(() => expect(guiMms.turnStatusForSender).toHaveBeenCalled())
      await vi.advanceTimersByTimeAsync(0)
      expect(guiMms.snapshotThreadForSender).not.toHaveBeenCalled()
      expect(listReads()).toEqual([])
      expect(views()).toEqual([])
      expect(ofChannel('projects:updated')).toEqual([])
      expect(logLines.filter((line) => line.event === 'check.behind' || line.event === 'catch-up')).toEqual([])
    })
  }

  it('a turn that started and ended while the window missed it is still caught', async () => {
    service.messages.push(message('u2', 'user', 'second question', 2), message('a2', 'assistant', REPLY_TEXT, 4))
    service.turn = { threadId: 't1', turnId: 'run:2', phase: 'completed', startedAt: at(2), updatedAt: new Date().toISOString() }
    dropped()
    guiMms.turnStatusForSender.mockImplementation(async () => ({ turnState: service.turn, activeTurn: { active: false, running: false }, activity: 'completed', revision: service.revision }))
    win.emit('focus')
    await vi.waitFor(() => expect(views()).toHaveLength(1))
    expect(views()[0].messages.at(-1)?.content).toBe(REPLY_TEXT)
    expect(lastTurn()).toMatchObject({ phase: 'completed', turnId: 'run:2' })
  })
})

describe('a long silent turn that is really running', () => {
  it('is left alone: a few status reads backing off, nothing sent to the window, no transcript read', async () => {
    const running = startTurn()
    sent.length = 0
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(guiMms.turnStatusForSender).toHaveBeenCalledTimes(4)
    expect(guiMms.snapshotThreadForSender).not.toHaveBeenCalled()
    expect(sent).toEqual([])
    expect(service.turn).toBe(running)
    expect(logLines.filter((line) => line.event === 'check.running')).toHaveLength(4)
  })

  it('an update in the meantime starts the wait again', async () => {
    startTurn()
    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(20_000)
      push('thread.message-updated', { message: message('a2', 'assistant', `partial ${i}`, 3) })
    }
    expect(guiMms.turnStatusForSender).not.toHaveBeenCalled()
  })
})

describe('the catch-up in the window', () => {
  it('adds the reply once, keeps every row once and leaves the composer draft alone', async () => {
    const store = useAppStore.getState()
    store.switchToThread('t1')
    store.applyThreadView({ threadId: 't1', messages: service.messages.slice(0, 2), agents: [], tasks: [] } as never)
    store.setComposerDraft('t1', 'a draft being written')
    startTurn()
    useAppStore.getState().applyThreadView({ threadId: 't1', messages: service.messages.slice(0, 3), agents: [], tasks: [] } as never)
    finishTurnSilently()
    for (const listener of listeners.get('window-resnapshot') ?? []) listener({ senderId: WINDOW })
    await vi.waitFor(() => expect(views()).toHaveLength(1))

    // The same view twice (a gap and a quiet check close together) still adds nothing twice.
    useAppStore.getState().applyThreadView(views()[0] as never)
    useAppStore.getState().applyThreadView(views()[0] as never)
    const ids = useAppStore.getState().messages.map((entry) => entry.id)
    expect(ids).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(new Set(ids).size).toBe(ids.length)
    expect(useAppStore.getState().composerDrafts.t1).toBe('a draft being written')
  })
})
