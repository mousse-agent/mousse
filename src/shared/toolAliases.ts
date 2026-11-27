/**
 * Old Mousse tool names that still call the tool they were renamed to (docs/plans/tool-api.md §1.1 and §4), by old name.
 * An alias is never listed. A call under it is the canonical tool's call from the first step: it is renamed before
 * authorization and before its request key is built, so it meets the same checks, keeps the same receipts and
 * `expectedRunId` pins, and a retry under either name is the same request. A saved setting, an agent definition's grant
 * or a bot's stored grant that names an old tool means its new one. Names switch family by family; an alias stays until
 * a later cleanup, once the logs show no calls under it.
 */
export const MOUSSE_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  // The checklist family.
  list_tasks: 'task_list',
  create_task: 'task_create',
  update_task: 'task_update',
  goal_status: 'goal_update',
  // The discovery family. A bot's `work_models` and a thread's `list_models` are one tool: the bot's version on a bot turn.
  list_skills: 'skill_list',
  load_skill: 'skill_load',
  list_models: 'model_list',
  work_models: 'model_list',
  list_computers: 'computer_list',
  // The request family, asking side. A thread's `ask_user` and a bot's `ask_owner` are one tool, as are a thread's
  // `withdraw_question` and a bot's `question_withdraw`: the bot's version on a bot turn.
  ask_user: 'question_ask',
  ask_owner: 'question_ask',
  withdraw_question: 'question_withdraw',
  escalate: 'permission_ask',
  // The queue family. Each old tool is one `op` of `queue_update` (`MOUSSE_TOOL_ALIAS_ARGUMENTS`).
  queue_edit: 'queue_update',
  queue_remove: 'queue_update',
  queue_reorder: 'queue_update',
  queue_promote_to_steer: 'queue_update'
})

/**
 * What a call under an old name adds to its arguments, for an old tool that became one variant of its new one. They
 * win over the same argument given in the call: a call under an old name is that variant and no other.
 */
export const MOUSSE_TOOL_ALIAS_ARGUMENTS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  queue_edit: { op: 'edit' },
  queue_remove: { op: 'remove' },
  queue_reorder: { op: 'move' },
  queue_promote_to_steer: { op: 'send_now' }
})

/** The name a Mousse tool is registered, listed, granted and recorded under: `name` itself unless it is an old alias. */
export function canonicalToolName(name: string): string {
  return Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIASES, name) ? MOUSSE_TOOL_ALIASES[name] : name
}

/** Whether `name` is an old name kept only as a hidden alias. */
export function isToolAlias(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIASES, name)
}

/** A call as its canonical tool takes it: the canonical name, and the arguments an old variant name adds. */
export function canonicalToolCall(name: string, args: Record<string, unknown>): { name: string; args: Record<string, unknown> } {
  const added = Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIAS_ARGUMENTS, name) ? MOUSSE_TOOL_ALIAS_ARGUMENTS[name] : undefined
  return { name: canonicalToolName(name), args: added ? { ...args, ...added } : args }
}

/**
 * Whether a grant that names the tool `granted` holds a call of `name` with `args`. An old name that became one variant
 * of its tool (`MOUSSE_TOOL_ALIAS_ARGUMENTS`) holds only that variant: a grant of `queue_edit` is `queue_update` with
 * `op: edit` and nothing else. Without `args` (a listing), it holds the tool.
 */
export function grantHoldsCall(granted: string, name: string, args?: Record<string, unknown>): boolean {
  if (canonicalToolName(granted) !== canonicalToolName(name)) return false
  const variant = Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIAS_ARGUMENTS, granted) ? MOUSSE_TOOL_ALIAS_ARGUMENTS[granted] : undefined
  if (!variant || !args) return true
  const call = canonicalToolCall(name, args).args
  return Object.entries(variant).every(([key, value]) => call[key] === value)
}

/** The name a stored grant is kept under: its canonical name, except an old variant name, which keeps the variant it holds. */
export function canonicalGrantName(name: string): string {
  return Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIAS_ARGUMENTS, name) ? name : canonicalToolName(name)
}
