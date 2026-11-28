import { ADDRESSED_TOOLS, addressReceiptKey, botReachSends, type AddressResolution, type AddressTarget, type BotReach, type FamilyMember, type ResolvedAddress, type ResolveOptions } from '../../addressing'
import { fitPage, makeCursor, pageEnd, readCursor } from './paging'
import { refused } from './refusal'
import type { JsonSchema, ToolOutcome } from './types'

/**
 * The `thread` argument of the thread tools (docs/plans/tool-api.md §1.2 "Addressing"), as the registry turns it into
 * the ids the tools take, before any check: the checks and the handler see only `threadId` (or, for a Stop of several
 * subagents, `subagent`), so an address grants nothing an id would not.
 */

/** What the registry reads to resolve an address and keep what a retry key named (`index.ts`). */
export interface ThreadAddresses {
  resolve(callerThreadId: string, address: string, options: ResolveOptions): AddressResolution
  recorded(key: string): ResolvedAddress | undefined
  record(key: string, callerThreadId: string, resolved: ResolvedAddress): ResolvedAddress
  /** The caller's family, itself first (`familyOf`). */
  family?(callerThreadId: string): { members: FamilyMember[]; complete: boolean }
  /** The thread of the caller's subagent named by title, childThreadId or delegationId, as `task_status` reads it. */
  subagentOf?(callerThreadId: string, ref: string): string | undefined
}

type ThreadTarget = Extract<AddressTarget, { kind: 'thread' }>

const ONE = 'Instead of threadId: the thread by address. self; parent; child:<title> (your subagent); sibling:<title>; bot:<name>; the title of a thread of your family (your parent, siblings, subagents at any depth, and the helpers their runtimes started); or an id. A title that two of them share, or no one has, is refused with the candidates. An address only names a thread: what you may do there is decided as for its id. A retry with the same clientRequestId reaches the same thread, even after a rename.'
const MANY = `${ONE} children (your subagents) or descendants (every subagent below you) send to, stop or wait on each of them, and return one result per thread.`

const addressed = new WeakMap<object, JsonSchema>()

/** `schema` with `thread` among its properties, for a tool that takes an address; `threadId` is then not required. */
export function withAddress<T extends JsonSchema | undefined>(tool: string, schema: T): T {
  const spec = ADDRESSED_TOOLS[tool]
  if (!spec || !schema || typeof schema !== 'object') return schema
  const { properties, required } = schema as { properties?: Record<string, JsonSchema>; required?: string[] }
  if ((schema as { type?: unknown }).type !== 'object' || properties?.thread) return schema
  let out = addressed.get(schema)
  if (!out) {
    out = {
      ...schema,
      properties: { thread: { type: 'string', description: spec.many ? MANY : ONE }, ...(properties ?? {}) },
      ...(required ? { required: required.filter((name) => name !== 'threadId') } : {})
    } as JsonSchema
    addressed.set(schema, out)
  }
  return out as T
}

export type AddressedArgs = { args: Record<string, unknown>; resolved?: ResolvedAddress } | { refused: ToolOutcome }

/** A call of an addressed tool, as `addressedArgs` reads it. */
export interface AddressedCall {
  addresses: ThreadAddresses | undefined
  tool: string
  args: Record<string, unknown>
  callerThreadId: string
  /** The call's retry key; absent, nothing is recorded or looked up. */
  toolCallId: string | undefined
  /** The tool changes something: what the call names is recorded under its key. */
  record: boolean
  visible?(threadId: string): boolean
  bots: BotReach
}

/**
 * The thread a call names the older way (`threadId`, `subagent`, `delegationId`), as its receipt records it. A subagent
 * named by title or delegationId records its thread, so the same request under another name (`thread_send` to its id,
 * `continue_subagent` by its title) reaches it under one key.
 */
function olderForm(args: Record<string, unknown>, subagentOf: (ref: string) => string | undefined): ResolvedAddress | undefined {
  const value = (key: string) => (typeof args[key] === 'string' && (args[key] as string).trim() ? (args[key] as string).trim() : undefined)
  const threadId = value('threadId')
  if (threadId) return { form: 'threadId', address: threadId, targets: [{ kind: 'thread', threadId }], many: false }
  for (const form of ['subagent', 'delegationId'] as const) {
    const named = value(form)
    if (!named) continue
    // Resolved by its tool; one that names none of the caller's subagents has no targets, so only the same words reuse its key.
    const threadId = subagentOf(named)
    return { form, address: named, targets: threadId ? [{ kind: 'thread', threadId }] : [], many: false }
  }
  return undefined
}

const targetSet = (resolved: ResolvedAddress): string => resolved.targets.map((target) => (target.kind === 'thread' ? `thread:${target.threadId}` : `bot:${target.botId}`)).sort().join('\n')

/** Whether a call that reuses a key names what its first call named: the same words, or the same set of threads. */
function sameTargets(earlier: ResolvedAddress, now: ResolvedAddress): boolean {
  if ((earlier.form ?? 'thread') === (now.form ?? 'thread') && earlier.address === now.address) return true
  if (!earlier.targets.length || !now.targets.length) return false
  return targetSet(earlier) === targetSet(now)
}

function keyConflict(earlier: ResolvedAddress): ToolOutcome {
  return refused('conflict', 'This clientRequestId was first used for other threads, so it can\'t name these. Use a new clientRequestId for a new call.', { data: { conflict: 'client_request_id_conflict' } })
}

/**
 * The call's arguments with its `thread` resolved. A tool that changes something records what each call names under the
 * call's retry key, by address or by id: a retry with the same words never resolves a name again, and one in other
 * words must name the same set of threads, else it is `client_request_id_conflict`, so a key never widens from one
 * recipient to several. One target becomes `threadId`; several (`children`, `descendants`) come back in `resolved` for
 * the registry to call the tool once per target.
 */
export function addressedArgs(call: AddressedCall): AddressedArgs {
  const { addresses, tool, args, callerThreadId, toolCallId, record } = call
  const spec = ADDRESSED_TOOLS[tool]
  if (!spec) return { args }
  // A bot is named only by address (`bot:<name>`), so what the call names is resolved and recorded under its key; `bot`
  // is what that resolving gives the call, never an argument.
  if (tool === 'thread_send' && args.bot !== undefined)
    return { refused: refused('invalid_arguments', 'Name the bot as thread "bot:<name>", not with bot.') }
  const key = addresses && toolCallId ? addressReceiptKey(callerThreadId, tool, toolCallId) : undefined
  const earlier = key ? addresses!.recorded(key) : undefined
  if (args.thread === undefined) {
    if (!key) return { args }
    const named = olderForm(args, (ref) => addresses!.subagentOf?.(callerThreadId, ref))
    if (!named) return { args }
    if (earlier) return sameTargets(earlier, named) ? { args } : { refused: keyConflict(earlier) }
    if (record) addresses!.record(key, callerThreadId, named)
    return { args }
  }
  const { thread, ...rest } = args
  if (typeof thread !== 'string' || !thread.trim()) return { refused: refused('invalid_arguments', 'thread must be a thread id or an address (self, parent, child:<title>, sibling:<title>, bot:<name>, or a title in your family).') }
  if (rest.threadId !== undefined || rest.subagent !== undefined || rest.delegationId !== undefined)
    return { refused: refused('invalid_arguments', 'Name the thread once: thread, or threadId, subagent or delegationId, not two of them.') }
  const address = thread.trim()
  if (!addresses) return { args: { ...rest, threadId: address } }
  let resolved = earlier && (earlier.form ?? 'thread') === 'thread' && earlier.address === address ? earlier : undefined
  if (!resolved) {
    const resolution = addresses.resolve(callerThreadId, address, { many: spec.many, ...(call.visible ? { visible: call.visible } : {}), bots: call.bots })
    if (!resolution.ok)
      return { refused: refused('invalid_arguments', resolution.message, { data: { reason: resolution.reason, address, ...(resolution.candidates?.length ? { candidates: resolution.candidates } : {}) } }) }
    const { ok: _ok, ...found } = resolution
    const now: ResolvedAddress = { form: 'thread', ...found }
    if (earlier && !sameTargets(earlier, now)) return { refused: keyConflict(earlier) }
    // A key whose first call named the same threads in other words runs as that call did, under the same keys.
    resolved = earlier ?? (record && key ? addresses.record(key, callerThreadId, now) : now)
  }
  if (resolved.many) return { args: rest, resolved }
  const [target] = resolved.targets
  if (target?.kind === 'bot') {
    // A message to a bot the caller may send to (`botReachSends`) is `bot_send` (`variantOf`), with the bot's id the
    // address recorded, so a retry reaches the same bot after a rename.
    if (tool === 'thread_send' && botReachSends(call.bots)) return { args: { ...rest, bot: target.botId }, resolved }
    if (botReachSends(call.bots)) return { refused: refused('unavailable', `${resolved.address} names a bot, and ${tool} does not reach bots: send it a message with thread_send.`) }
    return { refused: refused('unavailable', `${resolved.address} names a bot, and ${tool} does not reach bots yet: use bot_send to message another bot.`) }
  }
  return { args: { ...rest, threadId: target.threadId }, resolved }
}

/**
 * The threads a call to several targets runs on, and its arguments for each: a Stop runs on your direct subagents only
 * (`subagent`: Stopping one stops what it delegated, deepest first), a send or a wait on every thread named.
 */
export function fanOutCalls(tool: string, args: Record<string, unknown>, resolved: ResolvedAddress): Array<{ target: ThreadTarget; args: Record<string, unknown> }> {
  const threads = resolved.targets.filter((target): target is ThreadTarget => target.kind === 'thread')
  if (tool === 'thread_stop') return threads.filter((target) => target.relation === 'child').map((target) => ({ target, args: { ...args, subagent: target.threadId } }))
  return threads.map((target) => ({ target, args: { ...args, threadId: target.threadId } }))
}

/** A refusal that names no thread: what the caller is told about a target it can't read by id. */
export const OUT_OF_REACH: ToolOutcome = refused('scope_denied', 'A thread at this address is out of your reach.')

const named = (target: ThreadTarget, visible: boolean) => (visible ? { threadId: target.threadId, ...(target.title ? { title: target.title } : {}) } : {})

/** One target's outcome, as a row of the result of a call to several. A target the caller can't see is not named. */
export function fanOutRow(target: ThreadTarget, outcome: ToolOutcome, visible: boolean): Record<string, unknown> {
  const shown = !outcome.isError || visible ? outcome : OUT_OF_REACH
  let value: unknown = shown.text
  try {
    value = JSON.parse(shown.text)
  } catch {
    // Plain text stays as it is.
  }
  if (!shown.isError) return { ...named(target, visible), result: value }
  return { ...named(target, visible), ...(value && typeof value === 'object' && 'refused' in value ? (value as Record<string, unknown>) : { refused: { code: 'failed', message: shown.text } }) }
}

/** A target the call never reached: it was cancelled first. */
export function notSentRow(target: ThreadTarget, visible: boolean): Record<string, unknown> {
  return { ...named(target, visible), status: 'not_sent', note: 'The call was cancelled before it reached this thread.' }
}

/**
 * The rows of a call to several targets in the order the address recorded them. A Stop's subagent further down has no
 * call of its own: its row says the Stop of the subagent above it covered it, or did not.
 */
export function fanOutRows(resolved: ResolvedAddress, rows: ReadonlyMap<string, Record<string, unknown>>, visible: (threadId: string) => boolean): Array<Record<string, unknown>> {
  const threads = resolved.targets.filter((target): target is ThreadTarget => target.kind === 'thread')
  const byId = new Map(threads.map((target) => [target.threadId, target]))
  return threads.map((target) => {
    const own = rows.get(target.threadId)
    if (own) return own
    let above = target.parentThreadId ? byId.get(target.parentThreadId) : undefined
    while (above && !rows.has(above.threadId)) above = above.parentThreadId ? byId.get(above.parentThreadId) : undefined
    const row = above ? rows.get(above.threadId) : undefined
    const stopped = row !== undefined && 'result' in row
    return {
      ...named(target, visible(target.threadId)),
      status: stopped ? 'stopped' : 'not_stopped',
      note: stopped ? 'Stopped with the subagent above it, which stops what it delegated.' : 'The Stop of the subagent above it did not go ahead.'
    }
  })
}

/** The most rows of a family page (`thread_list scope: family`), and how many when the call names no limit. */
const FAMILY_PAGE_MAX = 500
const FAMILY_PAGE_DEFAULT = 100
const FAMILY_PAGE_MAX_BYTES = 64 * 1024

/**
 * `thread_list scope: family` (docs/plans/tool-api.md §1.2 "Family"): the caller, then its parent, siblings, subagents at
 * any depth and the native helpers of all of these, one row each with its relation and the thread it sits under. A row
 * of one of the caller's own subagents carries what `list_subagents` says of it (`subagents`, that call's result). Only
 * the threads the caller may read by id are listed. The cursor continues after the last row it returned, wherever that
 * row is now; `complete` is false while there are more pages, and when the tree goes deeper than is followed.
 */
export function familyPage(
  family: { members: FamilyMember[]; complete: boolean },
  subagents: ToolOutcome,
  visible: (threadId: string) => boolean,
  callerThreadId: string,
  args: Record<string, unknown>
): ToolOutcome {
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > FAMILY_PAGE_MAX))
    return refused('invalid_arguments', `limit must be a whole number from 1 to ${FAMILY_PAGE_MAX}.`)
  const cursor = readCursor(callerThreadId, 'thread_list', args)
  if ('refused' in cursor) return cursor.refused
  const detail = new Map<string, Record<string, unknown>>()
  try {
    const rows: unknown = subagents.isError ? undefined : JSON.parse(subagents.text)
    if (Array.isArray(rows)) for (const row of rows) if (row && typeof row === 'object' && typeof row.childThreadId === 'string') detail.set(row.childThreadId, row as Record<string, unknown>)
  } catch {
    // Rows without their subagent details.
  }
  const rows = family.members
    .filter((member) => member.relation === 'self' || visible(member.threadId))
    .map((member) => ({ ...detail.get(member.threadId), thread: member.threadId, title: member.title, relation: member.relation, ...(member.parentThreadId ? { parentThread: member.parentThreadId } : {}) }))
  const at = cursor.position
  const after = typeof at?.t === 'string' ? rows.findIndex((row) => row.thread === at.t) : -1
  const from = after >= 0 ? after + 1 : typeof at?.o === 'number' && Number.isInteger(at.o) && at.o >= 0 ? at.o : 0
  const limit = typeof args.limit === 'number' ? args.limit : FAMILY_PAGE_DEFAULT
  const { taken } = fitPage(rows.slice(from, from + limit), {}, FAMILY_PAGE_MAX_BYTES)
  const next = from + taken.length
  const end = pageEnd(next < rows.length, () => makeCursor(callerThreadId, 'thread_list', args, { o: next, t: taken.at(-1)?.thread }))
  return {
    text: JSON.stringify({
      items: taken,
      nextCursor: end.nextCursor,
      complete: end.complete && family.complete,
      ...(family.complete ? {} : { note: 'Your subagents delegate deeper than this list follows: read a subagent\'s own family for the rest.' })
    })
  }
}
