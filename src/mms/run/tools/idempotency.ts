/**
 * Tool idempotency registry (SPEC §12.6). A crash while a non-idempotent tool is `started` makes
 * the run `uncertain` instead of `interrupted`.
 */

/** Read-only tools: replaying them cannot change the world. */
export const IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'read_file',
  'list_dir',
  'ls',
  'git_status',
  'git_diff',
  'web_search',
  'web_fetch',
  'browser_observe',
  'browser_find',
  'browser_extract',
  'browser_screenshot',
  'browser_tabs',
  'list_tasks',
  'list_subagents',
  'list_delegations',
  // Phase 5 Mousse MCP server (SPEC §15.1).
  'thread_read',
  'queue_list'
])

/** Tools with side effects. Listed for documentation; any unknown tool is also non-idempotent. */
export const NON_IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'run_command',
  'write_file',
  'edit_file',
  'browser_act',
  'browser_open',
  'create_task',
  'update_task',
  'create_subagent',
  'create_subagents',
  'integrate_subagent',
  'recall_subagent',
  // Phase 4 delegation (SPEC §14.2). `task_status` acknowledges a published result.
  'delegate_task',
  'continue_subagent',
  'answer_subagent',
  'task_status',
  'task_cancel',
  'integrate_delegation',
  'present_plan',
  'ask_user',
  'queue_enqueue'
])

/**
 * True for registered read-only tools. Everything else, including MCP tools, is non-idempotent
 * unless the MCP server annotates the tool with `readOnlyHint: true`.
 */
export function isIdempotentTool(
  name: string,
  mcpAnnotations?: { readOnlyHint?: boolean }
): boolean {
  if (IDEMPOTENT_TOOLS.has(name)) return true
  if (NON_IDEMPOTENT_TOOLS.has(name)) return false
  return mcpAnnotations?.readOnlyHint === true
}
