import type { OpenExternalFn } from './integrations/mcp/McpOAuthProvider'
import type { TerminalSendSink } from './terminals/PtyManager'
import type { MmsOwnerKind } from './ownership/MmsOwnerLease'

export interface MmsOptions {
  homeDir?: string
  repoRoot?: string
  headless?: boolean
  openExternal?: OpenExternalFn
  onTerminalEvent?: TerminalSendSink
  /**
   * Owner surface kind for the exclusive home lease.
   * Production GUI / service / writable CLI must set this (or accept default 'cli').
   */
  ownerKind?: MmsOwnerKind
  /**
   * When false, skip ownership (tests only). Production GUI, service run, and
   * writable CLI must not silently bypass ownership.
   */
  requireOwnership?: boolean
  version?: string
  build?: string
}
