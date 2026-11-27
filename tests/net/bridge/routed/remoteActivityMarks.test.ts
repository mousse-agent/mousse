/**
 * Another computer's thread is announced here as that computer announces it. The computer running the thread (its
 * private lists, `MmsListsSource`) marks a scheduled turn, a person's Stop and a wait its bot answers; this computer's
 * merged lists raise the status change with those marks, and the window's notifications (`registerGuiIpc`) keep the
 * same ones quiet. A computer that sends no marks is announced as before.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  events: new Map<string, Function>(),
  shown: [] as any[],
  windows: [] as any[]
}))
vi.mock('electron', () => ({
  ipcMain: { handle() {}, removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => h.windows },
  Notification: class {
    static isSupported() {
      return true
    }
    constructor(public options: unknown) {}
    on() {}
    show() {
      h.shown.push(this)
    }
    close() {}
  },
  powerMonitor: { getSystemIdleTime: () => 0 },
  app: { getPath: () => '', getVersion: () => 'test', on() {} },
  shell: {},
  dialog: {},
  clipboard: {},
  nativeTheme: { on() {} },
  screen: { on() {}, getAllDisplays: () => [] },
  session: {},
  webContents: {}
}))
vi.mock('../../../../src/main/notifications/completionSound', () => ({
  playThreadCompletionSound: vi.fn()
}))

import { registerGuiIpc, type GuiIpcServices } from '../../../../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../../../../src/main/mms/PresentationState'
import {
  MmsListsSource,
  type ListsSnapshot
} from '../../../../src/mms/bridge/remote/MmsListsSource'
import { MergedLists } from '../../../../src/mms/bridge/routed/mergedLists'
import { MmsEventBus } from '../../../../src/mms/events'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import { SqliteRemoteLists } from '../../../../src/mms/net/store/remoteLists'
import { newId, type NodeId } from '../../../../src/shared/net'
import type { Thread, ThreadActivityState, TurnState } from '../../../../src/shared/types'

const inert = (base: object = {}): any =>
  new Proxy(base, { get: (t, k) => (k in t ? (t as any)[k] : () => undefined) })
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})

beforeAll(() => {
  // A window in the background: a thread's status shows as a system notification.
  const window = {
    isDestroyed: () => false,
    isFocused: () => false,
    webContents: { id: 1, send() {} }
  }
  h.windows.push(window)
  const guiMms = inert({
    runWithSender: (_sender: unknown, run: () => unknown) => run(),
    request: async () => ({}),
    on: (e: string, f: Function) => h.events.set(e, f),
    getWindowBindingForSender: () => ({ profileId: 'p' })
  })
  const on = { system: true, sound: false }
  registerGuiIpc(
    {
      guiMms,
      presentation: new PresentationState(),
      settings: inert({
        get: () => ({ notifications: { events: { completed: on, question: on, idle: on } } })
      }),
      browserView: inert(),
      repoRoot: ''
    } as GuiIpcServices,
    () => window as any
  )
})

const TID = 't1'
const at = new Date(1_700_000_000_000).toISOString()

/** The computer that runs the thread: its profile as its private lists read it, for this computer. */
function runningComputer() {
  const thread: Thread = {
    id: TID,
    name: 'Report',
    createdAt: at,
    updatedAt: at,
    order: 0,
    startedAt: at
  }
  const now = {
    activity: {} as Record<string, ThreadActivityState>,
    turns: {} as Record<string, TurnState>,
    scheduled: false,
    stoppedByPerson: false,
    supervised: false
  }
  const threadRuntimes = Object.assign(new EventEmitter(), {
    getActivitySnapshot: () => ({ ...now.activity })
  })
  const services = {
    threads: Object.assign(new EventEmitter(), { listAllThreads: () => [thread] }),
    projects: { listProjects: () => [] },
    events: new EventEmitter(),
    questions: new EventEmitter(),
    threadRuntimes,
    orchestrator: Object.assign(new EventEmitter(), {
      getTurnSnapshot: () => now.turns,
      isScheduledTurn: () => now.scheduled,
      stoppedByPerson: () => now.stoppedByPerson,
      waitSupervised: () => now.supervised
    }),
    platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } }
  }
  const idle = {
    setTimeout: () => undefined,
    clearTimeout() {},
    setInterval: () => undefined,
    clearInterval() {}
  }
  const lists = new MmsListsSource(services as never, idle, { private: true, reader: 'here' })
  cleanups.push(lists.watch(() => undefined))
  return {
    now,
    lists,
    /** The thread's status changes there, as its runtimes report it, with its turn's phase. */
    status(state: ThreadActivityState, phase: TurnState['phase']) {
      if (state === 'idle') delete now.activity[TID]
      else now.activity[TID] = state
      now.turns[TID] = { threadId: TID, turnId: 'turn', phase, updatedAt: at }
      threadRuntimes.emit('activity', { threadId: TID, state, activity: { ...now.activity } })
    }
  }
}

/** This computer: its merged lists read the other computer's private lists, and the window gets their events. */
function thisComputer() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'remote-marks-')))
  const db = new NetDatabase({ profileDir: dir })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  cleanups.push(() => db.close())
  const node = newId('node') as NodeId
  const bus = new MmsEventBus()
  let sequence = 0
  // What the profile's events bring to the window.
  bus.on('protocol:event', ((event: { type: string; data: unknown; threadId?: string }) => {
    if (event.type === 'activity')
      h.events.get('window-event')!({
        senderId: 1,
        event: { ...event, profileId: 'p', sequence: ++sequence }
      })
  }) as (data: unknown) => void)
  let update: ((value: unknown) => void) | undefined
  const hub = {
    attach: vi.fn(async (_ref: unknown, onUpdate: (value: unknown) => void) => {
      update = onUpdate
      return { close: vi.fn(), descriptor: {} }
    }),
    threads: vi.fn(async () => ({ threads: [] })),
    projects: vi.fn(async () => ({ projects: [] })),
    dropCopy: vi.fn(async () => true)
  }
  const client = {
    openStream: vi.fn(async () => ({ descriptor: {}, head: { epoch: 1, seq: 0 } })),
    closeStream: vi.fn(async () => undefined),
    call: vi.fn(async () => ({}))
  }
  const lists = new MergedLists({
    services: {
      events: bus,
      threads: { listAllThreads: () => [] },
      projects: { listProjects: () => [] },
      // Every thread of the other computers notifies, as "all remote threads" asks.
      settings: { get: () => ({ notifications: { allRemoteThreads: true } }) },
      threadRuntimes: { getActivitySnapshot: () => ({}) }
    } as never,
    hub: hub as never,
    client: client as never,
    store: new SqliteRemoteLists(db, { now: () => Date.now() }),
    self: () => newId('node') as NodeId,
    computers: () => [{ node, name: 'Desktop' }],
    online: () => true,
    enabled: () => true,
    cacheSettleMs: 50
  })
  cleanups.push(() => lists.close())
  return {
    /** The other computer's lists stream sends what its lists say now. */
    async read(snapshot: ListsSnapshot) {
      await lists.reconcile()
      update!({ kind: 'snapshot', value: snapshot })
    }
  }
}

type End = { state: ThreadActivityState; phase: TurnState['phase'] }
const completed: End = { state: 'completed', phase: 'completed' }
const stopped: End = { state: 'idle', phase: 'stopped' }
const asks: End = { state: 'awaiting_input', phase: 'awaiting_input' }

it.each([
  // [case, how the turn ends there, whether it is a scheduled occurrence's, who stopped it, whether its bot answers the wait, sends marks, banners here]
  ['a scheduled turn ends', completed, true, false, false, true, 0],
  ['a turn a person started ends', completed, false, false, false, true, 1],
  ['a scheduled turn stops to ask', asks, true, false, false, true, 1],
  ['a person stops a turn', stopped, false, true, false, true, 0],
  ['a turn stops otherwise', stopped, false, false, false, true, 1],
  ['a turn waits on the bot that started the thread', asks, false, false, true, true, 0],
  ['a turn asks the person', asks, false, false, false, true, 1],
  ['an older computer ends a scheduled turn', completed, true, false, false, false, 1]
] as const)(
  '%s on another computer: as many notifications here as there',
  async (_case, end, scheduled, byPerson, supervised, marks, banners) => {
    const there = runningComputer()
    const here = thisComputer()
    const read = () => {
      const snapshot = there.lists.snapshot()
      if (marks) return snapshot
      const { marks: _dropped, ...older } = snapshot
      return older as ListsSnapshot
    }
    await here.read(read())
    there.now.scheduled = scheduled
    there.status('processing', 'streaming')
    await here.read(read())
    const before = h.shown.length
    // The turn ends while it runs; a scheduled occurrence is forgotten right after, before the lists are read.
    there.now.stoppedByPerson = byPerson
    there.now.supervised = supervised
    there.status(end.state, end.phase)
    there.now.scheduled = false
    await here.read(read())
    expect(h.shown.length - before).toBe(banners)
  }
)
