import type { AgentStatus } from '../../shared/types'

/** Transitions are deliberately centralized so late process events cannot resurrect workers. */
const TRANSITIONS: Record<AgentStatus, ReadonlySet<AgentStatus>> = {
  starting: new Set(['running', 'failed', 'cancelled', 'interrupted']),
  running: new Set(['ready', 'failed', 'cancelled', 'interrupted', 'merging']),
  ready: new Set(['merging', 'cancelled', 'running']),
  merging: new Set(['completed', 'conflict', 'ready', 'failed', 'cancelled']),
  conflict: new Set(['merging', 'ready', 'cancelled']),
  completed: new Set(['completed']),
  failed: new Set(['failed', 'running', 'cancelled', 'merging']),
  cancelled: new Set(['cancelled', 'merging', 'running']),
  interrupted: new Set(['interrupted', 'running', 'cancelled', 'merging'])
}

export function canTransitionAgentStatus(from: AgentStatus, to: AgentStatus): boolean {
  return from === to || TRANSITIONS[from].has(to)
}

/** Pure lifecycle policy used by the registry and process owners. */
export class AgentLifecycleService {
  canTransition(from: AgentStatus, to: AgentStatus): boolean {
    return canTransitionAgentStatus(from, to)
  }

  transition(from: AgentStatus, to: AgentStatus): AgentStatus | undefined {
    return this.canTransition(from, to) ? to : undefined
  }
}
