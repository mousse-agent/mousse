// @vitest-environment jsdom
/**
 * A group chat asks before its agents use the profile's browser, and once allowed, says so in one quiet line with Turn
 * off to take the consent back.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBrowserAccess } from '../../src/renderer/components/chats/ChatBrowserAccess'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { BrowserAccessState } from '../../src/shared/browser/access'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let access: BrowserAccessState
let request: ReturnType<typeof vi.fn>

beforeEach(() => {
  access = { allowed: false, pending: [] }
  request = vi.fn(async (method: string, params: { allowed?: boolean }) => {
    if (method === 'browser.access.set' || method === 'browser.access.respond') access = { allowed: params.allowed === true, pending: [] }
    return access
  })
  ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request } }
  useAppStore.setState({ profileId: 'profile_a' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve() })
const show = async () => { act(() => root.render(createElement(ChatBrowserAccess, { threadId: 'chat_thread' }))); await settle() }
const button = (name: string) => [...host.querySelectorAll('button')].find((item) => item.textContent === name)

describe('a group chat\'s browser consent', () => {
  it('shows nothing until a chat asks', async () => {
    await show()
    expect(host.textContent).toBe('')
  })

  it('asks in the chat that wants the browser, and once allowed offers Turn off, which takes the consent back', async () => {
    access = { allowed: false, pending: [{ requestId: 'request_1', threadId: 'chat_thread' }] } as BrowserAccessState
    await show()
    await act(async () => button('Allow')!.click())
    await settle()
    expect(request).toHaveBeenCalledWith('browser.access.respond', { profileId: 'profile_a', requestId: 'request_1', allowed: true })
    // The next status read shows the consent in force.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 800)) })
    expect(host.querySelector('[aria-label="Agent browser access"]')?.textContent).toContain('Agents can use the browser')
    await act(async () => button('Turn off')!.click())
    await settle()
    expect(request).toHaveBeenCalledWith('browser.access.set', { profileId: 'profile_a', allowed: false })
    expect(host.querySelector('[aria-label="Agent browser access"]')).toBeNull()
    expect(access.allowed).toBe(false)
  })
})
