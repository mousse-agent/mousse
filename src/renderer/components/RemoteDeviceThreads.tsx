import { useEffect, useId, useMemo, useState } from 'react'
import type { BridgeEntityRef } from '../../shared/bridge'
import type { NodeId } from '../../shared/net'
import type { Thread } from '../../shared/types'
import type { RemoteView } from '../services/remoteThreadDisplay'
import { watchRemoteThread } from '../lib/remoteThreadStore'
import { useAppStore } from '../stores/appStore'
import { pausedStatusLabel } from '../lib/pausedRun'
import { MarkdownPreview } from './editors/MarkdownPreview'
import { RefreshCw } from '../lib/icons'
import { SettingsGroup, SettingsRow } from './settings/SettingsRow'
import { Select } from './ui/Select'

export function RemoteThreadView({ refValue, connected }: { refValue: BridgeEntityRef; connected: boolean }) {
  const profile = useAppStore(state => state.profileId)
  const { nodeId, entityId } = refValue
  const [view, setView] = useState<RemoteView>(), [error, setError] = useState(''), [refresh, setRefresh] = useState(0)
  const connection = useMemo(() => ({ connected, refresh }), [connected, refresh])
  const [confirmed, setConfirmed] = useState<typeof connection>()
  useEffect(() => {
    setError('')
    if (!connection.connected) return
    return watchRemoteThread({ nodeId, entityId }, {
      view: value => { setView(value); setConfirmed(connection) },
      error: message => { setView(undefined); setError(message) }
    })
  }, [profile, nodeId, entityId, refresh, connection])
  const live = !!view && connected && confirmed === connection
  return <div className="remote-thread-view" aria-label="Remote thread view" role="region">
    <div className="remote-thread-head"><strong>{view?.thread.name ?? (connected ? 'Loading remote thread…' : 'Device offline')}</strong><button type="button" className="settings-icon-btn" title="Refresh display" aria-label="Refresh display" disabled={!connected} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14} /></button></div>
    <p className="settings-muted">On the selected device · {live ? view?.active ? 'Working' : view?.paused ? pausedStatusLabel(view.paused, Date.now()) : 'Display only' : connected ? 'Awaiting current display' : 'Offline'}{view && !live && ' · Cached display'}{view && ` · ${view.queued} queued · ${view.questions} pending questions`}</p>
    {error && <p className="chat-error" role="alert">{error}</p>}
    {view?.messages.filter(row => !row.hidden).slice(-512).map(row => <article key={row.id}><strong>{row.role}</strong><MarkdownPreview value={row.content || row.toolCall?.summary || row.thinking?.content || ''} className="chat-message-markdown chat-markdown" /></article>)}
    {view?.messages.length && view.messages.length > 512 ? <p className="settings-muted">This display shows the latest 512 retained messages.</p> : null}
    {view?.lastEvent && <p role="status" className="settings-muted">Latest update: {view.lastEvent.replaceAll('.', ' ')}</p>}
    {!!view?.questions && <p className="settings-muted">Open this thread on its device to answer pending questions.</p>}
    {live && view?.paused && <p role="status" className="settings-muted">A usage limit paused this run. Resume or cancel it on its device.</p>}
  </div>
}

export function RemoteDeviceThreads({ devices }: { devices: Array<{ node: NodeId; name: string; self: boolean; revoked: boolean; caps: string[]; state: string }> }) {
  const [target, setTarget] = useState<NodeId>(), [threads, setThreads] = useState<Thread[]>([]), [selected, setSelected] = useState<string>(), [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setThreads([]); setSelected(undefined); setError('')
    if (target) void window.mousse.platformRequest.request<{ threads: Thread[] }>('bridge.hub.threads', { target }).then(value => { if (active) setThreads(value.threads) }, cause => { if (active) setError(String(cause?.message ?? cause)) })
    return () => { active = false }
  }, [target])
  const id = useId()
  const allowed = devices.filter(device => !device.self && !device.revoked && device.caps.includes('read'))
  const current = target && allowed.find(device => device.node === target)
  return <SettingsGroup title="Browse threads on other devices" className="devices-group">
    <SettingsRow title="Device" htmlFor={`${id}-device`} control={<Select id={`${id}-device`} value={target ?? ''} onChange={value => setTarget(value as NodeId || undefined)} options={[{ value: '', label: 'Select my device' }, ...allowed.map(device => ({ value: device.node as string, label: `${device.name} · ${device.state === 'open' ? 'Online' : 'Offline'}` }))]} />} />
    {error && <p className="chat-error remote-thread-error" role="alert">{error}</p>}
    {current && <SettingsRow title="Thread" htmlFor={`${id}-thread`} control={<Select id={`${id}-thread`} value={selected ?? ''} onChange={value => setSelected(value || undefined)} options={[{ value: '', label: 'Select a thread' }, ...threads.map(row => ({ value: row.id, label: row.name }))]} />} />}
    {current && selected && <RemoteThreadView key={JSON.stringify([target, selected])} refValue={{ nodeId: current.node, entityId: selected }} connected={current.state === 'open'} />}
  </SettingsGroup>
}
