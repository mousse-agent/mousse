import { RUN_LEVEL_LABELS, type RunLevel } from '../../shared/automationInbox'
import {
  threadNotificationChannels,
  type MousseSettings,
  type NotificationChannels,
  type ThreadNotificationEvent
} from '../../shared/settings'
import type { RunEndState } from '../../shared/automations'

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

/** The body of an automation run's notification: how it ended, with the error of a failed run. */
export function automationRunBody(outcome: RunEndState, error?: string, report?: { level?: RunLevel; summary?: string }): string {
  // A run that reported says so, with its level: the report is the news.
  if (report?.summary && outcome !== 'failed' && outcome !== 'incomplete') return `${report.level ? `${RUN_LEVEL_LABELS[report.level]} · ` : ''}${report.summary.slice(0, 160)}`
  switch (outcome) {
    case 'done': return 'No report'
    case 'nothing_new': return 'Nothing new'
    case 'incomplete': return 'Incomplete · needs you'
    case 'failed': return error ? `Failed · ${error.split(/\r?\n/)[0]!.slice(0, 120)}` : 'Failed'
  }
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

export { botNotificationContent, botNotificationKind } from '../../shared/bots/personal/notification'

/** The bots' names the main process has seen in replies, and the rows it already announced, per profile. */
export class BotNotificationIndex {
  private readonly names = new Map<string, Map<string, string>>()
  private readonly announced = new Map<string, Set<string>>()

  /** Notes names from a `bots.list` reply (`{bots}`), or one bot from `{bot}` or `{summary}`. */
  note(profileId: string, data: unknown): void {
    const value = data as { bots?: unknown; bot?: unknown; summary?: unknown } | null
    const rows = Array.isArray(value?.bots) ? value.bots : [value?.bot ?? value?.summary]
    let names = this.names.get(profileId)
    for (const row of rows as Array<{ id?: unknown; name?: unknown } | null | undefined>) {
      if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') continue
      if (!names) this.names.set(profileId, (names = new Map()))
      names.set(row.id, row.name)
    }
  }

  name(profileId: string, botId: string): string | undefined {
    return this.names.get(profileId)?.get(botId)
  }

  /** True the first time a row is seen; a changed row (an answered ask) comes again and is not news. */
  first(profileId: string, messageId: string): boolean {
    let seen = this.announced.get(profileId)
    if (!seen) this.announced.set(profileId, (seen = new Set()))
    if (seen.has(messageId)) return false
    seen.add(messageId)
    if (seen.size > 500) seen.delete(seen.values().next().value as string)
    return true
  }
}
