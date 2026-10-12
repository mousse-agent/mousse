import type { ProviderCapabilities } from '../adapters/ProviderAdapter'

/**
 * Capability readers for later phases (docs/run-engine/SPEC.md §13.2). Each gate reads one flag
 * so callers never branch on a provider.
 */

/** Phase 6 Undo: the provider can roll its own session back to a turn. */
export function canUndoNatively(caps: ProviderCapabilities): boolean {
  return caps.rollback === 'native'
}

/** `native`: the provider forks its session; `portable`: a new session replays the transcript. */
export type ForkStrategy = 'native' | 'portable'

export function forkStrategy(caps: ProviderCapabilities): ForkStrategy {
  return caps.fork === 'native' ? 'native' : 'portable'
}

/**
 * Phase 4 delegation.
 * - `managed_children`: subagents are Mousse child threads the loop starts and controls.
 * - `mirror_native`: the provider runs its own subagents; Mousse records them read-only.
 * - `delegate_task_only`: the provider has no subagents; delegation goes through Mousse's tools.
 */
export type DelegationMode = 'managed_children' | 'mirror_native' | 'delegate_task_only'

export function delegationMode(caps: ProviderCapabilities): DelegationMode {
  if (caps.nativeSubagents === 'managed') return 'managed_children'
  if (caps.nativeSubagents === 'observed') return 'mirror_native'
  return 'delegate_task_only'
}

/**
 * Phase 6 checkpoint restore. Strong containment (Mousse ran every tool) restores automatically;
 * weak containment may have touched files Mousse did not see, so the user reviews the diff.
 */
export type RestoreMode = 'auto' | 'review_diff'

export function restoreMode(caps: ProviderCapabilities): RestoreMode {
  return caps.containment === 'strong' ? 'auto' : 'review_diff'
}

/**
 * Phase 6 handoff between providers. `native_history`: prior turns go in as the provider's own
 * message history; `prompt_preamble`: they are serialised into the first prompt.
 */
export type HandoffDelivery = 'native_history' | 'prompt_preamble'

export function handoffDelivery(caps: ProviderCapabilities): HandoffDelivery {
  return caps.historyInjection === 'native' ? 'native_history' : 'prompt_preamble'
}

/** Phase 5: the Mousse MCP server can be attached to the provider's runtime. */
export function mcpAttachable(caps: ProviderCapabilities): boolean {
  return caps.mcp
}
