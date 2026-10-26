/**
 * Environment variables that change how Grok signs in or where it sends requests. An instance with
 * a private home never inherits them from Mousse's environment (`INHERITED_CREDENTIALS.grok`). A
 * trailing `*` matches a prefix.
 */

/** The API key Grok runs with ahead of its home's sign-in; an instance may set its own. */
export const GROK_API_KEY_VARIABLE = 'XAI_API_KEY'

/**
 * Any of these set means Mousse cannot tell which account Grok runs as: a token or a sign-in
 * command of their own, another config file, or another endpoint for chats or models.
 */
export const GROK_OVERRIDE_VARIABLES: readonly string[] = Object.freeze([
  'GROK_AUTH*',
  'GROK_OAUTH2_*',
  'GROK_OIDC_*',
  'GROK_CONFIG',
  'GROK_CONFIG_PATH',
  'GROK_LOCAL_AUTH',
  'GROK_CLI_CHAT_PROXY_BASE_URL',
  'GROK_MODELS_BASE_URL'
])

/** Variables Mousse sets itself and that never count as an override. */
export const GROK_OWN_VARIABLES: readonly string[] = Object.freeze(['GROK_OAUTH2_REFERRER'])

export const GROK_CREDENTIAL_VARIABLES: readonly string[] = Object.freeze([GROK_API_KEY_VARIABLE, ...GROK_OVERRIDE_VARIABLES])
