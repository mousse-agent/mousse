import { useEffect, useState } from 'react'
import type { MessageSenders } from '../../shared/bridge/deviceActivity'
import type { TurnSenders } from '../chat/adapters/mousseToUI'

/** The turns another of the user's computers sent, by run id, from the daemon's answer. Anything else reads as none. */
export function turnSendersFrom(answer: Partial<MessageSenders> | undefined): TurnSenders {
  const senders: Record<string, { name: string }> = {}
  for (const [runId, who] of Object.entries(answer?.runs ?? {}))
    if (typeof who?.name === 'string' && who.name) senders[runId] = { name: who.name }
  return senders
}

/**
 * Which turns of the open thread a person on another of the user's computers sent, so the transcript can
 * say "from <computer>". It is asked only for a thread of this computer that one of them has sent in
 * (`sentIn`, from the thread's own record), and again when the thread has more turns. A computer without
 * Networking, or an older daemon, answers an error and the turns carry no label.
 */
export function useTurnSenders(threadId: string | null | undefined, sentIn: boolean, turns: number): TurnSenders | undefined {
  const [known, setKnown] = useState<{ threadId: string; senders: TurnSenders }>()
  useEffect(() => {
    if (!threadId || !sentIn) return
    let alive = true
    void window.mousse.platformRequest.request<MessageSenders>('bridge.messageSenders', { threadId }).then(
      (answer) => { if (alive) setKnown({ threadId, senders: turnSendersFrom(answer) }) },
      () => undefined
    )
    return () => { alive = false }
  }, [threadId, sentIn, turns])
  return sentIn && known && known.threadId === threadId ? known.senders : undefined
}
