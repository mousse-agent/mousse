import { ResourceLifecycleError } from '../lifecycle/ResourceLifecycleStore'
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
import type { UnseenDoneStore } from './UnseenDoneStore'
import type { Agent, AgentStatus, Task, ThreadActivityState } from '../../shared/types'
import { forEachYielding } from '../startup/startupTiming'

const BUSY_AGENT_STATUSES: ReadonlySet<AgentStatus> = new Set([
  'starting',
  'running',
  'merging'
])

/**
 * A live turn keeps its own state (Working, Waiting on a wait tool, or Input). Once it ends,
 * thread-owned agents, delegated tasks, provider background work (Claude's background agents and
 * shells) or the thread's own monitors, background commands and `keep_working` holds that are still
 * running hold the thread in Waiting instead of Done, since they report back to it.
 */
export function deriveThreadActivity(
  turnActivity: ThreadActivityState,
  agents: ReadonlyArray<Pick<Agent, 'status'>>,
  hasPendingDelegations = false,
  hasBackgroundWork = false
): ThreadActivityState {
  if (turnActivity !== 'idle' && turnActivity !== 'completed') return turnActivity
  return hasPendingDelegations || hasBackgroundWork || agents.some((agent) => BUSY_AGENT_STATUSES.has(agent.status))
    ? 'waiting'
    : turnActivity
}

interface RuntimeListenerBundle {
  onAgents: () => void
  onTasks: () => void
}

export class ThreadRuntimeManager extends EventEmitter {
  private readonly runtimes = new Map<string, ThreadRuntime>()

  /** How many thread runtimes are held (the memory monitor's count). */
  runtimeCount(): number {
    return this.runtimes.size
  }
  private readonly registryListeners = new Map<string, RuntimeListenerBundle>()
  /** Turn lifecycle state before thread-owned background agent work is folded in. */
  private readonly turnActivity = new Map<string, ThreadActivityState>()
  /** Threads with delegated tasks still running. */
  private readonly pendingDelegations = new Set<string>()
  /** Threads whose provider still runs background work (Claude's agents and shells). */
  private readonly pendingBackgroundWork = new Set<string>()
  /** Threads with a monitor, a background command or a `keep_working` hold running (`ThreadMonitors`). */
  private readonly pendingMonitors = new Set<string>()
  private threadStore: ThreadDataStore | null = null
  private orchestrator: OrchestratorService | null = null
  private ptyManager: PtyManager | null = null
  private questions: UserQuestionService | null = null
  /** Threads showing Done: finished, and not seen in a window since. Kept across restarts. */
  private unseenDone: UnseenDoneStore | null = null
  /** When each runtime was last used (hydrated, read through `getOrHydrate`, given an activity or a terminal). */
  private readonly lastUse = new Map<string, number>()
  /** The idle sweep's clock (`ThreadResidency.now`), so the sweep and the uses above are timed alike. */
  private now: () => number = Date.now
  /**
   * The threads listed when the service restarted whose agents and tasks from before the restart are not settled yet
   * (`beginRestart`): each is settled once, on its first use or by the background pass, whichever comes first.
   */
  private restartPending: Set<string> | null = null

  attach(deps: {
    threadStore: ThreadDataStore
    orchestrator: OrchestratorService
    ptyManager: PtyManager
    questions: UserQuestionService
    unseenDone?: UnseenDoneStore
  }): void {
    this.threadStore = deps.threadStore
    this.orchestrator = deps.orchestrator
    this.ptyManager = deps.ptyManager
    this.questions = deps.questions
    this.unseenDone = deps.unseenDone ?? null

    // Wire per-session agent/task registries from orchestrator hydration.
    deps.orchestrator.setRuntimeManager(this)
  }

  get(threadId: string): ThreadRuntime | undefined {
    return this.runtimes.get(threadId)
  }

  setClock(now: () => number): void {
    this.now = now
  }

  /**
   * Hydrate or return existing runtime. Loads agents/tasks from disk once.
   * Does not call getOrCreateSession (avoids recursion). Does not kill PTYs.
   * Subscribes once per runtime to agent/task updates.
   */
  getOrHydrate(threadId: string): ThreadRuntime {
    let rt = this.runtimes.get(threadId)
    this.lastUse.set(threadId, this.now())
    if (rt?.isHydrated) return rt
    if (!rt) {
      rt = new ThreadRuntime(threadId)
      this.runtimes.set(threadId, rt)
      this.turnActivity.set(threadId, rt.activity)
      this.attachRegistryListeners(threadId, rt)
    }
    if (this.threadStore?.getThread(threadId)) {
      const data = this.threadStore.loadThreadWorkState(threadId)
      rt.loadAgents(data.agents)
      rt.loadTasks(data.tasks)
    }
    // Sync into an existing orchestrator session only (no create — that would re-enter).
    this.orchestrator?.bindRuntimeRegistries?.(threadId, rt.agents, rt.tasks)
    rt.agents.setPersistCallback(() => this.persistAgentsTasks(threadId))
    rt.tasks.setPersistCallback(() => this.persistAgentsTasks(threadId))
    rt.markHydrated()
    // A thread used before the restart's pass reached it is settled now, before anything reads its agents.
    if (this.restartPending?.has(threadId)) this.settleRestarted(threadId, rt)
    return rt
  }

  private attachRegistryListeners(threadId: string, rt: ThreadRuntime): void {
    if (this.registryListeners.has(threadId)) return
    const onAgents = (): void => {
      const agents = rt.agents.list()
      const hasBusyAgent = agents.some((agent) =>
        BUSY_AGENT_STATUSES.has(agent.status)
      )
      // Agent resume/spawn can happen outside a foreground turn. In that case the
      // eventual resting state is completed rather than dropping back to no indicator.
      if (
        hasBusyAgent &&
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
    // Fields left out keep what is stored; only agents and tasks are written.
    this.threadStore.mutateThreadData(threadId, () => ({
      agents: rt.agents.list(),
      tasks: rt.tasks.list()
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

  /** Whether the thread waits on delegated tasks, provider background work or a busy agent of its own. */
  waitsOnWork(threadId: string): boolean {
    if (this.pendingDelegations.has(threadId) || this.pendingBackgroundWork.has(threadId) || this.pendingMonitors.has(threadId)) return true
    return Boolean(this.runtimes.get(threadId)?.agents.list().some((agent) => BUSY_AGENT_STATUSES.has(agent.status)))
  }

  /** Whether `threadId` has delegated tasks still running; they wake it when they finish. */
  setPendingDelegations(threadId: string, pending: boolean): void {
    if (pending === this.pendingDelegations.has(threadId)) return
    if (pending) this.pendingDelegations.add(threadId)
    else this.pendingDelegations.delete(threadId)
    this.publishDerivedActivity(threadId, this.getOrHydrate(threadId))
  }

  /** Whether the thread's provider still runs background work for it; the thread shows Waiting meanwhile. */
  setPendingBackgroundWork(threadId: string, pending: boolean): void {
    if (pending === this.pendingBackgroundWork.has(threadId)) return
    if (pending) this.pendingBackgroundWork.add(threadId)
    else this.pendingBackgroundWork.delete(threadId)
    this.publishDerivedActivity(threadId, this.getOrHydrate(threadId))
  }

  /** Whether the thread has monitors, background commands or a `keep_working` hold running; it shows Waiting meanwhile. */
  setPendingMonitors(threadId: string, pending: boolean): void {
    if (pending === this.pendingMonitors.has(threadId)) return
    if (pending) this.pendingMonitors.add(threadId)
    else this.pendingMonitors.delete(threadId)
    this.publishDerivedActivity(threadId, this.getOrHydrate(threadId))
  }

  private publishDerivedActivity(
    threadId: string,
    rt: ThreadRuntime,
    force = false
  ): void {
    const state = deriveThreadActivity(
      this.turnActivity.get(threadId) ?? rt.activity,
      rt.agents.list(),
      this.pendingDelegations.has(threadId),
      this.pendingBackgroundWork.has(threadId) || this.pendingMonitors.has(threadId)
    )
    if (!force && state === rt.activity) return
    if (state !== rt.activity) rt.setActivity(state)
    this.noteDone(threadId, state)
    // Always fan out a full authoritative map so clients merge, never clobber.
    const activity = this.getActivitySnapshot()
    this.emit('activity', { threadId, state, activity })
    this.emit('activity.snapshot', { activity })
  }

  /**
   * Done means the thread finished and nobody has looked since: the mark is set when its work cycle ends and
   * dropped when the next one starts (or the thread is seen). A personal bot's chat is never listed, so never marked.
   */
  private noteDone(threadId: string, state: ThreadActivityState): void {
    if (!this.unseenDone) return
    if (state !== 'completed') {
      this.unseenDone.delete(threadId)
      return
    }
    if (this.unseenDone.has(threadId) || this.threadStore?.getThread(threadId)?.botOwned) return
    this.unseenDone.add(threadId)
  }

  /**
   * A window opened the thread, or showed it in focus: its Done, and the Done of its subagents (which its row
   * shows rolled up), is cleared and every window is told. Seeing a thread is not activity on it: it moves no
   * updated time and no list. True when something showed Done.
   */
  markSeen(threadId: string): boolean {
    const ids = [threadId, ...(this.unseenDone?.list() ?? []).filter((id) => id !== threadId && this.descendsFrom(id, threadId))]
    let cleared = false
    for (const id of ids) {
      if (this.unseenDone?.delete(id)) cleared = true
      const rt = this.runtimes.get(id)
      // Still waiting on its background work: Done is set again when that finishes.
      if (!rt || rt.activity !== 'completed' || this.turnActivity.get(id) !== 'completed') continue
      this.turnActivity.set(id, 'idle')
      this.publishDerivedActivity(id, rt)
      cleared = true
    }
    return cleared
  }

  private descendsFrom(threadId: string, ancestorId: string): boolean {
    let current = this.threadStore?.getThread(threadId)?.lineage?.parentThreadId
    for (let depth = 0; current && depth < 64; depth++) {
      if (current === ancestorId) return true
      current = this.threadStore?.getThread(current)?.lineage?.parentThreadId
    }
    return false
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
  /** `ignoreTurn`: a bot's turn there, which the accepted trash stops in its drain. */
  /** `ignoreQuestions`: the thread's questions belong to a turn a delete is about to stop, which ends them. */
  assertDeletable(threadId: string, options: { ignoreTurn?: boolean; ignoreQuestions?: boolean } = {}): void {
    const rt = this.getOrHydrate(threadId)
    const turnRunning = !options.ignoreTurn && (this.orchestrator?.isActiveTurnRunning(threadId) ?? false)
    const pendingQ = options.ignoreQuestions ? [] : this.questions?.listPendingForThread(threadId) ?? []
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
      throw new ResourceLifecycleError('busy', 'Cannot delete thread: active turn, agent, PTY, or pending question')
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
    this.pendingDelegations.delete(threadId)
    this.pendingBackgroundWork.delete(threadId)
    this.pendingMonitors.delete(threadId)
    this.unseenDone?.delete(threadId)
    this.lastUse.delete(threadId)
  }

  /**
   * Why the thread's runtime must stay in memory, or undefined when dropping it loses nothing: its agents and tasks
   * are saved on every change and read back by `getOrHydrate`, and its activity is what a restart shows (Idle, or a
   * personal bot's chat that nothing lists). Cheap and synchronous; never hydrates.
   */
  runtimeHoldReason(threadId: string): string | undefined {
    const rt = this.runtimes.get(threadId)
    if (!rt) return undefined
    // A loaded session shares the runtime's agent and task registries; the session's release comes first.
    if (this.orchestrator?.hasSession(threadId)) return 'thread loaded'
    if (this.orchestrator?.isTurnActive(threadId) || this.orchestrator?.isActiveTurnRunning(threadId)) return 'turn running'
    if (!this.activityRebuiltByRestart(threadId, rt.activity) || !this.activityRebuiltByRestart(threadId, this.turnActivity.get(threadId) ?? rt.activity))
      return 'activity shown'
    if (this.pendingDelegations.has(threadId) || this.pendingBackgroundWork.has(threadId) || this.pendingMonitors.has(threadId)) return 'waiting on work'
    if (rt.agents.list().some((agent) => BUSY_AGENT_STATUSES.has(agent.status))) return 'agent running'
    if (rt.tasks.list().some((task) => task.status === 'in_progress')) return 'task in progress'
    if (rt.ptyIds.size) return 'terminal open'
    if (rt.pendingQuestionIds.size || this.questions?.listPendingForThread(threadId).length) return 'question pending'
    if (rt.connectionFailed) return 'connection failed'
    return undefined
  }

  /** Idle is what every thread shows after a restart; Done only when it is marked unseen, which is kept. */
  private activityRebuiltByRestart(threadId: string, state: ThreadActivityState): boolean {
    if (state === 'idle') return true
    if (state !== 'completed' || this.unseenDone?.has(threadId)) return false
    // A personal bot's chat is never listed, so its Done is never shown or marked.
    return Boolean(this.threadStore?.getThread(threadId)?.botOwned)
  }

  /**
   * Drops the thread's runtime when nothing holds it (`runtimeHoldReason`, and `keep`). Kills nothing and dismisses
   * nothing: a held runtime stays as it is. Emits nothing; the next use hydrates it again from disk. True when dropped.
   */
  releaseRuntime(threadId: string, keep?: (threadId: string) => string | undefined): boolean {
    const rt = this.runtimes.get(threadId)
    if (!rt) return false
    if (this.runtimeHoldReason(threadId) !== undefined || keep?.(threadId) !== undefined) return false
    this.detachRegistryListeners(threadId, rt)
    this.runtimes.delete(threadId)
    this.turnActivity.delete(threadId)
    this.lastUse.delete(threadId)
    return true
  }

  /**
   * The idle sweep (`ThreadResidency.sweepNow`): drops runtimes unused for `idleMs` before `now`, and at once those
   * of archived threads, unless something holds them. Returns the threads dropped.
   */
  releaseIdleRuntimes(idleMs: number, now: number, keep?: (threadId: string) => string | undefined): string[] {
    const out: string[] = []
    for (const threadId of [...this.runtimes.keys()]) {
      let since = this.lastUse.get(threadId)
      if (since === undefined) this.lastUse.set(threadId, (since = now))
      const thread = this.threadStore?.getThread(threadId)
      const archived = Boolean(thread?.settledAt)
      if (!archived && now - since < idleMs) continue
      if (this.releaseRuntime(threadId, keep)) out.push(threadId)
    }
    return out
  }

  /**
   * Startup: hydrate runtimes for threads with durable agents/tasks/queue work.
   * Marks non-reattachable PTY as interrupted (no live process after daemon restart).
   */
  /** The restart's pass in one go: every listed thread is settled before this returns (`beginRestart`). */
  restoreOnStartup(): void {
    this.beginRestart()
    for (const threadId of [...(this.restartPending ?? [])]) this.settleRestarted(threadId)
    this.restartPending = null
  }

  /**
   * Begins the restart's pass. Agents and tasks a restart cut short are marked interrupted, for every thread listed
   * now: on the thread's first use (`getOrHydrate`), or by `settleRestartedThreads`, whichever comes first. So the
   * service is ready without reading every thread, and nothing sees an agent from before the restart as running.
   * Done marks are restored now.
   */
  beginRestart(): void {
    if (!this.threadStore) return
    this.restartPending = new Set(this.threadStore.listAllThreads().filter((thread) => !thread.settledAt).map((thread) => thread.id))
    for (const threadId of [...this.restartPending]) {
      const rt = this.runtimes.get(threadId)
      if (rt?.isHydrated) this.settleRestarted(threadId, rt)
    }
    // Done outlives the service: threads that finished unseen before the restart show Done again. A thread that
    // is gone or archived since is no longer listed, so its mark is dropped.
    for (const threadId of this.unseenDone?.list() ?? []) {
      const thread = this.threadStore.getThread(threadId)
      if (!thread || thread.settledAt) {
        this.unseenDone?.delete(threadId)
        continue
      }
      // Hydrated first: a runtime made here starts its turn state from its own (idle) activity.
      const rt = this.getOrHydrate(threadId)
      this.turnActivity.set(threadId, 'completed')
      this.publishDerivedActivity(threadId, rt)
    }
  }

  /** The rest of the restart's pass, in the background: the threads nothing used yet, a few at a time. */
  async settleRestartedThreads(shouldStop: () => boolean = () => false): Promise<void> {
    const pending = this.restartPending
    if (!pending) return
    await forEachYielding([...pending], (threadId) => this.settleRestarted(threadId), shouldStop)
    if (this.restartPending === pending && !pending.size) this.restartPending = null
  }

  /** Marks interrupted what the restart cut short in one thread, once. `rt`: its runtime, already hydrated. */
  private settleRestarted(threadId: string, rt?: ThreadRuntime): void {
    if (!this.restartPending?.delete(threadId) || !this.threadStore) return
    try {
      if (!rt) {
        if (!this.threadStore.getThread(threadId)) return
        const data = this.threadStore.loadThreadWorkState(threadId)
        // Only threads with work to look at: a runtime for every started thread is what the idle sweep later drops.
        const hasWork = data.agents.length > 0 || data.tasks.length > 0 || data.queued > 0 || data.sessions > 0
        if (!hasWork) return
        rt = this.getOrHydrate(threadId)
      }
      for (const agent of rt.agents.list()) {
        // Headless children are owned by the daemon process and cannot outlive a restart.
        const guiSessionCannotBeRestored = agent.executionMode === 'gui' || agent.executionMode === 'headless'
        const ptyCannotBeRestored = Boolean(agent.ptyId && !this.ptyManager?.isAlive(agent.ptyId))
        if (guiSessionCannotBeRestored || ptyCannotBeRestored) {
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
    } catch (error) {
      // A thread that cannot be read now (moving to the trash, say) is left as it is; it is not listed afterwards.
      console.warn("a thread's work from before the restart could not be settled", { threadId, error: error instanceof Error ? error.message : String(error) })
    }
  }
}
