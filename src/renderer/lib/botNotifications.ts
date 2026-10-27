import type { BotEscalationSummary } from '../../shared/bots/personal/escalation'

/** A desktop notification for a bot waiting at a wall; a click brings the window back. */
export function notifyBotEscalation(escalation: BotEscalationSummary, botName: string | undefined, onClick: () => void): void {
  if (typeof Notification !== 'function') return
  try {
    const notification = new Notification(`${botName ?? 'A bot'} is waiting for you`, {
      body: `It asks: ${escalation.permissionText}. Answer in Automations → Bots.`
    })
    notification.onclick = () => {
      onClick()
      void window.mousse.window.focusMain().catch(() => undefined)
    }
  } catch {
    // Notifications are a convenience; the inbox still lists the request.
  }
}
