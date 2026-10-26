import { randomBytes } from 'node:crypto'
import { vi } from 'vitest'
import { ChatGptAuth, type ChatGptAuthOptions } from '../../../src/mms/harness/chatgpt/chatgptAuth'
import { LoginSession } from '../../../src/mms/providers/LoginSession'
import type { ProviderLoginEvent } from '../../../src/shared/providerAuth'
import { FULL_SCOPE, plainCodec, type Account, type FakeIssuer } from './fakeIssuer'

/** A `ChatGptAuth` against the fake issuer. */
export function chatgptAuth(issuer: FakeIssuer, homes: { profileHome: string; installationHome: string }, extra: Partial<ChatGptAuthOptions> = {}): ChatGptAuth {
  return new ChatGptAuth({ instanceId: 'codex:managed', ...homes, endpoints: issuer.endpoints, codec: plainCodec, ...extra })
}

/** Starts a sign-in in a real `LoginSession` and exposes its events. */
export function startSignIn(auth: ChatGptAuth, method?: string) {
  const session = new LoginSession(`s-${randomBytes(4).toString('hex')}`)
  const events: ProviderLoginEvent[] = []
  session.on('event', (event: ProviderLoginEvent) => events.push(event))
  const result = auth.signIn(session, method)
  const link = async (index = 0): Promise<URL> => {
    await vi.waitFor(() => {
      if (events.filter((event) => event.type === 'auth_url').length <= index) throw new Error('no link yet')
    })
    const event = events.filter((entry) => entry.type === 'auth_url')[index]
    return new URL(event.type === 'auth_url' ? event.url : '')
  }
  const paste = (value: string) => session.respond({ sessionId: session.sessionId, kind: 'manual_code', value })
  const cancel = () => session.respond({ sessionId: session.sessionId, kind: 'cancel' })
  return { session, events, result, link, paste, cancel }
}

/** The callback the browser would open after the user approves `link`. */
export function callbackFor(link: URL, query: Record<string, string>): URL {
  const callback = new URL(link.searchParams.get('redirect_uri')!)
  callback.search = new URLSearchParams({ state: link.searchParams.get('state')!, ...query }).toString()
  return callback
}

/**
 * Approves `link` as `account` at the fake issuer and returns the callback address. With `open`,
 * the "browser" also opens it.
 */
export async function approve(
  issuer: FakeIssuer,
  link: URL,
  account: Account,
  options: { clientId?: string; scope?: string; returnClientId?: string | null; open?: boolean } = {}
): Promise<URL> {
  const clientId = options.clientId ?? (link.searchParams.get('client_id') === 'dynamic_agent_client' ? 'oaiapp_one' : link.searchParams.get('client_id')!)
  const code = `code-${randomBytes(6).toString('hex')}`
  issuer.grant(code, { clientId, nonce: link.searchParams.get('nonce')!, scope: options.scope ?? FULL_SCOPE, ...account })
  const returned = options.returnClientId === undefined ? clientId : options.returnClientId
  const callback = callbackFor(link, { code, ...(returned === null ? {} : { client_id: returned }) })
  if (options.open !== false) await fetch(callback)
  return callback
}

/** Runs a whole sign-in as `account`. */
export async function signIn(issuer: FakeIssuer, auth: ChatGptAuth, account: Account, options: { method?: string; clientId?: string; scope?: string } = {}) {
  const flow = startSignIn(auth, options.method)
  const link = await flow.link()
  await approve(issuer, link, account, options)
  return { link, result: await flow.result }
}
