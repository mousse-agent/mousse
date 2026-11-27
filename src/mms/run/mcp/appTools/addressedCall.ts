import { ADDRESSED_TOOLS, addressReceiptKey, type AddressResolution, type AddressTarget, type ResolvedAddress } from '../../addressing'
import { refused } from './refusal'
import type { JsonSchema, ToolOutcome } from './types'

/**
 * The `thread` argument of the thread tools (docs/plans/tool-api.md §1.2 "Addressing"), as the registry turns it into
 * the ids the tools take, before any check: the checks and the handler see only `threadId` (or, for a Stop of several
 * subagents, `subagent`), so an address grants nothing an id would not.
 */

/** What the registry reads to resolve an address and keep what a retry key resolved it to (`index.ts`). */
export interface ThreadAddresses {
  resolve(callerThreadId: string, address: string, options: { many: boolean }): AddressResolution
  recorded(key: string): ResolvedAddress | undefined
  record(key: string, callerThreadId: string, resolved: ResolvedAddress): ResolvedAddress
}

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

/**
 * The call's arguments with its `thread` resolved (`record`: keep what a named address resolved to under the call's
 * retry key). A retry under a key that has a record never resolves the name again, and a key reused for another address
 * is refused. One target becomes `threadId`; several (`children`, `descendants`) come back in `resolved` for the
 * registry to call the tool once per target.
 */
export function addressedArgs(addresses: ThreadAddresses | undefined, tool: string, args: Record<string, unknown>, callerThreadId: string, toolCallId: string | undefined, record: boolean): AddressedArgs {
  const spec = ADDRESSED_TOOLS[tool]
  if (!spec || args.thread === undefined) return { args }
  const { thread, ...rest } = args
  if (typeof thread !== 'string' || !thread.trim()) return { refused: refused('invalid_arguments', 'thread must be a thread id or an address (self, parent, child:<title>, sibling:<title>, bot:<name>, or a title in your family).') }
  if (rest.threadId !== undefined || rest.subagent !== undefined || rest.delegationId !== undefined)
    return { refused: refused('invalid_arguments', 'Name the thread once: thread, or threadId, subagent or delegationId, not two of them.') }
  if (!addresses) return { args: { ...rest, threadId: thread.trim() } }
  const key = toolCallId ? addressReceiptKey(callerThreadId, tool, toolCallId) : undefined
  let resolved = key ? addresses.recorded(key) : undefined
  if (resolved && resolved.address !== thread.trim())
    return { refused: refused('conflict', `This clientRequestId was first used for thread "${resolved.address}", so it can't name "${thread.trim()}". Use a new clientRequestId for a new call.`, { data: { conflict: 'client_request_id_conflict' } }) }
  if (!resolved) {
    const resolution = addresses.resolve(callerThreadId, thread, { many: spec.many })
    if (!resolution.ok)
      return { refused: refused('invalid_arguments', resolution.message, { data: { reason: resolution.reason, address: thread.trim(), ...(resolution.candidates?.length ? { candidates: resolution.candidates } : {}) } }) }
    const { ok: _ok, ...found } = resolution
    const named = found.many || found.targets.length !== 1 || found.targets[0].kind !== 'thread' || found.targets[0].threadId !== found.address
    resolved = record && key && named ? addresses.record(key, callerThreadId, found) : found
  }
  if (resolved.many) return { args: rest, resolved }
  const [target] = resolved.targets
  if (target.kind === 'bot')
    return { refused: refused('unavailable', `${resolved.address} names a bot, and ${tool} does not reach bots yet: use bot_send to message another bot.`) }
  return { args: { ...rest, threadId: target.threadId }, resolved }
}

/**
 * The threads a call to several targets runs on, and its arguments for each: a Stop runs on your direct subagents only
 * (`subagent`: Stopping one stops what it delegated, deepest first), a send or a wait on every thread named.
 */
export function fanOutCalls(tool: string, args: Record<string, unknown>, resolved: ResolvedAddress): Array<{ target: Extract<AddressTarget, { kind: 'thread' }>; args: Record<string, unknown> }> {
  const threads = resolved.targets.filter((target): target is Extract<AddressTarget, { kind: 'thread' }> => target.kind === 'thread')
  if (tool === 'thread_stop') return threads.filter((target) => target.relation === 'child').map((target) => ({ target, args: { ...args, subagent: target.threadId } }))
  return threads.map((target) => ({ target, args: { ...args, threadId: target.threadId } }))
}

/** One target's outcome, as a row of the result of a call to several. */
export function fanOutRow(target: Extract<AddressTarget, { kind: 'thread' }>, outcome: ToolOutcome): Record<string, unknown> {
  let value: unknown = outcome.text
  try {
    value = JSON.parse(outcome.text)
  } catch {
    // Plain text stays as it is.
  }
  const row = { threadId: target.threadId, ...(target.title ? { title: target.title } : {}) }
  if (!outcome.isError) return { ...row, result: value }
  return { ...row, ...(value && typeof value === 'object' && 'refused' in value ? (value as Record<string, unknown>) : { refused: { code: 'failed', message: outcome.text } }) }
}
