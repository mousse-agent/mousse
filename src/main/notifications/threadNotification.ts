import {
  threadNotificationChannels,
  type MousseSettings,
  type NotificationChannels,
  type ThreadNotificationEvent
} from '../../shared/settings'

export type ThreadNotificationKind = ThreadNotificationEvent

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

/** Body of a subagent's question, announced under its parent's name. */
export const SUBAGENT_QUESTION_BODY = 'A subagent has a question for you'

/** A notification body that names the thread's project, so threads with the same title in two projects read apart. */
export function bodyWithProject(body: string, projectName?: string): string {
  return projectName ? `${body} · ${projectName}` : body
}

/**
 * Build platform notification content and apply the event's sound choice.
 */
export function getThreadNotificationPresentation(
  kind: ThreadNotificationKind,
  settings: Pick<MousseSettings, 'notifications'>
): ThreadNotificationPresentation {
  const audible = threadNotificationChannels(settings.notifications, kind).sound
  return {
    body: THREAD_NOTIFICATION_BODIES[kind],
    silent: !audible,
    // Without `sound`, macOS posts the banner silently even when `silent` is
    // false (UNNotificationContent.sound stays nil). 'Ping' ships in
    // /System/Library/Sounds on macOS; other platforms ignore the field.
    ...(audible ? { sound: 'Ping' } : {})
  }
}

/** Where the person is when a thread event arrives. */
export interface ThreadNotificationContext {
  /** Mousse's window has focus. */
  windowFocused: boolean
  /** The thread the event is about (or the parent a subagent's question is announced under) is open. */
  viewingThread: boolean
  /** The operating system can show notifications. */
  systemSupported: boolean
}

/** What one thread event does: a toast in the window, the system notification, and a separate sound. */
export interface ThreadNotificationPlan {
  toast: boolean
  system: boolean
  /** Play Mousse's sound itself; false when nothing should sound or the system notification carries it. */
  playSound: boolean
}

/**
 * Decides how a thread event reaches the person.
 * - The thread on screen in a focused window gets no toast or notification, only its sound.
 * - A toast shows for any other thread; it waits in the window while the person is away.
 * - The system notification shows while Mousse is in the background, and in the foreground only
 *   when toasts are off for the event, so one event never shows twice.
 */
export function planThreadNotification(channels: NotificationChannels, context: ThreadNotificationContext): ThreadNotificationPlan {
  if (context.windowFocused && context.viewingThread) {
    return { toast: false, system: false, playSound: channels.sound }
  }
  const toast = channels.toast && !context.viewingThread
  const system = channels.system && context.systemSupported && (!context.windowFocused || !toast)
  return { toast, system, playSound: channels.sound && !system }
}

export type { ThreadToastPayload } from '../../shared/threadToast'
