import { useEffect } from 'react'
import type { SubagentSummary } from '../../shared/subagents'
import { createSubagentsSync } from '../lib/subagentsSync'
import { useAppStore } from '../stores/appStore'

const NONE: SubagentSummary[] = []

const sync = createSubagentsSync({
  list: (threadId) => window.mousse.subagents.list(threadId),
  onUpdated: (cb) => window.mousse.subagents.onUpdated(cb),
  apply: (threadId, subagents) => useAppStore.getState().setSubagents(threadId, subagents)
})

/** The list the store holds for `threadId`; one shared empty array until the daemon has answered. */
export function selectSubagents(state: { subagentsByParent: Record<string, SubagentSummary[]> }, threadId: string | null | undefined): SubagentSummary[] {
  return (threadId ? state.subagentsByParent[threadId] : undefined) ?? NONE
}

/** The subagents `threadId` started, refreshed as the daemon reports changes. Empty until the first reply. */
export function useSubagents(threadId: string | null | undefined): SubagentSummary[] {
  const profileId = useAppStore((s) => s.profileId)
  useEffect(() => (threadId ? sync.watch(threadId) : undefined), [threadId, profileId])
  return useAppStore((s) => selectSubagents(s, threadId))
}
