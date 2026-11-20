/**
 * A thread agent's wake-ups (`ThreadWakes`): kept in a file so a restart keeps them, fired into the thread's inbox at
 * their time or when what they wait for happens, with the bots' limits (the loop guard, give-up hours). The decisions on
 * a pull request's or thread's state are the bots' own, tested in botWakeSources; here is what the service adds.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_SAME_WAKES } from '../../src/shared/bots/personal/wakes'
import type { WakePullRequestState, WakeThreadState } from '../../src/mms/bots/wakeSources'
import type { ThreadWakePayload } from '../../src/mms/run/types'
import { PR_WAKE_READ_MS } from '../../src/mms/bots/wakeSources'
import { THREAD_WAKE_TICK_MS, ThreadWakes } from '../../src/mms/wakes/ThreadWakes'

const T0 = Date.parse('2026-11-20T10:00:00.000Z')
const MINUTE = 60_000

type PrRead = WakePullRequestState | { none: true } | { problem: string }

function harness(options: { dir?: string; now?: number } = {}) {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'mousse-thread-wakes-'))
  const file = join(dir, 'thread-wakes.json')
  const clock = { now: options.now ?? T0 }
  const posts: Array<{ threadId: string; payload: ThreadWakePayload; key: string }> = []
  const changed: string[] = []
  const timers: Array<{ callback: () => void; ms: number; cleared: boolean }> = []
  const threads = new Map<string, WakeThreadState>()
  const existing = new Set(['t1', 't2', 'other'])
  const personWrote = new Map<string, string>()
  let pr: PrRead = { state: 'open', title: 'Add wakes', headSha: 'abcdef1234', checkRuns: [{ name: 'build', state: 'pending' }] }
  let prReads = 0
  let failPosts = false
  const wakes = new ThreadWakes({
    file,
    post: (threadId, payload, key) => {
      if (failPosts) throw new Error('database busy')
      posts.push({ threadId, payload, key })
    },
    changed: (threadId) => changed.push(threadId),
    threadState: (_from, threadId) => threads.get(threadId) ?? { state: 'deleted' },
    pullRequestState: async () => {
      prReads += 1
      return pr
    },
    personLastWroteAt: (threadId) => personWrote.get(threadId),
    threadExists: (threadId) => existing.has(threadId),
    now: () => clock.now,
    setTimer: (callback, ms) => {
      const timer = { callback, ms, cleared: false }
      timers.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (timer) => {
      (timer as unknown as { cleared: boolean }).cleared = true
    }
  })
  const armed = () => timers.filter((timer) => !timer.cleared).at(-1)
  /** Moves the clock and runs the armed timer, as the daemon would; waits for the pass it starts. */
  const advance = async (ms: number) => {
    await settle()
    clock.now += ms
    const timer = armed()
    if (!timer) return
    timer.cleared = true
    timer.callback()
    await settle()
  }
  return {
    dir, file, clock, posts, changed, timers, threads, existing, personWrote, wakes, armed, advance,
    setPr: (next: PrRead) => { pr = next },
    prReads: () => prReads,
    failPosts: (fail: boolean) => { failPosts = fail },
    stored: () => JSON.parse(readFileSync(file, 'utf8')) as { wakes: Array<{ id: string }> }
  }
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('thread wake-ups', () => {
  const dirs: string[] = []
  const make = (options: Parameters<typeof harness>[0] = {}) => {
    const h = harness(options)
    dirs.push(h.dir)
    return h
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('a time wake posts its notice to its thread at its time, once, then is gone', async () => {
    const h = make()
    h.wakes.start()
    const added = await h.wakes.add('t1', { brief: 'Check the nightly build', dueAt: new Date(T0 + 2 * MINUTE).toISOString() })
    expect(h.wakes.list('t1')).toEqual([{ wakeId: added.wakeId, brief: 'Check the nightly build', setAt: new Date(T0).toISOString(), dueAt: added.dueAt }])
    expect(h.changed).toEqual(['t1'])
    await h.advance(MINUTE)
    expect(h.posts).toEqual([])
    await h.advance(MINUTE)
    expect(h.posts).toHaveLength(1)
    const [post] = h.posts
    expect(post!.threadId).toBe('t1')
    expect(post!.key).toBe(`thread-wake:${added.wakeId}`)
    expect(post!.payload).toMatchObject({ kind: 'thread_wake', wakeId: added.wakeId, brief: 'Check the nightly build', attention: 'needed' })
    expect(post!.payload.text).toContain('<mousse_notice kind="thread_wake"')
    expect(post!.payload.text).toContain('The person did not write: you carry on by yourself.')
    expect(post!.payload.text).toContain('What you wrote for yourself: Check the nightly build')
    expect(post!.payload.text).not.toContain('reply=')
    expect(h.wakes.list('t1')).toEqual([])
    expect(h.stored().wakes).toEqual([])
    // Nothing waits, so nothing is armed.
    expect(h.armed()).toBeUndefined()
  })

  it('looks at least every tick however far ahead the wake is, so a timer paused by sleep catches up', async () => {
    const h = make()
    h.wakes.start()
    await h.wakes.add('t1', { brief: 'Ping in three days', dueAt: new Date(T0 + 3 * 24 * 60 * MINUTE).toISOString() })
    expect(h.armed()!.ms).toBe(THREAD_WAKE_TICK_MS)
    // The computer slept past the time: the next tick fires it, said late.
    await h.advance(3 * 24 * 60 * MINUTE + 10 * MINUTE)
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.payload.text).toMatch(/is due \(it was for /)
  })

  it('a restart keeps a wake: a new service over the same file fires it at start, said late', async () => {
    const first = make()
    first.wakes.start()
    const added = await first.wakes.add('t1', { brief: 'Read the deploy log', dueAt: new Date(T0 + 2 * MINUTE).toISOString() })
    first.wakes.close()
    const second = make({ dir: first.dir, now: T0 + 10 * MINUTE })
    expect(second.wakes.list('t1').map((view) => view.wakeId)).toEqual([added.wakeId])
    second.wakes.start()
    await settle()
    expect(second.posts.map((post) => post.key)).toEqual([`thread-wake:${added.wakeId}`])
    expect(second.posts[0]!.payload.text).toMatch(/is due \(it was for /)
    expect(second.posts[0]!.payload.label).toMatch(/^Following up · was for /)
  })

  it('a post that fails keeps the wake for the next tick', async () => {
    const h = make()
    h.wakes.start()
    await h.wakes.add('t1', { brief: 'Follow up', dueAt: new Date(T0 + MINUTE).toISOString() })
    h.failPosts(true)
    await h.advance(MINUTE)
    expect(h.wakes.list('t1')).toHaveLength(1)
    h.failPosts(false)
    await h.advance(THREAD_WAKE_TICK_MS)
    expect(h.posts).toHaveLength(1)
    expect(h.wakes.list('t1')).toEqual([])
  })

  it('refuses a wake it cannot keep, in words for the agent', async () => {
    const h = make()
    const refused = (input: Parameters<ThreadWakes['add']>[1], thread = 't1') => h.wakes.add(thread, input).then(() => 'set', (error: Error) => error.message)
    expect(await refused({ brief: '  ', dueAt: new Date(T0 + MINUTE).toISOString() })).toMatch(/needs a brief/)
    expect(await refused({ brief: 'x', dueAt: new Date(T0 - 5 * MINUTE).toISOString() })).toMatch(/has passed/)
    expect(await refused({ brief: 'x', dueAt: new Date(T0 + 8 * 24 * 60 * MINUTE).toISOString() })).toMatch(/at most 7 days ahead/)
    expect(await refused({ brief: 'x', event: { kind: 'thread', threadId: 't1' } })).toMatch(/That is this thread/)
    h.threads.set('t2', { state: 'running' })
    expect(await refused({ brief: 'x', event: { kind: 'thread', threadId: 't2' }, hours: 0 })).toMatch(/more than 0, at most 168/)
    expect(await refused({ brief: 'x', event: { kind: 'thread', threadId: 't2' }, hours: 169 })).toMatch(/more than 0, at most 168/)
    h.threads.set('t2', { state: 'unreachable' })
    expect(await refused({ brief: 'x', event: { kind: 'thread', threadId: 't2' } })).toBe('Thread t2 is not available to you.')
    h.setPr({ none: true })
    expect(await refused({ brief: 'x', event: { kind: 'pr', repo: 'someone/else', number: 4 } })).toBe("someone/else is not one of the person's projects in Mousse, so its pull requests can't be watched.")
    expect(h.wakes.list('t1')).toEqual([])
  })

  it('refuses only a loop: the same wake set more than the limit since the person last wrote', async () => {
    const h = make()
    const at = new Date(T0 + 10 * MINUTE).toISOString()
    for (let i = 0; i < MAX_SAME_WAKES; i++) await h.wakes.add('t1', { brief: 'Check CI', dueAt: at })
    await expect(h.wakes.add('t1', { brief: 'Check CI', dueAt: at })).rejects.toThrow(/that is a loop/)
    // A different brief, or another thread, is not the same wake.
    await h.wakes.add('t1', { brief: 'Check CI: the flaky test was re-run', dueAt: at })
    await h.wakes.add('t2', { brief: 'Check CI', dueAt: at })
    // Once the person writes, the count starts again.
    h.clock.now += MINUTE
    h.personWrote.set('t1', new Date(h.clock.now).toISOString())
    h.clock.now += MINUTE
    await h.wakes.add('t1', { brief: 'Check CI', dueAt: at })
  })

  it('says how many wakes in a row ran without the person', async () => {
    const h = make()
    h.wakes.start()
    await h.wakes.add('t1', { brief: 'First', dueAt: new Date(T0 + MINUTE).toISOString() })
    await h.wakes.add('t1', { brief: 'Second', dueAt: new Date(T0 + MINUTE).toISOString() })
    await h.advance(MINUTE)
    expect(h.posts.map((post) => post.payload.text.match(/wake-up (\d+) in a row without the person/)?.[1])).toEqual(['1', '2'])
  })

  it('a wake on a pull request\'s checks fires once they settle, reading it at most every two minutes', async () => {
    const h = make()
    h.wakes.start()
    const added = await h.wakes.add('t1', { brief: 'Merge if green', event: { kind: 'pr', repo: 'acme/app', number: 12, on: 'checks' } })
    expect(added.label).toBe("when acme/app#12's checks finish")
    expect(h.wakes.list('t1')[0]!.waitsFor).toBe("when acme/app#12's checks finish")
    const readsAtSet = h.prReads()
    await h.advance(THREAD_WAKE_TICK_MS)
    await h.advance(THREAD_WAKE_TICK_MS)
    expect(h.prReads()).toBe(readsAtSet + 1)
    expect(h.posts).toEqual([])
    h.setPr({ state: 'open', title: 'Add wakes', headSha: 'abcdef1234', checkRuns: [{ name: 'build', state: 'passing' }, { name: 'lint', state: 'failing' }] })
    await h.advance(PR_WAKE_READ_MS)
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.payload.text).toContain("pull request acme/app#12's checks have settled. Passed: 1. Failed: 1.")
    expect(h.posts[0]!.payload.label).toBeTruthy()
    expect(h.wakes.list('t1')).toEqual([])
  })

  it('a wake on a pull request that closes wakes once and says why', async () => {
    const h = make()
    h.wakes.start()
    await h.wakes.add('t1', { brief: 'Rebase after merge', event: { kind: 'pr', repo: 'acme/app', number: 12 } })
    h.setPr({ state: 'closed' })
    await h.advance(PR_WAKE_READ_MS)
    expect(h.posts[0]!.payload.text).toContain('ended without it: the pull request was closed without merging.')
  })

  it('a wake on another thread fires when its run ends, without waiting for the tick', async () => {
    const h = make()
    h.wakes.start()
    h.threads.set('t2', { state: 'running', title: 'Port the parser' })
    await h.wakes.add('t1', { brief: 'Review what t2 wrote', event: { kind: 'thread', threadId: 't2' } })
    h.wakes.threadRunEnded('t2')
    await settle()
    expect(h.posts).toEqual([])
    h.threads.set('t2', { state: 'idle', title: 'Port the parser', lastRun: { status: 'completed' } })
    h.wakes.threadRunEnded('t2')
    await settle()
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.payload.text).toContain('thread t2 finished its turn (status: completed).')
  })

  it('a wake on a thread that is archived wakes once and says why; one that waits too long gives up', async () => {
    const h = make()
    h.wakes.start()
    h.threads.set('t2', { state: 'running' })
    await h.wakes.add('t1', { brief: 'A', event: { kind: 'thread', threadId: 't2' } })
    await h.wakes.add('t1', { brief: 'B', event: { kind: 'pr', repo: 'acme/app', number: 12, on: 'review' }, hours: 1 })
    h.threads.set('t2', { state: 'archived' })
    await h.advance(THREAD_WAKE_TICK_MS)
    expect(h.posts.map((post) => post.payload.brief)).toEqual(['A'])
    expect(h.posts[0]!.payload.text).toContain('ended without it: the thread was archived.')
    h.clock.now += 60 * MINUTE
    await h.advance(0)
    expect(h.posts.map((post) => post.payload.brief)).toEqual(['A', 'B'])
    expect(h.posts[1]!.payload.text).toContain("ended without it: it didn't happen in time.")
  })

  it('cancel removes one wake; a Stop cancels all of a thread\'s and, when told, tells its agent quietly once', async () => {
    const h = make()
    h.wakes.start()
    const at = new Date(T0 + 10 * MINUTE).toISOString()
    const one = await h.wakes.add('t1', { brief: 'One', dueAt: at })
    await h.wakes.add('t1', { brief: 'Two', dueAt: at })
    await h.wakes.add('t1', { brief: 'Three', dueAt: at })
    await h.wakes.add('t2', { brief: 'Elsewhere', dueAt: at })
    expect(h.wakes.cancel('t2', one.wakeId)).toBe(false)
    expect(h.wakes.cancel('t1', one.wakeId)).toBe(true)
    expect(h.wakes.stopThread('t1', true, 'the thread was archived')).toBe(2)
    expect(h.posts).toHaveLength(1)
    expect(h.posts[0]!.payload).toMatchObject({ kind: 'thread_wake', attention: 'none', brief: 'Two\nThree' })
    expect(h.posts[0]!.payload.text).toContain('Your 2 wake-ups were cancelled: the thread was archived.')
    expect(h.wakes.stopThread('t1', true)).toBe(0)
    expect(h.posts).toHaveLength(1)
    // Deleted: cancelled without a word.
    expect(h.wakes.stopThread('t2', false)).toBe(1)
    expect(h.posts).toHaveLength(1)
    await h.advance(10 * MINUTE)
    expect(h.posts).toHaveLength(1)
  })

  it('drops the wakes of a thread that no longer exists without posting', async () => {
    const h = make()
    h.wakes.start()
    await h.wakes.add('t1', { brief: 'Gone soon', dueAt: new Date(T0 + MINUTE).toISOString() })
    h.existing.delete('t1')
    await h.advance(MINUTE)
    expect(h.posts).toEqual([])
    expect(h.stored().wakes).toEqual([])
  })
})
