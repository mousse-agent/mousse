// @vitest-environment jsdom
/**
 * The Git section stops saying "Checking…" when the thread's folder lookup does not answer (a drive asleep, a busy
 * service), and shows the folder's state as soon as the lookup answers after all.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useStillPending } from '../../src/renderer/components/sideCard/useStillPending'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

function show(pending: boolean, scope: string) {
  const Probe = () => createElement('span', null, useStillPending(pending, scope, 15_000) ? 'slow' : 'waiting')
  act(() => root.render(createElement(Probe)))
}

function advance(ms: number) {
  act(() => { vi.advanceTimersByTime(ms) })
}

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
})

it('turns slow once a lookup has waited 15 seconds, and back as soon as it answers', () => {
  show(true, 't1')
  advance(14_999)
  expect(host.textContent).toBe('waiting')
  advance(1)
  expect(host.textContent).toBe('slow')
  show(false, 't1')
  expect(host.textContent).toBe('waiting')
})

it('starts the wait again for another thread', () => {
  show(true, 't1')
  advance(15_000)
  show(true, 't2')
  expect(host.textContent).toBe('waiting')
  advance(15_000)
  expect(host.textContent).toBe('slow')
})
