/**
 * An applet of another computer's bot in a window: main reads it through that bot (`bots.remote.applet`) and runs it in
 * the same sandboxed page as any applet; what the page saves goes back to the bot's computer
 * (`bots.remote.appletState`), and nothing is saved while it shows from the copy kept here.
 */
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { newId } from '../src/shared/net'

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
type Emit = (event: { runtimeId: string; threadId: string; revisionId: string; type: string; payload: unknown }) => void

const BOT = `${newId('node')}:bot-0123456789ab`
const source = { schemaVersion: 1, title: 'Budget', description: '', html: '<p>4000</p>', css: '', js: '', stateVersion: 1 }
const bundle = { appletId: 'a1', revisionId: 'r1', sourceHash: 'h1', title: 'Budget', description: '', source }

function setup(opened: { state: unknown; readOnly?: true }) {
  const handlers = new Map<string, Handler>()
  const contents = Object.assign(new EventEmitter(), { id: 7, mainFrame: {}, isDestroyed: () => false, send: vi.fn() })
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false })
  const request = vi.fn(async (method: string) => (method === 'bots.remote.applet' ? { bundle, ...opened } : { saved: true }))
  const gui = Object.assign(new EventEmitter(), {
    getWindowBindingForSender: () => ({ profileId: 'profile-1', epoch: 1 }),
    request,
    runWithSender: (_sender: unknown, work: () => unknown) => work()
  })
  registerAppletIpc((channel, handler) => handlers.set(channel, handler), gui as never, () => [window as never])
  // The page main mounts, and what it hears from it.
  const mounted: Array<{ source: unknown; state: unknown }> = []
  let emit: Emit | undefined
  vi.spyOn(AppletRuntimeManager.prototype, 'mount').mockImplementation(function (this: unknown, input) {
    emit = (this as { emit: Emit }).emit
    mounted.push({ source: input.source, state: input.state })
    return 'mousse-applet://page'
  })
  const event = { sender: contents, senderFrame: contents.mainFrame }
  const mount = () => handlers.get('applets:mount')!(event, { threadId: 'ignored', appletId: 'a1', revisionId: 'r1', sourceHash: 'h1', bot: { botId: BOT, messageId: 'm1' } }) as Promise<{ runtimeId: string; readOnly?: true }>
  const save = (runtimeId: string, state: unknown) => emit!({ runtimeId, threadId: `bot:${BOT}`, revisionId: 'r1', type: 'state', payload: state })
  return { request, mounted, mount, save, close: () => window.emit('closed') }
}

afterEach(() => vi.restoreAllMocks())

describe('an applet of another computer’s bot in a window', () => {
  it('is read through that bot by its message, and what it saves goes back there', async () => {
    const h = setup({ state: { rent: 900 } })
    const { runtimeId, readOnly } = await h.mount()
    expect(readOnly).toBeUndefined()
    expect(h.request).toHaveBeenCalledWith('bots.remote.applet', { profileId: 'profile-1', botId: BOT, messageId: 'm1', appletId: 'a1', revisionId: 'r1' })
    // No thread of this computer is asked for it.
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['bots.remote.applet'])
    expect(h.mounted).toEqual([{ source, state: { rent: 900 } }])

    h.save(runtimeId, { rent: 1200 })
    expect(h.request).toHaveBeenLastCalledWith('bots.remote.appletState', { profileId: 'profile-1', botId: BOT, messageId: 'm1', appletId: 'a1', revisionId: 'r1', state: { rent: 1200 } })
    h.close()
  })

  it('shown from the copy while its computer is away: read only, and nothing it changes is saved', async () => {
    const h = setup({ state: { rent: 900 }, readOnly: true })
    const { runtimeId, readOnly } = await h.mount()
    expect(readOnly).toBe(true)
    h.save(runtimeId, { rent: 1 })
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['bots.remote.applet'])
    h.close()
  })
})
