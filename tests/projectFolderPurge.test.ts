/**
 * Purging a thread that worked in its project's own folder releases its pins and its receipts' refs in that folder's
 * repository, and nothing else: no file in the folder is deleted or moved, HEAD, the index and the branches stay, files
 * a restore kept (`refs/mousse/preserved/*`) stay, and another thread's pins stay. A purge that stops partway resumes
 * and finishes the release.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThreadActionService } from '../src/mms/actions/ThreadActionService'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourcePurgeService } from '../src/mms/lifecycle/ResourcePurgeService'
import { lifecycleGit as git } from '../src/mms/lifecycle/WorktreeRetirementService'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'
import { ThreadWorkspaceManager } from '../src/mms/workspace/ThreadWorkspaceManager'

const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mousse-folder-purge-'))); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const repo = join(root, 'repo'); mkdirSync(repo)
  git(repo, ['init', '-q', '-b', 'main']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'base'])

  // The thread's record and one recorded action in the project folder: a snapshot pair, a receipt and the thread's pin.
  new ThreadWorkspaceManager(location).ensureProjectFolder('task', 'main', repo)
  await new ThreadActionService(location).runCheckpointedAction({
    threadId: 'task', turnId: 'edit', conversationBranchId: 'main', workspacePath: repo, actor: { kind: 'user' }, allowDirtyInput: true,
    presentationMessageStart: 0, presentationMessageEnd: 0, nativeContextBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'exact' }
  }, async () => { writeFileSync(join(repo, 'a.txt'), 'edited by the thread\n') })

  // What must survive: the person's own work, another thread's pin and files a restore kept.
  writeFileSync(join(repo, 'mine.txt'), 'the person\'s, uncommitted\n')
  git(repo, ['add', 'mine.txt'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['update-ref', 'refs/mousse/threads/other/main', head])
  git(repo, ['update-ref', 'refs/mousse/preserved/op-1-abc', head])

  const coordinator = new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {}, projectPurged: () => {} })
  return { location, repo, store, coordinator }
}

const refsIn = (repo: string) => git(repo, ['for-each-ref', '--format=%(refname)', 'refs/mousse/']).split('\n').filter(Boolean).sort()
const folderState = (repo: string) => ({
  head: git(repo, ['rev-parse', 'HEAD']),
  branches: git(repo, ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/']),
  index: git(repo, ['ls-files', '--stage']),
  files: ['a.txt', 'mine.txt'].map((name) => readFileSync(join(repo, name), 'utf8'))
})

test('purging a project-folder thread releases its pins and receipt refs only, and touches nothing in the folder', async () => {
  const f = await fixture()
  const before = refsIn(f.repo)
  expect(before).toEqual(expect.arrayContaining(['refs/mousse/threads/task/main', 'refs/mousse/threads/other/main', 'refs/mousse/preserved/op-1-abc']))
  expect(before.filter((ref) => ref.startsWith('refs/mousse/changes/'))).toHaveLength(2)
  const folder = folderState(f.repo)

  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.blockers).toEqual([])
  const refItems = preview.items.filter((item) => item.kind === 'ref').map((item) => item.identity).sort()
  expect(refItems).toEqual(before.filter((ref) => ref.startsWith('refs/mousse/changes/') || ref === 'refs/mousse/threads/task/main'))
  // No worktree item and no path in the person's folder.
  expect(preview.items.some((item) => item.kind === 'worktree' || (item.kind === 'path' && item.identity.startsWith(f.repo)))).toBe(false)

  const record = await f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })
  expect(record.state).toBe('purged')
  expect(existsSync(record.location)).toBe(false)
  expect(refsIn(f.repo)).toEqual(['refs/mousse/preserved/op-1-abc', 'refs/mousse/threads/other/main'])
  expect(folderState(f.repo)).toEqual(folder)
  // Asking again changes nothing.
  expect((await f.coordinator.purge({ taskId: 'task', operationId: 'purge' })).state).toBe('purged')
  expect(refsIn(f.repo)).toEqual(['refs/mousse/preserved/op-1-abc', 'refs/mousse/threads/other/main'])
}, 60_000)

test('a purge that stops partway through the refs resumes and finishes releasing them', async () => {
  const f = await fixture()
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  const preview = await f.coordinator.cleanup.preview('task')
  const remove = (ResourcePurgeService.prototype as unknown as { remove: (...args: unknown[]) => Promise<void> }).remove
  let refsRemoved = 0
  vi.spyOn(ResourcePurgeService.prototype as unknown as { remove: (...args: unknown[]) => Promise<void> }, 'remove').mockImplementation(async function (this: unknown, ...args: unknown[]) {
    const item = args[0] as { kind: string }
    if (item.kind === 'ref' && ++refsRemoved === 2) throw new Error('interrupted')
    return remove.apply(this, args)
  })
  await expect(f.coordinator.purge({ taskId: 'task', operationId: 'purge', expectedGeneration: preview.generation, previewDigest: preview.digest })).rejects.toBeDefined()
  expect(f.store.require('task').state).toBe('purge-started')
  vi.restoreAllMocks()

  // Resumed with the same operation: the ref already gone is skipped, the rest go, and the purge completes.
  expect((await f.coordinator.purge({ taskId: 'task', operationId: 'purge' })).state).toBe('purged')
  expect(refsIn(f.repo)).toEqual(['refs/mousse/preserved/op-1-abc', 'refs/mousse/threads/other/main'])
}, 60_000)

test('a purge names no ref when the project folder now holds another repository', async () => {
  const f = await fixture()
  await f.coordinator.trash({ taskId: 'task', operationId: 'trash' })
  rmSync(join(f.repo, '.git'), { recursive: true, force: true })
  git(f.repo, ['init', '-q', '-b', 'main'])
  const preview = await f.coordinator.cleanup.preview('task')
  expect(preview.items.filter((item) => item.kind === 'ref')).toEqual([])
  expect(preview.retained).toEqual(expect.arrayContaining([expect.objectContaining({ reason: expect.stringContaining("no longer holds the thread's repository") })]))
  expect(readFileSync(join(f.repo, 'mine.txt'), 'utf8')).toBe('the person\'s, uncommitted\n')
}, 60_000)
