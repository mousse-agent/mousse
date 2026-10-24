import { CLAUDE_MOUSSE_TOOL_PREFIX, READ_ONLY_MOUSSE_TOOLS } from '../../run/mcp/attachment'
import type { ChildTurnPolicy } from '../../run/adapters/ProviderAdapter'

/**
 * The built-in tools a read-only (`shared`) child may use; `ToolSearch` keeps Mousse's deferred tools
 * reachable. `Agent` (`Task` before) is Claude Code's own subagent tool: a subagent may start
 * subagents, and what one does still passes through the same hook and permission callback.
 */
export const CLAUDE_READ_ONLY_BUILTIN_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch', 'Agent', 'Task']

/**
 * Issue #142: the permission decision for one tool call of a delegated child, or undefined when
 * the child may call it. Only a read-only (`shared`) child is restricted; an isolated child keeps
 * every tool. Applied on every turn of the child, first or resumed, from both the permission
 * callback and the PreToolUse hook (hooks run in every permission mode, so the decision holds under
 * the user's own allow rules). Nothing here edits the user's Claude configuration.
 *
 * A read-only child gets the read-only built-ins and Mousse's read-only tools; every other tool is
 * refused, which includes every external MCP tool: the server stays configured, but Mousse cannot
 * tell which of its tools write. The Mousse MCP server also refuses a read-only child's
 * thread-writing tools on its own (`ToolRegistry`, keyed by the caller's thread), since the callback
 * lets Mousse's tools through, and `delegate_task` limits its subagents to read-only ones.
 */
export function claudeChildToolDenial(child: ChildTurnPolicy | undefined, toolName: string): string | undefined {
  if (!child?.readOnly) return undefined
  if (toolName.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX))
    return READ_ONLY_MOUSSE_TOOLS.has(toolName.slice(CLAUDE_MOUSSE_TOOL_PREFIX.length)) ? undefined : 'This subagent is read-only; this Mousse tool can change threads or the workspace.'
  if (CLAUDE_READ_ONLY_BUILTIN_TOOLS.includes(toolName)) return undefined
  return toolName.startsWith('mcp__')
    ? 'This subagent is read-only; tools from other MCP servers are not available to it.'
    : 'This subagent is read-only; edits and shell commands are disabled.'
}
