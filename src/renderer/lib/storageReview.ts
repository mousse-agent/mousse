import { useSyncExternalStore } from 'react'
import { parseStoragePolicyReply } from '../../shared/storageReply'

/**
 * Whether the recommended cleanup rules are waiting for the person to look at them. The Storage page,
 * the Settings list and the navigation rail all show a small dot while this is true, so it lives in one place.
 */
let pending = false
const listeners = new Set<() => void>()

export function setStorageReviewPending(next: boolean): void {
  if (pending === next) return
  pending = next
  for (const listener of listeners) listener()
}

export function useStorageReviewPending(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => pending, () => false)
}

/** Reads the daemon's answer once; a daemon that cannot answer leaves the dot off. */
export async function refreshStorageReview(): Promise<void> {
  try { setStorageReviewPending(parseStoragePolicyReply(await window.mousse.storage.policy()).reviewRecommended) } catch { /* No notice is better than a wrong one. */ }
}
