import { RefreshCw } from '../lib/icons'
import { useComposerNotice } from './ComposerNotice'

export const SERVICE_LOST_TITLE = "Can't reach Mousse's background service"
export const SERVICE_LOST_SHORT_TITLE = 'Background service unreachable'
export const SERVICE_LOST_TOOLTIP =
  'This window lost its link to the Mousse service that runs your agents. Agents may still be running. Nothing you send reaches them until it reconnects.'
export const SERVICE_LOST_RECONNECT = 'Reconnect'

/**
 * The notice while this window cannot reach the background service (the daemon) that runs the agents.
 * It is the window's link that is lost, not the internet, so the line names the service.
 */
export function ServiceLostNotice({ lost, onReconnect, onDismiss }: {
  lost: boolean
  onReconnect: () => void
  onDismiss: () => void
}) {
  useComposerNotice(lost ? {
    tone: 'error',
    priority: 'service',
    title: SERVICE_LOST_TITLE,
    shortTitle: SERVICE_LOST_SHORT_TITLE,
    tooltip: SERVICE_LOST_TOOLTIP,
    actions: [{ label: SERVICE_LOST_RECONNECT, icon: <RefreshCw size={14} strokeWidth={1.8} />, onClick: onReconnect }],
    onDismiss
  } : null)
  return null
}
