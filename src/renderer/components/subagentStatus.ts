import type { SubagentState } from '../../shared/subagents'

/**
 * The colour of the dot on a subagent's provider icon: going (accent), waiting on someone (warning),
 * done (success), failed (danger), or stopped/idle (faint).
 */
export type SubagentBadgeTone = 'running' | 'attention' | 'done' | 'failed' | 'idle'

export function subagentBadgeTone(subagent: { state: SubagentState; pending?: boolean }): SubagentBadgeTone {
  if (subagent.pending) return 'running'
  switch (subagent.state) {
    case 'queued':
    case 'starting':
    case 'working':
      return 'running'
    case 'needs_input':
    case 'waiting':
    case 'paused':
      return 'attention'
    case 'done':
      return 'done'
    case 'failed':
    case 'interrupted':
      return 'failed'
    default:
      return 'idle'
  }
}

/**
 * Which logo a subagent row shows: the provider instance it was asked to run on, else the one it
 * inherited from its parent thread. Empty when neither is known, which draws the generic mark.
 */
export function subagentIconId(provider: string | null | undefined, inherited: string | null | undefined): string {
  return provider || inherited || ''
}

/** The provider a thread runs on: its own override, else the default provider. Null when neither is known. */
export function threadProviderId(override: string | null | undefined, defaultProvider: string | null | undefined): string | null {
  return override || defaultProvider || null
}
