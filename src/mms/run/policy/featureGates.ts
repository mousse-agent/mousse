import type { RunCapabilities as ProviderCapabilities } from '../../../shared/harness/types'

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
  /**
   * `shared_unsupported_for_provider`: the target cannot run a `shared` child (use `isolated`).
   * `read_only_caller_requires_shared`: the caller is itself read-only, so its children must be too.
   */
  code: 'shared_unsupported_for_provider' | 'read_only_caller_requires_shared'
  message: string
}

/** What `ProviderAdapter.childPreflight` is asked about: the requested workspace and the parent's workspace path. */
export interface ChildPreflightContext {
  workspace: 'shared' | 'isolated'
  cwd: string | null
}

/**
 * Issue #142: a `shared` child must be read-only, so a provider that cannot hold a child to that (it
 * rejects plan mode) is refused as the target of one. `label` names the provider for the message.
 */
export function subagentTargetRefusal(caps: ProviderCapabilities, label: string, workspace: 'shared' | 'isolated'): SubagentRefusal | null {
  if (caps.childPolicy === 'enforced' || workspace !== 'shared') return null
  return {
    code: 'shared_unsupported_for_provider',
    message: `${label} cannot run a read-only (shared) subagent: Mousse cannot keep it read-only. Use workspace "isolated", or choose another provider or model for this task.`
  }
}
