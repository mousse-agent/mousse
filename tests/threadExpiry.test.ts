/**
 * Thread expiry end to end (issue #672): an expired thread is deleted for good, with its worktree, and
 * never shows in Recently deleted; its branch and the commits on it stay. The expiry's purge authority
 * holds only for a thread whose own expiry passed, and the protocol checks the times it is given.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import { dispatchMethod, type HandlerContext } from '../src/mms/protocol/handlers'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'
import { asSettingsPartial } from '../src/mms/protocol/validators'

describe('thread expiry', () => {
  let home: string
  let mms: MousseMainService
  const cleanup: string[] = []

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'mousse-thread-expiry-'))
    process.env.MOUSSE_HOME = home
    mms = await MousseMainService.create({ homeDir: home, headless: true, ownerKind: 'test' })
    await mms.start()
  })

  afterEach(async () => {
    await mms.stop()
    for (const path of [home, ...cleanup.splice(0)]) {
      try { rmSync(path, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    delete process.env.MOUSSE_HOME
  })

  const gui = (method: string, params: Record<string, unknown> = {}) =>
    dispatchMethod({ mms, globalSequence: () => 0, connection: { id: 'gui-1', clientType: 'gui' } } as unknown as HandlerContext, method, params)

  function repository(): string {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'expiry-repo-')))
    cleanup.push(path)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: path, stdio: 'pipe' })
    git('init', '-q', '-b', 'main')
    git('config', 'user.email', 'owner@example.test')
    git('config', 'user.name', 'Owner')
    git('config', 'commit.gpgsign', 'false')
    writeFileSync(join(path, 'a.txt'), 'one\n')
    git('add', '-A')
    git('commit', '-q', '-m', 'first')
    return path
  }

  it('deletes an expired thread and its worktree for good, keeps its branch, and lists it nowhere', async () => {
    const repo = repository()
    const project = mms.projects.openProject(repo)
    const thread = mms.threads.createThread('Expiring work', project.id, repo, { worktreeEnabled: true, started: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    const workspace = await new ThreadWorkspaceManager(mms.threads.getThreadDir(thread.id)).provision(thread.id, 'main', repo, undefined, undefined, undefined, { nameFrom: 'Expiring work' })
    const inWorktree = (...args: string[]) => execFileSync('git', args, { cwd: workspace.worktreePath, encoding: 'utf8' }).trim()
    writeFileSync(join(workspace.worktreePath, 'b.txt'), 'committed\n')
    inWorktree('add', 'b.txt')
    inWorktree('-c', 'user.email=a@example.test', '-c', 'user.name=A', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'work')
    const committed = inWorktree('rev-parse', 'HEAD')
    writeFileSync(join(workspace.worktreePath, 'scratch.txt'), 'not committed\n')

    mms.threads.updateThreadMeta(thread.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    expect(mms.orchestrator.isExpired(thread.id)).toBe(true)
    await mms.threadExpiry.pass()

    expect(mms.threads.getThread(thread.id)).toBeUndefined()
    expect(mms.threads.lifecycleStore.get(thread.id)?.state).toBe('purged')
    expect(existsSync(workspace.worktreePath)).toBe(false)
    // The branch and its commit stay in the repository.
    expect(execFileSync('git', ['rev-parse', `refs/heads/${workspace.branch}`], { cwd: repo, encoding: 'utf8' }).trim()).toBe(committed)
    const inventory = (await gui('threads.inventory')) as { lifecycles: Array<{ taskId: string }> }
    expect(inventory.lifecycles.map((record) => record.taskId)).not.toContain(thread.id)
  }, 120_000)

  it('deletes a subagent a cut-short delete left in the trash with its expiring thread', async () => {
    const root = mms.threads.createThread('Root', undefined, undefined, { started: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    const child = mms.threads.createThread('Helper', undefined, undefined, { started: true, ownerThreadId: root.id, lineage: { parentThreadId: root.id, rootThreadId: root.id, relationship: 'subagent' } })
    await mms.trashThread(child.id)
    expect(mms.threads.lifecycleStore.get(child.id)?.state).toBe('trashed')
    mms.threads.updateThreadMeta(root.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    await mms.threadExpiry.pass()
    expect(mms.threads.lifecycleStore.get(root.id)?.state).toBe('purged')
    expect(mms.threads.lifecycleStore.get(child.id)?.state).toBe('purged')
  }, 60_000)

  it('finishes an expiry delete a crash cut short at the next start, instead of putting it back in Archived', async () => {
    const thread = mms.threads.createThread('Cut short', undefined, undefined, { started: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    mms.threads.updateThreadMeta(thread.id, { expiresAt: new Date(Date.now() - 1000).toISOString() })
    const deletes = (mms as unknown as { threadDeletes: { setIntent(id: string, intent: unknown): void; finishCutShort(): Promise<Array<{ taskId: string; outcome: string }>> } }).threadDeletes
    // The state a crash leaves between the trash and the purge: the thread in the trash with its expiry intent.
    deletes.setIntent(thread.id, { human: false, discard: false, at: new Date().toISOString(), expiry: true })
    await mms.trashThread(thread.id)
    expect(await deletes.finishCutShort()).toEqual([{ taskId: thread.id, outcome: 'purged' }])
    expect(mms.threads.lifecycleStore.get(thread.id)?.state).toBe('purged')
  }, 60_000)

  it('gives the expiry purge authority only to a thread whose own expiry passed', async () => {
    const thread = mms.threads.createThread('Kept', undefined, undefined, { started: true, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })
    await mms.trashThread(thread.id)
    const preview = await mms.lifecycle.cleanup.preview(thread.id)
    await expect(mms.lifecycle.purge({ taskId: thread.id, operationId: 'op-expiry-1', expectedGeneration: preview.generation, previewDigest: preview.digest, authorization: 'expiry' })).rejects.toThrow(/expiry has passed/)
    expect(mms.threads.lifecycleStore.get(thread.id)?.state).toBe('trashed')
  }, 60_000)

  it('checks the times it is given, and keeps a subagent with its root', async () => {
    const created = (await gui('threads.create', { name: 'Timed', expiresAt: new Date(Date.now() + 86_400_000).toISOString(), expiryStopsRun: true })) as { thread: { id: string; expiresAt?: string; expiryStopsRun?: true } }
    expect(created.thread.expiresAt).toBeDefined()
    expect(created.thread.expiryStopsRun).toBe(true)
    await expect(gui('threads.create', { name: 'Past', expiresAt: new Date(Date.now() - 1000).toISOString() })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(gui('threads.setExpiry', { threadId: created.thread.id, expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(gui('threads.setExpiry', { threadId: created.thread.id, expiresAt: 'tomorrow' })).rejects.toMatchObject({ code: 'invalid_params' })
    const removed = (await gui('threads.setExpiry', { threadId: created.thread.id, expiresAt: null })) as { thread: { expiresAt?: string; expiryStopsRun?: true } }
    expect(removed.thread.expiresAt).toBeUndefined()
    expect(removed.thread.expiryStopsRun).toBeUndefined()
    expect(mms.threads.getThread(created.thread.id)?.expiresAt).toBeUndefined()
    const child = mms.threads.createThread('Helper', undefined, undefined, { lineage: { parentThreadId: created.thread.id, rootThreadId: created.thread.id, relationship: 'subagent' } })
    await expect(gui('threads.setExpiry', { threadId: child.id, expiresAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject({ code: 'invalid_params' })
  }, 60_000)

  it('refuses a message to an expired thread', async () => {
    const thread = mms.threads.createThread('Gone soon', undefined, undefined, { started: true, expiresAt: new Date(Date.now() - 1000).toISOString() })
    await expect(mms.orchestrator.send({ content: 'hello' } as never, false, { threadId: thread.id } as never)).rejects.toMatchObject({ code: 'thread_expired' })
  }, 60_000)

  it('saves the Runs settings, the worktree default and the private chat expiry included', () => {
    expect(asSettingsPartial({ runs: { resumeAfterUsageLimit: false, usageLimitPauseCap: 3, privateThreadExpiry: '24h' } })).toBeTruthy()
    expect(() => asSettingsPartial({ runs: { privateThreadExpiry: '2h' } })).toThrow(/privateThreadExpiry/)
  })
})
