import { useEffect, useMemo, useState } from 'react'
import { MessagesSquare } from '../../lib/icons'
import { ipcErrorLine } from '../../lib/errorText'
import { useAppStore } from '../../stores/appStore'
import { useComposerNotice, type ComposerNoticeProps } from '../../components/ComposerNotice'
import type { PlatformRequestApi } from '../../../shared/platform'
import type { ChainHoldView } from '../../../shared/types'

/** The person's answer to a held chain of agent messages. */
export type ChainHoldAnswer = 'continue' | 'stop'

export interface ChainHoldClient {
  /** `threadId` is the thread the chain started in; one on another computer is answered there. `holdId` is the card's batch. */
  answer(threadId: string, chainId: string, holdId: string, answer: ChainHoldAnswer): Promise<void>
}

export function createChainHoldClient(api: PlatformRequestApi): ChainHoldClient {
  return {
    async answer(threadId, chainId, holdId, answer) { await api.request('threads.chainHold', { threadId, chainId, holdId, answer }) }
  }
}

export interface ChainHoldNoticeInput {
  hold: ChainHoldView
  /** The press in flight, if any; both buttons ignore presses until it settles. */
  busy: ChainHoldAnswer | null
  error: string | null
  onAnswer: (answer: ChainHoldAnswer) => void
  onDismissError: () => void
}

/** "Agents paused · 12 messages · 2 waiting". */
export function chainHoldLine(hold: Pick<ChainHoldView, 'used' | 'held'>): string {
  return `Agents paused · ${hold.used} message${hold.used === 1 ? '' : 's'} · ${hold.held} waiting`
}

/** Who is talking: `"Parent" and "Review"`, or `"A", "B" and 2 more`. */
export function chainHoldWho(hold: Pick<ChainHoldView, 'between'>): string {
  const names = hold.between.map((thread) => thread.title ? `"${thread.title}"` : 'an untitled thread')
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

/**
 * A chain of agent messages held at its budget (issue #1443), as the composer's notice on the thread the chain started
 * in: how many messages, who is talking, and the decision. Nothing waiting is sent until the person answers.
 */
export function chainHoldNotice({ hold, busy, error, onAnswer, onDismissError }: ChainHoldNoticeInput): ComposerNoticeProps {
  const blocked = busy !== null
  const line = chainHoldLine(hold)
  const who = chainHoldWho(hold)
  const tooltip = `Agents in ${who} sent each other ${hold.used} messages without you. Continue sends what waits and lets them go on; Stop drops it and tells each sender.`
  return {
    tone: error ? 'error' : 'warning',
    priority: 'approval',
    ...(error ? {} : { icon: <MessagesSquare size={14} strokeWidth={2} aria-hidden="true" /> }),
    label: 'Agent messages held',
    title: error ?? line,
    shortTitle: error ? undefined : 'Agents paused',
    ...(error ? {} : { detail: who }),
    tooltip: error ? `${line}. ${tooltip}` : tooltip,
    actions: [
      { label: busy === 'continue' ? 'Continuing…' : 'Continue', primary: true, title: 'Send what waits and let the agents go on', blocked, busy: busy === 'continue', onClick: () => onAnswer('continue') },
      { label: busy === 'stop' ? 'Stopping…' : 'Stop', title: 'Drop what waits; each sender is told', blocked, busy: busy === 'stop', onClick: () => onAnswer('stop') }
    ],
    ...(error ? { onDismiss: onDismissError } : {})
  }
}

/** The held chain shown on `threadId`, from its turn state (on another computer's thread too); undefined when none. */
export function useChainHold(threadId: string | null | undefined): ChainHoldView | undefined {
  return useAppStore((state) => (threadId ? state.turnStates[threadId]?.chainHold : undefined))
}

/** The card of a chain held on this thread. Shows nothing when none is. */
export function ChainHoldNotice({ threadId, client }: { threadId?: string | null; client?: ChainHoldClient }) {
  const hold = useChainHold(threadId)
  const [busy, setBusy] = useState<ChainHoldAnswer | null>(null)
  const [error, setError] = useState<string | null>(null)
  const actions = useMemo(() => client ?? createChainHoldClient(window.mousse.platformRequest), [client])
  // Another thread, held chain or batch starts clean.
  useEffect(() => { setBusy(null); setError(null) }, [threadId, hold?.chainId, hold?.holdId])
  const answer = async (choice: ChainHoldAnswer) => {
    if (!threadId || !hold || busy) return
    setBusy(choice)
    setError(null)
    // Answered on another computer first: the card goes once its turn state says so, and this press says why it did nothing.
    try { await actions.answer(threadId, hold.chainId, hold.holdId, choice) }
    catch (failure) { setError(ipcErrorLine(failure) || 'The held messages could not be changed.') }
    finally { setBusy(null) }
  }
  useComposerNotice(hold ? chainHoldNotice({ hold, busy, error, onAnswer: (choice) => void answer(choice), onDismissError: () => setError(null) }) : null)
  return null
}
