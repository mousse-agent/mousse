/**
 * The merged lists of the user's other computers, with a fake hub and client so each snapshot and each
 * change is under the test's control: where rows sit, which changes notify, what is kept while a computer
 * is offline, how a search names a computer it could not ask.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fitSnapshot, isListedComputer } from '../../../../src/mms/bridge/routed/listRows'
import { MergedLists, type MergedListsOptions } from '../../../../src/mms/bridge/routed/mergedLists'
import { MmsEventBus } from '../../../../src/mms/events'
import { NetDatabase } from '../../../../src/mms/net/store/database'
import {
  canonicalJson,
  MAX_DISPLAY_JSON_NODES,
  parseBoundedJsonDocument
} from '../../../../src/mms/net/sync/codec'
import {
  SqliteRemoteLists,
  REMOTE_LISTS_CACHE_MAX_BYTES
} from '../../../../src/mms/net/store/remoteLists'
import { DomainRpcError } from '../../../../src/mms/protocol/domainRegistry'
import { listedThreadsFor, projectEventFor } from '../../../../src/mms/protocol/threadVisibility'
import { newId, type NodeId } from '../../../../src/shared/net'
import { qualifyId } from '../../../../src/shared/threadRef'
import type { Project, Thread } from '../../../../src/shared/types'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})

const T0 = 1_700_000_000_000
const iso = (n: number): string => new Date(T0 + n * 1000).toISOString()

interface Event {
  type: string
  data: any
  threadId?: string
}

/** What a computer sends: the snapshot of its private lists stream, in its own ids. */
function snapshot(
  threads: Array<Record<string, unknown>>,
  extra: { projects?: Array<Record<string, unknown>>; status?: Record<string, unknown> } = {}
) {
  return {
    kind: 'mousse.lists',
    version: 1,
    projects: extra.projects ?? [],
    threads: threads.map((thread) => ({
      name: String(thread.id),
      createdAt: iso(0),
      startedAt: iso(0),
      order: 0,
      ...thread
    })),
    status: extra.status ?? {},
    chats: []
  }
}

function harness(
  options: {
    computers?: Array<{ node: NodeId; name: string }>
    self?: NodeId
    enabled?: boolean
    deadline?: number
    cacheSettleMs?: number
  } = {}
) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'merged-lists-')))
  let db = new NetDatabase({ profileDir: dir })
  cleanups.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  cleanups.push(() => db.close())
  const now = { at: T0 + 10_000_000 }
  const clock = { now: () => now.at }
  const self = options.self ?? newId('node')
  const computers = options.computers ?? [{ node: newId('node'), name: 'Laptop' }]
  /** What the roster says now: a test changes it, or makes it unreadable (undefined). */
  const roster: { list: Array<{ node: NodeId; name: string }> | undefined } = { list: computers }
  const online = new Set<NodeId>(computers.map((computer) => computer.node))
  const state = {
    threads: [] as Thread[],
    projects: [] as Project[],
    activity: {} as Record<string, string>,
    all: false,
    enabled: options.enabled ?? true
  }
  const events: Event[] = []
  const bus = new MmsEventBus()
  bus.on('protocol:event', ((event: Event) => events.push(event)) as (data: unknown) => void)
  const services = {
    events: bus,
    threads: { listAllThreads: () => state.threads },
    projects: { listProjects: () => state.projects },
    settings: { get: () => ({ notifications: { allRemoteThreads: state.all } }) },
    threadRuntimes: { getActivitySnapshot: () => state.activity }
  }
  const attachments = new Map<
    NodeId,
    { update: (value: unknown) => void; error: () => void; close: ReturnType<typeof vi.fn> }
  >()
  const hub = {
    attach: vi.fn(
      async (ref: { nodeId: NodeId }, update: (value: unknown) => void, error: () => void) => {
        const close = vi.fn()
        attachments.set(ref.nodeId, { update, error, close })
        return { close, descriptor: {} }
      }
    ),
    threads: vi.fn(async () => ({ threads: [] })),
    projects: vi.fn(async () => ({ projects: [] }))
  }
  const client = {
    openStream: vi.fn(async () => ({ descriptor: {}, head: { epoch: 1, seq: 0 } })),
    closeStream: vi.fn(async () => undefined),
    call: vi.fn(
      async (
        _node: NodeId,
        _method: string,
        _params: unknown,
        _options?: { signal?: AbortSignal }
      ): Promise<unknown> => ({})
    )
  }
  let store = new SqliteRemoteLists(db, clock)
  const make = (): MergedLists =>
    new MergedLists({
      services: services as never,
      hub: hub as never,
      client: client as never,
      store,
      self: () => self,
      computers: () => roster.list,
      online: (node) => online.has(node),
      enabled: () => state.enabled,
      clock,
      fanOutDeadlineMs: options.deadline ?? 2_000,
      cacheSettleMs: options.cacheSettleMs ?? 50
    } satisfies MergedListsOptions)
  let lists = make()
  cleanups.push(() => lists.close())
  const node = computers[0]!.node
  /** Connects to the computer and gives it a snapshot, as its stream does. */
  const feed = async (value: unknown, which: NodeId = node): Promise<void> => {
    await lists.reconcile()
    attachments.get(which)!.update({ kind: 'snapshot', value })
  }
  return {
    state,
    events,
    hub,
    client,
    attachments,
    online,
    now,
    node,
    self,
    computers,
    roster,
    get store() {
      return store
    },
    get lists() {
      return lists
    },
    feed,
    /** How many computers' lists are on disk. */
    restartSnapshots: () => store.snapshots().length,
    q: (id: string, of: NodeId = node) => qualifyId(of, id),
    /** This computer is restarted: a new object reads what the database kept. */
    restart() {
      lists.close()
      db.close()
      db = new NetDatabase({ profileDir: dir })
      store = new SqliteRemoteLists(db, clock)
      attachments.clear()
      lists = make()
      cleanups.push(() => lists.close())
      return lists
    },
    ofType: (type: string, from = 0) => events.slice(from).filter((event) => event.type === type)
  }
}

const local = (
  id: string,
  order: number,
  updated: number,
  extra: Partial<Thread> = {}
): Thread => ({
  id,
  name: id,
  createdAt: iso(0),
  updatedAt: iso(updated),
  order,
  startedAt: iso(0),
  ...extra
})

describe('rows of another computer', () => {
  it('are named with qualified ids, carry their computer, and keep subagents under their parents', async () => {
    const h = harness()
    await h.feed(
      snapshot(
        [
          { id: 'p1', name: 'Parent', projectId: 'proj1', updatedAt: iso(20) },
          {
            id: 'c1',
            name: 'Child',
            projectId: 'proj1',
            updatedAt: iso(10),
            lineage: { parentThreadId: 'p1', rootThreadId: 'p1', relationship: 'subagent' }
          }
        ],
        {
          projects: [{ id: 'proj1', name: 'App', path: '/home/o/app', order: 0 }],
          status: { p1: { state: 'processing' } }
        }
      )
    )
    const rows = h.lists.threads()
    expect(rows.map((row) => row.id).sort()).toEqual([h.q('c1'), h.q('p1')])
    expect(rows.every((row) => row.node === h.node)).toBe(true)
    const child = rows.find((row) => row.id === h.q('c1'))!
    expect(child.lineage).toEqual({
      parentThreadId: h.q('p1'),
      rootThreadId: h.q('p1'),
      relationship: 'subagent'
    })
    expect(child.projectId).toBe(h.q('proj1'))
    expect(h.lists.projects()).toMatchObject([{ id: h.q('proj1'), name: 'App', node: h.node }])
    expect(h.lists.activity()).toEqual({ [h.q('p1')]: 'processing' })
    // No id of the computer is left plain anywhere in what a window is given.
    const json = JSON.stringify([rows, h.lists.projects(), h.lists.activity()])
    for (const plain of ['"p1"', '"c1"', '"proj1"']) expect(json).not.toContain(plain)
  })

  it('stay out of every list while routing is off, and nothing is attached', async () => {
    const h = harness({ enabled: false })
    await h.lists.reconcile()
    expect(h.hub.attach).not.toHaveBeenCalled()
    expect(h.lists.threads()).toEqual([])
    expect(h.lists.projects()).toEqual([])
    expect(h.lists.activity()).toEqual({})
    expect(h.events).toEqual([])
  })

  it('are added to every list a window gets, and not to the CLI’s', async () => {
    const h = harness()
    await h.feed(snapshot([{ id: 'r1', updatedAt: iso(5) }]))
    h.state.threads = [local('l1', 0, 1)]
    const ctx = (clientType: 'gui' | 'cli') => ({
      connection: { clientType },
      mms: { remoteLists: h.lists }
    })
    expect(listedThreadsFor(ctx('gui'), h.state.threads).map((row) => row.id)).toEqual([
      'l1',
      h.q('r1')
    ])
    expect(listedThreadsFor(ctx('cli'), h.state.threads).map((row) => row.id)).toEqual(['l1'])
    // A project's list gets only the rows of that project.
    expect(listedThreadsFor(ctx('gui'), [], [], { projectId: 'nope' })).toEqual([])
    expect(listedThreadsFor(ctx('gui'), [], [], { projectId: null }).map((row) => row.id)).toEqual([
      h.q('r1')
    ])
    // Events of this computer's own lists get them when a window is given the event, and a local rename that
    // pushes a list of this computer's rows alone still shows the others.
    const event = projectEventFor(
      'gui',
      {
        type: 'threads.updated',
        data: { threads: h.state.threads },
        sequence: 1,
        timestamp: ''
      } as never,
      h.lists
    )
    expect((event.data as { threads: Thread[] }).threads.map((row) => row.id)).toEqual([
      'l1',
      h.q('r1')
    ])
    const cliEvent = projectEventFor(
      'cli',
      {
        type: 'threads.updated',
        data: { threads: h.state.threads },
        sequence: 1,
        timestamp: ''
      } as never,
      h.lists
    )
    expect((cliEvent.data as { threads: Thread[] }).threads.map((row) => row.id)).toEqual(['l1'])
    // Another event that names every thread's status keeps the other computers' statuses as well.
    h.state.activity = { l1: 'processing' }
    await h.feed(
      snapshot([{ id: 'r1', updatedAt: iso(5) }], { status: { r1: { state: 'awaiting_input' } } })
    )
    const status = projectEventFor(
      'gui',
      {
        type: 'activity',
        data: { threadId: 'l1', state: 'processing', activity: { l1: 'processing' } },
        sequence: 2,
        timestamp: ''
      } as never,
      h.lists
    )
    expect((status.data as { activity: object }).activity).toEqual({
      l1: 'processing',
      [h.q('r1')]: 'awaiting_input'
    })
  })
})

describe('where a row sits', () => {
  it('takes the position its update time gives among the rows of its group, and keeps it', async () => {
    const h = harness()
    h.state.threads = [local('l1', 0, 50), local('l2', 1, 10)]
    await h.feed(
      snapshot([
        { id: 'mid', updatedAt: iso(30) },
        { id: 'newest', updatedAt: iso(99) },
        { id: 'oldest', updatedAt: iso(1) }
      ])
    )
    const order = () =>
      [...h.state.threads, ...h.lists.threads()]
        .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
        .map((row) => row.id)
    expect(order()).toEqual([h.q('newest'), 'l1', h.q('mid'), 'l2', h.q('oldest')])
    const before = Object.fromEntries(h.lists.threads().map((row) => [row.id, row.order]))
    // A local create goes to the front of this computer's rows; the others do not move.
    h.state.threads = [local('l3', -1, 200), ...h.state.threads]
    await h.feed(
      snapshot([
        { id: 'mid', updatedAt: iso(30), name: 'renamed on its computer' },
        { id: 'newest', updatedAt: iso(99) },
        { id: 'oldest', updatedAt: iso(1) }
      ])
    )
    for (const row of h.lists.threads()) expect(row.order).toBe(before[row.id])
    expect(order()[0]).toBe('l3')
  })

  it('does not move when its status changes, and an unchanged row keeps its object', async () => {
    const h = harness()
    await h.feed(
      snapshot([
        { id: 'a', updatedAt: iso(20) },
        { id: 'b', updatedAt: iso(10) }
      ])
    )
    const before = new Map(h.lists.threads().map((row) => [row.id, row]))
    await h.feed(
      snapshot(
        [
          { id: 'a', updatedAt: iso(20) },
          { id: 'b', updatedAt: iso(10) }
        ],
        { status: { a: { state: 'processing' } } }
      )
    )
    await h.feed(
      snapshot(
        [
          { id: 'a', updatedAt: iso(20) },
          { id: 'b', updatedAt: iso(10), name: 'Renamed' }
        ],
        {
          status: { a: { state: 'completed' } }
        }
      )
    )
    const now = new Map(h.lists.threads().map((row) => [row.id, row]))
    // A did not change as a row (its status is not part of it); B changed its name only.
    expect(now.get(h.q('a'))).toBe(before.get(h.q('a')))
    expect(now.get(h.q('b'))).not.toBe(before.get(h.q('b')))
    expect(now.get(h.q('b'))).toMatchObject({ name: 'Renamed', order: before.get(h.q('b'))!.order })
    // Nothing about the order moved.
    expect([...now.values()].sort((x, y) => x.order - y.order).map((row) => row.id)).toEqual([
      h.q('a'),
      h.q('b')
    ])
  })

  it('takes a change of its own row from a thread in view at once, keeping its place', async () => {
    const h = harness()
    await h.feed(
      snapshot(
        [
          { id: 'a', updatedAt: iso(20) },
          { id: 'b', updatedAt: iso(10) }
        ],
        { projects: [{ id: 'p', name: 'P', path: '/p', order: 0 }] }
      )
    )
    const rows = new Map(h.lists.threads().map((row) => [row.id, row]))
    const from = h.events.length
    const renamed = {
      id: 'a',
      name: 'Renamed',
      projectId: 'p',
      createdAt: iso(0),
      updatedAt: iso(25),
      // The order the owner gives it is not a place here.
      order: 99,
      pinnedAt: iso(30),
      startedFrom: { node: h.self, projectId: 'mine' }
    }
    h.lists.applyMetadata(h.node, renamed)
    const now = new Map(h.lists.threads().map((row) => [row.id, row]))
    expect(now.get(h.q('a'))).toMatchObject({
      name: 'Renamed',
      projectId: h.q('p'),
      pinnedAt: iso(30),
      order: rows.get(h.q('a'))!.order,
      // This computer's own project is named as it is; the other computer's is qualified.
      startedFrom: { node: h.self, projectId: 'mine' }
    })
    expect(now.get(h.q('b'))).toBe(rows.get(h.q('b')))
    expect(h.ofType('threads.updated', from)).toHaveLength(1)
    // The same row again says nothing, a thread not listed yet waits for the lists, and another computer's is not ours.
    h.lists.applyMetadata(h.node, renamed)
    h.lists.applyMetadata(h.node, {
      id: 'unknown',
      name: 'x',
      createdAt: iso(0),
      updatedAt: iso(0),
      order: 0
    })
    h.lists.applyMetadata(newId('node'), renamed)
    expect(h.ofType('threads.updated', from)).toHaveLength(1)
  })

  it('moves to the front of its group on a send from here, and keeps that after a restart', async () => {
    const h = harness()
    h.state.threads = [local('l1', 0, 50)]
    await h.feed(
      snapshot([
        { id: 'a', updatedAt: iso(20) },
        { id: 'b', updatedAt: iso(10) }
      ])
    )
    const before = h.lists.threads().find((row) => row.id === h.q('b'))!.order
    h.lists.noteSent(h.q('b'))
    const sent = h.lists.threads().find((row) => row.id === h.q('b'))!.order
    expect(sent).toBeLessThan(
      Math.min(
        0,
        ...h.lists
          .threads()
          .filter((row) => row.id !== h.q('b'))
          .map((row) => row.order)
      )
    )
    expect(sent).toBeLessThan(before)
    expect(h.ofType('threads.updated').length).toBeGreaterThan(0)
    const lists = h.restart()
    await h.lists.reconcile()
    expect(lists.threads().find((row) => row.id === h.q('b'))!.order).toBe(sent)
  })

  it('moves to the front when its computer moves it to its own front, and not for any other change', async () => {
    const h = harness()
    await h.feed(
      snapshot([
        { id: 'a', order: 0, updatedAt: iso(20) },
        { id: 'b', order: 1, updatedAt: iso(10) },
        { id: 'c', order: 2, updatedAt: iso(5) }
      ])
    )
    const order = () =>
      h.lists
        .threads()
        .sort((x, y) => x.order - y.order)
        .map((row) => row.id)
    expect(order()).toEqual([h.q('a'), h.q('b'), h.q('c')])
    // The computer moves C back and B forward without taking it to the front.
    await h.feed(
      snapshot([
        { id: 'a', order: 0, updatedAt: iso(20) },
        { id: 'b', order: 5, updatedAt: iso(10) },
        { id: 'c', order: 1, updatedAt: iso(5) }
      ])
    )
    expect(order()).toEqual([h.q('a'), h.q('b'), h.q('c')])
    // A person sends in C on the computer itself: it is at its front now.
    await h.feed(
      snapshot([
        { id: 'a', order: 0, updatedAt: iso(20) },
        { id: 'b', order: 5, updatedAt: iso(10) },
        { id: 'c', order: -1, updatedAt: iso(30) }
      ])
    )
    expect(order()).toEqual([h.q('c'), h.q('a'), h.q('b')])
  })

  it('takes the places a drag gives it among the rows of this computer', async () => {
    const h = harness()
    h.state.threads = [local('l1', 0, 50), local('l2', 1, 10)]
    await h.feed(snapshot([{ id: 'r', updatedAt: iso(99) }]))
    // The person drags the group into: l2, r, l1. This computer's rows are reordered first.
    h.state.threads = [local('l2', 0, 10), local('l1', 1, 50)]
    h.lists.reorder(['l2', h.q('r'), 'l1'])
    const all = [...h.state.threads, ...h.lists.threads()].sort((a, b) => a.order - b.order)
    expect(all.map((row) => row.id)).toEqual(['l2', h.q('r'), 'l1'])
    // The place is kept across a restart.
    const lists = h.restart()
    await h.lists.reconcile()
    expect(lists.threads()[0]!.order).toBe(all[1]!.order)
  })
})

describe('notifications', () => {
  const quiet = (h: ReturnType<typeof harness>, id: string) =>
    h.ofType('activity').filter((event) => event.threadId === h.q(id))

  it('come as activity events only for a thread this computer started or sent in, or opened in the last week', async () => {
    const h = harness()
    const rows = [
      { id: 'started', updatedAt: iso(3), startedFrom: { node: h.self } },
      { id: 'sent', updatedAt: iso(2), sentFrom: { node: h.self } },
      { id: 'opened', updatedAt: iso(1) },
      { id: 'stale', updatedAt: iso(0) },
      { id: 'never', updatedAt: iso(-1), startedFrom: { node: newId('node') } }
    ]
    const status = (state: string) => Object.fromEntries(rows.map((row) => [row.id, { state }]))
    await h.feed(snapshot(rows, { status: status('processing') }))
    h.lists.noteOpened(h.q('opened'))
    h.lists.noteOpened(h.q('stale'))
    // An opening eight days old no longer counts.
    h.now.at += 8 * 24 * 3600_000
    h.lists.noteOpened(h.q('opened'))
    const from = h.events.length
    await h.feed(snapshot(rows, { status: status('completed') }))
    const told = h.events.slice(from).filter((event) => event.type === 'activity')
    expect(told.map((event) => event.threadId).sort()).toEqual(
      [h.q('opened'), h.q('sent'), h.q('started')].sort()
    )
    expect(told.every((event) => event.data.state === 'completed')).toBe(true)
    // The ones that did not notify are still in the snapshot every window gets.
    const snapshots = h.events.slice(from).filter((event) => event.type === 'activity.snapshot')
    expect(snapshots).toHaveLength(1)
    expect(h.lists.activity()[h.q('never')]).toBe('completed')
    expect(quiet(h, 'never')).toHaveLength(0)
    expect(quiet(h, 'stale')).toHaveLength(0)
  })

  it('tell once for a thread that completes, not again for the same status', async () => {
    const h = harness()
    const row = { id: 't', updatedAt: iso(1), startedFrom: { node: h.self } }
    await h.feed(snapshot([row], { status: { t: { state: 'processing' } } }))
    await h.feed(snapshot([row], { status: { t: { state: 'completed' } } }))
    await h.feed(
      snapshot([row], {
        status: { t: { state: 'completed' } },
        projects: [{ id: 'x', name: 'x', path: '/x', order: 0 }]
      })
    )
    expect(quiet(h, 't').map((event) => event.data.state)).toEqual(['completed'])
  })

  it('come for every thread of the other computers when the person asks for all', async () => {
    const h = harness()
    h.state.all = true
    const row = { id: 'any', updatedAt: iso(1) }
    await h.feed(snapshot([row], { status: { any: { state: 'processing' } } }))
    await h.feed(snapshot([row], { status: { any: { state: 'awaiting_input' } } }))
    expect(quiet(h, 'any').map((event) => event.data.state)).toEqual(['awaiting_input'])
  })

  it('are never raised by a first look at a computer or by a reconnect', async () => {
    const h = harness()
    const row = { id: 't', updatedAt: iso(1), startedFrom: { node: h.self } }
    // The first snapshot on a link already says the thread is working or done: no event, only the snapshot.
    await h.feed(snapshot([row], { status: { t: { state: 'processing' } } }))
    expect(quiet(h, 't')).toHaveLength(0)
    expect(h.ofType('activity.snapshot').length).toBeGreaterThan(0)
    // The link is lost; what the thread was doing is not known until the computer is back.
    h.online.delete(h.node)
    h.lists.nodeOffline(h.node)
    expect(h.lists.activity()).toEqual({})
    expect(h.lists.threads().every((entry) => entry.offline === true)).toBe(true)
    // It comes back and says the thread completed while it was away: that is not a notification.
    h.online.add(h.node)
    h.lists.nodeOnline(h.node)
    // The hub keeps the stream attached across a reconnect, so the same attachment delivers the new snapshot.
    expect(h.hub.attach).toHaveBeenCalledTimes(1)
    h.attachments.get(h.node)!.update({
      kind: 'snapshot',
      value: snapshot([row], { status: { t: { state: 'completed' } } })
    })
    expect(quiet(h, 't')).toHaveLength(0)
    expect(h.lists.activity()[h.q('t')]).toBe('completed')
    // A change on that same live link after it does notify.
    h.attachments.get(h.node)!.update({
      kind: 'snapshot',
      value: snapshot([row], { status: { t: { state: 'processing' } } })
    })
    h.attachments.get(h.node)!.update({
      kind: 'snapshot',
      value: snapshot([row], { status: { t: { state: 'completed' } } })
    })
    expect(quiet(h, 't').map((event) => event.data.state)).toEqual(['processing', 'completed'])
  })
})

describe('a computer that is out of reach', () => {
  it('keeps its rows in place with an offline mark, and shows them again after a restart', async () => {
    const h = harness()
    h.state.threads = [local('l1', 0, 50)]
    await h.feed(
      snapshot(
        [
          { id: 'a', updatedAt: iso(20) },
          { id: 'b', updatedAt: iso(10) }
        ],
        { projects: [{ id: 'p', name: 'P', path: '/p', order: 0 }] }
      )
    )
    const order = Object.fromEntries(h.lists.threads().map((row) => [row.id, row.order]))
    h.online.delete(h.node)
    h.lists.nodeOffline(h.node)
    expect(h.lists.threads().map((row) => [row.id, row.order, row.offline])).toEqual(
      expect.arrayContaining([
        [h.q('a'), order[h.q('a')], true],
        [h.q('b'), order[h.q('b')], true]
      ])
    )
    expect(h.lists.projects()[0]).toMatchObject({ offline: true })
    // The last lists were written to disk once they settled.
    await vi.waitFor(() => expect(h.restartSnapshots()).toBe(1), { timeout: 5000 })
  })

  it('is read from disk at start, so its threads are listed before it connects', async () => {
    const h = harness()
    await h.feed(
      snapshot([
        { id: 'a', updatedAt: iso(20) },
        { id: 'b', updatedAt: iso(10) }
      ])
    )
    await vi.waitFor(() => expect(h.restartSnapshots()).toBe(1), { timeout: 5000 })
    h.online.delete(h.node)
    const lists = h.restart()
    await lists.reconcile()
    expect(
      lists
        .threads()
        .map((row) => row.id)
        .sort()
    ).toEqual([h.q('a'), h.q('b')])
    expect(lists.threads().every((row) => row.offline === true)).toBe(true)
    // A computer that was never reached says nothing about what its threads are doing.
    expect(lists.activity()).toEqual({})
    expect(h.hub.attach).toHaveBeenCalledTimes(1)
  })

  it('keeps the places of a long list and a copy larger than a transaction may hold, within 2 MiB', async () => {
    const h = harness()
    const long = 'x'.repeat(1_000)
    const many = Array.from({ length: 1_300 }, (_, n) => ({
      id: `t${n}`,
      name: `${long}${n}`,
      // Older threads are archived; the others are updated a second apart.
      updatedAt: iso(n),
      ...(n >= 1_000 ? { settledAt: iso(n - 2_000) } : {})
    }))
    await h.feed(snapshot(many))
    expect(h.lists.threads()).toHaveLength(1_300)
    const before = Object.fromEntries(h.lists.threads().map((row) => [row.id, row.order]))
    const lists = h.restart()
    // The places of all of them were written (a transaction takes 500 rows), and the copy, over 1 MiB, was too.
    expect(h.restartSnapshots()).toBe(1)
    await lists.reconcile()
    expect(lists.threads()).toHaveLength(1_300)
    for (const row of lists.threads()) expect(row.order).toBe(before[row.id])
  }, 30_000)

  it('cuts the copy to the size kept: archived threads go first, then the oldest, with their subagents', () => {
    const row = (n: number, extra: Record<string, unknown> = {}) => ({
      id: `t${n}`,
      updatedAt: iso(n),
      name: 'n'.repeat(200),
      ...extra
    })
    const snapshot = {
      kind: 'mousse.lists',
      threads: [
        row(1, { settledAt: iso(-50) }),
        row(2, { settledAt: iso(-10) }),
        row(3),
        row(4),
        row(5),
        row(6, { lineage: { parentThreadId: 't1' } }),
        row(7, { lineage: { parentThreadId: 't5' } })
      ],
      status: { t1: { state: 'completed' }, t5: { state: 'processing' } }
    }
    expect(fitSnapshot(snapshot, 1_000_000)).toBe(snapshot)
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
    const cut = fitSnapshot(snapshot, size(snapshot) - 1)
    // The oldest archived thread and its subagent are the first to go.
    expect(cut.threads.map((thread) => thread.id)).toEqual(['t2', 't3', 't4', 't5', 't7'])
    expect(Object.keys(cut.status)).toEqual(['t5'])
    const tight = fitSnapshot(snapshot, size(snapshot) * 0.55)
    expect(size(tight)).toBeLessThanOrEqual(size(snapshot) * 0.55)
    const ids = tight.threads.map((thread) => thread.id)
    // Unarchived threads outlast archived ones, and the newest outlast the oldest.
    expect(ids).not.toContain('t1')
    expect(ids).not.toContain('t2')
    expect(ids).toContain('t5')
    // A subagent never outlives its parent.
    for (const thread of tight.threads)
      if (thread.lineage) expect(ids).toContain(thread.lineage.parentThreadId)
  })

  it('is forgotten with its rows when it is removed from the user’s computers', async () => {
    const h = harness()
    await h.feed(snapshot([{ id: 'a', updatedAt: iso(20) }]))
    h.computers.splice(0)
    await h.lists.reconcile()
    expect(h.lists.threads()).toEqual([])
    expect(h.attachments.get(h.node)!.close).toHaveBeenCalled()
  })

  it('reads an older computer through the API a phone uses', async () => {
    const h = harness()
    h.client.openStream.mockRejectedValueOnce(
      new DomainRpcError('computer_outdated', 'Update Mousse')
    )
    h.hub.threads.mockResolvedValueOnce({
      threads: [{ id: 'old1', name: 'Old', createdAt: iso(0), updatedAt: iso(4), order: 0 }]
    } as never)
    h.hub.attach.mockRejectedValueOnce(new DomainRpcError('computer_outdated', 'Update Mousse'))
    await h.lists.reconcile()
    await vi.waitFor(() => expect(h.lists.threads().map((row) => row.id)).toEqual([h.q('old1')]))
    expect(h.lists.state()[0]).toMatchObject({ mode: 'read', live: true })
  })
})

describe('search and Recently deleted across computers', () => {
  const second = (): { node: NodeId; name: string } => ({ node: newId('node'), name: 'Desktop' })

  it('name a computer that was not searched, and keep the matches of the others', async () => {
    const offline = second(),
      slow = second(),
      broken = second()
    const h = harness({
      computers: [{ node: newId('node'), name: 'Laptop' }, offline, slow, broken],
      deadline: 80
    })
    h.online.delete(offline.node)
    h.client.call.mockImplementation(async (node: NodeId) => {
      if (node === slow.node) return new Promise(() => undefined)
      if (node === broken.node) throw new DomainRpcError('computer_outdated', 'Update Mousse')
      return {
        results: [{ threadId: 'r1', threadName: 'Found', projectId: 'pr1', matchType: 'thread' }]
      }
    })
    await h.lists.reconcile()
    const found = await h.lists.search('window-1', 'found', 20)
    expect(found.results).toEqual([
      {
        threadId: h.q('r1'),
        threadName: 'Found',
        projectId: h.q('pr1'),
        matchType: 'thread',
        node: h.node
      }
    ])
    expect(found.skipped.map((row) => [row.name, row.reason]).sort()).toEqual([
      ['Desktop', 'offline'],
      ['Desktop', 'slow'],
      ['Desktop', 'unavailable']
    ])
  })

  it('end the older search of a window when it starts a newer one', async () => {
    const h = harness()
    h.client.call.mockImplementation(
      (_node: NodeId, _method: string, params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const query = (params as { query: string }).query
          if (query === 'second')
            return resolve({
              results: [{ threadId: 'r2', threadName: 'Second', matchType: 'thread' }]
            })
          options?.signal?.addEventListener('abort', () =>
            reject(new DomainRpcError('cancelled', 'cancelled'))
          )
        })
    )
    await h.lists.reconcile()
    const first = h.lists.search('window-1', 'first', 10)
    const newer = await h.lists.search('window-1', 'second', 10)
    expect(await first).toEqual({
      results: [],
      skipped: [{ node: h.node, name: 'Laptop', reason: 'replaced' }]
    })
    expect(newer.results.map((row) => row.threadName)).toEqual(['Second'])
    // Another window's search is its own.
    expect(h.client.call).toHaveBeenCalledTimes(2)
  })

  it('list what is in the trash of the other computers by qualified id, without their folders', async () => {
    const h = harness()
    h.client.call.mockResolvedValue({
      lifecycles: [
        {
          taskId: 'gone1',
          state: 'trashed',
          location: '/home/o/.mousse/trash/gone1',
          originalLocation: '/home/o/app',
          locations: ['/home/o/app'],
          cleanupOwner: { pid: 1, processInstanceId: 'x', token: 'y' },
          operations: []
        }
      ],
      taskNames: { gone1: 'Deleted thread' }
    })
    await h.lists.reconcile()
    const inventory = await h.lists.inventory('window-1')
    expect(inventory.lifecycles).toHaveLength(1)
    expect(inventory.lifecycles[0]).toMatchObject({
      taskId: h.q('gone1'),
      node: h.node,
      computerName: 'Laptop',
      location: '',
      locations: []
    })
    expect(inventory.lifecycles[0]).not.toHaveProperty('cleanupOwner')
    expect(inventory.taskNames).toEqual({ [h.q('gone1')]: 'Deleted thread' })
    expect(JSON.stringify(inventory)).not.toContain('/home/o')
  })
})

describe('projects that are the same repository', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8'
    }).trim()
  const folder = (): string => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'merged-same-')))
    cleanups.push(() =>
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    )
    return path
  }
  const repository = (): { path: string; root: string } => {
    const path = folder()
    git(path, 'init', '-q')
    git(path, 'commit', '-q', '--allow-empty', '-m', `root ${Math.random()}`)
    return { path, root: git(path, 'rev-list', '--max-parents=0', 'HEAD') }
  }

  it('is named by sameAs on the other computer’s project, for a subfolder and for a linked folder', async () => {
    const h = harness()
    const sub = repository(),
      linked = repository()
    mkdirSync(join(sub.path, 'packages', 'ui'), { recursive: true })
    const link = join(folder(), 'shortcut')
    let linkOk = true
    try {
      symlinkSync(linked.path, link, 'junction')
    } catch {
      linkOk = false
    }
    h.state.projects = [
      {
        id: 'local-sub',
        name: 'ui',
        path: join(sub.path, 'packages', 'ui'),
        createdAt: iso(0),
        order: 0
      },
      ...(linkOk
        ? [{ id: 'local-link', name: 'linked', path: link, createdAt: iso(0), order: 1 }]
        : [])
    ]
    // The other computer answers with its project for a repository, by the root commits asked about.
    const mine: Record<string, string> = {
      [sub.root]: 'remote-sub',
      [linked.root]: 'remote-linked'
    }
    h.client.call.mockImplementation(async (_node: NodeId, method: string, params: unknown) => {
      if (method !== 'projects.match') return {}
      const roots = (params as { roots: string[] }).roots
      const projectId = roots.map((root) => mine[root]).find(Boolean)
      return projectId ? { projectId } : {}
    })
    await h.feed(
      snapshot([], {
        projects: [
          { id: 'remote-sub', name: 'lib', path: '/srv/lib', order: 0 },
          { id: 'remote-linked', name: 'tool', path: '/srv/tool', order: 1 },
          { id: 'remote-other', name: 'other', path: '/srv/other', order: 2 }
        ]
      })
    )
    await vi.waitFor(
      () => {
        const by = Object.fromEntries(
          h.lists.projects().map((project) => [project.id, project.sameAs])
        )
        expect(by[h.q('remote-sub')]).toBe('local-sub')
        if (linkOk) expect(by[h.q('remote-linked')]).toBe('local-link')
        expect(by[h.q('remote-other')]).toBeUndefined()
      },
      { timeout: 20_000 }
    )
    // The other computer was asked about each local repository once, and no path was sent.
    const asked = h.client.call.mock.calls.filter((call) => call[1] === 'projects.match')
    expect(asked).toHaveLength(linkOk ? 2 : 1)
    expect(JSON.stringify(asked.map((call) => call[2]))).not.toContain(sub.path)
    // Rows of the other computer then sort with this computer's project: its group is the local project.
    h.client.call.mockClear()
    await h.feed(
      snapshot([{ id: 'x', projectId: 'remote-sub', updatedAt: iso(9) }], {
        projects: [{ id: 'remote-sub', name: 'lib', path: '/srv/lib', order: 0 }]
      })
    )
    expect(
      listedThreadsFor(
        { connection: { clientType: 'gui' }, mms: { remoteLists: h.lists } },
        [],
        [],
        { projectId: 'local-sub' }
      ).map((row) => row.id)
    ).toEqual([h.q('x')])
  }, 30_000)

  it('keeps the match across a restart while the other computer is out of reach, for the projects this computer still has', async () => {
    const h = harness({ cacheSettleMs: 20 })
    const repo = repository()
    h.state.projects = [{ id: 'mine', name: 'mine', path: repo.path, createdAt: iso(0), order: 0 }]
    h.client.call.mockImplementation(async (_node: NodeId, method: string) =>
      method === 'projects.match' ? { projectId: 'rp' } : {}
    )
    await h.feed(
      snapshot([{ id: 't', projectId: 'rp', updatedAt: iso(1) }], {
        projects: [{ id: 'rp', name: 'rp', path: '/x', order: 0 }]
      })
    )
    await vi.waitFor(() => expect(h.lists.projects()[0]?.sameAs).toBe('mine'), { timeout: 20_000 })
    // The match is written with the copy of the lists; it holds project ids only.
    await vi.waitFor(
      () => {
        const [copy] = h.store.snapshots()
        expect(copy && JSON.parse(copy.snapshot).matches).toEqual({
          sameAs: [[h.q('rp'), 'mine']],
          similar: []
        })
      },
      { timeout: 5000 }
    )
    h.online.delete(h.node)
    h.client.call.mockClear()
    const lists = h.restart()
    await lists.reconcile()
    // Without the other computer: its project is still this computer's project's group, and its row is in it.
    expect(lists.projects()).toMatchObject([{ id: h.q('rp'), sameAs: 'mine', offline: true }])
    expect(
      listedThreadsFor({ connection: { clientType: 'gui' }, mms: { remoteLists: lists } }, [], [], {
        projectId: 'mine'
      }).map((row) => row.id)
    ).toEqual([h.q('t')])
    expect(h.client.call).not.toHaveBeenCalled()

    // A project that was removed here since is not matched from the copy.
    h.state.projects = []
    const again = h.restart()
    await again.reconcile()
    expect(again.projects()[0]).not.toHaveProperty('sameAs')
    expect(again.threads()).toHaveLength(1)
  }, 30_000)

  it('asks the other computer again only after a while, and not for a folder that is not a repository', async () => {
    const h = harness()
    const repo = repository()
    h.state.projects = [
      { id: 'a', name: 'a', path: repo.path, createdAt: iso(0), order: 0 },
      { id: 'plain', name: 'plain', path: folder(), createdAt: iso(0), order: 1 }
    ]
    h.client.call.mockResolvedValue({})
    const rows = snapshot([], { projects: [{ id: 'rp', name: 'rp', path: '/x', order: 0 }] })
    await h.feed(rows)
    await vi.waitFor(() => expect(h.client.call).toHaveBeenCalledTimes(1), { timeout: 20_000 })
    await h.feed(rows)
    await h.feed(
      snapshot([{ id: 't', updatedAt: iso(1) }], {
        projects: [{ id: 'rp', name: 'rp', path: '/x', order: 0 }]
      })
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(h.client.call).toHaveBeenCalledTimes(1)
  }, 30_000)
})

describe('a search and Recently deleted on one window', () => {
  it('do not cancel each other: each kind of call has its own slot, and overlapping reads share one', async () => {
    const h = harness()
    const aborted: string[] = []
    h.client.call.mockImplementation(
      (_node: NodeId, method: string, _params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            aborted.push(method)
            reject(new DomainRpcError('cancelled', 'cancelled'))
          })
          if (method === 'threads.inventory')
            setTimeout(
              () =>
                resolve({
                  lifecycles: [{ taskId: 'gone', state: 'trashed', operations: [] }],
                  taskNames: { gone: 'Gone' }
                }),
              60
            )
          else
            setTimeout(
              () =>
                resolve({ results: [{ threadId: 'r', threadName: 'Found', matchType: 'thread' }] }),
              120
            )
        })
    )
    await h.lists.reconcile()
    const search = h.lists.search('window-1', 'x', 10)
    // Recently deleted refreshes while the search is running, twice, on the same connection.
    const first = h.lists.inventory('window-1')
    const second = h.lists.inventory('window-1')
    const [found, trash, again] = await Promise.all([search, first, second])
    expect(aborted).toEqual([])
    expect(found.results.map((row) => row.threadName)).toEqual(['Found'])
    expect(found.skipped).toEqual([])
    expect(trash.lifecycles).toHaveLength(1)
    expect(again).toBe(trash)
    // One read of the trash for the two refreshes, one of the search.
    expect(h.client.call.mock.calls.filter((call) => call[1] === 'threads.inventory')).toHaveLength(
      1
    )
    expect(h.client.call.mock.calls.filter((call) => call[1] === 'threads.search')).toHaveLength(1)
  })

  it('name the computers a replaced search did not cover, and the one a list could not read', async () => {
    const quiet = { node: newId('node'), name: 'Desktop' }
    const h = harness({ computers: [{ node: newId('node'), name: 'Laptop' }, quiet] })
    h.online.delete(quiet.node)
    h.client.call.mockImplementation(
      (_node: NodeId, _method: string, params: unknown, options?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          if ((params as { query?: string }).query === 'newer') return resolve({ results: [] })
          options?.signal?.addEventListener('abort', () =>
            reject(new DomainRpcError('cancelled', 'x'))
          )
        })
    )
    await h.lists.reconcile()
    const older = h.lists.search('w', 'older', 5)
    await h.lists.search('w', 'newer', 5)
    expect((await older).skipped.map((row) => [row.name, row.reason]).sort()).toEqual([
      ['Desktop', 'replaced'],
      ['Laptop', 'replaced']
    ])
    h.client.call.mockResolvedValue({ lifecycles: [], taskNames: {} })
    const trash = await h.lists.inventory('w')
    expect(trash.skipped).toEqual([{ node: quiet.node, name: 'Desktop', reason: 'offline' }])
  })
})

describe('which devices are computers', () => {
  it('lists a device whose kind is computer, or whose delegation holds Works on threads; never a phone', () => {
    expect(isListedComputer('computer', [])).toBe(true)
    expect(isListedComputer(undefined, ['read', 'chat', 'write', 'settings'])).toBe(true)
    expect(isListedComputer(undefined, ['read', 'chat', 'write'])).toBe(false)
    expect(isListedComputer('phone', ['read', 'chat', 'write', 'settings'])).toBe(false)
    expect(isListedComputer('phone', [])).toBe(false)
  })

  it('forgets no computer when the roster cannot be read', async () => {
    const h = harness()
    await h.feed(snapshot([{ id: 'a', updatedAt: iso(1) }]))
    h.roster.list = undefined
    await h.lists.reconcile()
    expect(h.lists.threads()).toHaveLength(1)
    expect(h.attachments.get(h.node)!.close).not.toHaveBeenCalled()
  })
})

describe('the copy of a computer’s lists on disk', () => {
  it('is not written back for a computer that left the roster while its stream was being opened', async () => {
    const h = harness()
    let release!: () => void
    h.hub.attach.mockImplementationOnce(
      (ref: { nodeId: NodeId }, update: (value: unknown) => void, error: () => void) =>
        new Promise((resolve) => {
          const close = vi.fn()
          h.attachments.set(ref.nodeId, { update, error, close })
          release = () => resolve({ close, descriptor: {} })
        }) as never
    )
    const reading = h.lists.reconcile()
    await vi.waitFor(() => expect(h.hub.attach).toHaveBeenCalledTimes(1))
    // It is removed (revoked) before the stream is open.
    h.roster.list = []
    const second = h.lists.reconcile()
    release()
    await Promise.all([reading, second])
    const attachment = h.attachments.get(h.node)!
    expect(attachment.close).toHaveBeenCalled()
    expect(h.client.closeStream).toHaveBeenCalled()
    // A snapshot that still arrives is not made into rows, and nothing is written for the computer.
    attachment.update({ kind: 'snapshot', value: snapshot([{ id: 'late', updatedAt: iso(1) }]) })
    expect(h.lists.threads()).toEqual([])
    h.lists.close()
    expect(h.restartSnapshots()).toBe(0)
  })

  it('is cleared when routing goes off, and what is kept for a computer no longer listed goes first', async () => {
    const gone = { node: newId('node'), name: 'Old' }
    const h = harness({ computers: [{ node: newId('node'), name: 'Laptop' }, gone] })
    await h.feed(snapshot([{ id: 'a', updatedAt: iso(1) }]))
    await h.feed(snapshot([{ id: 'z', updatedAt: iso(1) }]), gone.node)
    h.lists.close()
    expect(h.restartSnapshots()).toBe(2)
    // Restart with the other computer out of the roster: its copy and places are dropped at the first look.
    const lists = h.restart()
    h.roster.list = h.computers.slice(0, 1)
    await lists.reconcile()
    expect(h.store.snapshots().map((row) => row.node)).toEqual([h.node])
    expect(h.store.positions(gone.node).size).toBe(0)
    // Routing goes off: every copy goes, the rows go, and nothing is attached.
    h.state.enabled = false
    await lists.reconcile()
    expect(h.restartSnapshots()).toBe(0)
    expect(lists.threads()).toEqual([])
    // Places are only numbers and stay, so rows come back in order when routing is on again.
    expect(h.store.positions(h.node).size).toBeGreaterThan(0)
  })

  it('shows a computer that refuses this one as not shared, not offline, and keeps nothing of it on disk', async () => {
    const h = harness()
    await h.feed(
      snapshot([{ id: 'a', updatedAt: iso(1) }], {
        projects: [{ id: 'p', name: 'P', path: '/p', order: 0 }]
      })
    )
    h.lists.close()
    expect(h.restartSnapshots()).toBe(1)
    const lists = h.restart()
    await lists.reconcile()
    // The other computer then refuses this one: the stream ends with `forbidden`.
    h.attachments.get(h.node)!.error('forbidden' as never)
    expect(lists.threads().map((row) => [row.offline, row.notShared])).toEqual([[undefined, true]])
    expect(lists.projects().map((row) => [row.offline, row.notShared])).toEqual([[undefined, true]])
    expect(lists.state()[0]).toMatchObject({ live: false })
    expect(h.restartSnapshots()).toBe(0)
    // A search says so rather than "offline", and does not ask.
    expect(await lists.search('w', 'x', 5)).toMatchObject({
      skipped: [{ name: 'Laptop', reason: 'refused' }]
    })
    expect(h.client.call).not.toHaveBeenCalled()
  })

  it('is a refusal too when the computer answers no to opening the stream', async () => {
    const h = harness()
    await h.feed(snapshot([{ id: 'a', updatedAt: iso(1) }]))
    h.lists.close()
    const lists = h.restart()
    h.hub.attach.mockRejectedValueOnce(new DomainRpcError('computer_forbidden', 'no'))
    await lists.reconcile()
    expect(lists.threads().map((row) => row.notShared)).toEqual([true])
    expect(h.restartSnapshots()).toBe(0)
  })

  it('is written when it changed and at most once while it settles; it holds no statuses', async () => {
    const h = harness({ cacheSettleMs: 40 })
    const save = vi.spyOn(h.store, 'saveSnapshot')
    const rows = [{ id: 'a', updatedAt: iso(1) }]
    await h.feed(
      snapshot(rows, {
        status: { a: { state: 'failed', error: 'Secret detail of a failed turn' } }
      })
    )
    for (let n = 0; n < 5; n++)
      await h.feed(snapshot(rows, { status: { a: { state: 'processing' } } }))
    expect(save).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    const cached = h.store.snapshots()[0]!.snapshot
    expect(cached).not.toContain('Secret detail')
    expect(JSON.parse(cached).status).toEqual({})
    // Nothing changed: the same copy is not written again.
    await h.feed(snapshot(rows, { status: { a: { state: 'completed' } } }))
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(save).toHaveBeenCalledTimes(1)
    // A change in the rows is.
    await h.feed(snapshot([{ id: 'a', name: 'Renamed', updatedAt: iso(1) }]))
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2))
  })
})

describe('a subagent and the notification rule', () => {
  it('notifies for a question under the default rule when the thread it works for qualifies', async () => {
    const h = harness()
    const child = (id: string, parent: string) => ({
      id,
      updatedAt: iso(1),
      lineage: { parentThreadId: parent, rootThreadId: parent, relationship: 'subagent' }
    })
    const rows = [
      { id: 'mine', updatedAt: iso(5), startedFrom: { node: h.self } },
      child('mine-child', 'mine'),
      { id: 'theirs', updatedAt: iso(4) },
      child('theirs-child', 'theirs')
    ]
    const say = (state: string) => ({ 'mine-child': { state }, 'theirs-child': { state } })
    await h.feed(snapshot(rows, { status: say('processing') }))
    const from = h.events.length
    await h.feed(snapshot(rows, { status: say('awaiting_input') }))
    const told = h.ofType('activity', from).map((event) => event.threadId)
    expect(told).toEqual([h.q('mine-child')])
  })
})

describe('where this computer’s own threads go in a group that holds rows of others', () => {
  it('knows the first row of the group, among every computer’s rows of its project', async () => {
    const h = harness()
    await h.feed(
      snapshot(
        [
          { id: 'a', updatedAt: iso(9) },
          { id: 'b', updatedAt: iso(3), projectId: 'p' }
        ],
        { projects: [{ id: 'p', name: 'P', path: '/p', order: 0 }] }
      )
    )
    const first = Math.min(
      ...h.lists
        .threads()
        .filter((row) => !row.projectId)
        .map((row) => row.order)
    )
    expect(h.lists.frontFloor(undefined)).toBe(first)
    expect(h.lists.frontFloor(h.q('p'))).toBe(
      h.lists.threads().find((row) => row.id === h.q('b'))!.order
    )
    expect(h.lists.frontFloor('nothing')).toBeUndefined()
    h.state.enabled = false
    expect(h.lists.frontFloor(undefined)).toBeUndefined()
  })
})

describe('how projects are matched', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
      cwd,
      encoding: 'utf8'
    }).trim()
  const folder = (): string => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'merged-match-')))
    cleanups.push(() =>
      rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    )
    return path
  }
  const repository = (remote?: string): { path: string; root: string } => {
    const path = folder()
    git(path, 'init', '-q')
    git(path, 'commit', '-q', '--allow-empty', '-m', `root ${Math.random()}`)
    if (remote) git(path, 'remote', 'add', 'origin', remote)
    return { path, root: git(path, 'rev-list', '--max-parents=0', 'HEAD') }
  }
  const remoteProject = [{ id: 'rp', name: 'R', path: '/r', order: 0 }]

  it('keeps a weak match (the root commit alone) apart from sameAs', async () => {
    const h = harness()
    const repo = repository()
    h.state.projects = [{ id: 'mine', name: 'm', path: repo.path, createdAt: iso(0), order: 0 }]
    h.client.call.mockResolvedValue({ projectId: 'rp', weak: true })
    await h.feed(snapshot([], { projects: remoteProject }))
    await vi.waitFor(() => expect(h.lists.projects()[0]?.similarTo).toBe('mine'), {
      timeout: 20_000
    })
    expect(h.lists.projects()[0]).not.toHaveProperty('sameAs')
    // Rows of a project that is only similar do not sort with this computer's project.
    await h.feed(
      snapshot([{ id: 't', projectId: 'rp', updatedAt: iso(1) }], { projects: remoteProject })
    )
    expect(h.lists.threads({ projectId: 'mine' })).toEqual([])
  }, 30_000)

  it('asks again only for a repository it has not asked about, and a minute after a failure', async () => {
    const h = harness()
    const one = repository(),
      two = repository()
    h.state.projects = [{ id: 'a', name: 'a', path: one.path, createdAt: iso(0), order: 0 }]
    h.client.call.mockRejectedValueOnce(new DomainRpcError('deadline_exceeded', 'slow'))
    const rows = snapshot([], { projects: remoteProject })
    await h.feed(rows)
    await vi.waitFor(() => expect(h.client.call).toHaveBeenCalledTimes(1), { timeout: 20_000 })
    // The failure is not retried by every snapshot that follows.
    for (let n = 0; n < 3; n++)
      await h.feed(snapshot([{ id: `t${n}`, updatedAt: iso(n) }], { projects: remoteProject }))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(h.client.call).toHaveBeenCalledTimes(1)
    h.now.at += 61_000
    h.client.call.mockResolvedValue({ projectId: 'rp' })
    await h.feed(snapshot([{ id: 'late', updatedAt: iso(9) }], { projects: remoteProject }))
    await vi.waitFor(() => expect(h.lists.projects()[0]?.sameAs).toBe('a'), { timeout: 20_000 })
    const calls = h.client.call.mock.calls.length
    // A rename or a pin of a project changes no repository: nothing is asked.
    h.state.projects = [{ ...h.state.projects[0]!, name: 'renamed', pinnedAt: iso(1) }]
    ;(h.lists as unknown as { localProjectsChanged(): void }).localProjectsChanged()
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    expect(h.client.call).toHaveBeenCalledTimes(calls)
    // A project of a repository not asked about before is asked about, and only that one.
    h.state.projects = [
      ...h.state.projects,
      { id: 'b', name: 'b', path: two.path, createdAt: iso(0), order: 1 }
    ]
    ;(h.lists as unknown as { localProjectsChanged(): void }).localProjectsChanged()
    await vi.waitFor(() => expect(h.client.call).toHaveBeenCalledTimes(calls + 1), {
      timeout: 20_000
    })
  }, 60_000)

  it('sorts rows with this computer’s project once its match is known, unless a person moved them', async () => {
    const h = harness()
    const repo = repository()
    h.state.projects = [{ id: 'mine', name: 'm', path: repo.path, createdAt: iso(0), order: 0 }]
    h.state.threads = [
      local('l1', 0, 50, { projectId: 'mine' }),
      local('l2', 1, 10, { projectId: 'mine' })
    ]
    // The match takes a moment: the rows are placed before it arrives.
    let answer!: () => void
    h.client.call.mockImplementation(
      () => new Promise((resolve) => (answer = () => resolve({ projectId: 'rp' })))
    )
    await h.feed(
      snapshot(
        [
          { id: 'seeded', projectId: 'rp', updatedAt: iso(30) },
          { id: 'moved', projectId: 'rp', updatedAt: iso(31) }
        ],
        { projects: remoteProject }
      )
    )
    // A person sends in "moved" before the match is known: it goes to the front of its group and stays.
    h.lists.noteSent(h.q('moved'))
    const movedAt = h.lists.threads().find((row) => row.id === h.q('moved'))!.order
    await vi.waitFor(() => expect(typeof answer).toBe('function'), { timeout: 20_000 })
    answer()
    await vi.waitFor(() => expect(h.lists.projects()[0]?.sameAs).toBe('mine'), { timeout: 20_000 })
    const order = (id: string) => h.lists.threads().find((row) => row.id === h.q(id))!.order
    // "seeded" was re-placed among the local rows by its update time: between l1 (50) and l2 (10).
    expect(order('seeded')).toBeGreaterThan(0)
    expect(order('seeded')).toBeLessThan(1)
    expect(order('moved')).toBe(movedAt)
    // The places were kept.
    expect(h.store.positions(h.node).get('seeded')).toBe(order('seeded'))
  }, 30_000)
})
