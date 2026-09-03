import type { MousseSettings } from '../../shared/settings'

export type ThreadNotificationKind = 'completed' | 'question'

export interface ThreadNotificationPresentation {
  body: string
  silent: boolean
  /** macOS requires an explicit sound name — ignored on Windows/Linux. */
  sound?: string
}

/** Build platform notification content and apply the completion-sound preference. */
export function getThreadNotificationPresentation(
  kind: ThreadNotificationKind,
  settings: Pick<MousseSettings, 'notifications'>
): ThreadNotificationPresentation {
  const completed = kind === 'completed'
  const audible = completed && settings.notifications.threadCompletionSound
  return {
    body: completed ? 'Agent finished' : 'Agent has a question for you',
    silent: !audible,
    // Without `sound`, macOS posts the banner silently even when `silent` is
    // false (UNNotificationContent.sound stays nil). 'Ping' ships in
    // /System/Library/Sounds on macOS; other platforms ignore the field.
    ...(audible ? { sound: 'Ping' } : {})
  }
}
