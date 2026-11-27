import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Laptop, Server } from '../../lib/icons'
import type { NetStatus } from '../../../shared/net'
import type { NetAddonRecords, SshRecordView } from '../../../shared/net/local'
import type { TransportManifest } from '../../../mms/net/contracts'
import {
  accessHere,
  accessWords,
  allowDetail,
  connectedHere,
  connectStep,
  isComputer,
  isIncompatible,
  lastSeenLabel,
  listedDevices,
  presetLabel,
  readDevices,
  routeDetails,
  type Device
} from '../../lib/netDevices'
import { mousseIdAvailable, useMousseIdStore } from '../../stores/mousseIdStore'
import { SettingsRow } from '../settings/SettingsRow'

/*
 * The old networking, drawn in the engine's layout. It keeps serving the devices paired under it, phones and
 * relays until the engine takes them over (engine Phases 2–4); this file goes with it.
 */

export interface LegacyNet {
  status?: NetStatus
  devices: Device[]
  manifests: TransportManifest[]
  records: NetAddonRecords
  saved: Record<string, unknown>
  ssh: SshRecordView[]
}

const EMPTY: LegacyNet = { devices: [], manifests: [], records: {}, saved: {}, ssh: [] }

/** The old networking's state, read every 5 seconds. A failed read keeps the last one and shows nothing. */
export function useLegacyNet(): LegacyNet & { reload: () => Promise<void> } {
  const [state, setState] = useState<LegacyNet>(EMPTY)
  const generation = useRef(0)
  const alive = useRef(true)
  const reload = useCallback(async () => {
    const owner = ++generation.current
    const { current, addons, nodes, ssh } = await readDevices(
      mousseIdAvailable(useMousseIdStore.getState())
    )
    if (!alive.current || owner !== generation.current) return
    setState({
      status: current,
      devices: nodes ?? [],
      manifests: addons.manifests ?? [],
      records: addons.records ?? {},
      saved: addons.settings ?? {},
      ssh
    })
  }, [])
  useEffect(() => {
    alive.current = true
    const refresh = () => void reload().catch(() => undefined)
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {
      alive.current = false
      clearInterval(timer)
    }
  }, [reload])
  return { ...state, reload }
}

/** The old networking is on for this profile. */
export const legacyOn = (status?: NetStatus): boolean => status?.enabled === true

/** The old networking's other devices for the merged list: engine pairings are drawn from the engine's own list. */
export function legacyListed(devices: Device[]): Device[] {
  return listedDevices(devices).filter(
    (device) => !device.self && device.source !== 'engine' && device.connection !== 'held'
  )
}

/** How an old pairing is connected, in plain words. */
const V1_HOW: Record<string, string> = {
  direct: 'same network',
  tailscale: 'via Tailscale',
  ssh: 'over SSH',
  relay: 'via relay',
  'plus-relay': 'via relay',
  cloudflared: 'over the internet',
  'phone-webrtc': 'directly'
}

export const legacyHow = (device: Device): string | undefined =>
  device.state === 'open' && device.route?.transport
    ? (V1_HOW[device.route.transport] ?? `via ${device.route.transport}`)
    : undefined

/** What a device may do here, as the row's last words; undefined when it may do nothing worth naming. */
export function accessShort(
  device: Device | undefined,
  switches: { workOnThreads: boolean }
): string | undefined {
  if (!device?.policy) return undefined
  if (device.policy.blocked) return 'Blocked here'
  if (!connectedHere(device)) return undefined
  const preset = presetLabel(device)
  if (preset) return preset
  const access = accessHere(device, switches)
  if (!access || typeof access === 'string') return undefined
  const line = accessWords(access, { phone: !isComputer(device) }).line
  return line === 'Nothing' ? undefined : line
}

/** An old pairing's row line: its state in plain words, then the fix as the tooltip. */
export function legacyLine(
  device: Device,
  now: number,
  { signedOut = false }: { signedOut?: boolean } = {}
): { line: string; detail?: string; warn?: boolean } {
  const routes = routeDetails(device) || undefined
  if (isIncompatible(device))
    return {
      line: 'Needs an update',
      detail: `Update Mousse on ${device.name} or on this computer so they can work together.`,
      warn: true
    }
  if (!connectedHere(device)) {
    const step = connectStep(device)
    return {
      line: 'Not connected here',
      detail: step && 'hint' in step ? 'Pair it again from Devices.' : 'Connect from its menu.'
    }
  }
  if (device.state === 'open')
    return { line: ['Connected', legacyHow(device)].filter(Boolean).join(' · '), detail: routes }
  if (device.state === 'connecting') return { line: 'Connecting…', detail: routes }
  const seen = lastSeenLabel(device.lastSeenAt, now)
  return {
    line: signedOut ? 'Not nearby' : `Can't reach it · open Mousse on ${device.name}`,
    detail: [seen && `${seen[0]!.toUpperCase()}${seen.slice(1)}.`, routes].filter(Boolean).join('\n') || undefined
  }
}

/** A computer that came in by a link and waits for Allow, on either side. */
export function LegacyHeldRow({
  device,
  side,
  busy,
  canRemove,
  onAllow,
  onNotNow,
  onRemove
}: {
  device: Device
  side: 'maker' | 'joiner'
  busy: boolean
  canRemove: boolean
  onAllow: () => void
  onNotNow: () => void
  onRemove: () => void
}) {
  return (
    <SettingsRow
      leading={<Laptop size={16} />}
      title={device.name}
      description={<span title={allowDetail(device.name, side)}>Wants to connect</span>}
      control={
        <>
          {side === 'maker' ? (
            canRemove && (
              <button type="button" className="settings-btn" disabled={busy} onClick={onRemove}>
                Remove…
              </button>
            )
          ) : (
            <button type="button" className="settings-btn" disabled={busy} onClick={onNotNow}>
              Not now
            </button>
          )}
          <button
            type="button"
            className="settings-btn primary"
            data-mousse-decision=""
            disabled={busy}
            title={allowDetail(device.name, side)}
            onClick={onAllow}
          >
            Allow
          </button>
        </>
      }
    />
  )
}

/** A join that stopped before its answer: Retry (with the passphrase while locked) or Give up. */
export function LegacyJoinRow({
  name,
  locked,
  busy,
  onRetry,
  onGiveUp
}: {
  name?: string
  locked: boolean
  busy: boolean
  onRetry: (passphrase?: string) => void
  onGiveUp: () => void
}) {
  const [passphrase, setPassphrase] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy || (locked && !passphrase)) return
    onRetry(locked ? passphrase : undefined)
    setPassphrase('')
  }
  return (
    <SettingsRow
      leading={<Laptop size={16} />}
      title={name ?? 'The other computer'}
      description={locked ? 'Enter this computer’s passphrase to retry' : 'Connecting didn’t finish'}
      control={
        <form className="devices-inline-form" onSubmit={submit}>
          {locked && (
            <input
              className="settings-input"
              type="password"
              aria-label="Passphrase"
              value={passphrase}
              disabled={busy}
              onChange={(event) => setPassphrase(event.target.value)}
              autoComplete="current-password"
            />
          )}
          <button type="submit" className="settings-btn" disabled={busy || (locked && !passphrase)}>
            Retry
          </button>
          <button type="button" className="settings-btn" disabled={busy} onClick={onGiveUp}>
            Give up…
          </button>
        </form>
      }
    />
  )
}

/** A setup over SSH that stopped before the machine joined: it can only be undone from here. */
export function LegacyUnfinishedSshRow({
  record,
  busy,
  onUndo
}: {
  record: SshRecordView
  busy: boolean
  onUndo: () => void
}) {
  return (
    <SettingsRow
      leading={<Server size={16} />}
      title={record.endpoint}
      description={record.phase === 'running' ? 'Setting up over SSH…' : 'Setup over SSH didn’t finish'}
      control={
        record.phase !== 'running' &&
        record.recoverable && (
          <button type="button" className="settings-btn" disabled={busy} onClick={onUndo}>
            Undo…
          </button>
        )
      }
    />
  )
}

/** The old networking's keys stay locked after a restart until the passphrase is entered. */
export function LegacyUnlockRow({
  busy,
  onUnlock
}: {
  busy: boolean
  onUnlock: (passphrase: string) => void
}) {
  const [passphrase, setPassphrase] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!passphrase || busy) return
    onUnlock(passphrase)
    setPassphrase('')
  }
  return (
    <SettingsRow
      title="Unlock to reach older devices"
      anchor="devices-passphrase"
      description={
        <span title="Devices paired before this version connect once the passphrase is entered.">
          Enter the passphrase you chose for this computer
        </span>
      }
      control={
        <form className="devices-inline-form" onSubmit={submit}>
          <input
            className="settings-input"
            type="password"
            aria-label="Passphrase"
            value={passphrase}
            disabled={busy}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="current-password"
          />
          <button type="submit" className="settings-btn" disabled={busy || !passphrase}>
            Unlock
          </button>
        </form>
      }
    />
  )
}
