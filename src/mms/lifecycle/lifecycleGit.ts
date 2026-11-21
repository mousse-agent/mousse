import { gitDirectoryEnvAsync } from '../git/gitEnv'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { activeHiddenStore, checkStoreCommandAsync, hiddenStoreEnv } from '../git/hiddenStore'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'

/**
 * Git for lifecycle work, without blocking the daemon: it waits until the folder's volume answers, runs the central
 * check, and the command with a 30-second limit. A failure carries Git's `status`, `stdout` and `stderr`.
 * `beforeStart` runs after Git preparation and again immediately before the command starts. It can instead return a
 * promise for a final synchronous check, which then runs immediately before the command starts.
 */
export async function lifecycleGitAsync(cwd: string, args: string[], input?: string, maxBuffer = 32 * 1024 * 1024, env?: NodeJS.ProcessEnv, beforeStart?: () => void | Promise<() => void>): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args, { stdin: input, env })
  const runEnv = repoProgramEnv({ ...process.env, ...await gitDirectoryEnvAsync(cwd), ...env })
  // A check that reads first returns a promise for its final synchronous check: the reads run now, and that check right
  // before Git starts (after any wait for its disk), with nothing awaited in between. A synchronous check runs now and then.
  const admission = beforeStart?.()
  const final = admission ? await admission : beforeStart
  const ran = await runGitProcess(argv, { cwd, input, env: runEnv, timeout: 30_000, maxBuffer, beforeStart: final })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout.trimEnd()
}
/** A lifecycle read (a preview, the checks before a delete): it never refreshes the index and never fetches a missing object. */
export function lifecycleReadAsync(cwd: string, args: string[], input?: string, maxBuffer?: number): Promise<string> {
  return lifecycleGitAsync(cwd, args, input, maxBuffer, READ_ONLY_GIT_ENV)
}
/** Never treat an unreadable reference as absent, and never dereference an owned symbolic ref. */
export async function readDirectLifecycleRefAsync(cwd: string, ref: string): Promise<string | undefined> {
  const store = activeHiddenStore(cwd)
  const run = async (args: string[]) => {
    const argv = store ? ['--no-optional-locks', ...args] : await withoutRepoProgramsAsync(cwd, args)
    if (store) await checkStoreCommandAsync(store, cwd, argv)
    const env = repoProgramEnv({ ...process.env, ...(store ? {} : await gitDirectoryEnvAsync(cwd)), ...READ_ONLY_GIT_ENV })
    const result = await runGitProcess(argv, { cwd, env: store ? hiddenStoreEnv(store, env) : env, timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
    return { argv, result }
  }
  const { argv, result: symbolic } = await run(['symbolic-ref', '-q', ref])
  if (symbolic.status === 0 && !symbolic.error) throw new Error('Symbolic resource reference is not cleanup authority: ' + ref)
  if (symbolic.status !== 1 || symbolic.error) throw gitRunError(argv, symbolic)
  const { result: listing } = await run(['for-each-ref', '--format=%(refname)%00%(objectname)', ref])
  // Git may warn about a corrupt loose ref while exiting successfully and omitting it.
  if (listing.error || listing.status !== 0 || listing.stderr.trim()) throw new Error(`Resource reference inventory is unreadable: ${ref}`)
  const row = listing.stdout.split(/\r?\n/).find((entry) => entry.split('\0')[0] === ref)
  if (!row) return undefined
  const sha = row.split('\0')[1]
  if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || /^0+$/.test(sha)) throw new Error(`Existing resource reference is malformed or unreadable: ${ref}`)
  return sha
}
/** Whether Git exits 0 for a question it answers by its status alone (`merge-base --is-ancestor`, `cat-file -e`). */
export async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  return (await runGitProcess(argv, { cwd, env: repoProgramEnv() })).status === 0
}
