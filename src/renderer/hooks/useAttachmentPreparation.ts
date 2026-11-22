import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AttachmentPreparation, chipStatus, sendBlockedReason, type ChipStatus, type PreparableFile, type PreparationSnapshot } from '../lib/attachmentPreparation'

export interface AttachmentPreparationView {
  snapshot: PreparationSnapshot
  /** Each attached image's chip line and tooltip, by attachment id; none for one ready as it is. */
  statuses: ReadonlyMap<string, ChipStatus>
  /** Why Send waits or is refused, for its tooltip; null when it can send. */
  blocked: string | null
}

/** Prepares a composer's attached images as they are attached (`AttachmentPreparation`), and what its chips and Send show. */
export function useAttachmentPreparation(files: readonly PreparableFile[], remote: boolean): AttachmentPreparationView {
  const [preparation] = useState(() => new AttachmentPreparation())
  useEffect(() => { preparation.update(files, remote) }, [preparation, files, remote])
  const snapshot = useSyncExternalStore(preparation.subscribe, preparation.getSnapshot)
  return useMemo(() => {
    const statuses = new Map<string, NonNullable<ReturnType<typeof chipStatus>>>()
    for (const [id, state] of snapshot.images) {
      const status = chipStatus(state, snapshot.remote)
      if (status) statuses.set(id, status)
    }
    return { snapshot, statuses, blocked: sendBlockedReason(files, snapshot) }
  }, [snapshot, files])
}
