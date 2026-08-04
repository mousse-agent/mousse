import type { MousseSettings } from '../../shared/settings'

export type ThreadNotificationKind = 'completed' | 'question'

export interface ThreadNotificationPresentation {
  body: string
  silent: boolean
}

/** Build platform notification content and apply the completion-sound preference. */
export function getThreadNotificationPresentation(
  kind: ThreadNotificationKind,
  settings: Pick<MousseSettings, 'notifications'>
): ThreadNotificationPresentation {
  const completed = kind === 'completed'
  return {
    body: completed ? 'Agent finished' : 'Agent has a question for you',
    silent: !completed || !settings.notifications.threadCompletionSound
  }
}
