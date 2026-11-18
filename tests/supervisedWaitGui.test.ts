/**
 * A wait the bot that started the thread answers (`supervised`, set by the service) pings no one: no banner for its
 * activity or its question, in a profile window or on the base connection. The same wait without the mark still pings.
 */
import { beforeAll, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ events: new Map<string, Function>(), shown: [] as any[], windows: [] as any[], handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: Function) => h.handlers.set(c, f), removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => h.windows },
  Notification: class {
    static isSupported() { return true }
    constructor(public options: unknown) {}
    on() {} show() { h.shown.push(this) } close = vi.fn()
  },
  powerMonitor: { getSystemIdleTime: () => 0 }, app: { getPath: () => '', getVersion: () => 'test', on() {} }, shell: {}, dialog: {}, clipboard: {}, nativeTheme: { on() {} }, screen: { on() {}, getAllDisplays: () => [] }, session: {}, webContents: {}
}))
vi.mock('../src/main/notifications/completionSound', () => ({ playThreadCompletionSound: vi.fn() }))
import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
const inert = (base: object = {}): any => new Proxy(base, { get: (t, k) => k in t ? (t as any)[k] : () => undefined })
beforeAll(() => {
  const window = { isDestroyed: () => false, isFocused: () => false, webContents: { id: 1, send() {} } }
  h.windows.push(window)
  const guiMms = inert({ runWithSender: (_sender: unknown, run: () => unknown) => run(), request: async () => ({}), on: (e: string, f: Function) => h.events.set(e, f), getWindowBindingForSender: () => ({ profileId: 'p' }), tellsForSender: () => true })
  const on = { system: true, sound: false }
  registerGuiIpc({ guiMms, presentation: new PresentationState(), settings: inert({ get: () => ({ notifications: { events: { completed: on, question: on, idle: on } } }) }), browserView: inert(), repoRoot: '' } as GuiIpcServices, () => window as any)
})

let sequence = 0
const windowEvent = (type: string, threadId: string, data: object) =>
  h.events.get('window-event')!({ senderId: 1, event: { type, threadId, data, profileId: 'p', sequence: ++sequence } })
const baseEvent = (type: string, threadId: string, data: object) => h.events.get('event')!({ type, threadId, data })

it.each([
  ['a profile window', windowEvent],
  ['the base connection', baseEvent]
])('pings for a wait in %s unless the bot that started the thread answers it', (_where, send) => {
  for (const [threadId, mark] of [[`quiet-${_where}`, { supervised: true }], [`asks-${_where}`, {}]] as const) {
    send('activity', threadId, { state: 'processing' })
    const before = h.shown.length
    send('activity', threadId, { state: 'awaiting_input', ...mark })
    send('activity', threadId, { state: 'processing' })
    send('questions.pending', threadId, { requestId: 'r', questions: [], ...mark })
    expect(h.shown.length - before).toBe('supervised' in mark ? 0 : 2)
  }
})
