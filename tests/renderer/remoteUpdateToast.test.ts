// @vitest-environment jsdom
/**
 * On the computer being updated, the countdown shows in every window as "Updating from <computer> in N s" with
 * Cancel, which cancels there and hides it. The main process is stubbed at `window.mousse.updates`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RemoteUpdateToast as Toast } from '../../src/shared/remoteUpdates'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { RemoteUpdateToast } = await import('../../src/renderer/components/updates/RemoteUpdateToast')

let root: Root
let push: (toast: Toast | null) => void = () => undefined
const cancelRemote = vi.fn(async () => undefined)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(1_000_000)
  cancelRemote.mockClear()
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    updates: {
      remoteToast: async () => null,
      onRemoteToast: (listener: (toast: Toast | null) => void) => {
        push = listener
        return () => undefined
      },
      cancelRemote
    }
  }
})
afterEach(() => {
  act(() => root.unmount())
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? ''

it('counts down the update another computer asked for, and Cancel cancels it there', async () => {
  await act(async () => root.render(createElement(RemoteUpdateToast)))
  expect(text()).not.toContain('Updating')
  await act(async () => push({ job: 'j1', from: 'Desk PC', installAt: Date.now() + 10_000 }))
  expect(text()).toContain('Updating from Desk PC in 10 s')
  await act(async () => vi.advanceTimersByTime(3_000))
  expect(text()).toContain('Updating from Desk PC in 7 s')
  // More turns started than were confirmed: it waits for them instead of counting.
  await act(async () => push({ job: 'j1', from: 'Desk PC', installAt: Date.now(), waiting: true }))
  expect(text()).toContain('Updating from Desk PC when turns finish')
  const cancel = [...document.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel')
  await act(async () => cancel!.click())
  expect(cancelRemote).toHaveBeenCalledWith('j1')
  expect(text()).not.toContain('Updating')
})
