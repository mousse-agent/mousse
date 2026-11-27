import { parseQualifiedId } from '../../shared/threadRef'
import { normalizeSubagentTitle } from './delegation/subagentAddress'

/**
 * Thread addresses (docs/plans/tool-api.md §1.2 "Addressing"): what the `thread` argument of the thread tools names. An
 * address only names a target; it grants nothing. Every target it resolves to still goes through the tool's own checks.
 *
 * - an id of this computer, or a qualified `<computer id>:<thread id>`, which keeps the remote rules;
 * - `self`, `parent`, `child:<title>`, `sibling:<title>`, `bot:<name>`;
 * - `children` and `descendants`, on the tools that take several targets (send, stop, wait);
 * - a bare title, which resolves only inside the caller's family.
 */

/** The words that are addresses by themselves. */
export const RESERVED_ADDRESS_WORDS = ['self', 'parent', 'children', 'descendants'] as const
/** The prefixes that start an address. */
export const RESERVED_ADDRESS_PREFIXES = ['child', 'sibling', 'bot'] as const

const PREFIXED = /^\s*(child|sibling|bot)\s*:\s*(.*)$/is
/** How deep the descendants are followed, as the family is (`family.ts`). */
const MAX_DEPTH = 32
/** How many candidates a refusal lists. */
const LISTED = 12

/** How a thread sits in the caller's family. */
export type AddressRelation = 'self' | 'parent' | 'sibling' | 'child' | 'descendant' | 'native'

export type AddressTarget =
  /** `parentThreadId`: a descendant's parent, so a Stop of the subagent above it can account for it. */
  | { kind: 'thread'; threadId: string; title?: string; relation?: AddressRelation; parentThreadId?: string }
  | { kind: 'bot'; botId: string; name: string }

/**
 * Which bots `bot:` may name for a caller: `others`, the owner's other bots, for a bot turn that holds `bot_send`; `own`,
 * the bot that started the caller's thread, for any other thread (no read of the bots' store); `none` otherwise.
 */
export type BotReach = 'others' | 'own' | 'none'

/** How a call resolves: several targets allowed or not, which threads the caller may see named, which bots it reaches. */
export interface ResolveOptions {
  many: boolean
  /** Whether the caller may read the thread by id. A thread it can't is never matched by title nor listed as a candidate. */
  visible?(threadId: string): boolean
  bots?: BotReach
}

export interface AddressCandidate {
  threadId?: string
  botId?: string
  title: string
  relation?: AddressRelation | 'bot'
}

/**
 * What a call named and resolved to: `many` for `children` and `descendants`, which may be any number of targets. `form`
 * is the argument it was named by (`thread`, or the older `threadId`, `subagent`, `delegationId`); a `subagent` or
 * `delegationId` is resolved by its tool, so its record has no targets.
 */
export interface ResolvedAddress {
  form?: 'thread' | 'threadId' | 'subagent' | 'delegationId'
  address: string
  targets: AddressTarget[]
  many: boolean
}

export type AddressResolution =
  | ({ ok: true } & ResolvedAddress)
  | { ok: false; reason: 'unknown_address' | 'ambiguous_address' | 'not_for_this_tool' | 'no_parent'; message: string; candidates?: AddressCandidate[] }

/** What resolving reads, at call time. */
export interface AddressSources {
  /** The thread's parent when it is a subagent. */
  parentOf(threadId: string): string | undefined
  /** The thread's direct subagents that still exist, with their titles, oldest first. */
  childrenOf(threadId: string): Array<{ threadId: string; title: string }>
  /** The mirror threads of the native helpers the thread's runs started. */
  helpersOf?(threadId: string): Array<{ threadId: string; title: string }>
  titleOf(threadId: string): string | undefined
  /** A thread of this computer has this id. */
  exists(threadId: string): boolean
  /** The bots the caller may reach as `reach` says; never called for `none`. */
  botsFor?(callerThreadId: string, reach: Exclude<BotReach, 'none'>): Array<{ botId: string; name: string }>
}

/** The reserved word or prefix `title` is or starts with; a subagent may not be titled so. Undefined when it is free. */
export function reservedAddressTitle(title: string): string | undefined {
  const prefixed = PREFIXED.exec(title)
  if (prefixed) return `${prefixed[1].toLowerCase()}:`
  const word = normalizeSubagentTitle(title)
  return (RESERVED_ADDRESS_WORDS as readonly string[]).includes(word) ? word : undefined
}

/** Whether `value` is an address that has to be resolved, rather than an id that names its thread as it is. */
export function isNamedAddress(value: string, sources: Pick<AddressSources, 'exists'>): boolean {
  return parseQualifiedId(value) === undefined && !sources.exists(value.trim())
}

/** A member of a thread's family, with the thread it sits under (none for the parent). */
export interface FamilyMember {
  threadId: string
  title: string
  relation: AddressRelation
  parentThreadId?: string
}

/**
 * The family of `threadId` (§1.2 "Family"), itself excluded: its parent, its siblings, its descendants at any depth, and
 * the native helpers of all of these and of itself. Parent and siblings first, then the tree below, breadth first.
 * `complete` is false when the tree goes deeper than is followed, so some descendants are left out.
 */
export function familyOf(sources: AddressSources, threadId: string): { members: FamilyMember[]; complete: boolean } {
  const out: FamilyMember[] = []
  const seen = new Set([threadId])
  const add = (id: string, title: string, relation: AddressRelation, parentThreadId?: string) => {
    if (seen.has(id)) return
    seen.add(id)
    out.push({ threadId: id, title, relation, ...(parentThreadId ? { parentThreadId } : {}) })
  }
  const parent = sources.parentOf(threadId)
  if (parent) {
    add(parent, sources.titleOf(parent) ?? '', 'parent')
    for (const sibling of sources.childrenOf(parent)) add(sibling.threadId, sibling.title, 'sibling', parent)
  }
  let complete = true
  for (const member of descendants(sources, threadId, () => (complete = false))) add(member.threadId, member.title, member.relation, member.parentThreadId)
  for (const member of [{ threadId }, ...out.filter((member) => member.relation !== 'native')])
    for (const helper of sources.helpersOf?.(member.threadId) ?? []) add(helper.threadId, helper.title, 'native', member.threadId)
  return { members: out, complete }
}

/** `familyOf`'s members. */
export function familyMembers(sources: AddressSources, threadId: string): FamilyMember[] {
  return familyOf(sources, threadId).members
}

/** The subagents below `threadId`, breadth first: its children, then theirs. */
function descendants(sources: AddressSources, threadId: string, cut?: () => void): Array<{ threadId: string; title: string; relation: 'child' | 'descendant'; parentThreadId: string }> {
  const out: Array<{ threadId: string; title: string; relation: 'child' | 'descendant'; parentThreadId: string }> = []
  let level = [threadId]
  const seen = new Set(level)
  for (let depth = 0; level.length && depth < MAX_DEPTH; depth += 1) {
    const next: string[] = []
    for (const id of level)
      for (const child of sources.childrenOf(id)) {
        if (seen.has(child.threadId)) continue
        seen.add(child.threadId)
        out.push({ ...child, relation: depth === 0 ? 'child' : 'descendant', parentThreadId: id })
        next.push(child.threadId)
      }
    level = next
  }
  if (cut && level.some((id) => sources.childrenOf(id).length > 0)) cut()
  return out
}

const quoted = (titles: string[]): string => titles.slice(0, LISTED).map((title) => `"${title}"`).join(', ') + (titles.length > LISTED ? ', ...' : '')

function unknown(message: string, candidates: AddressCandidate[]): AddressResolution {
  return { ok: false, reason: 'unknown_address', message, candidates: candidates.slice(0, LISTED) }
}

function thread(threadId: string, title: string | undefined, relation: AddressRelation): AddressTarget {
  return { kind: 'thread', threadId, ...(title ? { title } : {}), relation }
}

/** Matches by title among `members`: one target, an ambiguity, or an unknown name with the titles there are. */
function byTitle(address: string, name: string, members: Array<{ threadId: string; title: string; relation: AddressRelation }>, where: string): AddressResolution {
  const wanted = normalizeSubagentTitle(name)
  const matches = members.filter((member) => normalizeSubagentTitle(member.title) === wanted)
  const candidates = (list: typeof members) => list.map(({ threadId, title, relation }) => ({ threadId, title, relation }))
  if (matches.length === 1) return { ok: true, address, targets: [thread(matches[0].threadId, matches[0].title, matches[0].relation)], many: false }
  if (matches.length > 1)
    return { ok: false, reason: 'ambiguous_address', message: `"${name}" is the title of more than one thread of ${where}: ${matches.map((match) => `your ${match.relation} ${match.threadId}`).join(', ')}. Name one by its id, or with child: or sibling:.`, candidates: candidates(matches) }
  const titled = members.filter((member) => member.title)
  return unknown(
    titled.length ? `No thread of ${where} is titled "${name}". There: ${quoted(titled.map((member) => member.title))}. A thread outside your family is named by its id.` : `No thread of ${where} is titled "${name}"; there is none. A thread outside your family is named by its id.`,
    candidates(titled)
  )
}

/**
 * Resolves `address` for `callerThreadId`. `many`: the tool takes several targets (send, stop, wait), so `children` and
 * `descendants` resolve; elsewhere they are refused. An id resolves to itself unchecked: the tool's own checks decide.
 */
export function resolveAddress(sources: AddressSources, callerThreadId: string, rawAddress: string, options: ResolveOptions): AddressResolution {
  // A thread the caller can't read by id is never matched by title nor named as a candidate: a refusal discloses nothing.
  const seen = <T extends { threadId: string }>(members: T[]): T[] => (options.visible ? members.filter((member) => member.threadId === callerThreadId || options.visible!(member.threadId)) : members)
  const address = rawAddress.trim()
  if (!address) return unknown('thread must name a thread: an id, self, parent, child:<title>, sibling:<title>, bot:<name> or the title of a thread of your family.', [])
  if (!isNamedAddress(address, sources)) return { ok: true, address, targets: [{ kind: 'thread', threadId: address }], many: false }
  const word = address.toLowerCase()
  if (word === 'self') return { ok: true, address, targets: [thread(callerThreadId, sources.titleOf(callerThreadId), 'self')], many: false }
  if (word === 'parent') {
    const parent = sources.parentOf(callerThreadId)
    return parent
      ? { ok: true, address, targets: [thread(parent, sources.titleOf(parent), 'parent')], many: false }
      : { ok: false, reason: 'no_parent', message: 'This thread is not a subagent, so it has no parent thread.' }
  }
  if (word === 'children' || word === 'descendants') {
    if (!options.many) return { ok: false, reason: 'not_for_this_tool', message: `${word} names several threads, which only thread_send, thread_stop and thread_wait take. Name one thread.` }
    const below = descendants(sources, callerThreadId).filter((member) => word === 'descendants' || member.relation === 'child')
    return { ok: true, address, targets: below.map((member) => ({ ...thread(member.threadId, member.title, member.relation), ...(member.relation === 'descendant' ? { parentThreadId: member.parentThreadId } : {}) })), many: true }
  }
  const prefixed = PREFIXED.exec(address)
  if (prefixed) {
    const [, prefix, name] = prefixed
    if (!name.trim()) return unknown(`${prefix.toLowerCase()}: needs a name after it.`, [])
    switch (prefix.toLowerCase()) {
      case 'child':
        return byTitle(address, name, seen(sources.childrenOf(callerThreadId)).map((child) => ({ ...child, relation: 'child' as const })), 'your subagents')
      case 'sibling': {
        const parent = sources.parentOf(callerThreadId)
        if (!parent) return { ok: false, reason: 'no_parent', message: 'This thread is not a subagent, so it has no siblings.' }
        return byTitle(address, name, seen(sources.childrenOf(parent)).filter((child) => child.threadId !== callerThreadId).map((child) => ({ ...child, relation: 'sibling' as const })), 'your siblings')
      }
      default: {
        const reach = options.bots ?? 'none'
        const bots = reach === 'none' ? [] : sources.botsFor?.(callerThreadId, reach) ?? []
        const wanted = name.replace(/\s+/g, ' ').trim().toLowerCase()
        const matches = bots.filter((bot) => bot.botId === name.trim() || bot.name.replace(/\s+/g, ' ').trim().toLowerCase() === wanted)
        const candidates = bots.map((bot) => ({ botId: bot.botId, title: bot.name, relation: 'bot' as const }))
        if (matches.length === 1) return { ok: true, address, targets: [{ kind: 'bot', botId: matches[0].botId, name: matches[0].name }], many: false }
        if (matches.length > 1) return { ok: false, reason: 'ambiguous_address', message: `More than one bot you may reach is named "${name.trim()}".`, candidates: matches.map((bot) => ({ botId: bot.botId, title: bot.name, relation: 'bot' as const })) }
        return unknown(bots.length ? `No bot you may reach is named "${name.trim()}". You may reach: ${quoted(bots.map((bot) => bot.name))}.` : `No bot you may reach is named "${name.trim()}"; you may reach none.`, candidates)
      }
    }
  }
  const self = sources.titleOf(callerThreadId)
  return byTitle(address, address, [...(self !== undefined ? [{ threadId: callerThreadId, title: self, relation: 'self' as const }] : []), ...seen(familyMembers(sources, callerThreadId))], 'your family')
}

/** The receipt kind that keeps what an address resolved to under a retry key. */
export const ADDRESS_RECEIPT_KIND = 'thread_address'

/** The tools whose `thread` takes an address, and whether it may name several threads. */
export const ADDRESSED_TOOLS: Readonly<Record<string, { many: boolean }>> = Object.freeze({
  thread_send: { many: true },
  thread_stop: { many: true },
  thread_wait: { many: true },
  thread_read: { many: false },
  thread_update: { many: false },
  thread_archive: { many: false }
})

/** The receipt key of a call's address: the caller, the canonical tool and the call's retry key. */
export function addressReceiptKey(callerThreadId: string, tool: string, toolCallId: string): string {
  return `${ADDRESS_RECEIPT_KIND}:${callerThreadId}:${tool}:${toolCallId}`
}

/** What keeps address receipts: the run store's receipts, which outlive a restart. */
export interface AddressReceiptStore {
  getReceipt(clientRequestId: string): { commandKind: string; result: unknown } | null
  putReceipt(record: { clientRequestId: string; threadId: string; commandKind: string; status: 'accepted'; result: unknown; createdAt: string }): unknown
}

/** What a retry key's first call resolved its address to, or undefined. */
export function recordedAddress(store: AddressReceiptStore, key: string): ResolvedAddress | undefined {
  const receipt = store.getReceipt(key)
  return receipt?.commandKind === ADDRESS_RECEIPT_KIND ? (receipt.result as ResolvedAddress) : undefined
}

/** Records `resolved` under `key` unless the key has a record already; returns the record that holds. */
export function recordAddress(store: AddressReceiptStore, key: string, callerThreadId: string, resolved: ResolvedAddress, now = new Date().toISOString()): ResolvedAddress {
  const earlier = recordedAddress(store, key)
  if (earlier) return earlier
  const result: ResolvedAddress = { form: resolved.form ?? 'thread', address: resolved.address, targets: resolved.targets, many: resolved.many }
  store.putReceipt({ clientRequestId: key, threadId: callerThreadId, commandKind: ADDRESS_RECEIPT_KIND, status: 'accepted', result, createdAt: now })
  return result
}
