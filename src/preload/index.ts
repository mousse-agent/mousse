import { contextBridge, ipcRenderer } from 'electron'
import type {
  Agent,
  BrowserBounds,
  BrowserState,
  ChatImageAttachment,
  ChatMessage,
  OrchestratorContextUsageInput,
  OrchestratorSendInput,
  ContextUsageSnapshot,
  DocumentOpenPayload,
  FileAsset,
  FileEntry,
  FileStat,
  GitBranchInfo,
  GitCommit,
  GitDiffStats,
  GitStatusSnapshot,
  MainView,
  OrchestratorResponse,
  Project,
  PtyCreateRequest,
  PtyCreateResult,
  QueuedMessage,
  CreateScheduledJobInput,
  ScheduledJob,
  SchedulerStatus,
  ChannelActivityEvent,
  ChannelConfig,
  ChannelPlatform,
  ChannelsSnapshot,
  PairingRequest,
  ThreadSearchResult,
  PendingUserQuestions,
  Task,
  TaskStatus,
  Thread,
  ThreadActivitySnapshot,
  TurnState,
  TurnStateSnapshot,
  UserQuestionAnswers
} from '../shared/types'
import type { MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../shared/settings'
import type { LineEditStatsSnapshot } from '../shared/lineEditStats'
import type {
  McpConfigSourceDescriptor,
  McpServerConfig,
  McpToolDescriptor,
  SkillReadResult,
  SkillsRegistrySnapshot
} from '../shared/integrations'
import type {
  AmbientProviderInfo,
  ConfiguredProvider,
  ProviderLoginEvent,
  ProviderLoginOption,
  ProviderLoginResponse,
  ProviderLoginResult
} from '../shared/providerAuth'

export interface AppInfo {
  platform: string
  repoRoot: string
  macroProviders: string[]
  llmProvider: string
}

const api = {
  platform: process.platform,
  orchestrator: {
    /** Compatibility: send to the active thread (stacks on the queue when busy). */
    send: (request: OrchestratorSendInput): Promise<OrchestratorResponse> =>
      ipcRenderer.invoke('orchestrator:send', request),
    /** Thread-id-aware send for concurrent multi-thread clients. */
    sendToThread: (
      threadId: string,
      request: OrchestratorSendInput
    ): Promise<OrchestratorResponse> =>
      ipcRenderer.invoke('orchestrator:sendToThread', threadId, request),
    getMessages: (threadId?: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('orchestrator:getMessages', threadId),
    getContextUsage: (request?: OrchestratorContextUsageInput): Promise<ContextUsageSnapshot> =>
      ipcRenderer.invoke('orchestrator:getContextUsage', request),
    onMessage: (cb: (msg: ChatMessage) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, msg: ChatMessage) => cb(msg)
      ipcRenderer.on('orchestrator:message', handler)
      return () => ipcRenderer.removeListener('orchestrator:message', handler)
    },
    onResponse: (cb: (resp: OrchestratorResponse) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, resp: OrchestratorResponse) => cb(resp)
      ipcRenderer.on('orchestrator:response', handler)
      return () => ipcRenderer.removeListener('orchestrator:response', handler)
    },
    onMessages: (cb: (messages: ChatMessage[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, messages: ChatMessage[]) => cb(messages)
      ipcRenderer.on('orchestrator:messages', handler)
      return () => ipcRenderer.removeListener('orchestrator:messages', handler)
    },
    onThreadMessages: (
      cb: (payload: { threadId: string; messages: ChatMessage[] }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { threadId: string; messages: ChatMessage[] }
      ) => cb(payload)
      ipcRenderer.on('orchestrator:thread-messages', handler)
      return () => ipcRenderer.removeListener('orchestrator:thread-messages', handler)
    },
    onThreadMessage: (
      cb: (payload: { threadId: string; message: ChatMessage }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { threadId: string; message: ChatMessage }
      ) => cb(payload)
      ipcRenderer.on('orchestrator:thread-message', handler)
      return () => ipcRenderer.removeListener('orchestrator:thread-message', handler)
    },
    onThreadMessageUpdated: (
      cb: (payload: { threadId: string; message: ChatMessage }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { threadId: string; message: ChatMessage }
      ) => cb(payload)
      ipcRenderer.on('orchestrator:thread-message-updated', handler)
      return () => ipcRenderer.removeListener('orchestrator:thread-message-updated', handler)
    },
    onMessageUpdated: (cb: (msg: ChatMessage) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, msg: ChatMessage) => cb(msg)
      ipcRenderer.on('orchestrator:message-updated', handler)
      return () => ipcRenderer.removeListener('orchestrator:message-updated', handler)
    },
    onQuestionsPending: (cb: (payload: PendingUserQuestions) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: PendingUserQuestions) => cb(payload)
      ipcRenderer.on('orchestrator:questionsPending', handler)
      return () => ipcRenderer.removeListener('orchestrator:questionsPending', handler)
    },
    answerQuestions: (requestId: string, answers: UserQuestionAnswers): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:answerQuestions', requestId, answers),
    dismissQuestions: (requestId: string): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:dismissQuestions', requestId),
    abort: (threadId?: string): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:abort', threadId),
    steer: (text: string, threadId?: string): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:steer', text, threadId),
    isTurnActive: (threadId?: string): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:isTurnActive', threadId),
    onTurnState: (cb: (state: TurnState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: TurnState) => cb(data)
      ipcRenderer.on('orchestrator:turn-state', handler)
      return () => ipcRenderer.removeListener('orchestrator:turn-state', handler)
    },
    onTurnSnapshot: (cb: (snapshot: TurnStateSnapshot) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: TurnStateSnapshot) => cb(data)
      ipcRenderer.on('turns:state', handler)
      return () => ipcRenderer.removeListener('turns:state', handler)
    },
    getTurnSnapshot: (): Promise<TurnStateSnapshot> => ipcRenderer.invoke('turn:getSnapshot'),
    retryConnection: (threadId?: string): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:retryConnection', threadId),
    onConnectionFailed: (cb: () => void): (() => void) => {
      const handler = () => cb()
      ipcRenderer.on('orchestrator:connection-failed', handler)
      return () => ipcRenderer.removeListener('orchestrator:connection-failed', handler)
    }
  },
  turn: {
    onTurnState: (cb: (state: TurnState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: TurnState) => cb(data)
      ipcRenderer.on('orchestrator:turn-state', handler)
      return () => ipcRenderer.removeListener('orchestrator:turn-state', handler)
    },
    onTurnSnapshot: (cb: (snapshot: TurnStateSnapshot) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: TurnStateSnapshot) => cb(data)
      ipcRenderer.on('turns:state', handler)
      return () => ipcRenderer.removeListener('turns:state', handler)
    },
    getSnapshot: (): Promise<TurnStateSnapshot> => ipcRenderer.invoke('turn:getSnapshot')
  },
  queue: {
    list: (threadId: string): Promise<QueuedMessage[]> =>
      ipcRenderer.invoke('queue:list', threadId),
    enqueue: (threadId: string, request: OrchestratorSendInput): Promise<QueuedMessage> =>
      ipcRenderer.invoke('queue:enqueue', threadId, request),
    remove: (threadId: string, itemId: string): Promise<QueuedMessage | null> =>
      ipcRenderer.invoke('queue:remove', threadId, itemId),
    reorder: (threadId: string, orderedIds: string[]): Promise<QueuedMessage[]> =>
      ipcRenderer.invoke('queue:reorder', threadId, orderedIds),
    promoteToSteer: (threadId: string, itemId: string): Promise<boolean> =>
      ipcRenderer.invoke('queue:promoteToSteer', threadId, itemId),
    onUpdated: (
      cb: (payload: { threadId: string; items: QueuedMessage[] }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { threadId: string; items: QueuedMessage[] }
      ) => cb(payload)
      ipcRenderer.on('queue:updated', handler)
      return () => ipcRenderer.removeListener('queue:updated', handler)
    }
  },
  documents: {
    onOpened: (cb: (payload: DocumentOpenPayload) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: DocumentOpenPayload) => cb(payload)
      ipcRenderer.on('document:opened', handler)
      return () => ipcRenderer.removeListener('document:opened', handler)
    }
  },
  agents: {
    list: (): Promise<Agent[]> => ipcRenderer.invoke('agents:list'),
    stop: (agentId: string): Promise<string[]> => ipcRenderer.invoke('agents:stop', agentId),
    onUpdated: (cb: (agents: Agent[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, agents: Agent[]) => cb(agents)
      ipcRenderer.on('agents:updated', handler)
      return () => ipcRenderer.removeListener('agents:updated', handler)
    },
    onSpawned: (cb: (agent: Agent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, agent: Agent) => cb(agent)
      ipcRenderer.on('agent:spawned', handler)
      return () => ipcRenderer.removeListener('agent:spawned', handler)
    },
    onActivated: (cb: (payload: { agentId: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { agentId: string }) => cb(payload)
      ipcRenderer.on('agent:activated', handler)
      return () => ipcRenderer.removeListener('agent:activated', handler)
    }
  },
  mousseAgent: {
    getMessages: (agentId: string): Promise<ChatMessage[]> =>
      ipcRenderer.invoke('mousseAgent:getMessages', agentId),
    getAssignment: (agentId: string) => ipcRenderer.invoke('mousseAgent:getAssignment', agentId),
    send: (
      agentId: string,
      content: string,
      images?: ChatImageAttachment[]
    ): Promise<{ accepted: boolean; reason?: string }> =>
      ipcRenderer.invoke('mousseAgent:send', agentId, content, images),
    abort: (agentId: string): Promise<boolean> => ipcRenderer.invoke('mousseAgent:abort', agentId),
    onMessage: (
      cb: (payload: { agentId: string; message: ChatMessage }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { agentId: string; message: ChatMessage }
      ) => cb(payload)
      ipcRenderer.on('mousse-agent:message', handler)
      return () => ipcRenderer.removeListener('mousse-agent:message', handler)
    },
    onMessageUpdated: (
      cb: (payload: { agentId: string; message: ChatMessage }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { agentId: string; message: ChatMessage }
      ) => cb(payload)
      ipcRenderer.on('mousse-agent:message-updated', handler)
      return () => ipcRenderer.removeListener('mousse-agent:message-updated', handler)
    },
    onMessagesSync: (
      cb: (payload: { agentId: string; messages: ChatMessage[] }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { agentId: string; messages: ChatMessage[] }
      ) => cb(payload)
      ipcRenderer.on('mousse-agent:messages-sync', handler)
      return () => ipcRenderer.removeListener('mousse-agent:messages-sync', handler)
    },
    onConnectionFailed: (cb: (payload: { agentId: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { agentId: string }) => cb(payload)
      ipcRenderer.on('mousse-agent:connection-failed', handler)
      return () => ipcRenderer.removeListener('mousse-agent:connection-failed', handler)
    },
    retryConnection: (agentId: string): Promise<void> =>
      ipcRenderer.invoke('mousseAgent:retryConnection', agentId),
    onComplete: (
      cb: (payload: { agentId: string; summary: string }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { agentId: string; summary: string }
      ) => cb(payload)
      ipcRenderer.on('mousse-agent:complete', handler)
      return () => ipcRenderer.removeListener('mousse-agent:complete', handler)
    }
  },
  tasks: {
    list: (): Promise<Task[]> => ipcRenderer.invoke('tasks:list'),
    create: (input: {
      description: string
      agentId?: string
      status?: TaskStatus
    }): Promise<Task> => ipcRenderer.invoke('tasks:create', input),
    update: (input: {
      id: string
      description?: string
      status?: TaskStatus
      progress?: number
      message?: string
      summary?: string
      agentId?: string | null
    }): Promise<Task> => ipcRenderer.invoke('tasks:update', input),
    onUpdated: (cb: (tasks: Task[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, tasks: Task[]) => cb(tasks)
      ipcRenderer.on('tasks:updated', handler)
      return () => ipcRenderer.removeListener('tasks:updated', handler)
    }
  },
  pty: {
    write: (ptyId: string, data: string): Promise<void> =>
      ipcRenderer.invoke('pty:write', ptyId, data),
    resize: (ptyId: string, cols: number, rows: number): Promise<void> =>
      ipcRenderer.invoke('pty:resize', ptyId, cols, rows),
    list: (): Promise<Array<{ ptyId: string; agentId: string }>> =>
      ipcRenderer.invoke('pty:list'),
    isAlive: (ptyId: string): Promise<boolean> => ipcRenderer.invoke('pty:isAlive', ptyId),
    lookup: (
      ptyId: string
    ): Promise<{ alive: true; ptyId: string; agentId: string } | { alive: false; ptyId: string }> =>
      ipcRenderer.invoke('pty:lookup', ptyId),
    create: (request: PtyCreateRequest): Promise<PtyCreateResult> =>
      ipcRenderer.invoke('pty:create', request),
    kill: (ptyId: string): Promise<void> => ipcRenderer.invoke('pty:kill', ptyId),
    onData: (cb: (payload: { ptyId: string; data: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { ptyId: string; data: string }) =>
        cb(payload)
      ipcRenderer.on('pty:data', handler)
      return () => ipcRenderer.removeListener('pty:data', handler)
    },
    onExit: (cb: (payload: { ptyId: string; agentId: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { ptyId: string; agentId: string }) =>
        cb(payload)
      ipcRenderer.on('pty:exit', handler)
      return () => ipcRenderer.removeListener('pty:exit', handler)
    },
    onActivated: (cb: (payload: { ptyId: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { ptyId: string }) => cb(payload)
      ipcRenderer.on('pty:activated', handler)
      return () => ipcRenderer.removeListener('pty:activated', handler)
    }
  },
  fs: {
    listDir: (dirPath?: string, projectId?: string, threadId?: string | null): Promise<FileEntry[]> =>
      ipcRenderer.invoke('fs:listDir', dirPath, projectId, threadId),
    readFile: (filePath: string, projectId?: string, threadId?: string | null): Promise<string> =>
      ipcRenderer.invoke('fs:readFile', filePath, projectId, threadId),
    readAsset: (filePath: string, projectId?: string, threadId?: string | null): Promise<FileAsset> =>
      ipcRenderer.invoke('fs:readAsset', filePath, projectId, threadId),
    writeFile: (filePath: string, content: string, projectId?: string, threadId?: string | null): Promise<void> =>
      ipcRenderer.invoke('fs:writeFile', filePath, content, projectId, threadId),
    stat: (targetPath: string, projectId?: string): Promise<FileStat> =>
      ipcRenderer.invoke('fs:stat', targetPath, projectId)
  },
  git: {
    status: (projectId?: string, cwd?: string): Promise<GitStatusSnapshot> =>
      ipcRenderer.invoke('git:status', projectId, cwd),
    diff: (filePath: string, staged: boolean, projectId?: string, cwd?: string): Promise<string> =>
      ipcRenderer.invoke('git:diff', filePath, staged, projectId, cwd),
    log: (limit?: number, projectId?: string, cwd?: string): Promise<GitCommit[]> =>
      ipcRenderer.invoke('git:log', limit, projectId, cwd),
    branches: (projectId?: string, cwd?: string): Promise<GitBranchInfo> =>
      ipcRenderer.invoke('git:branches', projectId, cwd),
    diffStats: (projectId?: string, cwd?: string): Promise<GitDiffStats> =>
      ipcRenderer.invoke('git:diffStats', projectId, cwd),
    checkout: (branch: string, projectId?: string, cwd?: string): Promise<void> =>
      ipcRenderer.invoke('git:checkout', branch, projectId, cwd),
    commit: (message: string, projectId?: string, cwd?: string): Promise<void> =>
      ipcRenderer.invoke('git:commit', message, projectId, cwd),
    push: (projectId?: string, cwd?: string): Promise<void> =>
      ipcRenderer.invoke('git:push', projectId, cwd)
  },
  browser: {
    navigate: (url: string): Promise<BrowserState> => ipcRenderer.invoke('browser:navigate', url),
    goBack: (): Promise<BrowserState> => ipcRenderer.invoke('browser:goBack'),
    goForward: (): Promise<BrowserState> => ipcRenderer.invoke('browser:goForward'),
    reload: (): Promise<BrowserState> => ipcRenderer.invoke('browser:reload'),
    getState: (): Promise<BrowserState> => ipcRenderer.invoke('browser:getState'),
    clearCookies: (): Promise<void> => ipcRenderer.invoke('browser:clearCookies'),
    clearCache: (): Promise<void> => ipcRenderer.invoke('browser:clearCache'),
    setVisible: (visible: boolean): Promise<void> =>
      ipcRenderer.invoke('browser:setVisible', visible),
    setBounds: (bounds: BrowserBounds): Promise<void> =>
      ipcRenderer.invoke('browser:setBounds', bounds),
    onState: (cb: (state: BrowserState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, state: BrowserState) => cb(state)
      ipcRenderer.on('browser:state', handler)
      return () => ipcRenderer.removeListener('browser:state', handler)
    }
  },
  settings: {
    get: (): Promise<MousseSettings> => ipcRenderer.invoke('settings:get'),
    set: (partial: MousseSettingsUpdate): Promise<MousseSettings> =>
      ipcRenderer.invoke('settings:set', partial),
    getOptions: (): Promise<SettingsOptions> => ipcRenderer.invoke('settings:getOptions'),
    onChanged: (cb: (settings: MousseSettings) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, settings: MousseSettings) => cb(settings)
      ipcRenderer.on('settings:changed', handler)
      return () => ipcRenderer.removeListener('settings:changed', handler)
    }
  },
  lineEdits: {
    getStats: (): Promise<LineEditStatsSnapshot> => ipcRenderer.invoke('lineEdits:getStats'),
    onUpdated: (cb: (stats: LineEditStatsSnapshot) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, stats: LineEditStatsSnapshot) => cb(stats)
      ipcRenderer.on('lineEdits:updated', handler)
      return () => ipcRenderer.removeListener('lineEdits:updated', handler)
    }
  },
  mcp: {
    listServers: (projectId?: string): Promise<McpServerConfig[]> =>
      ipcRenderer.invoke('mcp:listServers', projectId),
    listTools: (serverId: string, projectId?: string): Promise<McpToolDescriptor[]> =>
      ipcRenderer.invoke('mcp:listTools', serverId, projectId),
    testServer: (serverId: string, projectId?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:testServer', serverId, projectId),
    authenticate: (serverId: string, projectId?: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('mcp:authenticate', serverId, projectId),
    restartServer: (serverId: string): Promise<void> =>
      ipcRenderer.invoke('mcp:restartServer', serverId),
    getConfigSources: (projectId?: string): Promise<McpConfigSourceDescriptor[]> =>
      ipcRenderer.invoke('mcp:getConfigSources', projectId),
    writeCursorConfig: (
      scope: 'global' | 'project',
      patch: Record<string, unknown>,
      projectId?: string
    ): Promise<void> => ipcRenderer.invoke('mcp:writeCursorConfig', scope, patch, projectId),
    openConfig: (scope: 'global' | 'project', projectId?: string): Promise<string> =>
      ipcRenderer.invoke('mcp:openConfig', scope, projectId),
    onChanged: (cb: () => void): (() => void) => {
      const handler = () => cb()
      ipcRenderer.on('mcp:changed', handler)
      return () => ipcRenderer.removeListener('mcp:changed', handler)
    }
  },
  skills: {
    list: (projectId?: string): Promise<SkillsRegistrySnapshot> =>
      ipcRenderer.invoke('skills:list', projectId),
    read: (skillId: string, projectId?: string): Promise<SkillReadResult> =>
      ipcRenderer.invoke('skills:read', skillId, projectId),
    refresh: (projectId?: string): Promise<SkillsRegistrySnapshot> =>
      ipcRenderer.invoke('skills:refresh', projectId),
    openFolder: (scope: 'global' | 'project', projectId?: string): Promise<string> =>
      ipcRenderer.invoke('skills:openFolder', scope, projectId),
    onChanged: (cb: (snapshot: SkillsRegistrySnapshot) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, snapshot: SkillsRegistrySnapshot) => cb(snapshot)
      ipcRenderer.on('skills:changed', handler)
      return () => ipcRenderer.removeListener('skills:changed', handler)
    }
  },
  workspace: {
    getStatus: (threadId: string): Promise<unknown> => ipcRenderer.invoke('workspace:getStatus', threadId),
    restore: (threadId: string, expectedJournalGeneration?: number): Promise<unknown> =>
      ipcRenderer.invoke('workspace:restore', threadId, expectedJournalGeneration)
  },
  actions: {
    list: (threadId: string): Promise<unknown> => ipcRenderer.invoke('actions:list', threadId),
    undoLatest: (threadId: string, expectedJournalGeneration: number): Promise<unknown> =>
      ipcRenderer.invoke('actions:undoLatest', threadId, expectedJournalGeneration),
    revertCode: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:revertCode', params),
    redo: (threadId: string, expectedJournalGeneration: number): Promise<unknown> =>
      ipcRenderer.invoke('actions:redo', threadId, expectedJournalGeneration),
    fork: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:fork', params),
    activateBranch: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:activateBranch', params)
  },
  publish: {
    start: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('publish:start', params)
  },
  operations: {
    abort: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('operations:abort', params)
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    open: (): Promise<Project | null> => ipcRenderer.invoke('projects:open'),
    remove: (projectId: string): Promise<void> =>
      ipcRenderer.invoke('projects:remove', projectId),
    rename: (projectId: string, name: string): Promise<Project> =>
      ipcRenderer.invoke('projects:rename', projectId, name),
    pin: (projectId: string, pinned: boolean): Promise<Project> =>
      ipcRenderer.invoke('projects:pin', projectId, pinned),
    reorder: (projectIds: string[]): Promise<Project[]> =>
      ipcRenderer.invoke('projects:reorder', projectIds),
    listThreads: (projectId: string): Promise<Thread[]> =>
      ipcRenderer.invoke('projects:threads', projectId),
    onUpdated: (cb: (projects: Project[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, projects: Project[]) => cb(projects)
      ipcRenderer.on('projects:updated', handler)
      return () => ipcRenderer.removeListener('projects:updated', handler)
    }
  },
  threads: {
    list: (): Promise<Thread[]> => ipcRenderer.invoke('threads:list'),
    listAll: (): Promise<Thread[]> => ipcRenderer.invoke('threads:listAll'),
    active: (): Promise<string | null> => ipcRenderer.invoke('threads:active'),
    getActivity: (): Promise<ThreadActivitySnapshot> => ipcRenderer.invoke('threads:activity'),
    create: (name?: string, projectId?: string): Promise<Thread> =>
      ipcRenderer.invoke('threads:create', name, projectId),
    createAndSelect: (name?: string, projectId?: string): Promise<Thread> =>
      ipcRenderer.invoke('threads:createAndSelect', name, projectId),
    select: (threadId: string): Promise<void> => ipcRenderer.invoke('threads:select', threadId),
    delete: (threadId: string): Promise<void> => ipcRenderer.invoke('threads:delete', threadId),
    restore: (threadId: string): Promise<unknown> => ipcRenderer.invoke('threads:restore', threadId),
    purge: (threadId: string): Promise<unknown> => ipcRenderer.invoke('threads:purge', threadId),
    rename: (threadId: string, name: string): Promise<Thread> =>
      ipcRenderer.invoke('threads:rename', threadId, name),
    regenerateTitle: (threadId: string): Promise<Thread> =>
      ipcRenderer.invoke('threads:regenerateTitle', threadId),
    setModel: (
      threadId: string,
      model?: { llmProvider: string; model: string }
    ): Promise<Thread> => ipcRenderer.invoke('threads:setModel', threadId, model),
    pin: (threadId: string, pinned: boolean): Promise<Thread> =>
      ipcRenderer.invoke('threads:pin', threadId, pinned),
    settle: (threadId: string, settled: boolean): Promise<Thread> =>
      ipcRenderer.invoke('threads:settle', threadId, settled),
    reorder: (projectId: string | undefined, threadIds: string[]): Promise<Thread[]> =>
      ipcRenderer.invoke('threads:reorder', projectId, threadIds),
    search: (query: string, limit?: number): Promise<ThreadSearchResult[]> =>
      ipcRenderer.invoke('threads:search', query, limit),
    onUpdated: (cb: (threads: Thread[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, threads: Thread[]) => cb(threads)
      ipcRenderer.on('threads:updated', handler)
      return () => ipcRenderer.removeListener('threads:updated', handler)
    },
    onTitleGenerationFailed: (
      cb: (payload: { threadId: string; error: string }) => void
    ): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { threadId: string; error: string }) => cb(payload)
      ipcRenderer.on('threads:title-generation-failed', handler)
      return () => ipcRenderer.removeListener('threads:title-generation-failed', handler)
    },
    onSelected: (cb: (payload: { id: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { id: string }) => cb(payload)
      ipcRenderer.on('thread:selected', handler)
      return () => ipcRenderer.removeListener('thread:selected', handler)
    },
    /**
     * Combined messages + agents + tasks for the selected thread (select / resnapshot).
     * Prefer this over separate orchestrator:messages + agents:updated + tasks:updated.
     */
    onView: (
      cb: (payload: {
        threadId: string
        messages: ChatMessage[]
        agents: Agent[]
        tasks: Task[]
      }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: {
          threadId: string
          messages: ChatMessage[]
          agents: Agent[]
          tasks: Task[]
        }
      ) => cb(payload)
      ipcRenderer.on('thread:view', handler)
      return () => ipcRenderer.removeListener('thread:view', handler)
    },
    onActivity: (cb: (activity: ThreadActivitySnapshot) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, activity: ThreadActivitySnapshot) =>
        cb(activity)
      ipcRenderer.on('threads:activity', handler)
      return () => ipcRenderer.removeListener('threads:activity', handler)
    }
  },
  scheduled: {
    list: (): Promise<ScheduledJob[]> => ipcRenderer.invoke('scheduled:list'),
    get: (id: string): Promise<ScheduledJob | undefined> => ipcRenderer.invoke('scheduled:get', id),
    create: (input: CreateScheduledJobInput): Promise<ScheduledJob> =>
      ipcRenderer.invoke('scheduled:create', input),
    update: (id: string, patch: Partial<ScheduledJob>): Promise<ScheduledJob | null> =>
      ipcRenderer.invoke('scheduled:update', id, patch),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('scheduled:delete', id),
    pause: (id: string, reason?: string): Promise<ScheduledJob | null> =>
      ipcRenderer.invoke('scheduled:pause', id, reason),
    resume: (id: string): Promise<ScheduledJob | null> =>
      ipcRenderer.invoke('scheduled:resume', id),
    run: (id: string): Promise<ScheduledJob | null> => ipcRenderer.invoke('scheduled:run', id),
    status: (): Promise<SchedulerStatus> => ipcRenderer.invoke('scheduled:status'),
    onUpdated: (cb: (jobs: ScheduledJob[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, jobs: ScheduledJob[]) => cb(jobs)
      ipcRenderer.on('scheduled:updated', handler)
      return () => ipcRenderer.removeListener('scheduled:updated', handler)
    },
    onStatus: (cb: (status: SchedulerStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: SchedulerStatus) => cb(status)
      ipcRenderer.on('scheduled:status', handler)
      return () => ipcRenderer.removeListener('scheduled:status', handler)
    }
  },
  channels: {
    getSnapshot: (): Promise<ChannelsSnapshot> => ipcRenderer.invoke('channels:getSnapshot'),
    getConfig: (): Promise<ChannelConfig> => ipcRenderer.invoke('channels:getConfig'),
    updateConfig: (patch: Partial<ChannelConfig>): Promise<ChannelConfig> =>
      ipcRenderer.invoke('channels:updateConfig', patch),
    connect: (platform?: ChannelPlatform): Promise<ChannelsSnapshot> =>
      ipcRenderer.invoke('channels:connect', platform),
    disconnect: (platform?: ChannelPlatform): Promise<ChannelsSnapshot> =>
      ipcRenderer.invoke('channels:disconnect', platform),
    listPairingRequests: (): Promise<PairingRequest[]> =>
      ipcRenderer.invoke('channels:listPairingRequests'),
    approvePairing: (code: string): Promise<boolean> =>
      ipcRenderer.invoke('channels:approvePairing', code),
    rejectPairing: (code: string): Promise<boolean> =>
      ipcRenderer.invoke('channels:rejectPairing', code),
    sendTest: (
      platform: ChannelPlatform,
      chatId: string,
      text: string,
      threadId?: string
    ): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('channels:sendTest', platform, chatId, text, threadId),
    getActivity: (limit?: number): Promise<ChannelActivityEvent[]> =>
      ipcRenderer.invoke('channels:getActivity', limit),
    onUpdated: (cb: (snapshot: ChannelsSnapshot) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, snapshot: ChannelsSnapshot) => cb(snapshot)
      ipcRenderer.on('channels:updated', handler)
      return () => ipcRenderer.removeListener('channels:updated', handler)
    },
    onActivity: (cb: (event: ChannelActivityEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ChannelActivityEvent) => cb(event)
      ipcRenderer.on('channels:activity', handler)
      return () => ipcRenderer.removeListener('channels:activity', handler)
    }
  },
  providers: {
    getUsage: () => ipcRenderer.invoke('providers:getUsage'),
    listConfigured: (): Promise<ConfiguredProvider[]> =>
      ipcRenderer.invoke('providers:listConfigured'),
    getSubscriptionUsage: (providerId: string): Promise<string | undefined> =>
      ipcRenderer.invoke('providers:getSubscriptionUsage', providerId),
    getLoginOptions: (authType?: 'api_key' | 'oauth'): Promise<ProviderLoginOption[]> =>
      ipcRenderer.invoke('providers:getLoginOptions', authType),
    getAmbientInfo: (providerId: string): Promise<AmbientProviderInfo | undefined> =>
      ipcRenderer.invoke('providers:getAmbientInfo', providerId),
    setApiKey: (providerId: string, apiKey: string): Promise<void> =>
      ipcRenderer.invoke('providers:setApiKey', providerId, apiKey),
    verifyAmbient: (providerId: string): Promise<ProviderLoginResult> =>
      ipcRenderer.invoke('providers:verifyAmbient', providerId),
    logout: (providerId: string): Promise<void> =>
      ipcRenderer.invoke('providers:logout', providerId),
    loginOAuth: (providerId: string): Promise<ProviderLoginResult> =>
      ipcRenderer.invoke('providers:loginOAuth', providerId),
    loginApiKey: (providerId: string): Promise<ProviderLoginResult> =>
      ipcRenderer.invoke('providers:loginApiKey', providerId),
    respondLogin: (response: ProviderLoginResponse): Promise<void> =>
      ipcRenderer.invoke('providers:login:respond', response),
    cancelLogin: (sessionId: string): Promise<void> =>
      ipcRenderer.invoke('providers:login:cancel', sessionId),
    onLoginEvent: (cb: (event: ProviderLoginEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ProviderLoginEvent) => cb(event)
      ipcRenderer.on('providers:login:event', handler)
      return () => ipcRenderer.removeListener('providers:login:event', handler)
    },
    onChanged: (cb: (providers: ConfiguredProvider[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, providers: ConfiguredProvider[]) =>
        cb(providers)
      ipcRenderer.on('providers:changed', handler)
      return () => ipcRenderer.removeListener('providers:changed', handler)
    }
  },
  app: {
    getInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getInfo'),
    getActiveProjectPath: (threadId?: string | null): Promise<string | null> =>
      ipcRenderer.invoke('app:getActiveProjectPath', threadId),
    getFilesRoot: (threadId?: string | null): Promise<string> =>
      ipcRenderer.invoke('app:getFilesRoot', threadId),
    restart: (): Promise<void> => ipcRenderer.invoke('app:restart'),
    navigateMainView: (view: MainView): Promise<void> =>
      ipcRenderer.invoke('app:navigateMainView', view),
    onNavigateMainView: (cb: (view: MainView) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, view: MainView) => cb(view)
      ipcRenderer.on('app:navigateMainView', handler)
      return () => ipcRenderer.removeListener('app:navigateMainView', handler)
    }
  },
  clipboard: {
    showCopyMenu: (x: number, y: number, text: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:showCopyMenu', x, y, text)
  },
  window: {
    minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
    maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
    dragStart: (point: { screenX: number; screenY: number }): Promise<void> =>
      ipcRenderer.invoke('window:dragStart', point),
    dragMove: (point: { screenX: number; screenY: number }): Promise<void> =>
      ipcRenderer.invoke('window:dragMove', point),
    dragEnd: (): Promise<void> => ipcRenderer.invoke('window:dragEnd'),
    close: (): Promise<void> => ipcRenderer.invoke('window:close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:isMaximized'),
    syncBackground: (): Promise<boolean> => ipcRenderer.invoke('window:syncBackground'),
    openAgentsTasks: (anchor?: { x: number; y: number }): Promise<void> =>
      ipcRenderer.invoke('window:openAgentsTasks', anchor),
    closeAgentsTasks: (): Promise<void> => ipcRenderer.invoke('window:closeAgentsTasks'),
    focusMain: (): Promise<void> => ipcRenderer.invoke('window:focusMain'),
    onMaximizedChange: (cb: (maximized: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, maximized: boolean) => cb(maximized)
      ipcRenderer.on('window:maximized-changed', handler)
      return () => ipcRenderer.removeListener('window:maximized-changed', handler)
    },
    onFocusChanged: (cb: (focused: boolean) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, focused: boolean) => cb(focused)
      ipcRenderer.on('window:focus-changed', handler)
      return () => ipcRenderer.removeListener('window:focus-changed', handler)
    }
  }
}

contextBridge.exposeInMainWorld('mousse', api)

export type MousseAPI = typeof api
