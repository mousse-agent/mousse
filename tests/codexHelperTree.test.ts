/**
 * Issue #142: the helper tree of a Codex thread, read back from the app-server. A fake server holds
 * the threads; the tree's `list`, `read` and `interrupt` go through it. Time is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HelperTree, RpcRefused, ThreadStatuses, TreeOff, type SweepOptions, type TreePorts, type TreeTiming } from '../src/mms/providers/codex/helperTree'
import type { CodexNotification, ThreadStatusType } from '../src/mms/providers/codex/protocol'

const ROOT = 'root'
const T0 = 1_800_000_000_000
const TIMING: TreeTiming = { newbornMs: 2_000, scanMinMs: 1_000, pairGapMs: 250, safetyTickMs: 15_000, sweepRoundMs: 500 }

type Thread = { parent: string | null; status: ThreadStatusType; createdAt?: number; edge?: boolean; unreadable?: boolean }

/** The server: threads by id, answering the tree's requests, recording what it was asked. */
class World {
  readonly threads = new Map<string, Thread>()
  readonly lists: number[] = []
  readonly reads: string[] = []
  readonly interrupts: string[] = []
  listFails: Array<unknown> = []
  readRootFails: Array<unknown> = []
  rows: ((rows: unknown[]) => unknown[]) | undefined

  constructor() {
    this.threads.set(ROOT, { parent: null, status: 'idle' })
  }

  add(id: string, parent: string, status: ThreadStatusType = 'idle', extra: Partial<Thread> = {}): void {
    this.threads.set(id, { parent, status, createdAt: 0, edge: true, ...extra })
  }

  set(id: string, status: ThreadStatusType): void {
    this.threads.get(id)!.status = status
  }

  /** Threads whose edge chain reaches `ancestor`. */
  descendants(ancestor: string): string[] {
    const result: string[] = []
    const reaches = (id: string): boolean => {
      for (let cursor = this.threads.get(id)?.parent; cursor; cursor = this.threads.get(cursor)?.parent) if (cursor === ancestor) return true
      return false
    }
    for (const [id, thread] of this.threads) if (thread.edge && id !== ancestor && reaches(id)) result.push(id)
    return result
  }

  list(ancestor: string): unknown[] {
    this.lists.push(Date.now())
    const failure = this.listFails.shift()
    if (failure) throw failure
    const rows = this.descendants(ancestor).map((id) => {
      const thread = this.threads.get(id)!
      return { id, parentThreadId: thread.parent, status: { type: thread.status }, ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}) }
    })
    return this.rows ? this.rows(rows) : rows
  }

  read(id: string): unknown {
    this.reads.push(id)
    if (id === ROOT) {
      const failure = this.readRootFails.shift()
      if (failure) throw failure
    }
    const thread = this.threads.get(id)
    if (!thread || thread.unreadable) throw new RpcRefused('thread not found')
    return { id, status: { type: thread.status }, parentThreadId: thread.parent }
  }
}

const note = (method: string, params: Record<string, unknown>): CodexNotification => ({ method, params })
const started = (threadId: string): CodexNotification => note('turn/started', { threadId, turn: { id: `t-${threadId}`, status: 'inProgress', error: null } })
const completed = (threadId: string): CodexNotification => note('turn/completed', { threadId, turn: { id: `t-${threadId}`, status: 'completed', error: null } })
const spawnItem = (threadId: string): CodexNotification =>
  note('item/completed', { threadId, turnId: 't', item: { type: 'subAgentActivity', id: 'i', kind: 'started', agentThreadId: 'x' } })

function build(world = new World(), options: { floor?: string[]; timing?: Partial<TreeTiming>; ports?: Partial<TreePorts> } = {}) {
  const statuses = new ThreadStatuses()
  const floor = { running: () => options.floor ?? [] }
  const ports: TreePorts = {
    now: () => Date.now(),
    read: async (id) => world.read(id),
    list: async (ancestor) => world.list(ancestor),
    interrupt: (threadId, turnId) => void world.interrupts.push(`${threadId}/${turnId}`),
    ...options.ports
  }
  const tree = new HelperTree(ROOT, ports, statuses, floor, { ...TIMING, ...options.timing })
  /** A notification as the service sees it: the process-wide record first, then the tree. */
  const hear = (notification: CodexNotification): void => {
    statuses.note(notification)
    tree.noteWake(notification)
  }
  return { tree, statuses, world, hear }
}

/** Runs `untilQuiescent` and advances time until it settles or `limit` ms passed. */
async function untilQuiet(tree: HelperTree, limit = 20_000, step = 50): Promise<{ done: boolean; at: number; error?: unknown }> {
  const start = Date.now()
  const stop = new AbortController()
  let outcome: { done: boolean; error?: unknown } = { done: false }
  tree.untilQuiescent(stop.signal).then(
    () => (outcome = { done: true }),
    (error: unknown) => (outcome = { done: false, error })
  )
  while (!outcome.done && !outcome.error && Date.now() - start < limit) await vi.advanceTimersByTimeAsync(step)
  stop.abort()
  return { ...outcome, at: Date.now() - start }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('quiescence pair', () => {
  it('needs two agreeing snapshots 250 ms apart; a member that appears in between resets it', async () => {
    const { tree, world } = build()
    expect((await tree.check()).quiescent).toBe(false)
    world.add('h1', ROOT)
    await vi.advanceTimersByTimeAsync(250)
    const second = await tree.check()
    expect(second.snapshot.members).toEqual(['h1'])
    expect(second.quiescent).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(true)
  })

  it('a pair needs 250 ms between its snapshots', async () => {
    const { tree } = build()
    await tree.check()
    await vi.advanceTimersByTimeAsync(100)
    expect((await tree.check()).quiescent).toBe(false)
  })

  it('a wake-up between the two snapshots voids the pair, whichever thread of the tree it names', async () => {
    for (const make of [() => started(ROOT), () => completed('h1'), () => spawnItem(ROOT)]) {
      const { tree, world, hear } = build()
      world.add('h1', ROOT)
      await tree.check()
      hear(make())
      await vi.advanceTimersByTimeAsync(250)
      expect((await tree.check()).quiescent).toBe(false)
      await vi.advanceTimersByTimeAsync(250)
      expect((await tree.check()).quiescent).toBe(true)
    }
  })

  it('a wake-up from a thread not seen yet voids it; once ruled out, its wake-ups do not', async () => {
    const { tree, world, hear } = build()
    world.threads.set('other', { parent: null, status: 'idle' })
    await tree.check()
    hear(note('thread/status/changed', { threadId: 'other', status: { type: 'idle' } }))
    await vi.advanceTimersByTimeAsync(250)
    // The unseen thread is placed (a root of its own: ruled out) and the pair is void.
    expect((await tree.check()).quiescent).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(true)
    // Ruled out now: more of its traffic leaves the next pair alone.
    for (let i = 0; i < 3; i += 1) hear(note('thread/status/changed', { threadId: 'other', status: { type: 'idle' } }))
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(true)
  })

  it('ignores notifications that cannot change who is busy', async () => {
    const { tree, hear } = build()
    await tree.check()
    hear(note('item/agentMessage/delta', { threadId: ROOT, itemId: 'm', delta: 'x' }))
    hear(note('thread/tokenUsage/updated', { threadId: ROOT }))
    hear(note('item/completed', { threadId: ROOT, item: { type: 'agentMessage', id: 'a', text: '' } }))
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(true)
  })
})

describe('membership during a list and between lists', () => {
  it('a list that gains a member between two snapshots keeps the run held; the next two agree', async () => {
    const { tree, world } = build()
    let extra = false
    world.rows = (rows) => {
      if (extra) rows.push({ id: 'late', parentThreadId: ROOT, status: { type: 'idle' }, createdAt: 0 })
      return rows
    }
    await tree.check()
    extra = true
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(false)
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(true)
  })

  it('a member that vanishes from the list disagrees with the earlier snapshot too', async () => {
    const { tree, world } = build()
    world.add('h1', ROOT)
    await tree.check()
    world.threads.get('h1')!.edge = false
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(false)
  })
})

describe('busy: active, newborn, and what is settled', () => {
  it('a listed helper still idle and never seen active is busy for 2 s after it was created, and the run waits for that without the 15 s tick', async () => {
    const { tree, world } = build()
    world.add('h1', ROOT, 'idle', { createdAt: T0 / 1000 - 1 })
    const first = await tree.check()
    expect(first.snapshot.busy).toEqual(['h1'])
    expect(first.snapshot.newbornAt).toBe(T0 + 1_000)
    const listsBefore = world.lists.length
    const result = await untilQuiet(tree, 5_000)
    expect(result.done).toBe(true)
    // Expiry at +1 s, then the pair 250 ms later: well before a 15 s tick.
    expect(result.at).toBeLessThanOrEqual(1_400)
    expect(world.lists.length - listsBefore).toBeLessThanOrEqual(4)
  })

  it('a helper created long ago never delays the run', async () => {
    const { tree, world } = build()
    world.add('h1', ROOT, 'idle', { createdAt: 1 })
    const result = await untilQuiet(tree)
    expect(result.done).toBe(true)
    expect(result.at).toBeLessThanOrEqual(350)
  })

  it('a newborn that was seen active is not a newborn any more', async () => {
    const { tree, world, hear } = build()
    world.add('h1', ROOT, 'active', { createdAt: T0 / 1000 })
    hear(started('h1'))
    await tree.check()
    world.set('h1', 'idle')
    hear(completed('h1'))
    const check = await tree.check()
    expect(check.snapshot.busy).toEqual([])
  })

  it('notLoaded and a settled systemError are never busy or interrupted, and do not switch the mode off', async () => {
    const { tree, world } = build()
    world.add('gone', ROOT, 'notLoaded')
    world.add('broken', ROOT, 'systemError')
    const options = sweepOptions()
    const outcome = await sweepUntilDone(tree, options)
    expect(outcome).toBe('quiescent')
    expect(world.interrupts).toEqual([])
    expect(options.interruptRoot).not.toHaveBeenCalled()
  })

  it('systemError on the root counts as idle', async () => {
    const { tree, world } = build()
    world.set(ROOT, 'systemError')
    await tree.check()
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(true)
  })

  it('systemError while a turn of that thread is still open is busy and interrupted', async () => {
    const { tree, world, hear } = build()
    world.add('h1', ROOT, 'systemError')
    hear(started('h1'))
    const check = await tree.check()
    expect(check.snapshot.busy).toEqual(['h1'])
    const options = sweepOptions()
    const sweeping = tree.sweep(options)
    await vi.advanceTimersByTimeAsync(10)
    expect(world.interrupts).toContain('h1/')
    world.set('h1', 'idle')
    hear(completed('h1'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await sweeping).toBe('quiescent')
  })
})

describe('unknown threads', () => {
  it('a turn from an unlisted thread blocks; placed under the root it is read each snapshot, interrupted by a sweep, and released once idle', async () => {
    const { tree, world, hear } = build()
    // The edge was never written: not in the listing, but the thread itself knows its parent.
    world.add('ghost', ROOT, 'active', { edge: false })
    hear(started('ghost'))
    const first = await tree.check()
    expect(first.snapshot.members).toEqual(['ghost'])
    expect(first.snapshot.busy).toEqual(['ghost'])
    const options = sweepOptions()
    const sweeping = tree.sweep(options)
    await vi.advanceTimersByTimeAsync(10)
    expect(world.interrupts).toContain('ghost/')
    world.set('ghost', 'idle')
    hear(completed('ghost'))
    await vi.advanceTimersByTimeAsync(2_000)
    expect(await sweeping).toBe('quiescent')
    expect(world.reads.filter((id) => id === 'ghost').length).toBeGreaterThan(1)
  })

  it('an edge-less grandchild is placed through its parent and held until idle', async () => {
    const { tree, world, hear } = build()
    world.add('child', ROOT, 'idle')
    world.add('grandchild', 'child', 'active', { edge: false })
    hear(started('grandchild'))
    const check = await tree.check()
    expect(check.snapshot.members).toEqual(['child', 'grandchild'])
    expect(check.snapshot.busy).toEqual(['grandchild'])
  })

  it('a chain through unlisted intermediates places every thread on it', async () => {
    const { tree, world, hear } = build()
    world.add('a', ROOT, 'idle', { edge: false })
    world.add('b', 'a', 'idle', { edge: false })
    world.add('c', 'b', 'active', { edge: false })
    hear(started('c'))
    const check = await tree.check()
    expect(check.snapshot.members).toEqual(['a', 'b', 'c'])
    expect(check.snapshot.busy).toEqual(['c'])
  })

  it('a thread whose chain ends at another root is ruled out and never blocks or voids again', async () => {
    const { tree, world, hear } = build()
    world.threads.set('p', { parent: null, status: 'idle' })
    world.threads.set('stranger', { parent: 'p', status: 'active' })
    hear(started('stranger'))
    const check = await tree.check()
    expect(check.snapshot.members).toEqual([])
    expect(check.snapshot.calm).toBe(true)
    const reads = world.reads.length
    hear(started('stranger'))
    hear(started('p'))
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(true)
    // Nothing was read for them again (the root and the listing are read each time).
    expect(world.reads.slice(reads).filter((id) => id === 'stranger' || id === 'p')).toEqual([])
  })

  it('a chain through a missing intermediate is inconclusive: kept unknown, retried, blocks only while active, never ruled out', async () => {
    const { tree, world, hear } = build()
    world.add('mid', ROOT, 'idle', { edge: false, unreadable: true })
    world.add('leaf', 'mid', 'active', { edge: false })
    hear(started('leaf'))
    const blocked = await tree.check()
    expect(blocked.snapshot.members).toEqual([])
    expect(blocked.snapshot.unknownActive).toBe(true)
    expect(blocked.snapshot.calm).toBe(false)
    // It goes idle: no longer blocks, and it is still not ruled out.
    world.set('leaf', 'idle')
    hear(completed('leaf'))
    const idle = await tree.check()
    expect(idle.snapshot.calm).toBe(true)
    // The intermediate becomes readable: the chain resolves into the tree.
    world.threads.get('mid')!.unreadable = false
    world.set('leaf', 'active')
    hear(started('leaf'))
    const placed = await tree.check()
    expect(placed.snapshot.members).toEqual(['leaf', 'mid'])
    expect(placed.snapshot.busy).toEqual(['leaf'])
  })

  it('a read that fails once is retried at the next snapshot, not held against the thread', async () => {
    const { tree, world, hear } = build()
    world.add('ghost', ROOT, 'active', { edge: false, unreadable: true })
    hear(started('ghost'))
    expect((await tree.check()).snapshot.unknownActive).toBe(true)
    world.threads.get('ghost')!.unreadable = false
    const check = await tree.check()
    expect(check.snapshot.members).toEqual(['ghost'])
    expect(check.snapshot.unknownActive).toBe(false)
  })

  it('eight parent links are followed; nine are inconclusive', async () => {
    for (const links of [8, 9]) {
      const { tree, world, hear } = build()
      let parent = ROOT
      for (let i = 1; i < links; i += 1) {
        world.add(`n${i}`, parent, 'idle', { edge: false })
        parent = `n${i}`
      }
      world.add('deep', parent, 'active', { edge: false })
      hear(started('deep'))
      const check = await tree.check()
      if (links === 8) expect(check.snapshot.members).toContain('deep')
      else {
        expect(check.snapshot.members).toEqual([])
        expect(check.snapshot.unknownActive).toBe(true)
        // Not ruled out: a later look reads it again.
        const reads = world.reads.length
        await tree.check()
        expect(world.reads.length).toBeGreaterThan(reads + 2)
      }
    }
  })

  it('a placed thread that is listed later is counted once', async () => {
    const { tree, world, hear } = build()
    world.add('ghost', ROOT, 'active', { edge: false })
    hear(started('ghost'))
    expect((await tree.check()).snapshot.members).toEqual(['ghost'])
    world.threads.get('ghost')!.edge = true
    const check = await tree.check()
    expect(check.snapshot.members).toEqual(['ghost'])
    expect(check.snapshot.busy).toEqual(['ghost'])
  })

  it('an unlisted thread that was active before the hold began is collected and placed before the first pair', async () => {
    const { tree, world, statuses } = build()
    world.add('ghost', ROOT, 'active', { edge: false })
    world.add('quiet', ROOT, 'idle', { edge: false })
    // Heard by the process (a status broadcast), but before any run held the thread.
    statuses.note(note('thread/status/changed', { threadId: 'ghost', status: { type: 'active' } }))
    statuses.note(note('thread/status/changed', { threadId: 'quiet', status: { type: 'idle' } }))
    const first = await tree.check()
    expect(first.snapshot.members).toEqual(['ghost'])
    expect(first.snapshot.busy).toEqual(['ghost'])
    // The idle one is ignored: never read.
    expect(world.reads).not.toContain('quiet')
  })
})

describe('validation of the server\'s answers', () => {
  const badRows: Array<[string, (world: World) => void]> = [
    ['a row without a parent', (world) => (world.rows = () => [{ id: 'h1', status: { type: 'idle' } }])],
    ['a row without a status', (world) => (world.rows = () => [{ id: 'h1', parentThreadId: ROOT }])],
    ['a row with an unknown status', (world) => (world.rows = () => [{ id: 'h1', parentThreadId: ROOT, status: { type: 'weird' } }])],
    ['the root itself in the listing', (world) => (world.rows = () => [{ id: ROOT, parentThreadId: 'x', status: { type: 'idle' } }])],
    // Not a shape problem, but proof that the listing holds a thread of another root.
    [
      'a row that descends from another root',
      (world) => {
        world.threads.set('elsewhere', { parent: null, status: 'idle' })
        world.rows = () => [{ id: 'h1', parentThreadId: 'elsewhere', status: { type: 'idle' } }]
      }
    ]
  ]
  it.each(badRows)('%s ends tree mode and interrupts nobody', async (_name, corrupt) => {
    const { tree, world } = build()
    corrupt(world)
    await expect(tree.check()).rejects.toBeInstanceOf(TreeOff)
    await expect(tree.sweep(sweepOptions())).rejects.toBeInstanceOf(TreeOff)
    expect(world.interrupts).toEqual([])
  })

  it('an error response to the listing or to the read of the root is final after one failure, with no retry loop', async () => {
    for (const break_ of [(world: World) => world.listFails.push(new RpcRefused('state DB unavailable')), (world: World) => world.readRootFails.push(new RpcRefused('nope'))]) {
      const { tree, world } = build()
      break_(world)
      const result = await untilQuiet(tree, 5_000)
      expect(result.error).toBeInstanceOf(TreeOff)
      expect(world.lists.length).toBeLessThanOrEqual(1)
    }
  })

  it('a transport failure is retried with backoff, never concluded from, and the mode stays', async () => {
    const { tree, world } = build()
    world.listFails.push(new Error('timeout'), new Error('timeout'), new Error('timeout'))
    const result = await untilQuiet(tree, 20_000)
    expect(result.error).toBeUndefined()
    expect(result.done).toBe(true)
    // Failed at 0, retried after 0.5 s, 1 s and 2 s, then the pair.
    expect(world.lists.slice(0, 4).map((at) => at - T0)).toEqual([0, 500, 1_500, 3_500])
  })

  it('a sweep during transport failures keeps interrupting the floor and what the last snapshot showed busy', async () => {
    const { tree, world, hear } = build()
    world.add('h1', ROOT, 'active')
    hear(started('h1'))
    await tree.check()
    // Every listing of the sweep fails: only the snapshot taken before it can say who is busy.
    for (let i = 0; i < 20; i += 1) world.listFails.push(new Error('timeout'))
    const listsBefore = world.lists.length
    const options = sweepOptions()
    const sweeping = tree.sweep({ ...options, deadlineAt: Date.now() + 1_200 })
    await vi.advanceTimersByTimeAsync(1_500)
    expect(await sweeping).toBe('deadline')
    expect(world.lists.length - listsBefore).toBeGreaterThanOrEqual(2)
    expect(world.interrupts.filter((entry) => entry === 'h1/').length).toBeGreaterThanOrEqual(2)
    expect(options.interruptFloor.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})

describe('listed rows whose parent the listing lacks', () => {
  it('a helper whose own row is not written yet (an edge without a thread row) keeps tree mode: it is placed through its own read, and busy while it runs', async () => {
    const { tree, world, hear } = build()
    world.add('mid', ROOT, 'idle', { edge: false })
    world.add('leaf', 'mid', 'active')
    hear(started('leaf'))
    const check = await tree.check()
    expect(check.snapshot.members).toEqual(['leaf', 'mid'])
    expect(check.snapshot.busy).toEqual(['leaf'])
  })

  it('an archived intermediate (not readable) keeps tree mode too: its listed child is still a member and busy', async () => {
    const { tree, world } = build()
    world.add('mid', ROOT, 'idle', { edge: false, unreadable: true })
    world.add('leaf', 'mid', 'active')
    const check = await tree.check()
    expect(check.snapshot.members).toEqual(['leaf'])
    expect(check.snapshot.busy).toEqual(['leaf'])
    // Nothing was ruled out: once the intermediate can be read, it joins.
    world.threads.get('mid')!.unreadable = false
    expect((await tree.check()).snapshot.members).toEqual(['leaf', 'mid'])
  })
})

describe('listed rows whose ancestry is not established', () => {
  it('an active one holds the pair but is never interrupted, nor is anything below it; once its ancestry is read it is', async () => {
    const { tree, world } = build()
    world.add('mid', ROOT, 'idle', { edge: false, unreadable: true })
    world.add('leaf', 'mid', 'active')
    world.add('leaf2', 'leaf', 'active')
    const check = await tree.check()
    expect(check.snapshot.busy.sort()).toEqual(['leaf', 'leaf2'])
    expect(check.snapshot.targets).toEqual([])
    expect(check.snapshot.calm).toBe(false)
    let outcome: string | undefined
    void tree.sweep(sweepOptions({ deadlineAt: Date.now() + 800 })).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(outcome).toBe('deadline')
    expect(world.interrupts).toEqual([])
    // The intermediate can be read now: the rows are in the tree, and a sweep may stop them.
    world.threads.get('mid')!.unreadable = false
    expect((await tree.check()).snapshot.targets.sort()).toEqual(['leaf', 'leaf2'])
  })
})

describe('a snapshot the sweep gave up on', () => {
  /** Reads of the ids in `held` wait until `release()`. */
  function gated(world: World, held: string[]) {
    const pending: Array<() => void> = []
    let gate = false
    const ports: Partial<TreePorts> = {
      read: (id) => (gate && held.includes(id) ? new Promise((resolve) => pending.push(() => resolve(world.read(id)))) : Promise.resolve(world.read(id)))
    }
    return { ports, close: () => void (gate = true), release: () => pending.splice(0).forEach((answer) => answer()) }
  }
  const members = (tree: HelperTree) => tree as unknown as { placed: Map<string, string> }

  it('asks for nothing more and places nothing when a walk is answered after the release', async () => {
    const world = new World()
    world.add('p2', ROOT, 'idle', { edge: false })
    world.add('p1', 'p2', 'idle', { edge: false })
    world.add('leaf', 'p1', 'active')
    const gate = gated(world, ['p1'])
    const { tree } = build(world, { ports: gate.ports })
    gate.close()
    let outcome: string | undefined
    void tree.sweep(sweepOptions({ deadlineAt: Date.now() + 500 })).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(700)
    expect(outcome).toBe('deadline')
    gate.release()
    await vi.advanceTimersByTimeAsync(200)
    expect(world.reads).not.toContain('p2')
    expect(members(tree).placed.size).toBe(0)
  })

  it('changes no placed status when a refresh is answered after the release', async () => {
    const world = new World()
    world.add('ghost', ROOT, 'active', { edge: false })
    const gate = gated(world, ['ghost'])
    const { tree, hear } = build(world, { ports: gate.ports })
    hear(started('ghost'))
    await tree.check()
    expect(members(tree).placed.get('ghost')).toBe('active')
    gate.close()
    let outcome: string | undefined
    void tree.sweep(sweepOptions({ deadlineAt: Date.now() + 500 })).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(700)
    expect(outcome).toBe('deadline')
    world.set('ghost', 'idle')
    gate.release()
    await vi.advanceTimersByTimeAsync(200)
    expect(members(tree).placed.get('ghost')).toBe('active')
  })

  it('an already aborted signal does not leave the promise it waited on unhandled', async () => {
    vi.useRealTimers()
    const unhandled: unknown[] = []
    const listen = (reason: unknown): void => void unhandled.push(reason)
    process.on('unhandledRejection', listen)
    try {
      const { tree } = build()
      const abort = new AbortController()
      abort.abort()
      const within = (tree as unknown as { within(promise: Promise<unknown>, ms: number, signal: AbortSignal): Promise<{ kind: string }> }).within
      expect((await within.call(tree, Promise.reject(new Error('late')), 50, abort.signal)).kind).toBe('aborted')
      await new Promise((done) => setTimeout(done, 30))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', listen)
    }
  })

  it('the pause that ends a sweep round does not run past the deadline', async () => {
    const { tree } = build(undefined, { timing: { pairGapMs: 5_000, sweepRoundMs: 100 } })
    let outcome: string | undefined
    void tree.sweep(sweepOptions({ deadlineAt: Date.now() + 600 })).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(700)
    expect(outcome).toBe('deadline')
  })
})

describe('sweep deadline', () => {
  it('a read that hangs near the deadline does not hold the sweep past it; what it answers later is dropped', async () => {
    const world = new World()
    world.add('h1', ROOT, 'active')
    let slow = false
    const late: Array<() => void> = []
    const { tree } = build(world, {
      ports: {
        read: (id) => {
          if (!slow) return Promise.resolve(world.read(id))
          return new Promise((resolve) => late.push(() => resolve(world.read(id))))
        }
      }
    })
    await tree.check()
    slow = true
    const options = sweepOptions({ deadlineAt: Date.now() + 1_000 })
    let outcome: string | undefined
    void tree.sweep(options).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(1_050)
    expect(outcome).toBe('deadline')
    // The hanging read is answered long after the run was released: nothing changes and nothing is interrupted.
    const last = tree.last
    const interrupts = world.interrupts.length
    world.set('h1', 'idle')
    for (const answer of late) answer()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(tree.last).toBe(last)
    expect(world.interrupts.length).toBe(interrupts)
  })
})

describe('systemError of a thread nobody lists', () => {
  it('an unlisted helper that was flagged systemError while its turn is open still holds the pair, and is never interrupted', async () => {
    const { tree, world, hear } = build()
    // Its placement read is refused (ancestry inconclusive); only the process's own notifications speak.
    world.add('ghost', ROOT, 'systemError', { edge: false, unreadable: true })
    hear(started('ghost'))
    hear(note('thread/status/changed', { threadId: 'ghost', status: { type: 'systemError' } }))
    const options = sweepOptions({ deadlineAt: Date.now() + 1_000 })
    let first = await tree.check()
    expect(first.snapshot.unknownActive).toBe(true)
    await vi.advanceTimersByTimeAsync(250)
    expect((await tree.check()).quiescent).toBe(false)
    // The sweep sees it busy but never interrupts a thread it could not place.
    let outcome: string | undefined
    void tree.sweep(options).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(1_200)
    expect(outcome).toBe('deadline')
    expect(world.interrupts).toEqual([])
    // Its turn ends: now it is settled.
    hear(completed('ghost'))
    first = await tree.check()
    expect(first.snapshot.unknownActive).toBe(false)
    expect(await checksUntilQuiet(tree)).toBeGreaterThan(0)
  })
})

describe('a placed member whose read is refused', () => {
  it('keeps the status the process last announced for it', async () => {
    const { tree, world, hear } = build()
    world.add('ghost', ROOT, 'active', { edge: false })
    hear(started('ghost'))
    expect((await tree.check()).snapshot.busy).toEqual(['ghost'])
    world.threads.get('ghost')!.unreadable = true
    const check = await tree.check()
    expect(check.snapshot.members).toEqual(['ghost'])
    expect(check.snapshot.busy).toEqual(['ghost'])
  })
})

function sweepOptions(overrides: Partial<SweepOptions> = {}) {
  return {
    deadlineAt: Date.now() + 10_000,
    interruptRoot: vi.fn(),
    interruptFloor: vi.fn(),
    dead: () => false,
    ...overrides
  } satisfies SweepOptions
}

async function sweepUntilDone(tree: HelperTree, options: SweepOptions): Promise<string> {
  let outcome: string | undefined
  void tree.sweep(options).then((value) => (outcome = value))
  for (let waited = 0; outcome === undefined && waited < 12_000; waited += 50) await vi.advanceTimersByTimeAsync(50)
  return outcome ?? 'running'
}

describe('sweep', () => {
  it('interrupts the root every round while it is active, and what is busy under it with an empty turn id', async () => {
    const { tree, world, hear } = build()
    world.set(ROOT, 'active')
    world.add('h1', ROOT, 'active')
    world.add('h2', 'h1', 'active')
    world.add('ghost', ROOT, 'active', { edge: false })
    hear(started('ghost'))
    const options = sweepOptions()
    void tree.sweep(options)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(options.interruptRoot.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(new Set(world.interrupts)).toEqual(new Set(['h1/', 'h2/', 'ghost/']))
    // Idle or settled threads are not interrupted.
    world.add('idle', ROOT, 'idle')
    world.add('settled', ROOT, 'systemError')
    world.add('unloaded', ROOT, 'notLoaded')
    await vi.advanceTimersByTimeAsync(1_100)
    expect(world.interrupts.filter((entry) => ['idle/', 'settled/', 'unloaded/'].includes(entry))).toEqual([])
  })

  it('interrupts the floor helpers each round', async () => {
    const { tree } = build(undefined, { floor: ['direct'] })
    const options = sweepOptions({ deadlineAt: Date.now() + 1_100 })
    void tree.sweep(options)
    await vi.advanceTimersByTimeAsync(1_300)
    expect(options.interruptFloor.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('catches a helper that appears in round two, after its spawner went idle', async () => {
    const { tree, world } = build()
    world.set(ROOT, 'active')
    let interrupted = false
    const options = sweepOptions({
      interruptRoot: vi.fn(() => {
        // The interrupt lands: the spawner stops, and the helper it was just spawning shows up.
        if (interrupted) return
        interrupted = true
        world.set(ROOT, 'idle')
        world.add('late', ROOT, 'active')
      })
    })
    void tree.sweep(options)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(world.interrupts).toContain('late/')
  })

  it('stops at a pair, and says so', async () => {
    const { tree, world } = build()
    world.add('h1', ROOT, 'active')
    const options = sweepOptions()
    let outcome: string | undefined
    void tree.sweep(options).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(600)
    expect(outcome).toBeUndefined()
    world.set('h1', 'idle')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(outcome).toBe('quiescent')
  })

  it('gives up at the deadline with a helper still active', async () => {
    const { tree, world } = build()
    world.add('stubborn', ROOT, 'active')
    const options = sweepOptions({ deadlineAt: Date.now() + 2_000 })
    let outcome: string | undefined
    void tree.sweep(options).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(2_600)
    expect(outcome).toBe('deadline')
  })

  it('ends when the process is gone', async () => {
    const { tree, world } = build()
    world.add('h1', ROOT, 'active')
    let dead = false
    let outcome: string | undefined
    void tree.sweep(sweepOptions({ dead: () => dead })).then((value) => (outcome = value))
    await vi.advanceTimersByTimeAsync(300)
    dead = true
    await vi.advanceTimersByTimeAsync(600)
    expect(outcome).toBe('closed')
  })
})

/** Snapshots, 250 ms apart, until a pair completes; how many it took. */
async function checksUntilQuiet(tree: HelperTree, limit = 8): Promise<number> {
  for (let count = 1; count <= limit; count += 1) {
    await vi.advanceTimersByTimeAsync(250)
    if ((await tree.check()).quiescent) return count
  }
  throw new Error('never quiescent')
}

describe('ordering on one connection', () => {
  /** Notifications and responses share one queue, as on the app-server's stdout: a response is delivered after everything queued before it. */
  function wired() {
    const statuses = new ThreadStatuses()
    const world = new World()
    const queue: Array<() => void> = []
    let tree!: HelperTree
    const flush = (): void => {
      while (queue.length) queue.shift()!()
    }
    const respond = <T>(compute: () => T): Promise<T> =>
      new Promise((resolve, reject) => {
        let value: T
        try {
          value = compute()
        } catch (error) {
          queue.push(() => reject(error))
          queueMicrotask(flush)
          return
        }
        queue.push(() => resolve(value))
        queueMicrotask(flush)
      })
    const queueNotification = (notification: CodexNotification): void => {
      queue.push(() => {
        statuses.note(notification)
        tree.noteWake(notification)
      })
    }
    tree = new HelperTree(
      ROOT,
      { now: () => Date.now(), read: (id) => respond(() => world.read(id)), list: (ancestor) => respond(() => world.list(ancestor)), interrupt: () => undefined },
      statuses,
      { running: () => [] },
      TIMING
    )
    return { tree, world, queueNotification, statuses }
  }

  it('the "active" notification of a thread that ran a turn between two reads arrives before the response that shows it idle, and voids the pair', async () => {
    const { tree, world, queueNotification } = wired()
    world.add('h1', ROOT, 'idle')
    await tree.check()
    await vi.advanceTimersByTimeAsync(250)
    // h1 ran a turn between the two reads: active, then idle. Its "active" notification is queued
    // first; the "idle" one only after the second snapshot's responses.
    world.set('h1', 'active')
    queueNotification(started('h1'))
    world.set('h1', 'idle')
    const second = await tree.check()
    expect(second.snapshot.calm).toBe(true)
    expect(second.quiescent).toBe(false)
    // The wake-up arrived during the second snapshot, so it is inside the window of the next pair too; a
    // late "idle" is only one more wake-up. Neither releases early; a quiet pair follows.
    queueNotification(completed('h1'))
    expect(await checksUntilQuiet(tree)).toBeGreaterThan(1)
  })

  it('a thread whose row appears only at the third snapshot but whose "active" arrived before the second blocks the second', async () => {
    const { tree, world, queueNotification } = wired()
    await tree.check()
    await vi.advanceTimersByTimeAsync(250)
    // Not listed and not readable yet (its edge and row are still being written), but its turn was announced.
    world.add('late', ROOT, 'active', { edge: false, unreadable: true })
    queueNotification(started('late'))
    const second = await tree.check()
    expect(second.quiescent).toBe(false)
    expect(second.snapshot.unknownActive).toBe(true)
    // Now the row exists and the thread finished.
    world.threads.get('late')!.edge = true
    world.threads.get('late')!.unreadable = false
    world.set('late', 'idle')
    queueNotification(completed('late'))
    await vi.advanceTimersByTimeAsync(250)
    const third = await tree.check()
    expect(third.snapshot.members).toEqual(['late'])
    expect(third.quiescent).toBe(false)
    expect(await checksUntilQuiet(tree)).toBeGreaterThan(0)
  })
})

describe('traffic of other threads', () => {
  it('50 wake-ups from an unrelated, already ruled-out root in a second cost no extra snapshot and reset no clock', async () => {
    const { tree, world, hear } = build()
    world.threads.set('other', { parent: null, status: 'idle' })
    hear(note('thread/status/changed', { threadId: 'other', status: { type: 'idle' } }))
    await tree.check()
    const activityBefore = tree.lastActivityAt
    await vi.advanceTimersByTimeAsync(300)
    const listsBefore = world.lists.length
    let done = false
    const stop = new AbortController()
    void tree.untilQuiescent(stop.signal).then(() => (done = true))
    for (let i = 0; i < 50; i += 1) {
      hear(note('thread/status/changed', { threadId: 'other', status: { type: i % 2 ? 'active' : 'idle' } }))
      await vi.advanceTimersByTimeAsync(20)
    }
    expect(done).toBe(true)
    expect(world.lists.length - listsBefore).toBeLessThanOrEqual(2)
    expect(tree.lastActivityAt).toBe(activityBefore)
    stop.abort()
  })

  it("an unplaced thread's wake-ups reset the activity clock only once it is placed", async () => {
    const { tree, world, hear } = build()
    world.add('ghost', ROOT, 'idle', { edge: false, unreadable: true })
    const before = tree.lastActivityAt
    await vi.advanceTimersByTimeAsync(5_000)
    hear(started('ghost'))
    hear(completed('ghost'))
    await tree.check()
    expect(tree.lastActivityAt).toBe(before)
    world.threads.get('ghost')!.unreadable = false
    await tree.check()
    await vi.advanceTimersByTimeAsync(5_000)
    hear(started('ghost'))
    expect(tree.lastActivityAt).toBe(Date.now())
  })

  it("the root's and a member's wake-ups are activity", async () => {
    const { tree, world, hear } = build()
    world.add('h1', ROOT)
    await tree.check()
    await vi.advanceTimersByTimeAsync(1_000)
    hear(started('h1'))
    expect(tree.lastActivityAt).toBe(Date.now())
    await vi.advanceTimersByTimeAsync(1_000)
    hear(started(ROOT))
    expect(tree.lastActivityAt).toBe(Date.now())
  })
})
