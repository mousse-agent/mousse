import type { Delegations } from '../Delegations'
import type { DelegationRecord } from '../types'

/** Titles are compared trimmed, with runs of spaces collapsed, ignoring case. */
export function normalizeSubagentTitle(title: string): string {
  return title.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** How many titles a refusal lists, so a long roster stays readable. */
const LISTED_TITLES = 12

export type SubagentResolution =
  | { ok: true; childThreadId: string; title: string; delegation?: DelegationRecord }
  | { ok: false; code: 'unknown_subagent' | 'ambiguous_subagent' | 'subagent_trashed'; message: string; candidates?: string[] }

/** What resolving a name needs: the lineage and delegation rows, and a thread's title (undefined once trashed or gone). */
export interface SubagentAddressSources {
  delegations: Delegations
  titleOf(threadId: string): string | undefined
}

/** The caller's subagents that still exist, oldest first. */
export function visibleSubagents(sources: SubagentAddressSources, parentThreadId: string): Array<{ threadId: string; title: string }> {
  const out: Array<{ threadId: string; title: string }> = []
  for (const lineage of sources.delegations.listChildThreads(parentThreadId)) {
    if (lineage.relationship !== 'subagent') continue
    const title = sources.titleOf(lineage.threadId)
    if (title !== undefined) out.push({ threadId: lineage.threadId, title })
  }
  return out
}

/** The caller's subagents titled `title` (normalized), as child thread ids. */
export function subagentsTitled(sources: SubagentAddressSources, parentThreadId: string, title: string): string[] {
  const wanted = normalizeSubagentTitle(title)
  return visibleSubagents(sources, parentThreadId).filter((child) => normalizeSubagentTitle(child.title) === wanted).map((child) => child.threadId)
}

/**
 * Finds the caller's direct subagent a model named: by `delegationId`, `childThreadId` or title, in
 * that order. Only children of `parentThreadId` resolve; another thread's subagent is unknown. A
 * subagent whose thread was trashed is reported as such when it was addressed by id (its title is
 * gone with it). Older duplicates of a title are `ambiguous_subagent`, listed by thread id.
 */
export function resolveSubagent(sources: SubagentAddressSources, parentThreadId: string, ref: string): SubagentResolution {
  const name = ref.trim()
  const children = sources.delegations.listChildThreads(parentThreadId).filter((lineage) => lineage.relationship === 'subagent')
  const byId = (childThreadId: string, delegation?: DelegationRecord): SubagentResolution => {
    const title = sources.titleOf(childThreadId)
    return title === undefined
      ? { ok: false, code: 'subagent_trashed', message: 'That subagent was deleted, and a deleted subagent cannot be continued. Start a new one with delegate_task.' }
      : { ok: true, childThreadId, title, ...(delegation ? { delegation } : {}) }
  }
  const delegation = sources.delegations.get(name)
  if (delegation && delegation.parentThreadId === parentThreadId) return byId(delegation.childThreadId, delegation)
  if (children.some((lineage) => lineage.threadId === name)) return byId(name)
  const matches = subagentsTitled(sources, parentThreadId, name)
  if (matches.length === 1) return { ok: true, childThreadId: matches[0], title: sources.titleOf(matches[0]) ?? name }
  if (matches.length > 1)
    return {
      ok: false,
      code: 'ambiguous_subagent',
      message: `More than one of your subagents is titled "${name}". Address one by its childThreadId.`,
      candidates: matches
    }
  const titles = visibleSubagents(sources, parentThreadId).map((child) => child.title)
  return {
    ok: false,
    code: 'unknown_subagent',
    message: titles.length
      ? `You have no subagent titled "${name}". Your subagents: ${titles.slice(0, LISTED_TITLES).map((title) => `"${title}"`).join(', ')}${titles.length > LISTED_TITLES ? ', ...' : ''}.`
      : `You have no subagent titled "${name}"; you have not started any. Start one with delegate_task.`
  }
}
