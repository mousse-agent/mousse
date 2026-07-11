import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { homedir } from 'os'
import { AgentRegistry } from '../../mms/agents/AgentRegistry'
import { TaskQueue } from '../../mms/tasks/TaskQueue'
import { WorktreeManager } from '../../mms/worktree/WorktreeManager'
import { PtyManager } from '../../mms/terminals/PtyManager'
import { MacroEngine } from '../../mms/macros/MacroEngine'
import { OrchestratorService } from '../../mms/orchestrator/OrchestratorService'
import { SettingsStore } from '../../mms/settings/SettingsStore'
import { ProjectManager } from '../../mms/data/ProjectManager'
import { ThreadDataStore } from '../../mms/data/ThreadDataStore'
import { ThreadContext } from '../data/ThreadContext'
import { resolveActiveProjectPath } from '../../mms/data/resolveActiveProjectPath'
import {
  ACCENT_COLORS,
  AGENT_TYPES,
  THEME_OPTIONS,
  themeUsesAcrylic,
  type MousseSettings,
  type MousseSettingsUpdate
} from '../../shared/settings'
import { showCopyMenu } from '../contextMenu'
import { threadActivityTracker } from '../data/ThreadActivityTracker'
import { NotificationService } from '../notifications/NotificationService'
import { userQuestionService } from '../../mms/orchestrator/UserQuestionService'
import { ProviderAuthService } from '../../mms/providers/ProviderAuthService'
import { getPiLlmProviders } from '../../mms/orchestrator/piProviders'
import type { ProviderLoginEvent, ProviderLoginResponse } from '../../shared/providerAuth'
import {
  attachWindowStateListeners,
  beginWindowDrag,
  endWindowDrag,
  isWindowZoomed,
  toggleWindowZoom,
  updateWindowDrag,
  type WindowDragPoint
} from '../windowState'
import { refreshWindowChrome } from '../windowsChrome'
import { applyWindowMaterial, attachWindowFocusListeners } from '../windowMaterial'
import { buildAccentCssVars, surfaceToWindowBackground } from '../../shared/accentPalette'
import { closeAgentsTasksWindow, openAgentsTasksWindow } from '../agentsTasksWindow'
import type { MainView } from '../../shared/types'
import type { McpManager } from '../../mms/integrations/mcp/McpManager'
import type { McpRegistry } from '../../mms/integrations/mcp/McpRegistry'
import type { SkillsRegistry } from '../../mms/integrations/skills/SkillsRegistry'
import { FileService } from '../../mms/files/FileService'
import { GitService } from '../../mms/git/GitService'
import { BrowserViewManager } from '../browser/BrowserViewManager'
import type { ScheduledJobService } from '../../mms/scheduled/ScheduledJobService'
import type { LineEditStatsStore } from '../../mms/stats/LineEditStatsStore'
import type { ChannelService } from '../../mms/channels/ChannelService'
import type {
  BrowserBounds,
  ChannelActivityEvent,
  ChannelConfig,
  ChannelPlatform,
  ChannelsSnapshot,
  CreateScheduledJobInput,
  OrchestratorContextUsageInput,
  OrchestratorSendInput,
  PtyCreateRequest,
  ScheduledJob,
  ThreadActivityState,
  UserQuestionAnswers
} from '../../shared/types'

function applyWindowAccentBackground(
  win: BrowserWindow | null | undefined,
  settings: MousseSettings
): void {
  if (!win || win.isDestroyed()) return
  const surfaceBase = buildAccentCssVars(settings.appearance.accentColor)['--surface-base']
  if (!surfaceBase) return
  win.setBackgroundColor(
    surfaceToWindowBackground(surfaceBase, themeUsesAcrylic(settings.appearance.theme) ? 0 : 1)
  )
}

export interface AppServices {
  agents: AgentRegistry
  tasks: TaskQueue
  worktrees: WorktreeManager
  ptyManager: PtyManager
  macros: MacroEngine
  orchestrator: OrchestratorService
  settings: SettingsStore
  providerAuth: ProviderAuthService
  projectManager: ProjectManager
  threadStore: ThreadDataStore
  threadContext: ThreadContext
  mcpRegistry: McpRegistry
  mcpManager: McpManager
  skillsRegistry: SkillsRegistry
  fileService: FileService
  gitService: GitService
  browserView: BrowserViewManager
  scheduledJobs: ScheduledJobService
  lineEditStats: LineEditStatsStore
  channels: ChannelService
}

function registerHandler(
  channel: string,
  handler: Parameters<typeof ipcMain.handle>[1]
): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, handler)
}

export function registerIpc(services: AppServices, getWindow: () => BrowserWindow | null): void {
  const {
    agents,
    tasks,
    ptyManager,
    orchestrator,
    settings,
    providerAuth,
    projectManager,
    threadStore,
    threadContext,
    mcpRegistry,
    mcpManager,
    skillsRegistry,
    fileService,
    gitService,
    browserView,
    scheduledJobs,
    lineEditStats,
    channels
  } = services

  const resolveSelectedProjectPath = (
    projectId?: string,
    threadId?: string | null
  ): string | undefined => {
    if (projectId) return projectManager.getProject(projectId)?.path
    const effectiveThreadId = threadId ?? threadContext.getActiveThreadId()
    return resolveActiveProjectPath(projectManager, threadStore, effectiveThreadId)
  }

  const resolveProjectPath = (projectId?: string, threadId?: string | null): string | undefined => {
    const selected = resolveSelectedProjectPath(projectId, threadId)
    if (selected) return selected
    if (!app.isPackaged) return services.worktrees.getRepoRoot()
    return undefined
  }

  const resolveFilesRoot = (projectId?: string, threadId?: string | null): string => {
    return resolveSelectedProjectPath(projectId, threadId) ?? homedir()
  }

  const requireSelectedProjectPath = (projectId?: string): string => {
    const path = resolveSelectedProjectPath(projectId)
    if (!path) throw new Error('No project selected')
    return path
  }

  browserView.init(getWindow, (state) => broadcast('browser:state', state))

  const broadcast = (channel: string, data: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, data)
      }
    }
  }

  const notificationService = new NotificationService(getWindow, threadStore, threadContext)

  const broadcastThreadActivity = (): void => {
    broadcast('threads:activity', threadActivityTracker.getSnapshot())
  }

  const setThreadActivity = (threadId: string, state: ThreadActivityState): void => {
    threadActivityTracker.setState(threadId, state)
    broadcastThreadActivity()
  }

  agents.on('updated', (list) => broadcast('agents:updated', list))
  tasks.on('updated', (list) => broadcast('tasks:updated', list))

  orchestrator.on('message', (msg) => broadcast('orchestrator:message', msg))
  orchestrator.on('message-updated', (msg) => broadcast('orchestrator:message-updated', msg))
  orchestrator.on('messages-sync', (messages) => broadcast('orchestrator:messages', messages))
  orchestrator.on('response', (resp) => broadcast('orchestrator:response', resp))
  orchestrator.on('agent-spawned', (agent) => broadcast('agent:spawned', agent))
  orchestrator.on('terminal-activated', (payload) => broadcast('pty:activated', payload))
  orchestrator.on('agent-activated', (payload) => broadcast('agent:activated', payload))
  orchestrator.on('document-opened', (payload) => broadcast('document:opened', payload))
  orchestrator.on('mousse-agent-message', (payload) => broadcast('mousse-agent:message', payload))
  orchestrator.on('mousse-agent-message-updated', (payload) =>
    broadcast('mousse-agent:message-updated', payload)
  )
  orchestrator.on('mousse-agent-messages-sync', (payload) =>
    broadcast('mousse-agent:messages-sync', payload)
  )
  orchestrator.on('mousse-agent-complete', (payload) => broadcast('mousse-agent:complete', payload))

  userQuestionService.on('pending', (payload) => {
    broadcast('orchestrator:questionsPending', payload)
    const busyThreadId = threadActivityTracker.getBusyThreadId()
    if (busyThreadId) {
      setThreadActivity(busyThreadId, 'awaiting_input')
      notificationService.notifyThread(
        busyThreadId,
        'question',
        threadContext.getActiveThreadId()
      )
    }
  })

  registerHandler('orchestrator:send', async (_e, request: OrchestratorSendInput) => {
    const threadId = threadContext.getActiveThreadId()
    if (threadId) {
      threadActivityTracker.setBusyThreadId(threadId)
      setThreadActivity(threadId, 'processing')
    }
    try {
      const result = await orchestrator.send(request)
      if (threadId) {
        setThreadActivity(threadId, 'completed')
        notificationService.notifyThread(threadId, 'completed', threadContext.getActiveThreadId())
      }
      return result
    } catch (err) {
      if (threadId) {
        setThreadActivity(threadId, 'idle')
        threadActivityTracker.setBusyThreadId(null)
      }
      throw err
    } finally {
      threadActivityTracker.setBusyThreadId(null)
    }
  })

  registerHandler('orchestrator:getMessages', () => {
    return orchestrator.getMessages()
  })

  registerHandler('orchestrator:getContextUsage', (_e, request?: OrchestratorContextUsageInput) => {
    return orchestrator.getContextUsage(request ?? '')
  })

  registerHandler('orchestrator:answerQuestions', (_e, requestId: string, answers: UserQuestionAnswers) => {
    const result = userQuestionService.submitAnswers(requestId, answers)
    const busyThreadId = threadActivityTracker.getBusyThreadId()
    if (result && busyThreadId) {
      setThreadActivity(busyThreadId, 'processing')
    }
    return result
  })

  registerHandler('orchestrator:dismissQuestions', (_e, requestId: string) => {
    return userQuestionService.dismiss(requestId)
  })

  registerHandler('mousseAgent:getMessages', (_e, agentId: string) => {
    return orchestrator.getMousseAgentMessages(agentId)
  })

  registerHandler('mousseAgent:send', (_e, agentId: string, content: string) => {
    orchestrator.sendMousseAgentMessage(agentId, content)
  })

  registerHandler('agents:list', () => agents.list())
  registerHandler('tasks:list', () => tasks.list())

  registerHandler('pty:write', (_e, ptyId: string, data: string) => {
    ptyManager.write(ptyId, data)
  })

  registerHandler('pty:resize', (_e, ptyId: string, cols: number, rows: number) => {
    ptyManager.resize(ptyId, cols, rows)
  })

  registerHandler('pty:list', () => ptyManager.list())

  registerHandler('pty:create', (_e, request: PtyCreateRequest) => {
    const cwd = request.cwd || resolveProjectPath() || homedir()
    const ptyId = ptyManager.create(request.agentId, cwd, request.command, {
      env: request.env,
      shellArgs: request.shellArgs
    })
    return { ptyId }
  })

  registerHandler('pty:kill', (_e, ptyId: string) => {
    ptyManager.kill(ptyId)
  })

  registerHandler('app:getInfo', () => ({
    platform: process.platform,
    repoRoot: services.worktrees.getRepoRoot(),
    macroProviders: services.macros.listProviders(),
    llmProvider: settings.get().provider.llmProvider
  }))

  registerHandler('app:getActiveProjectPath', (_e, threadId?: string | null) =>
    resolveSelectedProjectPath(undefined, threadId) ?? null
  )

  registerHandler('app:getFilesRoot', (_e, threadId?: string | null) =>
    resolveFilesRoot(undefined, threadId)
  )

  registerHandler('fs:listDir', async (_e, dirPath?: string, projectId?: string) => {
    const root = resolveFilesRoot(projectId)
    return fileService.listDir(root, dirPath ?? '')
  })

  registerHandler('fs:readFile', async (_e, filePath: string, projectId?: string) => {
    const root = resolveFilesRoot(projectId)
    return fileService.readFile(root, filePath)
  })

  registerHandler('fs:writeFile', async (_e, filePath: string, content: string, projectId?: string) => {
    const root = resolveFilesRoot(projectId)
    const lines = await fileService.writeFile(root, filePath, content)
    lineEditStats.record('manual', lines)
  })

  registerHandler('fs:stat', async (_e, targetPath: string, projectId?: string) => {
    const root = resolveFilesRoot(projectId)
    return fileService.stat(root, targetPath)
  })

  const resolveGitCwd = (projectId?: string, cwd?: string): string => {
    if (cwd) return cwd
    return resolveProjectPath(projectId) ?? homedir()
  }

  registerHandler('git:status', async (_e, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    return gitService.getStatus(root)
  })

  registerHandler('git:diff', async (_e, filePath: string, staged: boolean, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    return gitService.getDiff(root, filePath, staged)
  })

  registerHandler('git:log', async (_e, limit?: number, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    return gitService.getLog(root, limit)
  })

  registerHandler('git:branches', async (_e, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    return gitService.getBranches(root)
  })

  registerHandler('git:diffStats', async (_e, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    return gitService.getDiffStats(root)
  })

  registerHandler('git:checkout', async (_e, branch: string, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    await gitService.checkout(root, branch)
  })

  registerHandler('git:commit', async (_e, message: string, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    await gitService.commit(root, message)
  })

  registerHandler('git:push', async (_e, projectId?: string, cwd?: string) => {
    const root = resolveGitCwd(projectId, cwd)
    await gitService.push(root)
  })

  registerHandler('browser:navigate', (_e, url: string) => {
    browserView.navigate(url)
    return browserView.getState()
  })

  registerHandler('browser:goBack', () => {
    browserView.goBack()
    return browserView.getState()
  })

  registerHandler('browser:goForward', () => {
    browserView.goForward()
    return browserView.getState()
  })

  registerHandler('browser:reload', () => {
    browserView.reload()
    return browserView.getState()
  })

  registerHandler('browser:getState', () => browserView.getState())

  registerHandler('browser:setVisible', (_e, visible: boolean) => {
    browserView.setVisible(visible)
  })

  registerHandler('browser:setBounds', (_e, bounds: BrowserBounds) => {
    browserView.setBounds(bounds)
  })

  registerHandler('settings:get', () => settings.get())

  registerHandler('settings:set', (_e, partial: MousseSettingsUpdate) => {
    const updated = settings.set(partial)
    applyWindowAccentBackground(getWindow(), updated)
    broadcast('settings:changed', updated)
    return updated
  })

  registerHandler('settings:getOptions', () => ({
    themes: THEME_OPTIONS,
    accentColors: ACCENT_COLORS,
    llmProviders: getPiLlmProviders(providerAuth),
    agentTypes: AGENT_TYPES
  }))

  registerHandler('lineEdits:getStats', () => lineEditStats.getSnapshot())

  lineEditStats.on('updated', (snapshot) => broadcast('lineEdits:updated', snapshot))

  registerHandler('mcp:listServers', async (_e, projectId?: string) => {
    const snapshot = await mcpRegistry.discover({
      projectPath: resolveProjectPath(projectId),
      redactSecrets: true
    })
    return snapshot.servers
  })

  registerHandler('mcp:listTools', (_e, serverId: string, projectId?: string) =>
    mcpManager.listTools(serverId, resolveProjectPath(projectId))
  )

  registerHandler('mcp:testServer', (_e, serverId: string, projectId?: string) =>
    mcpManager.testServer(serverId, resolveProjectPath(projectId))
  )

  registerHandler('mcp:authenticate', (_e, serverId: string, projectId?: string) =>
    mcpManager.authenticateServer(serverId, resolveProjectPath(projectId))
  )

  registerHandler('mcp:restartServer', async (_e, serverId: string) => {
    await mcpManager.restartServer(serverId)
    broadcast('mcp:changed', null)
  })

  registerHandler('mcp:getConfigSources', async (_e, projectId?: string) => {
    const snapshot = await mcpRegistry.discover({
      projectPath: resolveProjectPath(projectId),
      redactSecrets: true
    })
    return snapshot.sources
  })

  registerHandler(
    'mcp:writeCursorConfig',
    async (_e, scope: 'global' | 'project', patch: Record<string, unknown>, projectId?: string) => {
      await mcpRegistry.writeCursorMcpConfig(scope, patch, resolveProjectPath(projectId))
      broadcast('mcp:changed', null)
    }
  )

  registerHandler('mcp:openConfig', async (_e, scope: 'global' | 'project', projectId?: string) => {
    const sources = (await mcpRegistry.discover({
      projectPath: resolveProjectPath(projectId),
      redactSecrets: true
    })).sources
    const source = sources.find((entry) =>
      scope === 'global' ? entry.source === 'cursor-global' : entry.source === 'cursor-project'
    )
    return source ? shell.openPath(source.path) : 'Config source not found.'
  })

  registerHandler('skills:list', (_e, projectId?: string) =>
    skillsRegistry.discover({ projectPath: resolveProjectPath(projectId) })
  )

  registerHandler('skills:read', (_e, skillId: string, projectId?: string) =>
    skillsRegistry.readSkill(skillId, { projectPath: resolveProjectPath(projectId) })
  )

  registerHandler('skills:refresh', async (_e, projectId?: string) => {
    const snapshot = await skillsRegistry.discover({ projectPath: resolveProjectPath(projectId) })
    broadcast('skills:changed', snapshot)
    return snapshot
  })

  registerHandler('skills:openFolder', async (_e, scope: 'global' | 'project', projectId?: string) => {
    const snapshot = await skillsRegistry.discover({ projectPath: resolveProjectPath(projectId) })
    const source = snapshot.sources.find((entry) => entry.scope === scope)
    return source ? shell.openPath(source.path) : 'Skills root not found.'
  })

  registerHandler('providers:listConfigured', () => providerAuth.getConfiguredProviders())

  registerHandler('providers:getLoginOptions', (_e, authType?: 'api_key' | 'oauth') =>
    providerAuth.getLoginOptions(authType)
  )

  registerHandler('providers:getAmbientInfo', (_e, providerId: string) =>
    providerAuth.getAmbientProviderInfo(providerId)
  )

  registerHandler('providers:setApiKey', async (_e, providerId: string, apiKey: string) => {
    await providerAuth.setApiKey(providerId, apiKey)
    broadcast('providers:changed', providerAuth.getConfiguredProviders())
  })

  registerHandler('providers:verifyAmbient', async (_e, providerId: string) => {
    const result = await providerAuth.verifyAmbientProvider(providerId)
    if (result.success) {
      broadcast('providers:changed', providerAuth.getConfiguredProviders())
    }
    return result
  })

  registerHandler('providers:logout', async (_e, providerId: string) => {
    await providerAuth.logout(providerId)
    broadcast('providers:changed', providerAuth.getConfiguredProviders())
  })

  registerHandler('providers:login:respond', (_e, response: ProviderLoginResponse) => {
    providerAuth.getSession(response.sessionId)?.respond(response)
  })

  registerHandler('providers:login:cancel', (_e, sessionId: string) => {
    providerAuth.endSession(sessionId)
  })

  registerHandler('providers:loginOAuth', async (_e, providerId: string) => {
    const session = providerAuth.createSession()
    const send = (event: ProviderLoginEvent) => broadcast('providers:login:event', event)
    session.on('event', send)
    try {
      const result = await providerAuth.runOAuthLogin(session, providerId)
      if (result.success) {
        broadcast('providers:changed', providerAuth.getConfiguredProviders())
      }
      return result
    } finally {
      session.off('event', send)
      providerAuth.endSession(session.sessionId)
    }
  })

  registerHandler('providers:loginApiKey', async (_e, providerId: string) => {
    const session = providerAuth.createSession()
    const send = (event: ProviderLoginEvent) => broadcast('providers:login:event', event)
    session.on('event', send)
    try {
      const result = await providerAuth.runApiKeyLogin(session, providerId)
      if (result.success) {
        broadcast('providers:changed', providerAuth.getConfiguredProviders())
      }
      return result
    } finally {
      session.off('event', send)
      providerAuth.endSession(session.sessionId)
    }
  })

  registerHandler('app:restart', () => {
    app.relaunch()
    app.quit()
  })

  registerHandler('projects:list', () => projectManager.listProjects())

  registerHandler('projects:open', async () => {
    const win = getWindow()
    const result = win
      ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
      : await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    const project = projectManager.openProject(result.filePaths[0])
    broadcast('projects:updated', projectManager.listProjects())
    broadcast('threads:updated', threadStore.listAllThreads())
    return project
  })

  registerHandler('projects:remove', (_e, projectId: string) => {
    projectManager.removeProject(projectId)
    broadcast('projects:updated', projectManager.listProjects())
  })

  registerHandler('projects:rename', (_e, projectId: string, name: string) => {
    const project = projectManager.renameProject(projectId, name)
    broadcast('projects:updated', projectManager.listProjects())
    return project
  })

  registerHandler('projects:pin', (_e, projectId: string, pinned: boolean) => {
    const project = projectManager.setProjectPinned(projectId, pinned)
    broadcast('projects:updated', projectManager.listProjects())
    return project
  })

  registerHandler('projects:threads', (_e, projectId: string) => {
    return projectManager.listProjectThreads(projectId)
  })

  registerHandler('threads:list', () => threadStore.listThreads())

  registerHandler('threads:listAll', () => threadStore.listAllThreads())

  registerHandler('threads:active', () => threadContext.getActiveThreadId())

  registerHandler('threads:activity', () => threadActivityTracker.getSnapshot())

  registerHandler('threads:create', (_e, name?: string, projectId?: string) => {
    const thread = threadContext.createThread(name?.trim() || 'New Thread', projectId)
    return thread
  })

  registerHandler('threads:select', async (_e, threadId: string) => {
    setThreadActivity(threadId, 'idle')
    await threadContext.switchThread(threadId)
  })

  registerHandler('threads:delete', async (_e, threadId: string) => {
    await threadContext.deleteThread(threadId)
  })

  registerHandler('threads:rename', (_e, threadId: string, name: string) => {
    return threadContext.renameThread(threadId, name)
  })

  registerHandler('threads:pin', (_e, threadId: string, pinned: boolean) => {
    const thread = threadStore.setThreadPinned(threadId, pinned)
    broadcast('threads:updated', threadStore.listAllThreads())
    return thread
  })

  registerHandler('threads:search', (_e, query: string, limit?: number) => {
    return threadStore.searchThreads(query, limit)
  })

  scheduledJobs.on('updated', (jobs) => broadcast('scheduled:updated', jobs))
  scheduledJobs.on('status', (status) => broadcast('scheduled:status', status))

  registerHandler('scheduled:list', () => scheduledJobs.listJobs())
  registerHandler('scheduled:get', (_e, id: string) => scheduledJobs.getJob(id))
  registerHandler('scheduled:create', (_e, input: CreateScheduledJobInput) =>
    scheduledJobs.createJob(input)
  )
  registerHandler('scheduled:update', (_e, id: string, patch: Partial<ScheduledJob>) =>
    scheduledJobs.updateJob(id, patch)
  )
  registerHandler('scheduled:delete', (_e, id: string) => scheduledJobs.deleteJob(id))
  registerHandler('scheduled:pause', (_e, id: string, reason?: string) =>
    scheduledJobs.pauseJob(id, reason)
  )
  registerHandler('scheduled:resume', (_e, id: string) => scheduledJobs.resumeJob(id))
  registerHandler('scheduled:run', (_e, id: string) => scheduledJobs.triggerJob(id))
  registerHandler('scheduled:status', () => scheduledJobs.getStatus())

  channels.on('updated', (snapshot: ChannelsSnapshot) => broadcast('channels:updated', snapshot))
  channels.on('activity', (event: ChannelActivityEvent) => broadcast('channels:activity', event))

  registerHandler('channels:getSnapshot', () => channels.getSnapshot())
  registerHandler('channels:getConfig', () => channels.getConfig())
  registerHandler('channels:updateConfig', (_e, patch: Partial<ChannelConfig>) =>
    channels.updateConfig(patch)
  )
  registerHandler('channels:connect', (_e, platform?: ChannelPlatform) => channels.connect(platform))
  registerHandler('channels:disconnect', (_e, platform?: ChannelPlatform) =>
    channels.disconnect(platform)
  )
  registerHandler('channels:listPairingRequests', () => channels.listPairingRequests())
  registerHandler('channels:approvePairing', (_e, code: string) => channels.approvePairing(code))
  registerHandler('channels:rejectPairing', (_e, code: string) => channels.rejectPairing(code))
  registerHandler(
    'channels:sendTest',
    (_e, platform: ChannelPlatform, chatId: string, text: string, threadId?: string) =>
      channels.sendTest(platform, chatId, text, threadId)
  )
  registerHandler('channels:getActivity', (_e, limit?: number) => channels.getRecentActivity(limit))

  registerHandler('window:syncBackground', (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win || win.isDestroyed()) return false
    return applyWindowMaterial(win, settings)
  })

  registerHandler('app:navigateMainView', (_e, view: MainView) => {
    broadcast('app:navigateMainView', view)
  })

  registerHandler('window:focusMain', () => {
    closeAgentsTasksWindow()
    const win = getWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  registerHandler('window:closeAgentsTasks', () => {
    closeAgentsTasksWindow()
  })

  registerHandler('window:openAgentsTasks', (e, anchor?: { x: number; y: number }) => {
    openAgentsTasksWindow(settings, BrowserWindow.fromWebContents(e.sender) ?? getWindow() ?? undefined, anchor)
  })

  registerHandler('window:minimize', () => {
    getWindow()?.minimize()
  })

  registerHandler('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    toggleWindowZoom(win, settings)
  })

  registerHandler('window:dragStart', (_e, point: WindowDragPoint) => {
    const win = getWindow()
    if (!win) return
    beginWindowDrag(win, settings, point)
  })

  registerHandler('window:dragMove', (_e, point: WindowDragPoint) => {
    const win = getWindow()
    if (!win) return
    updateWindowDrag(win, settings, point)
  })

  registerHandler('window:dragEnd', () => {
    const win = getWindow()
    if (!win) return
    endWindowDrag(win, settings)
  })

  registerHandler('window:close', () => {
    getWindow()?.close()
  })

  registerHandler('window:isMaximized', () => {
    const win = getWindow()
    return win ? isWindowZoomed(win) : false
  })

  registerHandler('clipboard:showCopyMenu', (_e, x: number, y: number, text: string) => {
    showCopyMenu(getWindow, x, y, text)
  })
}

export function attachWindowListeners(
  getWindow: () => BrowserWindow | null,
  settings: SettingsStore
): void {
  attachWindowStateListeners(getWindow, settings)
  attachWindowFocusListeners(getWindow, settings)
}
