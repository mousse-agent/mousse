import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { MousseMainService } from '../src/mms/MousseMainService'
import type { MmsProfileServices } from '../src/mms/MmsProfileServices'
import { ERROR_INFO_CAPABILITY } from '../src/shared/errors'
import type { Thread } from '../src/shared/types'
import { lifecycleHarness } from './fixtures/resource-lifecycle-harness'
import { fixtureGit as git } from './support/fixtureGit'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { ensureSnapshotWorkspaceAsync, threadStorePath } from '../src/mms/workspace/SnapshotWorkspace'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { actionOptions } from './fixtures/gitFoundation'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'

/** Puts a file only this thread has in its scratch folder: unpublished work a purge may discard only with consent. */
function soleCopy(services: MmsProfileServices, threadId: string): string {
  const path = services.threads.getThreadDir(threadId)
  mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
  writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
  writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId, workspaceRelativePath: 'terminal-workspace' }))
  return path
}
const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId) => ({ parentThreadId, rootThreadId, relationship: 'subagent' as const })

/**
 * Gives `threadId` a worktree of a fresh repository, as a thread's first editing turn makes it, with a changed tracked
 * file and a new one nobody committed: work that exists only in that folder.
 */
function worktreeWithChanges(services: MmsProfileServices, home: string, root: string, threadId: string) {
  const repo = join(root, `repo-${threadId.slice(0, 8)}`)
  mkdirSync(repo); git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base'])
  const repositoryId = resolveRepositoryIdentity(repo).key
  const worktree = join(home, 'repositories', repositoryId, 'worktrees', 'threads', threadId, 'main')
  mkdirSync(join(worktree, '..'), { recursive: true })
  const branch = `mousse/thread/${threadId}/main`, retainedRef = `refs/mousse/threads/${threadId}/main`
  git(repo, ['worktree', 'add', '-b', branch, worktree])
  const sha = git(repo, ['rev-parse', 'HEAD']); git(repo, ['update-ref', retainedRef, sha])
  const location = services.threads.getThreadDir(threadId)
  writeFileSync(join(location, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId, worktreePath: worktree, branch, repositoryId, retainedRef, baseSha: sha, headSha: sha, integrationTarget: { baseSha: sha, checkoutPath: repo }, lifecycle: 'ready' }))
  mkdirSync(join(location, 'journal'), { recursive: true })
  writeFileSync(join(location, 'journal', '0000000000000001.json'), JSON.stringify({ schemaVersion: 1, sequence: 1, operationId: 'provision', operationType: 'workspace-provision', state: 'planned', expectedPreState: { branch, worktreePath: worktree } }))
  writeFileSync(join(location, 'journal', '0000000000000002.json'), JSON.stringify({ schemaVersion: 1, sequence: 2, operationId: 'provision', operationType: 'workspace-provision', state: 'completed' }))
  writeFileSync(join(worktree, 'a.txt'), 'changed, not committed\n')
  writeFileSync(join(worktree, 'notes.txt'), 'only here\n')
  const refs = () => git(repo, ['for-each-ref', '--format=%(refname) %(objectname)'])
  return { repo, worktree, branch, retainedRef, refs, before: refs() }
}

/** Archive first, then delete: only an archived thread is deleted, for good, with its subagent threads. */
describe('threads.delete', () => {
  it('refuses a thread that is not archived, from any client, and leaves it as it was', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'still in use' })
      const folder = f.services.threads.getThreadDir(thread.id)
      for (const client of [f.rpc, cli]) {
        await expect(client.request('threads.delete', { threadId: thread.id })).rejects.toMatchObject({ code: 'thread_not_archived', message: 'Archive the thread before deleting it.' })
      }
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(existsSync(join(folder, 'meta.json'))).toBe(true)
    } finally { await f.close() }
  })

  it('deletes an archived thread and its subagent threads for good, with no trash left behind', async () => {
    const f = await lifecycleHarness()
    try {
      const subagentOf = (parentThreadId: string, rootThreadId = parentThreadId) => ({ parentThreadId, rootThreadId, relationship: 'subagent' as const })
      const parent = f.services.threads.createThread('Archived parent')
      const child = f.services.threads.createThread('Its subagent', undefined, undefined, { lineage: subagentOf(parent.id) })
      const grandchild = f.services.threads.createThread('Its nested subagent', undefined, undefined, { lineage: subagentOf(child.id, parent.id) })
      const folders = [parent, child, grandchild].map((thread) => f.services.threads.getThreadDir(thread.id))
      await f.rpc.request('threads.settle', { threadId: parent.id, settled: true })
      const reply = await f.rpc.request<{ threads: Thread[]; lifecycle: { state: string } }>('threads.delete', { threadId: parent.id })
      expect(reply.lifecycle.state).toBe('purged')
      const ids = new Set(reply.threads.map((thread) => thread.id))
      for (const thread of [parent, child, grandchild]) {
        expect(ids.has(thread.id), thread.name).toBe(false)
        expect(f.services.threads.getThread(thread.id), thread.name).toBeUndefined()
      }
      expect(f.services.threads.lifecycleStore.require(parent.id).state).toBe('purged')
      for (const folder of folders) expect(existsSync(folder), folder).toBe(false)
      // Nothing waits in a trash: the inventory lists no thread that could be restored.
      const inventory = await f.rpc.request<{ lifecycles: Array<{ taskId: string; state: string }> }>('threads.inventory', {})
      expect(inventory.lifecycles.filter((record) => record.state === 'trashed')).toEqual([])
    } finally { await f.close() }
  })

  it('keeps the worktrees of the thread and its subagent threads: their folders, branches, uncommitted changes and refs stay', async () => {
    const f = await lifecycleHarness()
    try {
      const parent = f.services.threads.createThread('Archived with a worktree')
      const child = f.services.threads.createThread('Its subagent, with its own worktree', undefined, undefined, { lineage: subagentOf(parent.id) })
      const work = [parent, child].map((thread) => worktreeWithChanges(f.services, f.home, f.root, thread.id))
      const folders = [parent, child].map((thread) => f.services.threads.getThreadDir(thread.id))
      await f.rpc.request('threads.settle', { threadId: parent.id, settled: true })
      // As the app's Delete sends it, after its confirmation.
      const reply = await f.rpc.request<{ lifecycle: { state: string; purge?: { keptWork?: boolean } } }>('threads.delete', { threadId: parent.id, discard: true })
      expect(reply.lifecycle.state).toBe('purged')
      expect(reply.lifecycle.purge?.keptWork).toBe(true)
      // The threads are gone.
      for (const thread of [parent, child]) expect(f.services.threads.getThread(thread.id), thread.name).toBeUndefined()
      for (const folder of folders) expect(existsSync(folder), folder).toBe(false)
      // Their work is where it was.
      for (const { repo, worktree, branch, retainedRef, refs, before } of work) {
        expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('changed, not committed\n')
        expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('only here\n')
        expect(git(worktree, ['status', '--porcelain']).split(/\r?\n/).sort()).toEqual([' M a.txt', '?? notes.txt'])
        expect(git(worktree, ['branch', '--show-current'])).toBe(branch)
        expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(`branch refs/heads/${branch}`)
        expect(git(repo, ['for-each-ref', '--format=%(refname)', retainedRef])).toBe(retainedRef)
        // Not one ref was written, moved or deleted.
        expect(refs()).toBe(before)
      }
      // The next start does not take them either.
      await f.services.lifecycle.recoverAll()
      expect(await f.services.finishCutShortDeletes()).toEqual([])
      for (const { worktree } of work) expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('only here\n')
    } finally { await f.close() }
  })

  it('deletes a thread for good from the CLI too, without asking to discard the work in its worktree, which stays', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const thread = f.services.threads.createThread('Archived, deleted from a script')
      const { worktree, refs, before } = worktreeWithChanges(f.services, f.home, f.root, thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      await cli.request('threads.delete', { threadId: thread.id })
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('only here\n')
      expect(refs()).toBe(before)
    } finally { await f.close() }
  })

  it('deletes a thread whose worktree cannot be checked (a broken .git), and leaves that folder as it is', async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Archived, its worktree broken')
      const { worktree } = worktreeWithChanges(f.services, f.home, f.root, thread.id)
      // Its link to the repository is broken: Mousse can't check it, so it could never remove it, but that no longer matters.
      rmSync(join(worktree, '.git'), { force: true })
      writeFileSync(join(worktree, '.git'), 'gitdir: nowhere\n')
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      await f.rpc.request('threads.delete', { threadId: thread.id, discard: true })
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(readFileSync(join(worktree, '.git'), 'utf8')).toBe('gitdir: nowhere\n')
      expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('only here\n')
      expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('changed, not committed\n')
    } finally { await f.close() }
  })

  it('a preview that keeps the work cannot authorize a purge that releases a hidden store thread’s snapshots', async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Archived, in a folder without Git')
      const work = join(f.root, 'no-git-folder'); mkdirSync(work)
      writeFileSync(join(work, 'a.txt'), 'first\n')
      const directory = f.services.threads.getThreadDir(thread.id)
      const space = await ensureSnapshotWorkspaceAsync({ threadDirectory: directory, threadId: thread.id, workTree: work })
      await new ThreadActionService(directory).runCheckpointedAction({ ...actionOptions(space.record.workTree, 'turn'), threadId: thread.id }, () => writeFileSync(join(work, 'a.txt'), 'second\n'))
      const store = threadStorePath(thread.id, f.home)
      const refs = () => git(store, ['for-each-ref', '--format=%(refname) %(objectname)'])
      const before = refs()
      expect(before).toContain(`refs/mousse/threads/${thread.id}/`)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      await f.services.trashThread(thread.id, undefined, undefined, true)
      const keeping = await f.services.lifecycle.cleanup.preview(thread.id, { keepWork: true })
      expect(keeping.keepWork).toBe(true)
      // Signed for a purge that keeps the work: one that would release the snapshots is refused, and nothing goes.
      await expect(f.services.lifecycle.cleanup.purge({ taskId: thread.id, operationId: 'removes', expectedGeneration: keeping.generation, previewDigest: keeping.digest, discard: true, human: true })).rejects.toMatchObject({ code: 'resource_purge_preview_stale' })
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
      expect(refs()).toBe(before)
      // The delete itself keeps them.
      const purged = await f.services.lifecycle.cleanup.purge({ taskId: thread.id, operationId: 'keeps', expectedGeneration: keeping.generation, previewDigest: keeping.digest, discard: true, human: true, keepWork: true })
      expect(purged.state).toBe('purged')
      expect(refs()).toBe(before)
      expect(readFileSync(join(work, 'a.txt'), 'utf8')).toBe('second\n')
    } finally { await f.close() }
  })

  it('keeps the worktree of a delete an older version left half done when the next start resumes it', async () => {
    const f = await lifecycleHarness()
    let restarted: MousseMainService | undefined
    try {
      const thread = f.services.threads.createThread('Cut short by an older version')
      const { worktree, branch, refs } = worktreeWithChanges(f.services, f.home, f.root, thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      await f.services.trashThread(thread.id)
      // What an older version wrote at its purge boundary: the worktree and its refs in the ledger, to be removed.
      const preview = await f.services.lifecycle.cleanup.preview(thread.id)
      expect(preview.items.some((item) => item.kind === 'worktree')).toBe(true)
      const store = f.services.threads.lifecycleStore
      store.enableCleanupWriter()
      store.update(thread.id, (current) => {
        current.state = 'purge-started'; current.generation++
        current.purge = { ...preview, operationId: 'older-purge', startedAt: new Date().toISOString(), discardAuthorized: true }
      })
      const before = refs()
      await f.main.stop()
      restarted = await MousseMainService.create({ homeDir: f.home, repoRoot: f.root, requireOwnership: false, headless: true })
      const services = await restarted.getProfileServices(f.alice.id)
      const record = services.threads.lifecycleStore.require(thread.id)
      expect(record.state).toBe('purged')
      expect(record.purge?.keptWork).toBe(true)
      expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('changed, not committed\n')
      expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('only here\n')
      expect(git(worktree, ['branch', '--show-current'])).toBe(branch)
      expect(refs()).toBe(before)
    } finally { await restarted?.stop(); await f.close() }
  })

  it('leaves a half-done older delete pending and untouched when it cannot be set to keep the work, and keeps the work at a later start', async () => {
    const f = await lifecycleHarness()
    let restarted: MousseMainService | undefined
    try {
      const thread = f.services.threads.createThread('Cut short, its ledger not writable at first')
      const { worktree, branch, refs } = worktreeWithChanges(f.services, f.home, f.root, thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      await f.services.trashThread(thread.id)
      const preview = await f.services.lifecycle.cleanup.preview(thread.id)
      expect(preview.items.some((item) => item.kind === 'worktree')).toBe(true)
      const store = f.services.threads.lifecycleStore
      store.enableCleanupWriter()
      store.update(thread.id, (current) => {
        current.state = 'purge-started'; current.generation++
        current.purge = { ...preview, operationId: 'older-purge', startedAt: new Date().toISOString(), discardAuthorized: true }
      })
      const ledger = () => JSON.stringify(store.require(thread.id).purge)
      const pending = ledger()
      const before = refs()
      const expectWorkThere = () => {
        expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('changed, not committed\n')
        expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('only here\n')
        expect(git(worktree, ['branch', '--show-current'])).toBe(branch)
        expect(refs()).toBe(before)
      }
      await f.main.stop()

      // First start: the write that would set it to keep the work fails once (a file another program holds, say).
      const update = ResourceLifecycleStore.prototype.update
      let failures = 0
      const spy = vi.spyOn(ResourceLifecycleStore.prototype, 'update').mockImplementation(function (this: ResourceLifecycleStore, taskId: string, ...rest: unknown[]) {
        if (taskId === thread.id && failures === 0) { failures++; throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }) }
        return (update as (...args: unknown[]) => unknown).call(this, taskId, ...rest)
      } as typeof update)
      restarted = await MousseMainService.create({ homeDir: f.home, repoRoot: f.root, requireOwnership: false, headless: true })
      let services = await restarted.getProfileServices(f.alice.id)
      spy.mockRestore()
      expect(failures).toBe(1)
      // Not resumed: still pending, its ledger exactly as it was, and the work all there.
      expect(services.threads.lifecycleStore.require(thread.id).state).toBe('purge-started')
      expect(JSON.stringify(services.threads.lifecycleStore.require(thread.id).purge)).toBe(pending)
      expectWorkThere()
      await restarted.stop(); restarted = undefined

      // A later start writes it, then finishes the delete keeping the work.
      restarted = await MousseMainService.create({ homeDir: f.home, repoRoot: f.root, requireOwnership: false, headless: true })
      services = await restarted.getProfileServices(f.alice.id)
      const record = services.threads.lifecycleStore.require(thread.id)
      expect(record.state).toBe('purged')
      expect(record.purge?.keptWork).toBe(true)
      expectWorkThere()
    } finally { vi.restoreAllMocks(); await restarted?.stop(); await f.close() }
  })

  it('discards unpublished work only for the app; anyone else is refused and the thread goes back to Archived', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'sole copy scratch' })
      const path = f.services.threads.getThreadDir(thread.id)
      mkdirSync(join(path, 'terminal-workspace'), { recursive: true })
      writeFileSync(join(path, 'terminal-workspace', 'sole-copy.txt'), 'retained output')
      writeFileSync(join(path, 'terminal-workspace.json'), JSON.stringify({ schemaVersion: 1, kind: 'task-terminal-scratch', threadId: thread.id, workspaceRelativePath: 'terminal-workspace' }))
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })

      // The CLI asks to discard too, but only a person in the app may: refused, and nothing is lost.
      await expect(cli.request('threads.delete', { threadId: thread.id, discard: true })).rejects.toMatchObject({ code: 'thread_has_unpublished_work' })
      const kept = f.services.threads.getThread(thread.id)
      expect(kept?.settledAt).toBeTruthy()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')

      // The app asks after its confirmation; the thread and its only copy go for good.
      await f.rpc.request('threads.delete', { threadId: thread.id, discard: true })
      expect(f.services.threads.getThread(thread.id)).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(path)).toBe(false)
    } finally { await f.close() }
  })

  it('checks the whole family before purging anything: a refusal on the thread or a subagent thread leaves all of them', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      for (const unpublished of ['parent', 'child'] as const) {
        const parent = f.services.threads.createThread(`Parent, ${unpublished} has unpublished work`)
        const child = f.services.threads.createThread('Its subagent', undefined, undefined, { lineage: subagentOf(parent.id) })
        soleCopy(f.services, unpublished === 'parent' ? parent.id : child.id)
        await f.rpc.request('threads.settle', { threadId: parent.id, settled: true })
        await expect(cli.request('threads.delete', { threadId: parent.id })).rejects.toMatchObject({ code: 'thread_has_unpublished_work' })
        for (const thread of [parent, child]) {
          expect(f.services.threads.getThread(thread.id), `${unpublished}: ${thread.name}`).toBeTruthy()
          expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
        }
        expect(f.services.threads.getThread(parent.id)?.settledAt).toBeTruthy()
      }
    } finally { await f.close() }
  })

  it('finishes a delete whose purge failed when Delete is pressed again', async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Held by an editor')
      const folder = f.services.threads.getThreadDir(thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      const purge = vi.spyOn(f.services.lifecycle.cleanup, 'purge').mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }))
      await expect(f.rpc.request('threads.delete', { threadId: thread.id })).rejects.toThrow()
      // Not listed while the delete waits, and not "not found": the same Delete finishes it.
      expect(f.services.threads.getThread(thread.id)).toBeUndefined()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
      purge.mockRestore()
      await f.rpc.request('threads.delete', { threadId: thread.id })
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(folder)).toBe(false)
    } finally { await f.close() }
  })

  it('finishes at the next start a delete that stopped between the trash and the purge', async () => {
    const f = await lifecycleHarness()
    let restarted: MousseMainService | undefined
    try {
      const thread = f.services.threads.createThread('Cut short')
      const folder = soleCopy(f.services, thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      // The process ends after the trash: the purge never runs.
      vi.spyOn(f.services.lifecycle.cleanup, 'purge').mockRejectedValueOnce(new Error('the process ended'))
      await expect(f.rpc.request('threads.delete', { threadId: thread.id, discard: true })).rejects.toThrow()
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('trashed')
      await f.main.stop()
      restarted = await MousseMainService.create({ homeDir: f.home, repoRoot: f.root, requireOwnership: false, headless: true })
      const services = await restarted.getProfileServices(f.alice.id)
      // The app's delete was confirmed with its unpublished work, so the start finishes it as asked.
      expect(services.threads.lifecycleStore.require(thread.id).state).toBe('purged')
      expect(existsSync(folder)).toBe(false)
    } finally { await restarted?.stop(); await f.close() }
  })

  it('puts a thread left in the trash without consent to discard its unpublished work back in Archived', async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Trashed by a script')
      soleCopy(f.services, thread.id)
      f.services.threads.setThreadSettled(thread.id, true)
      await f.services.trashThread(thread.id)
      expect(await f.services.finishCutShortDeletes()).toEqual([{ taskId: thread.id, outcome: 'archived' }])
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeTruthy()
      expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
    } finally { await f.close() }
  })

  it('never purges a thread in the trash with no recorded delete: it goes back to Archived', async () => {
    const f = await lifecycleHarness()
    try {
      // An older build's trash, left in progress at the upgrade: nothing to discard, and no delete was asked for here.
      const thread = f.services.threads.createThread('Left in the old trash')
      await f.services.trashThread(thread.id)
      expect(await f.services.finishCutShortDeletes()).toEqual([{ taskId: thread.id, outcome: 'archived' }])
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeTruthy()
    } finally { await f.close() }
  })

  it("drops a delete's consent when its thread is restored, so a later trash cannot reuse it", async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('Restored after a cut-short delete')
      soleCopy(f.services, thread.id)
      await f.rpc.request('threads.settle', { threadId: thread.id, settled: true })
      vi.spyOn(f.services.lifecycle.cleanup, 'purge').mockRejectedValueOnce(new Error('the process ended'))
      await expect(f.rpc.request('threads.delete', { threadId: thread.id, discard: true })).rejects.toThrow()
      const intents = join(f.services.threads.lifecycleStore.root, 'delete-intents.json')
      expect(JSON.parse(readFileSync(intents, 'utf8'))[thread.id]).toMatchObject({ human: true, discard: true })
      await f.services.restoreThread(thread.id)
      expect(JSON.parse(readFileSync(intents, 'utf8'))[thread.id]).toBeUndefined()
      // Trashed again without a delete: the start puts it back, its only copy kept.
      await f.services.trashThread(thread.id)
      expect(await f.services.finishCutShortDeletes()).toEqual([{ taskId: thread.id, outcome: 'archived' }])
      expect(readFileSync(join(f.services.threads.getThreadDir(thread.id), 'terminal-workspace', 'sole-copy.txt'), 'utf8')).toBe('retained output')
    } finally { await f.close() }
  })

  it("keeps Mousse's own delete of a thread with unpublished work in Archived instead of failing", async () => {
    const f = await lifecycleHarness()
    try {
      const thread = f.services.threads.createThread('A failed start')
      soleCopy(f.services, thread.id)
      await f.services.deleteThreadForGood(thread.id, { human: false, discard: false, internal: true })
      expect(f.services.threads.getThread(thread.id)?.settledAt).toBeTruthy()
      const plain = f.services.threads.createThread('Nothing unpublished')
      await f.services.deleteThreadForGood(plain.id, { human: false, discard: false, internal: true })
      expect(f.services.threads.lifecycleStore.require(plain.id).state).toBe('purged')
    } finally { await f.close() }
  })
})

describe('the steps of a delete', () => {
  it('are not protocol methods: no client can trash, restore, purge or set an automatic emptying', async () => {
    const f = await lifecycleHarness()
    try {
      const cli = await f.connect(f.alice.id, [ERROR_INFO_CAPABILITY], 'cli')
      const { thread } = await f.rpc.request<{ thread: Thread }>('threads.create', { name: 'in use' })
      f.services.threads.setThreadSettled(thread.id, true)
      for (const client of [f.rpc, cli]) {
        for (const method of ['threads.trash', 'threads.restore', 'threads.purge']) await expect(client.request(method, { threadId: thread.id })).rejects.toThrow()
        await expect(client.request('threads.configureTrash', { graceDays: 1, automaticPurge: true })).rejects.toThrow()
      }
      expect(f.services.threads.lifecycleStore.require(thread.id).state).toBe('active')
      expect(f.services.lifecycle.cleanup.policy().automaticPurge).toBe(false)
    } finally { await f.close() }
  })
})

describe('the move of the old trash to Archived', () => {
  it("brings back a bot's execution thread that was deleted before its home thread, with the real restore", async () => {
    const f = await lifecycleHarness()
    try {
      const home = f.services.threads.createThread('Bot home')
      const execution = f.services.threads.createThread('Bot run', undefined, undefined, { ownerThreadId: home.id })
      // As an older build left it: the run's thread trashed on its own, then its home thread.
      await f.services.trashThread(execution.id)
      await f.services.trashThread(home.id)
      rmSync(join(f.services.threads.lifecycleStore.root, 'trash-returned-to-archive.json'), { force: true })
      expect(await f.services.returnTrashToArchive()).toMatchObject({ done: true, restored: [home.id, execution.id], failed: [] })
      expect(f.services.threads.lifecycleStore.require(home.id).state).toBe('active')
      expect(f.services.threads.lifecycleStore.require(execution.id).state).toBe('active')
      expect(f.services.threads.getThread(home.id)?.settledAt).toBeTruthy()
      // A thread another owns is not archived on its own.
      expect(f.services.threads.getThread(execution.id)?.settledAt).toBeUndefined()
    } finally { await f.close() }
  })
})
