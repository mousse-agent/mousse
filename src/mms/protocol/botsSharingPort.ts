/**
 * "Share bots with other devices" on this computer: while it is off, the lists that the user's phones and other
 * computers read carry no bots, and every `bots.*` call they make is refused. Set while Bridge is on; absent, bots
 * are shared (the switch is on by default).
 */
export interface BotsSharingPort {
  /** Undefined while bots are shared; otherwise the plain refusal: "<Computer> doesn't share its bots with other devices." */
  refusal(): string | undefined
  /** Called when the switch turns on or off. */
  onChange(listener: () => void): () => void
}
