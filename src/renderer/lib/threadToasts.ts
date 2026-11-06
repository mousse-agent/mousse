import type { ThreadToastPayload } from '../../shared/threadToast'
import { dismissToastByKey, showToast, type ToastInput } from '../components/ui/Toast'
import { useAppStore } from '../stores/appStore'
import { openThread } from './openThread'

const KIND_LINES: Record<ThreadToastPayload['kind'], string> = {
  completed: 'Finished',
  question: 'Needs you',
  idle: 'Stopped'
}

const KIND_TONES: Record<ThreadToastPayload['kind'], ToastInput['tone']> = {
  completed: 'success',
  question: 'attention',
  idle: 'paused'
}

/** A thread that needs the person stays longest; a finished one goes soonest. */
const KIND_DURATIONS: Record<ThreadToastPayload['kind'], number> = {
  completed: 8_000,
  question: 20_000,
  idle: 12_000
}

/** One key per thread, so a thread that finishes after asking shows only its latest toast. */
export function threadToastKey(threadId: string): string {
  return `thread:${threadId}`
}

/** The toast for a thread event: the thread's name, what happened and its project; clicking it opens the thread. */
export function threadToastInput(toast: ThreadToastPayload, open: (threadId: string) => void = (id) => void openThread(id)): ToastInput {
  const name = toast.threadName?.trim() || 'Untitled thread'
  const what = toast.subagent && toast.kind === 'question' ? 'A subagent needs you' : KIND_LINES[toast.kind]
  return {
    key: threadToastKey(toast.threadId),
    title: name,
    message: toast.projectName ? `${what} · ${toast.projectName}` : what,
    tone: KIND_TONES[toast.kind],
    durationMs: KIND_DURATIONS[toast.kind],
    onOpen: () => open(toast.threadId),
    openLabel: `Open ${name}`
  }
}

/** Shows a thread event as a toast, unless the person already has that thread open. */
export function showThreadToast(toast: ThreadToastPayload): void {
  if (useAppStore.getState().activeThreadId === toast.threadId) return
  showToast(threadToastInput(toast))
}

/** Opening a thread any way clears its toast: it has been seen. */
export function watchOpenedThreadToasts(): () => void {
  let last = useAppStore.getState().activeThreadId
  return useAppStore.subscribe((state) => {
    if (state.activeThreadId === last) return
    last = state.activeThreadId
    if (last) dismissToastByKey(threadToastKey(last))
  })
}
