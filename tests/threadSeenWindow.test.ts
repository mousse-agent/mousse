import { EventEmitter } from 'node:events'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Done is "finished, and you haven't seen it". A window tells the service it has seen a thread when it opens
// it, when it comes into focus showing a Done thread, and when the thread it shows in focus finishes.

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const appListeners = vi.hoisted(() => new Map<string, (...args: unknown[]) => void>())
type FakeWindow = { isDestroyed: () => boolean; isFocused: () => boolean; webContents: { id: number; send: (channel: string, data: unknown) => void } }
const windows = vi.hoisted(() => [] as FakeWindow[])

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => windows },
  Notification: class {},
  app: { getPath: () => '', getVersion: () => '0.0.0', on: (name: string, listener: (...args: unknown[]) => void) => { appListeners.set(name, listener) } },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeTheme: { on: () => undefined },
  session: {},
  webContents: {}
}))

import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { seenReporter, showsDone } from '../src/main/ipc/threadSeen'
import { PresentationState } from '../src/main/mms/PresentationState'
import type { ProtocolEvent } from '../src/mms/protocol/types'

const WINDOW = 7
let focused = true
let currentSender: number | null = WINDOW
const seen: string[] = []

const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })
const guiMms = Object.assign(new EventEmitter(), {
  request: vi.fn(async (method: string, params?: { threadId?: string }): Promise<unknown> => {
    if (method === 'threads.markSeen' && params?.threadId) seen.push(params.threadId)
    return {}
  }),
  snapshotThread: vi.fn(async () => ({ messages: [], queue: [], claimed: [], activeTurn: { active: false, running: false }, connectionFailed: false })),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => currentSender,
  getWindowBindingForSender: (senderId: number) => (senderId === WINDOW ? { profileId: 'default', epoch: 1 } : undefined),
  getBaseBinding: () => undefined
})

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler({ sender: { id: WINDOW } }, ...args))
}

const windowEvent = (type: string, data: unknown, threadId?: string): void => {
  const event: ProtocolEvent = { kind: 'event', sequence: 1, type, data, profileId: 'default', ts: new Date().toISOString(), ...(threadId ? { threadId } : {}) }
  guiMms.emit('window-event', { senderId: WINDOW, event, replay: false })
}
const finished = (threadId: string, rest: Record<string, string> = {}): void =>
  windowEvent('activity', { state: 'completed', activity: { ...rest, [threadId]: 'completed' } }, threadId)

beforeAll(() => {
  registerGuiIpc({ guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
})
beforeEach(async () => {
  focused = true
  currentSender = WINDOW
  windows.length = 0
  windows.push({ isDestroyed: () => false, isFocused: () => focused, webContents: { id: WINDOW, send: () => undefined } })
  windowEvent('activity.snapshot', { activity: {} })
  await invoke('threads:select', 'open')
  await vi.waitFor(() => expect(seen).toContain('open'))
  seen.length = 0
})

describe('a window sees a thread', () => {
  it('when it opens it', async () => {
    await invoke('threads:select', 'background')
    await vi.waitFor(() => expect(seen).toEqual(['background']))
  })

  it('when the thread it shows in focus finishes, so Done clears at once', async () => {
    finished('open')
    await vi.waitFor(() => expect(seen).toEqual(['open']))
  })

  it('not when another thread finishes, or the window is not in focus', async () => {
    finished('background')
    focused = false
    finished('open', { background: 'completed' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([])
  })

  it('when it comes into focus showing a thread that finished meanwhile', async () => {
    focused = false
    finished('open')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(seen).toEqual([])
    focused = true
    appListeners.get('browser-window-focus')?.({}, windows[0])
    await vi.waitFor(() => expect(seen).toEqual(['open']))
  })

  it('when a subagent listed under the thread it shows finishes', async () => {
    windowEvent('threads.updated', { threads: [
      { id: 'open', name: 'Open' },
      { id: 'child', name: 'Child', lineage: { parentThreadId: 'open', rootThreadId: 'open', relationship: 'subagent' } }
    ] })
    finished('child')
    await vi.waitFor(() => expect(seen).toEqual(['open']))
  })
})

describe('showsDone', () => {
  const listedAs = (id: string) => (id === 'child' ? 'parent' : id)
  it('is the shown thread, or a subagent listed under it, finished', () => {
    expect(showsDone({ parent: 'completed' }, 'parent', listedAs)).toBe(true)
    expect(showsDone({ child: 'completed' }, 'parent', listedAs)).toBe(true)
    expect(showsDone({ parent: 'processing', other: 'completed' }, 'parent', listedAs)).toBe(false)
  })
})

describe('seenReporter', () => {
  it('sends one call at a time per window and thread, and ignores a failure', async () => {
    let release!: () => void
    const send = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const report = seenReporter(send)
    report(1, 'a')
    report(1, 'a')
    report(2, 'a')
    report(1, null)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2))
    release()
    const failing = seenReporter(async () => { throw new Error('older service') })
    expect(() => failing(1, 'a')).not.toThrow()
  })
})
