import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { getMousseHomeDir } from '../data/paths'

export interface WorkspaceGcReport {
  staleWorktrees: Array<{ path: string; branch?: string }>
  unreferencedRefs: string[]
  retainedRefs: string[]
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

/** Explicit, reference-aware maintenance. Never blanket-prunes repositories. */
export class WorkspaceGcService {
  constructor(private readonly repositoryPath: string) {}

  dryRun(knownWorktrees: Set<string>, referencedRefs: Set<string>): WorkspaceGcReport {
    const staleWorktrees: Array<{ path: string; branch?: string }> = []
    const lines = git(this.repositoryPath, ['worktree', 'list', '--porcelain']).split(/\r?\n/)
    let current: { path?: string; branch?: string } = {}
    const flush = () => {
      if (current.path && !knownWorktrees.has(resolve(current.path)) && resolve(current.path) !== resolve(this.repositoryPath)) {
        const ownedRoot = resolve(getMousseHomeDir(), 'repositories')
        const ownedRelative = relative(ownedRoot, resolve(current.path))
        const owned = ownedRelative && !ownedRelative.startsWith('..') && !ownedRelative.includes(`..${sep}`)
        if (owned) staleWorktrees.push({ path: current.path, branch: current.branch })
      }
      current = {}
    }
    for (const line of lines) {
      if (line.startsWith('worktree ')) { flush(); current.path = line.slice(9) }
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (!line) flush()
    }
    flush()
    const refs = git(this.repositoryPath, ['for-each-ref', '--format=%(refname)', 'refs/mousse']).split(/\r?\n/).filter(Boolean)
    return {
      staleWorktrees,
      unreferencedRefs: refs.filter((ref) => !referencedRefs.has(ref)),
      retainedRefs: refs.filter((ref) => referencedRefs.has(ref))
    }
  }

  async purge(report: WorkspaceGcReport, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Workspace GC requires explicit confirmation of a dry-run report.')
    const identity = resolveRepositoryIdentity(this.repositoryPath, { requireMutationCapability: true })
    const lease = await acquireRepositoryLease(identity)
    try {
      for (const worktree of report.staleWorktrees) {
        if (!existsSync(worktree.path)) continue
        // Git itself refuses dirty worktrees; no force removal is permitted.
        git(this.repositoryPath, ['worktree', 'remove', worktree.path])
      }
      for (const ref of report.unreferencedRefs) git(this.repositoryPath, ['update-ref', '-d', ref])
    } finally {
      lease.release()
    }
  }
}
