import { useEffect } from 'react'
import type { PlusEnrollmentRequestView } from '../../shared/net'
import { canApproveEnrollment, formatMatchCode, notifyEnrollmentRequest } from '../lib/plusEnrollment'
import { useAppStore } from '../stores/appStore'
import { currentEnrollmentRequest, useEnrollmentPromptStore, useEnrollmentRequestWatch } from '../stores/enrollmentPromptStore'
import { useMousseId, useMousseIdAvailable } from '../stores/mousseIdStore'
import { Check, X } from '../lib/icons'
import { Modal } from './ui/Modal'

export function EnrollmentRequestPrompt({
  request,
  busy,
  error,
  onDecide,
  onClose
}: {
  request: PlusEnrollmentRequestView
  busy: boolean
  error: string
  onDecide: (approve: boolean) => void
  onClose: () => void
}) {
  return (
    <Modal
      open
      className="enrollment-prompt"
      title={`${request.kind === 'computer' ? 'Computer' : 'Phone'} wants to join`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="settings-btn" data-action="deny-enrollment" disabled={busy} onClick={() => onDecide(false)}>
            <X size={14} />
            Deny
          </button>
          <button type="button" className="settings-btn" data-action="approve-enrollment" disabled={busy} onClick={() => onDecide(true)}>
            <Check size={14} className="settings-status-ok" />
            Approve
          </button>
        </>
      }
    >
      {error && <p role="alert" className="chat-error">{error}</p>}
      <p className="enrollment-device">{request.deviceName}</p>
      <p className="enrollment-code">
        Match code <strong>{formatMatchCode(request.matchCode)}</strong> · approve only if the {request.kind === 'computer' ? 'computer' : 'phone'} shows it
      </p>
    </Modal>
  )
}

/**
 * Asks about phone requests over any screen while this computer can approve them. Closing without
 * a choice hides a request until the window reloads; it stays under Settings → Devices.
 */
export function EnrollmentRequestHost() {
  const available = useMousseIdAvailable()
  const account = useMousseId(available)
  const profileId = useAppStore((s) => s.profileId)
  const active = available && canApproveEnrollment(account.net, account.plus)
  useEnrollmentRequestWatch(active, profileId)
  const { requests, dismissed, notified, busy, error, errorId, decide, dismiss, markNotified, prune } = useEnrollmentPromptStore()
  const current = active ? currentEnrollmentRequest({ requests, dismissed }) : undefined

  // The daemon sends no event when a request times out, so close it here.
  useEffect(() => {
    if (!current) return
    const timer = setTimeout(() => prune(), Math.max(0, current.expiresAt - Date.now()))
    return () => clearTimeout(timer)
  }, [current, prune])

  useEffect(() => {
    if (!current || notified.has(current.id)) return
    markNotified(current.id)
    if (!document.hasFocus()) notifyEnrollmentRequest(current)
  }, [current, notified, markNotified])

  if (!current) return null
  return (
    <EnrollmentRequestPrompt
      request={current}
      busy={busy}
      error={errorId === current.id ? error : ''}
      onDecide={(approve) => void decide(current.id, approve)}
      onClose={() => dismiss(current.id)}
    />
  )
}
