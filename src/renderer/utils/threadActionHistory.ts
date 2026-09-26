import type { ChangeReceipt, ThreadAction } from '../../shared/threadActions'
import type { UndoRetentionPolicy } from '../../shared/undoRetention'
import { useAppStore } from '../stores/appStore'

export interface ThreadActionHistory {
  actions: ThreadAction[]
  receipts: ChangeReceipt[]
  journalGeneration: number
  activeBranchId?: string
  retentionPolicy?: UndoRetentionPolicy
}
const reads = new Map<string, { at: number; promise: Promise<ThreadActionHistory> }>()
let profileEpoch = 0
useAppStore.subscribe((state, previous) => {
  if (state.profileId !== previous.profileId) { profileEpoch++; reads.clear() }
})
export function invalidateThreadActionHistory(threadId: string): void {
  reads.delete(`${useAppStore.getState().profileId}\0${threadId}`)
}
/** Coalesce a history mounted in many message rows into one task-level request. */
export function readThreadActionHistory(threadId: string, refresh = false): Promise<ThreadActionHistory> {
  const profileId = useAppStore.getState().profileId, epoch = profileEpoch
  const key = `${profileId}\0${threadId}`
  const now = Date.now(), previous = reads.get(key)
  if (previous && (!refresh && now - previous.at < 3000 || previous.at === Infinity)) return previous.promise
  const entry = { at: Infinity, promise: Promise.resolve({} as ThreadActionHistory) }
  entry.promise = window.mousse.actions.list(threadId).then((result) => {
    if (epoch !== profileEpoch || profileId !== useAppStore.getState().profileId) throw new Error('Task history belongs to a previous profile binding.')
    entry.at = Date.now()
    return result as ThreadActionHistory
  }).catch((error) => { if (reads.get(key) === entry) reads.delete(key); throw error })
  reads.set(key, entry)
  // Do not retain every historical task in a long-lived renderer.
  if (reads.size > 50) for (const [id, value] of reads) if (id !== key && value.at !== Infinity) { reads.delete(id); break }
  return entry.promise
}
