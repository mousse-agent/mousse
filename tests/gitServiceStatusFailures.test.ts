/**
 * A status read tells "not a repository" and "detached HEAD" apart from a Git that failed: a failure throws, so a
 * window keeps the branch it showed instead of hearing there is none.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { GitService } from '../src/mms/git/GitService'

const roots: string[] = []
const folder = (): string => {
  const cwd = mkdtempSync(join(tmpdir(), 'mousse-status-failure-'))
  roots.push(cwd)
  return cwd
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore' })

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('answers a folder outside Git as not a repository, and a detached HEAD as no branch', async () => {
  const service = new GitService()
  await expect(service.getStatus(folder())).resolves.toMatchObject({ isRepo: false, branch: null })

  const repository = folder()
  git(repository, 'init', '-q', '-b', 'main')
  git(repository, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
  await expect(service.getStatus(repository)).resolves.toMatchObject({ isRepo: true, branch: 'main' })
  git(repository, 'checkout', '-q', '--detach')
  await expect(service.getStatus(repository)).resolves.toMatchObject({ isRepo: true, branch: null, tracking: 'detached' })
})

it('throws when Git fails to read the status, instead of answering that the folder is not a repository or has no branch', async () => {
  const repository = folder()
  git(repository, 'init', '-q', '-b', 'main')
  const service = new GitService()
  const failed = { ok: false, code: null, stalled: false, cancelled: false, exited: false, stdout: '', truncated: false, output: 'spawn git EAGAIN' }
  vi.spyOn(service as unknown as { runGit(...args: unknown[]): unknown }, 'runGit').mockResolvedValue(failed)
  await expect(service.getStatus(repository)).rejects.toThrow('EAGAIN')
})

it('throws when Git cannot tell whether a folder the files do not answer for is a repository', async () => {
  const service = new GitService()
  const failing = { checkIsRepo: () => Promise.reject(new Error('spawn git EAGAIN')) }
  vi.spyOn(service as unknown as { gitFor(cwd: string): unknown }, 'gitFor').mockReturnValue(failing)
  // A `.git` file that names no Git folder: a layout Git's files do not tell, so Git is asked.
  const odd = folder()
  writeFileSync(join(odd, '.git'), 'not a gitdir line')
  await expect(service.getStatus(odd)).rejects.toThrow('EAGAIN')
})
