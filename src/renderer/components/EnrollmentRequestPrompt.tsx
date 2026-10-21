import { useEffect } from 'react'
import type { PlusEnrollmentRequestView } from '../../shared/net'
import { formatMatchCode, notifyEnrollmentRequest } from '../lib/plusEnrollment'
import { useAppStore } from '../stores/appStore'
import { currentEnrollmentRequest, useEnrollmentPromptStore, useEnrollmentRequestWatch } from '../stores/enrollmentPromptStore'
import { useMousseId, useMousseIdAvailable } from '../stores/mousseIdStore'
import { Modal } from './ui/Modal'

/** Device name and match code of a phone request, shared by the dialog and Settings → Devices. */
export function EnrollmentRequestDetails({ request }: { request: PlusEnrollmentRequestView }) {
  return (
    <div>
      <strong>{request.deviceName}</strong>
      <span>
        Wants to join · match code <strong>{formatMatchCode(request.matchCode)}</strong> · approve only if the phone shows the same code
      </span>
    </div>
  )
}

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
          <button type="button" className="btn" data-action="deny-enrollment" disabled={busy} onClick={() => onDecide(false)}>
            Deny
          </button>
          <button type="button" className="btn btn-primary" data-action="approve-enrollment" disabled={busy} onClick={() => onDecide(true)}>
            Approve
          </button>
        </>
      }
    >
      {error && <p role="alert" className="chat-error">{error}</p>}
      <div className="net-device-row">
        <EnrollmentRequestDetails request={request} />
      </div>
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
  const active = available && !!account.plus?.connected && !!account.net?.self?.isAuthority
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
