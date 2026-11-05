import { useEffect, useId, useState, type ReactNode } from 'react'
import { ChevronLeft, Laptop, Link2, Server, type LucideIcon } from '../../lib/icons'
import { formatCountdown, secondsLeft } from '../../lib/plusSignIn'
import { PAIRING_DISCLOSURE } from '../../lib/netDevices'
import { CopyButton } from '../settings/IconButtons'
import { Modal } from '../ui/Modal'

export type AddDeviceRouteId = 'invite' | 'join' | 'ssh'

export interface AddDeviceRoute {
  id: AddDeviceRouteId
  icon: LucideIcon
  title: string
  detail: string
  /** What this device needs first; the route cannot be taken until then. */
  blocked?: string
}

/** What this device is, as far as adding another device goes. */
export interface AddDeviceState {
  /** This device has a network identity. */
  hasIdentity: boolean
  unlocked: boolean
  /** This device manages the identity and can invite others. */
  authority: boolean
  /** Network keys are protected, which an invitation needs. */
  protectedKeys: boolean
}

/** Why this device cannot invite another one yet, or nothing when it can. */
function inviteBlocked(state: AddDeviceState): string | undefined {
  if (!state.hasIdentity) return 'Turn on networking first.'
  if (!state.unlocked) return 'Unlock this device first.'
  if (!state.authority) return 'Add it from the computer that manages your devices.'
  if (!state.protectedKeys) return 'Protect network keys first.'
  return undefined
}

/**
 * The three ways to add a device, each with what it needs first when it is not possible yet.
 * Inviting a computer and setting one up over SSH both need this device to sign the invitation;
 * joining is only for a device that has no network identity yet.
 */
export function addDeviceRoutes(state: AddDeviceState): AddDeviceRoute[] {
  const invite = inviteBlocked(state)
  return [
    { id: 'invite', icon: Laptop, title: 'Invite a computer', detail: 'Paste an invitation on a computer with Mousse.', blocked: invite },
    { id: 'join', icon: Link2, title: 'Join with invitation', detail: 'Paste an invitation from one of your devices.', blocked: state.hasIdentity ? 'Only on a device that is not set up yet.' : undefined },
    { id: 'ssh', icon: Server, title: 'Remote machine over SSH', detail: 'Set up Mousse on a machine you reach with ssh.', blocked: invite }
  ]
}

/** The first view of Add device: one row per route. An unavailable route stays focusable and says why. */
export function AddDeviceChooser({ routes, onChoose, onClose }: {
  routes: AddDeviceRoute[]
  onChoose: (route: AddDeviceRouteId) => void
  onClose: () => void
}) {
  const id = useId()
  // The routes name the task, so the title is for assistive tech only.
  return (
    <Modal open title="Add device" hideTitle onClose={onClose}>
      <div className="devices-routes" role="group" aria-label="Add device">
        {routes.map((route) => (
          <button
            key={route.id}
            type="button"
            className="devices-choice"
            data-route={route.id}
            aria-disabled={route.blocked ? true : undefined}
            aria-describedby={`${id}-${route.id}`}
            onClick={() => { if (!route.blocked) onChoose(route.id) }}
          >
            <route.icon size={14} aria-hidden="true" />
            <strong>{route.title}</strong>
            <span id={`${id}-${route.id}`}>{route.blocked ?? route.detail}</span>
          </button>
        ))}
      </div>
    </Modal>
  )
}

/** A Back button for a route's own view, returning to the choice of routes. */
export function RouteBack({ onBack }: { onBack: () => void }) {
  return (
    <button type="button" className="settings-icon-btn devices-back" title="Back" aria-label="Back" onClick={onBack}>
      <ChevronLeft size={16} />
    </button>
  )
}

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

export interface Invitation {
  text: string
  /** When the invitation stops working, in ms; an older daemon does not say. */
  expiresAt?: number
}

/** Invite a computer: create an invitation, then copy it. An expired one can be made again. */
export function InviteComputerDialog({ invitation, ready, busy, error, now: fixedNow, onCreate, onBack, onClose }: {
  invitation?: Invitation
  /** This device can sign an invitation now. */
  ready: boolean
  busy: boolean
  error?: string
  /** For tests: the time to show the countdown at. */
  now?: number
  onCreate: () => void
  onBack: () => void
  onClose: () => void
}) {
  const ticking = useNow(!!invitation?.expiresAt && fixedNow === undefined)
  const now = fixedNow ?? ticking
  const left = invitation?.expiresAt === undefined ? undefined : secondsLeft(invitation.expiresAt, now)
  const expired = left === 0
  const create = (label: string) => (
    <button type="button" className="settings-btn devices-dialog-btn primary" disabled={busy || !ready} onClick={onCreate}>{label}</button>
  )
  let body: ReactNode
  if (!invitation) body = <p className="settings-muted">{PAIRING_DISCLOSURE}</p>
  else if (expired) body = <p className="settings-muted">This invitation expired.</p>
  else body = <>
    <p className="settings-muted">On the other computer, open Settings → Devices → Add device → Join with invitation and paste this. Share it privately.</p>
    <label className="devices-field">
      <span>Invitation</span>
      <textarea readOnly value={invitation.text} autoFocus onFocus={(event) => event.currentTarget.select()} aria-label="Device invitation" />
    </label>
    <div className="devices-invite-foot">
      {left !== undefined && <span className="settings-muted">Expires in {formatCountdown(left)}</span>}
      <CopyButton text={invitation.text} label="Copy invitation" announce />
    </div>
  </>
  return (
    <Modal
      open
      title="Invite a computer"
      onClose={onClose}
      headerStart={<RouteBack onBack={onBack} />}
      footer={!invitation ? create('Create invitation') : expired ? create('Create new invitation') : undefined}
    >
      <div className="devices-dialog">
        {body}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
