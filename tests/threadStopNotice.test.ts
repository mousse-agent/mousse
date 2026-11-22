/** A thread's turn that a person stopped is not announced to them as stopped; one that stopped otherwise still is. */
import { beforeAll, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ events: new Map<string, Function>(), shown: [] as any[], windows: [] as any[] }))
vi.mock('electron', () => ({
  ipcMain: { handle() {}, removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => h.windows },
  Notification: class {
    static isSupported() { return true }
    constructor(public options: unknown) {}
    on() {} show() { h.shown.push(this) } close() {}
  },
  powerMonitor: { getSystemIdleTime: () => 0 }, app: { getPath: () => '', getVersion: () => 'test', on() {} }, shell: {}, dialog: {}, clipboard: {}, nativeTheme: { on() {} }, screen: { on() {}, getAllDisplays: () => [] }, session: {}, webContents: {}
}))
vi.mock('../src/main/notifications/completionSound', () => ({ playThreadCompletionSound: vi.fn() }))
import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
const inert = (base: object = {}): any => new Proxy(base, { get: (t, k) => k in t ? (t as any)[k] : () => undefined })
beforeAll(() => {
  // A window in the background: a thread's end shows as a system notification.
  const window = { isDestroyed: () => false, isFocused: () => false, webContents: { id: 1, send() {} } }
  h.windows.push(window)
  const guiMms = inert({ runWithSender: (_sender: unknown, run: () => unknown) => run(), request: async () => ({}), on: (e: string, f: Function) => h.events.set(e, f), getWindowBindingForSender: () => ({ profileId: 'p' }) })
  const events = { completed: { system: true, sound: false }, question: { system: true, sound: false }, idle: { system: true, sound: false } }
  registerGuiIpc({ guiMms, presentation: new PresentationState(), settings: inert({ get: () => ({ notifications: { events } }) }), browserView: inert(), repoRoot: '' } as GuiIpcServices, () => window as any)
})

let sequence = 0
const activity = (threadId: string, data: object): void =>
  h.events.get('window-event')!({ senderId: 1, event: { type: 'activity', threadId, profileId: 'p', sequence: ++sequence, data } })

it.each([
  ['a person stopped', { stoppedByPerson: true }, 0],
  ['stopped otherwise', {}, 1]
])('announces a turn %s accordingly', (_case, mark, banners) => {
  const threadId = `t-${sequence}`
  const before = h.shown.length
  activity(threadId, { state: 'processing' })
  activity(threadId, { state: 'idle', ...mark })
  expect(h.shown.length - before).toBe(banners)
})
