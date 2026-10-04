import { useEffect, useState } from 'react'
import { CheckSquare, Loader2, Square, SquareX, X } from '../lib/icons'
import { IconButton } from './IconButton'
import { confirmStopAgent } from '../lib/confirmStopAgent'
import { isTerminalAgentStatus, type Agent, type MousseAgentAssignment, type Task, type TaskStatus } from '../../shared/types'
import { buildAgentTypesFromCatalogs, type AgentTypeId, type LlmProviderOption, type MousseSettings } from '../../shared/settings'
import { formatWorkedFor } from '../utils/responseTimeline'
import { resolveMousseAgentModelSelection } from '../utils/agentChatMessages'
import { getGroupedModelButtonParts } from './ModelFamilyMenu'
import { ProviderIcon } from '../lib/providerIcons'
import { useAppStore } from '../stores/appStore'

function StatusBadge({ status, startupPhase }: { status: string; startupPhase?: Agent['startupPhase'] }) {
  const label = status === 'starting' && startupPhase ? startupPhase : status
  return <span className={`status-badge status-${status}`}>{label.replace('_', ' ')}</span>
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  const className = `agents-tasks-task-icon agents-tasks-task-icon-${status}`

  switch (status) {
    case 'completed':
      return <CheckSquare size={16} strokeWidth={2} className={className} aria-hidden="true" />
    case 'in_progress':
      return <Loader2 size={16} strokeWidth={2} className={`${className} agents-tasks-task-icon-spin`} aria-hidden="true" />
    case 'failed':
    case 'cancelled':
    case 'interrupted':
      return <SquareX size={16} strokeWidth={2} className={className} aria-hidden="true" />
    default:
      return <Square size={16} strokeWidth={2} className={className} aria-hidden="true" />
  }
}

function agentWorkedLabel(agent: Agent, now: number, rememberedEnd?: string): string {
  const started = Date.parse(agent.createdAt)
  if (!Number.isFinite(started)) return ''
  const working = agent.status === 'starting' || agent.status === 'running'
  const endSource = working ? undefined : agent.idleAt ?? agent.exitedAt ?? rememberedEnd
  const ended = endSource ? Date.parse(endSource) : working ? now : Number.NaN
  if (!Number.isFinite(ended)) return ''
  return formatWorkedFor(Math.max(0, ended - started))
}

interface AgentModelMark {
  providerId: string
  providerLabel: string
  modelLabel: string
}

function cliProviderId(cliType: string, modelId: string): string {
  if (cliType === 'claude-code') return 'anthropic'
  if (cliType === 'codex') return 'openai'
  if (cliType === 'cursor-agents-cli') return 'cursor'
  if (cliType === 'opencode') return modelId.startsWith('opencode-go/') ? 'opencode-go' : 'opencode'
  return cliType
}

function modelMark(
  providerId: string,
  modelId: string,
  providers: LlmProviderOption[]
): AgentModelMark {
  const provider = providers.find((entry) => entry.id === providerId)
  const parts = getGroupedModelButtonParts(providerId, modelId, providers)
    .filter((part) => part && part !== 'Select model')
  return {
    providerId: providerId || 'mousse',
    providerLabel: provider?.label || providerId,
    modelLabel: parts.join(' · ') || modelId || provider?.label || 'Model'
  }
}

function describeSubagentModel(
  agent: Agent,
  assignment: MousseAgentAssignment | undefined,
  settings: MousseSettings,
  providers: LlmProviderOption[]
): AgentModelMark {
  if (agent.cliType === 'mousse') {
    const selected = resolveMousseAgentModelSelection(assignment, {
      provider: settings.agents.llmProvider.mousse || settings.provider.llmProvider,
      model: settings.agents.model.mousse || settings.provider.model
    })
    return modelMark(selected.provider, selected.model, providers)
  }
  const cliType = agent.cliType as AgentTypeId
  const modelId = settings.agents.model[cliType] || ''
  const providerId = cliProviderId(agent.cliType, modelId)
  const catalogModel = buildAgentTypesFromCatalogs(providers)
    .find((entry) => entry.id === cliType)
    ?.models.find((entry) => entry.id === modelId)
  const mark = modelMark(providerId, catalogModel?.id || modelId, providers)
  if (catalogModel?.label) mark.modelLabel = catalogModel.label
  return mark
}

function AgentModelBadge({ mark }: { mark: AgentModelMark }) {
  return (
    <span className="agents-tasks-model" title={`${mark.providerLabel} · ${mark.modelLabel}`}>
      <ProviderIcon providerId={mark.providerId} size={16} />
      <span className="agents-tasks-model-name">{mark.modelLabel}</span>
      <span className="agents-tasks-model-provider">{mark.providerLabel}</span>
    </span>
  )
}

function taskStatusLabel(status: TaskStatus): string {
  switch (status) {
    case 'completed':
      return 'Completed'
    case 'in_progress':
      return 'In progress'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'interrupted':
      return 'Interrupted'
    default:
      return 'Pending'
  }
}

export function AgentsTasksView({ variant = 'window' }: { variant?: 'window' | 'panel' }) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [stoppingAgentIds, setStoppingAgentIds] = useState<Set<string>>(() => new Set())
  const [now, setNow] = useState(() => Date.now())
  const [rememberedEnds, setRememberedEnds] = useState<Record<string, string>>({})
  const [providers, setProviders] = useState<LlmProviderOption[]>([])
  const [settings, setSettings] = useState<MousseSettings | null>(null)
  const [assignments, setAssignments] = useState<Record<string, MousseAgentAssignment | undefined>>({})
  const assignmentKey = agents.map((agent) => `${agent.id}:${agent.cliType}`).join('\n')
  const centerAgentId = useAppStore((state) => state.centerAgentId)
  const setCenterAgentId = useAppStore((state) => state.setCenterAgentId)
  const setThreadsSidebarOpen = useAppStore((state) => state.setThreadsSidebarOpen)
  const mainAgentName = useAppStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.name)
  const mainModelOverride = useAppStore((state) => state.threads.find((thread) => thread.id === state.activeThreadId)?.modelOverride)
  const mainMark = settings
    ? modelMark(
      mainModelOverride?.llmProvider || settings.provider.llmProvider,
      mainModelOverride?.model || settings.provider.model,
      providers
    )
    : null

  useEffect(() => {
    let agentRevision = 0
    let taskRevision = 0

    const unsubs = [
      window.mousse.agents.onUpdated((next) => {
        agentRevision += 1
        setAgents(next)
      }),
      window.mousse.tasks.onUpdated((next) => {
        taskRevision += 1
        setTasks(next)
      }),
      // Reconnect publishes an authoritative combined thread snapshot. The popup used
      // to ignore it, so an initial list request lost during an outage left it empty.
      window.mousse.threads.onView((view) => {
        agentRevision += 1
        taskRevision += 1
        setAgents(view.agents)
        setTasks(view.tasks)
      })
    ]

    const requestedAgentRevision = agentRevision
    void window.mousse.agents.list().then((next) => {
      if (agentRevision === requestedAgentRevision) setAgents(next)
    }).catch(() => {})
    const requestedTaskRevision = taskRevision
    void window.mousse.tasks.list().then((next) => {
      if (taskRevision === requestedTaskRevision) setTasks(next)
    }).catch(() => {})

    return () => unsubs.forEach((u) => u())
  }, [])

  useEffect(() => {
    let cancelled = false
    void Promise.all([window.mousse.settings.getOptions(), window.mousse.settings.get()]).then(([options, nextSettings]) => {
      if (cancelled) return
      setProviders(options.llmProviders)
      setSettings(nextSettings)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const listed = agents
    let cancelled = false
    void Promise.all(listed.map(async (agent) => {
      if (agent.cliType !== 'mousse') return [agent.id, undefined] as const
      const assignment = await window.mousse.mousseAgent.getAssignment(agent.id).catch(() => undefined)
      return [agent.id, assignment] as const
    })).then((pairs) => {
      if (cancelled) return
      setAssignments(Object.fromEntries(pairs))
    })
    return () => { cancelled = true }
  }, [assignmentKey])

  useEffect(() => {
    const settledWithoutEnd = agents.filter((agent) =>
      agent.status !== 'starting' && agent.status !== 'running' && !agent.idleAt && !agent.exitedAt
    )
    if (settledWithoutEnd.length === 0) return
    let cancelled = false
    void Promise.all(settledWithoutEnd.map(async (agent) => {
      const messages = await window.mousse.mousseAgent.getMessages(agent.id).catch(() => [])
      const timestamp = messages.at(-1)?.timestamp
      return timestamp ? [agent.id, timestamp] as const : null
    })).then((pairs) => {
      if (cancelled) return
      setRememberedEnds((current) => {
        const next = { ...current }
        for (const pair of pairs) {
          if (pair) next[pair[0]] = pair[1]
        }
        return next
      })
    })
    return () => { cancelled = true }
  }, [agents])

  const hasLiveAgent = agents.some((agent) => agent.status === 'starting' || agent.status === 'running')
  useEffect(() => {
    if (!hasLiveAgent) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasLiveAgent])

  const listedAgents = [...agents].sort((left, right) => {
    const leftDone = isTerminalAgentStatus(left.status)
    const rightDone = isTerminalAgentStatus(right.status)
    if (leftDone !== rightDone) return leftDone ? 1 : -1
    return Date.parse(right.createdAt) - Date.parse(left.createdAt)
  })

  const openAgentSession = (agentId: string) => {
    setCenterAgentId(agentId)
    setThreadsSidebarOpen(true)
  }

  const stopAgent = async (agentId: string) => {
    setStoppingAgentIds((current) => new Set(current).add(agentId))
    try {
      await window.mousse.agents.stop(agentId)
    } finally {
      setStoppingAgentIds((current) => {
        const next = new Set(current)
        next.delete(agentId)
        return next
      })
    }
  }

  const embedded = variant === 'panel'

  return (
    <div className={embedded ? 'agents-tasks-window agents-tasks-panel' : 'agents-tasks-window'}>
      {!embedded && (
        <header className="agents-tasks-header">
          <h2>Agents &amp; Tasks</h2>
          <div className="agents-tasks-header-actions">
            <IconButton icon={X} label="Close" onClick={() => window.close()} />
          </div>
        </header>
      )}

      <div className="agents-tasks-body">
        <section className="agents-tasks-section">
          <h3 className="agents-tasks-section-title">
            Agents
            <span className="agents-tasks-count">{listedAgents.length}</span>
          </h3>
          {listedAgents.length === 0 && !centerAgentId ? null : (
            <ul className="agents-tasks-list">
              {centerAgentId && (
                <li className="agents-tasks-row agents-tasks-agent-row">
                  <button
                    type="button"
                    className="agents-tasks-agent-open"
                    onClick={() => setCenterAgentId(null)}
                  >
                    <div className="agents-tasks-row-main">
                      <span className="agents-tasks-row-title">Main agent</span>
                      {mainMark && <AgentModelBadge mark={mainMark} />}
                      <span className="agents-tasks-row-subtitle">{mainAgentName || 'This chat'}</span>
                    </div>
                  </button>
                </li>
              )}
              {listedAgents.map((agent) => {
                const inactive = isTerminalAgentStatus(agent.status)
                const worked = agentWorkedLabel(agent, now, rememberedEnds[agent.id])
                const mark = settings
                  ? describeSubagentModel(agent, assignments[agent.id], settings, providers)
                  : null
                return (
                  <li
                    key={agent.id}
                    className={`agents-tasks-row agents-tasks-agent-row${inactive ? ' is-inactive' : ''}${centerAgentId === agent.id ? ' is-open' : ''}`}
                  >
                    <button
                      type="button"
                      className="agents-tasks-agent-open"
                      onClick={() => openAgentSession(agent.id)}
                    >
                      <div className="agents-tasks-row-main">
                        <span className="agents-tasks-row-title">{agent.task || agent.cliType}</span>
                        {mark && <AgentModelBadge mark={mark} />}
                        <span className="agents-tasks-row-subtitle">
                          {inactive ? 'Inactive agent' : agent.cliType}
                          {worked ? ` · ${worked}` : ''}
                        </span>
                      </div>
                    </button>
                    <div className="agents-tasks-row-aside">
                      {!inactive && <StatusBadge status={agent.status} startupPhase={agent.startupPhase} />}
                      {!inactive && (
                        <IconButton
                          icon={SquareX}
                          size={14}
                          label="Stop agent (worktree retained)"
                          disabled={stoppingAgentIds.has(agent.id)}
                          onClick={() => {
                            if (confirmStopAgent(agent)) void stopAgent(agent.id)
                          }}
                        />
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="agents-tasks-section">
          <h3 className="agents-tasks-section-title">
            All Tasks
            <span className="agents-tasks-count">{tasks.length}</span>
          </h3>
          {tasks.length === 0 ? (
            <div className="agents-tasks-empty">No tasks yet</div>
          ) : (
            <ul className="agents-tasks-list">
              {tasks.map((task) => (
                <li key={task.id} className="agents-tasks-row agents-tasks-task-row">
                  <span className="agents-tasks-task-icon-wrap" title={taskStatusLabel(task.status)}>
                    <TaskStatusIcon status={task.status} />
                  </span>
                  <div className="agents-tasks-row-main">
                    <span
                      className={`agents-tasks-row-title${task.status === 'completed' ? ' agents-tasks-row-title-done' : ''}`}
                      title={task.description}
                    >
                      {task.description}
                    </span>
                    {task.progressMessage ? (
                      <span className="agents-tasks-row-subtitle" title={task.progressMessage}>
                        {task.progress !== undefined ? `${task.progress}% · ` : ''}{task.progressMessage}
                      </span>
                    ) : null}
                  </div>
                  {task.agentId ? (
                    <span className="agents-tasks-row-meta" title={task.agentId}>
                      {task.agentId.slice(0, 8)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
