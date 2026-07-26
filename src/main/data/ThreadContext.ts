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
import { isDefaultThreadName, summarizeThreadTitle } from '../../mms/data/threadTitle'
import { resetSessionCursorAgent } from 'pi-cursor-sdk/src/cursor-session-agent'

export class ThreadContext {
  private activeThreadId: string | null = null
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
    const allThreads = this.threadStore.listAllThreads()
    let activeId = this.threadStore.getActiveThreadId()

    if (activeId && !this.threadStore.getThread(activeId)) {
      activeId = null
    }

    if (!activeId) {
      if (allThreads.length > 0) {
        activeId = allThreads[0].id
      } else {
        const thread = this.threadStore.createThread('New Thread')
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
    if (this.orchestrator.isActiveTurnRunning()) {
      throw new Error('Stop the active turn before switching threads.')
    }
    if (this.orchestrator.hasRunningMousseAgentSessions()) {
      throw new Error('Stop active Mousse subagent turns before switching threads.')
    }
    if (!options.skipSave && this.activeThreadId) {
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
    const thread = this.threadStore.createThread(name, projectId, projectPath)
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
    return thread
  }

  deleteThread(threadId: string): Promise<void> {
    if (this.activeThreadId === threadId) {
      const remaining = this.threadStore
        .listAllThreads()
        .filter((t) => t.id !== threadId)
      this.threadStore.deleteThread(threadId)

      if (remaining.length > 0) {
        return this.switchThread(remaining[0].id, { skipSave: true })
      }

      const thread = this.threadStore.createThread('New Thread')
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

  saveCurrent(): void {
    if (!this.activeThreadId) return
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
    this.orchestrator.on('message', (message) => {
      if (message.role === 'user') {
        this.renameDefaultThreadFromMessage(message.content)
      }
    })
  }

  private renameDefaultThreadFromMessage(content: string): void {
    if (!this.activeThreadId) return

    const thread = this.threadStore.getThread(this.activeThreadId)
    if (!thread || !isDefaultThreadName(thread.name)) return

    const title = summarizeThreadTitle(content)
    if (!title) return

    this.threadStore.updateThreadMeta(thread.id, { name: title })
    this.broadcast('threads:updated', this.threadStore.listAllThreads())
  }
}
