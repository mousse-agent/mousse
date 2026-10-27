import type { HarnessCaps } from '../../../../shared/harness/types'
import { ACP_BASE_CAPABILITIES } from '../capabilities'
import { planModeId } from '../models'
import { classifyGenericOption } from '../permissions'
import type { AcpPreset } from '../preset'
import { NO_QUIRKS } from '../quirks'

/**
 * Any ACP agent run from a command the user chose. Mousse cannot pin such an agent's own approval
 * settings, so it approves tools itself (`uncontrolled`): interactive turns only. It publishes no
 * context window; plan mode exists only when the agent offers a `plan` (or `architect`) mode.
 */
export const GENERIC_ACP_CAPS: HarnessCaps = Object.freeze({
  ...ACP_BASE_CAPABILITIES,
  planMode: false,
  contextUsage: 'none',
  toolControl: 'uncontrolled',
  budgets: 'unsupported',
  spendLimits: 'unsupported',
  definitionLimits: 'none'
})

export const GENERIC_ACP_PRESET: AcpPreset = {
  id: 'generic',
  label: 'ACP agent',
  launch: ({ source }) => ({ command: source.command, args: [...source.args], env: { ...source.env } }),
  // An arbitrary agent's version flag is unknown; it announces its version in `initialize`.
  versionArgs: () => null,
  staticCaps: GENERIC_ACP_CAPS,
  capsFromFacts: (caps, facts) => ({ ...caps, planMode: Boolean(planModeId(facts.modes ?? [])) }),
  classifyOption: classifyGenericOption,
  quirks: NO_QUIRKS
}
