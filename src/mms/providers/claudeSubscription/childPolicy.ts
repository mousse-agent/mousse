import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { ChildTurnPolicy } from '../../run/adapters/ProviderAdapter'

/**
 * The built-in tools a read-only (`shared`) child may use. `ToolSearch` stays so the Mousse MCP
 * tools, which Claude Code defers behind it, remain reachable. Plan turns use the same allowlist
 * for the calls that reach `canUseTool`.
 */
export const CLAUDE_READ_ONLY_BUILTIN_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'ToolSearch'] as const

/** Claude Code's own subagent tool: `Agent` today, `Task` before. A Mousse subagent starts none. */
export const CLAUDE_NATIVE_SUBAGENT_TOOLS = ['Agent', 'Task'] as const

/**
 * Deny rules on top of the allowlist (a deny rule beats the user's own allow rules and hooks):
 * everything that writes files or runs a shell.
 */
const CLAUDE_WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'] as const

/**
 * Issue #142: the SDK options a delegated child's turn adds, on its first turn and every resumed
 * one. A read-only child gets only the read-only built-ins and none of the user's MCP servers
 * (`strictMcpConfig` ignores `.mcp.json`, user settings and plugins; the caller also leaves the
 * user's servers out of `mcpServers`). It keeps the default permission mode rather than `plan`:
 * plan mode makes Claude Code write a plan and call ExitPlanMode, which is wrong for research and
 * review, while the allowlist plus deny rules already refuse every write. Any child, read-only or
 * not, loses the native subagent tool.
 */
export function claudeChildOptions(child: ChildTurnPolicy | undefined): Pick<Options, 'tools' | 'disallowedTools' | 'strictMcpConfig'> {
  if (!child) return {}
  if (!child.readOnly) return { disallowedTools: [...CLAUDE_NATIVE_SUBAGENT_TOOLS] }
  return {
    tools: [...CLAUDE_READ_ONLY_BUILTIN_TOOLS],
    disallowedTools: [...CLAUDE_WRITE_TOOLS, ...CLAUDE_NATIVE_SUBAGENT_TOOLS],
    strictMcpConfig: true
  }
}
