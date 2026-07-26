import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import simpleGit, { SimpleGit } from 'simple-git'

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

  constructor(repoRoot?: string) {
    this.repoRoot = repoRoot || process.env.MOUSSE_REPO_ROOT || process.cwd()
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.git = simpleGit(this.repoRoot)
  }

  async init(): Promise<void> {
    if (!existsSync(this.worktreesBase)) {
      mkdirSync(this.worktreesBase, { recursive: true })
    }

    const isRepo = await this.git.checkIsRepo().catch(() => false)
    if (!isRepo) {
      console.warn(
        `[WorktreeManager] ${this.repoRoot} is not a git repo. Worktrees will use temp dirs only.`
      )
    }
  }

  getRepoRoot(): string {
    return this.repoRoot
  }

  getWorktreesBase(): string {
    return this.worktreesBase
  }

  setRepoRoot(repoRoot: string): void {
    this.repoRoot = repoRoot
    this.worktreesBase = join(this.repoRoot, '.mousse-worktrees')
    this.git = simpleGit(this.repoRoot)
    if (!existsSync(this.worktreesBase)) {
      mkdirSync(this.worktreesBase, { recursive: true })
    }
  }

  async createWorktree(agentId: string): Promise<WorktreeInfo> {
    const branch = `mousse/agent-${agentId.slice(0, 8)}`
    const worktreePath = join(this.worktreesBase, `agent-${agentId.slice(0, 8)}`)

    if (existsSync(worktreePath)) {
      rmSync(worktreePath, { recursive: true, force: true })
    }

    const isRepo = await this.git.checkIsRepo().catch(() => false)

    if (isRepo) {
      try {
        const branches = await this.git.branchLocal()
        if (branches.all.includes(branch)) {
          await this.git.branch(['-D', branch])
        }
        await this.git.raw(['worktree', 'add', '-b', branch, worktreePath])
      } catch (err) {
        // A plain directory inside a repository is not an isolated checkout. Running an
        // agent there can produce files that are absent from its nominal branch and are
        // then deleted after a no-op "merge". Fail the spawn instead.
        if (existsSync(worktreePath)) {
          rmSync(worktreePath, { recursive: true, force: true })
        }
        await this.git.raw(['worktree', 'prune']).catch(() => {})
        await this.git.branch(['-D', branch]).catch(() => {})
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`Failed to create isolated Git worktree ${branch}: ${message}`)
      }
    } else {
      mkdirSync(worktreePath, { recursive: true })
    }

    return { path: worktreePath, branch }
  }

  /**
   * Whether an agent still has an isolated branch/directory that can be finalized.
   * This deliberately does not trust the persisted agent status: older sessions could
   * mark a worker "completed" when it was merely ready to merge.
   */
  async hasMergeCandidate(worktreeInfo: WorktreeInfo): Promise<boolean> {
    const isRepo = await this.git.checkIsRepo().catch(() => false)
    if (!isRepo) return existsSync(worktreeInfo.path)

    // Do not use --quiet here. simple-git's default error detector can treat a silent
    // non-zero Git exit as success, which made missing branches look mergeable.
    return this.git.raw(['show-ref', '--verify', `refs/heads/${worktreeInfo.branch}`])
      .then(() => true)
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
    const isRepo = await this.git.checkIsRepo().catch(() => false)
    if (isRepo) {
      const listed = await this.listGitWorktreesUnderBase()
      for (const entry of listed) {
        const resolved = resolve(entry.path)
        if (knownPathSet.has(resolved)) continue
        // Primary worktree (repo root) is never an orphan agent tree.
        if (resolve(entry.path) === resolve(this.repoRoot)) continue
        if (!resolved.startsWith(resolve(this.worktreesBase) + sep) && resolved !== resolve(this.worktreesBase)) {
          continue
        }
        staleGitWorktrees.push(entry)
      }
    }

    return {
      basePath,
      knownAgentDirs,
      ghostDirectories,
      staleGitWorktrees,
      recoverableKnown
    }
  }

  /**
   * Explicitly remove one validated agent worktree and prune Git metadata.
   * Refuses paths outside `.mousse-worktrees` or that fail the agent naming check.
   * Does not delete cancelled/failed/ready worktrees unless the caller asks for that path.
   */
  async cleanupValidatedAgentWorktree(
    worktreeInfo: WorktreeInfo,
    options: { deleteBranch?: boolean } = {}
  ): Promise<{ success: boolean; error?: string; pruned?: boolean }> {
    const deleteBranch = options.deleteBranch !== false
    if (!this.isValidatedAgentWorktreePath(worktreeInfo.path)) {
      return {
        success: false,
        error: `Refusing to remove path that is not a validated agent worktree: ${worktreeInfo.path}`
      }
    }

    const isRepo = await this.git.checkIsRepo().catch(() => false)
    if (!isRepo) {
      if (existsSync(worktreeInfo.path)) {
        rmSync(worktreeInfo.path, { recursive: true, force: true })
      }
      return { success: true, pruned: false }
    }

    try {
      if (existsSync(worktreeInfo.path)) {
        await this.git.raw(['worktree', 'remove', worktreeInfo.path, '--force'])
      }
      await this.git.raw(['worktree', 'prune'])
      if (deleteBranch && worktreeInfo.branch) {
        await this.git.branch(['-D', worktreeInfo.branch]).catch(() => {})
      }
      // If git worktree remove left a plain directory (failed registration), remove only when validated.
      if (existsSync(worktreeInfo.path) && this.isValidatedAgentWorktreePath(worktreeInfo.path)) {
        rmSync(worktreeInfo.path, { recursive: true, force: true })
      }
      return { success: true, pruned: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.git.raw(['worktree', 'prune']).catch(() => {})
      return { success: false, error: message, pruned: true }
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

  async mergeAndRemove(
    worktreeInfo: WorktreeInfo
  ): Promise<{ success: boolean; error?: string; conflict?: boolean; conflicts?: string[] }> {
    const isRepo = await this.git.checkIsRepo().catch(() => false)
    if (!isRepo) {
      if (existsSync(worktreeInfo.path) && this.isValidatedAgentWorktreePath(worktreeInfo.path)) {
        rmSync(worktreeInfo.path, { recursive: true, force: true })
      }
      return { success: true }
    }

    try {
      // A retry after the parent resolved a previous conflict should finish that merge,
      // rather than trying to start a second merge.
      // Keep stderr enabled so an absent MERGE_HEAD rejects. With -q, simple-git can
      // resolve the exit-1 command and incorrectly enter the merge-retry path, skip the
      // real branch merge, then delete the branch and leave its commit dangling.
      const mergeInProgress = await this.git.raw(['rev-parse', '--verify', 'MERGE_HEAD'])
        .then(() => true)
        .catch(() => false)
      if (mergeInProgress) {
        const conflicts = (await this.git.raw(['diff', '--name-only', '--diff-filter=U']))
          .split(/\r?\n/)
          .filter(Boolean)
        if (conflicts.length > 0) {
          return {
            success: false,
            conflict: true,
            conflicts,
            error: `Unresolved merge conflicts: ${conflicts.join(', ')}`
          }
        }
        await this.git.commit(`Merge ${worktreeInfo.branch}`)
      } else {
        await this.git.merge([worktreeInfo.branch, '--no-edit'])
      }
      // Only remove validated agent worktrees after a successful merge.
      if (this.isValidatedAgentWorktreePath(worktreeInfo.path)) {
        await this.git.raw(['worktree', 'remove', worktreeInfo.path, '--force'])
        await this.git.raw(['worktree', 'prune']).catch(() => {})
      } else {
        console.warn(
          `[WorktreeManager] Merge succeeded but refused to remove non-validated path: ${worktreeInfo.path}`
        )
      }
      await this.git.branch(['-D', worktreeInfo.branch]).catch(() => {})
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const conflicts = await this.git.raw(['diff', '--name-only', '--diff-filter=U'])
        .then((output) => output.split(/\r?\n/).filter(Boolean))
        .catch(() => [] as string[])
      console.error('[WorktreeManager] merge failed:', message)
      if (conflicts.length > 0) {
        // Preserve MERGE_HEAD, the worktree, and the branch. The main agent can inspect and
        // resolve these files, then retry complete_task to commit and clean everything up.
        return { success: false, error: message, conflict: true, conflicts }
      }
      await this.git.merge(['--abort']).catch(() => {})
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
