import { spawnSync } from 'node:child_process'
import { withoutRepoPrograms } from './repoPrograms'

export interface GitRun { status: number | null; stdout: string; stderr: string }

/**
 * Runs Git for a read-only question. `GIT_OPTIONAL_LOCKS=0` stops `git status` from taking
 * `index.lock` to refresh the index, so a commit from another terminal in the same checkout is not
 * refused while a background check runs. No program the repository configures runs, and a partial
 * clone fetches nothing (`GIT_NO_LAZY_FETCH`). Never throws on a non-zero exit; callers read `status`.
 */
export function runReadOnlyGit(cwd: string, args: string[]): GitRun {
  const result = spawnSync('git', withoutRepoPrograms(cwd, args), {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }
  })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The trimmed standard output, or a thrown error carrying Git's message. */
export function readOnlyGit(cwd: string, args: string[]): string {
  const run = runReadOnlyGit(cwd, args)
  if (run.status !== 0) throw new Error(run.stderr.trim() || `git ${args[0]} failed with exit code ${run.status}`)
  return run.stdout.trimEnd()
}
