/**
 * "Open in a window" for a bot's browser, on the host (the worker answers as the test says; the restart itself is
 * `browserWindowRestart.test.ts`, on a real Chromium). Claims:
 * - the window is the view's hold: only the view that holds the browser opens it, the hold's heartbeat keeps it,
 *   nothing is pictured meanwhile, and the bot's runs are refused and told their owner is using the browser;
 * - Close window closes it before the browser goes back to the bot; a hold that runs out, or that another window
 *   takes, closes it too;
 * - the window ending by itself gives the browser back with nothing said, unless it stopped (a crash): then one line
 *   in the bot's chat says so;
 * - only the desktop app on this computer reaches it (\`bots.browser.window\`, not a method the renderer's bridge
 *   offers), and only that app is told it may open one (\`windowable\`);
 * - the app's main process names its own screen, and a renderer cannot name one.
 */
import { describe, expect, it, vi } from 'vitest'
import { BotBrowsers, HOLD_EXPIRED_NOTICE, WINDOW_STOPPED_NOTICE, type BotBrowserService } from '../src/mms/bots/browser/BotBrowsers'
import { DomainHandlerRegistry } from '../src/mms/protocol/domainRegistry'
import type { HandlerContext } from '../src/mms/protocol/handlers'
import { registerBotBrowserMethods } from '../src/mms/bots/browser/registerBotBrowserMethods'
import { BOT_BROWSER_WINDOW_METHOD, BOTS_BROWSER_METHODS, type BotBrowserFrameEvent } from '../src/shared/bots/personal/browser'
import type { BrowserSessionRecord } from '../src/shared/browser/types'
import type { BrowserWindowState } from '../src/shared/browser/window'
import { appDisplay, botBrowserWindow } from '../src/main/ipc/botBrowserWindow'
import { serviceHasDesktop, sessionFromTasklist } from '../src/mms/browser/windowDesktop'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A promise the test settles. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

/** The bot's browser on the host, with a worker whose window changes when the test says (`windowEnds`). */
function host() {
  let now = 1_000_000
  const leases: Array<{ fn: () => void; cleared: boolean }> = []
  const record: BrowserSessionRecord = { id: 'sess_1', profileId: 'p', threadId: 'home', persistent: true, backend: 'managed-chromium', browserVersion: '1', generation: 1, lifecycle: 'agent-controlled', createdAt: '', updatedAt: '' }
  const worker: Array<{ method: string; args?: unknown }> = []
  const notices: string[] = []
  let serial = 0
  let open = false
  let change = deferred<BrowserWindowState>()
  let pictured = 0
  const service = {
    sessions: {
      trustedSessionScope: () => ({ threadId: 'home', record: { ...record } }),
      control: async (_context: unknown, _sessionId: string, owner: 'agent' | 'human') => {
        worker.push({ method: 'control', args: owner })
        record.lifecycle = owner === 'human' ? 'human-controlled' : 'agent-controlled'
        return {}
      },
      humanInput: async () => ({}),
      humanInputs: async (_context: unknown, input: { inputs: unknown[] }) => input.inputs.map(() => ({ applied: true })),
      viewerNext: async () => {
        pictured += 1
        return new Promise(() => undefined)
      },
      viewerStop: async () => undefined,
      window: async (_context: unknown, input: { op: 'open' | 'close'; display?: unknown }) => {
        worker.push({ method: `window.${input.op}`, args: input.display })
        open = input.op === 'open'
        serial += 1
        const state = { open, serial, ...(input.op === 'close' ? { ended: 'given-back' as const } : {}) }
        if (input.op === 'close') change.resolve(state)
        return state
      },
      windowWait: async (_context: unknown, input: { after: number }) => (input.after !== serial ? { open, serial } : change.promise),
      retireViewerBudget: () => undefined,
      close: async () => { record.lifecycle = 'closed' }
    },
    tools: { invoke: async () => ({ ok: true, value: { session: { id: 'sess_1' }, observation: { tabId: 'tab_1' } } }) },
    artifacts: {},
    workspaceDataDir: () => '/nowhere'
  } as unknown as BotBrowserService
  const bots = new BotBrowsers({
    profileId: 'p', browser: () => service, homeThread: () => 'home', now: () => now, setTimer: () => ({ clear: () => undefined }),
    leaseTimer: (fn) => { const lease = { fn, cleared: false }; leases.push(lease); return { clear: () => { lease.cleared = true } } },
    holdLeaseMs: 120_000, computerName: 'Desk'
  })
  bots.setNotice((_botId, text) => notices.push(text))
  /** The window ends by itself: closed by the person, or stopped. */
  const windowEnds = (ended: 'closed' | 'crashed') => {
    open = false
    serial += 1
    const ending = change
    change = deferred()
    ending.resolve({ open: false, serial, ended })
  }
  const watch = async (viewId: string) => {
    const events: BotBrowserFrameEvent[] = []
    await bots.watch('bot-w', `w-${viewId}`, { width: 960, fps: 15, connectionId: `c-${viewId}`, viewId, emit: async (event) => { events.push(event) } })
    return events
  }
  const fireLeases = () => { for (const lease of leases.splice(0)) if (!lease.cleared) lease.fn() }
  return { bots, worker, notices, record, windowEnds, watch, fireLeases, advance: (ms: number) => { now += ms }, pictured: () => pictured }
}

/** The bot's run asks to load a page: refused while its owner holds the browser, with the reason it is told. */
async function botLoads(bots: BotBrowsers) {
  const turn = bots.turn({ botId: 'bot-w', activationId: 'act_1', lane: 'run', homeThreadId: 'home', runId: 'run_1', signal: new AbortController().signal })!
  const context = { execution: { profileId: 'p', threadId: 'home', turnId: 'run_1' } } as never
  return turn.runtime.dispatch(context, 'browser_open', { url: 'https://example.com/' })
}

describe('the bot\'s browser in a window, on the host', () => {
  it('opens for the view that holds the browser, keeps that hold, pictures nothing, and refuses the bot meanwhile', async () => {
    const { bots, worker, watch, pictured } = host()
    await watch('one')
    const { hold } = await bots.open('bot-w', undefined, { viewId: 'one', connectionId: 'c-one' })
    // Another view that does not hold it cannot open the window.
    await expect(bots.window('bot-w', 'two', hold!.id, 'open', undefined, 'c-two')).rejects.toMatchObject({ code: 'hold_ended' })
    const before = pictured()
    const view = await bots.window('bot-w', 'one', hold!.id, 'open', { DISPLAY: ':5' }, 'c-one')
    expect(view).toMatchObject({ open: true, control: 'owner', windowed: true })
    expect(worker.filter((call) => call.method.startsWith('window'))).toEqual([{ method: 'window.open', args: { DISPLAY: ':5' } }])
    // The heartbeat keeps the hold, and the window with it.
    await expect(bots.hold('bot-w', 'one', { op: 'renew', holdId: hold!.id }, 'c-one')).resolves.toMatchObject({ browser: { windowed: true } })
    await tick()
    expect(pictured()).toBe(before)
    // The bot opens nothing and is told why.
    await expect(botLoads(bots)).rejects.toMatchObject({ code: 'human_controlled', message: expect.stringContaining('Your owner is using your browser now') })
  })

  it('Close window closes it first, then gives the browser back to the bot, with nothing said in its chat', async () => {
    const { bots, worker, notices } = host()
    const { hold } = await bots.open('bot-w', undefined, { viewId: 'one', connectionId: 'c-one' })
    await bots.window('bot-w', 'one', hold!.id, 'open', undefined, 'c-one')
    const view = await bots.window('bot-w', 'one', hold!.id, 'close', undefined, 'c-one')
    expect(view.windowed).toBeUndefined()
    expect(view.control).toBe('bot')
    expect(worker.map((call) => call.method === 'control' ? `control:${call.args as string}` : call.method)).toEqual(['control:human', 'window.open', 'window.close', 'control:agent'])
    expect(notices).toEqual([])
    await expect(bots.hold('bot-w', 'one', { op: 'renew', holdId: hold!.id }, 'c-one')).rejects.toMatchObject({ code: 'hold_ended' })
  })

  it('the person closing the window gives the browser back, with nothing said; a window that stopped says so once', async () => {
    for (const ended of ['closed', 'crashed'] as const) {
      const { bots, worker, notices, windowEnds, record } = host()
      const { hold } = await bots.open('bot-w', undefined, { viewId: 'one', connectionId: 'c-one' })
      await bots.window('bot-w', 'one', hold!.id, 'open', undefined, 'c-one')
      windowEnds(ended)
      await expect.poll(() => record.lifecycle).toBe('agent-controlled')
      // Already closed: the browser is not asked to close it again.
      expect(worker.filter((call) => call.method === 'window.close')).toEqual([])
      expect((await bots.view('bot-w', { viewId: 'one' })).windowed).toBeUndefined()
      expect(notices).toEqual(ended === 'crashed' ? [WINDOW_STOPPED_NOTICE] : [])
    }
  })

  it('a hold that runs out (the app went away) closes the window, and the bot has its browser back', async () => {
    const { bots, worker, notices, record, advance, fireLeases } = host()
    const { hold } = await bots.open('bot-w', undefined, { viewId: 'one', connectionId: 'c-one' })
    await bots.window('bot-w', 'one', hold!.id, 'open', undefined, 'c-one')
    advance(121_000)
    fireLeases()
    await expect.poll(() => record.lifecycle).toBe('agent-controlled')
    expect(worker.map((call) => call.method)).toEqual(['control', 'window.open', 'window.close', 'control'])
    expect(notices).toEqual([HOLD_EXPIRED_NOTICE])
  })

  it('another window taking the browser over closes the window: that window sees pictures', async () => {
    const { bots, worker, record } = host()
    const { hold } = await bots.open('bot-w', undefined, { viewId: 'one', connectionId: 'c-one' })
    await bots.window('bot-w', 'one', hold!.id, 'open', undefined, 'c-one')
    const taken = await bots.hold('bot-w', 'two', { op: 'take', force: true }, 'c-two')
    expect(taken.browser.windowed).toBeUndefined()
    expect(worker.map((call) => call.method)).toEqual(['control', 'window.open', 'window.close'])
    expect(record.lifecycle).toBe('human-controlled')
  })
})

describe('who reaches the window', () => {
  function protocol() {
    const window = vi.fn(async () => ({ open: true, control: 'owner' as const, activations: [], windowed: true as const }))
    const view = vi.fn(async () => ({ open: true, control: 'bot' as const, activations: [] }))
    const browsers = { window, view } as unknown as BotBrowsers
    const domains = new DomainHandlerRegistry()
    registerBotBrowserMethods(domains, () => browsers)
    domains.seal()
    const connection = (overrides: Record<string, unknown> = {}) => ({
      id: 'conn-1', binding: { profileId: 'p1', epoch: 1 }, capabilities: new Set<string>(), clientType: 'gui',
      lifetime: new AbortController().signal, emitConnectionEvent: vi.fn(async () => undefined), ...overrides
    })
    const call = (method: string, params: unknown, conn = connection()) => domains.dispatch({ connection: conn } as unknown as HandlerContext, method, params)
    return { window, call, connection }
  }
  const BOT = 'bot-aaaaaaaaaaaa'
  const request = { botId: BOT, viewId: 'view-1', holdId: 'hold_1', op: 'open' }

  it('is the desktop app\'s on this computer alone: a command line, another computer and the renderer\'s bridge never reach it', async () => {
    const { window, call, connection } = protocol()
    expect(BOTS_BROWSER_METHODS as readonly string[]).not.toContain(BOT_BROWSER_WINDOW_METHOD)
    for (const stranger of [connection({ clientType: 'cli' }), connection({ bridgeCaller: { node: 'n', user: 'u', maxPermissionMode: 'ask' } })])
      await expect(call(BOT_BROWSER_WINDOW_METHOD, request, stranger)).rejects.toMatchObject({ code: 'unsupported' })
    expect(window).not.toHaveBeenCalled()
    await call(BOT_BROWSER_WINDOW_METHOD, { ...request, display: { DISPLAY: ':0' } })
    expect(window).toHaveBeenCalledWith(BOT, 'view-1', 'hold_1', 'open', { DISPLAY: ':0' }, 'conn-1')
    // A screen that is not a display name is refused before anything runs.
    await expect(call(BOT_BROWSER_WINDOW_METHOD, { ...request, display: { DISPLAY: '$(reboot)' } })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call(BOT_BROWSER_WINDOW_METHOD, { ...request, display: { LD_PRELOAD: '/x.so' } })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('tells only the desktop app on this computer that it may open one', async () => {
    const { call, connection } = protocol()
    const app = await call('bots.browser.get', { botId: BOT }) as { browser: { windowable?: boolean } }
    expect(app.browser.windowable).toBe(await serviceHasDesktop() ? true : undefined)
    const remote = await call('bots.browser.get', { botId: BOT }, connection({ bridgeCaller: { node: 'n', user: 'u', maxPermissionMode: 'ask' } })) as { browser: { windowable?: boolean } }
    expect(remote.browser.windowable).toBeUndefined()
  })

  it('offers a window only where the service runs on a desktop someone sees', async () => {
    expect(await serviceHasDesktop('win32', {}, async () => 0)).toBe(false)
    expect(await serviceHasDesktop('win32', {}, async () => 1)).toBe(true)
    expect(await serviceHasDesktop('darwin', { SSH_CONNECTION: '1 2 3 4' })).toBe(false)
    expect(await serviceHasDesktop('darwin', {})).toBe(true)
    expect(sessionFromTasklist('"node.exe","1234","Console","1","50,000 K"\r\n')).toBe(1)
    expect(sessionFromTasklist('"node.exe","1234","Services","0","50,000 K"')).toBe(0)
    expect(sessionFromTasklist('INFO: No tasks are running')).toBeUndefined()
  })
})

describe('the app names its own screen', () => {
  it('passes its own display on Linux, never one the renderer names, and refuses where it has none', async () => {
    const request = vi.fn(async () => ({ browser: { open: true, control: 'owner' as const, activations: [] } }))
    const ask = { botId: 'bot-aaaaaaaaaaaa', viewId: 'view-1', holdId: 'hold_1', op: 'open' }
    await botBrowserWindow(ask, { request, platform: 'linux', env: { DISPLAY: ':1', XAUTHORITY: '/home/a/.Xauthority', PATH: '/bin' } })
    expect(request).toHaveBeenLastCalledWith(BOT_BROWSER_WINDOW_METHOD, { ...ask, display: { DISPLAY: ':1', XAUTHORITY: '/home/a/.Xauthority' } })
    // A renderer that names a screen is refused outright.
    expect(await botBrowserWindow({ ...ask, display: { DISPLAY: ':9' } }, { request, platform: 'linux', env: { DISPLAY: ':1' } })).toEqual({ refused: expect.any(String) })
    expect(request).toHaveBeenCalledTimes(1)
    expect(await botBrowserWindow(ask, { request, platform: 'linux', env: {} })).toEqual({ refused: expect.stringContaining('no screen') })
    // Windows and macOS need no display named: the window opens on the desktop the service runs in.
    await botBrowserWindow(ask, { request, platform: 'win32', env: { DISPLAY: ':1' } })
    expect(request).toHaveBeenLastCalledWith(BOT_BROWSER_WINDOW_METHOD, ask)
    expect(appDisplay('linux', { WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' })).toEqual({ WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000' })
  })
})
