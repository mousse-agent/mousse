import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProtocolEvent } from '../src/mms/protocol'
import type { Thread, TurnState } from '../src/shared/types'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
const sent = vi.hoisted(() => [] as Array<{ channel: string; data: unknown }>)
const listeners = vi.hoisted(() => new Map<string, Set<(...args: unknown[]) => void>>())
const WINDOW_ID = 42
const PROFILE = 'prf_perf'

const mockWin = vi.hoisted(() => ({
  isDestroyed: () => false,
  isFocused: () => true,
  isMinimized: () => false,
  on: () => undefined,
  webContents: {
    id: 42,
    send: (channel: string, data: unknown) => { sent.push({ channel, data }) },
    on: () => undefined
  }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [mockWin] },
  Notification: class { static isSupported() { return false } },
  app: { getPath: () => '', getVersion: () => '0.0.0', on: () => undefined },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeTheme: { on: () => undefined },
  screen: { on: () => undefined, getAllDisplays: () => [] },
  session: {},
  webContents: {}
}))

import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'

const inert = (base: object = {}): object =>
  new Proxy(base, { get: (target, key) => (key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined) })

const guiMms = {
  on: (name: string, fn: (...args: unknown[]) => void) => {
    let set = listeners.get(name)
    if (!set) listeners.set(name, (set = new Set()))
    set.add(fn)
  },
  off: (name: string, fn: (...args: unknown[]) => void) => { listeners.get(name)?.delete(fn) },
  request: vi.fn(async () => ({})),
  supports: async () => true,
  snapshotThread: vi.fn(async () => ({ messages: [], queue: [], claimed: [], activeTurn: { active: false, running: false }, connectionFailed: false })),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => WINDOW_ID,
  getWindowBindingForSender: (senderId: number) => (senderId === WINDOW_ID ? { profileId: PROFILE, epoch: 1 } : undefined),
  getBaseBinding: () => ({ profileId: PROFILE, epoch: 1 })
}

let seq = 0
function pushWindowEvent(type: string, data: unknown, threadId?: string): void {
  seq += 1
  const event: ProtocolEvent = {
    kind: 'event',
    sequence: seq,
    type,
    threadId,
    profileId: PROFILE,
    data,
    ts: new Date().toISOString()
  }
  for (const fn of listeners.get('window-event') ?? []) fn({ senderId: WINDOW_ID, event, instance: 'inst-1' })
}

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler({ sender: { id: WINDOW_ID } }, ...args))
}

const at = '2026-11-25T05:00:00.000Z'
const makeThread = (id: string, extra: Partial<Thread> = {}): Thread => ({
  id,
  name: id,
  createdAt: at,
  updatedAt: at,
  order: 0,
  ...extra
} as Thread)

const msg = (id: string, content: string) => ({ id, role: 'assistant', content, timestamp: at, streaming: true })

beforeAll(() => {
  registerGuiIpc(
    { guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert({ get: () => ({ notifications: {} }) }), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices,
    () => mockWin as never
  )
})

beforeEach(async () => {
  sent.length = 0
  await invoke('threads:select', 'selected-1')
  pushWindowEvent('threads.updated', {
    threads: [
      makeThread('selected-1'),
      makeThread('parent-1'),
      makeThread('sub-1', { lineage: { parentThreadId: 'parent-1', rootThreadId: 'parent-1', relationship: 'subagent', depth: 1 } }),
      makeThread('bg-1'),
      makeThread('side-1', { lineage: { parentThreadId: 'selected-1', rootThreadId: 'selected-1', relationship: 'side', depth: 1 } })
    ]
  })
  sent.length = 0
})

describe('background subagent and thread IPC filtering in main', () => {
  it('drops streaming transcript updates for unselected subagents and background threads, while forwarding selected, side-chat, bot, and replace updates', () => {
    pushWindowEvent('thread.message', { message: msg('m1', 'subagent new') }, 'sub-1')
    pushWindowEvent('thread.message-updated', { message: msg('m1', 'subagent delta') }, 'sub-1')
    pushWindowEvent('thread.messages', { messages: [msg('m1', 'subagent list')] }, 'sub-1')
    pushWindowEvent('thread.message-updated', { message: msg('m2', 'bg delta') }, 'bg-1')

    expect(sent).toEqual([])

    pushWindowEvent('thread.message-updated', { message: msg('m3', 'selected delta') }, 'selected-1')
    pushWindowEvent('thread.message-updated', { message: msg('m4', 'side chat delta') }, 'side-1')
    pushWindowEvent('thread.message-updated', { message: msg('m5', 'unlisted bot delta') }, 'bot-home-1')
    pushWindowEvent('thread.messages', { messages: [msg('m6', 'bg undo')], replace: true }, 'bg-1')

    expect(sent.map((entry) => [entry.channel, (entry.data as { threadId?: string }).threadId])).toEqual([
      ['orchestrator:thread-message-updated', 'selected-1'],
      ['orchestrator:thread-message-updated', 'side-1'],
      ['orchestrator:thread-message-updated', 'bot-home-1'],
      ['orchestrator:thread-messages', 'bg-1']
    ])
  })

  it('broadcasts turn.state and activity once per event without duplicating through bridgeProtocolEvent', () => {
    const state: TurnState = { threadId: 'sub-1', turnId: 'run:1', phase: 'streaming', startedAt: at, updatedAt: at }
    pushWindowEvent('turn.state', state, 'sub-1')

    expect(sent.filter((entry) => entry.channel === 'orchestrator:turn-state')).toHaveLength(1)

    sent.length = 0
    pushWindowEvent('activity', { state: 'processing', activity: { 'sub-1': 'processing' } }, 'sub-1')
    // routeWindowState handles both single-thread state and full snapshot; bridgeProtocolEvent must not emit a third time.
    expect(sent.filter((entry) => entry.channel === 'threads:activity').length).toBeLessThanOrEqual(2)
  })
})
