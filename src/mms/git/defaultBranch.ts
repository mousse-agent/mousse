import { readOnlyGit, runReadOnlyGit } from './readOnlyGit'

export interface DefaultBranch {
  name: string
  /** Existing refs that name the default branch: the local branch and the remote-tracking branch. */
  refs: string[]
}

const BRANCH_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

/** `origin` if the repository has it, else the only remote; undefined when there is no single answer. */
export function primaryRemote(checkoutPath: string): string | undefined {
  const remotes = readOnlyGit(checkoutPath, ['remote']).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (remotes.includes('origin')) return 'origin'
  return remotes.length === 1 ? remotes[0] : undefined
}

function refExists(cwd: string, ref: string): boolean {
  const run = runReadOnlyGit(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (run.status === 0) return true
  if (run.status === 1) return false
  throw new Error(run.stderr.trim() || `git rev-parse failed for ${ref}`)
}

/**
 * The default branch as repository metadata names it: `git symbolic-ref -q refs/remotes/<remote>/HEAD`,
 * else the name the code host has already cached for this checkout (no `gh` call). Never the checkout's
 * current branch. Null when the name is unknown or no ref for it exists. A Git failure throws.
 */
export function resolveDefaultBranch(checkoutPath: string, codeHost?: { cachedDefaultBranch(cwd: string): string | undefined }): DefaultBranch | null {
  const remote = primaryRemote(checkoutPath)
  let name: string | undefined
  if (remote) {
    const run = runReadOnlyGit(checkoutPath, ['symbolic-ref', '-q', `refs/remotes/${remote}/HEAD`])
    if (run.status === 0) {
      const prefix = `refs/remotes/${remote}/`
      const target = run.stdout.trim()
      if (target.startsWith(prefix)) name = target.slice(prefix.length)
    } else if (run.status !== 1) throw new Error(run.stderr.trim() || 'git symbolic-ref failed')
  }
  name ??= codeHost?.cachedDefaultBranch(checkoutPath)
  if (!name || !BRANCH_NAME.test(name) || name.includes('..')) return null
  const candidates = [`refs/heads/${name}`, ...(remote ? [`refs/remotes/${remote}/${name}`] : [])]
  const refs = candidates.filter((ref) => refExists(checkoutPath, ref))
  return refs.length ? { name, refs } : null
}

/**
 * Whether `head` is reachable from the default branch (`merge-base --is-ancestor`), by any of the
 * refs. Ancestry only: a rebased, cherry-picked or squashed branch is not integrated. Exit 1 means
 * "not an ancestor"; any other Git failure throws so the caller keeps the worktree.
 */
export function isIntegrated(worktreePath: string, head: string, refs: readonly string[]): boolean {
  for (const ref of refs) {
    const run = runReadOnlyGit(worktreePath, ['merge-base', '--is-ancestor', head, ref])
    if (run.status === 0) return true
    if (run.status !== 1) throw new Error(run.stderr.trim() || `git merge-base failed for ${ref}`)
  }
  return false
}
