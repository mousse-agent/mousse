// Ported from @earendil-works/pi-ai 1.4.0 `dist/auth/oauth/openai-chatgpt.js` (MIT, Copyright (c)
// Mario Zechner): the authorize parameters, the callback server, the race with a pasted redirect
// and closing spare connections. Rewritten in TypeScript with T3 Code's callback rules
// (`apps/server/src/provider/CodexChatGptAuth.ts`, MIT, Copyright (c) 2026 T3 Tools Inc.): an
// ephemeral port, one-shot callback, state first, and the issued client id checks.
// See THIRD_PARTY_NOTICES.md.

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Discovery } from './discovery'
import { ChatGptAuthError, MESSAGES } from './errors'
import { oauthErrorCode, postForm } from './http'
import { createPkce, randomValue } from './pkce'
import type { ChatGptRegistration } from './store'
import { DIRECT_SCOPE } from './store'
import { OPENAI_RESOURCE, parseTokenResponse, type TokenSet } from './tokens'

/** Every first sign-in registers a new client; OpenAI returns the issued id in the callback. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
export const AGENT_NAME_HINT = 'Mousse'
export const CALLBACK_PATH = '/auth/callback'
export const SCOPE = `openid profile email offline_access resource.invoke ${DIRECT_SCOPE}`
/** The longest pasted redirect accepted. */
export const MAX_PASTE_BYTES = 16 * 1024
const EXCHANGE_TIMEOUT_MS = 20_000

/**
 * The part of a login session the flow uses. `LoginSession.createAuthCallbacks` provides it; the
 * `manual_code` prompt is the pasted-redirect field.
 */
export interface SignInInteraction {
  readonly signal: AbortSignal
  prompt(prompt: { type: 'manual_code'; message: string; placeholder?: string; signal?: AbortSignal }): Promise<string>
  notify(event: { type: 'auth_url'; url: string; instructions?: string } | { type: 'progress'; message: string }): void
}

export interface AuthorizeInput {
  discovery: Discovery
  /** `urn:uuid:…`, the installation's host id. */
  hostId: string
  /** The saved registration to sign in again; absent registers a new client. */
  registration?: ChatGptRegistration
  /** Ask again for plan use, after a grant that lacked it. */
  consent: boolean
  interaction: SignInInteraction
}

/** What the callback returned, ready to exchange. */
export interface AuthorizationGrant {
  code: string
  clientId: string
  redirectUri: string
  verifier: string
  nonce: string
  /**
   * Closes the callback server. Until then a repeated browser request is answered 410; the
   * caller closes it when the sign-in ends.
   */
  close(): void
}

export function authorizeUrl(input: {
  authorizationEndpoint: string
  hostId: string
  redirectUri: string
  registration?: ChatGptRegistration
  consent: boolean
  state: string
  nonce: string
  challenge: string
}): string {
  const url = new URL(input.authorizationEndpoint)
  const params: Record<string, string> = input.registration
    ? {
        client_id: input.registration.clientId,
        // Reauth: name the account, never the ID token (the URL travels to the renderer).
        ...(input.registration.email ? { login_hint: input.registration.email } : {}),
        ...(input.consent ? { prompt: 'consent' } : {})
      }
    : { client_id: DYNAMIC_CLIENT_ID, agent_name_hint: AGENT_NAME_HINT }
  url.search = new URLSearchParams({
    ...params,
    ext_agent_host_id: input.hostId,
    response_type: 'code',
    redirect_uri: input.redirectUri,
    scope: SCOPE,
    resource: OPENAI_RESOURCE,
    state: input.state,
    nonce: input.nonce,
    code_challenge_method: 'S256',
    code_challenge: input.challenge
  }).toString()
  return url.toString()
}

/**
 * Checks a callback, in order: the state, a declined or failed authorization, the code, then the
 * client id (a first registration needs an issued `oaiapp_` id; a reauth must not return another).
 */
export function checkCallback(url: URL, expected: { state: string; registeredClientId?: string }): { code: string; clientId: string } {
  const states = url.searchParams.getAll('state')
  if (states.length !== 1 || states[0] !== expected.state) throw new ChatGptAuthError('signed_out', 'callback', MESSAGES.stateMismatch)
  const error = url.searchParams.get('error')
  if (error !== null) {
    if (error === 'access_denied') throw new ChatGptAuthError('signed_out', 'declined', MESSAGES.declined)
    throw new ChatGptAuthError('signed_out', 'callback', MESSAGES.callbackFailed)
  }
  const codes = url.searchParams.getAll('code')
  if (codes.length !== 1 || !codes[0]) throw new ChatGptAuthError('signed_out', 'callback', MESSAGES.callbackFailed)
  const returned = url.searchParams.getAll('client_id')
  if (returned.length > 1) throw new ChatGptAuthError('signed_out', 'registration', MESSAGES.registrationIncomplete)
  if (expected.registeredClientId !== undefined) {
    if (returned.length === 1 && returned[0] !== expected.registeredClientId) {
      throw new ChatGptAuthError('signed_out', 'registration', MESSAGES.registrationIncomplete)
    }
    return { code: codes[0], clientId: expected.registeredClientId }
  }
  const clientId = returned[0]
  if (!clientId || !/^oaiapp_[\w-]+$/.test(clientId)) throw new ChatGptAuthError('signed_out', 'registration', MESSAGES.registrationIncomplete)
  return { code: codes[0], clientId }
}

/**
 * A pasted redirect address, for a browser that cannot reach this machine (WSL, SSH, a remote
 * daemon). It must be the exact callback: `http://127.0.0.1:<this attempt's port>/auth/callback`,
 * at most 16 KB, without credentials or a fragment, with one `code` (or an `error`) and one `state`.
 */
export function parsePastedRedirect(input: string, port: number): URL {
  const invalid = () => new ChatGptAuthError('signed_out', 'callback', MESSAGES.pasteInvalid)
  const text = input.trim()
  if (Buffer.byteLength(text, 'utf8') > MAX_PASTE_BYTES || text.includes('#')) throw invalid()
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw invalid()
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== String(port) || url.pathname !== CALLBACK_PATH) throw invalid()
  if (url.username || url.password) throw invalid()
  if (url.searchParams.getAll('state').length !== 1) throw invalid()
  if (!url.searchParams.has('error') && url.searchParams.getAll('code').length !== 1) throw invalid()
  return url
}

const CALLBACK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Mousse</title></head><body style="font-family:system-ui,sans-serif;margin:3rem">
<p>Return to Mousse to finish signing in. You can close this window.</p></body></html>`

const CLOSED_PAGE = 'This sign-in is no longer active.'

const PAGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff'
}

interface CallbackServer {
  port: number
  /** The first request on the callback path. */
  result: Promise<URL>
  /** Idempotent. */
  close(): void
}

/** Listens on an ephemeral 127.0.0.1 port. The callback path answers once, then 410. */
function startCallbackServer(): Promise<CallbackServer> {
  return new Promise((resolve, reject) => {
    let used = false
    let deliver!: (url: URL) => void
    const result = new Promise<URL>((resolveResult) => (deliver = resolveResult))
    const server: Server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        response.writeHead(404, { 'cache-control': 'no-store' }).end()
        return
      }
      if (used) {
        response.writeHead(410, { ...PAGE_HEADERS, 'content-type': 'text/plain; charset=utf-8' }).end(CLOSED_PAGE)
        return
      }
      used = true
      response.writeHead(200, PAGE_HEADERS).end(CALLBACK_PAGE)
      deliver(url)
    })
    server.once('error', () => reject(new ChatGptAuthError('signed_out', 'callback', MESSAGES.callbackServer)))
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        result,
        close: () => {
          used = true
          if (!server.listening) return
          server.close()
          // close() only stops new connections. A browser's spare keep-alive connection would
          // otherwise stay attached to this server and swallow a later attempt's callback.
          server.closeAllConnections()
        }
      })
    })
  })
}

function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled))
    else signal.addEventListener('abort', () => reject(new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled)), { once: true })
  })
}

/**
 * Runs the browser part of a sign-in: starts the callback server, offers the paste field, shows the
 * sign-in link, and waits for whichever answer comes first. The paste field is registered before
 * the link is shown, so the link's prompt carries `acceptsRedirectPaste`.
 */
export async function authorize(input: AuthorizeInput): Promise<AuthorizationGrant> {
  const { interaction } = input
  if (interaction.signal.aborted) throw new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled)
  const { verifier, challenge } = createPkce()
  const state = randomValue()
  const nonce = randomValue()
  const server = await startCallbackServer()
  const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`
  const pasteWithdrawn = new AbortController()
  try {
    const pasted = interaction
      .prompt({
        type: 'manual_code',
        message: 'Paste the address your browser ended on',
        placeholder: redirectUri,
        signal: AbortSignal.any([pasteWithdrawn.signal, interaction.signal])
      })
      .then(
        (value) => parsePastedRedirect(value, server.port),
        // An empty answer or a closed dialog ends the sign-in.
        (error: unknown) => {
          throw error instanceof ChatGptAuthError ? error : new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled)
        }
      )
    // A withdrawn or cancelled paste field must not surface as an unhandled rejection.
    pasted.catch(() => undefined)
    interaction.notify({
      type: 'auth_url',
      url: authorizeUrl({
        authorizationEndpoint: input.discovery.authorizationEndpoint,
        hostId: input.hostId,
        redirectUri,
        registration: input.registration,
        consent: input.consent,
        state,
        nonce,
        challenge
      }),
      instructions: "Continue with ChatGPT in your browser. If it can't reach this computer, paste the address it ended on."
    })
    const returned = await Promise.race([server.result, pasted, rejectOnAbort(interaction.signal)])
    const { code, clientId } = checkCallback(returned, { state, registeredClientId: input.registration?.clientId })
    return { code, clientId, redirectUri, verifier, nonce, close: () => server.close() }
  } catch (error) {
    server.close()
    if (interaction.signal.aborted) throw new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled)
    throw error
  } finally {
    pasteWithdrawn.abort()
  }
}

/** Exchanges the authorization code at the token endpoint (20 s). */
export async function exchangeCode(discovery: Discovery, grant: Omit<AuthorizationGrant, 'close'>, signal?: AbortSignal): Promise<TokenSet> {
  let response
  try {
    response = await postForm(
      discovery.tokenEndpoint,
      {
        grant_type: 'authorization_code',
        client_id: grant.clientId,
        code: grant.code,
        code_verifier: grant.verifier,
        redirect_uri: grant.redirectUri,
        resource: OPENAI_RESOURCE
      },
      { timeoutMs: EXCHANGE_TIMEOUT_MS, signal }
    )
  } catch {
    if (signal?.aborted) throw new ChatGptAuthError('cancelled', 'cancelled', MESSAGES.cancelled)
    throw new ChatGptAuthError('timeout', 'transient', MESSAGES.exchangeFailed)
  }
  if (!response.ok) {
    const code = oauthErrorCode(response.body)
    if (code === 'invalid_grant') throw new ChatGptAuthError('signed_out', 'code_expired', MESSAGES.codeExpired)
    if (code === 'access_denied') throw new ChatGptAuthError('signed_out', 'declined', MESSAGES.declined)
    if (code === 'invalid_client') throw new ChatGptAuthError('wont_run', 'invalid_client', MESSAGES.invalidClient)
    throw new ChatGptAuthError('signed_out', 'transient', MESSAGES.exchangeFailed)
  }
  return parseTokenResponse(response.body)
}
