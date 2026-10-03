import { useEffect, useState } from 'react'
import { Monitor, RefreshCw } from 'lucide-react'
import { RemoteDeviceThreads } from './RemoteDeviceThreads'
import type { NetDoctor, NetStatus, NodeCapability, NodeId } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { TransportManifest } from '../../mms/net/contracts'

interface Device { node: NodeId; name: string; caps: NodeCapability[]; keyEpoch: number; expiresAt: number; self: boolean; revoked: boolean; state: 'connecting' | 'open' | 'closed' }
export function NetDevicesSection() {
  const [status, setStatus] = useState<NetStatus>(), [devices, setDevices] = useState<Device[]>([]), [manifests, setManifests] = useState<TransportManifest[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [passphrase, setPassphrase] = useState(''), [name, setName] = useState('My device'), [invite, setInvite] = useState(''), [joinText, setJoinText] = useState(''), [doctor, setDoctor] = useState<NetDoctor>()
  const [relayAddress, setRelayAddress] = useState(''), [named, setNamed] = useState(false), [tunnelId, setTunnelId] = useState(''), [hostname, setHostname] = useState(''), [credentialsFile, setCredentialsFile] = useState('')
  const reload = async () => {
    const current = await window.mousse.platformRequest.request<NetStatus>('net.status', {})
    setStatus(current)
    const addons = await window.mousse.platformRequest.request<{ manifests: TransportManifest[] }>('net.transport.list', {})
    setManifests(addons.manifests)
    if (current.self && current.keystore === 'unlocked') setDevices((await window.mousse.platformRequest.request<{ nodes: Device[] }>('bridge.nodes', {})).nodes)
    else setDevices([])
  }
  useEffect(() => {
    let active = true, running = false
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const current = await window.mousse.platformRequest.request<NetStatus>('net.status', {})
        const addons = await window.mousse.platformRequest.request<{ manifests: TransportManifest[] }>('net.transport.list', {})
        const nodes = current.self && current.keystore === 'unlocked' ? (await window.mousse.platformRequest.request<{ nodes: Device[] }>('bridge.nodes', {})).nodes : []
        if (active) { setStatus(current); setManifests(addons.manifests); setDevices(nodes) }
      } catch (cause) { if (active) setError(String((cause as Error)?.message ?? cause)) }
      finally { running = false }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000)
    return () => { active = false; clearInterval(timer) }
  }, [])
  const action = async (method: PlatformRequestMethod, params: unknown, capture?: (value: unknown) => void) => {
    setBusy(true); setError('')
    try { const result = await window.mousse.platformRequest.request(method, params); capture?.(result); await reload() }
    catch (cause) { setError(String((cause as Error)?.message ?? cause)) }
    finally { setBusy(false); setPassphrase('') }
  }
  const transport = (id: string, enabled: boolean, settings: Record<string, unknown>) => action('net.transport.configure', { id, enabled, settings })
  return <div className="net-devices-section">
    <header><p>{!status ? 'Loading network identity…' : !status.self ? 'No network identity yet' : status.keystore === 'locked' ? 'Keystore locked' : status.rosterState === 'conflict' ? 'Roster conflict · recovery required' : 'Identity ready'}{status?.error && ` · ${status.error}`}</p><button type="button" disabled={busy} onClick={() => void action('net.doctor', {}, value => setDoctor(value as NetDoctor))}><RefreshCw size={14} />Check connection</button></header>
    {error && <p role="alert" className="chat-error">{error}</p>}
    {!status?.self && <fieldset disabled={busy}><legend>Set up this device</legend><label>Device name<input value={name} maxLength={120} onChange={e => setName(e.target.value)} /></label><button type="button" onClick={() => void action('net.init', { name: name.trim(), listen: true })} disabled={!name.trim()}>Create network identity</button><label>Or paste a device invitation<textarea value={joinText} onChange={e => setJoinText(e.target.value)} aria-label="Device invitation to join" /></label><label>Protect with a passphrase<input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} autoComplete="new-password" /></label><button type="button" disabled={!joinText.trim() || !passphrase} onClick={() => void action('bridge.join', { invite: joinText.trim(), name: name.trim(), passphrase }, () => setJoinText(''))}>Join my devices</button></fieldset>}
    {status?.self && (!status.protected || status.keystore === 'locked') && <fieldset disabled={busy}><legend>{status.keystore === 'locked' ? 'Unlock this profile' : 'Protect network keys'}</legend><label>Passphrase<input type="password" value={passphrase} onChange={e => setPassphrase(e.target.value)} autoComplete={status.keystore === 'locked' ? 'current-password' : 'new-password'} /></label><button type="button" disabled={!passphrase} onClick={() => void action(status.keystore === 'locked' ? 'net.unlock' : 'net.protect', { passphrase })}>{status.keystore === 'locked' ? 'Unlock' : 'Protect keys'}</button></fieldset>}
    {!!devices.length && <section><h3>My devices</h3>{devices.map(device => <div className="net-device-row" key={device.node}><Monitor size={16} /><div><strong>{device.name}{device.self && ' · This device'}</strong><span>{device.revoked ? 'Revoked' : device.state === 'open' || device.self ? 'Online' : device.state === 'connecting' ? 'Connecting' : 'Offline'} · {device.caps.join(', ')}</span></div>{!device.self && !device.revoked && status?.self?.isAuthority && <button type="button" disabled={busy} onClick={() => void action('bridge.revoke', { node: device.node })}>Revoke</button>}</div>)}{status?.self?.isAuthority && <button type="button" disabled={busy || status.keystore !== 'unlocked' || !status.protected} onClick={() => void action('bridge.invite', { name: 'New device', ttlMs: 3600000 }, value => setInvite((value as { invite: string }).invite))}>Invite another device</button>}{invite && <label>Device invitation · share privately<textarea readOnly value={invite} onFocus={e => e.currentTarget.select()} aria-label="Device invitation" /></label>}</section>}
    {!!devices.length && <RemoteDeviceThreads devices={devices} />}
    {doctor && <section><h3>Connection checks</h3>{doctor.checks.map(check => <p key={check.name}>{check.ok ? 'Ready' : 'Needs attention'} · {check.message}{check.code && ` (${check.code})`}</p>)}</section>}
    {status?.routes.length ? <section><h3>Advertised routes</h3>{status.routes.map(route => <p key={route.transport + route.address}><strong>{route.transport}</strong> <code>{route.address}</code></p>)}</section> : status?.self && <p>No advertised route. Enable an add-on to accept connections.</p>}
    {status?.self && status.keystore === 'unlocked' && <section><h3>Connection add-ons</h3>{manifests.map(manifest => {
      const live = status.transports?.find(t => t.id === manifest.id)
      return <details key={manifest.id} className="net-addon"><summary>{manifest.displayName} · {live?.state ?? 'disabled'}{live?.error && ` · ${live.error}`}</summary>{manifest.setupSteps.map(step => <p key={step.title}><strong>{step.title}</strong> {step.detail}{step.command && <code>{step.command}</code>}</p>)}
        {manifest.id === 'cloudflared' && <><label className="net-toggle"><input type="checkbox" checked={named} onChange={e => setNamed(e.target.checked)} />Use a named tunnel</label>{named && <><label>Tunnel ID<input value={tunnelId} onChange={e => setTunnelId(e.target.value)} /></label><label>Hostname<input value={hostname} onChange={e => setHostname(e.target.value)} /></label><label>Private credentials file on this device<input value={credentialsFile} onChange={e => setCredentialsFile(e.target.value)} /></label></>}<button type="button" disabled={busy || named && (!tunnelId || !hostname || !credentialsFile)} onClick={() => void transport('cloudflared', true, named ? { mode: 'named', tunnelId, hostname, credentialsFile } : { mode: 'quick' })}>Enable Cloudflare Tunnel</button></>}
        {manifest.id === 'direct' && <button type="button" disabled={busy} onClick={() => void transport('direct', true, { host: '127.0.0.1', port: 0 })}>Enable local listener</button>}
        {manifest.id === 'tailscale' && <button type="button" disabled={busy} onClick={() => void transport('tailscale', true, {})}>Use connected Tailscale network</button>}
        {manifest.id === 'relay' && <><label>Relay WebSocket address<input value={relayAddress} onChange={e => setRelayAddress(e.target.value)} placeholder="wss://relay.example.com" /></label><button type="button" disabled={busy || !relayAddress} onClick={() => void transport('relay', true, { address: relayAddress })}>Enable relay</button></>}
        {live?.enabled && <button type="button" disabled={busy} onClick={() => void transport(manifest.id, false, manifest.id === 'cloudflared' ? { mode: 'quick' } : manifest.id === 'relay' ? { address: relayAddress || live.routes[0]?.address || '' } : {})}>Disable</button>}
      </details>
    })}</section>}
  </div>
}
