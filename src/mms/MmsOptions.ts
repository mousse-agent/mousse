import type { OpenExternalFn } from './integrations/mcp/McpOAuthProvider'
import type { TerminalSendSink } from './terminals/PtyManager'
import type { MmsOwnerKind } from './ownership/MmsOwnerLease'
import type { MmsProfileServices } from './MmsProfileServices'
import type { NetRuntime, NetService } from './net/NetService'
import type { NativeBotComposition } from './bots/BotProfileService'

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
  /** Trusted local code supplies immutable definitions and measured runtime
   * evidence for this exact profile. Never populated from received DTOs. */
  nativeBotAdapters?(context: { services: MmsProfileServices; runtime: NetRuntime; net: NetService }): ReadonlyMap<string, NativeBotComposition>
}
