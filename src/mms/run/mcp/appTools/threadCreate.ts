import type { RunEngine } from '../../RunEngine'
import type { AppToolHost } from './host'
import type { JsonSchema, MousseTool } from './types'

/**
 * `thread_create` (docs/plans/tool-api.md §2.1): one tool that starts a subagent or a thread. Each kind is held to a
 * declaration of its own (`MousseTool.kinds`), so who may start what is read here:
 *
 * - `kind: subagent` needs `threads.delegate`, which every thread holds, readers and Plan included: a child no wider
 *   than its caller, here or on another computer (`computer`). It is `delegate_task`'s declaration and host
 *   (`delegation.ts`), whose old name is an alias of this kind (`MOUSSE_TOOL_ALIASES`).
 * - `kind: thread` needs `threads.start`, which a Plan ceiling and a read-only child lack, and a project: the thread
 *   family's independent thread (`thread.ts`). An agent's is a handoff (another project, or a thread the person asked
 *   for) and always shows in the person's sidebar; `hidden` is a personal bot's (#2004, #2003).
 *
 * The tool is listed and usable as its widest kind, the subagent. A bot's turn starts threads only: its subagents and
 * its work start through the bot port (`subagent_start`, `work_start`).
 */
export type ThreadCreateKind = 'subagent' | 'thread'

const KIND_SCHEMA: JsonSchema = {
  type: 'string',
  enum: ['subagent', 'thread'],
  description: 'Required. subagent: a child of yours that reports back to you, in your project (or on another computer). thread: a handoff, an independent thread in another project or one the person asked for; it shows in their sidebar.'
}

/** `thread_create`, from the declarations of its two kinds. Without the run engine there is no thread kind. */
export function threadCreateTool(kinds: { subagent: MousseTool; thread?: MousseTool }, host: Pick<AppToolHost, 'threadMeta'>, engine?: RunEngine): MousseTool {
  const declarations: Partial<Record<ThreadCreateKind, MousseTool>> = {
    subagent: { ...kinds.subagent, name: 'thread_create', capabilities: ['threads.delegate'] },
    ...(kinds.thread ? { thread: kinds.thread } : {})
  }
  const properties = { subagent: propertiesOf(kinds.subagent.inputSchema), thread: propertiesOf(kinds.thread?.inputSchema) }
  const { definition: _definition, ...subagent } = declarations.subagent!
  return {
    ...subagent,
    description: `Start a subagent or a thread; kind is required. kind "subagent": ${kinds.subagent.description}${kinds.thread ? ` kind "thread": ${kinds.thread.description}` : ''}`,
    inputSchema: { type: 'object', properties: { kind: KIND_SCHEMA, ...mergedProperties(properties.subagent, properties.thread) }, required: ['kind'] },
    // A bot's thread lists the thread kind only, as a bot uses it (`asBotTool`).
    ...(kinds.thread ? { botDescription: kinds.thread.botDescription ?? kinds.thread.description, botInputSchema: kinds.thread.botInputSchema ?? kinds.thread.inputSchema, botClass: kinds.thread.class } : {}),
    kinds: {
      declarations: declarations as Record<string, MousseTool>,
      of: (args, { caller, turn, toolCallId }) => {
        if (args.kind !== undefined && args.kind !== 'subagent' && args.kind !== 'thread') throw new Error('kind must be "subagent" or "thread".')
        const older = args.kind === undefined ? olderCall(args, { caller, turn, toolCallId }, host, engine) : undefined
        const kind: ThreadCreateKind = older?.kind ?? (args.kind as ThreadCreateKind)
        const call = older?.args ?? args
        if (turn.bot && kind === 'subagent') throw new Error('A bot starts its subagents with subagent_start, and its work with work_start: thread_create starts threads (kind "thread").')
        if (!declarations[kind]) throw new Error(`kind "${kind}" is not available here.`)
        // An argument of the other kind only is a mistake about the kind, never one to drop.
        const other = kind === 'subagent' ? 'thread' : 'subagent'
        const foreign = Object.keys(call).filter((key) => key in properties[other] && !(key in properties[kind]))
        if (foreign.length) throw new Error(`${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} for kind "${other}", not "${kind}".`)
        return { kind, args: { ...call, kind } }
      }
    },
    handler: (args, ctx) => {
      const declaration = declarations[args.kind as ThreadCreateKind]
      if (!declaration) throw new Error('kind must be "subagent" or "thread".')
      return declaration.handler(args, ctx)
    }
  }
}

/**
 * The kind an older caller means when it names none, by what the call did before kinds: a thread, as it was. An agent's
 * thread it asked to hide (`hidden: true`) in its own project, with a first message, was its own work out of the person's
 * sight: that is a subagent now (#2004), unless a thread was made for this request already (a retry across the upgrade
 * finds it). Hidden anywhere else, it is still a thread, and the thread kind refuses an agent's `hidden`.
 */
function olderCall(args: Record<string, unknown>, ctx: { caller: { threadId: string }; turn: { bot?: unknown }; toolCallId: string }, host: Pick<AppToolHost, 'threadMeta'>, engine?: RunEngine): { kind: ThreadCreateKind; args?: Record<string, unknown> } {
  const message = typeof args.firstMessage === 'string' && args.firstMessage.trim() ? args.firstMessage : undefined
  const ownProject = typeof args.projectId === 'string' && args.projectId === host.threadMeta?.(ctx.caller.threadId)?.projectId
  if (ctx.turn.bot || args.hidden !== true || args.computer !== undefined || !message || !ownProject) return { kind: 'thread' }
  const request = typeof args.clientRequestId === 'string' && args.clientRequestId ? args.clientRequestId : ctx.toolCallId
  if (engine?.store.getReceipt(`thread_create:${ctx.caller.threadId}:${request}`)) return { kind: 'thread' }
  // A subagent reports back to its parent, so `notify` has nothing to add; `hidden` is what it is.
  const { projectId: _project, fromProjectId: _from, firstMessage: _message, workspace, mode, hidden: _hidden, notify: _notify, title, ...rest } = args
  const named = typeof title === 'string' && title.trim() ? title.trim() : message.trim().split('\n')[0].slice(0, 60)
  return {
    kind: 'subagent',
    args: { ...rest, prompt: message, title: named, workspace: workspace === 'new_worktree' ? 'isolated' : 'shared', ...(mode === 'plan' ? { modeCeiling: 'plan' } : {}) }
  }
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
