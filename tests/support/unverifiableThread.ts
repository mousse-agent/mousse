import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveRepositoryIdentity } from '../../src/mms/git/RepositoryIdentity'
import type { ResourceLifecycleStore } from '../../src/mms/lifecycle/ResourceLifecycleStore'
import { fixtureGit as git } from './fixtureGit'

function initRepository(repo: string): void {
  mkdirSync(repo, { recursive: true })
  git(repo, ['init', '-q']); git(repo, ['config', 'user.email', 'test@example.com']); git(repo, ['config', 'user.name', 'Test'])
  writeFileSync(join(repo, 'a.txt'), 'first\n'); git(repo, ['add', '.']); git(repo, ['commit', '-q', '-m', 'base'])
}

/**
 * Registers thread `id` in `store` with a worktree in `repo` that can no longer be verified, as seen live:
 * - `recreated`: the repository was deleted and made again at the same path, so Git no longer knows the worktree;
 * - `unlinked`: the worktree's `.git` file is gone, so it is no longer a linked worktree of the repository;
 * - `intact`: nothing is broken yet, for a test that breaks it its own way (moving the repository, say).
 * `repo` is created when it does not exist. The thread's records are intact; only its checkout fails verification.
 */
export function unverifiableThread(store: ResourceLifecycleStore, options: { id: string; name: string; repo: string; how: 'recreated' | 'unlinked' | 'intact' }) {
  const { id, name, repo, how } = options
  if (!existsSync(repo)) initRepository(repo)
  const repositoryId = resolveRepositoryIdentity(repo).key
  const worktree = join(store.profileHome, 'repositories', repositoryId, 'worktrees', 'threads', id, 'main')
  mkdirSync(join(worktree, '..'), { recursive: true })
  const branch = `mousse/thread/${id}/main`
  git(repo, ['worktree', 'add', '-q', '-b', branch, worktree])
  const sha = git(repo, ['rev-parse', 'HEAD']), retainedRef = `refs/mousse/threads/${id}/main`
  git(repo, ['update-ref', retainedRef, sha])
  const location = join(store.profileHome, 'thread-data', id)
  mkdirSync(location, { recursive: true })
  writeFileSync(join(location, 'meta.json'), JSON.stringify({ id, name }))
  writeFileSync(join(location, 'messages.json'), '[]')
  writeFileSync(join(location, 'workspace.json'), JSON.stringify({ schemaVersion: 1, threadId: id, worktreePath: worktree, branch, repositoryId, retainedRef, baseSha: sha, headSha: sha, integrationTarget: { baseSha: sha, checkoutPath: repo }, lifecycle: 'ready' }))
  store.registerTask({ taskId: id, location })
  if (how === 'recreated') { rmSync(repo, { recursive: true, force: true }); initRepository(repo) }
  else if (how === 'unlinked') rmSync(join(worktree, '.git'))
  return { location, worktree, repositoryId, branch, retainedRef }
}
