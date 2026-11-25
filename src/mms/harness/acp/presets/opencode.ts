import type { HarnessCaps } from '../../../../shared/harness/types'
import { compatibilityFields } from '../../compatibility'
import { planModeId } from '../models'
import { classifyGenericOption } from '../permissions'
import type { AcpPreset } from '../preset'
import { NO_QUIRKS } from '../quirks'
import { GENERIC_ACP_CAPS } from './generic'

/**
 * OpenCode (anomalyco/opencode) as an ACP preset: `opencode acp`, with the entry's own arguments
 * after it. Nothing beyond the generic agent is claimed until a run on the real agent shows it, so
 * it keeps the generic capabilities: Mousse approves its tools itself, no context window, and plan
 * mode only when the agent offers a `plan` mode.
 */

export const OPENCODE_LABEL = 'OpenCode'

export const OPENCODE_CAPS: HarnessCaps = Object.freeze({ ...GENERIC_ACP_CAPS })

/** The arguments of every OpenCode process Mousse starts. */
export function opencodeArgs(extra: readonly string[] = []): string[] {
  return ['acp', ...extra]
}

export const OPENCODE_PRESET: AcpPreset = {
  id: 'opencode',
  label: OPENCODE_LABEL,
  ...compatibilityFields('acp:opencode'),
  launch: ({ config, source }) => ({ command: source.command, args: opencodeArgs(config.args ?? []), env: { ...(config.env ?? {}) } }),
  versionArgs: () => ['--version'],
  staticCaps: OPENCODE_CAPS,
  capsFromFacts: (caps, facts) => ({ ...caps, planMode: Boolean(planModeId(facts.modes ?? [])) }),
  classifyOption: classifyGenericOption,
  quirks: NO_QUIRKS
}
