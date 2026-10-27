// @vitest-environment jsdom
/**
 * PR 5a-2 review r1 (M3): the sign-in dialog on a browser link that carries the paste field (pi-ai's
 * OpenRouter order) keeps the link's actions and the waiting line, with the field under them, and
 * a pasted answer goes back on that prompt as a redirect.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SignInDialog } from '../../src/renderer/components/providers/SignInDialog'
import { applyOperationEvent, clearOperation } from '../../src/renderer/lib/providerSnapshots'

const PASTE = 'Complete sign-in in your browser, or paste the authorization code / redirect URL here:'
let host: HTMLDivElement
let root: Root
const respondSignIn = vi.fn(async () => true)

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { mousse: unknown }).mousse = {
    providers: { openLoginUrl: vi.fn(async () => ({ ok: true })), onSnapshots: () => () => {}, onOperation: () => () => {}, instances: { respondSignIn } }
  }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  clearOperation('op-link')
})

it('keeps Open again, Copy link and the waiting line, with the paste field under them', async () => {
  act(() => applyOperationEvent({
    operationId: 'op-link',
    instanceId: 'pi:openrouter',
    kind: 'sign_in',
    phase: 'prompt',
    prompt: { promptId: 'op-link:2', type: 'auth_url', url: 'https://openrouter.example/auth', usesCallbackServer: true, acceptsRedirectPaste: true, pasteMessage: PASTE }
  }))
  act(() => root.render(createElement(SignInDialog, { operationId: 'op-link', name: 'OpenRouter', onClose: () => {} })))
  const text = () => document.body.textContent ?? ''
  const button = (label: string) => [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  expect(button('Open sign-in page again')).toBeTruthy()
  expect(button('Copy link')).toBeTruthy()
  expect(text()).toContain('Waiting for you to finish in the browser')
  await act(async () => { button("Browser didn't return here?")!.click() })
  // The link's actions stay while the field is open.
  expect(button('Open sign-in page again')).toBeTruthy()
  expect(text()).toContain(PASTE)
  const input = document.body.querySelector<HTMLInputElement>('#provider-signin-redirect')!
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setValue.call(input, 'fixture-code')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => { button('Continue')!.click() })
  expect(respondSignIn).toHaveBeenCalledWith('op-link', { promptId: 'op-link:2', kind: 'redirect_url', value: 'fixture-code' })
})
