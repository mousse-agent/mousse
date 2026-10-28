import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { AlertTriangle, CircleCheck, Monitor, MonitorSmartphone, MoreHorizontal, Plus, RefreshCw, Smartphone } from '../lib/icons'
import { ChangePlanDialog } from './devices/ChangePlanDialog'
import { AddSshDeviceDialog } from './devices/AddSshDeviceDialog'
import { ApproveSshRouteDialog } from './devices/ApproveSshRouteDialog'
import { EditorSshSettings } from './devices/EditorSshSettings'
import { RenameEndpointDialog, UndoSetupDialog, UpdateRemoteDialog } from './devices/SshRecordDialogs'
import { Modal } from './ui/Modal'
import { takePendingDevice } from '../lib/settingsNavigation'
import { SettingsAdvanced, SettingsGroup, SettingsRow, Switch } from './settings/SettingsRow'
import { CopyButton } from './settings/IconButtons'
import { mousseIdAvailable, useMousseIdStore } from '../stores/mousseIdStore'
import { DeviceLimitsDialog } from './devices/DeviceLimitsDialog'
import { DeviceActivityRows } from './devices/DeviceActivityRows'
import { DeviceAccessRows } from './devices/DeviceAccessRows'
import { pendingEditorAsk, useEditorAskStore } from '../stores/editorAskStore'
import { PAIRING_DISCLOSURE, netErrorWords, bindSettings, workOnThreadsDisclosure, canWorkOnThreads, deviceLine, isComputer, isIncompatible, listedDevices, readDevices, routeDetails, serveSettings, sshRecordFor, updateInstructions, worksOnThreads, WORKS_ON_THREADS, type Device } from '../lib/netDevices'
import type { NetDoctor, NetStatus } from '../../shared/net'
import { TAILSCALE_FUNNEL_PORTS, type NetAddonActionResult, type NetAddonRecords, type SshRecordView, type SshSetupPhase } from '../../shared/net/local'
import type { PlatformRequestMethod } from '../../shared/platform'
import type { TransportManifest } from '../../mms/net/contracts'
import '../styles/devices.css'

type Transport = NonNullable<NetStatus['transports']>[number]

/** One line under "Networking" for this device. */
function networkingLine(status?: NetStatus): string {
  if (!status) return 'Loading…'
  if (status.restartRequired) return 'Off · restart the background service before turning it on again'
  const error = status.error ? ` · ${netErrorWords(status.error)}` : ''
  if (!status.self) return status.enabled ? `No network identity yet${error}` : 'Off · turning it on creates a network identity for this device'
  if (!status.enabled) return status.keystore === 'unlocked' ? `Off · local conversations and network records are kept${error}` : `Off · unlock below to turn it on${error}`
  if (status.keystore === 'locked') return `On · locked until you enter the passphrase${error}`
  if (status.rosterState === 'conflict') return `On · device list conflict, recovery required${error}`
  return `On${error}`
}

const SETUP_PHASE: Record<SshSetupPhase, string> = {
  running: 'Setting up',
  done: 'Set up',
  failed: 'Setup failed',
  cancelled: 'Setup cancelled',
  interrupted: 'Setup interrupted'
}

const TRANSPORT_STATE: Record<Transport['state'], string> = {
  disabled: 'Off',
  provisioning: 'Starting',
  ready: 'On',
  degraded: 'On · degraded',
  failed: 'Failed'
}

function addonLine(manifest: TransportManifest, live?: Transport): string {
  if (live?.enabled) {
    const why = live.detail ?? live.error
    return `${TRANSPORT_STATE[live.state]}${why ? ` · ${why}` : ''}`
  }
  const step = manifest.setupSteps[0]
  if (!step) return live?.error ? `Off · ${live.error}` : 'Off'
  return step.command ? `${step.title}: ${step.command}` : step.title
}

interface MenuItem { label: string; danger?: boolean; onSelect: () => void }

/** Overflow menu on a device row. */
function DeviceMenu({ name, disabled, items }: { name: string; disabled: boolean; items: MenuItem[] }) {
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
          {items.map((item) => (
            <button key={item.label} type="button" role="menuitem" className={item.danger ? 'devices-menu-item danger' : 'devices-menu-item'} onClick={() => { setOpen(false); item.onSelect() }}>{item.label}</button>
          ))}
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
  const [sshEndpoint, setSshEndpoint] = useState(''), [sshPort, setSshPort] = useState('')
  const [adding, setAdding] = useState(false), [addKind, setAddKind] = useState<'computer'>(), [revoking, setRevoking] = useState<Device>(), [updating, setUpdating] = useState<Device>()
  const [records, setRecords] = useState<NetAddonRecords>({}), [saved, setSaved] = useState<Record<string, unknown>>({}), [notice, setNotice] = useState(''), [servePort, setServePort] = useState('47890'), [serveDialog, setServeDialog] = useState<{ wasOn: boolean }>()
  const [sshRecords, setSshRecords] = useState<SshRecordView[]>([]), [sshSetup, setSshSetup] = useState<{ setupId?: string }>(), [approving, setApproving] = useState<Device & { sshOffer: { endpoint: string } }>()
  const [recordDialog, setRecordDialog] = useState<{ kind: 'undo' | 'rename' | 'update'; record: SshRecordView; name: string }>()
  const [limits, setLimits] = useState<Device>()
  // A grant that opens this computer's threads to another is confirmed with what it opens.
  const [granting, setGranting] = useState<{ device: Device; kind: 'grant' | 'computer' }>()
  const nameEdited = useRef(false)
  // Asks for editor connections: the prompt host watches them for the whole window; this screen reads that list.
  const editorAsks = useEditorAskStore((s) => s.asks)
  useEffect(() => { void useEditorAskStore.getState().load() }, [])
  const reload = async () => {
    const owner = ++generation.current
    const { current, addons, nodes, ssh } = await readDevices(mousseIdAvailable(useMousseIdStore.getState()))
    if (alive.current && owner === generation.current) { setStatus(current); setManifests(addons.manifests); setRecords(addons.records ?? {}); setSaved(addons.settings ?? {}); setDevices(nodes); setSshRecords(ssh) }
  }
  useEffect(() => {
    alive.current = true
    let active = true, running = false
    const refresh = async () => {
      if (running) return
      running = true
      try {
        const owner = ++generation.current
        const { current, addons, nodes, ssh } = await readDevices(mousseIdAvailable(useMousseIdStore.getState()))
        if (active && owner === generation.current) { setStatus(current); setManifests(addons.manifests); setRecords(addons.records ?? {}); setSaved(addons.settings ?? {}); setDevices(nodes); setSshRecords(ssh) }
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
  const transport = (transportId: string, enabled: boolean, settings?: Record<string, unknown>) => action('net.transport.configure', { id: transportId, enabled, ...(settings ? { settings } : {}) })

  // Tailscale Serve keeps the daemon on loopback and lets Tailscale forward a tailnet port to it.
  const call = <T,>(method: PlatformRequestMethod, params: unknown) => window.mousse.platformRequest.request<T>(method, params)
  const tailscale = status?.transports?.find((t) => t.id === 'tailscale')
  const served = records.tailscale?.action === 'serve' ? (records.tailscale.record as { port: number; servePort: number; state?: string }) : undefined
  const servePending = served?.state === 'pending'
  const portValue = Number.parseInt(servePort, 10)
  // Tailscale uses 443, 8443 and 10000 for Funnel (the public internet); Serve never does.
  const portValid = /^\d+$/.test(servePort) && portValue >= 1024 && portValue <= 65535 && !TAILSCALE_FUNNEL_PORTS.includes(portValue)
  const tailscaleSaved = saved.tailscale
  // The saved settings (a custom binary path) travel with every change to this add-on.
  const serveSettingsNow = served ? serveSettings(tailscaleSaved, served.port, served.servePort) : serveSettings(tailscaleSaved, portValue, portValue)
  const serveUndo = async (enabled: boolean) => {
    const result = await call<NetAddonActionResult>('net.transport.action.undo', { id: 'tailscale', action: 'serve' })
    // Without Serve the add-on goes back to listening on the tailnet address, as before. While networking is off there is nothing to restart.
    if (result.ok && status?.enabled) await call('net.transport.configure', { id: 'tailscale', enabled, settings: bindSettings(tailscaleSaved) })
    return result
  }
  const turnOffServe = async () => {
    generation.current++; setBusy(true); setError(''); setNotice('')
    try {
      const result = await serveUndo(!!tailscale?.enabled)
      if (!result.ok) setError(result.message)
      else if (result.outcome && result.outcome !== 'removed' && result.message) setNotice(result.message)
      if (alive.current) await reload()
    } catch (cause) { if (alive.current) setError(String((cause as Error)?.message ?? cause)) }
    finally { if (alive.current) setBusy(false) }
  }
  // Mousse takes its loopback port first; only then is a tailnet port forwarded to it. A failed run puts the add-on back as it was.
  const turnOnServe = async (wasOn: boolean): Promise<NetAddonActionResult> => {
    const revert = () => call('net.transport.configure', { id: 'tailscale', enabled: wasOn, settings: bindSettings(tailscaleSaved) }).catch(() => undefined)
    try {
      const configured = await call<{ transports?: Transport[] }>('net.transport.configure', { id: 'tailscale', enabled: true, settings: serveSettingsNow })
      const row = configured.transports?.find((t) => t.id === 'tailscale')
      if (row?.state === 'failed') {
        await revert()
        return { ok: false, code: 'route_unreachable', message: row.detail ?? 'Tailscale could not start with Serve.' }
      }
      const result = await call<NetAddonActionResult>('net.transport.action.apply', { id: 'tailscale', action: 'serve', settings: serveSettingsNow })
      if (!result.ok) await revert()
      return result
    } catch (cause) {
      await revert()
      throw cause
    }
  }

  const self = status?.self
  const selfDevice = devices.find((device) => device.self)
  const others = listedDevices(devices).filter((device) => !device.self)
  // A device asked for from elsewhere in the app (an editor that needs SSH to it) is brought into view and marked for a moment.
  const [picked, setPicked] = useState<string>()
  useEffect(() => {
    const pick = () => { const node = takePendingDevice(); if (node) setPicked(node) }
    pick()
    window.addEventListener('mousse:settings-device', pick)
    return () => window.removeEventListener('mousse:settings-device', pick)
  }, [])
  useEffect(() => {
    if (!picked) return
    document.querySelector(`[data-device-node="${picked}"]`)?.scrollIntoView({ block: 'center' })
    const timer = window.setTimeout(() => setPicked(undefined), 4000)
    return () => window.clearTimeout(timer)
  }, [picked, others.length])
  const unlocked = status?.keystore === 'unlocked'
  const authority = !!self?.isAuthority
  // On unless this computer turned it off; an older daemon that does not report it has no such switch.
  const workOnThreads = status?.workOnThreads !== false

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
  const closeAdd = () => { setAdding(false); setAddKind(undefined); setInvite(''); setJoinText(''); setPassphrase('') }
  const reloadQuietly = () => void reload().catch(() => undefined)
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
  // Setups over SSH that stopped before the machine joined; they have no device row yet.
  const unfinished = sshRecords.filter((record) => record.phase !== 'done' && !record.node)
  const deviceMenu = (device: Device): MenuItem[] => {
    const record = sshRecordFor(device, sshRecords)
    const open = (kind: 'undo' | 'rename' | 'update') => () => { if (record) setRecordDialog({ kind, record, name: device.name }) }
    const blocked = !!device.policy?.blocked
    return [
      // Limits live on this computer, so they need no authority. A daemon from before them sends no policy.
      ...(device.policy ? [
        blocked
          ? { label: 'Unblock', onSelect: () => void action('bridge.policy', { node: device.node, blocked: false }) }
          : { label: 'Block on this computer', danger: true, onSelect: () => void action('bridge.policy', { node: device.node, blocked: true }) },
        ...(isComputer(device) ? [{ label: 'Limits on this computer…', onSelect: () => setLimits(device) }] : [])
      ] : []),
      // Only the device that owns the identity can sign a grant, and only to a device it knows is a
      // computer. One it never recorded a kind for is asked about first.
      ...(authority && canWorkOnThreads(device) ? [{
        label: worksOnThreads(device) ? 'Turn off Works on threads' : 'Turn on Works on threads',
        onSelect: () => worksOnThreads(device)
          ? void action('bridge.setCaps', { node: device.node, caps: device.caps.filter((cap) => cap !== WORKS_ON_THREADS) })
          : setGranting({ device, kind: 'grant' })
      }] : []),
      ...(authority && device.kind === 'unknown' ? [
        { label: 'This is a computer', onSelect: () => setGranting({ device, kind: 'computer' }) },
        { label: 'This is a phone', onSelect: () => void action('bridge.setKind', { node: device.node, kind: 'phone' }) }
      ] : []),
      ...(record ? [{ label: 'Undo setup…', onSelect: open('undo') }, { label: 'Rename SSH endpoint…', onSelect: open('rename') }] : []),
      ...(record?.owner === 'managed' ? [{ label: 'Update…', onSelect: open('update') }] : []),
      ...(authority ? [{ label: 'Revoke…', danger: true, onSelect: () => setRevoking(device) }] : [])
    ]
  }

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
      {self && status?.enabled && unlocked && !authority && selfDevice && (
        <SettingsRow
          title="Works on threads"
          description={worksOnThreads(selfDevice)
            ? 'On · this computer can open and change threads on your other computers that share them'
            : 'Off · this computer cannot work on threads on your other computers, which is why theirs are not listed. The computer that manages your devices can turn it on for this one.'}
        />
      )}
      {self && status?.enabled && unlocked && status.workOnThreads !== undefined && (
        <SettingsRow
          title="Let my other computers work on this computer's threads"
          description={workOnThreads
            ? 'On · computers with Works on threads can open and change this computer’s threads, within the limits set for each device below'
            : 'Off · no other computer can open or change this computer’s threads'}
          control={<Switch checked={workOnThreads} label="Let my other computers work on this computer's threads" disabled={busy} onChange={(next) => void action('bridge.workOnThreads', { enabled: next })} />}
        />
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
        {others.map((device) => {
          const items = deviceMenu(device), offer = device.sshOffer, record = sshRecordFor(device, sshRecords)
          return [
            <SettingsRow
              key={device.node}
              data-device-node={device.node}
              className={picked === device.node ? 'devices-row-picked' : undefined}
              title={device.name}
              titleAction={device.kind === 'phone'
                ? <span className="devices-kind" title="Phone"><Smartphone size={13} aria-hidden="true" />Phone</span>
                : authority && device.kind === 'unknown'
                  ? <span className="devices-kind" title="This device never told this computer what it is. Choose This is a computer or This is a phone in its menu.">Unknown device</span>
                  : undefined}
              description={<span title={routeDetails(device) || undefined}>{deviceLine(device, Date.now())}{offer ? ' · offers an SSH route' : ''}</span>}
              control={<>
                {offer && <button type="button" className="settings-btn" disabled={busy} onClick={() => setApproving({ ...device, sshOffer: offer })}>Use SSH route…</button>}
                {items.length > 0 && <DeviceMenu name={device.name} disabled={busy} items={items} />}
              </>}
            />,
            isIncompatible(device) && (
              <SettingsRow key={`${device.node}-incompatible`} indent title="Incompatible version" description={`Update ${device.name} or this device so they can talk to each other.`} />
            ),
            device.olderThanThis && (
              <SettingsRow
                key={`${device.node}-older`}
                indent
                title={device.version ? `Older than this device (${device.version})` : 'Older than this device'}
                description={device.version ? `This device runs ${selfDevice?.version ?? 'a newer version'}.` : `${device.name} is too old to report its version${selfDevice?.version ? `; this device runs ${selfDevice.version}` : ''}.`}
                control={record?.owner === 'managed'
                  ? <button type="button" className="settings-btn" onClick={() => setRecordDialog({ kind: 'update', record, name: device.name })}>Update…</button>
                  : selfDevice?.version && <button type="button" className="settings-btn" onClick={() => setUpdating(device)}>{updateInstructions(device, selfDevice.version).command ? 'Show command' : 'How to update'}</button>}
              />
            ),
            // Terminals and editor connections from it, side by side, with a waiting ask answered here too.
            device.policy && isComputer(device) && worksOnThreads(device) && !device.policy.blocked && (
              <DeviceAccessRows
                key={`${device.node}-access`}
                device={device}
                ask={pendingEditorAsk({ asks: editorAsks }, device.node)}
                onChanged={reloadQuietly}
              />
            ),
            // What it did here, with its Block and limits beside it. A phone has none of this: it keeps the phone API.
            device.policy && isComputer(device) && (
              <DeviceActivityRows
                key={`${device.node}-activity`}
                device={device}
                onLimits={() => setLimits(device)}
                onBlock={(blocked) => void action('bridge.policy', { node: device.node, blocked })}
              />
            )
          ]
        })}
        {self && unlocked && !others.length && <p className="settings-muted devices-note">No other devices yet.</p>}
      </SettingsGroup>
    )}

    {status && <EditorSshSettings />}

    {status && unfinished.length > 0 && (
      <SettingsGroup title="Unfinished remote machine setups" className="devices-group">
        {unfinished.map((record) => (
          <SettingsRow
            key={record.id}
            title={record.endpoint}
            description={SETUP_PHASE[record.phase]}
            control={record.phase === 'running'
              ? <button type="button" className="settings-btn" onClick={() => setSshSetup({ setupId: record.id })}>Show progress</button>
              : record.recoverable && <>
                <button type="button" className="settings-btn" disabled={busy} onClick={() => void action('net.ssh.setup.retry', { id: record.id }, () => setSshSetup({ setupId: record.id }))}>Retry</button>
                <button type="button" className="settings-btn" disabled={busy} onClick={() => setRecordDialog({ kind: 'undo', record, name: record.endpoint })}>Undo…</button>
              </>}
          />
        ))}
      </SettingsGroup>
    )}

    {status && served && !showAddons && (
      <SettingsGroup className="devices-group" title="Tailscale Serve">
        <SettingsRow
          title="Tailscale Serve"
          description={servePending ? 'Started but not confirmed · Turn off Serve clears it' : `Still on · tailnet port ${served.servePort} forwards to this device, also while networking is off`}
          control={<button type="button" className="settings-btn" disabled={busy} onClick={() => void turnOffServe()}>Turn off Serve</button>}
        />
      </SettingsGroup>
    )}
    {notice && <p role="status" className="settings-muted devices-note">{notice}</p>}

    {status && (
      <SettingsAdvanced>
        {showAddons && (
          <SettingsGroup className="devices-group" title="Connection add-ons" description="Ways other devices can reach this one">
            {manifests.map((manifest) => {
              const live = status.transports?.find((t) => t.id === manifest.id)
              const on = !!live?.enabled
              const tip = manifest.setupSteps.map((step) => `${step.title}: ${step.detail}${step.command ? ` (${step.command})` : ''}`).join('\n')
              const cloudflare = manifest.id === 'cloudflared', relay = manifest.id === 'relay', ssh = manifest.id === 'ssh'
              const namedReady = !named || (!!tunnelId && !!hostname && !!credentialsFile)
              const sshPortNumber = Number(sshPort), sshReady = !!sshEndpoint.trim() && Number.isInteger(sshPortNumber) && sshPortNumber >= 1 && sshPortNumber <= 65535
              const enableSettings: Record<string, unknown> | undefined =
                cloudflare ? (named ? { mode: 'named', tunnelId, hostname, credentialsFile } : { mode: 'quick' })
                  : manifest.id === 'direct' ? { host: '127.0.0.1', port: 0 }
                    : manifest.id === 'tailscale' ? (served ? serveSettingsNow : bindSettings(tailscaleSaved))
                      : relay ? { address: relayAddress }
                        : ssh ? (sshReady ? { endpoint: sshEndpoint.trim(), port: sshPortNumber } : undefined)
                          : undefined
              const canEnable = !!enableSettings && (!cloudflare || namedReady) && (!relay || !!relayAddress)
              // Switching SSH off keeps the saved settings, which the screen may not have (a listener that failed to start has no route and the form starts empty).
              const disableSettings = cloudflare ? { mode: 'quick' } : relay ? { address: relayAddress || live?.routes[0]?.address || '' } : ssh || manifest.id === 'tailscale' ? undefined : {}
              const label = manifest.id === 'direct' ? 'Local listener' : manifest.id === 'tailscale' ? 'Tailscale' : relay ? 'Relay' : ssh ? 'SSH (for devices that can ssh here)' : manifest.displayName
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
                manifest.id === 'tailscale' && manifest.actions?.some((entry) => entry.id === 'serve') && (
                  <SettingsRow
                    key={`${manifest.id}-serve`}
                    indent
                    title="Tailscale Serve"
                    description={served ? (servePending ? 'Started but not confirmed · Turn off Serve clears it' : `On · tailnet port ${served.servePort} forwards to this device`) : 'Keep the listener on this computer only and let Tailscale forward a tailnet port to it'}
                    control={served
                      ? <button type="button" className="settings-btn" disabled={busy} onClick={() => void turnOffServe()}>Turn off Serve</button>
                      : (
                        <div className="devices-inline-form">
                          <input className="settings-input devices-port-input" inputMode="numeric" aria-label="Tailnet port" title="Not 443, 8443 or 10000: Tailscale uses those for Funnel" aria-invalid={!portValid} value={servePort} disabled={busy} onChange={(event) => setServePort(event.target.value)} />
                          <button type="button" className="settings-btn" disabled={busy || !portValid} onClick={() => { setError(''); setServeDialog({ wasOn: !!tailscale?.enabled }) }}>Turn on Serve…</button>
                        </div>
                      )}
                  />
                ),
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
                ),
                ssh && (
                  <SettingsRow key={`${manifest.id}-endpoint`} indent title="SSH address" description="What other devices type after ssh: [user@]host[:port]" htmlFor={`${id}-ssh-endpoint`} control={<input id={`${id}-ssh-endpoint`} className="settings-input" value={sshEndpoint} placeholder="me@box.example.com" onChange={(event) => setSshEndpoint(event.target.value)} />} />
                ),
                ssh && (
                  <SettingsRow key={`${manifest.id}-port`} indent title="Daemon port" description="A free port on this computer, reachable only through SSH" htmlFor={`${id}-ssh-port`} control={<input id={`${id}-ssh-port`} className="settings-input" inputMode="numeric" value={sshPort} placeholder="47821" onChange={(event) => setSshPort(event.target.value)} />} />
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

    {adding && addMode === 'invite' && !addKind && (
      <Modal open title="Add a device" onClose={closeAdd}>
        <div className="devices-dialog">
          <button type="button" className="devices-choice" onClick={() => setAddKind('computer')}>
            <span>Another computer with Mousse</span>
            <span className="settings-muted">Create an invitation and paste it on the other computer. {PAIRING_DISCLOSURE}</span>
          </button>
          <button type="button" className="devices-choice" onClick={() => { closeAdd(); setSshSetup({}) }}>
            <span>Remote machine over SSH</span>
            <span className="settings-muted">Set up Mousse on a machine you reach with ssh.</span>
          </button>
        </div>
      </Modal>
    )}

    {adding && addMode === 'invite' && addKind === 'computer' && (
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
            <p className="settings-muted">Create an invitation code, then paste it on the new device. {PAIRING_DISCLOSURE}</p>
          )}
          {error && <p role="alert" className="chat-error">{error}</p>}
        </div>
      </Modal>
    )}

    {updating && selfDevice?.version && (() => {
      const instructions = updateInstructions(updating, selfDevice.version)
      return (
        <Modal open title={`Update ${updating.name}`} onClose={() => setUpdating(undefined)}>
          <div className="devices-dialog">
            <p>{instructions.summary}</p>
            {instructions.command && (
              <>
                <code className="devices-code devices-code-block">{instructions.command}</code>
                <div className="devices-dialog-actions">
                  <CopyButton text={instructions.command} label="Copy command" />
                </div>
              </>
            )}
          </div>
        </Modal>
      )
    })()}

    {serveDialog && (
      <ChangePlanDialog
        title="Turn on Tailscale Serve"
        describe={() => call<NetAddonActionResult>('net.transport.action.describe', { id: 'tailscale', action: 'serve', settings: serveSettingsNow })}
        apply={() => turnOnServe(serveDialog.wasOn)}
        undo={() => serveUndo(serveDialog.wasOn)}
        onClose={() => setServeDialog(undefined)}
        onChanged={() => void reload()}
      />
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

    {sshSetup && <AddSshDeviceDialog open setupId={sshSetup.setupId} onClose={() => { setSshSetup(undefined); reloadQuietly() }} onDone={reloadQuietly} />}
    {approving && <ApproveSshRouteDialog node={approving.node} name={approving.name} endpoint={approving.sshOffer.endpoint} onClose={() => setApproving(undefined)} onDone={reloadQuietly} />}
    {recordDialog?.kind === 'undo' && <UndoSetupDialog record={recordDialog.record} name={recordDialog.name} onClose={() => setRecordDialog(undefined)} onDone={reloadQuietly} />}
    {recordDialog?.kind === 'rename' && <RenameEndpointDialog record={recordDialog.record} name={recordDialog.name} onClose={() => setRecordDialog(undefined)} onDone={reloadQuietly} />}
    {recordDialog?.kind === 'update' && <UpdateRemoteDialog record={recordDialog.record} name={recordDialog.name} onClose={() => setRecordDialog(undefined)} onDone={reloadQuietly} />}
    {granting && (
      <Modal
        open
        title={granting.kind === 'grant' ? `Turn on Works on threads for ${granting.device.name}?` : `Is ${granting.device.name} a computer?`}
        onClose={() => setGranting(undefined)}
        footer={<button type="button" className="settings-btn devices-dialog-btn primary" disabled={busy} onClick={() => {
          const { device, kind } = granting
          setGranting(undefined)
          void (kind === 'grant'
            ? action('bridge.setCaps', { node: device.node, caps: [...device.caps, WORKS_ON_THREADS] })
            : action('bridge.setKind', { node: device.node, kind: 'computer' }))
        }}>{granting.kind === 'grant' ? 'Turn on' : 'This is a computer'}</button>}
      >
        <div className="devices-dialog">
          <p>{workOnThreadsDisclosure(granting.device.name, granting.device.policy?.maxPermissionMode)}</p>
        </div>
      </Modal>
    )}
    {limits?.policy && <DeviceLimitsDialog node={limits.node} name={limits.name} policy={limits.policy} onClose={() => setLimits(undefined)} onDone={reloadQuietly} />}
  </>
}

