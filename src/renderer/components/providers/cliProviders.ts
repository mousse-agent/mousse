import type {
  ClaudeSubscriptionStatus,
  CliProviderConfig,
  CliProviderInstanceId,
  CodexStatus
} from '../../../shared/providerAuth'
import type { HealthState } from './parts'

export interface CliProviderDefinition {
  id: CliProviderInstanceId
  label: string
  /** The `llmProvider` id the daemon uses for sign-in, logout and model refresh. */
  providerId: string
  /** Logo id for `ProviderIcon`. */
  iconId: string
}

export const CLI_PROVIDERS: readonly CliProviderDefinition[] = [
  { id: 'claude', label: 'Claude Code', providerId: 'claude-subscription', iconId: 'claude' },
  { id: 'codex', label: 'Codex', providerId: 'codex', iconId: 'openai' },
  { id: 'antigravity', label: 'Antigravity', providerId: 'antigravity', iconId: 'google' }
]

/** Login-option ids that belong to the CLIs, so the Model APIs list can skip them. */
export const CLI_LOGIN_IDS: ReadonlySet<string> = new Set(CLI_PROVIDERS.map((cli) => cli.providerId))

type VendorStatus = Pick<ClaudeSubscriptionStatus, 'state' | 'message'> | Pick<CodexStatus, 'state' | 'message'>

function vendorHealth(cli: CliProviderDefinition, status: VendorStatus, connectedDetail: string): HealthState {
  switch (status.state) {
    case 'connected':
      return { health: 'ready', label: 'Ready', detail: connectedDetail }
    case 'signed_out':
      return { health: 'attention', label: 'Signed out', detail: status.message }
    case 'disconnected':
      return { health: 'attention', label: 'Disconnected', detail: status.message }
    case 'missing_binary':
      return { health: 'attention', label: 'Not found', detail: status.message ?? `${cli.label} is not installed` }
    default:
      return { health: 'error', label: 'Could not check sign-in', detail: status.message }
  }
}

export function cliHealth(
  cli: CliProviderDefinition,
  input: {
    claude: ClaudeSubscriptionStatus | null
    codex: CodexStatus | null
    config?: CliProviderConfig
    /** The daemon lists the CLI as signed in (from `providers.listConfigured`). */
    configured: boolean
  }
): HealthState {
  if (input.config && !input.config.resolvedBinaryPath) {
    return {
      health: 'attention',
      label: 'Not found',
      detail: input.config.binaryPath ? `Nothing runs at ${input.config.binaryPath}` : `${cli.label} is not installed`
    }
  }
  if (cli.id === 'claude') {
    if (!input.claude) return { health: 'unknown', label: 'Checking' }
    return vendorHealth(
      cli,
      input.claude,
      input.claude.loginPolicy === 'isolated' ? 'Separate sign-in for this profile' : 'Signed in through your terminal'
    )
  }
  if (cli.id === 'codex') {
    if (!input.codex) return { health: 'unknown', label: 'Checking' }
    return vendorHealth(
      cli,
      input.codex,
      input.codex.planType ? `Signed in through your terminal (ChatGPT ${input.codex.planType})` : 'Signed in through your terminal'
    )
  }
  return input.configured
    ? { health: 'ready', label: 'Ready', detail: 'Signed in' }
    : { health: 'attention', label: 'Signed out' }
}

/** Space-separated, with quotes for arguments that contain spaces. */
export function formatArgs(args: readonly string[]): string {
  return args
    .map((arg) => {
      if (arg && !/[\s"']/.test(arg)) return arg
      return arg.includes('"') ? `'${arg}'` : `"${arg}"`
    })
    .join(' ')
}

export function parseArgs(text: string): string[] {
  const args: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    args.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return args
}
