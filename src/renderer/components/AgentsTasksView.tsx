import { useEffect, useState } from 'react'
import { CheckSquare, Loader2, Square, SquareX, X } from 'lucide-react'
import { IconButton } from './IconButton'
import { EnvironmentSection } from './EnvironmentSection'
import type { Agent, Task, TaskStatus } from '../../shared/types'

function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status}`}>{status.replace('_', ' ')}</span>
}

function TaskStatusIcon({ status }: { status: TaskStatus }) {
  const className = `agents-tasks-task-icon agents-tasks-task-icon-${status}`

  switch (status) {
    case 'completed':
      return <CheckSquare size={16} strokeWidth={2} className={className} aria-hidden="true" />
    case 'in_progress':
      return <Loader2 size={16} strokeWidth={2} className={`${className} agents-tasks-task-icon-spin`} aria-hidden="true" />
    case 'failed':
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
    default:
      return 'Pending'
  }
}

export function AgentsTasksView() {
  const [agents, setAgents] = useState<Agent[]>([])
  const [tasks, setTasks] = useState<Task[]>([])

  useEffect(() => {
    window.mousse.agents.list().then(setAgents)
    window.mousse.tasks.list().then(setTasks)

    const unsubs = [
      window.mousse.agents.onUpdated(setAgents),
      window.mousse.tasks.onUpdated(setTasks)
    ]

    return () => unsubs.forEach((u) => u())
  }, [])

  const runningAgents = agents.filter(
    (a) => ['running', 'starting', 'ready', 'merging', 'conflict'].includes(a.status)
  )

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
                    <StatusBadge status={agent.status} />
                    <span className="agents-tasks-row-meta" title={agent.worktreePath}>
                      {agent.worktreePath.split(/[/\\]/).pop()}
                    </span>
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
