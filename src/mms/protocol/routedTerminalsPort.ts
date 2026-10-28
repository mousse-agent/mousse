/**
 * What the protocol handlers need to know about the terminals other computers opened on this one
 * (`bridge/routed/terminals.ts`). A profile without Bridge has none, and every terminal is its own.
 */
export interface RoutedTerminalsPort {
  /** The computer that opened this terminal, if another computer did. */
  holderOf(ptyId: string): { node: string; name: string; openedAt: number } | undefined
  /** Whether `node` opened this terminal. */
  opened(node: string, ptyId: string): boolean
  /** The terminal is being stopped by a person on this computer, not by the device that opened it. */
  stoppedByOwner(ptyId: string): void
  /** The newest input number the owner applied for a terminal a device opened (0 when none). */
  lastSeq(ptyId: string): number
}
