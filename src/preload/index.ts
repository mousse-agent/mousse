import type { AppletApi, AppletUiEvent } from '../shared/appletRuntime'
import { contextBridge, ipcRenderer } from 'electron'
import { readStartupAppearanceArgument } from '../shared/startupAppearance'
import type { NetStatus } from '../shared/net/local'
import type { RemoteOpenResult, RemoteRoute } from '../shared/remoteEditor'
import type { CommandId } from '../shared/commands'
import type { LocalTtsModelId, LocalTtsModelStatus, ProviderSpeechRequest, ProviderSpeechResult } from '../shared/readAloud'
import type { LocalSttModelId, LocalSttModelStatus, ProviderTranscriptionRequest, ProviderTranscriptionResult } from '../shared/dictation'
import type { WindowResizeEdge } from '../shared/windowResize'
import { UPDATE_IPC, type UpdateChannel, type UpdateState } from '../shared/updates'
import type { SubagentSummary, SubagentsUpdatedEvent } from '../shared/subagents'
import type {
  Agent,
  BrowserBounds,
  BrowserState,
  ChatMessage,
  ThreadMessagesSnapshot,
  OrchestratorContextUsageInput,
  OrchestratorSendInput,
  ContextUsageSnapshot,
  DocumentOpenPayload,
  FileAsset,
  EditorInfo,
  FileEntry,
  FileGrepResponse,
  FileSearchResponse,
  GitBranchInfo,
  GitBranchOptions,
  GitCheckoutOptions,
  GitCheckoutResult,
  GitCommit,
  GitCommitOptions,
  GitCommitSuggestion,
  GitDeleteBranchOptions,
  GitDiffStats,
  GitFetchOptions,
  GitFetchResult,
  GitOperationEvent,
  GitMutationResult,
  GitPullOptions,
  GitPullRequestLookup,
  GitPullResult,
  GitPushOptions,
  GitScope,
  GitStatusSnapshot,
  ApprovalRuleInfo,
  MainView,
  OrchestratorResponse,
  PermissionMode,
  Project,
  PtyCreateRequest,
  PtyCreateResult,
  QueuedMessage,
  CreateScheduledJobInput,
  ScheduledJob,
  ScheduledJobPatch,
  ScheduledWebhookDeliveryLog,
  ScheduledWebhookGrant,
  ScheduledSettings,
  ScheduledSettingsUpdate,
  SchedulerStatus,
  ChannelActivityEvent,
  ChannelConfig,
  ChannelOwnerClaim,
  ChannelPlatform,
  ChannelsSnapshot,
  PairingRequest,
  ThreadSearchResponse,
  PendingUserQuestions,
  Task,
  TaskStatus,
  Thread,
  ThreadActivitySnapshot,
  TurnState,
  TurnStateSnapshot,
  QuestionAnswerOutcome,
  UserQuestionAnswers
} from '../shared/types'
import type {
  CreatePullRequestResult,
  PullRequestBaseBranches,
  PullRequestDetail,
  PullRequestDraft,
  PullRequestFormInput,
  PullRequestListItem,
  PullRequestPushTarget,
  PullRequestRef,
  PullRequestScope,
  PullRequestWatchMode,
  PullRequestWatchStatus,
  ResolvedPullRequestSummary,
  StartPullRequestThreadInput,
  StartPullRequestThreadResult
} from '../shared/pullRequests'
import type { ProfileCreateInput, ProfilePublicDto, ProfileUpdateInput } from '../shared/profiles/types'
import type { MousseSettings, MousseSettingsUpdate, SettingsOptions } from '../shared/settings'
import type { LineEditStatsSnapshot, UsageStatsSnapshot } from '../shared/lineEditStats'
import type {
  McpConfigSourceDescriptor,
  McpServerConfig,
  McpToolDescriptor,
  SkillReadResult,
  SkillsRegistrySnapshot
} from '../shared/integrations'
import type { CliInstallEvent } from '../shared/providerAuth'
import type { InstanceSnapshot, ModelRefreshResult, ProviderSnapshotsEvent } from '../shared/harness/status'
import type { MoveResult } from '../shared/harness/move'
import type {
  AddInstanceInput,
  InstanceConfigPatch,
  ModelPrefsPatch,
  ProviderAddOption,
  ProviderOperationEvent,
  ProviderOperationStarted,
  ProviderScope,
  RegistryAgentView,
  RemoveInstallResult,
  SignInResponse
} from '../shared/harness/types'
import type { BotEscalationSummary } from '../shared/bots/personal/escalation'
import type { PlatformRequestApi, PlatformRequestErrorShape, PlatformRequestMethod, PlatformResponse } from '../shared/platform'
import type { ChatReference } from '../shared/chatReferences'
import type { InAppBrowserApi, InAppBrowserState } from '../shared/browser/inApp'
import type { ReviewFileParams, ReviewFileResult, ReviewFilesParams, ReviewFilesResult } from '../shared/review'
import type {
  GitHubApi,
  GitHubAvailability,
  GitHubCloneRepositoryInput,
  GitHubCloneRepositoryResult,
  GitHubCreateRepositoryInput,
  GitHubCreateRepositoryResult
} from '../shared/github'

interface ChatReferencesApi {
  resolve(reference: ChatReference): Promise<ChatReference | null>
}

export interface AppInfo {
  deviceName?: string
  platform: string
  repoRoot: string
  llmProvider: string
}

const platformRequest: PlatformRequestApi['request'] = async <T>(method: PlatformRequestMethod, params?: unknown): Promise<T> => {
  try {
    const response = await ipcRenderer.invoke('platform:request', { method, params }) as PlatformResponse<unknown>
    if (response?.ok) return response.value as T
    const error = response?.error
    if (error && typeof error.code === 'string') {
      // Plain data crosses contextBridge with code/details intact; Error
      // subclasses lose custom fields during Electron's structured clone.
      throw { name: 'PlatformRequestError', code: error.code, message: error.message, details: error.details, errorInfo: error.errorInfo }
    }
    throw { name: 'PlatformRequestError', code: 'platform_invalid_response', message: 'Platform bridge returned an invalid response' }
  } catch (error) {
    const shape = error as PlatformRequestErrorShape | null
    if (shape && typeof shape.code === 'string') {
      throw shape
    }
    throw error
  }
}

async function storageInvoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const response = await ipcRenderer.invoke(channel, ...args) as PlatformResponse<T>
  if (response?.ok) return response.value
  if (response?.error) throw { ...response.error, name: 'StorageRequestError' }
  throw { code: 'storage_invalid_response', message: 'Storage bridge returned an invalid response', errorInfo: { category: 'internal', retryable: false } }
}

const api = {
  platform: process.platform,
  startupAppearance: readStartupAppearanceArgument(process.argv),
  /** Bounded profile-aware bridge for new platform feature clients. */
  platformRequest: {
    request: platformRequest
  },
  chatReferences: {
    resolve: (reference: ChatReference): Promise<ChatReference | null> =>
      platformRequest<ChatReference | null>('chatReferences.resolve', { reference })
  } satisfies ChatReferencesApi,
  applets: {
    get: input => ipcRenderer.invoke('applets:get', input),
    mount: input => ipcRenderer.invoke('applets:mount', input),
    update: input => ipcRenderer.invoke('applets:update', input),
    appearance: input => ipcRenderer.invoke('applets:appearance', input),
    snapshot: input => ipcRenderer.invoke('applets:snapshot', input),
    suspend: input => ipcRenderer.invoke('applets:suspend', input),
    unmount: input => ipcRenderer.invoke('applets:unmount', input),
    export: input => ipcRenderer.invoke('applets:export', input),
    onEvent: callback => {
      const handler = (_event: Electron.IpcRendererEvent, value: AppletUiEvent) => callback(value)
      ipcRenderer.on('applets:event', handler)
      return () => ipcRenderer.removeListener('applets:event', handler)
    }
  } satisfies AppletApi,
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
    onResponse: (cb: (resp: OrchestratorResponse) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, resp: OrchestratorResponse) => cb(resp)
      ipcRenderer.on('orchestrator:response', handler)
      return () => ipcRenderer.removeListener('orchestrator:response', handler)
    },
    onThreadMessages: (
      cb: (payload: ThreadMessagesSnapshot) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: ThreadMessagesSnapshot
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
    onQuestionsPending: (cb: (payload: PendingUserQuestions) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: PendingUserQuestions) => cb(payload)
      ipcRenderer.on('orchestrator:questionsPending', handler)
      return () => ipcRenderer.removeListener('orchestrator:questionsPending', handler)
    },
    onQuestionsCleared: (
      cb: (payload: { requestId: string; threadId?: string }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { requestId: string; threadId?: string }
      ) => cb(payload)
      ipcRenderer.on('orchestrator:questionsCleared', handler)
      return () => ipcRenderer.removeListener('orchestrator:questionsCleared', handler)
    },
    onTurnSteered: (
      cb: (payload: { threadId?: string; text: string }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: { threadId?: string; text: string }
      ) => cb(payload)
      ipcRenderer.on('orchestrator:turn-steered', handler)
      return () => ipcRenderer.removeListener('orchestrator:turn-steered', handler)
    },
    /** `threadId` names the thread that asked; a thread on another computer needs it. */
    answerQuestions: (requestId: string, answers: UserQuestionAnswers, threadId?: string): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:answerQuestions', requestId, answers, threadId),
    /** `answerQuestions` with its outcome: who answered a saved approval request first, or why it was closed. */
    answerQuestionsDetailed: (requestId: string, answers: UserQuestionAnswers, threadId?: string): Promise<QuestionAnswerOutcome> =>
      ipcRenderer.invoke('orchestrator:answerQuestionsDetailed', requestId, answers, threadId),
    dismissQuestions: (requestId: string, threadId?: string): Promise<boolean> =>
      ipcRenderer.invoke('orchestrator:dismissQuestions', requestId, threadId),
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
  quickActions: {
    onCreated: (cb: (action: unknown) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, action: unknown) => cb(action)
      ipcRenderer.on('quickActions:created', handler)
      return () => ipcRenderer.removeListener('quickActions:created', handler)
    }
  },
  subagents: {
    list: (threadId: string): Promise<SubagentSummary[]> => ipcRenderer.invoke('subagents:list', threadId),
    stopAll: (threadId: string): Promise<boolean> => ipcRenderer.invoke('subagents:stopAll', threadId),
    onUpdated: (cb: (payload: SubagentsUpdatedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: SubagentsUpdatedEvent) => cb(payload)
      ipcRenderer.on('subagents:updated', handler)
      return () => ipcRenderer.removeListener('subagents:updated', handler)
    }
  },
  agents: {
    /** Omit threadId to list agents for the active thread. */
    list: (threadId?: string): Promise<Agent[]> => ipcRenderer.invoke('agents:list', threadId),
    stop: (agentId: string, threadId?: string): Promise<string[]> => ipcRenderer.invoke('agents:stop', agentId, threadId),
    onUpdated: (cb: (agents: Agent[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, agents: Agent[]) => cb(agents)
      ipcRenderer.on('agents:updated', handler)
      return () => ipcRenderer.removeListener('agents:updated', handler)
    },
    onSpawned: (cb: (agent: Agent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, agent: Agent) => cb(agent)
      ipcRenderer.on('agent:spawned', handler)
      return () => ipcRenderer.removeListener('agent:spawned', handler)
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
    /** `threadId` names the terminal's thread; a terminal on another computer needs it. */
    write: (ptyId: string, data: string, threadId?: string): Promise<void> =>
      ipcRenderer.invoke('pty:write', ptyId, data, threadId),
    resize: (ptyId: string, cols: number, rows: number, threadId?: string): Promise<void> =>
      ipcRenderer.invoke('pty:resize', ptyId, cols, rows, threadId),
    /** `heldBy` is set on a terminal another of the user's computers opened on this thread. */
    list: (): Promise<
      Array<{ ptyId: string; agentId: string; heldBy?: { node: string; name: string; openedAt: number } }>
    > => ipcRenderer.invoke('pty:list'),
    /** `threadId` names the terminal's thread; a thread on another computer needs it. */
    isAlive: (ptyId: string, threadId?: string): Promise<boolean> => ipcRenderer.invoke('pty:isAlive', ptyId, threadId),
    lookup: (
      ptyId: string,
      threadId?: string
    ): Promise<{ alive: true; ptyId: string; agentId: string } | { alive: false; ptyId: string }> =>
      ipcRenderer.invoke('pty:lookup', ptyId, threadId),
    create: (request: PtyCreateRequest): Promise<PtyCreateResult> =>
      ipcRenderer.invoke('pty:create', request),
    kill: (ptyId: string, threadId?: string): Promise<void> =>
      ipcRenderer.invoke('pty:kill', ptyId, threadId),
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
    search: (
      query: string,
      options?: { limit?: number; kinds?: Array<'file' | 'directory'> },
      projectId?: string,
      threadId?: string | null
    ): Promise<FileSearchResponse> => ipcRenderer.invoke('fs:search', query, options, projectId, threadId),
    grep: (
      query: string,
      options?: { regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean; limit?: number; timeoutMs?: number },
      projectId?: string,
      threadId?: string | null
    ): Promise<FileGrepResponse> => ipcRenderer.invoke('fs:grep', query, options, projectId, threadId)
  },
  github: {
    status: (): Promise<GitHubAvailability> => ipcRenderer.invoke('github:status'),
    createRepository: (input: GitHubCreateRepositoryInput): Promise<GitHubCreateRepositoryResult> =>
      ipcRenderer.invoke('github:createRepository', input),
    chooseCloneDestination: (): Promise<string | null> =>
      ipcRenderer.invoke('github:chooseCloneDestination'),
    cloneRepository: (input: GitHubCloneRepositoryInput): Promise<GitHubCloneRepositoryResult> =>
      ipcRenderer.invoke('github:cloneRepository', input)
  } satisfies GitHubApi,
  git: {
    // Reads name their folder by scope, like the mutations: the thread when it is the thread's own worktree, else the project.
    status: (scope: GitScope): Promise<GitStatusSnapshot> =>
      ipcRenderer.invoke('git:status', scope),
    log: (limit: number | undefined, scope: GitScope): Promise<GitCommit[]> =>
      ipcRenderer.invoke('git:log', limit, scope),
    branches: (scope: GitScope): Promise<GitBranchInfo> =>
      ipcRenderer.invoke('git:branches', scope),
    diffStats: (scope: GitScope): Promise<GitDiffStats> =>
      ipcRenderer.invoke('git:diffStats', scope),
    // Mutations run in the daemon and reject with `{ code, message, details }` (storage handlers).
    checkout: (scope: GitScope, branch: string, options?: GitCheckoutOptions): Promise<GitMutationResult<GitCheckoutResult>> =>
      storageInvoke('git:checkout', scope, branch, options),
    commit: (scope: GitScope, message: string, options?: GitCommitOptions): Promise<GitMutationResult> =>
      storageInvoke('git:commit', scope, message, options),
    suggestCommitMessage: (scope: GitScope, options?: { expectedBranch?: string }): Promise<GitCommitSuggestion> =>
      storageInvoke('git:suggestCommitMessage', scope, options),
    push: (scope: GitScope, options?: GitPushOptions): Promise<GitMutationResult> =>
      storageInvoke('git:push', scope, options),
    init: (scope: GitScope): Promise<GitMutationResult> =>
      storageInvoke('git:init', scope),
    stage: (scope: GitScope, input: { paths: string[] } | { all: true }): Promise<GitMutationResult> =>
      storageInvoke('git:stage', scope, input),
    unstage: (scope: GitScope, input: { paths: string[] } | { all: true }): Promise<GitMutationResult> =>
      storageInvoke('git:unstage', scope, input),
    discard: (scope: GitScope, paths: string[]): Promise<GitMutationResult> =>
      storageInvoke('git:discard', scope, paths),
    fetch: (scope: GitScope, options?: GitFetchOptions): Promise<GitMutationResult<GitFetchResult>> =>
      storageInvoke('git:fetch', scope, options),
    pull: (scope: GitScope, options?: GitPullOptions): Promise<GitMutationResult<GitPullResult>> =>
      storageInvoke('git:pull', scope, options),
    /** Live output of the Git actions this window started. */
    onOperation: (cb: (event: GitOperationEvent) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: GitOperationEvent): void => cb(payload)
      ipcRenderer.on('git:operation', handler)
      return () => ipcRenderer.removeListener('git:operation', handler)
    },
    /**
     * Stops a push, pull, fetch or commit this window started, with everything Git started for it.
     * A thread's or project's folder on another computer needs its `threadId` or `projectId`; at most one is set.
     */
    cancelOperation: (operationId: string, threadId?: string, projectId?: string): Promise<{ cancelled: boolean }> =>
      storageInvoke('git:cancelOperation', operationId, threadId, projectId),
    abortInProgress: (scope: GitScope, kind: 'merge' | 'rebase'): Promise<GitMutationResult> =>
      storageInvoke('git:abortInProgress', scope, kind),
    createBranch: (scope: GitScope, name: string, options?: GitBranchOptions): Promise<GitMutationResult> =>
      storageInvoke('git:createBranch', scope, name, options),
    renameBranch: (scope: GitScope, name: string, newName: string): Promise<GitMutationResult> =>
      storageInvoke('git:renameBranch', scope, name, newName),
    deleteBranch: (scope: GitScope, name: string, options?: GitDeleteBranchOptions): Promise<GitMutationResult> =>
      storageInvoke('git:deleteBranch', scope, name, options),
    lastCommitMessage: (scope: GitScope): Promise<string | null> =>
      ipcRenderer.invoke('git:lastCommitMessage', scope)
  },
  pullRequests: {
    get: (ref: PullRequestRef, branch: string, force?: boolean): Promise<GitPullRequestLookup> =>
      ipcRenderer.invoke('pullRequests:get', ref, branch, force),
    detail: (ref: PullRequestRef, number: number, force?: boolean): Promise<PullRequestDetail> =>
      ipcRenderer.invoke('pullRequests:detail', ref, number, force),
    draft: (scope: PullRequestScope, base?: string): Promise<PullRequestDraft> =>
      ipcRenderer.invoke('pullRequests:draft', scope, base),
    create: (scope: PullRequestScope, input: PullRequestFormInput): Promise<CreatePullRequestResult> =>
      ipcRenderer.invoke('pullRequests:create', scope, input),
    baseBranches: (ref: PullRequestRef): Promise<PullRequestBaseBranches> =>
      ipcRenderer.invoke('pullRequests:baseBranches', ref),
    /** The project's open pull requests, most recently updated first. */
    list: (projectId: string, force?: boolean): Promise<PullRequestListItem[]> =>
      storageInvoke('pullRequests:list', projectId, force),
    /** The pull request a number, URL or `gh pr checkout` command names; rejects with a code when it is not this project's. */
    resolve: (projectId: string, reference: string): Promise<ResolvedPullRequestSummary> =>
      storageInvoke('pullRequests:resolve', projectId, reference),
    /** Creates a thread whose worktree starts at the pull request's head; the seed message is returned for the composer. */
    startThread: (input: StartPullRequestThreadInput): Promise<StartPullRequestThreadResult & { thread: Thread }> =>
      storageInvoke('pullRequests:startThread', input),
    /** Where Push goes for a thread linked to a pull request. */
    pushTarget: (threadId: string): Promise<PullRequestPushTarget> =>
      ipcRenderer.invoke('pullRequests:pushTarget', threadId),
    /** Turns a thread's watch of its pull request off, to notify, or to wake the agent. `number` links that pull request first. */
    watch: (threadId: string, watch: PullRequestWatchMode, number?: number): Promise<PullRequestWatchStatus> =>
      ipcRenderer.invoke('pullRequests:watch', threadId, watch, number),
    watchStatus: (threadId: string): Promise<PullRequestWatchStatus> =>
      ipcRenderer.invoke('pullRequests:watchStatus', threadId),
    /** A watched pull request changed (checks finished, a review or comment arrived, the watch ended). */
    onUpdated: (cb: (event: { threadId: string; number: number; changes: string[] }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: { threadId: string; number: number; changes: string[] }) => cb(event)
      ipcRenderer.on('pullRequests:updated', handler)
      return () => ipcRenderer.removeListener('pullRequests:updated', handler)
    }
  },
  editors: {
    list: (options?: { refresh?: boolean }): Promise<EditorInfo[]> =>
      ipcRenderer.invoke('editors:list', options),
    open: (editorId: string, path: string): Promise<void> =>
      ipcRenderer.invoke('editors:open', editorId, path),
    /** Opens the folder of a thread of another computer in an editor of this one, over SSH. */
    openRemote: (editorId: string, threadId: string): Promise<RemoteOpenResult> =>
      ipcRenderer.invoke('editors:openRemote', editorId, threadId),
    /** How this computer reaches the computer that runs a thread, for an editor. */
    remoteRoute: (threadId: string): Promise<RemoteRoute> => ipcRenderer.invoke('editors:remoteRoute', threadId)
  },
  inAppBrowser: {
    registerTab: (input) => ipcRenderer.invoke('browser:register-tab', input),
    selectTab: (input) => ipcRenderer.invoke('browser:select-tab', input),
    takeControl: (localTabId) => ipcRenderer.invoke('browser:take-control', localTabId),
    resumeAgent: (localTabId) => ipcRenderer.invoke('browser:resume-agent', localTabId),
    onState: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: InAppBrowserState) => listener(state)
      ipcRenderer.on('browser:automation-state', handler)
      return () => { ipcRenderer.removeListener('browser:automation-state', handler) }
    }
  } satisfies InAppBrowserApi,
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
  usageStats: {
    getStats: (): Promise<UsageStatsSnapshot> => ipcRenderer.invoke('usageStats:getStats')
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
  /** Personal bots (Automations → Bots): change and escalation events; requests go through `platformRequest`. */
  personalBots: {
    onChanged: (cb: (event: { botId?: string; activationId?: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: { botId?: string; activationId?: string }) => cb(event ?? {})
      ipcRenderer.on('bots:changed', handler)
      return () => ipcRenderer.removeListener('bots:changed', handler)
    },
    onEscalation: (cb: (escalation: BotEscalationSummary) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, escalation: BotEscalationSummary) => cb(escalation)
      ipcRenderer.on('bots:escalation', handler)
      return () => ipcRenderer.removeListener('bots:escalation', handler)
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
  storage: {
    policy: (): Promise<{ trash: import('../shared/resourceLifecycle').TrashRetentionPolicy; trashSweepStatus: { suspended: boolean; reason?: string }; policy: import('../shared/storage').StoragePolicy; clockSuspended: boolean; reviewRecommended?: boolean }> => storageInvoke('storage:policy'),
    reviewDismiss: (): Promise<{ reviewRecommended: false }> => storageInvoke('storage:reviewDismiss'),
    configure: (policy: import('../shared/storage').StoragePolicy): Promise<{ policy: import('../shared/storage').StoragePolicy }> => storageInvoke('storage:configure', policy),
    cleanupPlan: (): Promise<{ plan: import('../shared/storage').StorageCleanupPlanItem[]; token: import('../shared/storage').StorageCleanupPlanToken }> => storageInvoke('storage:cleanupPlan'),
    cleanupRun: (token?: import('../shared/storage').StorageCleanupPlanToken): Promise<{ report: import('../shared/storage').StorageCleanupReport }> => storageInvoke('storage:cleanupRun', token),
    cleanupLastReport: (): Promise<{ report: import('../shared/storage').StorageCleanupReport | null }> => storageInvoke('storage:cleanupLastReport'),
    usage: (options?: { refresh?: boolean }): Promise<import('../shared/storage').StorageUsageSnapshot> => storageInvoke('storage:usage', options)
  },
  workspace: {
    getStatus: (threadId: string): Promise<unknown> => ipcRenderer.invoke('workspace:getStatus', threadId),
    restore: (threadId: string, expectedJournalGeneration?: number): Promise<unknown> =>
      ipcRenderer.invoke('workspace:restore', threadId, expectedJournalGeneration)
  },
  actions: {
    pin: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:pin', params),
    configureRetention: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:configureRetention', params),
    sweepRetention: (threadId: string): Promise<unknown> => ipcRenderer.invoke('actions:sweepRetention', threadId),
    list: (threadId: string): Promise<unknown> => ipcRenderer.invoke('actions:list', threadId),
    undoLatest: (threadId: string, expectedJournalGeneration: number, expectedTurnId?: string): Promise<unknown> =>
      ipcRenderer.invoke('actions:undoLatest', threadId, expectedJournalGeneration, expectedTurnId),
    revertCode: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:revertCode', params),
    redo: (threadId: string, expectedJournalGeneration: number): Promise<unknown> =>
      ipcRenderer.invoke('actions:redo', threadId, expectedJournalGeneration),
    fork: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:fork', params),
    activateBranch: (params: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('actions:activateBranch', params)
  },
  review: {
    files: (params: ReviewFilesParams): Promise<ReviewFilesResult> => ipcRenderer.invoke('review:files', params),
    file: (params: ReviewFileParams): Promise<ReviewFileResult> => ipcRenderer.invoke('review:file', params)
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
    trustGitSettings: (projectId: string): Promise<{ filters: string[] }> =>
      ipcRenderer.invoke('projects:trustGitSettings', projectId),
    listThreads: (projectId: string): Promise<Thread[]> =>
      ipcRenderer.invoke('projects:threads', projectId),
    onUpdated: (cb: (projects: Project[]) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, projects: Project[]) => cb(projects)
      ipcRenderer.on('projects:updated', handler)
      return () => ipcRenderer.removeListener('projects:updated', handler)
    }
  },
  threads: {
    initialize: (): Promise<void> => ipcRenderer.invoke('threads:initialize'),
    list: (): Promise<Thread[]> => ipcRenderer.invoke('threads:list'),
    listAll: (): Promise<Thread[]> => ipcRenderer.invoke('threads:listAll'),
    active: (): Promise<string | null> => ipcRenderer.invoke('threads:active'),
    getActivity: (): Promise<ThreadActivitySnapshot> => ipcRenderer.invoke('threads:activity'),
    /** `opts.node` creates the chat on another of the user's computers (`projectId` is then that computer's, as this computer lists it). */
    create: (name?: string, projectId?: string, opts?: { worktreeEnabled?: boolean; node?: string }): Promise<Thread> =>
      ipcRenderer.invoke('threads:create', name, projectId, opts),
    createAndSelect: (name?: string, projectId?: string, opts?: { worktreeEnabled?: boolean; node?: string }): Promise<Thread> =>
      ipcRenderer.invoke('threads:createAndSelect', name, projectId, opts),
    select: (threadId: string): Promise<void> => ipcRenderer.invoke('threads:select', threadId),
    /** A page of the messages before `before` of a long thread of another computer. */
    loadEarlier: (threadId: string, before: string): Promise<{ messages: ChatMessage[]; earlier?: { before: string; count: number } }> =>
      ipcRenderer.invoke('threads:loadEarlier', threadId, before),
    /** One image of a message that arrived without its bytes. */
    messageImage: (threadId: string, messageId: string, index: number): Promise<{ name: string; mimeType: string; data: string }> =>
      ipcRenderer.invoke('threads:messageImage', threadId, messageId, index),
    delete: (threadId: string): Promise<void> => storageInvoke('threads:delete', threadId),
    restore: (threadId: string): Promise<unknown> => storageInvoke('threads:restore', threadId),
    purge: (threadId: string, options?: { preview?: boolean; operationId?: string; expectedGeneration?: number; previewDigest?: string; discard?: boolean }): Promise<{ preview?: import('../shared/resourceLifecycle').LifecyclePurgePreview; reclaim?: { bytes: number; estimated: boolean; partial: boolean }; lifecycle?: import('../shared/resourceLifecycle').TaskLifecycleRecord }> => storageInvoke('threads:purge', threadId, options),
    /** `includeComputers`: also the trash of the user's other computers (Recently deleted); without it, this computer's alone. */
    inventory: (threadId?: string, options?: { includeComputers?: boolean }): Promise<{ lifecycles: Array<import('../shared/resourceLifecycle').TaskLifecycleRecord & { node?: string; computerName?: string }>; taskNames: Record<string, string>; trashPolicy: import('../shared/resourceLifecycle').TrashRetentionPolicy; trashSweepStatus: { suspended: boolean; reason?: string }; skipped?: import('../shared/types').ThreadSearchSkipped[] }> => storageInvoke('threads:inventory', threadId, options),
    configureTrash: (policy: { graceDays: number; automaticPurge: boolean }): Promise<unknown> => storageInvoke('threads:configureTrash', policy),
    rename: (threadId: string, name: string): Promise<Thread> =>
      ipcRenderer.invoke('threads:rename', threadId, name),
    regenerateTitle: (threadId: string): Promise<Thread> =>
      ipcRenderer.invoke('threads:regenerateTitle', threadId),
    setModel: (
      threadId: string,
      model?: { instanceId?: string; llmProvider: string; model: string }
    ): Promise<Thread> => ipcRenderer.invoke('threads:setModel', threadId, model),
    pin: (threadId: string, pinned: boolean): Promise<Thread> =>
      ipcRenderer.invoke('threads:pin', threadId, pinned),
    setWorktreeEnabled: (threadId: string, enabled: boolean): Promise<Thread> =>
      ipcRenderer.invoke('threads:setWorktreeEnabled', threadId, enabled),
    setPermissionMode: (threadId: string, mode: PermissionMode): Promise<Thread> =>
      ipcRenderer.invoke('threads:setPermissionMode', threadId, mode),
    /** The thread's "Always for this thread" rules. */
    approvalRules: (threadId: string): Promise<ApprovalRuleInfo[]> =>
      ipcRenderer.invoke('threads:approvalRules', threadId),
    /** Revokes one rule (by id) or all of them; returns the rules that remain. */
    clearApprovalRules: (threadId: string, ruleId?: string): Promise<ApprovalRuleInfo[]> =>
      ipcRenderer.invoke('threads:clearApprovalRules', threadId, ruleId),
    settle: (threadId: string, settled: boolean): Promise<Thread> =>
      ipcRenderer.invoke('threads:settle', threadId, settled),
    reorder: (projectId: string | undefined, threadIds: string[]): Promise<Thread[]> =>
      ipcRenderer.invoke('threads:reorder', projectId, threadIds),
    search: (query: string, limit?: number): Promise<ThreadSearchResponse> =>
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
     * Prefer this over separate orchestrator:thread-messages + agents:updated + tasks:updated.
     */
    onView: (
      cb: (payload: {
        threadId: string
        messages: ChatMessage[]
        agents: Agent[]
        tasks: Task[]
        earlier?: { before: string; count: number }
      }) => void
    ): (() => void) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        payload: {
          threadId: string
          messages: ChatMessage[]
          agents: Agent[]
          tasks: Task[]
          earlier?: { before: string; count: number }
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
    update: (id: string, patch: ScheduledJobPatch): Promise<ScheduledJob | null> =>
      ipcRenderer.invoke('scheduled:update', id, patch),
    webhook: {
      enable: (id: string): Promise<ScheduledWebhookGrant> => ipcRenderer.invoke('scheduled:webhook:enable', id),
      rotate: (id: string): Promise<ScheduledWebhookGrant> => ipcRenderer.invoke('scheduled:webhook:rotate', id),
      disable: (id: string): Promise<ScheduledJob> => ipcRenderer.invoke('scheduled:webhook:disable', id),
      deliveries: (id: string): Promise<ScheduledWebhookDeliveryLog> =>
        ipcRenderer.invoke('scheduled:webhook:deliveries', id)
    },
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke('scheduled:delete', id),
    pause: (id: string, reason?: string): Promise<ScheduledJob | null> =>
      ipcRenderer.invoke('scheduled:pause', id, reason),
    resume: (id: string): Promise<ScheduledJob | null> =>
      ipcRenderer.invoke('scheduled:resume', id),
    run: (id: string): Promise<ScheduledJob | null> => ipcRenderer.invoke('scheduled:run', id),
    status: (): Promise<SchedulerStatus> => ipcRenderer.invoke('scheduled:status'),
    extend: (id: string): Promise<ScheduledJob | null> => ipcRenderer.invoke('scheduled:extend', id),
    settings: {
      get: (): Promise<ScheduledSettings> => ipcRenderer.invoke('scheduled:settings:get'),
      set: (update: ScheduledSettingsUpdate): Promise<ScheduledSettings> => ipcRenderer.invoke('scheduled:settings:set', update)
    },
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
    /** "This is me": the code, its status, and the confirmation that stores the owner. */
    owner: {
      start: (platform: ChannelPlatform): Promise<{ code: string; expiresAt: string }> =>
        ipcRenderer.invoke('channels:owner:start', platform),
      status: (platform: ChannelPlatform): Promise<ChannelOwnerClaim | null> =>
        ipcRenderer.invoke('channels:owner:status', platform),
      confirm: (platform: ChannelPlatform, userId: string): Promise<unknown> =>
        ipcRenderer.invoke('channels:owner:confirm', platform, userId),
      cancel: (platform: ChannelPlatform): Promise<void> =>
        ipcRenderer.invoke('channels:owner:cancel', platform),
      clear: (platform: ChannelPlatform): Promise<unknown> =>
        ipcRenderer.invoke('channels:owner:clear', platform)
    },
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
  webTools: {
    getCredentialStatus: (): Promise<{ exa: boolean; parallel: boolean }> =>
      ipcRenderer.invoke('webTools:getCredentialStatus'),
    setApiKey: (service: 'exa' | 'parallel', apiKey: string): Promise<void> =>
      ipcRenderer.invoke('webTools:setApiKey', service, apiKey),
    clearApiKey: (service: 'exa' | 'parallel'): Promise<void> =>
      ipcRenderer.invoke('webTools:clearApiKey', service)
  },
  providers: {
    getUsage: () => ipcRenderer.invoke('providers:getUsage'),
    getSubscriptionUsage: (providerId: string): Promise<string | undefined> =>
      ipcRenderer.invoke('providers:getSubscriptionUsage', providerId),
    onInstallEvent: (cb: (event: CliInstallEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: CliInstallEvent) => cb(event)
      ipcRenderer.on('providers:install:event', handler)
      return () => ipcRenderer.removeListener('providers:install:event', handler)
    },
    openLoginUrl: (url: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('providers:openLoginUrl', url),
    /** What Add provider offers: each option's sign-in methods and the exact `instances.add` input. */
    catalog: {
      addOptions: (): Promise<ProviderAddOption[]> => ipcRenderer.invoke('providers:catalog:addOptions')
    },
    /** Status of every provider instance in `scope` (device, or a project's overrides on top). */
    snapshots: (scope: ProviderScope): Promise<InstanceSnapshot[]> =>
      ipcRenderer.invoke('providers:snapshots', scope),
    /** Pushed on every change; a page showing another scope refetches with `snapshots`. */
    onSnapshots: (cb: (event: ProviderSnapshotsEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ProviderSnapshotsEvent) => cb(event)
      ipcRenderer.on('providers:snapshots', handler)
      return () => ipcRenderer.removeListener('providers:snapshots', handler)
    },
    /** The window reconnected to the service: operations it was running are gone. */
    onServiceRestarted: (cb: () => void): (() => void) => {
      const handler = () => cb()
      ipcRenderer.on('providers:serviceRestarted', handler)
      return () => ipcRenderer.removeListener('providers:serviceRestarted', handler)
    },
    /** Progress, sign-in prompts and the outcome of install, update and sign-in operations. */
    onOperation: (cb: (event: ProviderOperationEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ProviderOperationEvent) => cb(event)
      ipcRenderer.on('providers:operation', handler)
      return () => ipcRenderer.removeListener('providers:operation', handler)
    },
    /**
     * Provider instance commands. Mutations resolve with the instance's snapshot; install, update
     * and sign-in resolve at once with an operation id and report through `onOperation`.
     */
    /** The ACP agent registry ("More ACP agents"): agents that fit this computer, best match first. */
    registry: {
      search: (query: string): Promise<RegistryAgentView[]> => ipcRenderer.invoke('providers:registry:search', query)
    },
    instances: {
      add: (input: AddInstanceInput): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:add', input),
      /** Saves or replaces the instance's key (a model API's shared key); resolves with its snapshot. */
      setSecret: (instanceId: string, value: string): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:setSecret', instanceId, value),
      /** Deletes the instance; the user's own CLI and its sign-in are not touched. */
      remove: (instanceId: string): Promise<void> => ipcRenderer.invoke('providers:instances:remove', instanceId),
      configure: (instanceId: string, patch: InstanceConfigPatch): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:configure', instanceId, patch),
      /** `null` clears a project override; the device scope takes a boolean. */
      setEnabled: (instanceId: string, scope: ProviderScope, enabled: boolean | null): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:setEnabled', instanceId, scope, enabled),
      install: (instanceId: string): Promise<ProviderOperationStarted> =>
        ipcRenderer.invoke('providers:instances:install', instanceId),
      /** Deletes the files Mousse downloaded for it; other entries using them block it unless `force`. */
      removeInstall: (instanceId: string, force = false): Promise<RemoveInstallResult> =>
        ipcRenderer.invoke('providers:instances:removeInstall', instanceId, force),
      /** Cancels a running install or update; false when it is not running. */
      cancelInstall: (operationId: string): Promise<boolean> =>
        ipcRenderer.invoke('providers:instances:cancelInstall', operationId),
      update: (instanceId: string): Promise<ProviderOperationStarted> =>
        ipcRenderer.invoke('providers:instances:update', instanceId),
      signIn: (instanceId: string, method?: string): Promise<ProviderOperationStarted> =>
        ipcRenderer.invoke('providers:instances:signIn', instanceId, method),
      /** Answers a sign-in prompt, or cancels the sign-in with `{ kind: 'cancel' }`. */
      respondSignIn: (operationId: string, response: SignInResponse): Promise<boolean> =>
        ipcRenderer.invoke('providers:instances:respondSignIn', operationId, response),
      signOut: (instanceId: string): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:signOut', instanceId),
      /** "Run anyway with <version>": allows a version with a known problem for the program checked now. */
      allowKnownProblem: (instanceId: string, version: string): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:allowKnownProblem', instanceId, version),
      /** Checks again, bypassing the cached status. */
      recheck: (instanceId: string): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:recheck', instanceId),
      /**
       * Moves a model API entry to the agent that now serves it; lists the defaults rewritten.
       * `copyKey` gives the agent the entry's saved API key.
       */
      move: (instanceId: string, toInstanceId: string, options?: { copyKey?: boolean }): Promise<MoveResult> =>
        ipcRenderer.invoke('providers:instances:move', instanceId, toInstanceId, options),
      refreshModels: (instanceId: string): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:refreshModels', instanceId),
      /** Refreshes every enabled provider's model list; each result carries the new snapshot or why it was skipped or failed. */
      refreshAllModels: (): Promise<ModelRefreshResult[]> =>
        ipcRenderer.invoke('providers:instances:refreshAllModels'),
      /** Each present field replaces the stored one. */
      setModelPrefs: (instanceId: string, patch: ModelPrefsPatch): Promise<InstanceSnapshot> =>
        ipcRenderer.invoke('providers:instances:setModelPrefs', instanceId, patch)
    }
  },
  readAloud: {
    /** Download state of every local text-to-speech model. */
    localModels: (): Promise<LocalTtsModelStatus[]> => ipcRenderer.invoke('readAloud:localModels'),
    /** Downloads a local model from Hugging Face; resolves with its final state. */
    downloadLocalModel: (modelId: LocalTtsModelId): Promise<LocalTtsModelStatus> =>
      ipcRenderer.invoke('readAloud:downloadLocalModel', modelId),
    cancelLocalModelDownload: (modelId: LocalTtsModelId): Promise<void> =>
      ipcRenderer.invoke('readAloud:cancelLocalModelDownload', modelId),
    /** Removes a downloaded local model's files; resolves with its new (not-downloaded) state. */
    deleteLocalModel: (modelId: LocalTtsModelId): Promise<LocalTtsModelStatus> =>
      ipcRenderer.invoke('readAloud:deleteLocalModel', modelId),
    /** Bytes of one file of a downloaded local model. */
    readLocalModelFile: (modelId: LocalTtsModelId, path: string): Promise<Uint8Array> =>
      ipcRenderer.invoke('readAloud:readLocalModelFile', modelId, path),
    /** Speech audio for at most PROVIDER_TTS_MAX_CHARS characters, made with a provider's TTS model. */
    synthesizeWithProvider: (request: ProviderSpeechRequest): Promise<ProviderSpeechResult> =>
      ipcRenderer.invoke('readAloud:synthesizeWithProvider', request),
    onLocalModelStatus: (cb: (status: LocalTtsModelStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: LocalTtsModelStatus) => cb(status)
      ipcRenderer.on('readAloud:localModelStatus', handler)
      return () => ipcRenderer.removeListener('readAloud:localModelStatus', handler)
    }
  },
  dictation: {
    /** Download state of every local speech-to-text model. */
    localModels: (): Promise<LocalSttModelStatus[]> => ipcRenderer.invoke('dictation:localModels'),
    /** Downloads a local model from Hugging Face; resolves with its final state. */
    downloadLocalModel: (modelId: LocalSttModelId): Promise<LocalSttModelStatus> =>
      ipcRenderer.invoke('dictation:downloadLocalModel', modelId),
    cancelLocalModelDownload: (modelId: LocalSttModelId): Promise<void> =>
      ipcRenderer.invoke('dictation:cancelLocalModelDownload', modelId),
    /** Removes a downloaded local model's files; resolves with its new (not-downloaded) state. */
    deleteLocalModel: (modelId: LocalSttModelId): Promise<LocalSttModelStatus> =>
      ipcRenderer.invoke('dictation:deleteLocalModel', modelId),
    /** Bytes of one file of a downloaded local model. */
    readLocalModelFile: (modelId: LocalSttModelId, path: string): Promise<Uint8Array> =>
      ipcRenderer.invoke('dictation:readLocalModelFile', modelId, path),
    /** Transcript of at most PROVIDER_STT_MAX_BYTES of recorded audio, made with a provider's model. */
    transcribeWithProvider: (request: ProviderTranscriptionRequest): Promise<ProviderTranscriptionResult> =>
      ipcRenderer.invoke('dictation:transcribeWithProvider', request),
    onLocalModelStatus: (cb: (status: LocalSttModelStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: LocalSttModelStatus) => cb(status)
      ipcRenderer.on('dictation:localModelStatus', handler)
      return () => ipcRenderer.removeListener('dictation:localModelStatus', handler)
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
  /** Registry commands started outside the renderer: the application menu and keys typed in the browser surface. */
  commands: {
    onRun: (cb: (run: { id: CommandId; source: 'menu' | 'guest' }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, run: { id: CommandId; source: 'menu' | 'guest' }) => cb(run)
      ipcRenderer.on('commands:run', handler)
      return () => ipcRenderer.removeListener('commands:run', handler)
    },
    /** The chords the browser surface forwards to the renderer: binding and the command it runs. */
    setGuestShortcuts: (shortcuts: { binding: string; id: CommandId }[]): Promise<void> =>
      ipcRenderer.invoke('commands:setGuestShortcuts', shortcuts)
  },
  net: {
    /** Network status pushed by the daemon whenever it changes, including its list of phone requests. */
    onUpdated: (cb: (status: NetStatus) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, status: NetStatus) => cb(status)
      ipcRenderer.on('net:updated', handler)
      return () => ipcRenderer.removeListener('net:updated', handler)
    }
  },
  /** In-app updates from GitHub Releases (src/main/updates). */
  updates: {
    getState: (): Promise<UpdateState> => ipcRenderer.invoke(UPDATE_IPC.getState),
    check: (): Promise<UpdateState> => ipcRenderer.invoke(UPDATE_IPC.check),
    download: (): Promise<UpdateState> => ipcRenderer.invoke(UPDATE_IPC.download),
    install: (): Promise<UpdateState> => ipcRenderer.invoke(UPDATE_IPC.install),
    setChannel: (channel: UpdateChannel): Promise<UpdateState> => ipcRenderer.invoke(UPDATE_IPC.setChannel, channel),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, state: UpdateState) => cb(state)
      ipcRenderer.on(UPDATE_IPC.state, handler)
      return () => ipcRenderer.removeListener(UPDATE_IPC.state, handler)
    }
  },
  mousseId: {
    /** Runtime service origin from `MOUSSE_ID_ORIGIN`; empty when unset. */
    config: (): Promise<{ origin: string }> => ipcRenderer.invoke('mousseId:config'),
    /** Starts a one-shot loopback listener for the approval page to return to. */
    startCallback: (): Promise<{ id: string; url: string }> => ipcRenderer.invoke('mousseId:callback.start'),
    waitCallback: (id: string): Promise<'approved' | 'denied' | 'cancelled' | 'expired'> =>
      ipcRenderer.invoke('mousseId:callback.wait', id),
    cancelCallback: (id: string): Promise<void> => ipcRenderer.invoke('mousseId:callback.cancel', id)
  },
  profiles: {
    list: (): Promise<{ defaultProfileId: string; profiles: ProfilePublicDto[] }> =>
      ipcRenderer.invoke('profiles:list'),
    status: (): Promise<{ defaultProfileId: string; activeCount: number; binding: { profileId: string; epoch: number } | null }> =>
      ipcRenderer.invoke('profiles:status'),
    bind: (profile: string): Promise<{ profile: ProfilePublicDto; epoch: number }> =>
      ipcRenderer.invoke('profiles:bind', profile),
    create: (input: ProfileCreateInput): Promise<{ profile: ProfilePublicDto }> =>
      ipcRenderer.invoke('profiles:create', input),
    update: (profileId: string, expectedRevision: number, patch: ProfileUpdateInput): Promise<{ profile: ProfilePublicDto }> =>
      ipcRenderer.invoke('profiles:update', { profileId, expectedRevision, ...patch }),
    archive: (profileId: string, expectedRevision: number): Promise<{ profile: ProfilePublicDto }> =>
      ipcRenderer.invoke('profiles:archive', { profileId, expectedRevision }),
    restore: (profileId: string, expectedRevision: number): Promise<{ profile: ProfilePublicDto }> =>
      ipcRenderer.invoke('profiles:restore', { profileId, expectedRevision }),
    removePreview: (profileId: string): Promise<unknown> =>
      ipcRenderer.invoke('profiles:removePreview', profileId),
    remove: (profileId: string, expectedRevision: number): Promise<unknown> =>
      ipcRenderer.invoke('profiles:remove', { profileId, expectedRevision })
  },
  clipboard: {
    showCopyMenu: (x: number, y: number, text: string): Promise<void> =>
      ipcRenderer.invoke('clipboard:showCopyMenu', x, y, text)
  },
  dialog: {
    /** Native open-file dialog; resolves to the chosen absolute path, or null when cancelled. */
    pickExecutable: (options?: { title?: string; defaultPath?: string }): Promise<string | null> =>
      ipcRenderer.invoke('dialog:pickExecutable', options ?? {})
  },
  window: {
    resizeStart: (edge: WindowResizeEdge, pointerId: number): Promise<boolean> => ipcRenderer.invoke('window:resizeStart', edge, pointerId),
    resizeMove: (pointerId: number): Promise<void> => ipcRenderer.invoke('window:resizeMove', pointerId),
    resizeEnd: (pointerId: number): Promise<void> => ipcRenderer.invoke('window:resizeEnd', pointerId),
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
