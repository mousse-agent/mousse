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
  /** A sign-in that succeeded with something the user should know. */
  warning?: string
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

/** Where ChatGPT shows a plan's usage. The usage page links to it; Mousse never reads it. */
export const CHATGPT_USAGE_URL = 'https://chatgpt.com/settings/usage'

export interface ProviderUsage {
  id: string
  label: string
  status: 'available' | 'unavailable' | 'error'
  windows: ProviderUsageWindow[]
  message?: string
  /** Where the provider's own usage page is, when Mousse cannot show the numbers itself. */
  manageUrl?: string
  /** Where the numbers came from when it is not the provider itself (for example "via local proxy"). */
  source?: string
  /** ISO time the windows were reported, when that is not now (the last snapshot a provider sent). */
  readAt?: string
  /** The plan the limits belong to, as the provider names it ("Plus", "Pro"), when it says. */
  plan?: string
  /** The local CLI-to-API proxy the limits are read through, when one was detected. */
  proxy?: UsageProxyState
  /** Each account's own windows, when the provider reads several (a proxy with several sign-ins). */
  accounts?: UsageAccount[]
  /** A prepaid credit balance, for a provider billed by credits rather than limit windows. */
  credit?: UsageCredit
  /** Limit resets the account has available, when the provider reports them. */
  resets?: UsageResets
  /** The entry is set up and turned on but not signed in: listed so the usage page can offer Reconnect. */
  signedOut?: true
  /** Why there are no numbers, when the reader knows: it decides what the page says and offers. */
  problem?: UsageProblem
  /** How the provider is signed in, for a pi-ai provider (an API key or OAuth). */
  authType?: ProviderAuthType
}

/**
 * Why a provider has no usage numbers: no subscription on the account, an expired sign-in, an
 * expired or rejected key, or nothing certain (`unavailable`).
 */
export type UsageProblem = 'no_subscription' | 'session_expired' | 'key_expired' | 'key_rejected' | 'unavailable'

/** Limit resets an account has available: how many, and what the provider says of each. */
export interface UsageResets {
  available: number
  /** `id` is the provider's opaque credit id, for using that credit (never shown). */
  credits?: Array<{ id?: string; title?: string; type?: string; status?: string; expiresAt?: string }>
}

/** What using a limit reset did, as the provider reports it. */
export type LimitResetOutcome = 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'

export interface UseLimitResetResponse {
  outcome: LimitResetOutcome
}

/** A credit balance in USD: what is left, what was spent, and the limit when the provider has one. */
export interface UsageCredit {
  balanceUsd: number
  usedUsd?: number
  limitUsd?: number
}

/** One account of a provider that reads several: its label, its windows, or why it has none. */
export interface UsageAccount {
  id: string
  /** As the source names it (the sign-in's email or label). */
  label: string
  windows: ProviderUsageWindow[]
  /** Why this account has no windows, in a few words ("Sign-in expired"). */
  problem?: string
  /** Limit resets this account has available, when the provider reports them. */
  resets?: UsageResets
  /** Listed, its usage not read yet (a page filling sign-ins in one by one). */
  pending?: true
}

/** A detected CLI-to-API proxy, as the usage page shows it. Never carries the key itself. */
export interface UsageProxyState {
  /** `host:port` of the proxy. */
  address: string
  /** Where its management key comes from: none yet, saved in Mousse, or Claude's environment. */
  key: 'none' | 'saved' | 'environment'
  /** Why the limits could not be read with that key. */
  problem?: 'rejected' | 'unreachable'
}

/** The answer to saving a proxy key: kept only when the proxy accepted it. */
export type UsageProxyKeyResult = { ok: true } | { ok: false; reason: 'rejected' | 'unreachable' | 'no_proxy' }

/** A provider the usage page shows, before its usage is read: how to name it, and its last reading. */
export interface UsageSlot {
  id: string
  label: string
  authType?: ProviderAuthType
  signedOut?: true
  /** The last reading this computer made, dated (`readAt`), to show until the fresh one arrives. */
  cached?: ProviderUsage
}

export interface UsageSlotsResponse {
  slots: UsageSlot[]
}

/** One provider's fresh usage, or one of its sign-ins (`accountId`), or its sign-ins before their usage (`preview`). */
export interface UsageForResponse {
  provider?: ProviderUsage
  account?: UsageAccount
}

export interface ProvidersUsageResponse {
  providers: ProviderUsage[]
  fetchedAt: string
}

/** Provider instances that run a local vendor CLI (Settings → Providers). */
export type CliProviderInstanceId = 'claude' | 'codex' | 'antigravity'

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
