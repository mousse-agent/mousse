import { beforeAll, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ events: new Map<string, Function>(), appEvents: new Map<string, Function>(), focused: false, idle: 0, presence: false, presenceSent: vi.fn(async () => {}), shown: [] as any[], windows: [] as any[], supported: true, sound: false, system: true, played: vi.fn(), handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: Function) => h.handlers.set(c, f), removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => h.windows },
  Notification: class {
    static isSupported() { return true }
    constructor(public options: unknown) {}
    on() {} show() { h.shown.push(this) } close = vi.fn()
  },
  powerMonitor: { getSystemIdleTime: () => h.idle }, app: { getPath: () => '', getVersion: () => 'test', on: (e: string, f: Function) => h.appEvents.set(e, f) }, shell: {}, dialog: {}, clipboard: {}, nativeTheme: { on() {} }, session: {}, webContents: {}
}))
vi.mock('../src/main/notifications/completionSound', () => ({ playThreadCompletionSound: h.played }))
import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
const inert = (base: object = {}): any => new Proxy(base, { get: (t, k) => k in t ? (t as any)[k] : () => undefined })
beforeAll(() => {
  const window = { isDestroyed: () => false, isFocused: () => h.focused, webContents: { id: 1, send() {} } }
  h.windows.push(window)
  const guiMms = inert({ runWithSender: (_sender: unknown, run: () => unknown) => run(), request: async () => ({}), on: (e: string, f: Function) => h.events.set(e, f), getWindowBindingForSender: () => ({ profileId: 'p' }), tellsForSender: () => h.supported, presenceAudience: () => h.presence ? 'service:p' : undefined, sendPresence: h.presenceSent })
  registerGuiIpc({ guiMms, presentation: new PresentationState(), settings: inert({ get: () => ({ notifications: { events: { completed: { system: h.system, sound: h.sound }, question: { system: h.system, sound: h.sound }, idle: { system: h.system, sound: h.sound } } } }) }), browserView: inert(), repoRoot: '' } as GuiIpcServices, () => window as any)
})
it('shows and replaces the service banner, ignores the message path, and withdraws after a read in any window', () => {
  const event = h.events.get('window-event')!
  const row = { botId: 'b', messageId: 'm', seq: 1, tell: 'soon' }
  const tell = { id: 't', rows: [row], title: 'Scout', body: 'Report', kind: 'completed', sound: false }
  event({ senderId: 1, event: { type: 'bots.tell', data: tell, profileId: 'p', sequence: h.shown.length + 1 } })
  expect(h.shown).toHaveLength(1)
  expect(h.shown[0].options).toMatchObject({ title: 'Scout', body: 'Report', silent: true })
  event({ senderId: 1, event: { type: 'bots.message', data: { botId: 'b', message: { id: 'm', author: 'bot', at: new Date().toISOString(), text: 'Report' } }, profileId: 'p', sequence: h.shown.length + 1 } })
  expect(h.shown).toHaveLength(1)
  event({ senderId: 1, event: { type: 'bots.tell', data: { ...tell, body: 'Two reports', rows: [row, { ...row, messageId: 'm2' }] }, profileId: 'p', sequence: h.shown.length + 1 } })
  expect(h.shown[0].close).toHaveBeenCalledOnce()
  expect(h.shown).toHaveLength(2)
  event({ senderId: 1, event: { type: 'bots.tell', data: { ...tell, rows: [] }, profileId: 'p', sequence: h.shown.length + 1 } })
  expect(h.shown[1].close).toHaveBeenCalledOnce()
})

it('uses the legacy message path when the service lacks telling support', () => {
  h.supported = false
  const before = h.shown.length
  h.events.get('window-event')!({ senderId: 1, event: { type: 'bots.message', profileId: 'p', data: { botId: 'b', message: { id: 'legacy', author: 'bot', at: new Date().toISOString(), text: 'Legacy reply' } } } })
  expect(h.shown).toHaveLength(before + 1)
  expect(h.shown.at(-1).options.body).toBe('Legacy reply')
})

it('checks every focused window and applies sound caps and owner settings', async () => {
  h.supported = true; h.sound = true
  h.windows.push({ isDestroyed: () => false, isFocused: () => true, webContents: { id: 2, send() {} } })
  await h.handlers.get('notifications:viewBot')!({ sender: { id: 2 } }, 'b')
  const before = h.shown.length
  const data = { id: 'focused', rows: [{ botId: 'b', messageId: 'focused', seq: 9, tell: 'now' }], title: 'Scout', body: 'Reply', kind: 'completed', sound: true }
  const push = (sequence: number, patch = {}) => h.events.get('window-event')!({ senderId: 1, event: { type: 'bots.tell', profileId: 'p', sequence, data: { ...data, ...patch } } })
  push(100)
  expect(h.shown).toHaveLength(before)
  expect(h.played).toHaveBeenCalledOnce()
  push(101, { sound: false })
  expect(h.played).toHaveBeenCalledOnce()
  h.sound = false
  push(102)
  expect(h.played).toHaveBeenCalledOnce()
  h.windows.pop(); h.system = false
  push(103)
  expect(h.shown).toHaveLength(before)
})

it.each(['done', 'failed'])('shows an automation %s silently during quiet hours and respects banners off', outcome => {
  h.sound = true; h.system = true
  const event = h.events.get('window-event')!
  const data = { jobId: 'job', jobName: 'Night check', notify: true, outcome, quietHours: true }
  const before = h.shown.length, sounds = h.played.mock.calls.length
  event({ senderId: 1, event: { type: 'scheduled.runEnded', profileId: 'p', data } })
  expect(h.shown).toHaveLength(before + 1)
  expect(h.shown.at(-1).options).toMatchObject({ title: 'Night check', silent: true })
  expect(h.played).toHaveBeenCalledTimes(sounds)
  h.system = false
  event({ senderId: 1, event: { type: 'scheduled.runEnded', profileId: 'p', data } })
  expect(h.shown).toHaveLength(before + 1)
  expect(h.played).toHaveBeenCalledTimes(sounds)
  h.system = true
})


it('wires window focus to negotiated presence and never reports an unfocused or idle window', () => {
  const focus = h.appEvents.get('browser-window-focus')!
  h.focused = true; h.presence = false; focus()
  h.presence = true; h.idle = 60; focus()
  h.idle = 0; h.focused = false; focus()
  expect(h.presenceSent).not.toHaveBeenCalled()
  h.focused = true; focus(); focus()
  expect(h.presenceSent).toHaveBeenCalledOnce()
  expect(h.presenceSent).toHaveBeenCalledWith(1, { activeAt: expect.any(Number), timeZone: expect.any(String) })
  h.focused = false
})
