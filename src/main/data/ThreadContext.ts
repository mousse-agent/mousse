import type { AgentRegistry } from '../../mms/agents/AgentRegistry'
import type { OrchestratorService } from '../../mms/orchestrator/OrchestratorService'
import type { PtyManager } from '../../mms/terminals/PtyManager'
import type { TaskQueue } from '../../mms/tasks/TaskQueue'
import type { WorktreeManager } from '../../mms/worktree/WorktreeManager'
import type { Thread } from '../../shared/types'
import type { ProjectManager } from '../../mms/data/ProjectManager'
import type { ThreadDataStore } from '../../mms/data/ThreadDataStore'
import { resolveActiveProjectPath } from '../../mms/data/resolveActiveProjectPath'
import { applyProjectWorkingDirectory, getAppliedProjectWorkingDirectory } from '../../mms/data/projectWorkingDirectory'
import { isDefaultThreadName } from '../../mms/data/threadTitle'
import { resetSessionCursorAgent } from 'pi-cursor-sdk/src/cursor-session-agent'

export class ThreadContext {
  private activeThreadId: string | null = null
  private titleGeneration = new Set<string>()
  private broadcast: (channel: string, data: unknown) => void

  constructor(
    private threadStore: ThreadDataStore,
    private projectManager: ProjectManager,
    private orchestrator: OrchestratorService,
    private agents: AgentRegistry,
    private tasks: TaskQueue,
    private ptyManager: PtyManager,
    private worktrees: WorktreeManager,
    broadcast: (channel: string, data: unknown) => void
  ) {
    this.broadcast = broadcast
    this.setupAutoSave()
  }

  async initialize(): Promise<Thread> {
    // Prune only empty default-named drafts. Never touch threads with content or real titles.
    for (const thread of this.threadStore.listAllThreads()) {
      if (thread.settledAt) continue
      if (this.threadStore.isThreadStarted(thread.id)) continue
      if (!isDefaultThreadName(thread.name)) continue
      this.threadStore.deleteThread(thread.id)
    }

    const availableThreads = this.threadStore
      .listAllThreads()
      .filter((thread) => !thread.settledAt && this.threadStore.isThreadStarted(thread.id))
    let activeId = this.threadStore.getActiveThreadId()

    if (activeId && (!this.threadStore.getThread(activeId) || this.threadStore.getThread(activeId)?.settledAt)) {
      activeId = null
    }

    if (!activeId) {
      if (availableThreads.length > 0) {
        activeId = availableThreads[0].id
      } else {
        const thread = this.threadStore.createThread('New Chat')
        activeId = thread.id
      }
    }

    await this.switchThread(activeId, { skipSave: true })
    return this.threadStore.getThread(activeId)!
  }

  getActiveThreadId(): string | null {
    return this.activeThreadId
  }

  async switchThread(
    threadId: string,
    options: { skipSave?: boolean } = {}
  ): Promise<void> {
    const thread = this.threadStore.getThread(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    if (thread.settledAt) {
      throw new Error('Unsettle this thread before using it.')
    }
    if (this.orchestrator.isActiveTurnRunning()) {
      throw new Error('Stop the active turn before switching threads.')
    }
    if (this.orchestrator.hasRunningMousseAgentSessions()) {
      throw new Error('Stop active Mousse subagent turns before switching threads.')
    }

    const previousId = this.activeThreadId
    if (!options.skipSave && previousId) {
      this.saveCurrent()
    }

    this.ptyManager.killAll()
    this.ptyManager.clearScrollbacks()

    const data = this.threadStore.loadThreadData(threadId)
    const scrollbacks = this.threadStore.loadTerminalScrollbacks(threadId)

    this.orchestrator.loadMessages(data.messages, data.llmContext)
    this.agents.load(data.agents)
    this.tasks.load(data.tasks)
    this.ptyManager.loadScrollbacks(scrollbacks)

    // Point persistence at the destination thread before reconciliation mutates agent/task state.
    this.activeThreadId = threadId
    this.threadStore.setActiveThreadId(threadId)
    this.syncWorktreeRoot(threadId)

    // Restore durable Mousse subagent tabs without auto-restarting model work.
    const mousseReconciled = this.restoreMousseAgentSessions(data.mousseAgentSessions ?? [])

    // Agent processes can finish while the app is restarting or another thread is active.
    // Re-read their durable progress only after selecting this thread so reconciliation is
    // persisted to the correct thread record.
    this.orchestrator.restoreAgentProgress()

    if (mousseReconciled) {
      // Persist interrupted/failed reconciliation so reload does not re-emit the same transition.
      this.saveCurrent()
    }

    // Drop abandoned empty drafts so they never accumulate in the sidebar list.
    if (previousId && previousId !== threadId) {
      this.discardUnstartedThread(previousId)
    }

    this.broadcast('orchestrator:messages', this.orchestrator.getMessages())
    this.broadcast('agents:updated', this.agents.list())
    this.broadcast('tasks:updated', this.tasks.list())
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
    this.broadcast('thread:selected', { id: threadId })
  }

  createThread(name: string, projectId?: string): Thread {
    const projectPath = projectId
      ? this.projectManager.getProject(projectId)?.path
      : undefined
    // Prefer a single empty draft: reuse the current unstarted thread when the scope matches.
    if (this.activeThreadId) {
      const active = this.threadStore.getThread(this.activeThreadId)
      if (
        active &&
        !active.settledAt &&
        !this.threadStore.isThreadStarted(active.id) &&
        (active.projectId ?? undefined) === (projectId ?? undefined)
      ) {
        this.orchestrator.loadMessages([], undefined)
        this.agents.load([])
        this.tasks.load([])
        this.ptyManager.killAll()
        this.ptyManager.clearScrollbacks()
        this.broadcast('orchestrator:messages', [])
        this.broadcast('agents:updated', [])
        this.broadcast('tasks:updated', [])
        this.broadcast('threads:updated', this.threadStore.listAllThreads())
        this.broadcast('thread:selected', { id: active.id })
        return active
      }
    }

    this.discardUnstartedThreads(projectId, this.activeThreadId)
    const thread = this.threadStore.createThread(name, projectId, projectPath)
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
    return thread
  }

  deleteThread(threadId: string): Promise<void> {
    if (this.activeThreadId === threadId) {
      const remaining = this.threadStore
        .listAllThreads()
        .filter((t) => t.id !== threadId && !t.settledAt && this.threadStore.isThreadStarted(t.id))
      this.threadStore.deleteThread(threadId)

      if (remaining.length > 0) {
        return this.switchThread(remaining[0].id, { skipSave: true })
      }

      const thread = this.threadStore.createThread('New Chat')
      return this.switchThread(thread.id, { skipSave: true })
    }

    this.threadStore.deleteThread(threadId)
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
    return Promise.resolve()
  }

  renameThread(threadId: string, name: string): Thread {
    const thread = this.threadStore.updateThreadMeta(threadId, { name })
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
    return thread
  }

  async regenerateThreadTitle(threadId: string): Promise<Thread> {
    const thread = this.threadStore.getThread(threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const title = await this.orchestrator.generateThreadTitle(
      this.threadStore.loadThreadData(threadId).messages
    )
    if (!title) throw new Error('The title model returned an empty title.')
    const updated = this.threadStore.updateThreadMeta(threadId, { name: title })
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
    return updated
  }

  async setThreadSettled(threadId: string, settled: boolean): Promise<Thread> {
    const existing = this.threadStore.getThread(threadId)
    if (!existing) throw new Error(`Thread not found: ${threadId}`)
    if (Boolean(existing.settledAt) === settled) return existing

    if (settled && this.activeThreadId === threadId) {
      if (this.orchestrator.isActiveTurnRunning()) {
        throw new Error('Stop the active turn before settling this thread.')
      }
      this.saveCurrent()
      // Empty drafts cannot be settled into the archive.
      if (!this.threadStore.isThreadStarted(threadId)) {
        throw new Error('Start a chat before settling this thread.')
      }
      const replacement = this.threadStore
        .listAllThreads()
        .find(
          (thread) =>
            thread.id !== threadId &&
            !thread.settledAt &&
            this.threadStore.isThreadStarted(thread.id)
        )
      const updated = this.threadStore.setThreadSettled(threadId, true)
      if (replacement) {
        await this.switchThread(replacement.id, { skipSave: true })
      } else {
        const created = this.threadStore.createThread('New Chat')
        await this.switchThread(created.id, { skipSave: true })
      }
      return updated
    }

    if (settled && !this.threadStore.isThreadStarted(threadId)) {
      throw new Error('Start a chat before settling this thread.')
    }

    const updated = this.threadStore.setThreadSettled(threadId, settled)
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
    return updated
  }

  saveCurrent(): void {
    if (!this.activeThreadId) return
    const before = this.threadStore.getThread(this.activeThreadId)
    const wasStarted = Boolean(before?.startedAt)
    this.threadStore.saveThreadData(
      this.activeThreadId,
      {
        messages: this.orchestrator.getMessages(),
        agents: this.agents.list(),
        tasks: this.tasks.list(),
        llmContext: this.orchestrator.getNativeContext(),
        mousseAgentSessions: this.orchestrator.exportMousseAgentSessions()
      },
      this.ptyManager.getScrollbacks()
    )
    // First message: surface the thread in the sidebar immediately.
    if (!wasStarted) {
      const after = this.threadStore.getThread(this.activeThreadId)
      if (after?.startedAt) {
        this.broadcast('threads:updated', this.threadStore.listAllThreads())
      }
    }
  }

  private discardUnstartedThread(threadId: string): void {
    const thread = this.threadStore.getThread(threadId)
    if (!thread || thread.settledAt) return
    if (this.threadStore.isThreadStarted(threadId)) return
    if (!isDefaultThreadName(thread.name)) return
    this.threadStore.deleteThread(threadId)
  }

  private discardUnstartedThreads(projectId?: string, keepId?: string | null): void {
    for (const thread of this.threadStore.listAllThreads()) {
      if (keepId && thread.id === keepId) continue
      if (thread.settledAt) continue
      if ((thread.projectId ?? undefined) !== (projectId ?? undefined)) continue
      if (this.threadStore.isThreadStarted(thread.id)) continue
      if (!isDefaultThreadName(thread.name)) continue
      this.threadStore.deleteThread(thread.id)
    }
  }

  /**
   * Hydrate in-app Mousse subagent conversations from durable thread data.
   * Running sessions become explicit interrupted/failed states — never auto-restarted.
   * @returns true when registry/task status was reconciled.
   */
  private restoreMousseAgentSessions(sessions: unknown): boolean {
    const events = this.orchestrator.restoreMousseAgentSessions(sessions)

    for (const event of events) {
      this.broadcast('mousse-agent:messages-sync', {
        agentId: event.agentId,
        messages: this.orchestrator.getMousseAgentMessages(event.agentId)
      })
    }

    // Also re-broadcast messages for idle restored sessions so tabs repopulate.
    for (const agentId of this.orchestrator.listMousseAgentSessionIds()) {
      if (events.some((event) => event.agentId === agentId)) continue
      this.broadcast('mousse-agent:messages-sync', {
        agentId,
        messages: this.orchestrator.getMousseAgentMessages(agentId)
      })
    }

    return events.length > 0
  }

  private syncWorktreeRoot(threadId: string): void {
    const previousRoot = getAppliedProjectWorkingDirectory()
    const projectPath = resolveActiveProjectPath(
      this.projectManager,
      this.threadStore,
      threadId
    )
    const root = applyProjectWorkingDirectory(projectPath)
    this.worktrees.setRepoRoot(root)
    if (previousRoot && previousRoot !== root) {
      void resetSessionCursorAgent()
    }
  }

  private setupAutoSave(): void {
    const persist = (): void => this.saveCurrent()

    this.agents.setPersistCallback(persist)
    this.tasks.setPersistCallback(persist)
    this.orchestrator.setPersistCallback(persist)
    this.orchestrator.setMousseAgentPersistCallback(persist)
    const maybeGenerateTitle = (message: { role: string; content: string; streaming?: boolean }) => {
      if (message.role !== 'assistant' || message.streaming || !message.content.trim()) return
      void this.generateDefaultThreadTitle()
    }
    this.orchestrator.on('message', maybeGenerateTitle)
    this.orchestrator.on('message-updated', maybeGenerateTitle)
  }

  private async generateDefaultThreadTitle(): Promise<void> {
    const threadId = this.activeThreadId
    if (!threadId || this.titleGeneration.has(threadId)) return
    const thread = this.threadStore.getThread(threadId)
    if (!thread || !isDefaultThreadName(thread.name)) return

    this.titleGeneration.add(threadId)
    try {
      const title = await this.orchestrator.generateThreadTitle(this.orchestrator.getMessages())
      const current = this.threadStore.getThread(threadId)
      // Do not overwrite a manual rename while the title request was in flight.
      if (!title || !current || !isDefaultThreadName(current.name)) return
      this.threadStore.updateThreadMeta(threadId, { name: title })
      this.broadcast('threads:updated', this.threadStore.listAllThreads())
    } catch (error) {
      console.warn('[ThreadContext] Could not generate thread title:', error)
    } finally {
      this.titleGeneration.delete(threadId)
    }
  }
}
