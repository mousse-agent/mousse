import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { gitDirectoryEnvAsync } from '../git/gitEnv'
import { READ_ONLY_GIT_ENV } from '../git/readOnlyGit'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, runGitProcess } from '../git/runGitProcess'
import { gitEnvFor, gitFile } from '../git/gitExecutable'
import { timeGitChild } from '../diagnostics/turnBoundary'

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
/** Creates a fresh branch with a marker its caller can prove belongs to this Git command. */
export async function createLoggedBranchAsync(cwd: string, ref: string, sha: string, message: string): Promise<void> {
  await lifecycleGitAsync(cwd, ['update-ref', '--no-deref', '--create-reflog', '-m', message, ref, sha, '0'.repeat(sha.length)])
}

/** Let Git lock and verify the named refs before the caller checks their provenance. */
export async function verifiedRefTransactionAsync(cwd: string, commands: string, verify: () => boolean | Promise<boolean>, message?: string): Promise<boolean> {
  const prepare = `start\n${commands}prepare\n`
  const command = ['update-ref', '--no-deref', '--stdin', ...(message ? ['--create-reflog', '-m', message] : [])]
  const args = await withoutRepoProgramsAsync(cwd, command, { stdin: prepare + 'commit\n' })
  const env = gitEnvFor(repoProgramEnv({ ...process.env, ...await gitDirectoryEnvAsync(cwd) }))
  return new Promise((resolve, reject) => {
    const child = timeGitChild(() => spawn(gitFile(), args, { cwd, env, windowsHide: true, stdio: 'pipe' }))
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    let verified: boolean | undefined
    let failure: unknown
    let stderr = ''
    const timer = setTimeout(() => {
      failure = new Error('Git timed out updating branch references')
      child.stdin.end()
    }, 30_000)
    child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr = (stderr + data).slice(-4096) })
    child.stdin.on('error', (error) => { failure ??= error })
    child.on('error', (error) => { failure ??= error })
    child.on('close', (code) => {
      clearTimeout(timer)
      lines.close()
      if (failure) reject(failure)
      else if (code !== 0 || verified === undefined) reject(new Error(stderr.trim() || 'Git could not update branch references'))
      else resolve(verified)
    })
    lines.on('line', (line) => {
      if (line !== 'prepare: ok' || failure) return
      // Do not release Git's locks while the caller is verifying or updating another ref under them.
      clearTimeout(timer)
      void Promise.resolve().then(verify).then((result) => {
        if (failure) return
        verified = result
        child.stdin.end(verified ? 'commit\n' : 'abort\n')
      }, (error) => {
        if (failure) return
        failure = error
        child.stdin.end('abort\n')
      })
    })
    child.stdin.write(prepare)
  })
}

export async function branchCheckedOutAsync(cwd: string, ref: string): Promise<boolean> {
  const listing = await lifecycleReadAsync(cwd, ['worktree', 'list', '--porcelain', '-z'])
  return listing.split('\0').includes(`branch ${ref}`)
}

/** A ref lock blocks branch writers, but Git can still switch a worktree onto the branch while it is held. */
export async function deleteVerifiedBranchAsync(cwd: string, ref: string, sha: string, verify: () => boolean | Promise<boolean>): Promise<boolean> {
  const deleted = await verifiedRefTransactionAsync(cwd, `delete ${ref} ${sha}\n`, async () => {
    if (await isSymbolicRefAsync(cwd, ref)) return false
    return verify()
  })
  if (!deleted) return false
  try {
    if (!await branchCheckedOutAsync(cwd, ref)) return true
  } catch {
    // When the worktree inventory cannot be verified, keep the branch.
  }
  try {
    await createLoggedBranchAsync(cwd, ref, sha, 'mousse: preserve checked out branch')
  } catch (error) {
    // A replacement can take the name after the delete. Leave it alone if it now resolves.
    if (!await readDirectLifecycleRefAsync(cwd, ref)) throw error
  }
  return false
}

/** A lifecycle read (a preview, the checks before a delete): it never refreshes the index and never fetches a missing object. */
export function lifecycleReadAsync(cwd: string, args: string[], input?: string, maxBuffer?: number): Promise<string> {
  return lifecycleGitAsync(cwd, args, input, maxBuffer, READ_ONLY_GIT_ENV)
}
async function isSymbolicRefAsync(cwd: string, ref: string): Promise<boolean> {
  try {
    await lifecycleReadAsync(cwd, ['symbolic-ref', '-q', ref])
    return true
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error
    return false
  }
}

/** Never treat an unreadable reference as absent, and never dereference an owned symbolic ref. */
export async function readDirectLifecycleRefAsync(cwd: string, ref: string): Promise<string | undefined> {
  if (await isSymbolicRefAsync(cwd, ref)) throw new Error(`Symbolic resource reference is not cleanup authority: ${ref}`)
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
/** Whether Git exits 0 for a question it answers by its status alone (`merge-base --is-ancestor`, `cat-file -e`). */
export async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  return (await runGitProcess(argv, { cwd, env: repoProgramEnv() })).status === 0
}
