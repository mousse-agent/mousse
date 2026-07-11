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

export interface MmsOptions {
  homeDir?: string
  repoRoot?: string
  headless?: boolean
  openExternal?: OpenExternalFn
  onTerminalEvent?: TerminalSendSink
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

  private readonly channelStore: ChannelStore
  private readonly scheduledStore: ScheduledJobStore
  private started = false

  private constructor(
    config: MousseConfigStore,
    opts?: MmsOptions
  ) {
    this.config = config
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
    this.channels = new ChannelService(this.orchestrator, this.threads, this.channelStore)

    this.wireServiceEvents()
    void opts?.headless
  }

  static async create(opts?: MmsOptions): Promise<MousseMainService> {
    if (opts?.homeDir) {
      process.env.MOUSSE_HOME = opts.homeDir
    } else if (!process.env.MOUSSE_HOME) {
      process.env.MOUSSE_HOME = defaultMousseHome()
    }

    const config = MousseConfigStore.load(opts?.homeDir)
    const service = new MousseMainService(config, opts)
    await service.init()
    return service
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

    this.events.emit({ channel: 'projects:updated', data: this.projects.listProjects() })
    this.events.emit({ channel: 'threads:updated', data: this.threads.listAllThreads() })
    this.events.emit({ channel: 'scheduled:updated', data: this.scheduled.listJobs() })
    this.events.emit({ channel: 'scheduled:status', data: this.scheduled.getStatus() })
    this.events.emit({ channel: 'channels:updated', data: this.channels.getSnapshot() })
  }

  async stop(): Promise<void> {
    this.scheduled.stop()
    await this.channels.stopAll()
    await this.mcpManager.shutdown()
    this.config.stopWatching()
    this.started = false
  }
}

function defaultMousseHome(): string {
  return join(homedir(), '.mousse')
}
