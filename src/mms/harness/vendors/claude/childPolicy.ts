import { claudeToolKey, PERMISSION_KEYS } from '../../../../shared/permissionKeys'
import { CLAUDE_MOUSSE_TOOL_PREFIX, READ_ONLY_MOUSSE_TOOLS } from '../../../run/mcp/attachment'
import type { ChildTurnPolicy } from '../../adapter'

/**
 * The built-in tools a read-only (`shared`) child may use; `ToolSearch` keeps Mousse's deferred tools
 * reachable. `Agent` (`Task` before) is Claude Code's own subagent tool: a subagent may start
 * subagents, and what one does still passes through the same hook and permission callback.
 */
export const CLAUDE_READ_ONLY_BUILTIN_TOOLS: readonly string[] = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch', 'Agent', 'Task']

/**
 * Claude Code's shell tools: `Bash`, and `PowerShell` on Windows. A permission mode treats both as
 * the same class of action ("commands"), so an "Always" for commands covers both shells.
 */
export const CLAUDE_COMMAND_TOOLS: readonly string[] = ['Bash', 'PowerShell']

/** Claude Code's tools that change files. */
export const CLAUDE_EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

/**
 * What kind of action a Claude tool call is, for the permission mode: a shell command, a file edit,
 * a read-only built-in, or any other tool (an MCP tool, `WebFetch`, ...).
 */
export function claudeActionOf(toolName: string): 'command' | 'edit' | 'read' | 'tool' {
  if (CLAUDE_COMMAND_TOOLS.includes(toolName)) return 'command'
  if (CLAUDE_EDIT_TOOLS.includes(toolName)) return 'edit'
  if (CLAUDE_READ_ONLY_BUILTIN_TOOLS.includes(toolName)) return 'read'
  return 'tool'
}

/** The permission key of a Claude tool call: one per class of action, the tool name for any other tool. */
export function claudePermissionKey(toolName: string): string {
  const action = claudeActionOf(toolName)
  if (action === 'command') return PERMISSION_KEYS.claudeCommand
  if (action === 'edit') return PERMISSION_KEYS.claudeEdit
  return claudeToolKey(toolName)
}

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
