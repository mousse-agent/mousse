import { gitDirectoryEnvAsync } from '../git/gitEnv'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'

/**
 * Git for lifecycle work, without blocking the daemon: it waits until the folder's volume answers, runs the central
 * check, and the command with a 30-second limit. A failure carries Git's `status`, `stdout` and `stderr`.
 * `beforeStart` runs synchronously right before Git starts, after every wait: a check that must hold when a destructive
 * command begins goes there, so nothing is awaited between it and the command.
 */
export async function lifecycleGitAsync(cwd: string, args: string[], input?: string, maxBuffer = 32 * 1024 * 1024, env?: NodeJS.ProcessEnv, beforeStart?: () => void): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args, { stdin: input, env })
  const runEnv = repoProgramEnv({ ...process.env, ...await gitDirectoryEnvAsync(cwd), ...env })
  beforeStart?.()
  const ran = await runGitProcess(argv, { cwd, input, env: runEnv, timeout: 30_000, maxBuffer })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout.trimEnd()
}
/** A lifecycle read (a preview, the checks before a delete): it never refreshes the index and never fetches a missing object. */
export function lifecycleReadAsync(cwd: string, args: string[], input?: string, maxBuffer?: number): Promise<string> {
  return lifecycleGitAsync(cwd, args, input, maxBuffer, READ_ONLY_GIT_ENV)
}
/** Never treat an unreadable reference as absent, and never dereference an owned symbolic ref. */
export async function readDirectLifecycleRefAsync(cwd: string, ref: string): Promise<string | undefined> {
  try { await lifecycleGitAsync(cwd, ['symbolic-ref', '-q', ref]); throw new Error(`Symbolic resource reference is not cleanup authority: ${ref}`) }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error }
  const args = ['for-each-ref', '--format=%(refname)%00%(objectname)', ref]
  const listing = await runGitProcess(await withoutRepoProgramsAsync(cwd, args), { cwd, env: repoProgramEnv({ ...process.env, ...await gitDirectoryEnvAsync(cwd), ...READ_ONLY_GIT_ENV }), timeout: 30_000, maxBuffer: 32 * 1024 * 1024 })
  // Git may warn about a corrupt loose ref while exiting successfully and omitting it.
  if (listing.error || listing.status !== 0 || listing.stderr.trim()) throw new Error(`Resource reference inventory is unreadable: ${ref}`)
  const row = listing.stdout.split(/\r?\n/).find((entry) => entry.split('\0')[0] === ref)
  if (!row) return undefined
  const sha = row.split('\0')[1]
  if (!sha || !/^[a-f0-9]{40,64}$/.test(sha) || /^0+$/.test(sha)) throw new Error(`Existing resource reference is malformed or unreadable: ${ref}`)
  return sha
}
