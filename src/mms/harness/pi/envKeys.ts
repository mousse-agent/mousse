/**
 * The credential variables Pi reads from its environment, by provider: pi-ai's `getApiKeyEnvVars`
 * table in the pinned 0.85.1 (`pi-ai/dist/env-api-keys.js`). A test diffs this copy against the
 * table in the bundled runtime, so an upgrade that adds a key fails until it is listed here.
 *
 * Ambient cloud credentials (`AWS_*`, Google ADC) are not keys and are not listed: they stay in
 * the child's environment.
 */
export const PI_PROVIDER_ENV_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'github-copilot': ['COPILOT_GITHUB_TOKEN'],
  anthropic: ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'],
  'ant-ling': ['ANT_LING_API_KEY'],
  'qwen-token-plan': ['QWEN_TOKEN_PLAN_API_KEY'],
  'qwen-token-plan-cn': ['QWEN_TOKEN_PLAN_CN_API_KEY'],
  'qwen-token-plan-individual': ['QWEN_TOKEN_PLAN_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'azure-openai-responses': ['AZURE_OPENAI_API_KEY'],
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
 * Every credential variable a Pi child would read: none is inherited from Mousse's environment.
 * The launcher re-adds only the instance's own provider key (`piOwnProviderKeys`).
 */
export const PI_ENV_KEYS: readonly string[] = Object.freeze([
  ...new Set([...Object.values(PI_PROVIDER_ENV_KEYS).flat(), ...ANTHROPIC_OAUTH_ENV_KEYS])
])

/** The variables a `pi:<provider>` instance may take from the user's environment: its own key, never an Anthropic subscription token. */
export function piOwnProviderKeys(provider: string): string[] {
  const oauth = new Set(ANTHROPIC_OAUTH_ENV_KEYS)
  return (PI_PROVIDER_ENV_KEYS[provider] ?? []).filter((name) => !oauth.has(name))
}
