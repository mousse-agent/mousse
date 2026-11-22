/**
 * The window's Delete goes through main's `threads:delete`. When the service does not answer within the request's time
 * limit, the window gets a plain answer it can show, not an unknown error; a refusal keeps the service's own words.
 */
import { beforeAll, expect, it, vi } from 'vitest'
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), request: (async () => ({})) as (method: string, params?: unknown) => Promise<unknown> }))
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: Function) => h.handlers.set(c, f), removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class { static isSupported() { return false } },
  powerMonitor: {}, app: { getPath: () => '', getVersion: () => 'test', on() {} }, shell: {}, dialog: {}, clipboard: {}, nativeTheme: { on() {} }, screen: { on() {}, getAllDisplays: () => [] }, session: {}, webContents: {}
}))
import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
import { MmsProtocolError } from '../src/mms/protocol/client'
import { DELETE_TOO_LONG } from '../src/shared/resourceLifecycle'

const inert = (base: object = {}): any => new Proxy(base, { get: (t, k) => k in t ? (t as any)[k] : () => undefined })
beforeAll(() => {
  const window = { isDestroyed: () => false, isFocused: () => false, webContents: { id: 1, send() {} } }
  const guiMms = inert({ runWithSender: (_sender: unknown, run: () => unknown) => run(), request: (method: string, params?: unknown) => h.request(method, params), on() {}, getWindowBindingForSender: () => ({ profileId: 'p' }) })
  registerGuiIpc({ guiMms, presentation: new PresentationState(), settings: inert({ get: () => ({}) }), browserView: inert(), repoRoot: '' } as GuiIpcServices, () => window as any)
})
const remove = (threadId: string) => h.handlers.get('threads:delete')!({ sender: { id: 1 } }, threadId) as Promise<{ ok: boolean; error?: { code: string; message: string } }>

it('answers a delete the service did not answer in time with words the window can show', async () => {
  h.request = async (method) => { throw new Error(`Request timeout: ${method}`) }
  expect(await remove('t1')).toMatchObject({ ok: false, error: { code: 'delete_timeout', message: DELETE_TOO_LONG } })
})

it('keeps the service’s own reason for a refused delete', async () => {
  h.request = async () => { throw new MmsProtocolError('thread_delete_blocked', 'The thread could not be deleted: a reason') }
  expect(await remove('t1')).toMatchObject({ ok: false, error: { code: 'thread_delete_blocked', message: 'The thread could not be deleted: a reason' } })
})
