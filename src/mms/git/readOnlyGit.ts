import { repoProgramEnv, withoutRepoProgramsAsync } from './repoPrograms'
import { runGitProcess } from './runGitProcess'

export interface GitRun { status: number | null; stdout: string; stderr: string }

/**
 * For a Git read: `GIT_OPTIONAL_LOCKS=0` stops `git status` and `git diff` from taking `index.lock` to
 * refresh and write the index, and `GIT_NO_LAZY_FETCH` stops a partial clone from fetching.
 */
export const READ_ONLY_GIT_ENV: Readonly<Record<string, string>> = { GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' }

/**
 * Runs Git for a read-only question, without blocking the daemon. `GIT_OPTIONAL_LOCKS=0` stops `git status` from taking
 * `index.lock` to refresh the index, so a commit from another terminal in the same checkout is not refused while a
 * background check runs. No program the repository configures runs, and a partial clone fetches nothing
 * (`GIT_NO_LAZY_FETCH`). It waits until the folder's volume answers and runs the central check first. Never throws on a
 * non-zero exit (callers read `status`); a run that could not finish (Git missing, a timeout, output past the limit) throws.
 */
export async function runReadOnlyGitAsync(cwd: string, args: string[], maxBuffer = 32 * 1024 * 1024): Promise<GitRun> {
  const result = await runGitProcess(await withoutRepoProgramsAsync(cwd, args), {
    cwd,
    timeout: 30_000,
    maxBuffer,
    env: repoProgramEnv({ ...process.env, ...READ_ONLY_GIT_ENV })
  })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** The trimmed standard output, or a thrown error carrying Git's message. */
export async function readOnlyGitAsync(cwd: string, args: string[], maxBuffer?: number): Promise<string> {
  const run = await runReadOnlyGitAsync(cwd, args, maxBuffer)
  if (run.status !== 0) throw new Error(run.stderr.trim() || `git ${args[0]} failed with exit code ${run.status}`)
  return run.stdout.trimEnd()
}
