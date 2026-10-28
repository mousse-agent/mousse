import type { HarnessDriverKind } from '../../shared/harness/types'
import { compareVersions } from './driver'

/**
 * Which agent versions Mousse was tested with, and which are known to break. One row per driver
 * kind, and per ACP preset (`acp:<preset id>`) for the agents the `acp` driver runs. Drivers and
 * presets read their range from here (`compatibilityFields`); none declares its own.
 * `docs/providers/compatibility.md` says how a row changes when an agent releases a new version.
 */
export type CompatibilityKey = Exclude<HarnessDriverKind, 'acp'> | `acp:${string}`

/** A version range: one version (`2.1.5`), or two joined by ` - ` (`2.1.5 - 2.1.9`), both included. */
export interface KnownBrokenVersions {
  range: string
  /** Shown to the user: what goes wrong with these versions. */
  reason: string
  /** The first version that works again: the page then offers the update. */
  fixedIn?: string
}

export interface CompatibilityEvidence {
  version: string
  /** `fixture`: a replay fixture recorded from or written against that version; `smoke`: a run on the real agent. */
  kind: 'fixture' | 'smoke'
  /** The fixture's path, or the PR whose description records the run (`#226`). */
  ref: string
}

export interface CompatibilityRow {
  /**
   * The versions Mousse was tested with. Absent for a row that judges no version: the generic ACP
   * preset runs any agent.
   */
  tested?: { min: string; max: string }
  /** Versions that do not work with Mousse: turns on them are refused unless the user allows the version. */
  knownBroken?: readonly KnownBrokenVersions[]
  evidence: readonly CompatibilityEvidence[]
  /**
   * A runtime Mousse ships (an npm dependency): it is always the tested one. The row records the
   * version for its upgrades; the probe does not judge it.
   */
  bundled?: { package: string }
}

export const COMPATIBILITY: Readonly<Record<CompatibilityKey, CompatibilityRow>> = Object.freeze({
  claude: {
    tested: { min: '2.0.0', max: '2.1.999' },
    evidence: [
      { version: '2.1.291', kind: 'smoke', ref: '#285' },
      { version: '2.1.291', kind: 'fixture', ref: 'tests/run/fixtures/plain-turn/claude-subscription.ndjson' }
    ]
  },
  codex: {
    tested: { min: '0.100.0', max: '0.162.999' },
    evidence: [
      { version: '0.162.1', kind: 'smoke', ref: '#251' },
      { version: '0.162.1', kind: 'fixture', ref: 'tests/run/fixtures/activity/codex.ndjson' }
    ]
  },
  antigravity: {
    tested: { min: '1.1.1', max: '1.1.1' },
    evidence: [{ version: '1.1.1', kind: 'fixture', ref: 'tests/run/fixtures/plain-turn/antigravity.ndjson' }]
  },
  grok: {
    tested: { min: '1.0.70', max: '1.0.70' },
    evidence: [{ version: '1.0.70', kind: 'smoke', ref: '#226' }]
  },
  cursor: {
    tested: { min: '1.0.35', max: '1.0.35' },
    bundled: { package: '@cursor/sdk' },
    evidence: [{ version: '1.0.35', kind: 'fixture', ref: 'tests/run/fixtures/plain-turn/cursor.ndjson' }]
  },
  pi: {
    tested: { min: '1.4.0', max: '1.4.0' },
    bundled: { package: '@earendil-works/pi-coding-agent' },
    evidence: [
      { version: '1.4.0', kind: 'smoke', ref: '#369' },
      { version: '1.4.0', kind: 'fixture', ref: 'tests/run/fixtures/plain-turn/pi-rpc.ndjson' }
    ]
  },
  'acp:generic': { evidence: [] },
  'acp:grok': {
    tested: { min: '1.0.70', max: '1.0.70' },
    evidence: [{ version: '1.0.70', kind: 'smoke', ref: '#226' }]
  }
} satisfies Record<CompatibilityKey, CompatibilityRow>)

/** What a driver or preset takes from its row: its tested range and known-broken versions. */
export function compatibilityFields(key: CompatibilityKey): { testedVersions?: { min: string; max: string }; knownBroken?: readonly KnownBrokenVersions[] } {
  const row = COMPATIBILITY[key]
  return {
    ...(row.tested && !row.bundled ? { testedVersions: row.tested } : {}),
    ...(row.knownBroken?.length ? { knownBroken: row.knownBroken } : {})
  }
}

const VERSION = /^\d+(\.\d+){0,3}([-+][0-9A-Za-z.-]+)?$/

/** `KnownBrokenVersions.range` as its two ends; undefined when it does not parse. */
export function parseVersionRange(range: string): { min: string; max: string } | undefined {
  const parts = range.split(' - ').map((part) => part.trim())
  if (parts.length > 2 || !parts.every((part) => VERSION.test(part))) return undefined
  const [min, max = min] = parts
  return compareVersions(min, max) <= 0 ? { min, max } : undefined
}

/** The known-broken row `version` falls in, if any. */
export function knownProblemOf(rows: readonly KnownBrokenVersions[] | undefined, version: string | undefined): KnownBrokenVersions | undefined {
  if (!rows?.length || !version) return undefined
  return rows.find((row) => {
    const range = parseVersionRange(row.range)
    return range !== undefined && compareVersions(version, range.min) >= 0 && compareVersions(version, range.max) <= 0
  })
}

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
 * one kind, `tools`, with its own numbering (`PI_RPC_EVIDENCE_ITEMS`), in two forms:
 * - a record holding every item makes the engine `exact`/`strong` on that platform: it runs agent
 *   definitions, their shell included;
 * - a no-shell record (`PI_RPC_NO_SHELL_ITEMS`: every item but the contained shell) makes it
 *   `exact`/`weak`: it runs agent definitions, but a definition's shell command asks a person
 *   first, and an unattended definition runs none.
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
   * Where the suite ran, when that is not plain hardware running the platform (`'wsl2'`: a real
   * Linux kernel in a VM on Windows). A label for reviewers; the record holds for its platform.
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
 * A no-shell record's items: every Pi RPC item but the contained shell (10), for a platform where
 * Pi's `bash` runs uncontained (Windows). Mousse still decides every call,
 * so tool control is `exact`, but containment stays `weak`.
 */
export const PI_RPC_NO_SHELL_ITEMS: readonly number[] = Object.freeze(PI_RPC_EVIDENCE_ITEMS.filter((item) => item !== 10))

/**
 * Every record so far.
 * - Locked Claude Code: none. No platform has passed the real-CLI suite yet, so it holds no bot
 *   authority and runs no shell anywhere.
 * - Pi RPC, for Pi 1.4.0, each evidence file run on its own: Linux, from a run in WSL2 (a real Linux
 *   kernel in a VM on Windows, accepted as Linux evidence): items 1–12. Windows (native Windows 11,
 *   x64): a no-shell record, items 1–9, 11 and 12 (Pi's shell runs uncontained there, so item 10
 *   does not apply). macOS (macOS 26.6.2 on Apple silicon): items 1–12.
 */
export const CONTAINMENT_EVIDENCE: readonly ContainmentEvidence[] = Object.freeze([
  Object.freeze({ driver: 'pi', kind: 'tools', cliVersion: '1.4.0', platform: 'linux', environment: 'wsl2', items: PI_RPC_EVIDENCE_ITEMS, recordedAt: '2026-10-28T02:51:11Z' }),
  Object.freeze({ driver: 'pi', kind: 'tools', cliVersion: '1.4.0', platform: 'win32', items: PI_RPC_NO_SHELL_ITEMS, recordedAt: '2026-10-28T02:52:13Z' }),
  Object.freeze({ driver: 'pi', kind: 'tools', cliVersion: '1.4.0', platform: 'darwin', items: PI_RPC_EVIDENCE_ITEMS, recordedAt: '2026-10-28T02:50:26Z' })
] satisfies ContainmentEvidence[])

export interface EvidenceQuery {
  driver: HarnessDriverKind
  kind: ContainmentEvidenceKind
  platform: NodeJS.Platform
  /** The CLI version in use; absent matches a record of any version (a driver-level claim). */
  cliVersion?: string
  /** Items the record must hold (default: any record counts). */
  items?: readonly number[]
}

/** Whether `table` holds a record for the query. An unknown version never matches a versioned query. */
export function hasContainmentEvidence(query: EvidenceQuery, table: readonly ContainmentEvidence[] = CONTAINMENT_EVIDENCE): boolean {
  return table.some((record) =>
    record.driver === query.driver &&
    record.kind === query.kind &&
    record.platform === query.platform &&
    (!('cliVersion' in query) || record.cliVersion === query.cliVersion) &&
    (query.items ?? []).every((item) => record.items.includes(item)))
}

