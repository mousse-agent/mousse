import { useEffect, useRef, useState } from 'react'
import type { BrowserAccessState } from '../../../shared/browser/access'
import { Globe } from '../../lib/icons'
import { useAppStore } from '../../stores/appStore'

/**
 * A group chat's explicit, profile-owned consent to its shared browser, shown in the chat that asks, and, once given,
 * one quiet line with Turn off to take it back. Thread agents use the in-app tabs without it.
 */
export function ChatBrowserAccess({ threadId, profileId: suppliedProfile }: { threadId: string; profileId?: string }) {
  const selectedProfile = useAppStore((state) => state.profileId)
  const profileId = suppliedProfile ?? selectedProfile
  return <BrowserPermission key={`${profileId}:${threadId}`} profileId={profileId} threadId={threadId} />
}

function BrowserPermission({ threadId, profileId }: { threadId: string; profileId: string }) {
  const [requestId, setRequestId] = useState<string>()
  const [allowed, setAllowed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)
  const revision = useRef(0)
  const current = () => {
    const state = useAppStore.getState()
    return alive.current && state.profileId === profileId
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
        setAllowed(state.allowed)
        setError('')
      } catch (cause) {
        if (current() && expectedRevision === revision.current) setError(String((cause as { message?: string })?.message || cause))
      } finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 750)
    return () => { alive.current = false; clearInterval(timer) }
  }, [threadId, profileId])
  const answer = async (allowed: boolean) => {
    const id = requestId
    if (!id || busy || !current()) return
    revision.current += 1
    setBusy(true); setError('')
    try {
      await window.mousse.platformRequest.request('browser.access.respond', { profileId, requestId: id, allowed })
      if (!current()) return
      setRequestId(undefined)
    } catch (cause) {
      if (current()) setError(String((cause as { message?: string })?.message || cause))
    } finally {
      revision.current += 1
      if (current()) setBusy(false)
    }
  }
  const turnOff = async () => {
    if (busy || !current()) return
    revision.current += 1
    setBusy(true); setError('')
    try {
      const state = await window.mousse.platformRequest.request<BrowserAccessState>('browser.access.set', { profileId, allowed: false })
      if (current()) setAllowed(state.allowed)
    } catch (cause) {
      if (current()) setError(String((cause as { message?: string })?.message || cause))
    } finally {
      revision.current += 1
      if (current()) setBusy(false)
    }
  }
  if (allowed) {
    return <div className="chat-browser-access-on" role="region" aria-label="Agent browser access">
      <Globe size={13} aria-hidden="true" />
      <span>Agents can use the browser</span>
      <button type="button" disabled={busy} title="Stop group chat agents using this profile’s browser" onClick={() => void turnOff()}>Turn off</button>
      {error && <p className="chat-error" role="alert">{error}</p>}
    </div>
  }
  if (!requestId) return null
  return <div className="chat-browser-permission" data-mousse-decision="" role="region" aria-label="Agent browser access request">
    <span role="status">Waiting for browser permission</span>
    <span>Allow agents to use this profile’s browser?</span>
    <button type="button" disabled={busy} onClick={() => void answer(true)}>Allow</button>
    <button type="button" disabled={busy} onClick={() => void answer(false)}>Deny</button>
    {error && <p className="chat-error" role="alert">{error}</p>}
  </div>
}
