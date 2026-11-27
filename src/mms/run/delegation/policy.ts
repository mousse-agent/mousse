import type { ModeCeiling } from '../types'

/**
 * The most a task may do when two authorities apply: the narrower one. A `plan` ceiling anywhere
 * keeps the task `plan`; with neither set the task has no ceiling of its own.
 */
export function narrowCeiling(...ceilings: Array<ModeCeiling | null | undefined>): ModeCeiling | undefined {
  if (ceilings.includes('plan')) return 'plan'
  return ceilings.includes('default') ? 'default' : undefined
}

/**
 * Receipt key of a `delegate_task` call. A model-supplied `clientRequestId` (the Mousse MCP server
 * prefixes it `mcp:`) is scoped to the parent thread, so a retry after the calling run ended still
 * finds the first result; a pi tool-call id is only unique within its run.
 */
export function delegationRequestKey(parentThreadId: string, parentRunId: string, toolCallId: string): string {
  return toolCallId.startsWith('mcp:') ? `delegation:${parentThreadId}:${toolCallId}` : `delegation:${parentRunId}:${toolCallId}`
}

/**
 * The same for a Stop of a subagent by its title (`task_cancel`, or `thread_stop` with subagent): the key of its receipt,
 * under the old tool's prefix so a retry under either name finds it.
 */
export function cancelRequestKey(parentThreadId: string, parentRunId: string, toolCallId: string): string {
  return toolCallId.startsWith('mcp:') ? `task_cancel:${parentThreadId}:${toolCallId}` : `task_cancel:${parentRunId}:${toolCallId}`
}

/** The same for `continue_subagent`: the key of the follow-up's `send`. */
export function followUpRequestKey(parentThreadId: string, parentRunId: string, toolCallId: string): string {
  return toolCallId.startsWith('mcp:') ? `continue:${parentThreadId}:${toolCallId}` : `continue:${parentRunId}:${toolCallId}`
}
