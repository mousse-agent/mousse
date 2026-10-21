import type { PlusEnrollmentRequestView } from '../../shared/net'
import type { PlatformRequestMethod } from '../../shared/platform'

const request = <T,>(method: PlatformRequestMethod, params: unknown = {}) =>
  window.mousse.platformRequest.request<T>(method, params)

/** Six-digit match code split in two, as the phone shows it. */
export const formatMatchCode = (code: string): string => `${code.slice(0, 3)} ${code.slice(3)}`

/** Phone requests from the daemon's cache. The daemon polls the Mousse ID mailbox; reading also keeps that poll running. */
export const listEnrollmentRequests = (): Promise<PlusEnrollmentRequestView[]> =>
  request<{ requests: PlusEnrollmentRequestView[] }>('net.plus.enrollment.requests').then((value) => value.requests)

export const decideEnrollmentRequest = (id: string, approve: boolean): Promise<unknown> =>
  request(approve ? 'net.plus.enrollment.approve' : 'net.plus.enrollment.deny', { id })

/** The request to ask about next: the oldest one still open that was not closed this session. */
export function nextEnrollmentRequest(
  requests: readonly PlusEnrollmentRequestView[],
  dismissed: ReadonlySet<string>,
  now: number
): PlusEnrollmentRequestView | undefined {
  return requests
    .filter((row) => row.expiresAt > now && !dismissed.has(row.id))
    .reduce<PlusEnrollmentRequestView | undefined>((oldest, row) => (!oldest || row.createdAt < oldest.createdAt ? row : oldest), undefined)
}

/** System notification for a request that arrives while the window is in the background. */
export function notifyEnrollmentRequest(row: PlusEnrollmentRequestView): void {
  if (typeof Notification !== 'function') return
  try {
    const notification = new Notification(`${row.kind === 'computer' ? 'Computer' : 'Phone'} wants to join`, {
      body: `${row.deviceName} · match code ${formatMatchCode(row.matchCode)}`
    })
    notification.onclick = () => void window.mousse.window.focusMain().catch(() => undefined)
  } catch {
    // Notifications are a convenience; the dialog still waits in the window.
  }
}
