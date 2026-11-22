/**
 * The warm start through main's own handlers: a window that opens is put back on the thread its profile showed last,
 * what main sends and answers it is kept (lists, settled thread states, project icons, app info), and the next
 * window's preload reads it back synchronously (`app:warmStartView`) without asking the service.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, (event: unknown, ...args: unknown[]) => unknown>())
const listeners = vi.hoisted(() => new Map<string, (event: unknown) => void>())

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: (channel: string, listener: (event: unknown) => void) => { listeners.set(channel, listener) } },
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
import { WarmStartCache } from '../src/main/warmStartCache'

const binding = { profileId: 'prf_a', epoch: 1 }
const ICON = 'data:image/png;base64,iVBORw0KGgo='
const T = '2026-11-20T10:00:00.000Z'
const thread = (id: string) => ({ id, name: `Thread ${id}`, createdAt: T, updatedAt: T })
const requests: string[] = []
const guiMms = {
  request: vi.fn(async (method: string) => {
    requests.push(method)
    if (method === 'threads.list') return { threads: [thread('newest'), thread('last-shown')], version: { epoch: 'e', seq: 3 } }
    if (method === 'projects.list') return { projects: [{ id: 'p1', name: 'Mousse' }] }
    if (method === 'profiles.list') return { defaultProfileId: 'prf_a', profiles: [{ id: 'prf_a', displayName: 'Work', color: '#336699' }] }
    if (method === 'projects.icon') return { icon: { dataUrl: ICON } }
    if (method === 'activity.snapshot') return { activity: { newest: 'completed', 'last-shown': 'processing' } }
    return {}
  }),
  snapshotThread: vi.fn(async (threadId: string) => ({
    messages: [{ id: `${threadId}-1`, role: 'user', content: 'Ship it', timestamp: T }],
    queue: [], claimed: [], activeTurn: { active: false, running: false }, connectionFailed: false
  })),
  runWithSender: (_sender: unknown, run: () => unknown) => run(),
  getCurrentSenderId: () => 1,
  getWindowBinding: () => binding,
  getWindowBindingForSender: () => binding,
  getBaseBinding: () => binding
}
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })

let dir: string
let file: string
let cache: WarmStartCache
const sent: Array<[string, unknown]> = []
const event = { sender: { id: 1, isDestroyed: () => false, send: (channel: string, data: unknown) => { sent.push([channel, data]) } } }
const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => Promise.resolve(handlers.get(channel)!(event, ...args))
/** The window's own page; another sender (another window, a frame inside it) is answered nothing. */
const mainFrame = { parent: null }
const window = { isDestroyed: () => false, webContents: event.sender }
/** What the preload's synchronous read returns: the listener sets `returnValue`, once the file has been read. */
async function readSync(sender: unknown = event.sender, senderFrame: unknown = mainFrame): Promise<unknown> {
  return new Promise((resolve) => {
    const syncEvent = { sender, senderFrame, set returnValue(value: unknown) { resolve(value) } }
    listeners.get('app:warmStartView')!(syncEvent)
  })
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warm-start-ipc-'))
  file = join(dir, 'warm-start.json')
  // Last session: this profile's window showed `last-shown`.
  await writeFile(file, JSON.stringify({ version: 1, lastProfileId: 'prf_a', profiles: [['prf_a', { threads: [thread('last-shown')], activeThreadId: 'last-shown' }]] }), 'utf8')
  cache = new WarmStartCache(file)
  await cache.load()
  registerGuiIpc({ guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert({ get: () => ({ provider: { llmProvider: 'claude-subscription' } }) }), browserView: inert(), repoRoot: '', warmStart: cache } as unknown as GuiIpcServices, () => window as never)
})
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

describe('the warm start through the window handlers', () => {
  it('opens a new window on the thread shown last, and keeps what it was sent for the next launch', async () => {
    await invoke('threads:initialize')
    expect(sent.find(([channel]) => channel === 'thread:selected')?.[1]).toEqual({ id: 'last-shown' })
    await invoke('profiles:list')
    await invoke('threads:activity')
    await invoke('projects:icon', 'p1')
    await invoke('app:getInfo')
    await cache.flush()

    const next = new WarmStartCache(file)
    await next.load()
    handlers.clear()
    registerGuiIpc({ guiMms: inert(guiMms), presentation: new PresentationState(), settings: inert({ get: () => ({}) }), browserView: inert(), repoRoot: '', warmStart: next } as unknown as GuiIpcServices, () => window as never)
    requests.length = 0
    expect(await readSync()).toEqual({
      profileId: 'prf_a',
      profile: { id: 'prf_a', displayName: 'Work', color: '#336699' },
      threads: [thread('newest'), thread('last-shown')],
      projects: [{ id: 'p1', name: 'Mousse' }],
      activeThreadId: 'last-shown',
      messages: [{ id: 'last-shown-1', role: 'user', content: 'Ship it', timestamp: T }],
      // Only a finished or waiting thread's state is kept: a thread that was working shows none at the next launch.
      activity: { newest: 'completed' },
      projectIcons: { p1: { dataUrl: ICON } },
      appInfo: expect.objectContaining({ platform: process.platform, repoRoot: '', llmProvider: 'claude-subscription' })
    })
    // Reading it asks the service nothing.
    expect(requests).toEqual([])
    // Only the window's own page is answered.
    expect(await readSync({ id: 2 })).toBeNull()
    expect(await readSync(event.sender, { parent: mainFrame })).toBeNull()
  })
})
