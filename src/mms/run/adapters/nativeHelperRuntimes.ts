import type { NativeHelperRuntime, ThreadNativeHelper } from '../../../shared/types'
import type { StreamingLlmToolEvent } from '../../harness/turnEvents'

/**
 * What differs between the runtimes whose own helpers Mousse mirrors (docs/plans/tool-api.md §2.7). The router, the
 * mirrors and the thread's refusals read these rules and never name a runtime themselves, so provider names stay here.
 */
export interface NativeHelperRules {
  /** The agent a tool event's helper row stands for, when the event is a subagent row of this runtime. */
  helperRow(event: StreamingLlmToolEvent, activity: { nativeId?: string; toolName?: string }): string | undefined
  /** A completed row that only launched a background helper: the helper's row stays open. */
  launchOnly(activity: { background?: boolean; status?: string } | undefined): boolean
  /** The id the runtime addresses a finished agent by, when it said one. */
  sendTo(activity: { nativeId?: string } | undefined, row: string): string | undefined
  /** A helper's first event this process sees is later work for one it never saw start. */
  isLaterEpisode(event: StreamingLlmToolEvent): boolean
  /** How a Mousse tool call is tied to a helper: by the runtime's tool-use id, or by the helper's thread id. */
  attribution: 'tool_use' | 'thread'
  /** The runtime can stop one helper without stopping its hosting run. */
  stopsHelperAlone: boolean
  /** Why a message sent to the helper's thread goes nowhere, and what to do instead. */
  runtimeOwnedMessage(native: Pick<ThreadNativeHelper, 'agentId' | 'sendTo'>): string
}

const CODEX: NativeHelperRules = {
  helperRow(event, activity) {
    // Only the runtime's own helper rows: a Mousse subagent call is an MCP call with another id.
    if (!event.callId?.startsWith('helper:')) return undefined
    return activity.nativeId ?? event.callId.slice('helper:'.length).split('#')[0]
  },
  launchOnly: () => false,
  sendTo: () => undefined,
  isLaterEpisode: (event) => (event.activity as { summary?: string } | undefined)?.summary === 'More work',
  attribution: 'thread',
  stopsHelperAlone: true,
  runtimeOwnedMessage: (native) => `Codex runs this helper inside its parent's run (agent ${native.agentId}); write to the parent thread instead.`
}

const CLAUDE: NativeHelperRules = {
  helperRow(event, activity) {
    // The runtime's own subagent tool; Mousse's delegate_task is an MCP tool and never one of these.
    return activity.toolName === 'Agent' || activity.toolName === 'Task' ? event.callId : undefined
  },
  // The launch of a background agent completes the call, not the agent.
  launchOnly: (activity) => activity?.background === true && !activity.status,
  sendTo: (activity, row) => (activity?.nativeId && activity.nativeId !== row ? activity.nativeId : undefined),
  isLaterEpisode: () => false,
  attribution: 'tool_use',
  stopsHelperAlone: false,
  runtimeOwnedMessage: (native) => `Claude Code runs this helper inside its parent's run, and only that run can message it: ask the parent's agent to use SendMessage with agent ${native.sendTo ?? native.agentId}.`
}

export function nativeHelperRules(runtime: NativeHelperRuntime): NativeHelperRules {
  return runtime === 'codex' ? CODEX : CLAUDE
}

/** The runtime whose helpers a provider driver reports, or undefined for one Mousse does not mirror. */
export function nativeHelperRuntime(driver: string | undefined): NativeHelperRuntime | undefined {
  return driver === 'codex' ? 'codex' : driver === 'claude' ? 'claude' : undefined
}
