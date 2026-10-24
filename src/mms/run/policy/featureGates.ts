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

/** A delegation the target cannot honour; `delegate_task` returns it instead of starting a child. */
export interface SubagentRefusal {
  /** `provider_unsupported_for_subagents`: no child at all; `shared_unsupported_for_provider`: only a `shared` one, `isolated` works. */
  code: 'provider_unsupported_for_subagents' | 'shared_unsupported_for_provider'
  message: string
}

/** What `ProviderAdapter.childPreflight` is asked about: the requested workspace and the parent's workspace path. */
export interface ChildPreflightContext {
  workspace: 'shared' | 'isolated'
  cwd: string | null
}

/**
 * Issue #142: a delegated child must keep to its policy, so a provider that cannot hold it to
 * read-only access (and cannot switch off its own native subagents) is refused as a target. `label`
 * names the provider for the message.
 */
export function subagentTargetRefusal(caps: ProviderCapabilities, label: string): SubagentRefusal | null {
  if (caps.childPolicy === 'enforced') return null
  return {
    code: 'provider_unsupported_for_subagents',
    message: `${label} cannot run as a subagent: Mousse cannot keep it read-only or switch off its own native subagents. Choose another provider or model for this task.`
  }
}
