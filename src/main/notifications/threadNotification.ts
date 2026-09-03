import type { MousseSettings } from '../../shared/settings'

export type ThreadNotificationKind = 'completed' | 'question' | 'idle'

export interface ThreadNotificationPresentation {
  body: string
  silent: boolean
  /** macOS requires an explicit sound name — ignored on Windows/Linux. */
  sound?: string
}

const THREAD_NOTIFICATION_BODIES: Record<ThreadNotificationKind, string> = {
  completed: 'Agent finished',
  question: 'Agent has a question for you',
  idle: 'Agent paused'
}

/**
 * Build platform notification content and apply the completion-sound preference.
 * Any thread that stops doing work and needs the user — finished, asking a
 * question, or paused/idle — is audible under the same toggle.
 */
export function getThreadNotificationPresentation(
  kind: ThreadNotificationKind,
  settings: Pick<MousseSettings, 'notifications'>
): ThreadNotificationPresentation {
  const audible = settings.notifications.threadCompletionSound
  return {
    body: THREAD_NOTIFICATION_BODIES[kind],
    silent: !audible,
    // Without `sound`, macOS posts the banner silently even when `silent` is
    // false (UNNotificationContent.sound stays nil). 'Ping' ships in
    // /System/Library/Sounds on macOS; other platforms ignore the field.
    ...(audible ? { sound: 'Ping' } : {})
  }
}
