import { beforeAll, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ events: new Map<string, Function>(), shown: [] as any[], windows: [] as any[], supported: true, handlers: new Map<string, Function>() }))
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: Function) => h.handlers.set(c, f), removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => h.windows },
  Notification: class {
    static isSupported() { return true }
    constructor(public options: unknown) {}
    on() {} show() { h.shown.push(this) } close = vi.fn()
  },
  app: { getPath: () => '', getVersion: () => 'test', on() {} }, shell: {}, dialog: {}, clipboard: {}, nativeTheme: { on() {} }, session: {}, webContents: {}
}))
import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
const inert = (base: object = {}): any => new Proxy(base, { get: (t, k) => k in t ? (t as any)[k] : () => undefined })
beforeAll(() => {
  const window = { isDestroyed: () => false, isFocused: () => false, webContents: { id: 1, send() {} } }
  h.windows.push(window)
  const guiMms = inert({ request: async () => ({}), on: (e: string, f: Function) => h.events.set(e, f), getWindowBindingForSender: () => ({ profileId: 'p' }), tellsForSender: () => h.supported })
  registerGuiIpc({ guiMms, presentation: new PresentationState(), settings: inert({ get: () => ({ notifications: { events: { completed: { system: true, sound: false }, question: { system: true, sound: false } } } }) }), browserView: inert(), repoRoot: '' } as GuiIpcServices, () => window as any)
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
