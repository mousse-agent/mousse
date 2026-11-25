import { useCallback, useEffect, useState } from 'react'
import type { NetEngineStatus } from '../../../shared/netEngine/local'
import { useAppStore } from '../../stores/appStore'

/** Reads `netEngine.status` for this window's profile, again whenever the daemon says it changed. */
export function useEngineStatus(): {
  status: NetEngineStatus | undefined
  read: () => void
} {
  const profileId = useAppStore((state) => state.profileId)
  const [status, setStatus] = useState<NetEngineStatus>()
  const read = useCallback(() => {
    const profile = useAppStore.getState().profileId
    // A window without the daemon's requests (a test page, a window still starting) shows nothing.
    const platform = window.mousse?.platformRequest
    if (!platform) return
    void platform
      .request<NetEngineStatus>('netEngine.status', {})
      .then((value) => {
        if (useAppStore.getState().profileId === profile) setStatus(value)
      })
      .catch(() => undefined)
  }, [])
  useEffect(() => {
    setStatus(undefined)
    read()
    const off = window.mousse?.netEngine?.onChanged?.((change) => {
      if (!change.profileId || change.profileId === useAppStore.getState().profileId) read()
    })
    return () => off?.()
  }, [profileId, read])
  return { status, read }
}
