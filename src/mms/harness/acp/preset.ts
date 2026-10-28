import type { HarnessCaps, RegistrySourcePatch, RuntimeFacts } from '../../../shared/harness/types'
import type { KnownBrokenVersions } from '../compatibility'
import type { InstanceConfig } from '../driver'
import type { AcpPurpose } from './connection'
import type { ClassifyOption } from './permissions'
import type { AcpQuirks } from './quirks'

/**
 * A preset is data plus small hooks that fit one agent (or every agent Mousse knows nothing about)
 * onto the ACP core: how it starts, what it can do before it is asked, how its permission options
 * read, and its quirks. Presets never fork the core.
 */

/** A command the user chose: a program (path or name on PATH), its arguments and variables. */
export type AcpLocalSource = { kind: 'local'; command: string; args: string[]; env: Record<string, string> }

/**
 * Where a generic agent comes from: a command the user chose, or an agent Mousse installs from the
 * ACP registry (`receiptHash` binds the entry to the install it was made with).
 */
export type AcpSource = AcpLocalSource | (RegistrySourcePatch & { receiptHash?: string })

export interface AcpLaunchContext {
  config: InstanceConfig
  source: AcpLocalSource
  purpose: AcpPurpose
}

/** What starts the agent: a program and arguments (never a shell), and variables on top of the instance's. */
export interface AcpLaunch {
  /** As configured: an absolute path, or a name looked up on PATH. */
  command: string
  args: string[]
  env: Record<string, string>
}

export interface AcpPreset {
  id: string
  label: string
  /** From the preset's row of `COMPATIBILITY` (`acp:<id>`). */
  testedVersions?: { min: string; max: string }
  knownBroken?: readonly KnownBrokenVersions[]
  launch(context: AcpLaunchContext): AcpLaunch
  /** The executable's version flag; `null` when the preset knows none (the handshake decides). */
  versionArgs?(config: InstanceConfig): string[] | null
  /** `_meta` sent with `initialize`. */
  initializeMeta?: Record<string, unknown>
  /** What the agent can do before any handshake. */
  staticCaps: HarnessCaps
  /** Caps refined by what the agent reported (plan mode). */
  capsFromFacts?(caps: HarnessCaps, facts: RuntimeFacts): HarnessCaps
  /** Labels and scopes of permission options (default: the generic classes). */
  classifyOption?: ClassifyOption
  quirks: AcpQuirks
}
