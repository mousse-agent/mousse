/**
 * What a bot's wakes wait on, read from the rest of Mousse (`BotEngineHost.wakeThread`, `pullRequestState`): a thread of
 * the owner's as it stands now, and a pull request of a repository the owner has as a project. `MmsProfileServices`
 * wires the reads; these only decide.
 */

export type WakeThreadState = { state: 'running' | 'idle' | 'archived' | 'deleted' | 'unreachable'; title?: string; lastRun?: { status: string; endedAt?: string } }

export interface WakeThreadDeps {
  /** The thread's record; undefined when it is gone. */
  thread(threadId: string): { name?: string; settledAt?: string } | undefined
  /** Whether the thread is in the trash or being deleted. */
  trashed(threadId: string): boolean
  /** Whether a bot whose home thread is `from` may see the thread (`botThreadReach`). */
  reachable(from: string, threadId: string): boolean
  /** Whether a run of the thread works, waits its turn, or is paused by a usage limit (it goes on by itself). */
  working(threadId: string): boolean
  /** The thread's newest run. */
  lastRun(threadId: string): { status: string; endedAt?: string | null } | undefined
}

/** A thread as a wake sees it. Deleted (or trashed) and archived come before reach: a gone thread is gone for anyone. */
export function wakeThreadState(deps: WakeThreadDeps, from: string, threadId: string): WakeThreadState {
  const thread = deps.thread(threadId)
  if (!thread || deps.trashed(threadId)) return { state: 'deleted' }
  if (!deps.reachable(from, threadId)) return { state: 'unreachable' }
  const title = thread.name?.trim() || undefined
  if (thread.settledAt) return { state: 'archived', ...(title ? { title } : {}) }
  if (deps.working(threadId)) return { state: 'running', ...(title ? { title } : {}) }
  const last = deps.lastRun(threadId)
  return { state: 'idle', ...(title ? { title } : {}), ...(last ? { lastRun: { status: last.status, ...(last.endedAt ? { endedAt: last.endedAt } : {}) } } : {}) }
}

export interface PullRequestStateDeps {
  /** The folders of the owner's projects. */
  folders(): string[]
  /** "owner/name" of a folder's repository (its code host's identity); throws when it has none. */
  repository(folder: string): Promise<string>
  /** A pull request of the folder's repository: its state and title. */
  pullRequest(folder: string, number: number): Promise<{ state: 'open' | 'closed' | 'merged'; title?: string }>
}

/**
 * A pull request's state, read through the first of the owner's projects whose repository is `repo` (compared without
 * case, as GitHub names them). `none` when no project is that repository; `problem` when the read failed.
 */
export async function pullRequestStateOf(deps: PullRequestStateDeps, repo: string, number: number): Promise<{ state: 'open' | 'closed' | 'merged'; title?: string } | { none: true } | { problem: string }> {
  const wanted = repo.trim().toLowerCase()
  for (const folder of deps.folders()) {
    let name: string
    try {
      name = await deps.repository(folder)
    } catch {
      continue
    }
    if (name.toLowerCase() !== wanted) continue
    try {
      const read = await deps.pullRequest(folder, number)
      return { state: read.state, ...(read.title ? { title: read.title } : {}) }
    } catch (error) {
      return { problem: error instanceof Error ? error.message : String(error) }
    }
  }
  return { none: true }
}
