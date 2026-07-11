import { Notification, type BrowserWindow } from 'electron'
import type { ThreadDataStore } from '../../mms/data/ThreadDataStore'
import type { ThreadContext } from '../data/ThreadContext'

export type ThreadNotificationKind = 'completed' | 'question'

export class NotificationService {
  constructor(
    private getWindow: () => BrowserWindow | null,
    private threadStore: ThreadDataStore,
    private threadContext: ThreadContext
  ) {}

  notifyThread(
    threadId: string,
    kind: ThreadNotificationKind,
    activeThreadId: string | null
  ): void {
    const win = this.getWindow()
    const isFocused = win?.isFocused() ?? false
    if (isFocused && activeThreadId === threadId) return

    if (!Notification.isSupported()) return

    const thread = this.threadStore.getThread(threadId)
    const title = thread?.name ?? 'Thread'
    const body =
      kind === 'completed' ? 'Agent finished' : 'Agent has a question for you'

    const notification = new Notification({
      title,
      body,
      silent: false
    })

    notification.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      void this.threadContext.switchThread(threadId)
    })

    notification.show()
  }
}
