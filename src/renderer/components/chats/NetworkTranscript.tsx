import { useEffect, useState } from 'react'
import { Lock, RefreshCw } from 'lucide-react'
import type { ChatNetworkProjection, ChatWorkProjection } from '../../../shared/chatsNetwork'
import type { BotsLocalResults } from '../../../shared/bots/local'
import type { BotId, Envelope, StreamId } from '../../../shared/net'
import type { SpacesLocalResults } from '../../../shared/spaces/local'
import { useChatsStore } from '../../stores/chatsStore'
import { MarkdownPreview } from '../editors/MarkdownPreview'
import { ChatAvatar } from './ChatsSidebar'

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

function WorkView({ chatId, stream, network, onClose }: { chatId: string; stream: StreamId; network: ChatNetworkProjection; onClose(): void }) {
  const [work, setWork] = useState<ChatWorkProjection>(), [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const fetch = async (after?: ChatWorkProjection['cursor']) => {
    setLoading(true); setError('')
    try {
      const next = await window.mousse.platformRequest.request<ChatWorkProjection>('chats.work.get', { chatId, stream, ...(after ? { after } : {}), limit: 128 })
      setWork(previous => after && previous && previous.cursor.epoch === next.cursor.epoch ? { ...next, records: [...previous.records, ...next.records].slice(-2048) } : next)
    } catch (cause) { setWork(undefined); setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }
  useEffect(() => {
    let active = true
    void window.mousse.platformRequest.request<ChatWorkProjection>('chats.work.get', { chatId, stream, limit: 128 }).then(value => { if (active) setWork(value) }, cause => { if (active) { setWork(undefined); setError(String(cause?.message ?? cause)) } })
    return () => { active = false }
  }, [chatId, stream])
  return <aside className="chat-network-work" aria-label="Agent work thread">
    <header><strong>{work?.private && <Lock size={13} />}Agent work</strong><button type="button" onClick={onClose}>Close</button></header>
    {work?.private && <p className="chat-network-boundary">Private · visible to authorized participants</p>}
    {error && <p role="alert" className="chat-error">{error}</p>}
    {work?.records.map(row => <article key={row.envelope.id} className="chat-network-event"><strong>{network.participants.find(p => p.id === row.envelope.author.bot || p.id === row.envelope.author.user)?.name ?? row.envelope.author.bot ?? row.envelope.author.user}</strong><span>{row.envelope.type.replace('bot.run.', '')}</span><MarkdownPreview value={networkRecordText(row.envelope, row.privateBody)} className="chat-message-markdown chat-markdown" /></article>)}
    <button type="button" disabled={loading} onClick={() => void fetch(work?.nextAfter)}>{work?.nextAfter ? 'Load more work' : 'Refresh work'}</button>
  </aside>
}

export function NetworkTranscript({ chatId, network }: { chatId: string; network: ChatNetworkProjection }) {
  const [workStream, setWorkStream] = useState<StreamId>(), [presence, setPresence] = useState<Record<string, BotsLocalResults['bots.presence']>>({})
  const [queued, setQueued] = useState<SpacesLocalResults['spaces.outbox']['entries']>([])
  useEffect(() => {
    let active = true, running = false
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const results = await Promise.allSettled(network.participants.filter(p => p.kind === 'agent' && p.active).slice(0, 32).map(async p => [p.id, await window.mousse.platformRequest.request<BotsLocalResults['bots.presence']>('bots.presence', { space: network.binding.space, stream: network.binding.channel, bot: p.id as BotId })] as const))
        const outbox = await window.mousse.platformRequest.request<SpacesLocalResults['spaces.outbox']>('spaces.outbox', { stream: network.binding.channel, limit: 128 })
        if (!active) return
        setPresence(Object.fromEntries(results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])))
        setQueued(outbox.entries.filter(entry => entry.state !== 'sent'))
      } catch { if (active) { setPresence({}); setQueued([]) } }
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
          {opened ? <button type="button" className="chat-network-work-link" onClick={() => setWorkStream(opened.stream)}>{opened.private && <Lock size={12} />}{opened.private ? 'Private agent work' : opened.title || 'Open agent work'}</button> : <MarkdownPreview value={networkRecordText(e)} className="chat-message-markdown chat-markdown" />}
          {!!e.refs?.mentions?.length && <span className="chat-network-mentions">{e.refs.mentions.map(bot => network.participants.find(p => p.id === bot)?.name ?? bot).join(', ')}</span>}
        </div>
      </article>
    })}
    {queued.map(entry => <p key={entry.id} className="chat-network-delivery" role="status">Message {entry.state}{entry.error && ` · ${entry.error}`}<span>{entry.id}</span></p>)}
    {network.nextAfter && <button type="button" className="chat-network-page" onClick={() => void useChatsStore.getState().loadMore()}><RefreshCw size={13} />Load more conversation</button>}
    {workStream && <WorkView key={workStream} chatId={chatId} stream={workStream} network={network} onClose={() => setWorkStream(undefined)} />}
  </>
}
