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

/** The subagents `threadId` started, refreshed as the daemon reports changes. Empty until the first reply. */
export function useSubagents(threadId: string | null | undefined): SubagentSummary[] {
  const profileId = useAppStore((s) => s.profileId)
  useEffect(() => (threadId ? sync.watch(threadId) : undefined), [threadId, profileId])
  return useAppStore((s) => (threadId ? s.subagentsByParent[threadId] ?? NONE : NONE))
}
