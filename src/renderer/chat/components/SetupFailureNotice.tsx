import { useEffect, useState } from 'react'
import { useAppStore } from '../../stores/appStore'
import { useComposerNotice, type ComposerNoticeProps } from '../../components/ComposerNotice'
import { ipcErrorMessage } from '../../utils/voiceErrors'
import type { ThreadSetupFailure } from '../../../shared/types'

export interface SetupFailureNoticeInput {
  failure: ThreadSetupFailure
  busy: boolean
  error: string | null
  onRetry: () => void
  onDismissError: () => void
}

/**
 * A thread whose message could not start because its worktree could not be set up (`Thread.setupFailure`), as the
 * composer's notice: the reason in one line, what Git said in the tooltip, and Retry when the message was kept.
 */
export function setupFailureNotice({ failure, busy, error, onRetry, onDismissError }: SetupFailureNoticeInput): ComposerNoticeProps {
  const tooltip = [failure.reason, failure.detail ? `Git said: ${failure.detail}` : '', failure.retryable ? 'Retry sends the same message again on this thread.' : 'Send the message again to retry.'].filter(Boolean).join('\n')
  return {
    tone: 'error',
    label: "This thread's message didn't start",
    title: error ?? failure.reason,
    tooltip: error ? `${error}\n${tooltip}` : tooltip,
    actions: failure.retryable
      ? [{ label: busy ? 'Retrying…' : 'Retry', title: 'Send the same message again on this thread', primary: true, blocked: busy, busy, onClick: onRetry }]
      : [],
    ...(error ? { onDismiss: onDismissError } : {})
  }
}

/** Why the thread's last message did not start, from the thread's record; undefined when it did. */
export function useSetupFailure(threadId: string | null | undefined): ThreadSetupFailure | undefined {
  return useAppStore((state) => (threadId ? state.threads.find((thread) => thread.id === threadId)?.setupFailure : undefined))
}

/** The notice for a thread whose worktree could not be set up. Shows nothing otherwise. */
export function SetupFailureNotice({ threadId }: { threadId?: string | null }) {
  const failure = useSetupFailure(threadId)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Another thread, or a new failure, starts clean.
  useEffect(() => { setBusy(false); setError(null) }, [threadId, failure?.at])
  const retry = async (): Promise<void> => {
    if (busy || !threadId) return
    setBusy(true)
    setError(null)
    try {
      await window.mousse.orchestrator.retrySetup(threadId)
    } catch (failed) {
      setError(ipcErrorMessage(failed) || "Couldn't send it again.")
    } finally {
      setBusy(false)
    }
  }
  useComposerNotice(failure ? setupFailureNotice({ failure, busy, error, onRetry: () => void retry(), onDismissError: () => setError(null) }) : null)
  return null
}
