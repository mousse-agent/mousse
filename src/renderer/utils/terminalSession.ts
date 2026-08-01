/**
 * Pure helpers for project terminal tab / PTY reconciliation.
 * Kept free of Electron so unit tests can cover stale-session recovery.
 */

export type TerminalShellAction = 'none' | 'recreate' | 'show_exited' | 'spawn_missing'

export interface TerminalSessionState {
  /** Renderer-held PTY id; may be stale after main-process lifecycle changes. */
  ptyId: string | null
  /** True when the shell genuinely exited (user should see exit overlay). */
  exited: boolean
  /** Result of main-process liveness lookup for ptyId (false when null/stale). */
  isAlive: boolean
}

/**
 * Decide what to do when opening or switching to a project terminal tab.
 *
 * - Genuine exits must remain visible (no infinite auto-respawn).
 * - Stale PTY ids (session gone in main) should recreate the shell.
 * - Missing pty without exit should spawn once.
 */
export function resolveTerminalShellAction(state: TerminalSessionState): TerminalShellAction {
  if (state.exited) {
    return 'show_exited'
  }
  if (state.ptyId && state.isAlive) {
    return 'none'
  }
  if (state.ptyId && !state.isAlive) {
    return 'recreate'
  }
  return 'spawn_missing'
}

/**
 * After a stale id is detected, clear local session fields so a fresh spawn can proceed.
 * Does not mark exited — that is reserved for real PTY exit events.
 */
export function clearStalePtyBinding(tab: {
  ptyId: string | null
  exited: boolean
}): { ptyId: null; exited: false } {
  return { ptyId: null, exited: false }
}
