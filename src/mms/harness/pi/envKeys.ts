/**
 * The credential variables Pi reads from its environment, by provider: pi-ai's `getApiKeyEnvVars`
 * table in the pinned 1.4.0 (`pi-ai/dist/env-api-keys.js`). A test diffs this copy against the
 * table in the bundled runtime, so an upgrade that adds a key fails until it is listed here.
 *
 * Ambient cloud credentials (`AWS_*`, Google ADC) are not keys and are not listed: they stay in
 * the child's environment (`PI_AMBIENT_ENV` lists them for locked bot processes).
 */
export const PI_PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  azure: ['AZURE_OPENAI_API_KEY'],
  nvidia: ['NVIDIA_API_KEY'],
  deepseek: ['DEEPSEEK_API_KEY'],
  google: ['GEMINI_API_KEY'],
  'google-vertex': ['GOOGLE_CLOUD_API_KEY'],
  groq: ['GROQ_API_KEY'],
  cerebras: ['CEREBRAS_API_KEY'],
  xai: ['XAI_API_KEY'],
  radius: ['RADIUS_API_KEY'],
  openrouter: ['OPENROUTER_API_KEY'],
  'vercel-ai-gateway': ['AI_GATEWAY_API_KEY'],
  zai: ['ZAI_API_KEY'],
  'zai-coding-cn': ['ZAI_CODING_CN_API_KEY'],
  mistral: ['MISTRAL_API_KEY'],
  minimax: ['MINIMAX_API_KEY'],
  'minimax-cn': ['MINIMAX_CN_API_KEY'],
  moonshotai: ['MOONSHOT_API_KEY'],
  'moonshotai-cn': ['MOONSHOT_API_KEY'],
  huggingface: ['HF_TOKEN'],
  fireworks: ['FIREWORKS_API_KEY'],
  together: ['TOGETHER_API_KEY'],
  baseten: ['BASETEN_API_KEY'],
  opencode: ['OPENCODE_API_KEY'],
  'opencode-go': ['OPENCODE_API_KEY'],
  'kimi-coding': ['KIMI_API_KEY'],
  meta: ['META_API_KEY'],
  typesafe: ['TYPESAFE_API_KEY'],
  'cloudflare-workers-ai': ['CLOUDFLARE_API_KEY'],
  'cloudflare-ai-gateway': ['CLOUDFLARE_API_KEY'],
  xiaomi: ['XIAOMI_API_KEY'],
  'xiaomi-token-plan-cn': ['XIAOMI_TOKEN_PLAN_CN_API_KEY'],
  'xiaomi-token-plan-ams': ['XIAOMI_TOKEN_PLAN_AMS_API_KEY'],
  'xiaomi-token-plan-sgp': ['XIAOMI_TOKEN_PLAN_SGP_API_KEY']
})

/** Anthropic subscription credentials: never passed to Pi, not even for the `anthropic` instance. */
export const ANTHROPIC_OAUTH_ENV_KEYS: readonly string[] = Object.freeze(['ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])

/**
 * Anthropic workload identity federation (`anthropic-messages.js` `getAnthropicFederation`): with no
 * key, pi-ai signs Anthropic requests in with these. Never passed to Pi; the request guard refuses
 * an Anthropic request without an API key anyway.
 */
export const ANTHROPIC_FEDERATION_ENV_KEYS: readonly string[] = Object.freeze(['ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'ANTHROPIC_WORKSPACE_ID'])

/**
 * Every credential variable a Pi child would read: none is inherited from Mousse's environment.
 * The launcher re-adds only the instance's own provider key (`piOwnProviderKeys`).
 */
export const PI_ENV_KEYS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(PI_PROVIDER_ENV_KEYS).flat(), ...ANTHROPIC_OAUTH_ENV_KEYS, ...ANTHROPIC_FEDERATION_ENV_KEYS])
])

/** The variables a `pi:<provider>` instance may take from the user's environment: its own key, never an Anthropic subscription token. */
export function piOwnProviderKeys(provider: string): string[] {
  const oauth = new Set(ANTHROPIC_OAUTH_ENV_KEYS)
  return (PI_PROVIDER_ENV_KEYS[provider] ?? []).filter((name) => !oauth.has(name))
}

/**
 * The ambient credentials and settings the pinned Pi reads for its cloud providers (pi-ai's
 * Bedrock and Vertex streams, with the bundled AWS SDK and Google auth library). A locked bot
 * process on an ambient instance gets exactly its provider's set (`lockedEnv`), and nothing else
 * under these prefixes: not the AWS retry and defaults switches (the launcher pins retries), not the
 * test, metadata or external-account switches, and not `GOOGLE_CLOUD_API_KEY`, Vertex's API key,
 * which is a credential rather than ambient config (an ambient Vertex instance runs on the
 * application default credentials). Profiles, SSO caches and the default credentials file are read
 * from the home folder, which every locked environment keeps. A test diffs these sets against the
 * variables the pinned bundle reads.
 */
export const PI_AMBIENT_ENV: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'amazon-bedrock': Object.freeze([
    'AWS_PROFILE',
    'AWS_REGION',
    'AWS_DEFAULT_REGION',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_CREDENTIAL_EXPIRATION',
    'AWS_BEARER_TOKEN_BEDROCK',
    'AWS_CONFIG_FILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'AWS_ROLE_ARN',
    'AWS_ROLE_SESSION_NAME',
    'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
    'AWS_CONTAINER_CREDENTIALS_FULL_URI',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN',
    'AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE',
    'AWS_LOGIN_CACHE_DIRECTORY',
    'AWS_ENDPOINT_URL',
    'AWS_IGNORE_CONFIGURED_ENDPOINT_URLS',
    'AWS_USE_FIPS_ENDPOINT',
    'AWS_USE_DUALSTACK_ENDPOINT'
  ]),
  'google-vertex': Object.freeze([
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_CLOUD_PROJECT',
    'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_LOCATION',
    'GOOGLE_CLOUD_QUOTA_PROJECT',
    'CLOUDSDK_CONFIG'
  ])
})

/**
 * What pi-ai's `getEnvApiKey` returns for Bedrock and Vertex when the environment's cloud
 * credentials (not a key) sign them in, and what Mousse then stores as their credential. Any other
 * stored value is a real key (a Vertex API key saved by hand, or found in `GOOGLE_CLOUD_API_KEY`),
 * which Pi uses as the key.
 */
export const PI_AMBIENT_MARKER = '<authenticated>'

/** A Pi provider that can sign in with the environment's cloud credentials instead of a key. */
export function piAmbientProvider(provider: string): boolean {
  return Object.hasOwn(PI_AMBIENT_ENV, provider)
}
