import { afterEach, expect, test, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ResourceLifecycleStore } from '../src/mms/lifecycle/ResourceLifecycleStore'
import { ResourceLifecycleCoordinator } from '../src/mms/lifecycle/ResourceLifecycleCoordinator'
import type { TaskLifecycleRecord } from '../src/shared/resourceLifecycle'
import { fixtureGit as git, ownedHome } from './support/fixtureGit'
import { resolveRepositoryIdentity } from '../src/mms/git/RepositoryIdentity'
import { registerThreadLifecycleGate } from '../src/mms/queue/ThreadLifecycleAdmission'

/** Run right after the purge unlinks a path or removes a folder, as a change that lands between two of its system calls would. */
const late = vi.hoisted(() => ({ afterUnlink: undefined as undefined | ((path: string) => void), afterRmdir: undefined as undefined | ((path: string) => void) }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return {
    ...fs,
    unlinkSync: ((path) => { fs.unlinkSync(path); late.afterUnlink?.(String(path)) }) as typeof fs.unlinkSync,
    rmdirSync: ((path, options) => { fs.rmdirSync(path, options); late.afterRmdir?.(String(path)) }) as typeof fs.rmdirSync
  }
})

const roots: string[] = []
const undo: Array<() => void> = []
const realPath = process.env.PATH
afterEach(() => {
  vi.restoreAllMocks(); late.afterUnlink = undefined; late.afterRmdir = undefined; process.env.PATH = realPath
  for (const step of undo.splice(0)) step()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A trashed thread whose worktree holds a staged change, so its permanent delete discards the reviewed files. */
async function trashedWithStagedWork() {
  const root = mkdtempSync(join(tmpdir(), 'mousse-purge-discard-')); roots.push(root)
  const home = join(root, 'profile'), location = join(home, 'thread-data', 'task'); mkdirSync(location, { recursive: true }); undo.push(ownedHome(home))
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id: 'task' })); writeFileSync(join(location, 'messages.json'), '[]')
  const store = new ResourceLifecycleStore({ profileId: 'test', profileHome: home }); store.registerTask({ taskId: 'task', location })
  registerThreadLifecycleGate(home, store)
  const repo = join(root, 'repo'); mkdirSync(repo); git(repo, ['init']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'base.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-m', 'base'])
  const worktree = join(home, 'repositories', resolveRepositoryIdentity(repo).key, 'worktrees', 'threads', 'task', 'main'); mkdirSync(dirname(worktree), { recursive: true })
  const branch = 'mousse/thread/task/main'; git(repo, ['worktree', 'add', '-b', branch, worktree])
  const sha = git(repo, ['rev-parse', 'HEAD']), retainedRef = 'refs/mousse/threads/task/main'; git(repo, ['update-ref', retainedRef, sha])
  writeFileSync(join(location, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId: 'task', worktreePath: worktree, branch, repositoryId: resolveRepositoryIdentity(repo).key, retainedRef, baseSha: sha, headSha: sha, integrationTarget: { baseSha: sha, checkoutPath: repo }, lifecycle: 'ready' }))
  mkdirSync(join(location, 'journal')); writeFileSync(join(location, 'journal', '0000000000000001.json'), JSON.stringify({ schemaVersion: 1, sequence: 1, operationId: 'provision', operationType: 'workspace-provision', state: 'planned', expectedPreState: { branch, worktreePath: worktree } }))
  writeFileSync(join(location, 'journal', '0000000000000002.json'), JSON.stringify({ schemaVersion: 1, sequence: 2, operationId: 'provision', operationType: 'workspace-provision', state: 'completed' }))
  // A staged change has no exact reconstruction, so the person reviews and discards it.
  writeFileSync(join(worktree, 'base.txt'), 'staged reviewed bytes\n'); git(worktree, ['add', 'base.txt']); writeFileSync(join(worktree, 'draft.txt'), 'reviewed draft\n')
  const coordinator = (): ResourceLifecycleCoordinator => new ResourceLifecycleCoordinator(store, { drain: async () => {}, settleMutationOwnership: async () => {}, projectIndex: () => {} })
  const first = coordinator()
  await first.trash({ taskId: 'task', operationId: 'trash' })
  const preview = async () => {
    const reviewed = await first.cleanup.preview('task')
    expect(reviewed.blockers).toEqual([])
    expect(reviewed.items.find((item) => item.kind === 'worktree')).toMatchObject({ discardRequired: true, discardState: 'pending' })
    return { taskId: 'task', operationId: 'purge', expectedGeneration: reviewed.generation, previewDigest: reviewed.digest, human: true, discard: true }
  }
  return { root, repo, worktree, store, coordinator, first, preview }
}

/** Stops the purge right after the first durable write `when` accepts, as a crash there would. */
function stopAfter(when: (record: TaskLifecycleRecord) => boolean): void {
  const update = ResourceLifecycleStore.prototype.update
  let stopped = false
  vi.spyOn(ResourceLifecycleStore.prototype, 'update').mockImplementation(function (this: ResourceLifecycleStore, taskId, change) {
    const record = update.call(this, taskId, change)
    if (!stopped && when(record)) { stopped = true; throw new Error('the process stopped here') }
    return record
  })
}
const cleared = (record: TaskLifecycleRecord) => Boolean(record.purge?.items.some((item) => item.discardState === 'cleared'))

/**
 * Every Git command from here on, with the folder it ran in. With `dropLinkAfter`, the first command run in that folder
 * whose arguments hold `dropLinkAfter.args` deletes the folder's `.git` once it has finished, as something else could.
 */
function recordGit(root: string, dropLinkAfter?: { folder: string; args: string }): () => string[] {
  const bin = join(root, 'bin'), log = join(root, 'git.log'), flag = join(root, 'dropped'); mkdirSync(bin)
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const drop = dropLinkAfter ? `if [ "$PWD" = '${dropLinkAfter.folder}' ] && [ ! -e '${flag}' ]; then case "$*" in *'${dropLinkAfter.args}'*) '${real}' "$@"; rc=$?; : > '${flag}'; rm -f '${dropLinkAfter.folder}/.git'; exit $rc ;; esac; fi\n` : ''
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${log}'\n${drop}exec '${real}' "$@"\n`); chmodSync(join(bin, 'git'), 0o755)
  process.env.PATH = `${bin}:${realPath}`
  return () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
}
const registered = (repo: string, worktree: string) => git(repo, ['worktree', 'list', '--porcelain']).split('\n').some((line) => line === `worktree ${worktree}`)

test('a permanent delete removes the reviewed checkout without writing in it, and Git no longer lists it', async () => {
  const f = await trashedWithStagedWork()
  const commands = recordGit(f.root)
  const record = await f.first.purge(await f.preview())
  expect(record.state).toBe('purged')
  expect(existsSync(f.worktree)).toBe(false)
  expect(registered(f.repo, f.worktree)).toBe(false)
  expect(commands().filter((line) => / (restore|reset|checkout|clean) /.test(` ${line.split('\t')[1]} `))).toEqual([])
})

test('recovery stops at a file saved after the reviewed files went, names it, and keeps it in a working worktree (N6)', async () => {
  const f = await trashedWithStagedWork()
  stopAfter(cleared)
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  expect(cleared(f.store.require('task'))).toBe(true)
  // An editor saves into the worktree before the next start's recovery.
  const value = Buffer.from('new bytes after purge stopped f4947c80\n')
  writeFileSync(join(f.worktree, 'base.txt'), value)
  const outcomes = await f.coordinator().recoverAll()
  const message = 'Permanent delete stopped: base.txt was saved in this worktree after it began. It was kept.'
  expect(outcomes.find((outcome) => outcome.taskId === 'task')?.error).toBe(message)
  const record = f.store.require('task')
  expect(record.state).toBe('purge-started')
  expect(record.purge?.error).toBe(message)
  expect(readFileSync(join(f.worktree, 'base.txt')).equals(value)).toBe(true)
  // Still a working worktree of the same repository and branch.
  expect(git(f.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('mousse/thread/task/main')
  expect(registered(f.repo, f.worktree)).toBe(true)
  // Once the person moves the file away, the delete carries on.
  unlinkSync(join(f.worktree, 'base.txt'))
  expect((await f.coordinator().recover('task')).state).toBe('purged')
  expect(existsSync(f.worktree)).toBe(false)
  expect(registered(f.repo, f.worktree)).toBe(false)
})

test('a write that lands after .git is removed puts .git back, stops the delete and names the file', async () => {
  const f = await trashedWithStagedWork()
  const value = Buffer.from('late editor save 3c1e\n')
  late.afterUnlink = (path) => { if (path === join(f.worktree, '.git')) { late.afterUnlink = undefined; writeFileSync(join(f.worktree, 'late.txt'), value) } }
  const message = 'Permanent delete stopped: late.txt was saved in this worktree after it began. It was kept.'
  await expect(f.first.purge(await f.preview())).rejects.toMatchObject({ code: 'resource_purge_kept', message })
  expect(f.store.require('task').purge?.error).toBe(message)
  expect(readFileSync(join(f.worktree, 'late.txt')).equals(value)).toBe(true)
  expect(git(f.worktree, ['status', '--porcelain', '--untracked-files=all'])).toContain('late.txt')
  expect(registered(f.repo, f.worktree)).toBe(true)
})

test('recovery after .git went never runs Git in the folder: a file there stops it, an empty folder is removed', async () => {
  const f = await trashedWithStagedWork()
  stopAfter(cleared)
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  // The process stopped right after removing `.git`; then something wrote into the folder.
  unlinkSync(join(f.worktree, '.git'))
  const value = Buffer.from('written into the bare folder\n')
  mkdirSync(join(f.worktree, 'notes')); writeFileSync(join(f.worktree, 'notes', 'one.md'), value)
  const commands = recordGit(f.root)
  const outcomes = await f.coordinator().recoverAll()
  expect(outcomes.find((outcome) => outcome.taskId === 'task')?.error).toBe('Permanent delete stopped: notes/one.md was saved in this worktree after it began. It was kept.')
  expect(readFileSync(join(f.worktree, 'notes', 'one.md')).equals(value)).toBe(true)
  expect(commands().filter((line) => line.startsWith(`${f.worktree}\t`))).toEqual([])
  rmSync(join(f.worktree, 'notes'), { recursive: true })
  expect((await f.coordinator().recover('task')).state).toBe('purged')
  expect(existsSync(f.worktree)).toBe(false)
  expect(registered(f.repo, f.worktree)).toBe(false)
  expect(commands().filter((line) => line.startsWith(`${f.worktree}\t`))).toEqual([])
})

test('a missing folder Git still lists is unregistered after its files were cleared, even with its parent gone', async () => {
  const f = await trashedWithStagedWork()
  stopAfter(cleared)
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  rmSync(dirname(f.worktree), { recursive: true })
  expect(registered(f.repo, f.worktree)).toBe(true)
  expect((await f.coordinator().recover('task')).state).toBe('purged')
  expect(registered(f.repo, f.worktree)).toBe(false)
})

test('a folder moved away before its files were cleared stops the delete, named, and Git keeps listing it', async () => {
  const f = await trashedWithStagedWork()
  stopAfter((record) => record.state === 'purge-started')
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  const moved = join(f.root, 'moved'); execFileSync('mv', [f.worktree, moved])
  const outcomes = await f.coordinator().recoverAll()
  expect(outcomes.find((outcome) => outcome.taskId === 'task')?.error).toBe(`Permanent delete stopped: the worktree at ${f.worktree} was moved or deleted by something else, and Git still lists it. It was kept in Git's list of worktrees.`)
  expect(registered(f.repo, f.worktree)).toBe(true)
  expect(readFileSync(join(moved, 'draft.txt'), 'utf8')).toBe('reviewed draft\n')
})

test('a worktree Git has locked stops the delete before anything is removed, and the reason names the lock', async () => {
  const f = await trashedWithStagedWork()
  git(f.repo, ['worktree', 'lock', '--reason', 'on a USB disk', f.worktree])
  await expect(f.first.purge(await f.preview())).rejects.toMatchObject({ code: 'resource_purge_kept', message: `Permanent delete stopped: Git has this worktree locked (on a USB disk), so it stays in the trash. Run git worktree unlock "${f.worktree}" to let it be deleted.` })
  expect(cleared(f.store.require('task'))).toBe(false)
  expect(readFileSync(join(f.worktree, 'draft.txt'), 'utf8')).toBe('reviewed draft\n')
  expect(git(f.worktree, ['show', ':base.txt'])).toBe('staged reviewed bytes')
  git(f.repo, ['worktree', 'unlock', f.worktree])
  expect((await f.coordinator().recover('task')).state).toBe('purged')
  expect(registered(f.repo, f.worktree)).toBe(false)
})

test('a folder swapped for a link while it is deleted gets no .git: the link target is left alone and the swap is named', async () => {
  const f = await trashedWithStagedWork()
  const elsewhere = join(f.root, 'personal-folder'), moved = join(f.root, 'moved'); mkdirSync(elsewhere)
  writeFileSync(join(elsewhere, 'personal.txt'), 'not in the purge\n')
  late.afterUnlink = (path) => { if (path === join(f.worktree, '.git')) { late.afterUnlink = undefined; renameSync(f.worktree, moved); symlinkSync(elsewhere, f.worktree) } }
  await expect(f.first.purge(await f.preview())).rejects.toMatchObject({ code: 'resource_purge_kept', message: `Permanent delete stopped: the worktree at ${f.worktree} was moved or replaced while it was being deleted, so its link to its repository (.git) was not put back. Its files were kept.` })
  expect(existsSync(join(elsewhere, '.git'))).toBe(false)
  expect(readFileSync(join(elsewhere, 'personal.txt'), 'utf8')).toBe('not in the purge\n')
})

test('recovery checks the lock before removing an empty folder left without .git', async () => {
  const f = await trashedWithStagedWork()
  stopAfter(cleared)
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  const dot = join(f.worktree, '.git'), admin = readFileSync(dot, 'utf8').trim().slice('gitdir: '.length)
  unlinkSync(dot); writeFileSync(join(admin, 'locked'), 'keep the folder')
  const commands = recordGit(f.root)
  await expect(f.coordinator().recover('task')).rejects.toMatchObject({ code: 'resource_purge_kept', message: expect.stringContaining('Git has this worktree locked (keep the folder)') })
  expect(existsSync(f.worktree)).toBe(true)
  expect(registered(f.repo, f.worktree)).toBe(true)
  expect(commands().filter((line) => line.startsWith(`${f.worktree}\t`))).toEqual([])
})

test('a lock taken while the reviewed files are removed stops every later removal', async () => {
  const f = await trashedWithStagedWork()
  const admin = readFileSync(join(f.worktree, '.git'), 'utf8').trim().slice('gitdir: '.length)
  let first = ''
  late.afterUnlink = (path) => { if (path.startsWith(`${f.worktree}/`) && !path.endsWith('/.git')) { first = path; late.afterUnlink = undefined; writeFileSync(join(admin, 'locked'), 'keep this checkout') } }
  await expect(f.first.purge(await f.preview())).rejects.toMatchObject({ code: 'resource_purge_kept', message: expect.stringContaining('Git has this worktree locked (keep this checkout)') })
  expect(first).not.toBe('')
  expect(existsSync(join(f.worktree, '.git'))).toBe(true)
  const left = ['base.txt', 'draft.txt'].filter((name) => existsSync(join(f.worktree, name)))
  expect(left).toHaveLength(1)
  expect(readFileSync(join(f.worktree, left[0]), 'utf8')).toBe(left[0] === 'base.txt' ? 'staged reviewed bytes\n' : 'reviewed draft\n')
  git(f.repo, ['worktree', 'unlock', f.worktree])
  expect((await f.coordinator().recover('task')).state).toBe('purged')
  expect(registered(f.repo, f.worktree)).toBe(false)
})

test('a lock taken right after .git is removed puts .git back and keeps the folder', async () => {
  const f = await trashedWithStagedWork()
  const link = readFileSync(join(f.worktree, '.git'), 'utf8'), admin = link.trim().slice('gitdir: '.length)
  late.afterUnlink = (path) => { if (path === join(f.worktree, '.git')) { late.afterUnlink = undefined; writeFileSync(join(admin, 'locked'), '') } }
  await expect(f.first.purge(await f.preview())).rejects.toMatchObject({ code: 'resource_purge_kept', message: `Permanent delete stopped: Git has this worktree locked, so it stays in the trash. Run git worktree unlock "${f.worktree}" to let it be deleted.` })
  expect(readFileSync(join(f.worktree, '.git'), 'utf8')).toBe(link)
  expect(git(f.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('mousse/thread/task/main')
})

test('a folder made again before Git unregisters the old one is named on every run, and goes once it is empty', async () => {
  const f = await trashedWithStagedWork()
  const value = Buffer.from('made after the checkout went\n')
  late.afterRmdir = (path) => { if (path === f.worktree) { late.afterRmdir = undefined; mkdirSync(f.worktree); writeFileSync(join(f.worktree, 'new.txt'), value) } }
  const message = `Permanent delete stopped: files were written at ${f.worktree} after its worktree was deleted. They were kept.`
  await expect(f.first.purge(await f.preview())).rejects.toMatchObject({ message })
  await expect(f.coordinator().recover('task')).rejects.toMatchObject({ code: 'resource_purge_kept', message })
  expect(readFileSync(join(f.worktree, 'new.txt')).equals(value)).toBe(true)
  unlinkSync(join(f.worktree, 'new.txt'))
  expect((await f.coordinator().recover('task')).state).toBe('purged')
  expect(existsSync(f.worktree)).toBe(false)
  expect(registered(f.repo, f.worktree)).toBe(false)
})

test('.git deleted by something else before the files are cleared is named as such', async () => {
  const f = await trashedWithStagedWork()
  stopAfter((record) => record.state === 'purge-started')
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  unlinkSync(join(f.worktree, '.git'))
  await expect(f.coordinator().recover('task')).rejects.toMatchObject({ message: `Permanent delete stopped: the worktree at ${f.worktree} lost its link to its repository (.git) before its files were cleared. It was kept.` })
  expect(readFileSync(join(f.worktree, 'draft.txt'), 'utf8')).toBe('reviewed draft\n')
})

test('a change to the worktree folder itself names the folder', async () => {
  const f = await trashedWithStagedWork()
  stopAfter((record) => record.state === 'purge-started')
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  chmodSync(f.worktree, statSync(f.worktree).mode & 0o777 ^ 0o070)
  await expect(f.coordinator().recover('task')).rejects.toMatchObject({ message: `Permanent delete stopped: the worktree folder ${f.worktree} changed after the delete began. It was kept.` })
  expect(readFileSync(join(f.worktree, 'draft.txt'), 'utf8')).toBe('reviewed draft\n')
})

test('the checks before the delete never run Git in the folder once its .git is gone', async () => {
  const f = await trashedWithStagedWork()
  stopAfter((record) => record.state === 'purge-started')
  await expect(f.first.purge(await f.preview())).rejects.toThrow()
  vi.restoreAllMocks()
  const commands = recordGit(f.root, { folder: f.worktree, args: 'branch --show-current' })
  await expect(f.coordinator().recover('task')).rejects.toMatchObject({ code: 'resource_purge_kept' })
  const here = commands().filter((line) => line.startsWith(`${f.worktree}\t`))
  expect(here).toHaveLength(1)
  expect(here[0]).toContain('branch --show-current')
  expect(readFileSync(join(f.worktree, 'draft.txt'), 'utf8')).toBe('reviewed draft\n')
})
