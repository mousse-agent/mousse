import { useState } from 'react'
import type { ChatNetworkProjection } from '../../../shared/chatsNetwork'
import type { BotsLocalParams, BotsLocalResults } from '../../../shared/bots/local'
import { newId } from '../../../shared/net'
import type { SpacesLocalResults } from '../../../shared/spaces/local'
import { useChatsStore } from '../../stores/chatsStore'

export function NetworkChatActions({ chatId, network }: { chatId: string; network: ChatNetworkProjection }) {
  const [invite, setInvite] = useState(''), [name, setName] = useState(''), [profile, setProfile] = useState<BotsLocalParams['bots.add']['profile']>('chat')
  const [visibility, setVisibility] = useState<'public' | 'private'>('private'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<BotsLocalResults['bots.add']>()
  const [original, setOriginal] = useState<BotsLocalParams['bots.add']>()
  const createInvite = async () => {
    setBusy(true); setError('')
    try { const next = await window.mousse.platformRequest.request<SpacesLocalResults['spaces.invite']>('spaces.invite', { space: network.binding.space, role: 'member', uses: 1, ttlMs: 3600000 }); setInvite(next.invite) }
    catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }
  const addBot = async () => {
    const input = original ?? { id: newId('rpc'), space: network.binding.space, name: name.trim(), profile, policy: { steer: { kind: 'owner' as const }, visibility } }
    setOriginal(input); setBusy(true); setError('')
    try {
      const added = await window.mousse.platformRequest.request<BotsLocalResults['bots.add']>('bots.add', input)
      setResult(added)
      await useChatsStore.getState().refresh()
    } catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false) }
  }
  return <details className="chat-network-actions" key={chatId}><summary>Space options</summary><div>
    <button type="button" disabled={busy || network.readonly} onClick={() => void createInvite()}>Invite a member</button>
    {invite && <label>One-use invite · expires in one hour<textarea readOnly value={invite} aria-label="Space invitation" onFocus={event => event.currentTarget.select()} /></label>}
    <fieldset disabled={busy || network.readonly || !!original}><legend>Add a bot on this device</legend><label>Name<input value={name} onChange={event => setName(event.target.value)} maxLength={120} /></label><label>Access<select value={profile} onChange={event => setProfile(event.target.value as BotsLocalParams['bots.add']['profile'])}><option value="chat">Chat · text only</option><option value="reader">Reader · approved read tools</option></select></label><label>Work audience<select value={visibility} onChange={event => setVisibility(event.target.value as 'public' | 'private')}><option value="private">Private work with the requester</option><option value="public">Public work in this Space</option></select></label><p>Only the bot owner can steer it. Reader work requires a configured project and qualified runtime.</p></fieldset>
    {result?.state === 'registered' ? <button type="button" disabled={busy || network.readonly} onClick={() => { setOriginal(undefined); setResult(undefined); setName(''); setError('') }}>Add another bot</button> : <button type="button" disabled={busy || network.readonly || !name.trim()} onClick={() => void addBot()}>{original ? 'Check original registration' : 'Register bot'}</button>}
    {result && <p role="status">Registration {result.state}. Configure and qualify this bot before it executes.</p>}{error && <p role="alert" className="chat-error">{error}</p>}
  </div></details>
}
