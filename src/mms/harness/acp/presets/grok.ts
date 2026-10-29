import type { HarnessCaps } from '../../../../shared/harness/types'
import { ACP_BASE_CAPABILITIES } from '../capabilities'
import type { ClassifyOption, PermissionApprovals } from '../permissions'
import { compatibilityFields } from '../../compatibility'
import type { AcpPreset } from '../preset'
import type { AcpQuirks } from '../quirks'

/**
 * xAI's Grok CLI as an ACP preset. Every Grok process Mousse starts (probe, check, sign-in
 * verification, turn, model refresh) runs the same command line: the permission mode pinned on
 * the command line, which wins over the home's `config.toml`, and no shared leader process.
 */

export const GROK_LABEL = 'Grok'

/** The Grok release Mousse installs (inside its tested range, `COMPATIBILITY`). */
export const GROK_TESTED_VERSION = '1.0.70'

/**
 * Grok's `--permission-mode` for each approvals policy. Always `default`: Grok asks Mousse, and the
 * permission bridge answers by the policy. `auto` or always-approve are never passed.
 */
export const GROK_PERMISSION_MODE: Readonly<Record<PermissionApprovals, 'default'>> = Object.freeze({ ask: 'default', grants: 'default', never: 'default' })

/** The arguments of every Grok process Mousse starts. */
export function grokArgs(approvals: PermissionApprovals = 'ask'): string[] {
  return ['--permission-mode', GROK_PERMISSION_MODE[approvals], 'agent', '--no-leader', 'stdio']
}

/** The one Grok option that lasts only for the session; every other "always" is project-wide. */
export const GROK_SESSION_EDITS_OPTION = 'allow-edits-session'

/**
 * Grok keeps "always" answers for the whole project, beyond the session, so only its session-only
 * edits option is offered; every other `allow_always` and every `reject_always` (a project deny
 * rule) is hidden.
 */
export const classifyGrokOption: ClassifyOption = (option) => {
  switch (option.kind) {
    case 'allow_once':
    case 'reject_once':
      return { optionId: option.optionId, kind: option.kind, label: option.name, scope: 'once' }
    case 'allow_always':
      return option.optionId === GROK_SESSION_EDITS_OPTION
        ? { optionId: option.optionId, kind: option.kind, label: 'Allow edits for this session', scope: 'session' }
        : null
    default:
      return null
  }
}

/**
 * Grok asks Mousse for every tool (`approval_only`, pinned by the command line). Plan mode is not
 * offered over ACP, and Mousse measures no context for it: Grok sends no usage over ACP.
 */
export const GROK_CAPS: HarnessCaps = Object.freeze({
  ...ACP_BASE_CAPABILITIES,
  planMode: false,
  contextUsage: 'none',
  toolControl: 'approval_only',
  autoPermissionMode: false,
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

export const GROK_QUIRKS: AcpQuirks = Object.freeze({ xaiExtensions: true })

export const GROK_PRESET: AcpPreset = {
  id: 'grok',
  label: GROK_LABEL,
  ...compatibilityFields('acp:grok'),
  // The instance's own variables apply; its arguments do not, so nothing can unpin the mode.
  launch: ({ config, source }) => ({ command: source.command, args: grokArgs(), env: { ...(config.env ?? {}) } }),
  versionArgs: () => ['--version'],
  // Without it, Grok silently denies the prompts its Auto mode would ask about.
  initializeMeta: { clientType: 'extension' },
  staticCaps: GROK_CAPS,
  classifyOption: classifyGrokOption,
  quirks: GROK_QUIRKS
}
