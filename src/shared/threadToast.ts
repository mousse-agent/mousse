import type { ThreadNotificationEvent } from './settings'

/** What the window needs to show a thread event as a toast. Sent by the main process on `notifications:threadToast`. */
export interface ThreadToastPayload {
  threadId: string
  kind: ThreadNotificationEvent
  threadName?: string
  projectName?: string
  /** A subagent asked; the toast is about its parent. */
  subagent?: boolean
}
