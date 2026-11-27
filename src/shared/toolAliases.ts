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
  // The thread family. `thread_hide` and `thread_steer` are one variant of their new tool (`TOOL_VARIANTS`).
  thread_interrupt: 'thread_stop',
  thread_merge_back: 'thread_return',
  thread_hide: 'thread_update',
  thread_steer: 'thread_send'
})

type ToolArgs = Record<string, unknown>

/**
 * Old names that became one variant of a tool that does more (docs/plans/tool-api.md §1.2, "Who may call"). `args` turns
 * the old call's arguments into the new tool's; `holds` says whether a call of the new tool is that variant, since a grant
 * of the old name holds only that: an agent definition granted `thread_steer` sends notes, never work.
 */
const TOOL_VARIANTS: Readonly<Record<string, { args(old: ToolArgs): ToolArgs; holds(args: ToolArgs): boolean }>> = {
  // `thread_hide {threadId, hidden = true}` is `thread_update {threadId, hidden}`.
  thread_hide: {
    args: ({ hidden, ...rest }) => ({ ...rest, hidden: hidden === undefined ? true : hidden }),
    holds: (args) => args.hidden !== undefined && args.access === undefined
  },
  // `thread_steer {threadId, runId, text}` is a note that joins the run it names: `thread_send {…, content, intent: note}`.
  thread_steer: {
    args: ({ text, ...rest }) => ({ ...rest, content: text, intent: 'note' }),
    holds: (args) => args.intent === 'note'
  }
}

const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key)

/** The name a Mousse tool is registered, listed, granted and recorded under: `name` itself unless it is an old alias. */
export function canonicalToolName(name: string): string {
  return own(MOUSSE_TOOL_ALIASES, name) ? MOUSSE_TOOL_ALIASES[name] : name
}

/** Whether `name` is an old name kept only as a hidden alias. */
export function isToolAlias(name: string): boolean {
  return own(MOUSSE_TOOL_ALIASES, name)
}

/** A call under any name as its canonical tool's call: the new name, and the arguments that tool takes for that variant. */
export function canonicalToolCall(name: string, args: ToolArgs): { name: string; args: ToolArgs } {
  return { name: canonicalToolName(name), args: own(TOOL_VARIANTS, name) ? TOOL_VARIANTS[name].args(args) : args }
}

/**
 * The old names among the saved grant `names` (an agent definition's allowlist) that grant `tool` only as their variant;
 * undefined when `names` grants all of it (its own name, or a plain old name) or none of it.
 */
export function grantedVariants(names: readonly string[], tool: string): string[] | undefined {
  const naming = names.filter((name) => canonicalToolName(name) === tool)
  return naming.length > 0 && naming.every((name) => own(TOOL_VARIANTS, name)) ? [...new Set(naming)].sort() : undefined
}

/** Whether a grant held only as the old names `variants` (none: the whole tool) holds a call with `args`; without `args` (a listing), any variant does. */
export function variantsHold(variants: readonly string[] | undefined, args?: ToolArgs): boolean {
  return !variants || args === undefined || variants.some((name) => own(TOOL_VARIANTS, name) && TOOL_VARIANTS[name].holds(args))
}
