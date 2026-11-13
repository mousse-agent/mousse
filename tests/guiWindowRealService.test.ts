/**
 * A window and the service over a real connection (#1042), with main's IPC layer and its controller as they run:
 * - a restarted service is announced and every window's connection opened again after it, whether the window or the
 *   main connection notices the loss first;
 * - an answer to a read never puts back a turn older than an update that reached main before the answer;
 * - event numbers the window merely skipped (a streamed update replaced by its newer copy) are not taken for a loss.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const sent = vi.hoisted(() => [] as Array<{ channel: string; data: unknown }>)
const windows = vi.hoisted(() => [] as unknown[])

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => windows },
  Notification: Object.assign(class { on() { return this } show() { return undefined } }, { isSupported: () => false }),
  app: { getPath: () => '', getVersion: () => '0.0.0', on: () => undefined },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeTheme: { on: () => undefined },
  session: {},
  webContents: {}
}))

import { MousseMainService } from '../src/mms/MousseMainService'
import { MmsProtocolServer } from '../src/mms/protocol/server'
import type { LocalMmsClient } from '../src/mms/protocol/client'
import { GuiMmsController } from '../src/main/mms/GuiMmsController'
import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
import type { TurnState } from '../src/shared/types'

const WINDOW = 41
const webContents = Object.assign(new EventEmitter(), {
  id: WINDOW,
  isDestroyed: () => false,
  send: (channel: string, data: unknown) => void sent.push({ channel, data })
})
const win = Object.assign(new EventEmitter(), {
  isDestroyed: () => false,
  isFocused: () => false,
  isMinimized: () => false,
  webContents
})
windows.push(win)

const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })
const log: Array<{ event: string; fields: Record<string, unknown> }> = []
const sink = { write: (event: string, fields: Record<string, unknown> = {}) => void log.push({ event, fields }) }

let home: string
let mms: MousseMainService
let server: MmsProtocolServer
let ownerToken: string
let gui: GuiMmsController

type Internals = {
  client: LocalMmsClient | null
  disconnectTimer: ReturnType<typeof setInterval> | null
  windowSessions: Map<number, { client: LocalMmsClient }>
}
const internals = (): Internals => gui as unknown as Internals
const closedHandlersOf = (client: LocalMmsClient): Set<unknown> => (client as unknown as { connectionClosedHandlers: Set<unknown> }).connectionClosedHandlers
const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({ sender: webContents }, ...args)

// The service's turns, as its orchestrator reports them; an update is published the way the orchestrator does.
const turns = new Map<string, TurnState>()
let clock = 0
const turn = (threadId: string, phase: TurnState['phase'], turnId = 'run:1'): TurnState => {
  clock += 1
  return { threadId, turnId, phase, startedAt: '2026-11-13T10:00:00.000Z', updatedAt: new Date(Date.UTC(2026, 10, 13, 10, 0, clock)).toISOString() }
}
const publish = (state: TurnState): void => {
  turns.set(state.threadId, state)
  mms.orchestrator.emit('turn-state', state)
}
const turnsSent = (threadId: string): TurnState[] =>
  sent.filter((entry) => entry.channel === 'orchestrator:turn-state' && (entry.data as TurnState).threadId === threadId).map((entry) => entry.data as TurnState)
const lastTurnsMap = (): Record<string, TurnState> =>
  (sent.filter((entry) => entry.channel === 'turns:state').at(-1)?.data ?? {}) as Record<string, TurnState>
const count = (channel: string): number => sent.filter((entry) => entry.channel === channel).length

async function restartService(whileDown?: () => void): Promise<void> {
  await server.stop()
  whileDown?.()
  server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
  await server.start()
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'mousse-gui-real-'))
  process.env.MOUSSE_HOME = home
  mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'daemon' })
  await mms.start()
  ownerToken = mms.getOwnerLease()!.owner.token
  server = new MmsProtocolServer({ mms, ownerToken, version: 'test' })
  const endpoint = await server.start()
  mms.getOwnerLease()?.setEndpoint(endpoint)
  vi.spyOn(mms.orchestrator, 'getTurnState').mockImplementation((threadId: string) => turns.get(threadId) ?? turn(threadId, 'idle', 'none'))
  vi.spyOn(mms.orchestrator, 'getTurnSnapshot').mockImplementation(() => Object.fromEntries(turns))
  gui = new GuiMmsController({ homeDir: home, managedDaemon: true, endpointOverride: endpoint, ownerTokenOverride: ownerToken, reconnectBaseMs: 50 })
  gui.setConnectionLog(sink)
  // A reconnect attempt made while the service is down reports its failure here, as main logs it.
  gui.on('error', () => undefined)
  await gui.start()
  registerGuiIpc({
    guiMms: gui,
    presentation: new PresentationState(),
    settings: inert({ get: () => ({ notifications: {} }) }),
    browserView: inert(),
    repoRoot: '',
    connectionLog: { ...sink, undeliverable: () => undefined }
  } as unknown as GuiIpcServices, () => win as never)
  await gui.prepareWindow(webContents as never)
}, 60_000)

afterAll(async () => {
  vi.restoreAllMocks()
  await gui.stop()
  await server.stop()
  await mms.stop()
  rmSync(home, { recursive: true, force: true })
  delete process.env.MOUSSE_HOME
})

async function newThread(name: string): Promise<string> {
  const { thread } = await gui.runWithSender(webContents as never, () => gui.request<{ thread: { id: string } }>('threads.create', { name }))
  return thread.id
}

/** Holds the service's answer to a thread read after it read the turns, until `release`. */
function holdThreadReads(): { entered: Promise<void>; release: () => void; restore: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const reading = new Promise<void>((resolve) => { entered = resolve })
  const threads = mms.threads as unknown as Record<'warmThread' | 'readMessagePage', (...args: unknown[]) => Promise<unknown>>
  const spies = (['warmThread', 'readMessagePage'] as const).map((name) => {
    const original = threads[name].bind(mms.threads)
    return vi.spyOn(threads, name).mockImplementation(async (...args: unknown[]) => {
      entered()
      await gate
      return original(...args)
    })
  })
  return { entered: reading, release, restore: () => spies.forEach((spy) => spy.mockRestore()) }
}

describe('an answer to a read and an update sent while the service prepared it', () => {
  it('a "turn finished" update that arrives before an older answer stays: for the open thread and for another', async () => {
    const shown = await newThread('Shown')
    const other = await newThread('Other')
    await invoke('threads:select', shown)
    publish(turn(shown, 'thinking'))
    publish(turn(other, 'thinking'))
    await vi.waitFor(() => expect(lastTurnsMap()[other]?.phase).toBe('thinking'))

    // The window reads its thread again (here: its connection was opened again). The service reads the turns, then
    // loads the thread before it answers; both turns end meanwhile, and their updates reach main first.
    const reads = holdThreadReads()
    try {
      gui.emit('window-session-reopened', { senderId: WINDOW })
      await reads.entered
      publish(turn(shown, 'completed'))
      publish(turn(other, 'completed'))
      await vi.waitFor(() => expect(lastTurnsMap()[other]?.phase).toBe('completed'))
      expect(turnsSent(shown).at(-1)?.phase).toBe('completed')
      const before = log.length
      reads.release()
      await vi.waitFor(() => expect(log.slice(before).some((line) => line.event === 'catch-up')).toBe(true))
    } finally {
      reads.restore()
    }

    // The answer said both were still thinking: neither shows Working again.
    expect(turnsSent(shown).at(-1)?.phase).toBe('completed')
    expect(lastTurnsMap()[shown]?.phase).toBe('completed')
    expect(lastTurnsMap()[other]?.phase).toBe('completed')
    expect(log.filter((line) => line.event === 'catch-up').at(-1)?.fields.kept).toEqual(['turn'])
  })
})

describe('event numbers the window skipped', () => {
  it('are not a loss: the check reads no transcript when the turn it holds is the service\'s', async () => {
    const shown = await newThread('Streaming')
    await invoke('threads:select', shown)
    publish(turn(shown, 'thinking'))
    await vi.waitFor(() => expect(turnsSent(shown).at(-1)?.phase).toBe('thinking'))
    // A streamed update the service numbered and then replaced with its newer copy, still on its way: the window's
    // numbers skip it, and the status answer is numbered past what the window received.
    const ring = (server as unknown as { ringFor: (id: string) => { push: (...args: unknown[]) => unknown } }).ringFor(mms.profileId)
    ring.push('thread.message-updated', { message: { id: 'streaming', content: 'partial' } }, shown, mms.profileId)
    const status = vi.spyOn(gui, 'turnStatusForSender')
    const views = count('thread:view')
    const before = log.length
    win.emit('responsive')
    await vi.waitFor(() => expect(status).toHaveBeenCalled())
    await status.mock.results[0]!.value
    await new Promise((resolve) => setTimeout(resolve, 100))
    status.mockRestore()
    expect(log.slice(before).filter((line) => line.event === 'check.behind')).toEqual([])
    expect(count('thread:view')).toBe(views)
  })
})

describe('a service restart', () => {
  const reconnectedWindow = async (): Promise<void> => {
    await vi.waitFor(() => {
      expect(gui.connected).toBe(true)
      expect(gui.getWindowBindingForSender(WINDOW)).not.toBeNull()
      expect(internals().windowSessions.get(WINDOW)?.client.connected).toBe(true)
    }, { timeout: 10_000 })
  }

  it('is announced and the window opened again when the window notices first', async () => {
    const shown = await newThread('Across restarts')
    await invoke('threads:select', shown)
    const announced = count('providers:serviceRestarted')
    const before = log.length
    // The main connection does not notice by itself: neither its close nor its one-second check acts.
    const main = internals().client!
    closedHandlersOf(main).clear()
    clearInterval(internals().disconnectTimer!)
    await restartService()
    await reconnectedWindow()
    await vi.waitFor(() => expect(count('providers:serviceRestarted')).toBe(announced + 1), { timeout: 10_000 })
    await vi.waitFor(() => expect(log.slice(before).map((line) => line.event)).toEqual(expect.arrayContaining(['window.lost', 'service.lost', 'service.restored', 'window.reopened'])), { timeout: 10_000 })
    expect(log.slice(before).find((line) => line.event === 'service.lost')?.fields.noticedBy).toBe('window')
    // The window is caught up and its lists read again through its own connection.
    await vi.waitFor(() => expect(log.slice(before).find((line) => line.event === 'catch-up')?.fields.reasons).toEqual(expect.arrayContaining(['reconnected'])))
    // A turn after the restart reaches the window.
    publish(turn(shown, 'thinking', 'run:after-1'))
    await vi.waitFor(() => expect(turnsSent(shown).at(-1)).toMatchObject({ turnId: 'run:after-1', phase: 'thinking' }))
    publish(turn(shown, 'completed', 'run:after-1'))
    await vi.waitFor(() => expect(turnsSent(shown).at(-1)).toMatchObject({ turnId: 'run:after-1', phase: 'completed' }))
  }, 30_000)

  it('is announced and the window opened again when the main connection notices first', async () => {
    const shown = await newThread('Main first')
    await invoke('threads:select', shown)
    publish(turn(shown, 'thinking', 'run:during-restart'))
    await vi.waitFor(() => expect(turnsSent(shown).at(-1)?.phase).toBe('thinking'))
    const announced = count('providers:serviceRestarted')
    const before = log.length
    // The window's connection does not notice by itself: only the main connection's reconnect can open it again.
    closedHandlersOf(internals().windowSessions.get(WINDOW)!.client).clear()
    // The turn ends while the service is away: no update tells the window.
    await restartService(() => turns.set(shown, turn(shown, 'completed', 'run:during-restart')))
    await reconnectedWindow()
    await vi.waitFor(() => expect(count('providers:serviceRestarted')).toBe(announced + 1), { timeout: 10_000 })
    await vi.waitFor(() => expect(log.slice(before).map((line) => line.event)).toEqual(expect.arrayContaining(['service.restored', 'window.reopened'])), { timeout: 10_000 })
    expect(log.slice(before).find((line) => line.event === 'service.lost')?.fields.noticedBy).not.toBe('window')
    await vi.waitFor(() => expect(log.slice(before).find((line) => line.event === 'catch-up')?.fields.reasons).toEqual(expect.arrayContaining(['reconnected'])))
    // The turn that ended while the service was away is shown ended: the new service numbers from the start again,
    // and its answer is not taken for one older than the updates of the service before it.
    await vi.waitFor(() => expect(turnsSent(shown).at(-1)).toMatchObject({ turnId: 'run:during-restart', phase: 'completed' }))
    publish(turn(shown, 'thinking', 'run:after-2'))
    await vi.waitFor(() => expect(turnsSent(shown).at(-1)).toMatchObject({ turnId: 'run:after-2', phase: 'thinking' }))
  }, 30_000)

  it('is announced once for every restart, five in a row, each with a turn that reaches the window', async () => {
    const shown = await newThread('Five restarts')
    await invoke('threads:select', shown)
    const announced = count('providers:serviceRestarted')
    for (let round = 1; round <= 5; round += 1) {
      await restartService()
      await reconnectedWindow()
      await vi.waitFor(() => expect(count('providers:serviceRestarted')).toBe(announced + round), { timeout: 10_000 })
      publish(turn(shown, 'thinking', `run:round-${round}`))
      publish(turn(shown, 'completed', `run:round-${round}`))
      await vi.waitFor(() => expect(turnsSent(shown).at(-1)).toMatchObject({ turnId: `run:round-${round}`, phase: 'completed' }))
    }
    expect(count('providers:serviceRestarted')).toBe(announced + 5)
  }, 60_000)
})
