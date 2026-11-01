/**
 * The request ids of the composer's sends. The id is the service's retry key (`clientRequestId`): a send
 * with an id the service already has is answered with that run and never runs a second time.
 *
 * - A send whose outcome is unknown keeps its id, so sending the same message again replays it.
 * - The same message sent while the first is still waiting for its reply is a new message, with a new id.
 * - A send that arrived, or that the service refused (nothing ran), gives its id up: the same text sent
 *   later is a new message.
 */
export class SendRetryIds {
  private readonly retained = new Map<string, string>()
  private readonly waiting = new Set<string>()

  constructor(
    private readonly newId: () => string = () => crypto.randomUUID(),
    private readonly limit = 32
  ) {}

  /** The id for a send of the message with this signature; it waits for its reply until `replied`. */
  begin(signature: string): string {
    const kept = this.retained.get(signature)
    const id = kept && !this.waiting.has(kept) ? kept : this.newId()
    this.retained.delete(signature)
    this.retained.set(signature, id)
    if (this.retained.size > this.limit) this.retained.delete(this.retained.keys().next().value!)
    this.waiting.add(id)
    return id
  }

  /** The send's reply came, or the call failed: the id no longer waits. */
  replied(id: string): void {
    this.waiting.delete(id)
  }

  /** The send arrived or was refused: its id is not used again. Kept when a later send of the message took it over. */
  settle(signature: string, id: string): void {
    if (this.retained.get(signature) === id) this.retained.delete(signature)
  }
}
