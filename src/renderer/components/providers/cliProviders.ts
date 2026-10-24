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

/**
 * Mousse runs Google's own ACP agent with a private sign-in, so a separately installed `agy` CLI
 * and its sign-in never count. Install and sign-in are separate stages.
 */
function antigravityHealth(input: { config?: CliProviderConfig; configured: boolean }): HealthState {
  const { config, configured } = input
  if (!config && !configured) return { health: 'unknown', label: 'Checking' }
  if (config && !config.resolvedBinaryPath) {
    return config.binaryPath
      ? { health: 'attention', label: 'Not found', detail: `Nothing runs at ${config.binaryPath}`, action: 'install' }
      : {
          health: 'attention',
          label: 'Not installed',
          detail: "Mousse downloads Google's official Antigravity agent (several hundred MB). Your agy CLI isn't used.",
          action: 'install'
        }
  }
  // The service's own state: `configured` drops a provider that is switched off, which stays signed in.
  return (config?.signedIn ?? configured)
    ? { health: 'ready', label: 'Ready', detail: 'Signed in', action: 'sign-out' }
    : {
        health: 'attention',
        label: 'Signed out',
        detail: "Sign in with Google here. Your agy CLI sign-in isn't shared.",
        action: 'sign-in'
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
  if (cli.id === 'antigravity') return antigravityHealth(input)
  if (input.config && !input.config.resolvedBinaryPath) {
    return {
      health: 'attention',
      label: 'Not found',
      detail: input.config.binaryPath ? `Nothing runs at ${input.config.binaryPath}` : `${cli.label} is not installed`
    }
  }
  if (cli.id === 'claude') {
    if (!input.claude) return { health: 'unknown', label: 'Checking' }
    return vendorHealth(cli, input.claude, 'Signed in through your terminal')
  }
  if (!input.codex) return { health: 'unknown', label: 'Checking' }
  return vendorHealth(
    cli,
    input.codex,
    input.codex.planType ? `Signed in through your terminal (ChatGPT ${input.codex.planType})` : 'Signed in through your terminal'
  )
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
