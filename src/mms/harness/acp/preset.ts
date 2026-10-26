import type { HarnessCaps, RuntimeFacts } from '../../../shared/harness/types'
import type { InstanceConfig } from '../driver'
import type { AcpPurpose } from './connection'
import type { ClassifyOption } from './permissions'
import type { AcpQuirks } from './quirks'

/**
 * A preset is data plus small hooks that fit one agent (or every agent Mousse knows nothing about)
 * onto the ACP core: how it starts, what it can do before it is asked, how its permission options
 * read, and its quirks. Presets never fork the core.
 */

/** Where a generic agent comes from. PR B adds registry installs. */
export type AcpSource = { kind: 'local'; command: string; args: string[]; env: Record<string, string> }

export interface AcpLaunchContext {
  config: InstanceConfig
  source: AcpSource
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
  testedVersions?: { min: string; max: string }
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
