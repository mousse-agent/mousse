import type { HarnessCaps } from '../../../../shared/harness/types'
import { ACP_BASE_CAPABILITIES } from '../capabilities'
import { confinedRead, confinedSearch } from '../confinedRead'
import type { AllowsUnasked, ClassifyOption, PermissionApprovals } from '../permissions'
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
 * On its held launch (`grok/held.ts`), Grok asks Mousse for every tool, its reads and searches included. Mousse
 * answers these without asking anyone, in every mode but a run that refuses approvals, as Claude Code and Codex read
 * their folder unasked: a file read, a folder listing or a search confined to the turn's folder (`confinedRead.ts`;
 * Grok names each in `rawInput.variant`, with its path; a search without a path searches the folder), and Grok's own
 * plan list. Anything else, and any of these that is not confined, goes to the turn's permission mode.
 */
export const grokAllowsUnasked: AllowsUnasked = (request, cwd) => {
  const raw = request.toolCall?.rawInput
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false
  const input = raw as Record<string, unknown>
  switch (input.variant) {
    case 'TodoWrite':
      return true
    case 'ReadFile':
      return typeof input.target_file === 'string' && confinedRead(cwd, input.target_file)
    case 'ListDir':
      return typeof input.target_directory === 'string' && confinedRead(cwd, input.target_directory)
    case 'Grep':
      return input.path === null || input.path === undefined ? confinedSearch(cwd, cwd) : typeof input.path === 'string' && confinedSearch(cwd, input.path)
    default:
      return false
  }
}

/**
 * Grok's caps on a version whose held launch is proven on this platform (`grokHeldRecord`): it asks Mousse before
 * every tool (`approval_only`). On any other version the driver claims `uncontrolled` (`grokCaps`). Plan mode is not
 * offered over ACP, and Mousse measures no context for it: Grok sends no usage over ACP.
 */
export const GROK_CAPS: HarnessCaps = Object.freeze({
  ...ACP_BASE_CAPABILITIES,
  // Spike S4 (Grok 1.0.77 over ACP): every call of a response was reported before any ran, so no start arrived after
  // a result (G = 0); 2 × 0 + 100.
  steerSettleMs: 100,
  planMode: false,
  contextUsage: 'none',
  toolControl: 'approval_only',
  autoPermissionMode: false,
  budgets: 'unsupported',
  spendLimits: 'unsupported'
})

/** The caps of a Grok whose held launch is proven (`held`), or not. */
export function grokCaps(held: boolean): HarnessCaps {
  return held ? GROK_CAPS : Object.freeze({ ...GROK_CAPS, toolControl: 'uncontrolled' as const })
}

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
  allowsUnasked: grokAllowsUnasked,
  quirks: GROK_QUIRKS
}
