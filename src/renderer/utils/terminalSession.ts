/**
 * Pure helpers for project terminal tab / PTY reconciliation.
 * Kept free of Electron so unit tests can cover stale-session recovery.
 */

import { parseTerminalOffMessage } from '../../shared/bridge/routed'

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

/** What the terminal panel says when a terminal on another computer could not be opened. */
export interface TerminalNotice {
  message: string
  /** What to do about it, when there is something. */
  hint?: string
}

/**
 * The words for a terminal that could not be opened on another computer. When that computer has this
 * device's terminals off (the default), the panel says so and where to turn them on; any other failure
 * shows what the computer said, without the wrapper the window's own process adds.
 */
export function terminalNoticeFor(error: unknown): TerminalNotice {
  const text = error instanceof Error ? error.message : String(error)
  const off = parseTerminalOffMessage(text)
  if (off)
    return {
      message: `Terminals from this computer are off on ${off.computer}.`,
      hint: `On ${off.computer}, open Devices and turn on Terminals for this computer.`
    }
  return { message: text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') }
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
