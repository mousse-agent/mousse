import { useEffect, useState } from 'react'
import { CheckSquare, Loader2, Square, SquareX, X } from 'lucide-react'
import { IconButton } from './IconButton'
import { EnvironmentSection } from './EnvironmentSection'
import { confirmStopAgent } from '../lib/confirmStopAgent'
import type { Agent, Task, TaskStatus } from '../../shared/types'

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

export function AgentsTasksView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [stoppingAgentIds, setStoppingAgentIds] = useState<Set<string>>(() => new Set())

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

  const runningAgents = agents.filter(
    (a) => ['running', 'starting', 'ready', 'merging', 'conflict'].includes(a.status)
  )

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

  const handleClose = () => {
    window.close()
  }

  return (
    <div className="agents-tasks-window">
      <header className="agents-tasks-header">
        <h2>Agents &amp; Tasks</h2>
        <div className="agents-tasks-header-actions">
          <IconButton icon={X} label="Close" onClick={handleClose} />
        </div>
      </header>

      <div className="agents-tasks-body">
        <EnvironmentSection agents={agents} />

        <section className="agents-tasks-section">
          <h3 className="agents-tasks-section-title">
            Running Agents
            <span className="agents-tasks-count">{runningAgents.length}</span>
          </h3>
          {runningAgents.length === 0 ? (
            <div className="agents-tasks-empty">No agents currently running</div>
          ) : (
            <ul className="agents-tasks-list">
              {runningAgents.map((agent) => (
                <li key={agent.id} className="agents-tasks-row agents-tasks-agent-row">
                  <div className="agents-tasks-row-main">
                    <span className="agents-tasks-row-title">{agent.cliType}</span>
                    <span className="agents-tasks-row-subtitle" title={agent.task}>
                      {agent.task}
                    </span>
                  </div>
                  <div className="agents-tasks-row-aside">
                    <StatusBadge status={agent.status} startupPhase={agent.startupPhase} />
                    <span className="agents-tasks-row-meta" title={agent.worktreePath}>
                      {agent.worktreePath.split(/[/\\]/).pop()}
                    </span>
                    <IconButton
                      icon={SquareX}
                      size={14}
                      label="Stop agent (worktree retained)"
                      disabled={stoppingAgentIds.has(agent.id)}
                      onClick={() => {
                        if (confirmStopAgent(agent)) void stopAgent(agent.id)
                      }}
                    />
                  </div>
                </li>
              ))}
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
