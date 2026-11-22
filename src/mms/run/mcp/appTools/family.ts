import { isNativeHelperThread } from '../../../../shared/threadLineage'
import type { RunEngine } from '../../RunEngine'
import type { AppToolHost } from './host'
import { McpToolError, type FamilyRelation, type McpCaller, type MessageIntent, type MousseTool, type ToolScope } from './types'

/** How far up a chain of parents the family is followed; deeper chains are not family. */
const FAMILY_MAX_DEPTH = 32

/** What the family is read from, at call time. */
export interface FamilyLookup {
  /** The thread's parent when it is a Mousse subagent, or undefined. */
  parentOf(threadId: string): string | undefined
  /** The thread whose run hosts it, when the thread is a native helper's mirror; undefined for any other thread. */
  nativeHostOf(threadId: string): string | undefined
}

/**
 * The family as the thread owner records it: a subagent's parent from the run store's lineage (or the thread's own
 * record), a mirror's hosting thread from its thread record (the run store has no lineage row for a mirror).
 */
export function threadFamily(host: Pick<AppToolHost, 'threadMeta'>, engine: Pick<RunEngine, 'delegations'>): FamilyLookup {
  return {
    parentOf: (threadId) => {
      const lineage = engine.delegations.getLineage(threadId)
      if (lineage?.relationship === 'subagent') return lineage.parentThreadId
      const thread = host.threadMeta?.(threadId)
      return thread?.lineage?.relationship === 'subagent' ? thread.lineage.parentThreadId : undefined
    },
    nativeHostOf: (threadId) => {
      const thread = host.threadMeta?.(threadId)
      return thread && isNativeHelperThread(thread) ? thread.lineage?.parentThreadId : undefined
    }
  }
}

/**
 * How `targetThreadId` sits in the caller's family (docs/plans/tool-api.md §1.2): the caller's parent, its siblings,
 * its descendants at any depth, and the native helpers of all of these and of the caller. Null for the caller itself
 * and for any thread outside the family (a grandparent, a cousin, an unrelated thread).
 */
export function familyRelation(lookup: FamilyLookup, callerThreadId: string, targetThreadId: string): FamilyRelation | null {
  if (callerThreadId === targetThreadId) return null
  const host = lookup.nativeHostOf(targetThreadId)
  if (host !== undefined) return host === callerThreadId || familyRelation(lookup, callerThreadId, host) !== null ? 'native' : null
  const callerParent = lookup.parentOf(callerThreadId)
  if (callerParent === targetThreadId) return 'parent'
  const targetParent = lookup.parentOf(targetThreadId)
  if (targetParent === callerThreadId) return 'child'
  if (callerParent !== undefined && targetParent === callerParent) return 'sibling'
  let current = targetParent
  for (let depth = 0; current !== undefined && depth < FAMILY_MAX_DEPTH; depth += 1) {
    if (current === callerThreadId) return 'descendant'
    current = lookup.parentOf(current)
  }
  return null
}

const RELATION_WORDS: Readonly<Record<FamilyRelation, string>> = {
  parent: 'your parent',
  child: 'your subagent',
  sibling: 'a sibling of yours',
  descendant: 'a subagent below your subagents',
  native: 'a helper its runtime started'
}

export function familyWords(relation: FamilyRelation): string {
  return RELATION_WORDS[relation]
}

/**
 * Who may send a message to a thread of the caller's family (docs/plans/tool-api.md §2.1 `thread_send`): a note goes
 * to any family member, from a read-only subagent too, because it grants nothing; work goes only from a thread's direct
 * parent. A native helper's mirror takes either, as nothing is sent to it (the result says which runtime tool reaches
 * the helper). Returns the scope, or undefined for a target outside the family, which today's rules decide.
 */
export function familyMessageScope(
  tool: Pick<MousseTool, 'name' | 'target'>,
  intent: MessageIntent,
  args: Record<string, unknown>,
  caller: McpCaller,
  family: ((caller: McpCaller, threadId: string) => FamilyRelation | null) | undefined
): ToolScope | undefined {
  if (!family) return undefined
  const target = tool.target ? tool.target(args, caller) : { threadId: args.threadId as string | undefined }
  const threadId = target?.threadId
  if (typeof threadId !== 'string' || !threadId || threadId === caller.threadId) return undefined
  let relation: FamilyRelation | null
  try {
    relation = family(caller, threadId)
  } catch {
    relation = null
  }
  if (relation === null) return undefined
  if (intent === 'work' && relation !== 'child' && relation !== 'native')
    throw new McpToolError('mousse_scope_denied', `Thread ${threadId} is ${familyWords(relation)}: only a thread's direct parent sends it work. Send it a note instead (intent "note"), which it reads as information.`, { fix: 'Send a note (intent "note").' })
  return relation === 'child' || relation === 'descendant' ? 'descendant' : 'ancestor_or_sibling'
}
