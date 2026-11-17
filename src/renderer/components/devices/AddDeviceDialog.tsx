import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Laptop, Link2, Server, Smartphone, type LucideIcon } from '../../lib/icons'
import { formatCountdown, secondsLeft } from '../../lib/plusSignIn'
import { PAIRING_DISCLOSURE } from '../../lib/netDevices'
import { CopyButton } from '../settings/IconButtons'
import { Modal } from '../ui/Modal'

export type AddDeviceRouteId = 'invite' | 'phone' | 'ssh' | 'join'

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
  /**
   * Adding a phone through Mousse ID: absent in a build without Mousse ID, else what it needs first
   * (`blocked`), or nothing when a phone can be added now.
   */
  phone?: { blocked?: string }
  /** This computer's device pass lapsed: nothing can be added until it is renewed. */
  lapsed?: boolean
}

/** Why this device cannot invite another one yet, or nothing when it can. */
function inviteBlocked(state: AddDeviceState): string | undefined {
  if (state.lapsed) return 'Wait for this computer to reconnect first.'
  if (!state.hasIdentity) return 'Turn on networking first.'
  if (!state.unlocked) return 'Unlock this device first.'
  if (!state.authority) return 'Add it from the computer that manages your devices.'
  if (!state.protectedKeys) return 'Protect network keys first.'
  return undefined
}

/**
 * The ways to add a device, in the Add device menu, each with what it needs first when it is not possible yet.
 * Inviting a computer and setting one up over SSH both need this device to sign the invitation; a phone comes
 * through Mousse ID; joining is only for a device that has no network identity yet.
 */
export function addDeviceRoutes(state: AddDeviceState): AddDeviceRoute[] {
  const invite = inviteBlocked(state)
  return [
    { id: 'invite', icon: Laptop, title: 'Invite a computer', detail: 'Paste an invitation on a computer with Mousse.', blocked: invite },
    ...(state.phone ? [{ id: 'phone' as const, icon: Smartphone, title: 'Add a phone', detail: 'Scan a code with the Mousse app.', blocked: state.lapsed ? invite : state.phone.blocked }] : []),
    { id: 'ssh', icon: Server, title: 'Remote machine over SSH', detail: 'Set up Mousse on a machine you reach with ssh.', blocked: invite },
    { id: 'join', icon: Link2, title: 'Join with invitation', detail: 'Paste an invitation from one of your devices.', blocked: state.hasIdentity ? 'Only on a device that is not set up yet.' : undefined }
  ]
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
export function InviteComputerDialog({ invitation, ready, busy, error, now: fixedNow, onCreate, onClose }: {
  invitation?: Invitation
  /** This device can sign an invitation now. */
  ready: boolean
  busy: boolean
  error?: string
  /** For tests: the time to show the countdown at. */
  now?: number
  onCreate: () => void
  onClose: () => void
}) {
  const ticking = useNow(!!invitation?.expiresAt && fixedNow === undefined)
  const now = fixedNow ?? ticking
  const left = invitation?.expiresAt === undefined ? undefined : secondsLeft(invitation.expiresAt, now)
  const expired = left === 0
  const invitationRef = useRef<HTMLTextAreaElement>(null)
  // A refused copy leaves the whole invitation selected, ready to copy by hand.
  const selectInvitation = () => { invitationRef.current?.focus(); invitationRef.current?.select() }
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
      <textarea ref={invitationRef} readOnly value={invitation.text} autoFocus onFocus={(event) => event.currentTarget.select()} aria-label="Device invitation" />
    </label>
    <div className="devices-invite-foot">
      {left !== undefined && <span className="settings-muted">Expires in {formatCountdown(left)}</span>}
      <CopyButton text={invitation.text} label="Copy invitation" announce onFailed={selectInvitation} />
    </div>
  </>
  return (
    <Modal
      open
      title="Invite a computer"
      onClose={onClose}
      footer={!invitation ? create('Create invitation') : expired ? create('Create new invitation') : undefined}
    >
      <div className="devices-dialog">
        {body}
        {error && <p role="alert" className="chat-error">{error}</p>}
      </div>
    </Modal>
  )
}
