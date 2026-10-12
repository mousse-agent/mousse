export type ProviderAuthType = 'api_key' | 'oauth'

export interface ConfiguredProvider {
  id: string
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
 * Which Claude Code sign-in a profile's Claude Subscription provider uses: `cli` reuses the
 * terminal `claude` login (default config dir, or an inherited `CLAUDE_CONFIG_DIR`); `isolated`
 * keeps a profile-private config dir with its own sign-in.
 */
export type ClaudeLoginPolicy = 'cli' | 'isolated'

export interface ClaudeSubscriptionStatus {
  /** Null while unresolved: the first-run check could not tell which sign-in to use. */
  loginPolicy: ClaudeLoginPolicy | null
  /** The default profile is the only one that reuses the terminal sign-in without opting in. */
  defaultProfile: boolean
  /** A profile-private sign-in was completed before (kept when the policy is `isolated`). */
  isolatedSignIn: boolean
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
