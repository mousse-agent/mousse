/**
 * PR 5a-2 review r1 (M3): pi-ai's OpenRouter sign-in sends the browser link first and the paste
 * field after it. The sign-in dialog shows the latest prompt of an operation, so the field must
 * arrive with the link: the link is sent again with the paste field under it, and a pasted answer
 * on that prompt finishes the sign-in. A flow that sends the field first is unchanged.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import type { HarnessGatewayEvent } from '../../src/mms/harness/gateway'
import type { LoginSession } from '../../src/mms/providers/LoginSession'
import { ProviderInstanceService } from '../../src/mms/providers/ProviderInstanceService'
import { PiLoopAdapter } from '../../src/mms/run/adapters/pi/PiLoopAdapter'
import { adapterDriver, testHarness } from '../../src/mms/run/testkit/harness'
import { SignInDialog } from '../../src/renderer/components/providers/SignInDialog'
import { applyOperationEvent, clearOperation } from '../../src/renderer/lib/providerSnapshots'
import type { SignInPrompt } from '../../src/shared/harness/types'

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

const PASTE = 'Complete sign-in in your browser, or paste the authorization code / redirect URL here:'

/** A pi entry whose sign-in runs `flow`; returns the prompts the dialog would receive. */
function signInWith(flow: (session: LoginSession) => Promise<{ success: boolean }>) {
  const home = mkdtempSync(join(tmpdir(), 'mousse-signin-order-'))
  homes.push(home)
  let value: unknown = { 'pi:openrouter': { driver: 'pi', enabled: true } }
  const instances = new ProviderInstanceService({ store: { read: () => ({ instances: value, seedVersion: 1 }), write: (next) => { value = next.instances } } })
  const pi = new PiLoopAdapter(() => ({ chat: async () => { throw new Error('unused') } }))
  const driver = adapterDriver(pi, { runtime: { signIn: async (session) => ({ ...(await flow(session as LoginSession)), sessionId: session.sessionId }) } })
  const harness = testHarness({ drivers: [driver], instances, profileHome: home })
  const events: HarnessGatewayEvent[] = []
  harness.instances.subscribe((event) => events.push(event))
  const prompts = (): SignInPrompt[] => events.flatMap((event) => (event.type === 'operation' && event.data.phase === 'prompt' ? [event.data.prompt] : []))
  const finished = () => events.some((event) => event.type === 'operation' && event.data.phase === 'completed')
  return { harness, prompts, finished }
}

describe('a paste field that follows the browser link (OpenRouter order)', () => {
  it('is sent with the link, and a pasted answer on it finishes the sign-in', async () => {
    const { harness, prompts, finished } = signInWith(async (session) => {
      const callbacks = session.createAuthCallbacks()
      callbacks.notify({ type: 'auth_url', url: 'https://openrouter.example/auth', instructions: 'Complete sign-in in your browser.' })
      const code = await callbacks.prompt({ type: 'manual_code', message: PASTE } as never)
      return { success: code === 'fixture-code' }
    })
    const started = await harness.instances.signIn('pi:openrouter', 'oauth')
    await expect.poll(() => prompts().length).toBe(2)
    const [link, withPaste] = prompts()
    expect(link).toMatchObject({ type: 'auth_url', url: 'https://openrouter.example/auth' })
    // The latest prompt is still the link, now with the field under it.
    expect(withPaste).toMatchObject({ type: 'auth_url', url: 'https://openrouter.example/auth', instructions: 'Complete sign-in in your browser.', acceptsRedirectPaste: true, pasteMessage: PASTE })
    expect(withPaste!.promptId).not.toBe(link!.promptId)
    expect(await harness.instances.respondSignIn(started.operationId, { promptId: withPaste!.promptId, kind: 'redirect_url', value: 'fixture-code' })).toBe(true)
    await expect.poll(finished).toBe(true)
    harness.stop()
  })

  it('a field sent before any link stays its own prompt', async () => {
    const { harness, prompts, finished } = signInWith(async (session) => {
      const callbacks = session.createAuthCallbacks()
      const code = await callbacks.prompt({ type: 'manual_code', message: 'Paste the code.' } as never)
      return { success: code === 'fixture-code' }
    })
    const started = await harness.instances.signIn('pi:openrouter', 'oauth')
    await expect.poll(() => prompts().length).toBe(1)
    const [field] = prompts()
    expect(field).toMatchObject({ type: 'input', secret: false, message: 'Paste the code.' })
    expect(await harness.instances.respondSignIn(started.operationId, { promptId: field!.promptId, kind: 'input', value: 'fixture-code' })).toBe(true)
    await expect.poll(finished).toBe(true)
    harness.stop()
  })
})

describe('the sign-in dialog on that prompt', () => {
  it('keeps the link, Open again and Copy link, with the paste fallback under them', () => {
    applyOperationEvent({
      operationId: 'op-order',
      instanceId: 'pi:openrouter',
      kind: 'sign_in',
      phase: 'prompt',
      prompt: { promptId: 'op-order:2', type: 'auth_url', url: 'https://openrouter.example/auth', usesCallbackServer: true, acceptsRedirectPaste: true, pasteMessage: PASTE }
    })
    try {
      const html = renderToStaticMarkup(createElement(SignInDialog, { operationId: 'op-order', name: 'OpenRouter', onClose: () => {} }))
      expect(html).toContain('Open sign-in page again')
      expect(html).toContain('Copy link')
      expect(html).toContain('Waiting for you to finish in the browser')
      expect(html).toContain('Browser didn&#x27;t return here?')
    } finally {
      clearOperation('op-order')
    }
  })
})
