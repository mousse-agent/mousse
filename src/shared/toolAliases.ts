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
  // The queue family. Each old tool is one `op` of `queue_update` (`MOUSSE_TOOL_ALIAS_ARGUMENTS`).
  queue_edit: 'queue_update',
  queue_remove: 'queue_update',
  queue_reorder: 'queue_update',
  queue_promote_to_steer: 'queue_update',
  // The thread family. `thread_hide` and `thread_steer` are one variant of their new tool (`MOUSSE_TOOL_ALIAS_TRANSLATIONS`).
  thread_interrupt: 'thread_stop',
  thread_merge_back: 'thread_return',
  thread_hide: 'thread_update',
  thread_steer: 'thread_send'
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

type ToolArgs = Record<string, unknown>

/**
 * Old tools that became one variant of their new one with arguments of another shape. `args` turns the old call's
 * arguments into the new tool's, and the variant it fixes wins over the call; `holds` says whether a call of the new
 * tool is that variant, since a grant of the old name holds only that (`grantHoldsCall`).
 */
const MOUSSE_TOOL_ALIAS_TRANSLATIONS: Readonly<Record<string, { args(old: ToolArgs): ToolArgs; holds(args: ToolArgs): boolean }>> = Object.freeze({
  // `thread_hide {threadId, hidden = true}` is `thread_update {threadId, hidden}`; never `access`.
  thread_hide: {
    args: ({ hidden, ...rest }: ToolArgs) => ({ ...rest, hidden: hidden === undefined ? true : hidden }),
    holds: (args: ToolArgs) => args.hidden !== undefined && args.access === undefined
  },
  // `thread_steer {threadId, runId, text}` is a note that joins the run it names: `thread_send {…, content, intent: note}`.
  thread_steer: {
    args: ({ text, ...rest }: ToolArgs) => ({ ...rest, ...(text !== undefined ? { content: text } : {}), intent: 'note' }),
    holds: (args: ToolArgs) => args.intent === 'note'
  }
})

const own = (record: object, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key)

/** The name a Mousse tool is registered, listed, granted and recorded under: `name` itself unless it is an old alias. */
export function canonicalToolName(name: string): string {
  return own(MOUSSE_TOOL_ALIASES, name) ? MOUSSE_TOOL_ALIASES[name] : name
}

/** Whether `name` is an old name kept only as a hidden alias. */
export function isToolAlias(name: string): boolean {
  return own(MOUSSE_TOOL_ALIASES, name)
}

/** Whether `name` is an old name that became one variant of its new tool, so a grant of it holds that variant only. */
export function isVariantAlias(name: string): boolean {
  return own(MOUSSE_TOOL_ALIAS_ARGUMENTS, name) || own(MOUSSE_TOOL_ALIAS_TRANSLATIONS, name)
}

/** A call as its canonical tool takes it: the canonical name, and the arguments of the variant an old name is. */
export function canonicalToolCall(name: string, args: ToolArgs): { name: string; args: ToolArgs } {
  if (own(MOUSSE_TOOL_ALIAS_ARGUMENTS, name)) return { name: canonicalToolName(name), args: { ...args, ...MOUSSE_TOOL_ALIAS_ARGUMENTS[name] } }
  if (own(MOUSSE_TOOL_ALIAS_TRANSLATIONS, name)) return { name: canonicalToolName(name), args: MOUSSE_TOOL_ALIAS_TRANSLATIONS[name].args(args) }
  return { name: canonicalToolName(name), args }
}

/**
 * Whether a grant that names the tool `granted` holds a call of `name` with `args`. An old name that became one variant
 * of its tool holds only that variant: a grant of `queue_edit` is `queue_update` with `op: edit` and nothing else, and
 * one of `thread_steer` is `thread_send` with `intent: note`. Without `args` (a listing), it holds the tool.
 */
export function grantHoldsCall(granted: string, name: string, args?: ToolArgs): boolean {
  if (canonicalToolName(granted) !== canonicalToolName(name)) return false
  if (!args) return true
  const call = canonicalToolCall(name, args).args
  if (own(MOUSSE_TOOL_ALIAS_ARGUMENTS, granted)) return Object.entries(MOUSSE_TOOL_ALIAS_ARGUMENTS[granted]).every(([key, value]) => call[key] === value)
  if (own(MOUSSE_TOOL_ALIAS_TRANSLATIONS, granted)) return MOUSSE_TOOL_ALIAS_TRANSLATIONS[granted].holds(call)
  return true
}

/** The name a stored grant is kept under: its canonical name, except an old variant name, which keeps the variant it holds. */
export function canonicalGrantName(name: string): string {
  return isVariantAlias(name) ? name : canonicalToolName(name)
}
