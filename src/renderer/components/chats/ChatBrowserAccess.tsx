import { useEffect, useState } from 'react'
import type { BrowserAccessState } from '../../../shared/browser/access'

/** The same profile-owned browser grant as the ordinary browser, scoped to this pending request. */
export function ChatBrowserAccess({ threadId }: { threadId: string }) {
  const [requestId, setRequestId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true, pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const state = await window.mousse.platformRequest.request<BrowserAccessState>('browser.access.status', {})
        if (active) setRequestId(state.allowed ? undefined : state.pending?.find((item) => item.threadId === threadId)?.requestId)
      } catch (error) { if (active) setError(String((error as { message?: string })?.message || error)) }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1000)
    return () => { active = false; clearInterval(timer) }
  }, [threadId])
  const answer = async (allowed: boolean) => {
    const current = requestId
    if (!current) return
    setBusy(true); setError('')
    try { await window.mousse.platformRequest.request('browser.access.respond', { requestId: current, allowed }); setRequestId(undefined) }
    catch (error) { setError(String((error as { message?: string })?.message || error)) }
    finally { setBusy(false) }
  }
  if (!requestId) return null
  return <div className="chat-browser-permission" role="region" aria-label="Agent browser access request"><span>Allow agents to use this profile’s browser?</span><button disabled={busy} onClick={() => void answer(true)}>Allow</button><button disabled={busy} onClick={() => void answer(false)}>Deny</button>{error && <p className="chat-error" role="alert">{error}</p>}</div>
}
