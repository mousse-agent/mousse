// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChatBrowserAccess } from '../../src/renderer/components/chats/ChatBrowserAccess'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { BrowserAccessState } from '../../src/shared/browser/access'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let access: BrowserAccessState
let pushed: (() => void) | undefined
const request = vi.fn(async () => access)

beforeEach(() => {
  access = { allowed: false, pending: [] }
  pushed = undefined
  request.mockClear()
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    browser: { onAccessChanged: (listener: () => void) => { pushed = listener; return () => { pushed = undefined } } }
  }
  useAppStore.setState({ profileId: 'profile_a', activeThreadId: 'thread_a' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  vi.useFakeTimers()
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})

const settle = () => act(async () => { for (let i = 0; i < 4; i += 1) await Promise.resolve() })
const prompt = () => host.querySelector('[aria-label="Agent browser access request"]')

it("asks in the thread as soon as the service says its agent wants the browser, without polling every 750 ms", async () => {
  act(() => root.render(createElement(ChatBrowserAccess, { threadId: 'thread_a' })))
  await settle()
  expect(request).toHaveBeenCalledTimes(1)
  expect(prompt()).toBeNull()

  access = { allowed: false, pending: [{ requestId: 'request_1', threadId: 'thread_a' }] }
  await act(async () => { vi.advanceTimersByTime(5000) })
  await settle()
  expect(request).toHaveBeenCalledTimes(1)
  expect(prompt()).toBeNull()

  await act(async () => { pushed!() })
  await settle()
  expect(prompt()?.textContent).toContain('Allow agents to use this profile’s browser?')

  // A push that was missed is caught by the 30-second read.
  access = { allowed: true, pending: [] }
  await act(async () => { vi.advanceTimersByTime(30_000) })
  await settle()
  expect(prompt()).toBeNull()
})

it('stops listening when the thread is closed', async () => {
  act(() => root.render(createElement(ChatBrowserAccess, { threadId: 'thread_a' })))
  await settle()
  expect(pushed).toBeTypeOf('function')
  act(() => root.render(createElement('div')))
  expect(pushed).toBeUndefined()
})
