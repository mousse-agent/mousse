import { existsSync, mkdirSync, rmSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import simpleGit, { SimpleGit } from 'simple-git'

export interface WorktreeInfo {
  path: string
  branch: string
}

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

  async mergeAndRemove(
    worktreeInfo: WorktreeInfo
  ): Promise<{ success: boolean; error?: string; conflict?: boolean; conflicts?: string[] }> {
    const isRepo = await this.git.checkIsRepo().catch(() => false)
    if (!isRepo) {
      if (existsSync(worktreeInfo.path)) {
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
      await this.git.raw(['worktree', 'remove', worktreeInfo.path, '--force'])
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
