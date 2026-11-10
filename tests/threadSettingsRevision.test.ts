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
  await mms.stop()
  rmSync(home, { recursive: true, force: true })
  delete process.env.MOUSSE_HOME
})

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

  it('compares the mode a thread without its own runs in: the profile default, changed after it was shown', async () => {
    const thread = await projectThread()
    const turns = captureTurns()
    mms.settings.set({ permissions: { defaultMode: 'full' } })
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'accept_edits' } })).rejects.toMatchObject({ code: 'thread_settings_changed', details: { permissionMode: 'full' } })
    expect(turns).not.toHaveBeenCalled()
    await call('orchestrator.send', { threadId: thread.id, content: 'hi', expect: { permissionMode: 'full' } })
    expect(turns).toHaveBeenCalledTimes(1)
  })

  it('a bound send that would wait in the queue is refused, as an edited prompt is', async () => {
    const thread = await projectThread()
    mms.settings.set({ permissions: { defaultMode: 'ask' } })
    await expect(call('orchestrator.send', { threadId: thread.id, content: 'hi', forceQueue: true, expect: { permissionMode: 'ask' } })).rejects.toMatchObject({ code: 'thread_busy' })
    expect(mms.threads.loadMessageQueue(thread.id)).toEqual([])
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
