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

it('a failed sign-in says why and offers Try again only where it can start one', async () => {
  act(() => applyOperationEvent({
    operationId: 'op-link',
    instanceId: 'claude',
    kind: 'sign_in',
    phase: 'failed',
    error: { code: 'signed_out', message: 'The browser sign-in timed out.' }
  }))
  const button = (label: string) => [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  act(() => root.render(createElement(SignInDialog, { operationId: 'op-link', name: 'Claude Code', onClose: () => {} })))
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('The browser sign-in timed out.')
  expect(button('Try again')).toBeUndefined()

  const onRetry = vi.fn(async () => {})
  act(() => root.render(createElement(SignInDialog, { operationId: 'op-link', name: 'Claude Code', onClose: () => {}, onRetry })))
  await act(async () => { button('Try again')!.click() })
  expect(onRetry).toHaveBeenCalledTimes(1)

  // A retry that cannot start says why in the dialog.
  onRetry.mockRejectedValueOnce(new Error('The provider service is not running.'))
  await act(async () => { button('Try again')!.click() })
  expect(document.body.querySelector('[role="alert"]')?.textContent).toBe('The provider service is not running.')
})

it('a sign-in whose link arrives late shows starting, then opens the link once however often it is shown again', async () => {
  const link = 'https://accounts.google.com/o/oauth2/v2/auth?response_type=code&state=s&redirect_uri=http%3A%2F%2F127.0.0.1%3A41414%2F'
  const openLoginUrl = (window as unknown as { mousse: { providers: { openLoginUrl: ReturnType<typeof vi.fn> } } }).mousse.providers.openLoginUrl
  const base = { operationId: 'op-link', instanceId: 'antigravity', kind: 'sign_in' } as const
  const prompt = (promptId: string, extra: Record<string, unknown> = {}) =>
    act(() => applyOperationEvent({ ...base, phase: 'prompt', prompt: { promptId, type: 'auth_url', url: link, usesCallbackServer: true, ...extra } }))
  const button = (label: string) => [...document.body.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
  act(() => applyOperationEvent({ ...base, phase: 'progress', message: 'Starting Google sign-in…' }))
  act(() => root.render(createElement(SignInDialog, { operationId: 'op-link', name: 'Google Antigravity', onClose: () => {} })))
  expect(document.body.textContent).toContain('Starting Google sign-in…')
  expect(document.body.querySelector('input')).toBeNull()
  expect(openLoginUrl).not.toHaveBeenCalled()

  prompt('op-link:1')
  prompt('op-link:2', { acceptsRedirectPaste: true })
  // A refused redirect shows the same link again with the reason.
  prompt('op-link:3', { instructions: 'Redirect URL does not match this Google sign-in flow' })
  prompt('op-link:4', { instructions: 'Redirect URL does not match this Google sign-in flow', acceptsRedirectPaste: true })
  expect(openLoginUrl).toHaveBeenCalledExactlyOnceWith(link)
  expect(document.body.textContent).toContain('Redirect URL does not match this Google sign-in flow')
  expect(button('Open sign-in page again')).toBeTruthy()
  expect(button('Copy link')).toBeTruthy()
  expect(button("Browser didn't return here?")).toBeTruthy()
})

it('counts the seconds while the agent starts, and stops once Google\'s link shows', async () => {
  vi.useFakeTimers()
  try {
    act(() => applyOperationEvent({ operationId: 'op-link', instanceId: 'antigravity', kind: 'sign_in', phase: 'progress', message: 'Starting Antigravity…' }))
    act(() => root.render(createElement(SignInDialog, { operationId: 'op-link', name: 'Antigravity', onClose: () => {} })))
    const status = () => document.body.querySelector('[role="status"]')?.textContent ?? ''
    expect(status()).toBe('Starting Antigravity…')
    act(() => { vi.advanceTimersByTime(3_000) })
    expect(status()).toBe('Starting Antigravity…3 s')
    act(() => applyOperationEvent({
      operationId: 'op-link', instanceId: 'antigravity', kind: 'sign_in', phase: 'prompt',
      prompt: { promptId: 'op-link:2', type: 'auth_url', url: 'https://accounts.example/auth', usesCallbackServer: true }
    }))
    expect(document.body.textContent).not.toMatch(/\d s/)
  } finally {
    vi.useRealTimers()
  }
})
