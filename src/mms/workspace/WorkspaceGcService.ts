import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { getMousseHomeDir } from '../data/paths'

export interface WorkspaceGcReport {
  /** Exact revisions inspected by this report; purge rejects changed resources. */
  revision?: string
  refHeads?: Record<string, string>
  worktreeHeads?: Record<string, string>
  staleWorktrees: Array<{ path: string; branch?: string }>
  unreferencedRefs: string[]
  retainedRefs: string[]
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function canonicalPath(path: string): string {
  const resolved = resolve(path)
  try {
    return realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

/** Explicit, reference-aware maintenance. Never blanket-prunes repositories. */
export class WorkspaceGcService {
  private readonly issuedReports = new WeakMap<WorkspaceGcReport, string>()
  constructor(private readonly repositoryPath: string) {}

  dryRun(knownWorktrees: Set<string>, referencedRefs: Set<string>): WorkspaceGcReport {
    const staleWorktrees: Array<{ path: string; branch?: string }> = []
    const lines = git(this.repositoryPath, ['worktree', 'list', '--porcelain']).split(/\r?\n/)
    let current: { path?: string; branch?: string } = {}
    const flush = () => {
      const currentPath = current.path ? canonicalPath(current.path) : undefined
      if (currentPath && ![...knownWorktrees].some((path) => canonicalPath(path) === currentPath) && currentPath !== canonicalPath(this.repositoryPath)) {
        const displayRoot = resolve(getMousseHomeDir(), 'repositories')
        const ownedRoot = canonicalPath(displayRoot)
        const ownedRelative = relative(ownedRoot, currentPath)
        const owned = ownedRelative && !isAbsolute(ownedRelative) && !ownedRelative.startsWith('..') && !ownedRelative.includes(`..${sep}`)
        // Report paths under the configured MOUSSE_HOME spelling. Git may
        // canonicalize /var to /private/var on macOS, while callers and
        // cleanup commands use the configured path.
        // Active task branches and results not reachable from the destination retain ownership.
        const protectedTask = current.branch?.startsWith('mousse/thread/')
        let unpublished = true
        try { git(this.repositoryPath, ['merge-base', '--is-ancestor', git(currentPath, ['rev-parse', 'HEAD']), 'HEAD']); unpublished = false } catch { /* retain uncertain results */ }
        if (owned && !protectedTask && !unpublished) staleWorktrees.push({ path: join(displayRoot, ownedRelative), branch: current.branch })
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
    const protectedRefs = new Set(referencedRefs)
    for (const ref of refs) {
      // Audit/undo references have no implicit expiration; explicit retirement must release them.
      if (ref.startsWith('refs/mousse/changes/') || ref.startsWith('refs/mousse/threads/') || ref.startsWith('refs/mousse/conversation-branches/')) protectedRefs.add(ref)
      else try { git(this.repositoryPath, ['merge-base', '--is-ancestor', ref, 'HEAD']) } catch { protectedRefs.add(ref) }
    }
    const report: WorkspaceGcReport = {
      staleWorktrees,
      unreferencedRefs: refs.filter((ref) => !protectedRefs.has(ref)),
      retainedRefs: refs.filter((ref) => protectedRefs.has(ref)),
      revision: git(this.repositoryPath, ['rev-parse', 'HEAD']),
      refHeads: Object.fromEntries(refs.map((ref) => [ref, git(this.repositoryPath, ['rev-parse', ref])])),
      worktreeHeads: Object.fromEntries(staleWorktrees.filter((item) => existsSync(item.path)).map((item) => [item.path, git(item.path, ['rev-parse', 'HEAD'])]))
    }
    this.issuedReports.set(report, JSON.stringify(report))
    return report
  }

  async purge(report: WorkspaceGcReport, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Workspace GC requires explicit confirmation of a dry-run report.')
    if (this.issuedReports.get(report) !== JSON.stringify(report)) throw new Error('Workspace GC requires a fresh report issued by this service.')
    const identity = resolveRepositoryIdentity(this.repositoryPath, { requireMutationCapability: true })
    const lease = await acquireRepositoryLease(identity)
    try {
      if (git(this.repositoryPath, ['rev-parse', 'HEAD']) !== report.revision) throw new Error('GC destination revision changed; refresh inventory.')
      const fresh = this.dryRun(new Set(), new Set(report.retainedRefs))
      for (const worktree of report.staleWorktrees) {
        if (!fresh.staleWorktrees.some((item) => canonicalPath(item.path) === canonicalPath(worktree.path))) throw new Error('GC worktree is now retained or is outside managed ownership.')
        if (!existsSync(worktree.path)) continue
        if (git(worktree.path, ['rev-parse', 'HEAD']) !== report.worktreeHeads?.[worktree.path]) throw new Error('GC worktree revision changed; refresh inventory.')
        // Git itself refuses dirty worktrees; no force removal is permitted.
        git(this.repositoryPath, ['worktree', 'remove', worktree.path])
      }
      for (const ref of report.unreferencedRefs) {
        if (!fresh.unreferencedRefs.includes(ref) || !report.refHeads?.[ref]) throw new Error('GC reference is retained or changed; refresh inventory.')
        git(this.repositoryPath, ['update-ref', '-d', ref, report.refHeads[ref]])
      }
      this.issuedReports.delete(report)
    } finally {
      lease.release()
    }
  }
}
