/**
 * Per-thread runtime ownership (no Electron).
 * Holds agents, tasks, PTY membership, activity, and scrollback ownership keys.
 * Transcript/native context/queue live on ThreadSession (OrchestratorService).
 */

import { EventEmitter } from 'events'
import { AgentRegistry } from '../agents/AgentRegistry'
import { TaskQueue } from '../tasks/TaskQueue'
import type { Agent, Task, ThreadActivityState } from '../../shared/types'

export interface ThreadRuntimeSnapshot {
  threadId: string
  agents: Agent[]
  tasks: Task[]
  activity: ThreadActivityState
  connectionFailed: boolean
  ptyIds: string[]
  pendingQuestionRequestIds: string[]
}

/**
 * One hydrated runtime for a single threadId.
 * Never shared across threads; selection does not swap this instance.
 */
export class ThreadRuntime extends EventEmitter {
  readonly threadId: string
  readonly agents = new AgentRegistry()
  readonly tasks = new TaskQueue()
  /** Live PTY ids owned by this thread (daemon-side). */
  readonly ptyIds = new Set<string>()
  activity: ThreadActivityState = 'idle'
  connectionFailed = false
  /** Pending user-question request ids for this thread. */
  readonly pendingQuestionIds = new Set<string>()
  private hydrated = false

  constructor(threadId: string) {
    super()
    this.threadId = threadId
  }

  get isHydrated(): boolean {
    return this.hydrated
  }

  markHydrated(): void {
    this.hydrated = true
  }

  loadAgents(agents: Agent[]): void {
    this.agents.load(agents)
  }

  loadTasks(tasks: Task[]): void {
    this.tasks.load(tasks)
  }

  setActivity(state: ThreadActivityState): void {
    this.activity = state
    this.emit('activity', { threadId: this.threadId, state })
  }

  setConnectionFailed(failed: boolean): void {
    this.connectionFailed = failed
  }

  attachPty(ptyId: string): void {
    this.ptyIds.add(ptyId)
  }

  detachPty(ptyId: string): void {
    this.ptyIds.delete(ptyId)
  }

  snapshot(): ThreadRuntimeSnapshot {
    return {
      threadId: this.threadId,
      agents: this.agents.list(),
      tasks: this.tasks.list(),
      activity: this.activity,
      connectionFailed: this.connectionFailed,
      ptyIds: [...this.ptyIds],
      pendingQuestionRequestIds: [...this.pendingQuestionIds]
    }
  }

  /**
   * Whether this runtime owns non-deletable live work.
   */
  hasActiveResources(opts: {
    isTurnRunning: boolean
    hasPendingQuestions: boolean
    hasLivePtys: boolean
    hasRunningAgents: boolean
  }): boolean {
    if (opts.isTurnRunning) return true
    if (opts.hasPendingQuestions) return true
    if (opts.hasLivePtys) return true
    if (opts.hasRunningAgents) return true
    const busyAgent = this.agents
      .list()
      .some((a) => a.status === 'running' || a.status === 'starting' || a.status === 'merging')
    if (busyAgent) return true
    const busyTask = this.tasks
      .list()
      .some((t) => t.status === 'in_progress' || t.status === 'pending')
    if (busyTask && opts.isTurnRunning) return true
    return false
  }
}
