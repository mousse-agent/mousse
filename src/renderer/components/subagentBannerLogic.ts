import { isRunningSubagent, type SubagentSummary } from '../../shared/subagents'
import type { ThreadActivityState } from '../../shared/types'
import { lineageSubagentName } from './sideCard/lineageLogic'

/** How many subagent levels below the thread the banner looks for a question. */
export const BANNER_MAX_DEPTH = 3

export interface NeedingInput {
  childThreadId: string
  /** The subagent that asks. */
  title: string
  /** The subagent of this thread it belongs to, when it is deeper than a direct subagent. */
  via: string | null
}

/**
 * The subagents below `rootThreadId` that are waiting on an answer, from the lists the store holds,
 * nearest first. A subagent can start subagents of its own and one of those can ask, so the walk
 * follows every subagent that is still going, down to `BANNER_MAX_DEPTH` levels.
 */
export function collectNeedingInput(
  listsByParent: Readonly<Record<string, readonly SubagentSummary[]>>,
  rootThreadId: string | null | undefined,
  maxDepth = BANNER_MAX_DEPTH
): NeedingInput[] {
  if (!rootThreadId) return []
  const found: NeedingInput[] = []
  const visited = new Set<string>([rootThreadId])
  const walk = (parentId: string, depth: number, via: string | null): void => {
    for (const subagent of listsByParent[parentId] ?? []) {
      if (subagent.state === 'needs_input') {
        found.push({ childThreadId: subagent.childThreadId, title: lineageSubagentName(subagent), via })
      }
      if (depth < maxDepth && isRunningSubagent(subagent) && !visited.has(subagent.childThreadId)) {
        visited.add(subagent.childThreadId)
        walk(subagent.childThreadId, depth + 1, via ?? lineageSubagentName(subagent))
      }
    }
  }
  walk(rootThreadId, 1, null)
  return found
}

/**
 * Why a thread whose turn has ended is still Waiting: on its subagents when any are going,
 * otherwise on work its provider reports running in the background. Null when it is not Waiting.
 * This reads the thread's activity, the hook point for provider background work: nothing reports
 * it yet, and it shows here as soon as the daemon marks a thread with background work Waiting.
 */
export function waitingBannerLabel(activity: ThreadActivityState | undefined, subagents: readonly Pick<SubagentSummary, 'state'>[]): string | null {
  if (activity !== 'waiting') return null
  const running = subagents.filter(isRunningSubagent).length
  if (running === 0) return 'Waiting on background work'
  return `Waiting on ${running} ${running === 1 ? 'subagent' : 'subagents'}`
}

export interface ComposerBanner {
  asking: NeedingInput[]
  waiting: string | null
}

/** What the composer banner of `threadId` shows, from the store's subagent lists and the thread's activity. */
export function composerBanner(input: {
  lists: Readonly<Record<string, readonly SubagentSummary[]>>
  activity: ThreadActivityState | undefined
  threadId: string | null | undefined
}): ComposerBanner {
  const own = (input.threadId ? input.lists[input.threadId] : undefined) ?? []
  return { asking: collectNeedingInput(input.lists, input.threadId), waiting: waitingBannerLabel(input.activity, own) }
}

/** What a banner row says for a subagent that asks: its name, and which subagent of the thread it hangs under. */
export function needingInputLabel(entry: NeedingInput): string {
  return entry.via ? `${entry.title} has a question, via ${entry.via}` : `${entry.title} has a question`
}
