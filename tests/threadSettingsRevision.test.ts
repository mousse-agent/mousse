import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { ROUTED_METHODS, routedKeysAt } from '../src/shared/bridge/routed'
import type { Thread } from '../src/shared/types'

let home: string
let mms: MousseMainService
let ctx: HandlerContext
const call = <T = { thread: Thread }>(method: string, params: Record<string, unknown>) => dispatchMethod(ctx, method, params) as Promise<T>

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-settings-revision-')))
  process.env.MOUSSE_HOME = home
  mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
  await mms.start()
  ctx = { mms, globalSequence: () => 0, connection: { clientType: 'gui' } } as unknown as HandlerContext
})

afterEach(async () => {
  vi.restoreAllMocks()
  await mms.stop()
  rmSync(home, { recursive: true, force: true })
  delete process.env.MOUSSE_HOME
})

/**
 * Replaces the turn's own wait for its thread's folders (the second wait of a send: the handler waits first) with
 * `turnWait`. Returns whether the turn's wait was reached.
 */
function turnFolderWait(turnWait: () => Promise<'ready' | 'stopped' | 'aborted'>): () => boolean {
  const original = mms.orchestrator.waitForThreadFolders.bind(mms.orchestrator)
  let calls = 0
  vi.spyOn(mms.orchestrator, 'waitForThreadFolders').mockImplementation((...args) => (calls++ === 0 ? original(...args) : turnWait()))
  return () => calls >= 2
}

/** The profile's run engine. */
function engine() {
  return (mms.orchestrator as unknown as { runEngine: import('../src/mms/run/RunEngine').RunEngine }).runEngine
}

async function projectThread(): Promise<Thread> {
  const path = join(home, 'repo')
  mkdirSync(path, { recursive: true })
  execFileSync('git', ['init', '-q'], { cwd: path })
  const project = (await call<{ project: { id: string } }>('projects.open', { path })).project
  return (await call('threads.create', { name: 'New Chat', projectId: project.id })).thread
}

describe("a thread's settings revision", () => {
  it('comes with a new thread, and every write of the model or mode moves it on, by any route', async () => {
    const thread = await projectThread()
    const start = thread.settingsRevision!
    expect(Number.isSafeInteger(start)).toBe(true)
    const set = (await call('threads.setPermissionMode', { threadId: thread.id, mode: 'ask' })).thread
    expect(set.settingsRevision).toBe(start + 1)
    // Another route (an agent, the run engine) writes through the store and moves it on too.
    mms.orchestrator.setThreadPermissionMode(thread.id, 'full')
    expect(mms.threads.getThread(thread.id)?.settingsRevision).toBe(start + 2)
    // Writes that are not the model or mode leave it.
    mms.threads.updateThreadMeta(thread.id, { name: 'Renamed' })
    expect(mms.threads.getThread(thread.id)?.settingsRevision).toBe(start + 2)
  })

  it('a conditional mode set applies only on the current revision, and refuses a stale one with the current values', async () => {
    const thread = await projectThread()
    const applied = (await call('threads.setPermissionMode', { threadId: thread.id, mode: 'full', ifRevision: thread.settingsRevision })).thread
    expect(applied.permissionMode).toBe('full')
    const refused = call('threads.setPermissionMode', { threadId: thread.id, mode: 'ask', ifRevision: thread.settingsRevision })
    await expect(refused).rejects.toMatchObject({ code: 'thread_settings_changed', details: { threadId: thread.id, revision: applied.settingsRevision, permissionMode: 'full' } })
    expect(mms.threads.getThread(thread.id)?.permissionMode).toBe('full')
  })

  it('ABA: Ask, Full access, Ask set elsewhere still refuses a set read before them', async () => {
    const thread = await projectThread()
    const read = (await call('threads.setPermissionMode', { threadId: thread.id, mode: 'ask' })).thread
    for (const mode of ['full', 'ask']) await call('threads.setPermissionMode', { threadId: thread.id, mode })
    expect(mms.threads.getThread(thread.id)?.permissionMode).toBe(read.permissionMode)
    await expect(call('threads.setPermissionMode', { threadId: thread.id, mode: 'full', ifRevision: read.settingsRevision })).rejects.toMatchObject({ code: 'thread_settings_changed' })
    expect(mms.threads.getThread(thread.id)?.permissionMode).toBe('ask')
  })

  it('a conditional model set works the same way, and a bad revision is refused as invalid', async () => {
    const thread = await projectThread()
    const model = { instanceId: 'claude', model: 'sonnet' }
    const applied = (await call('threads.setModel', { threadId: thread.id, model, ifRevision: thread.settingsRevision })).thread
    expect(applied.modelOverride?.model).toBe('sonnet')
    expect(applied.settingsRevision).toBe(thread.settingsRevision! + 1)
    await expect(call('threads.setModel', { threadId: thread.id, model: { ...model, model: 'opus' }, ifRevision: thread.settingsRevision })).rejects.toMatchObject({ code: 'thread_settings_changed' })
    expect(mms.threads.getThread(thread.id)?.modelOverride?.model).toBe('sonnet')
    await expect(call('threads.setPermissionMode', { threadId: thread.id, mode: 'ask', ifRevision: -1 })).rejects.toMatchObject({ code: 'invalid_params' })
  })

  it('is new in the routed rows, so an older computer is never sent it (the caller refuses the call as outdated)', () => {
    for (const method of ['threads.setModel', 'threads.setPermissionMode']) {
      const row = ROUTED_METHODS[method]!
      expect(routedKeysAt(row, row.version)).toContain('ifRevision')
      expect(routedKeysAt(row, row.version - 1)).not.toContain('ifRevision')
    }
  })
})

describe('a send bound to what was shown (expect)', () => {
  /** The turn is not run here: the send's options are what the daemon hands it. */
  function captureTurns() {
    return vi.spyOn(mms.orchestrator, 'send').mockResolvedValue({ message: '', actions: [] } as never)
  }
  const sonnet = { instanceId: 'claude', model: 'sonnet' }

  it('runs on the shown model and at most the shown mode, never queues, and refuses anything changed', async () => {
    const thread = await projectThread()
    const set = (await call('threads.setModel', { threadId: thread.id, model: sonnet })).thread
    const withMode = (await call('threads.setPermissionMode', { threadId: thread.id, mode: 'ask' })).thread
    const turns = captureTurns()
    const expect_ = { permissionMode: 'ask', model: { instanceId: 'claude', llmProvider: set.modelOverride!.llmProvider, model: 'sonnet' }, settingsRevision: withMode.settingsRevision }
    await call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: expect_ })
    expect(turns).toHaveBeenCalledTimes(1)
    expect(turns.mock.calls[0]![2]).toMatchObject({ permissionMode: 'ask', refuseQueue: true, modelOverride: expect.objectContaining({ instanceId: 'claude', model: 'sonnet' }) })

    // Each difference is refused before a turn is asked for: the mode, the model, the revision (ABA included).
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { ...expect_, permissionMode: 'full' } })).rejects.toMatchObject({ code: 'thread_settings_changed', details: { permissionMode: 'ask' } })
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { ...expect_, model: { ...expect_.model, model: 'opus' } } })).rejects.toMatchObject({ code: 'thread_settings_changed' })
    for (const mode of ['full', 'ask']) await call('threads.setPermissionMode', { threadId: thread.id, mode })
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: expect_ })).rejects.toMatchObject({ code: 'thread_settings_changed', details: { revision: withMode.settingsRevision! + 2 } })
    expect(turns).toHaveBeenCalledTimes(1)
  })

  it('reads the shown model the way a create stores it: a legacy provider name resolves to the same instance', async () => {
    const thread = await projectThread()
    const stored = (await call('threads.setModel', { threadId: thread.id, model: sonnet })).thread.modelOverride!
    expect(stored.instanceId).toBe('claude')
    const turns = captureTurns()
    mms.settings.set({ permissions: { defaultMode: 'ask' } })
    // Named by the provider an older window still sends, with no instance: the same model, so the send goes.
    await call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'ask', model: { llmProvider: 'claude-subscription', model: 'sonnet' } } })
    expect(turns).toHaveBeenCalledTimes(1)
    expect(turns.mock.calls[0]![2]).toMatchObject({ modelOverride: expect.objectContaining({ instanceId: 'claude', model: 'sonnet' }) })
  })

  it('compares the mode a thread without its own runs in: the profile default, changed after it was shown', async () => {
    const thread = await projectThread()
    const turns = captureTurns()
    mms.settings.set({ permissions: { defaultMode: 'full' } })
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'accept_edits' } })).rejects.toMatchObject({ code: 'thread_settings_changed', details: { permissionMode: 'full' } })
    expect(turns).not.toHaveBeenCalled()
    await call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'full' } })
    expect(turns).toHaveBeenCalledTimes(1)
  })

  it('a bound send that would wait in the queue is refused at admission, before it is a run', async () => {
    const thread = await projectThread()
    mms.settings.set({ permissions: { defaultMode: 'ask' } })
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', forceQueue: true, expect: { permissionMode: 'ask' } })).rejects.toMatchObject({ code: 'thread_busy' })
    expect(mms.threads.loadMessageQueue(thread.id)).toEqual([])
    // No cancelled, unbound run is left for a later continuation to take as its predecessor.
    expect(engine().listRuns(thread.id)).toEqual([])
  })

  it('is compared again inside the engine admission: a change made while the send waits for the thread lock is refused', async () => {
    const thread = await projectThread()
    mms.settings.set({ permissions: { defaultMode: 'ask' } })
    const run = engine()
    const lock = (run as unknown as { mutex: { withLock(key: string, fn: () => Promise<void>): Promise<void> } }).mutex
    let release!: () => void
    const held = lock.withLock(thread.id, () => new Promise<void>((resolve) => { release = resolve }))
    // The send has passed the handler's comparison once it asks the engine to admit it.
    let reached!: () => void
    const atDispatch = new Promise<void>((resolve) => { reached = resolve })
    const dispatch = run.dispatch.bind(run)
    vi.spyOn(run, 'dispatch').mockImplementation((...args: Parameters<typeof run.dispatch>) => { reached(); return dispatch(...args) })
    const sending = call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'ask' } })
    await atDispatch
    await call('threads.setPermissionMode', { threadId: thread.id, mode: 'full' })
    release()
    await held
    await expect(sending).rejects.toMatchObject({ code: 'thread_settings_changed', details: { permissionMode: 'full' } })
    expect(run.listRuns(thread.id)).toEqual([])
  })

  it('a bound turn that loses the thread lease while it waits for its folders is refused with its run cancelled, never queued', async () => {
    const thread = await projectThread()
    mms.settings.set({ permissions: { defaultMode: 'ask' } })
    const { tryAcquireExecutionLease } = await import('../src/mms/queue/ThreadExecutionLease')
    let peer: { release?: () => void } | null = null
    const waits = turnFolderWait(async () => {
      // Another process takes the thread between the admission and the turn's own lease.
      peer = tryAcquireExecutionLease(mms.threads.getThreadDir(thread.id), { source: 'test-peer' }) as never
      return 'ready'
    })
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'ask' } })).rejects.toMatchObject({ code: 'thread_busy' })
    expect(waits()).toBe(true)
    expect(peer).not.toBeNull()
    expect(mms.threads.loadMessageQueue(thread.id)).toEqual([])
    expect(engine().listRuns(thread.id).map((entry) => entry.status)).toEqual(['cancelled'])
    ;(peer as unknown as { release?: () => void })?.release?.()
  })

  it('a bound turn the profile shutdown stops while it waits for its folders is refused with its run cancelled, never queued', async () => {
    const thread = await projectThread()
    mms.settings.set({ permissions: { defaultMode: 'ask' } })
    // The profile stops while the turn waits: its wait ends 'aborted' with the shutdown as the reason.
    let stopping = false
    const waits = turnFolderWait(async () => { stopping = true; return 'aborted' })
    const shutdown = (mms.orchestrator as unknown as { isShutdownAbort(reason: unknown): boolean }).isShutdownAbort.bind(mms.orchestrator)
    vi.spyOn(mms.orchestrator as unknown as { isShutdownAbort(reason: unknown): boolean }, 'isShutdownAbort').mockImplementation((reason) => stopping || shutdown(reason))
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'ask' } })).rejects.toMatchObject({ code: 'thread_busy' })
    expect(waits()).toBe(true)
    expect(mms.threads.loadMessageQueue(thread.id)).toEqual([])
    expect(engine().listRuns(thread.id).map((entry) => entry.status)).toEqual(['cancelled'])
  })

  it('takes expect at a new version of the routed row, and setModel refuses unknown keys', async () => {
    const row = ROUTED_METHODS['orchestrator.send']!
    expect(routedKeysAt(row, row.version)).toContain('expect')
    expect(routedKeysAt(row, row.version - 1)).not.toContain('expect')
    const thread = await projectThread()
    await expect(call('threads.setModel', { threadId: thread.id, model: sonnet, ifRevison: 0 })).rejects.toMatchObject({ code: 'invalid_params' })
  })
})

describe("another computer's thread rows", () => {
  it('carry the settings revision from the same lists snapshot as the mode and model, and an unknown one stays unknown', async () => {
    const { threadRow } = await import('../src/mms/bridge/routed/listRows')
    const thread = await projectThread()
    await call('threads.setPermissionMode', { threadId: thread.id, mode: 'ask' })
    const { MmsListsSource } = await import('../src/mms/bridge/remote/MmsListsSource')
    // The lists snapshot this computer sends another of the user's computers, from its real thread store.
    const source = new MmsListsSource({
      projects: { listProjects: () => [] },
      threads: { listAllThreads: () => mms.threads.listAllThreads() },
      orchestrator: { getTurnSnapshot: () => ({}) },
      threadRuntimes: { getActivitySnapshot: () => ({}) },
      platform: { chats: { snapshot: () => ({ chats: [] }), onChange: () => () => undefined } }
    } as never, undefined, { private: true })
    const sent = (source.snapshot().threads as Array<Record<string, unknown>>).find((entry) => entry.id === thread.id)!
    const owned = mms.threads.getThread(thread.id)!
    expect(sent.settingsRevision).toBe(owned.settingsRevision)
    // As that computer's merged lists take it.
    const row = threadRow({ ...sent, id: 'node-1:' + thread.id }, 0, { node: 'node-1', offline: false })
    expect(row.settingsRevision).toBe(owned.settingsRevision)
    expect(row.permissionMode).toBe('ask')
    const older = threadRow({ id: 'node-1:x', name: 'x', permissionMode: 'ask' }, 0, { node: 'node-1', offline: false })
    expect(older).not.toHaveProperty('settingsRevision')
  })
})
