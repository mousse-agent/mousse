import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class View { setBounds() {} setVisible() {} addChildView() {} removeChildView() {} }
  return {
    session: { fromPartition: vi.fn() },
    View,
    WebContentsView: class extends View {},
    BrowserWindow: class {},
    dialog: { showSaveDialog: vi.fn() }
  }
})

const { registerAppletIpc } = await import('../src/main/applets/registerAppletIpc')
const { AppletRuntimeManager } = await import('../src/main/applets/AppletRuntimeManager')

type Handler = (event: unknown, input: unknown) => unknown

/** One Mousse window whose page owns applets, with the applet IPC registered for it. */
function setup() {
  const handlers = new Map<string, Handler>()
  const contents = Object.assign(new EventEmitter(), { id: 7, mainFrame: {}, isDestroyed: () => false })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  const gui = Object.assign(new EventEmitter(), {
    getWindowBindingForSender: () => ({ profileId: 'profile-1', epoch: 1 }),
    request: vi.fn(async () => ({}))
  })
  registerAppletIpc((channel, handler) => handlers.set(channel, handler), gui as never, () => [window as never])
  const event = { sender: contents, senderFrame: contents.mainFrame }
  // Any applet request makes the window's manager, as a mount does.
  const request = () => handlers.get('applets:get')!(event, { threadId: 't1', appletId: 'a1', revisionId: 'r1' })
  return { contents, window, request }
}

afterEach(() => vi.restoreAllMocks())

describe('main drops every applet view when its page goes', () => {
  it('on a reload or navigation of the window page, and starts fresh for the next page', async () => {
    const destroy = vi.spyOn(AppletRuntimeManager.prototype, 'destroy')
    const { contents, window, request } = setup()
    await request()

    // Same-page and subframe navigations keep the page, and its applets.
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
    contents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
    expect(destroy).not.toHaveBeenCalled()

    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(destroy).toHaveBeenCalledTimes(1)

    // The reloaded page gets a new manager, which a later reload drops in turn.
    await request()
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
    expect(destroy).toHaveBeenCalledTimes(2)
    window.emit('closed')
  })

  it('when the window page crashes', async () => {
    const destroy = vi.spyOn(AppletRuntimeManager.prototype, 'destroy')
    const { contents, window, request } = setup()
    await request()
    contents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(destroy).toHaveBeenCalledTimes(1)
    window.emit('closed')
  })
})
