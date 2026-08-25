import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import simpleGit from 'simple-git'
import type { RepositoryContext } from './RepositoryContext'
import type { WorktreeInfo } from './WorktreeManager'

export interface WorkerStateInspection {
  ready: boolean
  reason?: string
  /** Immutable worker HEAD observed during validation. */
  commit?: string
  changedFiles?: string[]
}

const MOUSSE_CONTROL_FILES = new Set([
  '.mousse/task-progress.json',
  '.mousse/materialized-inputs.exclude'
])

export function isMousseControlFile(path: string): boolean {
  return MOUSSE_CONTROL_FILES.has(path.replace(/\\/g, '/'))
}

/** Read-only validation of a worker checkout immediately before it is accepted or merged. */
export class GitStateInspector {
  constructor(private readonly repository: RepositoryContext) {}

  async inspectWorker(worktree: WorktreeInfo): Promise<WorkerStateInspection> {
    if (!existsSync(worktree.path)) return { ready: false, reason: 'Agent worktree no longer exists.' }

    try {
      const workerPath = resolve(worktree.path)
      const registered = await this.repository.git.raw(['worktree', 'list', '--porcelain'])
      const entry = this.parseWorktrees(registered).find((item) => resolve(item.path) === workerPath)
      if (!entry || entry.branch !== worktree.branch) {
        return { ready: false, reason: 'Agent path and branch are not a registered matching worktree.' }
      }

      await this.repository.git.raw(['show-ref', '--verify', `refs/heads/${worktree.branch}`])
      const workerGit = simpleGit(workerPath)
      const status = await workerGit.status()
      const workingChanges = status.files.filter((file) => !isMousseControlFile(file.path))
      if (workingChanges.length > 0) {
        const changedFiles = workingChanges.map((file) => file.path.replace(/\\/g, '/'))
        return { ready: false, reason: `Agent left uncommitted changes: ${changedFiles.join(', ')}`, changedFiles }
      }

      const repositoryHead = (await this.repository.git.revparse(['HEAD'])).trim()
      const workerHead = (await workerGit.revparse(['HEAD'])).trim()
      const mergeBase = (await this.repository.git.raw(['merge-base', repositoryHead, workerHead])).trim()
      const commitsAhead = Number((await this.repository.git.raw([
        'rev-list', '--count', `${mergeBase}..${workerHead}`
      ])).trim())
      if (!Number.isSafeInteger(commitsAhead) || commitsAhead < 1) {
        return { ready: false, reason: 'Agent completed without creating a worker-authored commit.' }
      }

      const changedFiles = (await this.repository.git.raw(['diff', '--name-only', mergeBase, workerHead]))
        .split(/\r?\n/).filter(Boolean)
      if (changedFiles.length === 0) {
        return { ready: false, reason: 'Agent created only empty commits; the branch has no changes.' }
      }
      return { ready: true, commit: workerHead, changedFiles }
    } catch (error) {
      return { ready: false, reason: `Could not verify agent branch: ${error instanceof Error ? error.message : String(error)}` }
    }
  }

  private parseWorktrees(raw: string): Array<{ path: string; branch?: string }> {
    const entries: Array<{ path: string; branch?: string }> = []
    let current: { path?: string; branch?: string } = {}
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        if (current.path) entries.push({ path: current.path, branch: current.branch })
        current = { path: line.slice(9).trim() }
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice(7).trim().replace(/^refs\/heads\//, '')
      } else if (!line && current.path) {
        entries.push({ path: current.path, branch: current.branch })
        current = {}
      }
    }
    if (current.path) entries.push({ path: current.path, branch: current.branch })
    return entries
  }
}
