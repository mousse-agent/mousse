import type { Agent } from '../../shared/types'

export function confirmStopAgent(agent: Pick<Agent, 'cliType'>): boolean {
  return window.confirm(
    `Stop this ${agent.cliType} subagent?\n\nIts current process will be terminated. The worktree and any changes will be retained.`
  )
}
