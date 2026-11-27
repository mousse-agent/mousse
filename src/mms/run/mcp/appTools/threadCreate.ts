import { refused } from './refusal'
import type { JsonSchema, MousseTool, ToolOutcome, ToolVariant, VariantSite } from './types'

/**
 * `thread_create` (docs/plans/tool-api.md §2.1): one tool that starts a subagent or a thread. Each kind is a variant with
 * a declaration of its own (`MousseTool.variants`), so who may start what is read here:
 *
 * - `kind: subagent` needs `threads.delegate`, which every thread holds, readers and Plan included: a child no wider
 *   than its caller, here or on another computer (`computer`). It is `delegate_task`'s declaration and host
 *   (`delegation.ts`), under that name: a grant (a bot's, a definition's) judges it as `delegate_task`, whose old name
 *   is an alias of this kind (`MOUSSE_TOOL_ALIASES`).
 * - `kind: thread` needs `threads.start`, which a Plan ceiling and a read-only child lack, and a project: the thread
 *   family's independent thread (`thread.ts`). An agent's is a handoff (another project, or a thread the person asked
 *   for) and always shows in the person's sidebar; `hidden` is a personal bot's (#2004, #2003).
 *
 * The tool is listed and held where either kind is. A call that names no kind (an older caller) is a thread, as it was.
 * A bot's turn starts threads only: its subagents and its work start through the bot port (`subagent_start`,
 * `work_start`).
 */
export type ThreadCreateKind = 'subagent' | 'thread'

const KIND_SCHEMA: JsonSchema = {
  type: 'string',
  enum: ['subagent', 'thread'],
  description: 'Required. subagent: a child of yours that reports back to you, in your project (or on another computer). thread: a handoff, an independent thread in another project or one the person asked for; it shows in their sidebar.'
}

/** `thread_create`, from the declarations of its two kinds. Without the run engine there is no thread kind. */
export function threadCreateTool(kinds: { subagent: MousseTool; thread?: MousseTool }): MousseTool {
  const variants: Partial<Record<ThreadCreateKind, MousseTool>> = {
    subagent: { ...kinds.subagent, capabilities: ['threads.delegate'] },
    ...(kinds.thread ? { thread: kinds.thread } : {})
  }
  const properties = { subagent: propertiesOf(kinds.subagent.inputSchema), thread: propertiesOf(kinds.thread?.inputSchema) }
  const { definition: _definition, ...subagent } = kinds.subagent
  return {
    ...subagent,
    name: 'thread_create',
    description: `Start a subagent or a thread; kind is required. kind "subagent": ${kinds.subagent.description}${kinds.thread ? ` kind "thread": ${kinds.thread.description}` : ''}`,
    inputSchema: { type: 'object', properties: { kind: KIND_SCHEMA, ...mergedProperties(properties.subagent, properties.thread) }, required: ['kind'] },
    // A bot's thread lists the thread kind only, as a bot uses it (`asBotTool`).
    ...(kinds.thread ? { botDescription: kinds.thread.botDescription ?? kinds.thread.description, botInputSchema: kinds.thread.botInputSchema ?? kinds.thread.inputSchema, botClass: kinds.thread.class } : {}),
    describe: () => 'Start a subagent or a thread',
    variants: Object.values(variants) as MousseTool[],
    variantOf: (args, site) => kindOf(args, site, variants, properties),
    handler: () => {
      throw new Error('thread_create runs as the kind its call names (variantOf).')
    }
  }
}

/**
 * The kind a call is, and the arguments that kind takes. A call that names none is an older caller's thread, passed on
 * as it came (no `kind`), so the thread kind can tell it from a new caller's (its `hidden`, `thread.ts`).
 */
function kindOf(args: Record<string, unknown>, site: VariantSite, variants: Partial<Record<ThreadCreateKind, MousseTool>>, properties: Record<ThreadCreateKind, Record<string, JsonSchema>>): ToolVariant | { refused: ToolOutcome } {
  if (args.kind !== undefined && args.kind !== 'subagent' && args.kind !== 'thread') return { refused: refused('invalid_arguments', 'kind must be "subagent" or "thread".') }
  const kind: ThreadCreateKind = args.kind ?? 'thread'
  if (site.turn.bot && kind === 'subagent')
    return { refused: refused('not_granted', 'A bot starts its subagents with subagent_start, and its work with work_start: thread_create starts threads (kind "thread").', { variant: 'delegate_task' }) }
  const tool = variants[kind]
  if (!tool) return { refused: refused('unavailable', `kind "${kind}" is not available here.`) }
  // An argument of the other kind only is a mistake about the kind, never one to drop.
  const other = kind === 'subagent' ? 'thread' : 'subagent'
  const foreign = Object.keys(args).filter((key) => key in properties[other] && !(key in properties[kind]))
  if (foreign.length) return { refused: refused('invalid_arguments', `${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} for kind "${other}", not "${kind}".`) }
  return { tool, args }
}

function propertiesOf(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  return ((schema as { properties?: Record<string, JsonSchema> } | undefined)?.properties ?? {})
}

/** One kind's arguments and the other's: one each kind takes alike is listed once, and what differs is said per kind. */
function mergedProperties(subagent: Record<string, JsonSchema>, thread: Record<string, JsonSchema>): Record<string, JsonSchema> {
  const merged: Record<string, JsonSchema> = {}
  for (const key of new Set([...Object.keys(subagent), ...Object.keys(thread)])) {
    if (key === 'clientRequestId') continue
    const [a, b] = [subagent[key], thread[key]]
    const said = (schema: JsonSchema, kind: string) => (typeof schema.description === 'string' && schema.description ? `kind ${kind}: ${schema.description}` : `kind ${kind} only.`)
    if (!a || !b) merged[key] = { ...(a ?? b), description: said(a ?? b, a ? 'subagent' : 'thread') }
    else if (JSON.stringify(a) === JSON.stringify(b)) merged[key] = a
    else {
      const enums = [...new Set([...((a.enum as unknown[]) ?? []), ...((b.enum as unknown[]) ?? [])])]
      merged[key] = { ...a, ...(enums.length ? { enum: enums } : {}), description: `${said(a, 'subagent')} ${said(b, 'thread')}` }
    }
  }
  return merged
}
