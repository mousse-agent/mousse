import { useEffect, useRef, useState } from 'react'
import { BridgeDisplayDecoder, type BridgeEntityRef } from '../../shared/bridge'
import type { NodeId } from '../../shared/net'
import type { Thread } from '../../shared/types'
import { useAppStore } from '../stores/appStore'
import { remoteDisplay, type RemoteView } from '../services/remoteThreadDisplay'
import { MarkdownPreview } from './editors/MarkdownPreview'

// Serialize attachment and final detachment for repeated mounts of one display.
const attachments = new Map<string, { users: number; tail: Promise<unknown> }>()
function RemoteThreadView({ refValue }: { refValue: BridgeEntityRef }) {
  const profile = useAppStore(state => state.profileId)
  const currentView = useRef<RemoteView>(undefined)
  const { nodeId, entityId } = refValue
  const [view, setView] = useState<RemoteView>(), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let active = true
    const ref = { nodeId, entityId }
    const decoder = new BridgeDisplayDecoder({ ref }), key = JSON.stringify([profile, nodeId, entityId])
    const held = attachments.get(key) ?? { users: 0, tail: Promise.resolve() }
    attachments.set(key, held); held.users++
    currentView.current = undefined; setView(undefined); setError('')
    const off = window.mousse.bridge.onThreadPart(part => {
      if (!active || part.ref.nodeId !== nodeId || part.ref.entityId !== entityId) return
      void decoder.accept(part).then(event => {
        if (!active || !event) return
        try { currentView.current = remoteDisplay(currentView.current, event); setView(currentView.current) }
        catch (cause) { currentView.current = undefined; setView(undefined); setError(String((cause as Error)?.message ?? cause)) }
      }, cause => { if (active) { currentView.current = undefined; setView(undefined); setError(String(cause?.message ?? cause)) } })
    })
    const attaching = held.tail.catch(() => undefined).then(() => active ? window.mousse.platformRequest.request('bridge.hub.attach', { ref }) : undefined)
    held.tail = attaching
    void attaching.catch(cause => { if (active) { setView(undefined); setError(String(cause?.message ?? cause)) } })
    return () => {
      active = false; off(); decoder.close(); held.users--
      const closing = held.tail.catch(() => undefined).then(async () => {
        if (held.users || useAppStore.getState().profileId !== profile) return
        await window.mousse.platformRequest.request('bridge.hub.detach', { ref })
      }).catch(() => undefined).finally(() => { if (!held.users && attachments.get(key) === held && held.tail === closing) attachments.delete(key) })
      held.tail = closing
    }
  }, [profile, nodeId, entityId, refresh])
  return <section className="remote-thread-view" aria-label="Remote thread view">
    <header><strong>{view?.thread.name ?? 'Loading remote thread…'}</strong><button type="button" onClick={() => setRefresh(value => value + 1)}>Refresh display</button></header>
    <p>On the selected device · {view?.active ? 'Working' : 'Display only'}{view && ` · ${view.queued} queued · ${view.questions} pending questions`}</p>
    {error && <p className="chat-error" role="alert">{error}</p>}
    {view?.messages.filter(row => !row.hidden).slice(-512).map(row => <article key={row.id}><strong>{row.role}</strong><MarkdownPreview value={row.content || row.toolCall?.summary || row.thinking?.content || ''} className="chat-message-markdown chat-markdown" /></article>)}
    {view?.messages.length && view.messages.length > 512 ? <p>This display shows the latest 512 retained messages.</p> : null}
    {view?.lastEvent && <p role="status">Latest update: {view.lastEvent.replaceAll('.', ' ')}</p>}
    {!!view?.questions && <p>Open this thread on its device to answer pending questions.</p>}
  </section>
}

export function RemoteDeviceThreads({ devices }: { devices: Array<{ node: NodeId; name: string; self: boolean; revoked: boolean; caps: string[]; state: string }> }) {
  const [target, setTarget] = useState<NodeId>(), [threads, setThreads] = useState<Thread[]>([]), [selected, setSelected] = useState<string>(), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setThreads([]); setSelected(undefined); setError('')
    if (target) void window.mousse.platformRequest.request<{ threads: Thread[] }>('bridge.hub.threads', { target }).then(value => { if (active) setThreads(value.threads) }, cause => { if (active) setError(String(cause?.message ?? cause)) })
    return () => { active = false }
  }, [target])
  const allowed = devices.filter(device => !device.self && !device.revoked && device.caps.includes('read'))
  return <section><h3>Threads by device</h3><label>Device<select value={target ?? ''} onChange={event => setTarget(event.target.value as NodeId || undefined)}><option value="">Select my device</option>{allowed.map(device => <option key={device.node} value={device.node}>{device.name} · {device.state === 'open' ? 'Online' : 'Offline'}</option>)}</select></label>
    {error && <p className="chat-error" role="alert">{error}</p>}
    {target && allowed.some(device => device.node === target) && <><label>Remote thread<select value={selected ?? ''} onChange={event => setSelected(event.target.value || undefined)}><option value="">Select a thread</option>{threads.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>{selected && <RemoteThreadView key={JSON.stringify([target, selected])} refValue={{ nodeId: target, entityId: selected }} />}</>}
  </section>
}
