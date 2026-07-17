import { mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from 'fs'
import { dirname, join } from 'path'

export type AgentProgressStatus = 'working' | 'completed' | 'failed'

export interface AgentProgressUpdate {
  status: AgentProgressStatus
  progress?: number
  message?: string
  summary?: string
  updatedAt?: string
}

/**
 * A deliberately small, polling-based bridge between isolated agent processes and Mousse.
 * Polling is used instead of fs.watch because editors commonly replace JSON files atomically,
 * which makes fs.watch unreliable across platforms.
 */
export class TaskProgressMonitor {
  private paths = new Map<string, string>()

  start(
    agentId: string,
    worktreePath: string,
    onUpdate: (update: AgentProgressUpdate) => void
  ): string {
    return this.observe(agentId, worktreePath, onUpdate, true)
  }

  /**
   * Reattach to an agent after persisted state is loaded. Unlike start(), this must not
   * replace the worker's existing progress file (which may already say completed).
   */
  resume(
    agentId: string,
    worktreePath: string,
    onUpdate: (update: AgentProgressUpdate) => void
  ): string {
    return this.observe(agentId, worktreePath, onUpdate, false)
  }

  private observe(
    agentId: string,
    worktreePath: string,
    onUpdate: (update: AgentProgressUpdate) => void,
    initialize: boolean
  ): string {
    this.stop(agentId)
    const path = taskProgressPath(worktreePath)
    if (initialize) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        JSON.stringify({ status: 'working', progress: 0, message: 'Task started', updatedAt: new Date().toISOString() }, null, 2)
      )
    }
    this.paths.set(agentId, path)

    let lastContents = ''
    const readUpdate = (): void => {
      try {
        const contents = readFileSync(path, 'utf8')
        if (contents === lastContents) return
        const update = JSON.parse(contents) as AgentProgressUpdate
        lastContents = contents
        if (!['working', 'completed', 'failed'].includes(update.status)) return
        if (update.progress !== undefined) {
          update.progress = Math.max(0, Math.min(100, Number(update.progress)))
        }
        onUpdate(update)
      } catch {
        // Ignore partially-written or temporarily missing files; the next poll retries.
      }
    }

    // Reconciliation must happen immediately: watchFile only fires after a later change.
    readUpdate()
    if (this.paths.has(agentId)) {
      watchFile(path, { interval: 500, persistent: false }, readUpdate)
    }
    return path
  }

  stop(agentId: string): void {
    const path = this.paths.get(agentId)
    if (!path) return
    unwatchFile(path)
    this.paths.delete(agentId)
  }

  stopAll(): void {
    for (const agentId of this.paths.keys()) this.stop(agentId)
  }
}

export function taskProgressPath(worktreePath: string): string {
  return join(worktreePath, '.mousse', 'task-progress.json')
}

export function taskProgressInstructions(path: string): string {
  return `\n\n[Mousse task progress protocol]\nMousse is monitoring this file: ${path}\nUpdate it with valid JSON while you work, for example:\n{"status":"working","progress":50,"message":"Running tests","updatedAt":"${new Date().toISOString()}"}\nWhen implementation and verification are finished, commit all intended code changes on your branch, then write status "completed" and include a concise "summary". Do not commit the progress file. If you cannot finish, write status "failed" and explain why in "message". Do not delete the file. Do not merge the branch yourself.`
}
