import { isRunningSubagent, type SubagentSummary } from '../../shared/subagents'
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

/** What a banner row says for a subagent that asks: its name, and which subagent of the thread it hangs under. */
export function needingInputLabel(entry: NeedingInput): string {
  return entry.via ? `${entry.title} has a question, via ${entry.via}` : `${entry.title} has a question`
}
