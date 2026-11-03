import { access, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { getMousseHomeDir } from '../data/paths'
import { repoProgramEnv, withoutRepoProgramsAsync } from '../git/repoPrograms'
import { gitRunError, LISTING_MAX_BUFFER, runGitProcess } from '../git/runGitProcess'
import { isMousseBranchName } from '../../shared/mousseBranches'

export interface WorkspaceGcReport {
  /** Exact revisions inspected by this report; purge rejects changed resources. */
  revision?: string
  refHeads?: Record<string, string>
  worktreeHeads?: Record<string, string>
  staleWorktrees: Array<{ path: string; branch?: string }>
  unreferencedRefs: string[]
  retainedRefs: string[]
}

/** Git without blocking the daemon: the same check, command and answer as `execFileSync`. */
async function git(cwd: string, args: string[], maxBuffer?: number): Promise<string> {
  const argv = await withoutRepoProgramsAsync(cwd, args)
  const ran = await runGitProcess(argv, { cwd, env: repoProgramEnv(), maxBuffer })
  if (ran.error || ran.status !== 0) throw gitRunError(argv, ran)
  return ran.stdout.trim()
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false)

/** Namespaces whose refs are released only by their owner: receipts, thread and fork results, agent, delegation and workflow results, retirement pins, the last published files and files a restore kept. */
const PROTECTED_NAMESPACES = [
  'refs/mousse/changes/', 'refs/mousse/threads/', 'refs/mousse/conversation-branches/', 'refs/mousse/agents/', 'refs/mousse/workflows/',
  'refs/mousse/lifecycle/', 'refs/mousse/published/', 'refs/mousse/preserved/', 'refs/mousse/delegations/'
]

/** Whether a ref points at a workspace snapshot (see `takeSnapshot`), which no branch contains. */
async function isSnapshot(repositoryPath: string, ref: string): Promise<boolean> {
  try { return (await git(repositoryPath, ['log', '-1', '--format=%s', ref])).startsWith('mousse snapshot: ') } catch { return true }
}

/** The real path, read without blocking; `fs/promises`' `realpath` answers like `realpathSync.native`. */
async function canonicalPath(path: string): Promise<string> {
  const resolved = resolve(path)
  try {
    return await realpath(resolved)
  } catch {
    return resolved
  }
}

/** Explicit, reference-aware maintenance. Never blanket-prunes repositories. */
export class WorkspaceGcService {
  private readonly issuedReports = new WeakMap<WorkspaceGcReport, string>()
  constructor(private readonly repositoryPath: string) {}

  async dryRun(knownWorktrees: Set<string>, referencedRefs: Set<string>): Promise<WorkspaceGcReport> {
    const staleWorktrees: Array<{ path: string; branch?: string }> = []
    const lines = (await git(this.repositoryPath, ['worktree', 'list', '--porcelain'])).split(/\r?\n/)
    const known: string[] = []
    for (const path of knownWorktrees) known.push(await canonicalPath(path))
    const repositoryRoot = await canonicalPath(this.repositoryPath)
    let current: { path?: string; branch?: string } = {}
    const flush = async (): Promise<void> => {
      const currentPath = current.path ? await canonicalPath(current.path) : undefined
      if (currentPath && !known.includes(currentPath) && currentPath !== repositoryRoot) {
        const displayRoot = resolve(getMousseHomeDir(), 'repositories')
        const ownedRoot = await canonicalPath(displayRoot)
        const ownedRelative = relative(ownedRoot, currentPath)
        const owned = ownedRelative && !isAbsolute(ownedRelative) && !ownedRelative.startsWith('..') && !ownedRelative.includes(`..${sep}`)
        // Report paths under the configured MOUSSE_HOME spelling. Git may
        // canonicalize /var to /private/var on macOS, while callers and
        // cleanup commands use the configured path.
        // Active task branches and results not reachable from the destination retain ownership.
        const protectedTask = isMousseBranchName(current.branch)
        let unpublished = true
        try { await git(this.repositoryPath, ['merge-base', '--is-ancestor', await git(currentPath, ['rev-parse', 'HEAD']), 'HEAD']); unpublished = false } catch { /* retain uncertain results */ }
        if (owned && !protectedTask && !unpublished) staleWorktrees.push({ path: join(displayRoot, ownedRelative), branch: current.branch })
      }
      current = {}
    }
    for (const line of lines) {
      if (line.startsWith('worktree ')) { await flush(); current.path = line.slice(9) }
      else if (line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (!line) await flush()
    }
    await flush()
    const refs = (await git(this.repositoryPath, ['for-each-ref', '--format=%(refname)', 'refs/mousse'], LISTING_MAX_BUFFER)).split(/\r?\n/).filter(Boolean)
    const protectedRefs = new Set(referencedRefs)
    for (const ref of refs) {
      // Audit/undo references have no implicit expiration; explicit retirement must release them. A snapshot of a
      // worktree's files is work that exists nowhere else, whatever namespace pins it: it is never a candidate.
      if (PROTECTED_NAMESPACES.some((namespace) => ref.startsWith(namespace)) || await isSnapshot(this.repositoryPath, ref)) protectedRefs.add(ref)
      else try { await git(this.repositoryPath, ['merge-base', '--is-ancestor', ref, 'HEAD']) } catch { protectedRefs.add(ref) }
    }
    const revision = await git(this.repositoryPath, ['rev-parse', 'HEAD'])
    const refHeads: Record<string, string> = {}
    for (const ref of refs) refHeads[ref] = await git(this.repositoryPath, ['rev-parse', ref])
    const worktreeHeads: Record<string, string> = {}
    for (const item of staleWorktrees) if (await exists(item.path)) worktreeHeads[item.path] = await git(item.path, ['rev-parse', 'HEAD'])
    const report: WorkspaceGcReport = {
      staleWorktrees,
      unreferencedRefs: refs.filter((ref) => !protectedRefs.has(ref)),
      retainedRefs: refs.filter((ref) => protectedRefs.has(ref)),
      revision,
      refHeads,
      worktreeHeads
    }
    this.issuedReports.set(report, JSON.stringify(report))
    return report
  }

  async purge(report: WorkspaceGcReport, confirmed: boolean): Promise<void> {
    if (!confirmed) throw new Error('Workspace GC requires explicit confirmation of a dry-run report.')
    if (this.issuedReports.get(report) !== JSON.stringify(report)) throw new Error('Workspace GC requires a fresh report issued by this service.')
    const identity = await resolveRepositoryIdentityAsync(this.repositoryPath, { requireMutationCapability: true })
    const lease = await acquireRepositoryLease(identity)
    try {
      if (await git(this.repositoryPath, ['rev-parse', 'HEAD']) !== report.revision) throw new Error('GC destination revision changed; refresh inventory.')
      const fresh = await this.dryRun(new Set(), new Set(report.retainedRefs))
      for (const worktree of report.staleWorktrees) {
        const wanted = await canonicalPath(worktree.path)
        let stillStale = false
        for (const item of fresh.staleWorktrees) if (await canonicalPath(item.path) === wanted) { stillStale = true; break }
        if (!stillStale) throw new Error('GC worktree is now retained or is outside managed ownership.')
        if (!await exists(worktree.path)) continue
        if (await git(worktree.path, ['rev-parse', 'HEAD']) !== report.worktreeHeads?.[worktree.path]) throw new Error('GC worktree revision changed; refresh inventory.')
        // Git itself refuses dirty worktrees; no force removal is permitted.
        await git(this.repositoryPath, ['worktree', 'remove', worktree.path])
      }
      for (const ref of report.unreferencedRefs) {
        if (!fresh.unreferencedRefs.includes(ref) || !report.refHeads?.[ref]) throw new Error('GC reference is retained or changed; refresh inventory.')
        await git(this.repositoryPath, ['update-ref', '--no-deref', '-d', ref, report.refHeads[ref]])
      }
      this.issuedReports.delete(report)
    } finally {
      lease.release()
    }
  }
}
