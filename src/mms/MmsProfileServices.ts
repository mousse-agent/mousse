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
import { SkillsRegistry } from './integrations/skills/SkillsRegistry'
import { AgentConfigManager } from './integrations/agents/AgentConfigManager'
import { FileService } from './files/FileService'
import { GitService } from './git/GitService'
import { LineEditStatsStore } from './stats/LineEditStatsStore'
import type { TerminalSendSink } from './terminals/PtyManager'
import {
  type MmsOwnerHandle,
  type MmsOwnerRecord
} from './ownership/MmsOwnerLease'
import { ThreadRuntimeManager } from './runtime/ThreadRuntimeManager'
import { UserQuestionService } from './orchestrator/UserQuestionService'
import { ModeRegistry } from './modes/ModeRegistry'
import { createProfileSecretAdapter } from './profiles/secrets'
import type { ProfileHost } from './profiles/ProfileHost'
import {
  createLegacySingleProfileContext,
  type IntegrationRuntimeContext
} from './integrations/profileContext'
import { MmsControlService } from './control/MmsControlService'
import { dispatchMethod } from './protocol/handlers'
import { randomUUID } from 'crypto'
import { DomainHandlerRegistry, DomainRpcError } from './protocol/domainRegistry'
import type { MmsOptions } from './MmsOptions'
import { MmsProfilePlatform } from './platform/MmsProfilePlatform'
import { OwnedWorkBarrier } from './execution/OwnedWorkBarrier'

function containsProfileBusy(error: unknown): boolean {
  if (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'profile_busy' || error.code === 'shutdown_timeout')
  ) return true
  return error instanceof AggregateError && error.errors.some(containsProfileBusy)
}

export class MmsProfileServices {
  readonly domains: DomainHandlerRegistry
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
  readonly control: MmsControlService

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
  /** Daemon-owned pending questions, one instance per profile. */
  readonly questions: UserQuestionService
  readonly modeRegistry: ModeRegistry
  readonly profileId: string
  readonly integrationContext: IntegrationRuntimeContext
  readonly platform: MmsProfilePlatform

  private readonly channelStore: ChannelStore
  private readonly scheduledStore: ScheduledJobStore
  private started = false
  private stopped = false
  private readonly requests = new OwnedWorkBarrier()
  private stopOperation?: Promise<void>
  private readonly ownerHandle: MmsOwnerHandle | null
  private readonly homeDir: string
  private readonly installationHome: string

  constructor(
    config: MousseConfigStore,
    opts: MmsOptions | undefined,
    ownerHandle: MmsOwnerHandle | null,
    homeDir: string,
    shared: {
      providerAuth: ProviderAuthService
      domains: DomainHandlerRegistry
      installationHome: string
      personal?: boolean
      profileId?: string
      allowLegacyProjectData?: boolean
      inheritChannelEnvironment?: boolean
      includeExternalCliConfigs?: boolean
    }
  ) {
    this.config = config
    this.ownerHandle = ownerHandle
    this.homeDir = homeDir
    this.installationHome = shared.installationHome
    this.domains = shared.domains
    this.profileId = shared.profileId ?? 'default'
    this.questions = new UserQuestionService()
    this.modeRegistry = new ModeRegistry({
      profileRoot: homeDir,
      includeExternalCliConfigs: shared.includeExternalCliConfigs ?? !shared.personal
    })
    this.events = new MmsEventBus()
    this.settings = new SettingsStore(config)
    this.providerAuth = shared.providerAuth
    this.integrationContext = shared.personal
      ? {
          profileId: this.profileId,
          profileRoot: homeDir,
          secrets: createProfileSecretAdapter({
            profileRoot: homeDir,
            inheritProcessEnv: shared.inheritChannelEnvironment === true
          })
        }
      : createLegacySingleProfileContext({ profileId: this.profileId, profileRoot: homeDir })
    this.mcpRegistry = new McpRegistry(this.integrationContext)
    this.skillsRegistry = new SkillsRegistry(this.integrationContext)
    this.mcpManager = new McpManager(
      this.mcpRegistry,
      this.settings,
      opts?.openExternal,
      { context: this.integrationContext }
    )
    this.agentConfigManager = new AgentConfigManager(
      this.mcpRegistry,
      this.skillsRegistry,
      this.settings,
      { generatedConfigRoot: join(homeDir, 'agent-configs') }
    )
    this.fileService = new FileService()
    this.gitService = new GitService()
    this.lineEditStats = new LineEditStatsStore(homeDir)

    const repoRoot = opts?.repoRoot ?? process.env.MOUSSE_REPO_ROOT ?? process.cwd()
    this.worktrees = new WorktreeManager(repoRoot, shared.installationHome)
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

    this.projects = new ProjectManager(homeDir)
    this.threads = new ThreadDataStore(this.projects, homeDir, {
      allowLegacyProjectData: shared.allowLegacyProjectData ?? !shared.personal
    })
    this.threads.setTransactionalStoreEnabled(this.config.get().features.transactionalThreadStore)
    this.projects.setThreadStore(this.threads)
    this.platform = new MmsProfilePlatform(this)

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
      this.projects,
      { questions: this.questions, modeRegistry: this.modeRegistry }
    )
    // MMS owns the canonical per-thread transcript and durable message queue for
    // every surface (GUI client, CLI client, channels). Electron never owns MMS.
    this.orchestrator.setThreadStore(this.threads)
    this.orchestrator.setWorkflowChatExecutor(this.platform.workflowChat)
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

    this.channelStore = new ChannelStore(config, {
      inheritEnvironment: shared.inheritChannelEnvironment ?? !shared.personal
    })
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

    this.control = new MmsControlService({
      homeDir: this.homeDir,
      instanceId: this.ownerHandle?.owner.processInstanceId || randomUUID(),
      eventBus: this.events,
      openExternal: opts?.openExternal
    })
    this.control.setExecutor({
      execute: (method, params) => {
        return dispatchMethod(
          {
            mms: this,
            ownerToken: this.ownerHandle?.owner.token,
            globalSequence: () => 0
          },
          method,
          params
        )
      }
    })

    this.wireServiceEvents()
    void opts?.headless
  }

  getOwnerLease(): MmsOwnerHandle | null {
    return this.ownerHandle
  }

  getOwnerRecord(): MmsOwnerRecord | null {
    return this.ownerHandle?.owner ?? null
  }

  getHomeDir(): string {
    return this.installationHome
  }

  getProfileHomeDir(): string { return this.homeDir }

  getProfileId(): string { return this.profileId }

  async runOwnedRequest<T>(method: string, work: () => T | Promise<T>): Promise<T> {
    try { return await this.requests.run(`rpc:${method}`, work) }
    catch (error) {
      if (error instanceof Error && 'code' in error && (error.code === 'profile_draining' || error.code === 'profile_busy')) {
        throw new DomainRpcError(error.code, error.message, 'details' in error ? error.details : undefined)
      }
      throw error
    }
  }

  getOwnedActivity(): Record<string, number> {
    return {
      ...this.requests.snapshot(),
      ...this.orchestrator.getOwnedActivity(),
      scheduledTicks: this.scheduled.getActiveCount(),
      ptyProcesses: this.ptyManager.getActiveCount(),
      headlessProcesses: this.headlessRunner.getActiveCount(),
      agentRuns: this.platform.getActiveCount(),
      mcpWork: this.mcpManager.getActiveCount(),
      channelWork: this.channels.getActiveCount(),
      controlWork: this.control.getActiveCount()
    }
  }

  /** Close admission synchronously, before any teardown await can admit another request. */
  beginShutdown(): void {
    this.requests.beginShutdown()
    this.mcpManager.beginShutdown()
    this.channels.beginShutdown()
    this.control.beginShutdown()
    this.platform.beginShutdown()
    this.orchestrator.beginShutdown()
    this.scheduled.beginShutdown()
    this.ptyManager.beginShutdown()
    this.headlessRunner.beginShutdown()
  }

  /** Installation host; only MousseMainService returns a live host. */
  getInstallationHost(): ProfileHost | null {
    return null
  }

  async initialize(): Promise<void> {
    // A packaged GUI can start before the user opens a Git project. Keep the
    // worktree manager lazy in that state; project-bound operations still call
    // RepositoryContext.open() and fail clearly if their project is invalid.
    if (await this.gitService.isRepo(this.worktrees.getRepoRoot())) {
      await this.worktrees.init()
    }
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
    this.control.on('control:status_changed', (status) => {
      this.events.emit({ channel: 'control:status-changed', data: status })
    })
    this.control.on('control:pairing_request', (req) => {
      this.events.emit({ channel: 'control:pairing-request', data: req })
    })
  }

  start(): Promise<void> {
    return this.requests.run('profile-start', () => this.startOwned())
  }

  private async startOwned(): Promise<void> {
    this.requests.assertAccepting()
    if (this.started) return
    this.started = true

    if (this.config.getScheduledSection().enabled) {
      this.scheduled.start()
    }
    await this.channels.startEnabled()
    await this.control.start()

    // Restore multi-tenant runtimes; mark non-reattachable PTY/agents interrupted.
    this.threadRuntimes.restoreOnStartup()
    // Questions are memory-only — new process has none; document interrupted semantics.
    this.questions.markInterruptedByDaemonRestart()
    await this.platform.workflowRuns.startRecovery()

    // Headless-safe: reclaim abandoned claims and drain pending normal work without the GUI.
    // Non-blocking; live peer ownership is never stolen.
    this.orchestrator.scheduleStartupQueueRecovery()

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

  /** Stop personal services only. Installation retains shared providers and owner lease. */
  stop({ timeoutMs = 30_000 }: { timeoutMs?: number } = {}): Promise<void> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.reject(new Error('Invalid shutdown timeout'))
    this.beginShutdown()
    if (this.stopped) return Promise.resolve()
    if (!this.stopOperation) {
      const operation = this.finishStop()
      this.stopOperation = operation
      void operation.catch(() => { if (this.stopOperation === operation) this.stopOperation = undefined })
    }
    // Deadline only limits this caller's wait. The underlying operation retains
    // ownership and is reused by later attempts until it has actually settled.
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new DomainRpcError('profile_busy', 'Profile work is still draining', {
        profileId: this.profileId, activity: this.getOwnedActivity()
      })), timeoutMs)
      this.stopOperation!.then(() => { clearTimeout(timer); resolve() }, (error) => {
        clearTimeout(timer)
        reject(containsProfileBusy(error)
          ? new DomainRpcError('profile_busy', 'Profile work is still draining', {
              profileId: this.profileId, activity: this.getOwnedActivity()
            })
          : error)
      })
    })
  }

  private async finishStop(): Promise<void> {
    // Invoke each cleanup in its own promise. Calling the methods while
    // constructing the array would let one synchronous throw prevent every
    // later owner from even receiving shutdown.
    const cleanups = [
      () => this.platform.dispose(), () => this.scheduled.shutdown(), () => this.channels.shutdown(),
      () => this.orchestrator.shutdown(), () => this.control.shutdown(), () => this.requests.waitForIdle(),
      () => this.ptyManager.shutdown(), () => this.headlessRunner.shutdown(), () => this.mcpManager.shutdown()
    ]
    const results = await Promise.allSettled(cleanups.map((cleanup) => Promise.resolve().then(cleanup)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map((result) => result.reason)
    if (errors.length) throw new AggregateError(errors, 'Failed to drain profile services')
    // Some control shutdown paths exclude their caller to avoid recursive waits.
    // They must not allow an installation lifecycle request to release its own
    // profile while the excluded raw callback can still write or send.
    const activity = this.getOwnedActivity()
    if (Object.values(activity).some((count) => count > 0)) {
      throw new DomainRpcError('profile_busy', 'Profile work is still draining', { profileId: this.profileId, activity })
    }
    this.config.stopWatching()
    this.started = false
    this.stopped = true
  }
}
