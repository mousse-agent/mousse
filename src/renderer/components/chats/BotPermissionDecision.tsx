import { useEffect, useRef, useState } from 'react'
import type { BotPermissionRequest, EventId, StreamId } from '../../../shared/net'
import type { SpaceLocalDelivery } from '../../../shared/spaces/local'

export function BotPermissionDecision({ stream, request, body, onChanged }: { stream: StreamId; request: EventId; body: BotPermissionRequest; onChanged(): void }) {
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const [decision, setDecision] = useState<boolean>(), [delivery, setDelivery] = useState<SpaceLocalDelivery>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const decide = async (approved: boolean) => {
    if (!alive.current) return
    const original = decision ?? approved
    setDecision(original); setBusy(true); setError('')
    try {
      const result = await window.mousse.platformRequest.request<SpaceLocalDelivery>('bots.grant', { stream, request, approved: original })
      if (!alive.current) return
      setDelivery(result); onChanged()
    } catch (cause) { if (alive.current) setError(String((cause as Error)?.message ?? cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <section className="chat-network-permission" aria-label="Bot owner permission decision">
    <p>{body.summary}</p><p>{body.kind === 'runtimeAction' ? 'Approve this exact runtime action' : 'Approve this audience policy change'} · expires {new Date(body.expiresAt).toLocaleString()}</p>
    {delivery && <p role="status">Decision {delivery.state}</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {delivery?.state !== 'sent' && (decision === undefined ? <><button type="button" disabled={busy} onClick={() => void decide(true)}>Approve exact request</button><button type="button" disabled={busy} onClick={() => void decide(false)}>Reject request</button></> : <button type="button" disabled={busy} onClick={() => void decide(decision)}>Retry original {decision ? 'approval' : 'rejection'}</button>)}
  </section>
}
