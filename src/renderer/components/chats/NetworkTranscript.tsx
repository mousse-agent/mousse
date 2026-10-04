import { useCallback, useEffect, useRef, useState } from 'react'
import { Lock, RefreshCw } from '../../lib/icons'
import type { ChatAsideProjection, ChatAsideSendInput, ChatAsideSendResult, ChatNetworkProjection, ChatWorkProjection } from '../../../shared/chatsNetwork'
import type { BotsLocalResults } from '../../../shared/bots/local'
import type { BotId, BotPermissionRequest, Envelope, StreamId } from '../../../shared/net'
import type { SpacesLocalResults } from '../../../shared/spaces/local'
import { useChatsStore } from '../../stores/chatsStore'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { ChatAvatar } from './ChatsSidebar'
import { PrivateAsideComposer } from './PrivateAsideComposer'
import { BotPermissionDecision } from './BotPermissionDecision'

export function networkRecordText(envelope: Envelope, privateBody?: unknown): string {
  const body = (privateBody ?? envelope.body) as Record<string, unknown> | undefined
  if (envelope.sealed && privateBody === undefined) return 'Private activity'
  if (typeof body?.text === 'string') return body.text
  if (typeof body?.summary === 'string') return body.summary
  if (envelope.type === 'bot.run.expired') return 'Mention expired before delivery; no run was started.'
  if (envelope.type === 'bot.run.uncertain') return 'Run outcome needs checking.'
  if (typeof body?.message === 'string') return body.message
  if (typeof body?.title === 'string') return body.title
  return envelope.type.replaceAll('.', ' ')
}

function WorkView({ chatId, stream, network, aside, onClose }: { chatId: string; stream: StreamId; network: ChatNetworkProjection; aside: boolean; onClose(): void }) {
  const [work, setWork] = useState<ChatWorkProjection | ChatAsideProjection>(), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const [ownedBots, setOwnedBots] = useState<BotId[]>([]), [text, setText] = useState(''), [pending, setPending] = useState<ChatAsideSendInput>()
  const [delivery, setDelivery] = useState<ChatAsideSendResult>()
  const operation = useRef(0), alive = useRef(true)
  const fetch = useCallback(async (after?: ChatWorkProjection['cursor']) => {
    if (!alive.current) return
    const generation = ++operation.current
    setLoading(true); setError('')
    try {
      const next = await window.mousse.platformRequest.request<ChatWorkProjection | ChatAsideProjection>(aside ? 'chats.aside.get' : 'chats.work.get', { chatId, stream, ...(after ? { after } : {}), limit: 128 })
      if (!alive.current || generation !== operation.current) return
      setWork(previous => {
        if (!after || !previous || previous.cursor.epoch !== next.cursor.epoch) return next
        const records = [...previous.records, ...next.records]
        return records.length <= 2048 ? { ...next, records } : next
      })
    } catch (cause) { if (alive.current && generation === operation.current) { setWork(undefined); setError(cause instanceof Error ? cause.message : String(cause)) } }
    finally { if (alive.current && generation === operation.current) setLoading(false) }
  }, [aside, chatId, stream])
  useEffect(() => {
    alive.current = true
    void fetch()
    let active = true
    void window.mousse.platformRequest.request<BotsLocalResults['bots.list']>('bots.list', { limit: 128 }).then(value => { if (active) setOwnedBots(value.bots.map(bot => bot.bot)) }, () => { if (active) setOwnedBots([]) })
    return () => { active = false; alive.current = false }
  }, [fetch])
  const send = async () => {
    const input = pending ?? { chatId, stream, text, clientMessageId: crypto.randomUUID() }
    setPending(input); setLoading(true); setError('')
    try {
      const result = await window.mousse.platformRequest.request<ChatAsideSendResult>('chats.aside.send', input)
      if (!alive.current) return
      setDelivery(result)
      if (result.delivery.state === 'sent') { setPending(undefined); setText('') }
      await fetch()
    } catch (cause) { if (alive.current) { setWork(undefined); setError(String((cause as Error)?.message ?? cause)) } }
    finally { if (alive.current) setLoading(false) }
  }
  const audience = work && 'audience' in work ? work.audience : undefined
  return <aside className="chat-network-work" aria-label={aside ? 'Private aside' : 'Agent work thread'}>
    <header><strong>{work?.private && <Lock size={13} />}{aside ? 'Private aside' : 'Agent work'}</strong><button type="button" onClick={onClose}>Close</button></header>
    {work?.private && <p className="chat-network-boundary">Private · {audience ? audience.participants.map(id => network.participants.find(person => person.id === id)?.name ?? id).join(', ') : 'visible to authorized participants'}</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {work?.records.map(row => {
      const body = (row.privateBody ?? row.envelope.body) as BotPermissionRequest
      const request = row.envelope.type === 'bot.permission.requested' && (!row.envelope.sealed || row.privateBody !== undefined) && ownedBots.includes(body.bot)
      return <article key={row.envelope.id} className="chat-network-event"><strong>{network.participants.find(p => p.id === row.envelope.author.bot || p.id === row.envelope.author.user)?.name ?? row.envelope.author.bot ?? row.envelope.author.user}</strong><span>{row.envelope.type.replace('bot.run.', '')}</span><MarkdownPreview value={networkRecordText(row.envelope, row.privateBody)} className="chat-message-markdown chat-markdown" />{request && <BotPermissionDecision stream={stream} request={row.envelope.id} body={body} onChanged={() => void fetch()} />}</article>
    })}
    <button type="button" disabled={loading} onClick={() => void fetch(work?.nextAfter)}>{work?.nextAfter ? 'Load more work' : 'Refresh work'}</button>
    {aside && audience && <form className="chat-network-private-composer" onSubmit={event => { event.preventDefault(); if (text.trim() && !loading && !network.readonly) void send() }}><label>Private message<textarea value={text} disabled={loading || !!pending || network.readonly} onChange={event => setText(event.target.value)} /></label>{delivery && <p role="status">Private message {delivery.delivery.state}</p>}<button type="submit" disabled={loading || !text.trim() || network.readonly}>{pending ? 'Retry original private message' : 'Send privately'}</button></form>}
  </aside>
}

export function NetworkTranscript({ chatId, network }: { chatId: string; network: ChatNetworkProjection }) {
  const [workStream, setWorkStream] = useState<{ stream: StreamId; aside: boolean }>(), [presence, setPresence] = useState<Record<string, BotsLocalResults['bots.presence']>>({})
  const [queuedCount, setQueuedCount] = useState(0)
  const [queued, setQueued] = useState<SpacesLocalResults['spaces.outbox']['entries']>([])
  useEffect(() => {
    let active = true, running = false
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const results = await Promise.allSettled(network.participants.filter(p => p.kind === 'agent' && p.active).slice(0, 32).map(async p => [p.id, await window.mousse.platformRequest.request<BotsLocalResults['bots.presence']>('bots.presence', { space: network.binding.space, stream: network.binding.channel, bot: p.id as BotId })] as const))
        const outbox = await window.mousse.platformRequest.request<SpacesLocalResults['spaces.outbox']>('spaces.outbox', { stream: network.binding.channel, states: ['pending', 'unknown', 'failed'], limit: 128 })
        if (!active) return
        setPresence(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])))
        setQueuedCount(outbox.total)
        setQueued(outbox.entries.filter(entry => entry.state !== 'sent'))
      } catch { if (active) { setPresence({}); setQueued([]); setQueuedCount(0) } }
      finally { running = false }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [chatId, network.binding.space, network.binding.channel, network.participants])
  return <>
    <div className="chat-network-boundary" role="status">Published conversation · {network.offline ? 'Space offline' : 'Connected'}{network.readonly && ' · Read only'}<span>Earlier local history stays on this device.</span></div>
    <div className="chat-network-presence">{network.participants.filter(p => p.kind === 'agent').map(p => <span key={p.id}>{p.name} · {p.active ? presence[p.id]?.state === 'workingPrivate' ? 'working (private)' : presence[p.id]?.state ?? 'checking presence' : 'removed'}</span>)}</div>
    {network.records.map(row => {
      const e = row.envelope, participant = network.participants.find(p => p.id === e.author.user || p.id === e.author.bot)
      const name = participant?.name ?? e.author.user ?? e.author.bot ?? 'Historical author'
      const opened = e.type === 'thread.opened' ? e.body as { stream: StreamId; private: boolean; title: string } : undefined
      return <article key={e.id} className={`chat-participant-message ${e.author.bot ? 'from-agent' : 'from-person'}`}>
        <ChatAvatar name={name} /><div className="chat-participant-message-body"><div className="chat-message-meta"><strong>{name}</strong><span>{e.type === 'message.posted' ? 'Sent to Host' : e.type.replace('bot.run.', '')}</span><time dateTime={new Date(row.recvTs).toISOString()}>{new Date(row.recvTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div>
          {opened ? <button type="button" className="chat-network-work-link" onClick={() => setWorkStream({ stream: opened.stream, aside: opened.private && opened.title === 'Private aside' })}>{opened.private && <Lock size={12} />}{opened.private ? opened.title === 'Private aside' ? 'Private aside' : 'Private agent work' : opened.title || 'Open agent work'}</button> : <MarkdownPreview value={networkRecordText(e)} className="chat-message-markdown chat-markdown" />}
          {!!e.refs?.mentions?.length && <span className="chat-network-mentions">{e.refs.mentions.map(bot => network.participants.find(p => p.id === bot)?.name ?? bot).join(', ')}</span>}
        </div>
      </article>
    })}
    {queued.map(entry => <p key={entry.id} className="chat-network-delivery" role="status">Message {entry.state}{entry.error && ` · ${entry.error}`}<span>{entry.id}</span></p>)}
    {queuedCount > queued.length && <p className="chat-network-delivery" role="status">Showing {queued.length} of {queuedCount} delivery records requiring attention.</p>}
    {network.nextAfter && <button type="button" className="chat-network-page" onClick={() => void useChatsStore.getState().loadMore()}><RefreshCw size={13} />Load more conversation</button>}
    <PrivateAsideComposer key={chatId} chatId={chatId} network={network} onOpen={stream => setWorkStream({ stream, aside: true })} />
    {workStream && <WorkView key={workStream.stream} chatId={chatId} stream={workStream.stream} aside={workStream.aside} network={network} onClose={() => setWorkStream(undefined)} />}
  </>
}
