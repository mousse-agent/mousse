export type ProviderAuthType = 'api_key' | 'oauth'

/** Codex sign-in state of a profile, from a live `account/read` on the terminal sign-in. */
export interface CodexStatus {
  state: 'connected' | 'missing_binary' | 'signed_out' | 'disconnected' | 'error'
  message?: string
  /** ISO time of the last live `account/read`. */
  checkedAt?: string
  /** ChatGPT plan of the signed-in account. */
  planType?: string
}

export interface ConfiguredProvider {
  id: string
  /** Provider instance this sign-in serves. */
  instanceId?: string
  label: string
  authType: ProviderAuthType
  source?: string
}

export interface ProviderLoginOption {
  id: string
  label: string
  authType: ProviderAuthType
  configured: boolean
  ambient?: boolean
  /** Short secondary label (e.g. auth method name from pi-ai). */
  description?: string
  /**
   * When true, the UI should run the provider's guided login flow instead of
   * a single API-key field (multi-step prompts, device codes, etc.).
   */
  guidedLogin?: boolean
}

/**
 * The Claude Code provider always uses the terminal `claude` sign-in (default config dir, or an
 * inherited `CLAUDE_CONFIG_DIR`), whatever sign-in method the CLI is configured with.
 */
export interface ClaudeSubscriptionStatus {
  state: 'connected' | 'missing_binary' | 'signed_out' | 'disconnected' | 'error'
  message?: string
  /** ISO time of the last live `claude auth status` check (terminal sign-in only). */
  checkedAt?: string
}

export type ProviderLoginEvent =
  | {
      sessionId: string
      type: 'auth_url'
      url: string
      instructions?: string
      usesCallbackServer: boolean
    }
  | {
      sessionId: string
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | {
      sessionId: string
      type: 'progress'
      message: string
    }
  | {
      sessionId: string
      type: 'prompt'
      promptType: 'text' | 'secret'
      message: string
      placeholder?: string
    }
  | {
      sessionId: string
      type: 'select'
      message: string
      options: Array<{ id: string; label: string; description?: string }>
    }
  | {
      sessionId: string
      type: 'manual_code'
      message: string
    }

export interface ProviderLoginResponse {
  sessionId: string
  kind: 'prompt' | 'select' | 'manual_code' | 'cancel'
  value?: string
}

export interface ProviderLoginResult {
  success: boolean
  error?: string
  sessionId?: string
}

export interface AmbientProviderInfo {
  id: string
  label: string
  instructions: string[]
}

export interface ProviderUsageWindow {
  /** Stable window identifier (for example five_hour or seven_day). */
  id: string
  label: string
  remainingPercent: number
  resetsAt?: string
}

export interface ProviderUsage {
  id: string
  label: string
  status: 'available' | 'unavailable' | 'error'
  windows: ProviderUsageWindow[]
  message?: string
}

export interface ProvidersUsageResponse {
  providers: ProviderUsage[]
  fetchedAt: string
}

/** Provider instances that run a local vendor CLI (Settings → Providers). */
export type CliProviderInstanceId = 'claude' | 'codex' | 'antigravity'
export const CLI_PROVIDER_INSTANCE_IDS: readonly CliProviderInstanceId[] = ['claude', 'codex', 'antigravity']

export interface CliProviderConfig {
  instanceId: CliProviderInstanceId
  /** User-chosen executable; undefined = automatic lookup. */
  binaryPath?: string
  /** What Mousse would launch right now (user path or auto-detected), undefined if not found. */
  resolvedBinaryPath?: string
  /** Parsed from `<binary> --version`, undefined if unknown. */
  version?: string
  /** Extra arguments appended to the CLI launch. */
  args: string[]
  /** Extra environment variables for the CLI process, applied over Mousse's own environment. */
  env: Record<string, string>
  /** Antigravity: Mousse's own sign-in state, whether or not the provider is switched on. */
  signedIn?: boolean
  /** Antigravity: a download is running in the daemon (it outlives the page that started it). */
  installing?: boolean
  /** Antigravity: the latest line of that download's progress. */
  installProgress?: string
}

/** Progress of Mousse downloading a CLI provider's agent (Antigravity only today). */
export interface CliInstallEvent {
  instanceId: CliProviderInstanceId
  type: 'progress'
  message: string
}

export interface CliProviderConfigPatch {
  /** `null` (or an empty string) clears it back to automatic lookup. */
  binaryPath?: string | null
  args?: string[]
  /** Full replacement. */
  env?: Record<string, string>
}
