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
 *
 * Pi's RPC engine (`driver: 'pi'`, `cliVersion`: the pinned `@earendil-works/pi-coding-agent`) has
 * one kind, `tools`, with its own numbering (`PI_RPC_EVIDENCE_ITEMS`): a record holding every item
 * makes the engine `exact`/`strong` on that platform and lets it run agent definitions.
 */
export type ContainmentEvidenceKind = 'tools' | 'sandbox'

export interface ContainmentEvidence {
  driver: HarnessDriverKind
  kind: ContainmentEvidenceKind
  /** The exact CLI version the suite ran against. */
  cliVersion: string
  platform: NodeJS.Platform
  /** The evidence items that passed (`plan-pr6` §3 numbering; Pi: `PI_RPC_EVIDENCE_ITEMS`). */
  items: readonly number[]
  /** When the passing run was recorded (ISO). */
  recordedAt: string
  /**
   * Where the suite ran, when that is not the platform on its own machine (`'wsl2'`). A record that
   * names one holds only where Mousse runs in that same environment (`EvidenceQuery.environment`).
   */
  environment?: string
}

/**
 * Pi RPC's evidence items, each a test file run against the real pinned Pi child:
 * 1–9. PR 2 §4's suite (`piContainment.test.ts`): only Mousse's extension, no skills or context
 *    files, `--no-approve` and no project trust, a Mousse-only agent dir, `PI_OFFLINE`, no `bash`
 *    RPC command, the default-deny gate, no side effect of a denied call, every model guarded;
 * 10. the contained shell (`piShell.test.ts`, Linux and macOS only): every group Pi's `bash`
 *    starts is recorded before it runs anything, and dies with Pi;
 * 11. a definition's built-ins held to its authority (`piDefinitionGate.test.ts`);
 * 12. definition turns (`piDefinitionTurn.test.ts`): a fresh process and session per turn, the
 *    definition's system prompt in place of Pi's, exactly the granted tools, usage reported, and
 *    the turn, tool-call, token and cost limits.
 */
export const PI_RPC_EVIDENCE_ITEMS: readonly number[] = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

/**
 * Every record so far.
 * - Locked Claude Code: none. No platform has passed the real-CLI suite yet, so it holds no bot
 *   authority and runs no shell anywhere.
 * - Pi RPC: none yet. A run in WSL2 (a real Linux kernel, not a Linux machine) passed items 1–9, 11
 *   and 12, and each contained-shell test (item 10) alone, but the contained-shell file did not
 *   finish as a whole, so Linux has no record until it does. macOS needs a run on a Mac; Windows
 *   gets none (Pi's shell runs uncontained there). Without a record, definitions run on the loop.
 */
export const CONTAINMENT_EVIDENCE: readonly ContainmentEvidence[] = Object.freeze([])

export interface EvidenceQuery {
  driver: HarnessDriverKind
  kind: ContainmentEvidenceKind
  platform: NodeJS.Platform
  /** The CLI version in use; absent matches a record of any version (a driver-level claim). */
  cliVersion?: string
  /** Items the record must hold (default: any record counts). */
  items?: readonly number[]
  /** Where Mousse runs, when not the platform on its own machine (`'wsl2'`); see `ContainmentEvidence.environment`. */
  environment?: string
}

/** Whether `table` holds a record for the query. An unknown version never matches a versioned query. */
export function hasContainmentEvidence(query: EvidenceQuery, table: readonly ContainmentEvidence[] = CONTAINMENT_EVIDENCE): boolean {
  return table.some((record) =>
    record.driver === query.driver &&
    record.kind === query.kind &&
    record.platform === query.platform &&
    (!('cliVersion' in query) || record.cliVersion === query.cliVersion) &&
    (query.items ?? []).every((item) => record.items.includes(item)) &&
    (record.environment === undefined || record.environment === query.environment))
}
