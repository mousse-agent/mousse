import { describe, expect, it } from 'vitest'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { LoginSession } from '../src/mms/providers/LoginSession'
import type { ProviderLoginEvent } from '../src/shared/providerAuth'

function waitForEvent(
  session: LoginSession,
  type: ProviderLoginEvent['type']
): Promise<ProviderLoginEvent> {
  return new Promise((resolve) => {
    const handler = (event: ProviderLoginEvent) => {
      if (event.type !== type) return
      session.off('event', handler)
      resolve(event)
    }
    session.on('event', handler)
  })
}

describe('LoginSession abort', () => {
  it('settles the Codex browser login when the session is aborted so its callback server closes', async () => {
    const session = new LoginSession('codex-abort')
    const selectEvent = waitForEvent(session, 'select')
    const manualEvent = waitForEvent(session, 'manual_code')

    const login = openaiCodexProvider().auth.oauth!.login(session.createAuthCallbacks())
    const outcome = login.then(
      () => 'resolved',
      (error: Error) => error.message
    )

    await selectEvent
    session.respond({ sessionId: 'codex-abort', kind: 'select', value: 'browser' })
    await manualEvent

    // ProviderAuthService.endSession aborts without an explicit cancel response.
    session.abort.abort()

    const settled = await Promise.race([
      outcome,
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 3_000))
    ])
    expect(settled).toBe('Login cancelled')
  })

  it('withdraws the manual code prompt when the flow aborts that prompt', async () => {
    const session = new LoginSession('withdraw')
    const promptAbort = new AbortController()
    const callbacks = session.createAuthCallbacks()

    const pending = callbacks.prompt({
      type: 'manual_code',
      message: 'Paste the redirect URL',
      signal: promptAbort.signal
    })
    promptAbort.abort()

    await expect(pending).rejects.toThrow('Manual code prompt withdrawn')
    // A late paste after withdrawal must be ignored rather than resolving a stale prompt.
    expect(() =>
      session.respond({ sessionId: 'withdraw', kind: 'manual_code', value: 'late' })
    ).not.toThrow()
  })
})
