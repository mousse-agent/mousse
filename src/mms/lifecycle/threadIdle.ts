import type { Thread, ThreadActivityState } from '../../shared/types'

/**
 * What `threadHasPendingWork` reads. Every member is a cheap, side-effect-free lookup by thread id.
 * None of them may start a turn, load a thread or hydrate a runtime.
 */
export interface ThreadIdleServices {
  orchestrator: {
    isTurnActive(threadId: string): boolean
    isActiveTurnRunning(threadId: string): boolean
  }
  /**
   * Runs that have not ended, whatever their state: running, waiting to start, held, or paused until a
   * usage limit resets. A paused run is neither active nor queued, so asking for those two would miss it.
   */
  runEngine?: { store: { listNonTerminalRuns(): Array<{ threadId: string; status: string }> } }
  /** Pending messages in the thread's durable queue, read from disk (not through a session). */
  pendingQueueLength(threadId: string): number
  questions: { listPendingForThread(threadId: string): unknown[] }
  ptyManager: { list(threadId: string): Array<{ ptyId: string }>; isAlive(ptyId: string): boolean }
  threadRuntimes: {
    /** Only a runtime that is already loaded; never `getOrHydrate`. */
    get(threadId: string): { agents: { list(): Array<{ status: string }> } } | undefined
    getActivitySnapshot(): Record<string, ThreadActivityState>
  }
  /** A workflow run or chat that belongs to one of these threads and has not finished. */
  executionBusy?(threadIds: ReadonlySet<string>): string | undefined
  /** Every thread, for finding subagents by lineage. */
  listThreads(): Array<Pick<Thread, 'id' | 'lineage'>>
}

const RUNNING_AGENT = new Set(['running', 'starting', 'merging'])

/** Thread ids below `threadId` by subagent lineage, at any depth. */
export function threadDescendants(threads: Array<Pick<Thread, 'id' | 'lineage'>>, threadId: string): string[] {
  const found = new Set<string>()
  for (let added = true; added;) {
    added = false
    for (const thread of threads) {
      const parent = thread.lineage?.parentThreadId
      if (parent && (parent === threadId || found.has(parent)) && !found.has(thread.id) && thread.id !== threadId) { found.add(thread.id); added = true }
    }
  }
  return [...found]
}

function ownPendingWork(services: ThreadIdleServices, threadId: string): string | undefined {
  if (services.orchestrator.isTurnActive(threadId) || services.orchestrator.isActiveTurnRunning(threadId)) return 'A turn is running'
  const run = services.runEngine?.store.listNonTerminalRuns().find((candidate) => candidate.threadId === threadId)
  if (run) return run.status === 'queued' ? 'A run is waiting to start' : run.status === 'paused' ? 'A run is paused until a usage limit resets' : 'A run is active'
  if (services.pendingQueueLength(threadId) > 0) return 'Messages are waiting in the queue'
  if (services.questions.listPendingForThread(threadId).length) return 'A question is waiting for an answer'
  if (services.ptyManager.list(threadId).some((pty) => services.ptyManager.isAlive(pty.ptyId))) return 'A terminal is open'
  const activity = services.threadRuntimes.getActivitySnapshot()[threadId]
  if (activity === 'waiting' || activity === 'awaiting_input' || activity === 'processing') return 'The thread is working or waiting for input'
  if (services.threadRuntimes.get(threadId)?.agents.list().some((agent) => RUNNING_AGENT.has(agent.status))) return 'An agent is running'
  return undefined
}

/**
 * Why a thread is not idle, or undefined when it is. Completed, interrupted and failed threads are
 * idle; so are settled ones. Pending work in any subagent, at any depth, makes the root thread busy.
 * Cheap checks run first and nothing here hydrates a runtime.
 */
export function threadHasPendingWork(services: ThreadIdleServices, threadId: string): string | undefined {
  const own = ownPendingWork(services, threadId)
  if (own) return own
  const family = [threadId, ...threadDescendants(services.listThreads(), threadId)]
  for (const id of family.slice(1)) {
    const reason = ownPendingWork(services, id)
    if (reason) return `A subagent is busy: ${reason}`
  }
  return services.executionBusy?.(new Set(family))
}
