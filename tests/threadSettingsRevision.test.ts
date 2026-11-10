import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
