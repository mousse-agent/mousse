import type { HarnessDriverKind } from '../../shared/harness/types'

/**
 * Containment evidence (PR 6 §3): what a runtime was proven to hold, per driver, CLI version and
 * platform. A record is written only by a passing run of the runtime's evidence suite on that
 * platform (for locked Claude Code, `claudeLockedProcess.test.ts` against the real pinned CLI); a
 * failing item writes none. Without a record the runtime claims nothing:
 * - `tools` (items 1–7): the exact tool list, Mousse's grant gate and the built-in ledger hold, so
 *   the runtime's tool control is `exact` and it may hold a bot authority;
 * - `sandbox` (items 8–14, 16 and 17): the sandbox holds every write, read, network and kill rule,
 *   so a `shell` grant may run there and containment is `strong`.
 */
export type ContainmentEvidenceKind = 'tools' | 'sandbox'

export interface ContainmentEvidence {
  driver: HarnessDriverKind
  kind: ContainmentEvidenceKind
  /** The exact CLI version the suite ran against. */
  cliVersion: string
  platform: NodeJS.Platform
  /** The evidence items that passed (`plan-pr6` §3 numbering). */
  items: readonly number[]
  /** When the passing run was recorded (ISO). */
  recordedAt: string
}

/**
 * Every record so far. Empty: no platform has passed the real-CLI suite yet, so locked Claude Code
 * holds no bot authority and runs no shell anywhere.
 */
export const CONTAINMENT_EVIDENCE: readonly ContainmentEvidence[] = Object.freeze([])

export interface EvidenceQuery {
  driver: HarnessDriverKind
  kind: ContainmentEvidenceKind
  platform: NodeJS.Platform
  /** The CLI version in use; absent matches a record of any version (a driver-level claim). */
  cliVersion?: string
}

/** Whether `table` holds a record for the query. An unknown version never matches a versioned query. */
export function hasContainmentEvidence(query: EvidenceQuery, table: readonly ContainmentEvidence[] = CONTAINMENT_EVIDENCE): boolean {
  return table.some((record) =>
    record.driver === query.driver &&
    record.kind === query.kind &&
    record.platform === query.platform &&
    (!('cliVersion' in query) || record.cliVersion === query.cliVersion))
}
