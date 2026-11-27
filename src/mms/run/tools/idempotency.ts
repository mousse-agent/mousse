import { canonicalToolName } from '../../../shared/toolAliases'

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
  'task_list',
  'list_subagents',
  'list_delegations',
  // Asks the user's other computers whether they have the repository; changes nothing anywhere.
  'computer_list',
  // Reads the provider entries and models offered here or on another computer; changes nothing.
  'model_list',
  // The retired merge tools only report a finished task's result (and pin it again).
  'integrate_delegation',
  'integrate_subagent',
  // Phase 5 Mousse MCP server (SPEC §15.1). `thread_list` reads only; a ledger row of `list_subagents` names it now.
  'thread_read',
  'thread_list',
  'queue_list',
  // Reads a thread's terminals from memory; never writes to them.
  'terminal_read',
  // A bot's Mousse tools (PR 6 §3). A consult's effects are the consult run's own calls, each in the
  // ledger; an escalation writes only bots.db. Either cut off by a crash leaves nothing unknown.
  'consult',
  'permission_ask'
])

/** Tools with side effects. Listed for documentation; any unknown tool is also non-idempotent. */
export const NON_IDEMPOTENT_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'run_command',
  'write_file',
  'edit_file',
  'browser_act',
  'browser_open',
  // Opening, switching or closing a tab acts; only listing them reads (`isIdempotentTool` with its arguments).
  'browser_tabs',
  'task_create',
  'task_update',
  'create_subagent',
  'create_subagents',
  'recall_subagent',
  // Phase 4 delegation (SPEC §14.2). `task_status` acknowledges a published result.
  'delegate_task',
  'continue_subagent',
  'answer_subagent',
  'task_status',
  'task_cancel',
  'question_ask',
  'queue_enqueue',
  // Start, stop or hold background work of the thread (issue #1605).
  'monitor_start',
  'background_run',
  'background_stop',
  'keep_working'
])

/**
 * True for registered read-only tools, and for a call that only reads (`browser_tabs` listing tabs, when its
 * arguments are known). Everything else, including MCP tools, is non-idempotent unless the MCP server annotates the
 * tool with `readOnlyHint: true`.
 */
export function isIdempotentTool(
  name: string,
  mcpAnnotations?: { readOnlyHint?: boolean },
  args?: unknown
): boolean {
  // A ledger row an older build wrote may name a tool by its old name.
  name = canonicalToolName(name)
  if (IDEMPOTENT_TOOLS.has(name)) return true
  if (name === 'browser_tabs') {
    const operation = args && typeof args === 'object' ? (args as { operation?: unknown }).operation : 'new'
    return operation === undefined || operation === 'list'
  }
  if (NON_IDEMPOTENT_TOOLS.has(name)) return false
  return mcpAnnotations?.readOnlyHint === true
}
