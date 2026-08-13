import { homedir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from './config/MousseConfigStore'
import { MmsEventBus } from './events'
import { SettingsStore } from './settings/SettingsStore'
import { ProviderAuthService } from './providers/ProviderAuthService'
import { ProjectManager } from './data/ProjectManager'
import { ThreadDataStore } from './data/ThreadDataStore'
import { OrchestratorService } from './orchestrator/OrchestratorService'
import { ScheduledJobService } from './scheduled/ScheduledJobService'
import { ScheduledJobStore } from './scheduled/ScheduledJobStore'
import { ChannelService } from './channels/ChannelService'
import { ChannelStore } from './channels/ChannelStore'
import { AgentRegistry } from './agents/AgentRegistry'
import { TaskQueue } from './tasks/TaskQueue'
import { WorktreeManager } from './worktree/WorktreeManager'
import { PtyManager } from './terminals/PtyManager'
import { HeadlessAgentRunner } from './terminals/HeadlessAgentRunner'
import { MacroEngine } from './macros/MacroEngine'
import { McpRegistry } from './integrations/mcp/McpRegistry'
import { McpManager } from './integrations/mcp/McpManager'
import type { OpenExternalFn } from './integrations/mcp/McpOAuthProvider'
import { SkillsRegistry } from './integrations/skills/SkillsRegistry'
import { AgentConfigManager } from './integrations/agents/AgentConfigManager'
import { FileService } from './files/FileService'
import { GitService } from './git/GitService'
import { LineEditStatsStore } from './stats/LineEditStatsStore'
import type { TerminalSendSink } from './terminals/PtyManager'
import {
  acquireMmsOwnerLease,
  canonicalizeHome,
  type MmsOwnerHandle,
  type MmsOwnerKind,
  type MmsOwnerRecord
} from './ownership/MmsOwnerLease'
import { ThreadRuntimeManager } from './runtime/ThreadRuntimeManager'
import { userQuestionService } from './orchestrator/UserQuestionService'
import { ClientConnectionServer } from './http/ClientConnectionServer'

export interface MmsOptions {
  homeDir?: string
  repoRoot?: string
  headless?: boolean
  openExternal?: OpenExternalFn
  onTerminalEvent?: TerminalSendSink
  /**
   * Owner surface kind for the exclusive home lease.
   * Production GUI / service / writable CLI must set this (or accept default 'cli').
   */
  ownerKind?: MmsOwnerKind
  /**
   * When false, skip ownership (tests only). Production GUI, service run, and
   * writable CLI must not silently bypass ownership.
   */
  requireOwnership?: boolean
  version?: string
  build?: string
}

export class MousseMainService {
  readonly config: MousseConfigStore
  readonly settings: SettingsStore
  readonly providerAuth: ProviderAuthService
  readonly projects: ProjectManager
  readonly threads: ThreadDataStore
  readonly orchestrator: OrchestratorService
  readonly scheduled: ScheduledJobService
  readonly channels: ChannelService
  readonly agents: AgentRegistry
  readonly tasks: TaskQueue
  readonly events: MmsEventBus

  readonly worktrees: WorktreeManager
  readonly ptyManager: PtyManager
  readonly headlessRunner: HeadlessAgentRunner
  readonly macros: MacroEngine
  readonly mcpRegistry: McpRegistry
  readonly mcpManager: McpManager
  readonly skillsRegistry: SkillsRegistry
  readonly agentConfigManager: AgentConfigManager
  readonly fileService: FileService
  readonly gitService: GitService
  readonly lineEditStats: LineEditStatsStore
  /** Phase 4 multi-tenant thread runtimes (agents/tasks/PTY ownership). */
  readonly threadRuntimes: ThreadRuntimeManager
  /** Daemon-owned pending questions (shared singleton wired into LLM tools). */
  readonly questions = userQuestionService

  private readonly channelStore: ChannelStore
  private readonly scheduledStore: ScheduledJobStore
  private started = false
  private stopped = false
  private ownerHandle: MmsOwnerHandle | null = null
  private readonly homeDir: string
  private clientConnectionServer: ClientConnectionServer | null = null

  private constructor(
    config: MousseConfigStore,
    opts: MmsOptions | undefined,
    ownerHandle: MmsOwnerHandle | null,
    homeDir: string
  ) {
    this.config = config
    this.ownerHandle = ownerHandle
    this.homeDir = homeDir
    this.events = new MmsEventBus()
    this.settings = new SettingsStore(config)
    this.providerAuth = new ProviderAuthService()
    this.mcpRegistry = new McpRegistry()
    this.skillsRegistry = new SkillsRegistry()
    this.mcpManager = new McpManager(
      this.mcpRegistry,
      this.settings,
      opts?.openExternal
    )
    this.agentConfigManager = new AgentConfigManager(
      this.mcpRegistry,
      this.skillsRegistry,
      this.settings
    )
    this.fileService = new FileService()
    this.gitService = new GitService()
    this.lineEditStats = new LineEditStatsStore()

    const repoRoot = opts?.repoRoot ?? process.env.MOUSSE_REPO_ROOT ?? process.cwd()
    this.worktrees = new WorktreeManager(repoRoot)
    this.agents = new AgentRegistry()
    this.tasks = new TaskQueue()
    this.ptyManager = new PtyManager()
    this.headlessRunner = new HeadlessAgentRunner()

    const terminalSink: TerminalSendSink =
      opts?.onTerminalEvent ??
      ((channel, data) => {
        this.events.broadcast(channel, data)
      })
    this.ptyManager.setSendSink(terminalSink)
    this.headlessRunner.setSendSink(terminalSink)

    const macrosDir = WorktreeManager.resolveMacrosPath()
    this.macros = new MacroEngine(macrosDir, this.settings)

    this.projects = new ProjectManager()
    this.threads = new ThreadDataStore(this.projects)
    this.threads.setTransactionalStoreEnabled(this.config.get().features.transactionalThreadStore)
    this.projects.setThreadStore(this.threads)

    this.orchestrator = new OrchestratorService(
      this.agents,
      this.tasks,
      this.worktrees,
      this.ptyManager,
      this.headlessRunner,
      this.macros,
      this.settings,
      this.providerAuth,
      this.mcpManager,
      this.skillsRegistry,
      this.agentConfigManager,
      this.fileService,
      this.gitService,
      this.lineEditStats,
      this.projects
    )
    // MMS owns the canonical per-thread transcript and durable message queue for
    // every surface (GUI client, CLI client, channels). Electron never owns MMS.
    this.orchestrator.setThreadStore(this.threads)
    this.orchestrator.setFeatureFlags(this.config.get().features)
    this.threadRuntimes = new ThreadRuntimeManager()
    this.threadRuntimes.attach({
      threadStore: this.threads,
      orchestrator: this.orchestrator,
      ptyManager: this.ptyManager,
      questions: this.questions
    })
    // Minimum MMS-owned persistence so headless turns survive without the GUI.
    // Load-merges agents/tasks/mousse sessions; never writes messageQueue (queue API only).
    this.orchestrator.setPersistCallback((threadId) => {
      this.persistOrchestratorThread(threadId)
    })
    // PTY membership + capability events (no BrowserWindow).
    this.ptyManager.on('created', (p: { ptyId: string; threadId: string }) => {
      if (p.threadId && p.threadId !== '__unbound__') {
        this.threadRuntimes.registerPty(p.threadId, p.ptyId)
      }
    })
    this.ptyManager.on('exit', (p: { ptyId: string; threadId: string }) => {
      if (p.threadId && p.threadId !== '__unbound__') {
        this.threadRuntimes.unregisterPty(p.threadId, p.ptyId)
      }
    })

    this.channelStore = new ChannelStore(config)
    this.scheduledStore = new ScheduledJobStore(config)
    this.scheduled = new ScheduledJobService(
      {
        runIsolated: (prompt) => this.orchestrator.runIsolatedScheduledJob(prompt)
      },
      this.scheduledStore,
      this.threads,
      this.projects
    )
    this.channels = new ChannelService(
      this.orchestrator,
      this.threads,
      this.channelStore,
      this.settings,
      this.providerAuth,
      this.agents
    )

    this.wireServiceEvents()
    void opts?.headless
  }

  /**
   * Create a writable MMS instance. Acquires the exclusive home owner lease
   * before config load / watchers / channels / scheduler when requireOwnership is true (default).
   */
  static async create(opts?: MmsOptions): Promise<MousseMainService> {
    const homeDir = canonicalizeHome(
      opts?.homeDir ?? process.env.MOUSSE_HOME ?? defaultMousseHome()
    )
    process.env.MOUSSE_HOME = homeDir

    const requireOwnership = opts?.requireOwnership !== false
    const ownerKind: MmsOwnerKind = opts?.ownerKind ?? (opts?.headless ? 'cli' : 'gui')

    let ownerHandle: MmsOwnerHandle | null = null
    if (requireOwnership) {
      // Acquire BEFORE config watchers / service construction.
      ownerHandle = acquireMmsOwnerLease(homeDir, {
        kind: ownerKind,
        version: opts?.version ?? process.env.npm_package_version,
        build: opts?.build
      })
    }

    try {
      const config = MousseConfigStore.load(homeDir)
      const service = new MousseMainService(config, opts, ownerHandle, homeDir)
      await service.init()
      return service
    } catch (err) {
      ownerHandle?.release()
      throw err
    }
  }

  getOwnerLease(): MmsOwnerHandle | null {
    return this.ownerHandle
  }

  getOwnerRecord(): MmsOwnerRecord | null {
    return this.ownerHandle?.owner ?? null
  }

  getHomeDir(): string {
    return this.homeDir
  }

  private async init(): Promise<void> {
    await this.providerAuth.init()
    await this.worktrees.init()
    this.config.startWatching(() => {
      /* external edits reload sections; stores read on demand */
    })
  }

  private wireServiceEvents(): void {
    this.scheduled.on('updated', (jobs) => {
      this.events.emit({ channel: 'scheduled:updated', data: jobs })
    })
    this.scheduled.on('status', (status) => {
      this.events.emit({ channel: 'scheduled:status', data: status })
    })
    this.channels.on('updated', (snapshot) => {
      this.events.emit({ channel: 'channels:updated', data: snapshot })
    })
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    if (this.config.getScheduledSection().enabled) {
      this.scheduled.start()
    }
    await this.channels.startEnabled()

    // Restore multi-tenant runtimes; mark non-reattachable PTY/agents interrupted.
    this.threadRuntimes.restoreOnStartup()
    // Questions are memory-only — new process has none; document interrupted semantics.
    this.questions.markInterruptedByDaemonRestart()

    // Headless-safe: reclaim abandoned claims and drain pending normal work without the GUI.
    // Non-blocking; live peer ownership is never stolen.
    this.orchestrator.scheduleStartupQueueRecovery()

    const http = this.config.getMmsSection().http
    if (http?.enabled) {
      this.clientConnectionServer = new ClientConnectionServer(this, {
        ...http,
        version: this.ownerHandle?.owner.version ?? process.env.MOUSSE_VERSION ?? process.env.npm_package_version
      })
      await this.clientConnectionServer.start()
    }

    this.events.emit({ channel: 'projects:updated', data: this.projects.listProjects() })
    this.events.emit({ channel: 'threads:updated', data: this.threads.listAllThreads() })
    this.events.emit({ channel: 'scheduled:updated', data: this.scheduled.listJobs() })
    this.events.emit({ channel: 'scheduled:status', data: this.scheduled.getStatus() })
    this.events.emit({ channel: 'channels:updated', data: this.channels.getSnapshot() })
  }

  /**
   * Persist orchestrator messages + native context for a thread.
   * Merges existing agents, tasks, and Mousse-agent sessions from disk.
   * Never passes messageQueue — queue persistence is exclusively via saveMessageQueue.
   *
   * Missing/deleted threads are a safe no-op. Real I/O/persistence failures propagate
   * so queue acceptance cannot complete a claim after a silent write failure.
   */
  private persistOrchestratorThread(threadId?: string | null): void {
    const id = threadId ?? this.orchestrator.getBoundThreadId()
    if (!id) return
    if (!this.threads.getThread(id)) return

    // Atomic RMW: merge live messages/llm with latest agents/tasks under one lock.
    this.threads.mutateThreadData(id, (current) => {
      let agents = current.agents
      let tasks = current.tasks
      try {
        const rt = this.threadRuntimes.getOrHydrate(id)
        agents = rt.agents.list()
        tasks = rt.tasks.list()
      } catch {
        /* keep current */
      }
      return {
        messages: this.orchestrator.getMessagesForPersistence(id),
        agents,
        tasks,
        llmContext: this.orchestrator.getNativeContext(id),
        mousseAgentSessions:
          this.orchestrator.exportMousseAgentSessions?.() ?? current.mousseAgentSessions
      }
    })
  }

  /** Idempotent stop: services then exact-token owner release exactly once. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    try {
      this.scheduled.stop()
      await this.clientConnectionServer?.stop()
      this.clientConnectionServer = null
      await this.channels.stopAll()
      await this.mcpManager.shutdown()
      this.config.stopWatching()
    } finally {
      this.started = false
      if (this.ownerHandle) {
        this.ownerHandle.release()
        this.ownerHandle = null
      }
    }
  }
}

function defaultMousseHome(): string {
  return join(homedir(), '.mousse')
}
