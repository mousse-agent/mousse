import { existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import simpleGit, { SimpleGit } from 'simple-git'
import { GitStateInspector } from './GitStateInspector'
import { RepositoryContext } from './RepositoryContext'
import { WorktreeIdentity } from './WorktreeIdentity'

export interface WorktreeInfo {
  path: string
  branch: string
}

export interface GhostWorktreeEntry {
  path: string
  name: string
  reason: string
}

export interface OrphanWorktreeReport {
  /** Absolute base directory scanned (`.mousse-worktrees`). */
  basePath: string
  /** Directories that look like Mousse agent worktrees and match known agent records. */
  knownAgentDirs: string[]
  /**
   * Directories under the base path that are not registered git worktrees and are not
   * known agent paths — e.g. typo / progress-only folders. Reported only; never auto-deleted.
   */
  ghostDirectories: GhostWorktreeEntry[]
  /** Git worktree paths under the base that do not match any known agent record. */
  staleGitWorktrees: Array<{ path: string; branch?: string }>
  /** Known agent paths that still exist on disk (recoverable). */
  recoverableKnown: WorktreeInfo[]
}

/**
 * Matches directories created by createWorktree: `agent-` + first 8 chars of agentId.
 * Agent ids are normally UUIDs (hex), but tests and tooling may use other prefixes.
 */
const AGENT_DIR_PATTERN = /^agent-[0-9a-z][0-9a-z_-]{2,63}$/i

export class WorktreeManager {
  private git: SimpleGit
  private repoRoot: string
  private worktreesBase: string
  private repository?: RepositoryContext

  constructor(repoRoot: string) {
    if (!repoRoot?.trim()) throw new Error('WorktreeManager requires an explicit repository path.')
    this.repoRoot = resolve(repoRoot)
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.git = simpleGit(this.repoRoot)
  }

  async init(): Promise<void> {
    this.repository = await RepositoryContext.open(this.repoRoot)
    this.repoRoot = this.repository.root
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.git = this.repository.git
    if (!existsSync(this.worktreesBase)) mkdirSync(this.worktreesBase, { recursive: true })
  }

  private async getRepository(): Promise<RepositoryContext> {
    if (!this.repository) await this.init()
    return this.repository!
  }

  getRepoRoot(): string {
    return this.repoRoot
  }

  getWorktreesBase(): string {
    return this.worktreesBase
  }

  setRepoRoot(repoRoot: string): void {
    if (!repoRoot?.trim()) throw new Error('WorktreeManager requires an explicit repository path.')
    this.repoRoot = resolve(repoRoot)
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.git = simpleGit(this.repoRoot)
    this.repository = undefined
  }

  async createWorktree(agentId: string): Promise<WorktreeInfo> {
    const repository = await this.getRepository()
    const identity = WorktreeIdentity.forAgent(this.worktreesBase, agentId)
    if (existsSync(identity.path)) {
      throw new Error(`Refusing to reuse existing agent worktree path: ${identity.path}`)
    }
    const branchExists = await repository.git.raw(['show-ref', '--verify', `refs/heads/${identity.branch}`])
      .then(() => true).catch(() => false)
    if (branchExists) throw new Error(`Refusing to reuse existing agent branch: ${identity.branch}`)

    try {
      await repository.git.raw(['worktree', 'add', '-b', identity.branch, identity.path, 'HEAD'])
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`Failed to create isolated Git worktree ${identity.branch}: ${message}`)
    }
    return { path: identity.path, branch: identity.branch }
  }

  /**
   * Whether an agent still has an isolated branch/directory that can be finalized.
   * This deliberately does not trust the persisted agent status: older sessions could
   * mark a worker "completed" when it was merely ready to merge.
   */
  async hasMergeCandidate(worktreeInfo: WorktreeInfo): Promise<boolean> {
    const repository = await this.getRepository()
    return repository.git.raw(['show-ref', '--verify', `refs/heads/${worktreeInfo.branch}`])
      .then(() => existsSync(worktreeInfo.path))
      .catch(() => false)
  }

  /**
   * True when path is a directory under `.mousse-worktrees` with an agent-* name.
   * Prevents cleanup from touching unrelated project data.
   */
  isValidatedAgentWorktreePath(worktreePath: string): boolean {
    const resolved = resolve(worktreePath)
    const base = resolve(this.worktreesBase)
    if (resolved === base) return false
    const rel = relative(base, resolved)
    if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return false
    // Only direct children of the base (no nested arbitrary deletes).
    if (rel.includes(sep) || rel.includes('/')) return false
    return AGENT_DIR_PATTERN.test(basename(resolved))
  }

  /**
   * Read-only scan for orphan / ghost entries under `.mousse-worktrees`.
   * Never deletes. Use {@link cleanupValidatedAgentWorktree} for explicit removal.
   */
  async scanOrphanWorktrees(known: WorktreeInfo[] = []): Promise<OrphanWorktreeReport> {
    const basePath = this.worktreesBase
    const knownNormalized = known.map((entry) => ({
      path: resolve(entry.path),
      branch: entry.branch
    }))
    const knownPathSet = new Set(knownNormalized.map((entry) => entry.path))

    const ghostDirectories: GhostWorktreeEntry[] = []
    const knownAgentDirs: string[] = []
    const recoverableKnown: WorktreeInfo[] = []

    if (existsSync(basePath)) {
      for (const name of readdirSync(basePath)) {
        const full = resolve(basePath, name)
        let isDir = false
        try {
          isDir = statSync(full).isDirectory()
        } catch {
          continue
        }
        if (!isDir) continue

        if (knownPathSet.has(full)) {
          knownAgentDirs.push(full)
          const match = knownNormalized.find((entry) => entry.path === full)
          if (match) recoverableKnown.push(match)
          continue
        }

        const isAgentNamed = AGENT_DIR_PATTERN.test(name)
        const looksLikeGitWorktree = existsSync(join(full, '.git'))
        if (!looksLikeGitWorktree) {
          ghostDirectories.push({
            path: full,
            name,
            reason: isAgentNamed
              ? 'Agent-named directory without a Git worktree metadata file (possible typo or progress-only folder)'
              : 'Non-Git directory under .mousse-worktrees (not an agent worktree)'
          })
        } else if (!isAgentNamed) {
          ghostDirectories.push({
            path: full,
            name,
            reason: 'Git checkout under .mousse-worktrees with a non-agent directory name'
          })
        }
      }
    }

    const staleGitWorktrees: Array<{ path: string; branch?: string }> = []
    await this.getRepository()
    const listed = await this.listGitWorktreesUnderBase()
    for (const entry of listed) {
      const resolved = resolve(entry.path)
      if (knownPathSet.has(resolved)) continue
      // Primary worktree (repo root) is never an orphan agent tree.
      if (resolve(entry.path) === resolve(this.repoRoot)) continue
      if (!resolved.startsWith(resolve(this.worktreesBase) + sep) && resolved !== resolve(this.worktreesBase)) continue
      staleGitWorktrees.push(entry)
    }

    return {
      basePath,
      knownAgentDirs,
      ghostDirectories,
      staleGitWorktrees,
      recoverableKnown
    }
  }

  /** Explicit cleanup only: Git refuses dirty worktrees and does not alter other metadata. */
  async cleanupValidatedAgentWorktree(
    worktreeInfo: WorktreeInfo,
    options: { deleteBranch?: boolean } = {}
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.isValidatedAgentWorktreePath(worktreeInfo.path)) {
      return { success: false, error: `Refusing to remove path that is not a validated agent worktree: ${worktreeInfo.path}` }
    }
    try {
      const repository = await this.getRepository()
      if (existsSync(worktreeInfo.path)) await repository.git.raw(['worktree', 'remove', worktreeInfo.path])
      if (options.deleteBranch === true) await repository.git.branch(['-d', worktreeInfo.branch])
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  /**
   * Remove several validated agent worktrees. Skips invalid paths and returns per-path results.
   * Ghost directories from {@link scanOrphanWorktrees} are never deleted here.
   */
  async cleanupValidatedAgentWorktrees(
    worktrees: WorktreeInfo[],
    options: { deleteBranch?: boolean } = {}
  ): Promise<Array<{ path: string; success: boolean; error?: string }>> {
    const results: Array<{ path: string; success: boolean; error?: string }> = []
    for (const info of worktrees) {
      const result = await this.cleanupValidatedAgentWorktree(info, options)
      results.push({ path: info.path, success: result.success, error: result.error })
    }
    return results
  }

  private async listGitWorktreesUnderBase(): Promise<Array<{ path: string; branch?: string }>> {
    try {
      const raw = await this.git.raw(['worktree', 'list', '--porcelain'])
      const entries: Array<{ path: string; branch?: string }> = []
      let current: { path?: string; branch?: string } = {}
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('worktree ')) {
          if (current.path) entries.push({ path: current.path, branch: current.branch })
          current = { path: line.slice('worktree '.length).trim() }
        } else if (line.startsWith('branch ')) {
          const ref = line.slice('branch '.length).trim()
          current.branch = ref.replace(/^refs\/heads\//, '')
        } else if (line === '') {
          if (current.path) entries.push({ path: current.path, branch: current.branch })
          current = {}
        }
      }
      if (current.path) entries.push({ path: current.path, branch: current.branch })
      return entries
    } catch {
      return []
    }
  }

  async validateAgentReadiness(worktreeInfo: WorktreeInfo) {
    return new GitStateInspector(await this.getRepository()).inspectWorker(worktreeInfo)
  }

  async mergeAndRemove(
    worktreeInfo: WorktreeInfo
  ): Promise<{ success: boolean; error?: string; conflict?: boolean; conflicts?: string[] }> {
    const repository = await this.getRepository()
    // Validate at the merge boundary, not just when the worker first signals readiness.
    const readiness = await new GitStateInspector(repository).inspectWorker(worktreeInfo)
    if (!readiness.ready) return { success: false, error: readiness.reason }

    try {
      const mergeInProgress = await repository.git.raw(['rev-parse', '--verify', 'MERGE_HEAD'])
        .then(() => true).catch(() => false)
      if (mergeInProgress) {
        return {
          success: false,
          error: 'A merge is already in progress; resolve and commit it explicitly before retrying.'
        }
      }
      await repository.git.merge([worktreeInfo.branch, '--no-edit'])
      // Removal and branch deletion are intentionally separate explicit operations.
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const conflicts = await repository.git.raw(['diff', '--name-only', '--diff-filter=U'])
        .then((output) => output.split(/\r?\n/).filter(Boolean))
        .catch(() => [] as string[])
      if (conflicts.length > 0) return { success: false, error: message, conflict: true, conflicts }
      return { success: false, error: message }
    }
  }

  static resolveMacrosPath(): string {
    const moduleDir = dirname(fileURLToPath(import.meta.url))
    const candidates = [
      process.env.MOUSSE_MACROS_PATH,
      process.resourcesPath ? join(process.resourcesPath, 'macros') : undefined,
      resolve(moduleDir, '../../../macros'),
      resolve(moduleDir, '../../../../macros'),
      resolve(process.cwd(), 'macros')
    ].filter((value): value is string => Boolean(value))

    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }

    return resolve(process.cwd(), 'macros')
  }
}
