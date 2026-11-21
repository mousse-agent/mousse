/**
 * What became of a send, as far as the composer knows:
 * - `answered`: the service replied that it took the message (run, queued or failed after it started);
 * - `refused`: the service replied with an error, so nothing ran;
 * - `arrived`: no reply came, and reading the thread again found the message;
 * - `unknown`: no reply came (a timeout, another computer that did not confirm), or the thread was read
 *   again and the message was not there yet.
 */
export type SendOutcome = 'answered' | 'refused' | 'arrived' | 'unknown'

export interface SendRetry<T> {
  id: string
  context?: T
}

/**
 * The request ids of the composer's sends. The id is the service's retry key (`clientRequestId`): a send
 * with an id the service already has is answered with that run and never runs a second time.
 *
 * - A send whose outcome is unknown keeps its id, so sending the same message again replays it.
 * - The same message sent while the first is still waiting for its reply is a new message, with a new id.
 * - A send that arrived, or that the service refused, gives its id up: the same text sent later is a new message.
 */
export class SendRetryIds<T = undefined> {
  private readonly retained = new Map<string, SendRetry<T>>()
  private readonly waiting = new Set<string>()

  constructor(
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly limit = 32
  ) {}

  get hasRetry(): boolean {
    for (const { id } of this.retained.values()) if (!this.waiting.has(id)) return true
    return false
  }

  retry(signature: string): SendRetry<T> | undefined {
    const kept = this.retained.get(signature)
    return kept && !this.waiting.has(kept.id) ? kept : undefined
  }

  /** Keeps a selected retry through async preparation. The ID waits for its reply until `replied`. */
  begin(signature: string, context?: T, retry = this.retry(signature)): string {
    const kept = retry ?? { id: this.newId(), context }
    this.retained.delete(signature)
    this.retained.set(signature, kept)
    if (this.retained.size > this.limit) this.retained.delete(this.retained.keys().next().value!)
    this.waiting.add(kept.id)
    return kept.id
  }

  /** The send's call returned or failed: the id no longer waits. */
  replied(id: string): void {
    this.waiting.delete(id)
  }

  /** Records what became of the send. Only an unknown outcome keeps the id for the same message sent again. */
  settle(signature: string, id: string, outcome: SendOutcome): void {
    if (outcome === 'unknown') return
    // A later send of the same message may have taken the signature over; its id stays.
    if (this.retained.get(signature)?.id === id) this.retained.delete(signature)
  }
}
