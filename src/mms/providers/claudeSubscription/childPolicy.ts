import { CLAUDE_MOUSSE_TOOL_PREFIX, READ_ONLY_MOUSSE_TOOLS } from '../../run/mcp/attachment'
import type { ChildTurnPolicy } from '../../run/adapters/ProviderAdapter'

/** The built-in tools a read-only (`shared`) child may use; `ToolSearch` keeps Mousse's deferred tools reachable. */
export const CLAUDE_READ_ONLY_BUILTIN_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch']

/** Claude Code's own subagent tool: `Agent` today, `Task` before. A Mousse subagent starts none. */
export const CLAUDE_NATIVE_SUBAGENT_TOOLS: readonly string[] = ['Agent', 'Task']

/**
 * Issue #142: the permission decision for one tool call of a delegated child, or undefined when
 * the child may call it. Applied on every turn of the child, first or resumed, from both the
 * permission callback and the PreToolUse hook (hooks run in every permission mode, so the decision
 * holds under the user's own allow rules). Nothing here edits the user's Claude configuration.
 * The Mousse MCP server refuses a read-only child's thread-writing tools on its own as well
 * (`ToolRegistry`, keyed by the caller's thread), since the callback lets Mousse's tools through.
 *
 * Any subagent: no native subagent tool. A read-only child: the read-only built-ins and Mousse's
 * read-only tools only. Every other tool is refused, which includes every external MCP tool: the
 * server stays configured, but Mousse cannot tell which of its tools write.
 */
export function claudeChildToolDenial(child: ChildTurnPolicy | undefined, toolName: string): string | undefined {
  if (!child) return undefined
  if (CLAUDE_NATIVE_SUBAGENT_TOOLS.includes(toolName)) return 'A Mousse subagent cannot start Claude subagents.'
  if (!child.readOnly) return undefined
  if (toolName.startsWith(CLAUDE_MOUSSE_TOOL_PREFIX))
    return READ_ONLY_MOUSSE_TOOLS.has(toolName.slice(CLAUDE_MOUSSE_TOOL_PREFIX.length)) ? undefined : 'This subagent is read-only; this Mousse tool can change threads or the workspace.'
  if (CLAUDE_READ_ONLY_BUILTIN_TOOLS.includes(toolName)) return undefined
  return toolName.startsWith('mcp__')
    ? 'This subagent is read-only; tools from other MCP servers are not available to it.'
    : 'This subagent is read-only; edits and shell commands are disabled.'
}
