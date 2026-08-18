/**
 * Owns ThreadRuntime instances keyed by explicit threadId.
 * Hydrates from ThreadDataStore; persists agents/tasks without clobbering queue.
 * Subscribes once per runtime to agent/task registry updates for protocol fan-out.
 * No Electron imports.
 */

import { EventEmitter } from 'events'
import type { ThreadDataStore } from '../data/ThreadDataStore'
import type { OrchestratorService } from '../orchestrator/OrchestratorService'
import type { PtyManager } from '../terminals/PtyManager'
import type { UserQuestionService } from '../orchestrator/UserQuestionService'
import { ThreadRuntime } from './ThreadRuntime'
import type { Agent, AgentStatus, Task, ThreadActivityState } from '../../shared/types'

const PROCESSING_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'starting',
  'running',
  'merging'
])

/** A thread remains processing while any worker it owns is still doing work. */
export function deriveThreadActivity(
  turnActivity: ThreadActivityState,
  agents: ReadonlyArray<Pick<Agent, 'status'>>
): ThreadActivityState {
  return agents.some((agent) => PROCESSING_AGENT_STATUSES.has(agent.status))
    ? 'processing'
    : turnActivity
}

interface RuntimeListenerBundle {
  onAgents: () => void
  onTasks: () => void
}

export class ThreadRuntimeManager extends EventEmitter {
  private readonly runtimes = new Map<string, ThreadRuntime>()
  private readonly registryListeners = new Map<string, RuntimeListenerBundle>()
  /** Turn lifecycle state before thread-owned background agent work is folded in. */
  private readonly turnActivity = new Map<string, ThreadActivityState>()
  private threadStore: ThreadDataStore | null = null
  private orchestrator: OrchestratorService | null = null
  private ptyManager: PtyManager | null = null
  private questions: UserQuestionService | null = null

  attach(deps: {
    threadStore: ThreadDataStore
    orchestrator: OrchestratorService
    ptyManager: PtyManager
    questions: UserQuestionService
  }): void {
    this.threadStore = deps.threadStore
    this.orchestrator = deps.orchestrator
    this.ptyManager = deps.ptyManager
    this.questions = deps.questions

    // Wire per-session agent/task registries from orchestrator hydration.
    deps.orchestrator.setRuntimeManager(this)
  }

  get(threadId: string): ThreadRuntime | undefined {
    return this.runtimes.get(threadId)
  }

  /**
   * Hydrate or return existing runtime. Loads agents/tasks from disk once.
   * Does not call getOrCreateSession (avoids recursion). Does not kill PTYs.
   * Subscribes once per runtime to agent/task updates.
   */
  getOrHydrate(threadId: string): ThreadRuntime {
    let rt = this.runtimes.get(threadId)
    if (rt?.isHydrated) return rt
    if (!rt) {
      rt = new ThreadRuntime(threadId)
      this.runtimes.set(threadId, rt)
      this.turnActivity.set(threadId, rt.activity)
      this.attachRegistryListeners(threadId, rt)
    }
    if (this.threadStore?.getThread(threadId)) {
      const data = this.threadStore.loadThreadData(threadId)
      rt.loadAgents(data.agents ?? [])
      rt.loadTasks(data.tasks ?? [])
    }
    // Sync into an existing orchestrator session only (no create — that would re-enter).
    this.orchestrator?.bindRuntimeRegistries?.(threadId, rt.agents, rt.tasks)
    rt.agents.setPersistCallback(() => this.persistAgentsTasks(threadId))
    rt.tasks.setPersistCallback(() => this.persistAgentsTasks(threadId))
    rt.markHydrated()
    return rt
  }

  private attachRegistryListeners(threadId: string, rt: ThreadRuntime): void {
    if (this.registryListeners.has(threadId)) return
    const onAgents = (): void => {
      const agents = rt.agents.list()
      const hasProcessingAgent = agents.some((agent) =>
        PROCESSING_AGENT_STATUSES.has(agent.status)
      )
      // Agent resume/spawn can happen outside a foreground turn. In that case the
      // eventual resting state is completed rather than dropping back to no indicator.
      if (
        hasProcessingAgent &&
        (this.turnActivity.get(threadId) ?? 'idle') === 'idle'
      ) {
        this.turnActivity.set(threadId, 'completed')
      }
      this.publishDerivedActivity(threadId, rt)
      this.emit('agents.updated', {
        threadId,
        agents
      })
    }
    const onTasks = (): void => {
      this.emit('tasks.updated', {
        threadId,
        tasks: rt.tasks.list()
      })
    }
    rt.agents.on('updated', onAgents)
    rt.tasks.on('updated', onTasks)
    this.registryListeners.set(threadId, { onAgents, onTasks })
  }

  private detachRegistryListeners(threadId: string, rt: ThreadRuntime): void {
    const bundle = this.registryListeners.get(threadId)
    if (!bundle) return
    rt.agents.off('updated', bundle.onAgents)
    rt.tasks.off('updated', bundle.onTasks)
    this.registryListeners.delete(threadId)
  }

  /**
   * Persist agents+tasks only — never messageQueue / messages / llmContext here.
   * Merges with existing thread data so concurrent turn persistence cannot clobber.
   */
  persistAgentsTasks(threadId: string): void {
    if (!this.threadStore?.getThread(threadId)) return
    const rt = this.runtimes.get(threadId)
    if (!rt) return
    this.threadStore.mutateThreadData(threadId, (current) => ({
      agents: rt.agents.list(),
      tasks: rt.tasks.list(),
      messages: current.messages,
      llmContext: current.llmContext,
      mousseAgentSessions: current.mousseAgentSessions
    }))
  }

  listAgents(threadId: string): Agent[] {
    return this.getOrHydrate(threadId).agents.list()
  }

  listTasks(threadId: string): Task[] {
    return this.getOrHydrate(threadId).tasks.list()
  }

  createTask(
    threadId: string,
    input: { description: string; agentId?: string; status?: Task['status'] }
  ): Task {
    const rt = this.getOrHydrate(threadId)
    return rt.tasks.createTask(input)
  }

  updateTask(
    threadId: string,
    id: string,
    patch: {
      description?: string
      status?: Task['status']
      progress?: number
      message?: string
      summary?: string
      agentId?: string | null
    }
  ): Task {
    const rt = this.getOrHydrate(threadId)
    const task = rt.tasks.update(id, patch)
    if (!task) throw new Error(`Task not found: ${id}`)
    return task
  }

  setActivity(threadId: string, state: ThreadActivityState): void {
    const rt = this.getOrHydrate(threadId)
    this.turnActivity.set(threadId, state)
    // A parent turn may finish before its background agents. Publish the derived
    // ownership state so the sidebar does not show a false completion.
    this.publishDerivedActivity(threadId, rt, true)
  }

  setTurnStatePhase(threadId: string, phase: import('../../shared/types').TurnPhase): void {
    const base: ThreadActivityState = phase === 'awaiting_input' ? 'awaiting_input' : (['queued','thinking','streaming','tool_running','finalizing'] as readonly string[]).includes(phase) ? 'processing' : 'idle'
    this.setActivity(threadId, base)
  }

  private publishDerivedActivity(
    threadId: string,
    rt: ThreadRuntime,
    force = false
  ): void {
    const state = deriveThreadActivity(
      this.turnActivity.get(threadId) ?? rt.activity,
      rt.agents.list()
    )
    if (!force && state === rt.activity) return
    if (state !== rt.activity) rt.setActivity(state)
    // Always fan out a full authoritative map so clients merge, never clobber.
    const activity = this.getActivitySnapshot()
    this.emit('activity', { threadId, state, activity })
    this.emit('activity.snapshot', { activity })
  }

  getActivity(threadId: string): ThreadActivityState {
    return this.getOrHydrate(threadId).activity
  }

  getActivitySnapshot(): Record<string, ThreadActivityState> {
    const out: Record<string, ThreadActivityState> = {}
    for (const [id, rt] of this.runtimes) {
      out[id] = rt.activity
    }
    return out
  }

  registerPty(threadId: string, ptyId: string): void {
    this.getOrHydrate(threadId).attachPty(ptyId)
  }

  unregisterPty(threadId: string, ptyId: string): void {
    this.runtimes.get(threadId)?.detachPty(ptyId)
  }

  /**
   * Refuse deletion when the thread owns active turn/agent/task/PTY/question work.
   */
  assertDeletable(threadId: string): void {
    const rt = this.getOrHydrate(threadId)
    const turnRunning = this.orchestrator?.isActiveTurnRunning(threadId) ?? false
    const pendingQ = this.questions?.listPendingForThread(threadId) ?? []
    const livePtys = [...rt.ptyIds].filter((id) => this.ptyManager?.isAlive(id))
    const runningAgents = rt.agents
      .list()
      .some((a) => a.status === 'running' || a.status === 'starting' || a.status === 'merging')
    if (
      rt.hasActiveResources({
        isTurnRunning: turnRunning,
        hasPendingQuestions: pendingQ.length > 0,
        hasLivePtys: livePtys.length > 0,
        hasRunningAgents: runningAgents
      })
    ) {
      throw new Error(
        `Cannot delete thread ${threadId}: active turn, agent, PTY, or pending question`
      )
    }
  }

  /**
   * Tear down runtime after deletion is authorized.
   * Does not delete the thread record — caller does that.
   */
  disposeRuntime(threadId: string): void {
    const rt = this.runtimes.get(threadId)
    if (!rt) return
    this.detachRegistryListeners(threadId, rt)
    for (const ptyId of rt.ptyIds) {
      try {
        this.ptyManager?.kill(ptyId)
      } catch {
        /* ignore */
      }
    }
    this.questions?.dismissAllForThread(threadId)
    this.runtimes.delete(threadId)
    this.turnActivity.delete(threadId)
  }

  /**
   * Startup: hydrate runtimes for threads with durable agents/tasks/queue work.
   * Marks non-reattachable PTY as interrupted (no live process after daemon restart).
   */
  restoreOnStartup(): void {
    if (!this.threadStore) return
    for (const thread of this.threadStore.listAllThreads()) {
      if (thread.settledAt) continue
      const data = this.threadStore.loadThreadData(thread.id)
      const hasWork =
        (data.agents?.length ?? 0) > 0 ||
        (data.tasks?.length ?? 0) > 0 ||
        (data.messageQueue?.length ?? 0) > 0 ||
        (data.mousseAgentSessions?.length ?? 0) > 0
      if (!hasWork && !this.threadStore.isThreadStarted(thread.id)) continue
      const rt = this.getOrHydrate(thread.id)
      for (const agent of rt.agents.list()) {
        if (agent.ptyId && !this.ptyManager?.isAlive(agent.ptyId)) {
          if (agent.status === 'running' || agent.status === 'starting') {
            rt.agents.updateStatus(agent.id, 'interrupted')
          }
        }
      }
      for (const task of rt.tasks.list()) {
        if (task.status === 'in_progress') {
          rt.tasks.updateStatus(task.id, 'interrupted')
        }
      }
    }
  }
}
