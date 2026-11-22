import { isWorkingSubagent, type SubagentState, type SubagentSummary } from '../../shared/subagents'
import type { TurnPhase } from '../../shared/types'

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

/** A subagent's Nest entry and the parent thread that started it. */
export interface ActiveSubagentEntry {
  parentThreadId: string
  subagent: SubagentSummary
}

/**
 * Finds the Nest entry for `threadId` across all loaded parent subagent lists (matching a local subagent
 * by `childThreadId` or a remote one by `computer.ref`). Lets the chat and parent bar recognise a subagent
 * immediately on click, even before `threads:updated` or its first `turn-state` arrives.
 */
export function findSubagentEntry(
  subagentsByParent: Readonly<Record<string, readonly SubagentSummary[]>>,
  threadId: string | null | undefined
): ActiveSubagentEntry | undefined {
  if (!threadId) return undefined
  for (const [parentThreadId, rows] of Object.entries(subagentsByParent)) {
    const subagent = rows.find((row) => row.childThreadId === threadId || row.computer?.ref === threadId)
    if (subagent) return { parentThreadId, subagent }
  }
  return undefined
}

/**
 * Whether an opened subagent thread should show an optimistic Working / Starting… state before its
 * daemon turn state or first message arrives (e.g. while queued or creating a worktree, or on another
 * computer). Yields to any non-idle daemon turn phase and clears once a setup failure is recorded.
 */
export function isSubagentStartingOptimistically(input: {
  subagent: Pick<SubagentSummary, 'state' | 'waitingOn'> | undefined
  turnPhase: TurnPhase | undefined
  messageCount: number
  hasSetupFailure: boolean
}): boolean {
  if (!input.subagent || input.hasSetupFailure || input.messageCount > 0) return false
  if (input.turnPhase && input.turnPhase !== 'idle') return false
  return isWorkingSubagent(input.subagent)
}
