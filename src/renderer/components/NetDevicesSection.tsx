import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, CircleCheck, Monitor, MonitorSmartphone, MoreHorizontal, Plus, RefreshCw } from '../lib/icons'
import { RemoteDeviceThreads } from './RemoteDeviceThreads'
import { Modal } from './ui/Modal'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from './settings/SettingsRow'
import { CopyButton } from './settings/IconButtons'
import { mousseIdAvailable, useMousseIdStore } from '../stores/mousseIdStore'
import { listedDevices, readDevices, type Device } from '../lib/netDevices'
import type { NetDoctor, NetStatus } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { TransportManifest } from '../../mms/net/contracts'
import '../styles/devices.css'

type Transport = NonNullable<NetStatus['transports']>[number]

/** One line under "Networking" for this device. */
function networkingLine(status?: NetStatus): string {
  if (!status) return 'Loading…'
  if (status.restartRequired) return 'Off · restart the background service before turning it on again'
  const error = status.error ? ` · ${status.error}` : ''
  if (!status.self) return status.enabled ? `No network identity yet${error}` : 'Off · turning it on creates a network identity for this device'
  if (!status.enabled) return status.keystore === 'unlocked' ? `Off · local conversations and network records are kept${error}` : `Off · unlock below to turn it on${error}`
  if (status.keystore === 'locked') return `On · locked until you enter the passphrase${error}`
  if (status.rosterState === 'conflict') return `On · device list conflict, recovery required${error}`
  return `On${error}`
}

function deviceLine(device: Device): string {
  const state = device.state === 'open' ? 'Online' : device.state === 'connecting' ? 'Connecting' : 'Offline'
  return device.caps.length ? `${state} · can ${device.caps.join(', ')}` : state
}

const TRANSPORT_STATE: Record<Transport['state'], string> = {
  disabled: 'Off',
  provisioning: 'Starting',
  ready: 'On',
  degraded: 'On · degraded',
  failed: 'Failed'
}

function addonLine(manifest: TransportManifest, live?: Transport): string {
  if (live?.enabled) return `${TRANSPORT_STATE[live.state]}${live.error ? ` · ${live.error}` : ''}`
  const step = manifest.setupSteps[0]
  if (!step) return live?.error ? `Off · ${live.error}` : 'Off'
  return step.command ? `${step.title}: ${step.command}` : step.title
}

/** Overflow menu on a device row. */
function DeviceMenu({ name, disabled, onRevoke }: { name: string; disabled: boolean; onRevoke: () => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const down = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div ref={root} className="devices-menu">
      <button
        type="button"
        className="settings-icon-btn devices-menu-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More actions for ${name}`}
        title="More actions"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div className="devices-menu-panel" role="menu">
          <button type="button" role="menuitem" className="devices-menu-item danger" onClick={() => { setOpen(false); onRevoke() }}>Revoke…</button>
        </div>
      )}
    </div>
  )
}

export function NetDevicesSection() {
  const id = useId()
  const alive = useRef(true), generation = useRef(0)
  const [status, setStatus] = useState<NetStatus>(), [devices, setDevices] = useState<Device[]>([]), [manifests, setManifests] = useState<TransportManifest[]>([])
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [passphrase, setPassphrase] = useState(''), [name, setName] = useState('My device'), [invite, setInvite] = useState(''), [joinText, setJoinText] = useState(''), [doctor, setDoctor] = useState<NetDoctor>()
  const [relayAddress, setRelayAddress] = useState(''), [named, setNamed] = useState(false), [tunnelId, setTunnelId] = useState(''), [hostname, setHostname] = useState(''), [credentialsFile, setCredentialsFile] = useState('')
  const [adding, setAdding] = useState(false), [revoking, setRevoking] = useState<Device>()
  const nameEdited = useRef(false)
  const reload = async () => {
    const owner = ++generation.current
    const { current, addons, nodes } = await readDevices(mousseIdAvailable(useMousseIdStore.getState()))
    if (alive.current && owner === generation.current) { setStatus(current); setManifests(addons.manifests); setDevices(nodes) }
  }
  useEffect(() => {
    alive.current = true
    let active = true, running = false
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const owner = ++generation.current
        const { current, addons, nodes } = await readDevices(mousseIdAvailable(useMousseIdStore.getState()))
        if (active && owner === generation.current) { setStatus(current); setManifests(addons.manifests); setDevices(nodes) }
      } catch (cause) { if (active) { setDevices([]); setManifests([]); setError(String((cause as Error)?.message ?? cause)) } }
      finally { running = false }
    }
    void refresh(); const timer = setInterval(() => void refresh(), 5000)
    // Suggest this computer's name for a new identity.
    void window.mousse.app?.getInfo().then((info) => {
      const suggested = info?.deviceName?.trim()
      if (active && suggested && !nameEdited.current) setName(suggested)
    }, () => undefined)
    return () => { active = false; alive.current = false; clearInterval(timer) }
  }, [])
  const action = async (method: PlatformRequestMethod, params: unknown, capture?: (value: unknown) => void) => {
    generation.current++; setBusy(true); setError('')
    try { const result = await window.mousse.platformRequest.request(method, params); if (!alive.current) return; capture?.(result); await reload() }
    catch (cause) { if (alive.current) { setError(String((cause as Error)?.message ?? cause)); if (method === 'net.disable') { setDevices([]); setManifests([]); await reload().catch(() => undefined) } } }
    finally { if (alive.current) { setBusy(false); setPassphrase('') } }
  }
  const transport = (transportId: string, enabled: boolean, settings: Record<string, unknown>) => action('net.transport.configure', { id: transportId, enabled, settings })

  const self = status?.self
  const selfDevice = devices.find((device) => device.self)
  const others = listedDevices(devices).filter((device) => !device.self)
  const unlocked = status?.keystore === 'unlocked'
  const authority = !!self?.isAuthority

  const toggleNetworking = (next: boolean) => {
    if (!next) { setInvite(''); void action('net.disable', {}) }
    else if (self) void action('net.init', {})
    else void action('net.init', { name: name.trim(), listen: true })
  }
  const networkingLocked = !status || (!status.enabled && (!!status.restartRequired || (self ? !unlocked : !name.trim())))

  const locked = status?.keystore === 'locked'
  const submitPassphrase = (event: FormEvent) => {
    event.preventDefault()
    if (!passphrase || busy) return
    void action(locked ? 'net.unlock' : 'net.protect', { passphrase })
  }

  // "Add device" joins this device to my other devices, or invites a new one from the owner.
  const addMode: 'join' | 'invite' | undefined = status && !self ? 'join' : authority ? 'invite' : undefined
  const inviteReady = unlocked && !!status?.protected
  const closeAdd = () => { setAdding(false); setInvite(''); setJoinText(''); setPassphrase('') }
  const submitJoin = (event: FormEvent) => {
    event.preventDefault()
    if (!joinText.trim() || !passphrase || !name.trim() || busy) return
    void action('bridge.join', { invite: joinText.trim(), name: name.trim(), passphrase }, () => { setJoinText(''); setAdding(false) })
  }

  const devicesDescription = !status ? undefined
    : !self ? 'Join devices you already use, or turn on networking to start a new set.'
      : !unlocked ? 'Unlock this device to see your other devices.'
        : !authority ? 'Add devices from the device that owns this identity.'
          : !inviteReady ? 'Protect network keys to add devices.'
            : undefined

  const showAddons = !!status?.enabled && !!self && unlocked

  return <>
    {error && !adding && <p role="alert" className="chat-error devices-error">{error}</p>}

    <SettingsGroup title="This device" icon={Monitor} className="devices-group">
      {!self && (
        <SettingsRow
          title="Device name"
          htmlFor={`${id}-name`}
          control={<input id={`${id}-name`} className="settings-input" value={name} maxLength={120} disabled={busy || !!status?.restartRequired} onChange={(event) => { nameEdited.current = true; setName(event.target.value) }} />}
        />
      )}
      <SettingsRow
        title={selfDevice?.name ?? 'Networking'}
        description={networkingLine(status)}
        control={<Switch checked={!!status?.enabled} label="Networking" disabled={busy || networkingLocked} onChange={toggleNetworking} />}
      />
      {status?.restartRequired && status.error === 'outcome_uncertain' && (
        <p role="status" className="settings-muted devices-note">Some work is still draining; its original records are kept.</p>
      )}
      {self && (
        (!status.protected || locked) ? (
          <SettingsRow
            title={locked ? 'Unlock' : 'Passphrase'}
            htmlFor={`${id}-passphrase`}
            description={locked ? 'Enter the passphrase for this device’s network keys' : 'Protect this device’s network keys with a passphrase'}
            control={
              <form className="devices-inline-form" onSubmit={submitPassphrase}>
                <input id={`${id}-passphrase`} className="settings-input" type="password" value={passphrase} disabled={busy || !!status.restartRequired} onChange={(event) => setPassphrase(event.target.value)} autoComplete={locked ? 'current-password' : 'new-password'} />
                <button type="submit" className="settings-btn" disabled={busy || !passphrase || !!status.restartRequired}>{locked ? 'Unlock' : 'Protect'}</button>
              </form>
            }
          />
        ) : (
          <SettingsRow title="Passphrase" description="Network keys on this device are protected" />
        )
      )}
    </SettingsGroup>

    {status && (
      <SettingsGroup
        title="My devices"
        icon={MonitorSmartphone}
        className="devices-group"
        description={devicesDescription}
        action={addMode && (
          <button type="button" className="settings-btn" disabled={busy || !!status.restartRequired || (addMode === 'invite' && !inviteReady)} onClick={() => { setError(''); setAdding(true) }}>
            <Plus size={14} />Add device
          </button>
        )}
      >
        {others.map((device) => (
          <SettingsRow
            key={device.node}
            title={device.name}
            description={deviceLine(device)}
            control={authority && <DeviceMenu name={device.name} disabled={busy} onRevoke={() => setRevoking(device)} />}
          />
        ))}
        {self && unlocked && !others.length && <p className="settings-muted devices-note">No other devices yet.</p>}
      </SettingsGroup>
    )}

    {status && (
      <SettingsAdvanced>
        {showAddons && (
          <SettingsGroup className="devices-group" title="Connection add-ons" description="Ways other devices can reach this one">
            {manifests.map((manifest) => {
              const live = status.transports?.find((t) => t.id === manifest.id)
              const on = !!live?.enabled
              const tip = manifest.setupSteps.map((step) => `${step.title}: ${step.detail}${step.command ? ` (${step.command})` : ''}`).join('\n')
              const cloudflare = manifest.id === 'cloudflared', relay = manifest.id === 'relay'
              const namedReady = !named || (!!tunnelId && !!hostname && !!credentialsFile)
              const enableSettings: Record<string, unknown> | undefined =
                cloudflare ? (named ? { mode: 'named', tunnelId, hostname, credentialsFile } : { mode: 'quick' })
                  : manifest.id === 'direct' ? { host: '127.0.0.1', port: 0 }
                    : manifest.id === 'tailscale' ? {}
                      : relay ? { address: relayAddress }
                        : undefined
              const canEnable = !!enableSettings && (!cloudflare || namedReady) && (!relay || !!relayAddress)
              const disableSettings = cloudflare ? { mode: 'quick' } : relay ? { address: relayAddress || live?.routes[0]?.address || '' } : {}
              const label = manifest.id === 'direct' ? 'Local listener' : manifest.id === 'tailscale' ? 'Tailscale' : relay ? 'Relay' : manifest.displayName
              return [
                <SettingsRow
                  key={manifest.id}
                  title={label}
                  description={<span title={tip}>{addonLine(manifest, live)}</span>}
                  control={
                    <>
                      {cloudflare && on && named && (
                        <button type="button" className="settings-btn" disabled={busy || !namedReady} onClick={() => void transport('cloudflared', true, enableSettings!)}>Apply</button>
                      )}
                      <Switch
                        checked={on}
                        label={label}
                        disabled={busy || (!on && !canEnable)}
                        onChange={(next) => void (next ? transport(manifest.id, true, enableSettings!) : transport(manifest.id, false, disableSettings))}
                      />
                    </>
                  }
                />,
                cloudflare && (
                  <SettingsRow key={`${manifest.id}-named`} indent title="Use a named tunnel" description="A tunnel in your own Cloudflare account" control={<Switch checked={named} label="Use a named tunnel" onChange={setNamed} />} />
                ),
                cloudflare && named && (
                  <SettingsRow key={`${manifest.id}-id`} indent title="Tunnel ID" htmlFor={`${id}-tunnel`} control={<input id={`${id}-tunnel`} className="settings-input" value={tunnelId} onChange={(event) => setTunnelId(event.target.value)} />} />
                ),
                cloudflare && named && (
                  <SettingsRow key={`${manifest.id}-host`} indent title="Hostname" htmlFor={`${id}-hostname`} control={<input id={`${id}-hostname`} className="settings-input" value={hostname} onChange={(event) => setHostname(event.target.value)} />} />
                ),
                cloudflare && named && (
                  <SettingsRow key={`${manifest.id}-creds`} indent title="Credentials file" description="Private file on this device" htmlFor={`${id}-creds`} control={<input id={`${id}-creds`} className="settings-input" value={credentialsFile} onChange={(event) => setCredentialsFile(event.target.value)} />} />
                ),
                relay && (
                  <SettingsRow key={`${manifest.id}-address`} indent title="Relay address" htmlFor={`${id}-relay`} control={<input id={`${id}-relay`} className="settings-input" value={relayAddress} placeholder="wss://relay.example.com" onChange={(event) => setRelayAddress(event.target.value)} />} />
                )
              ]
            })}
          </SettingsGroup>
        )}

        {status.enabled && self && (
          <SettingsGroup className="devices-group" title="Advertised routes">
            {status.routes.length
              ? status.routes.map((route) => <SettingsRow key={route.transport + route.address} title={route.transport} description={<code className="devices-code">{route.address}</code>} />)
              : <p className="settings-muted devices-note">No advertised route. Turn on an add-on to accept connections.</p>}
          </SettingsGroup>
        )}

        <SettingsGroup
          title="Connection checks"
          className="devices-group"
          action={<button type="button" className="settings-btn" disabled={busy} onClick={() => void action('net.doctor', {}, (value) => setDoctor(value as NetDoctor))}><RefreshCw size={14} />Check connection</button>}
        >
          {status.enabled && (
            <SettingsRow title="Features" description={`Bridge ${status.features?.netBridge ? 'on' : 'off'} · Spaces ${status.features?.netSpaces ? 'on' : 'off'}`} />
          )}
          {doctor?.checks.map((check) => (
            <SettingsRow
              key={check.name}
              title={check.message}
              description={check.code}
              control={check.ok
                ? <span className="settings-status-icon settings-status-ok" role="img" aria-label="Ready" title="Ready"><CircleCheck size={14} /></span>
                : <span className="settings-status-icon settings-status-warn" role="img" aria-label="Needs attention" title="Needs attention"><AlertTriangle size={14} /></span>}
            />
          ))}
          {!doctor && !status.enabled && <p className="settings-muted devices-note">Run a check to see what this device can reach.</p>}
        </SettingsGroup>

        {!!devices.length && <RemoteDeviceThreads devices={devices} />}
      </SettingsAdvanced>
    )}

    {adding && addMode === 'join' && (
      <Modal
        open
        title="Join my devices"
        onClose={closeAdd}
        footer={<button type="submit" form={`${id}-join`} className="settings-btn devices-dialog-btn primary" disabled={busy || !joinText.trim() || !passphrase || !name.trim()}>Join</button>}
      >
        <form id={`${id}-join`} className="devices-dialog" onSubmit={submitJoin}>
          <p className="settings-muted">Paste the invitation from one of your devices.</p>
          <label className="devices-field">
            <span>Invitation</span>
            <textarea value={joinText} autoFocus onChange={(event) => setJoinText(event.target.value)} aria-label="Device invitation to join" />
          </label>
          <label className="devices-field">
            <span>This device’s name</span>
            <input value={name} maxLength={120} onChange={(event) => { nameEdited.current = true; setName(event.target.value) }} />
          </label>
          <label className="devices-field">
            <span>Passphrase for this device</span>
            <input type="password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} autoComplete="new-password" />
          </label>
          {error && <p role="alert" className="chat-error">{error}</p>}
        </form>
      </Modal>
    )}

    {adding && addMode === 'invite' && (
      <Modal
        open
        title="Add a device"
        onClose={closeAdd}
        footer={
          invite
            ? undefined
            : <button type="button" className="settings-btn devices-dialog-btn primary" disabled={busy || !inviteReady} onClick={() => void action('bridge.invite', { name: 'New device' }, (value) => setInvite((value as { invite: string }).invite))}>Create invitation</button>
        }
      >
        <div className="devices-dialog">
          {invite ? (
            <>
              <p className="settings-muted">On the new device, open Settings → Devices → Add device and paste this. Share it privately.</p>
              <label className="devices-field">
                <span>Invitation</span>
                <textarea readOnly value={invite} autoFocus onFocus={(event) => event.currentTarget.select()} aria-label="Device invitation" />
              </label>
              <div className="devices-dialog-actions">
                <CopyButton text={invite} label="Copy invitation" />
              </div>
            </>
          ) : (
            <p className="settings-muted">Create an invitation code, then paste it on the new device.</p>
          )}
          {error && <p role="alert" className="chat-error">{error}</p>}
        </div>
      </Modal>
    )}

    {revoking && (
      <Modal
        open
        title={`Revoke ${revoking.name}?`}
        onClose={() => setRevoking(undefined)}
        footer={<button type="button" className="settings-btn devices-dialog-btn danger-fill" disabled={busy} onClick={() => { const node = revoking.node; setRevoking(undefined); void action('bridge.revoke', { node }) }}>Revoke</button>}
      >
        <p>{revoking.name} will no longer connect to your other devices.</p>
      </Modal>
    )}
  </>
}

