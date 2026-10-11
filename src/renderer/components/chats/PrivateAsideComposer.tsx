import { useEffect, useRef, useState } from 'react'
import { Lock } from '../../lib/icons'
import type { ChatAsideCreateInput, ChatAsideCreation, ChatNetworkProjection } from '../../../shared/chatsNetwork'
import type { NetStatus, StreamId, UserId } from '../../../shared/net'
import { useChatsStore } from '../../stores/chatsStore'

export function PrivateAsideComposer({ chatId, network, onOpen }: { chatId: string; network: ChatNetworkProjection; onOpen(stream: StreamId): void }) {
  const alive = useRef(true)
  const [self, setSelf] = useState<UserId>(), [selected, setSelected] = useState<UserId[]>([])
  const [original, setOriginal] = useState<ChatAsideCreateInput>(), [creation, setCreation] = useState<ChatAsideCreation>()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    alive.current = true
    let active = true
    void window.mousse.platformRequest.request<NetStatus>('net.status', {}).then(value => {
      if (active) setSelf(value.self?.user)
    }, cause => { if (active) setError(String(cause?.message ?? cause)) })
    return () => { active = false; alive.current = false }
  }, [chatId])
  const create = async () => {
    if (!self || !alive.current) return
    const input = original ?? { chatId, asideId: crypto.randomUUID(), participants: [...new Set([self, ...selected])].sort() }
    setOriginal(input); setBusy(true); setError('')
    try {
      const result = await window.mousse.platformRequest.request<ChatAsideCreation>('chats.aside.create', input)
      if (!alive.current) return
      setCreation(result)
      await useChatsStore.getState().refresh()
      if (alive.current && result.state === 'sent') onOpen(result.stream)
    } catch (cause) { if (alive.current) setError(String((cause as Error)?.message ?? cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <details className="chat-network-aside"><summary><Lock size={13} />Start a private aside</summary>
    <p>Only the selected people receive new private messages. The shared conversation shows an opening marker.</p>
    <fieldset disabled={busy || network.readonly || !!original}><legend>Participants · you are included</legend>
      {network.participants.filter(person => person.kind === 'person' && person.active && person.id !== self).map(person => <label key={person.id}><input type="checkbox" checked={selected.includes(person.id as UserId)} disabled={!selected.includes(person.id as UserId) && selected.length >= 15} onChange={event => setSelected(held => event.target.checked ? [...held, person.id as UserId] : held.filter(id => id !== person.id))} />{person.name}</label>)}
    </fieldset>
    {error && <p className="chat-error" role="alert">{error}</p>}
    {creation && <p role="status">Private opening {creation.state}</p>}
    {creation?.state === 'sent' && <button type="button" disabled={busy || network.readonly} onClick={() => { setOriginal(undefined); setCreation(undefined); setSelected([]); setError('') }}>Start another aside</button>}
    {creation?.state === 'sent' ? <button type="button" onClick={() => onOpen(creation.stream)}>Open private aside</button> : <button type="button" disabled={busy || network.readonly || !self} onClick={() => void create()}>{original ? 'Check original private opening' : 'Create private aside'}</button>}
  </details>
}
