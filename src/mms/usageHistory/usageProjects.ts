import type { Project } from '../../shared/types'
import type { UsageHistoryResponse, UsageProjectRow } from '../../shared/usageHistory'

const norm = (path: string) => {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * The project a folder belongs to: a Mousse worktree's own project (its path holds `repositories/<project id>/`),
 * else the project whose folder holds it, else Bots for a bot's folder, else the folder's own name.
 */
export function usageProjectNamer(projects: readonly Project[]): (cwd: string) => string {
  const byId = new Map(projects.map((project) => [project.id, project.name]))
  const byPath = projects.map((project) => ({ path: norm(project.path), name: project.name })).sort((a, b) => b.path.length - a.path.length)
  return (cwd) => {
    if (!cwd) return 'Unknown folder'
    const path = norm(cwd)
    const repository = /\/repositories\/([^/]+)\//.exec(`${path}/`)?.[1]
    const own = repository ? projects.find((project) => norm(project.id) === repository) : undefined
    if (own) return byId.get(own.id)!
    const holder = byPath.find((entry) => path === entry.path || path.startsWith(`${entry.path}/`))
    if (holder) return holder.name
    // A bot works in its own folder under the profile: all of them count as one.
    if (/\/\.mousse\/profiles\/[^/]+\/bots\//.test(`${path}/`)) return 'Bots'
    return cwd.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || cwd
  }
}

/**
 * Gives this computer's history its project names, and each priciest session its thread where Mousse ran it. A
 * project's folders (worktrees, sub-folders) add up under its name.
 */
export function nameUsageProjects(
  history: UsageHistoryResponse,
  projects: readonly Project[],
  threadsFor: (sessionIds: string[]) => Map<string, string>,
  /** The thread's title, or undefined when there is no such thread here. */
  titleOf: (threadId: string) => string | undefined
): UsageHistoryResponse {
  const nameOf = usageProjectNamer(projects)
  const named = new Map<string, UsageProjectRow>()
  for (const row of history.projects) {
    const name = nameOf(row.name)
    const total = named.get(name) ?? { name, tokens: 0, costUsd: 0, sessions: 0 }
    total.tokens += row.tokens
    total.costUsd = Math.round((total.costUsd + row.costUsd) * 1e4) / 1e4
    total.sessions += row.sessions
    named.set(name, total)
  }
  let threads = new Map<string, string>()
  try {
    threads = threadsFor(history.topSessions.map((row) => row.session))
  } catch {
    // Without the run records the sessions are listed unlinked.
  }
  return {
    ...history,
    projects: [...named.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens),
    topSessions: history.topSessions.map((row) => {
      // Linked only to a thread this profile has (a run of another profile shares the database).
      const threadId = threads.get(row.session)
      const title = threadId ? titleOf(threadId) : undefined
      return { ...row, project: nameOf(row.project), ...(threadId && title !== undefined ? { threadId, title } : {}) }
    })
  }
}
