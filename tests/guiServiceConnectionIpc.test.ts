/**
 * The windows' composers say Connecting… from the app's link to its background service (`GuiMmsController` state).
 * Main answers a window that asks with the current state, and sends every change to every open window.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const sent = vi.hoisted(() => [] as Array<{ window: number; channel: string; data: unknown }>)
const windows = vi.hoisted(() => [7, 8, 9].map((id) => ({
  isDestroyed: () => id === 9,
  webContents: { id, send: (channel: string, data: unknown) => void sent.push({ window: id, channel, data }) }
})))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => windows },
  Notification: class {},
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

const listeners = new Map<string, Array<(payload: unknown) => void>>()
const guiMms = {
  connectionState: 'reconnecting',
  on: (event: string, listener: (payload: unknown) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), listener])
  },
  request: vi.fn(async () => ({})),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => 7,
  getWindowBindingForSender: () => ({ profileId: 'profile-1' })
}
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })

beforeAll(() => {
  registerGuiIpc({ guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
})

describe('the service connection, for the windows', () => {
  it('is answered to a window that asks', async () => {
    expect(await handlers.get('app:serviceConnection')!({ sender: { id: 7 } })).toBe('reconnecting')
    guiMms.connectionState = 'ready'
    expect(await handlers.get('app:serviceConnection')!({ sender: { id: 7 } })).toBe('ready')
  })

  it('is sent to every open window when it changes', () => {
    sent.length = 0
    for (const listener of listeners.get('state') ?? []) listener('reconnecting')
    for (const listener of listeners.get('state') ?? []) listener('ready')
    const changes = sent.filter((entry) => entry.channel === 'app:serviceConnectionChanged')
    expect(changes).toEqual([
      { window: 7, channel: 'app:serviceConnectionChanged', data: 'reconnecting' },
      { window: 8, channel: 'app:serviceConnectionChanged', data: 'reconnecting' },
      { window: 7, channel: 'app:serviceConnectionChanged', data: 'ready' },
      { window: 8, channel: 'app:serviceConnectionChanged', data: 'ready' }
    ])
  })
})
