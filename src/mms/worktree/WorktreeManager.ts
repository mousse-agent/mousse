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
        console.error('[WorktreeManager] git worktree add failed, using plain dir:', err)
        mkdirSync(worktreePath, { recursive: true })
      }
    } else {
      mkdirSync(worktreePath, { recursive: true })
    }

    return { path: worktreePath, branch }
  }

  async mergeAndRemove(worktreeInfo: WorktreeInfo): Promise<{ success: boolean; error?: string }> {
    const isRepo = await this.git.checkIsRepo().catch(() => false)
    if (!isRepo) {
      if (existsSync(worktreeInfo.path)) {
        rmSync(worktreeInfo.path, { recursive: true, force: true })
      }
      return { success: true }
    }

    try {
      await this.git.merge([worktreeInfo.branch, '--no-edit'])
      await this.git.raw(['worktree', 'remove', worktreeInfo.path, '--force'])
      await this.git.branch(['-D', worktreeInfo.branch]).catch(() => {})
      return { success: true }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error('[WorktreeManager] merge failed:', message)
      try {
        await this.git.raw(['worktree', 'remove', worktreeInfo.path, '--force'])
      } catch {
        /* ignore */
      }
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
