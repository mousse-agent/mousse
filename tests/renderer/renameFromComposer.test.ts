// @vitest-environment jsdom
/**
 * The composer's `/rename` with no title renames the thread in its sidebar row when a row of it is on
 * screen: its own row first, its copy in "Needs me" only when that is the one shown.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'


;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = '2026-11-05T10:00:00.000Z'
const thread = (id: string, name: string, projectId: string): Thread =>
  ({ id, name, createdAt: at, updatedAt: at, startedAt: at, order: 0, projectId })

const appKeys = ['projects', 'threads', 'activeThreadId', 'threadsSidebarView', 'threadFeedOrder', 'threadActivity'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getState()[key]]))
const offsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetParent')

let host: HTMLDivElement
let root: Root
/** jsdom has no layout; which rows count as on screen. */
let onScreen: (element: HTMLElement) => boolean = () => true

beforeEach(async () => {
  ;(window as unknown as { mousse: object }).mousse = {}
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) { return onScreen(this) ? document.body : null }
  })
  useAppStore.setState({
    projects: [{ id: 'p1', name: 'Mousse', path: '/p/mousse', createdAt: at, order: 0 }],
    threads: [thread('a', 'Fix tests', 'p1'), thread('b', 'Ship docs', 'p1')],
    activeThreadId: null,
    threadsSidebarView: 'threads',
    threadFeedOrder: [],
    threadActivity: { b: 'awaiting_input' }
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => root.render(createElement(ThreadsSidebar)))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
  if (offsetParent) Object.defineProperty(HTMLElement.prototype, 'offsetParent', offsetParent)
  onScreen = () => true
})

function renameFromComposer(threadId: string): boolean {
  const event = new CustomEvent('mousse:rename-thread', { detail: { threadId }, cancelable: true })
  act(() => { window.dispatchEvent(event) })
  return event.defaultPrevented
}

const renameInput = () => host.querySelector<HTMLInputElement>('.threads-sidebar-rename-input')
const inNeedsMe = (element: Element | null) => Boolean(element?.closest('.threads-sidebar-needs-me'))

describe('/rename from the composer', () => {
  it('renames in the thread\'s own row when it is on screen', () => {
    expect(renameFromComposer('b')).toBe(true)
    expect(renameInput()).not.toBeNull()
    expect(inNeedsMe(renameInput())).toBe(false)
  })

  it('renames in the "Needs me" copy when only that copy is on screen', () => {
    onScreen = (element) => inNeedsMe(element)
    expect(renameFromComposer('b')).toBe(true)
    expect(inNeedsMe(renameInput())).toBe(true)
  })

  it('leaves the event alone when no row of the thread is on screen', () => {
    onScreen = () => false
    expect(renameFromComposer('b')).toBe(false)
    expect(renameInput()).toBeNull()
  })
})
