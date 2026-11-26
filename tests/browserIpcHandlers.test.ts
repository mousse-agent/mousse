/**
 * The window's reports about its in-app tabs reach the browser host through the registered IPC handlers: the person's
 * use of a tab, a tab moved to another thread or kept in every thread, and a tab opened for an agent.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
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

/** Services the handlers under test do not use: every method does nothing. */
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })
const host = {
  reportActivity: vi.fn(),
  setTabOwner: vi.fn(),
  registerTab: vi.fn(async () => ({ uiTabId: 'ui_1' }))
}
const sender = { id: 1 }
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = handlers.get(channel)
  if (!handler) throw new Error(`No handler for ${channel}`)
  return Promise.resolve(handler({ sender, senderFrame: undefined }, ...args))
}

beforeAll(() => {
  registerGuiIpc({
    guiMms: inert({ request: async () => ({}), supports: async () => true, runWithSender: (_sender: unknown, run: () => unknown) => run() }), presentation: new PresentationState(),
    settings: inert(), browserView: inert(), repoRoot: '', attachedBrowserHost: host
  } as unknown as GuiIpcServices, () => null)
})
beforeEach(() => { vi.clearAllMocks() })

describe('the in-app browser\'s IPC handlers', () => {
  it('passes the person\'s use of a tab to the host', async () => {
    await invoke('browser:user-activity', { localTabId: 'tab_a', kind: 'pin', pin: 'address' })
    expect(host.reportActivity).toHaveBeenCalledWith(sender, { localTabId: 'tab_a', kind: 'pin', pin: 'address' })
  })

  it('passes a tab moved to a thread, or kept in every thread, to the host', async () => {
    await invoke('browser:tab-owner', { localTabId: 'tab_a', threadId: 'thread_2' })
    await invoke('browser:tab-owner', { localTabId: 'tab_a', threadId: null })
    expect(host.setTabOwner.mock.calls).toEqual([[sender, 'tab_a', 'thread_2'], [sender, 'tab_a', null]])
  })

  it('passes a tab the window opened for an agent to the host as one', async () => {
    await invoke('browser:register-tab', { localTabId: 'tab_a', webContentsId: 7, threadId: 'thread_1', agentOpened: true })
    expect(host.registerTab).toHaveBeenCalledWith(sender, { localTabId: 'tab_a', webContentsId: 7, threadId: 'thread_1', agentOpened: true })
  })

  it('refuses fields it does not know', async () => {
    await expect(invoke('browser:tab-owner', { localTabId: 'tab_a', threadId: 'thread_2', extra: true })).rejects.toThrow()
    expect(host.setTabOwner).not.toHaveBeenCalled()
  })
})
