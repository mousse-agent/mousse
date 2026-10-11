import { useEffect, useRef, useState } from 'react'
import type { BrowserAccessState } from '../../../shared/browser/access'
import { useAppStore } from '../../stores/appStore'

/** Explicit, profile-owned browser consent, visible in the requesting thread. */
export function ChatBrowserAccess({ threadId, profileId: suppliedProfile, requireSelectedThread = false }: { threadId: string; profileId?: string; requireSelectedThread?: boolean }) {
  const selectedProfile = useAppStore((state) => state.profileId)
  const profileId = suppliedProfile ?? selectedProfile
  return <BrowserPermission key={`${profileId}:${threadId}`} profileId={profileId} threadId={threadId} requireSelectedThread={requireSelectedThread} />
}

function BrowserPermission({ threadId, profileId, requireSelectedThread }: { threadId: string; profileId: string; requireSelectedThread: boolean }) {
  const [requestId, setRequestId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const revision = useRef(0)
  const current = () => {
    const state = useAppStore.getState()
    return alive.current && state.profileId === profileId && (!requireSelectedThread || state.activeThreadId === threadId)
  }
  const openBrowser = () => {
    if (!requireSelectedThread || !current()) return
    const state = useAppStore.getState()
    if (state.mainView !== 'browser' || !state.mainAreaOpen) state.openSurfaceKind('browser')
  }
  useEffect(() => {
    alive.current = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      const expectedRevision = revision.current
      try {
        const state = await window.mousse.platformRequest.request<BrowserAccessState>('browser.access.status', { profileId })
        if (!current() || expectedRevision !== revision.current) return
        const pendingRequest = state.pending?.find((item) => item.threadId === threadId)
        setRequestId(state.allowed ? undefined : pendingRequest?.requestId)
        setError('')
        // Mount the browser provisioner even when this fresh thread has no surfaces.
        if ((!state.allowed && pendingRequest) || (state.allowed && state.tabRequests?.some((item) => item.threadId === threadId))) openBrowser()
      } catch (cause) {
        if (current() && expectedRevision === revision.current) setError(String((cause as { message?: string })?.message || cause))
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 750)
    return () => { alive.current = false; clearInterval(timer) }
  }, [threadId, profileId, requireSelectedThread])
  const answer = async (allowed: boolean) => {
    const id = requestId
    if (!id || busy || !current()) return
    revision.current += 1
    setBusy(true); setError('')
    try {
      await window.mousse.platformRequest.request('browser.access.respond', { profileId, requestId: id, allowed })
      if (!current()) return
      setRequestId(undefined)
      if (allowed) openBrowser()
    } catch (cause) {
      if (current()) setError(String((cause as { message?: string })?.message || cause))
    } finally {
      revision.current += 1
      if (current()) setBusy(false)
    }
  }
  if (!requestId) return null
  return <div className="chat-browser-permission" role="region" aria-label="Agent browser access request">
    <span role="status">Waiting for browser permission</span>
    <span>Allow agents to use this profile’s browser?</span>
    <button type="button" disabled={busy} onClick={() => void answer(true)}>Allow</button>
    <button type="button" disabled={busy} onClick={() => void answer(false)}>Deny</button>
    {error && <p className="chat-error" role="alert">{error}</p>}
  </div>
}
