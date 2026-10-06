import { useEffect, useState } from 'react'
import type { NetworkChatConversation } from '../../../shared/chatsNetwork'
import type { SpaceId, StreamId } from '../../../shared/net'
import type { SpacesLocalResults } from '../../../shared/spaces/local'
import { useChatsStore } from '../../stores/chatsStore'

export function OpenNetworkChatDialog({ onClose }: { onClose(): void }) {
  const [spaces, setSpaces] = useState<SpacesLocalResults['spaces.list']['spaces']>([]), [channels, setChannels] = useState<SpacesLocalResults['spaces.channels']['channels']>([])
  const [invite, setInvite] = useState(''), [space, setSpace] = useState<SpaceId>(), [channel, setChannel] = useState<StreamId>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [bindingId] = useState(() => crypto.randomUUID())
  useEffect(() => {
    let active = true
    void window.mousse.platformRequest.request<SpacesLocalResults['spaces.list']>('spaces.list', {}).then(result => { if (active) setSpaces(result.spaces.filter(s => s.member)) }, cause => { if (active) setError(String(cause?.message ?? cause)) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!space) return
    let active = true
    void window.mousse.platformRequest.request<SpacesLocalResults['spaces.channels']>('spaces.channels', { space }).then(result => { if (active) setChannels(result.channels.filter(c => !c.archived)) }, cause => { if (active) setError(String(cause?.message ?? cause)) })
    return () => { active = false }
  }, [space])
  const join = async () => {
    setBusy(true); setError('')
    try {
      const result = await window.mousse.platformRequest.request<SpacesLocalResults['spaces.join']>('spaces.join', { invite: invite.trim() })
      const list = await window.mousse.platformRequest.request<SpacesLocalResults['spaces.list']>('spaces.list', {})
      setSpaces(list.spaces.filter(s => s.member)); setSpace(result.space); setChannel(undefined); setInvite('')
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }
  const open = async () => {
    if (!space || !channel) return
    setBusy(true); setError('')
    try {
      const result = await window.mousse.platformRequest.request<NetworkChatConversation>('chats.bind', { bindingId, space, channel })
      await useChatsStore.getState().openChat(result.id); await useChatsStore.getState().refresh(); onClose()
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }
  return <div className="chat-network-dialog-backdrop"><section className="chat-network-dialog" role="dialog" aria-modal="true" aria-labelledby="network-chat-title">
    <header><h2 id="network-chat-title">Open a Space conversation</h2><button type="button" disabled={busy} onClick={onClose}>Close</button></header>
    <label>Paste a Space invitation<textarea value={invite} aria-label="Space invitation to join" onChange={e => setInvite(e.target.value)} /></label><button type="button" disabled={busy || !invite.trim()} onClick={() => void join()}>Join Space</button>
    <label>Space<select value={space ?? ''} disabled={busy} onChange={e => { setSpace(e.target.value as SpaceId || undefined); setChannel(undefined); setChannels([]); setError('') }}><option value="">Select a joined Space</option>{spaces.map(s => <option key={s.space} value={s.space}>{s.name}{s.offline ? ' · offline' : ''}</option>)}</select></label>
    <label>Channel<select value={channel ?? ''} disabled={busy || !space} onChange={e => setChannel(e.target.value as StreamId || undefined)}><option value="">Select a channel</option>{channels.map(c => <option key={c.stream} value={c.stream}>{c.name}</option>)}</select></label>
    <p>This opens the shared conversation. Mentioned bots keep separate execution threads and workspaces.</p>
    {error && <p role="alert" className="chat-error">{error}</p>}<button type="button" className="chat-primary-button" disabled={busy || !space || !channel} onClick={() => void open()}>{busy ? 'Opening…' : 'Open conversation'}</button>
  </section></div>
}
