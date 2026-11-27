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
  goal_status: 'goal_update'
})

/** The name a Mousse tool is registered, listed, granted and recorded under: `name` itself unless it is an old alias. */
export function canonicalToolName(name: string): string {
  return Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIASES, name) ? MOUSSE_TOOL_ALIASES[name] : name
}

/** Whether `name` is an old name kept only as a hidden alias. */
export function isToolAlias(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MOUSSE_TOOL_ALIASES, name)
}
