// @vitest-environment jsdom
/**
 * The Threads tab: rows of any project can be dragged before or after another row, or below the last one,
 * and the list keeps that order. Threads started since go on top.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'


;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const thread = (id: string, day: number, projectId?: string): Thread => ({
  id,
  name: `Thread ${id}`,
  createdAt: `2026-01-0${day}T00:00:00.000Z`,
  updatedAt: `2026-01-0${day}T00:00:00.000Z`,
  startedAt: `2026-01-0${day}T00:00:00.000Z`,
  order: 0,
  ...(projectId ? { projectId } : {})
})

const appKeys = ['projects', 'threads', 'activeThreadId', 'threadsSidebarView', 'threadFeedOrder', 'threadActivity'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getState()[key]]))

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  // The sidebar's other parts ask the main process for things these tests do not need.
  ;(window as unknown as { mousse: object }).mousse = {}
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  useAppStore.setState({
    projects: [
      { id: 'p1', name: 'One', path: '/p/one', createdAt: '2026-01-01T00:00:00.000Z', order: 0 },
      { id: 'p2', name: 'Two', path: '/p/two', createdAt: '2026-01-01T00:00:00.000Z', order: 1 }
    ],
    // Newest first: d, c, b, a.
    threads: [thread('a', 1, 'p1'), thread('b', 2, 'p2'), thread('c', 3), thread('d', 4, 'p1')],
    activeThreadId: null,
    threadsSidebarView: 'threads',
    threadFeedOrder: [],
    threadActivity: {}
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
})

// The reorderable list, not the "Needs me" group above it, which shares the feed's look.
const feed = () => host.querySelector<HTMLElement>('.threads-sidebar-feed-list')!
const row = (id: string) => feed().querySelector<HTMLElement>(`[data-thread-id="${id}"]`)!
const shown = () => [...feed().querySelectorAll<HTMLElement>('[data-thread-id]')].map((element) => element.dataset.threadId)

/** jsdom has no DragEvent; React reads `dataTransfer` and `clientY` off the native event. */
function fire(target: Element, type: string, clientY = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY })
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: () => undefined, getData: () => '', effectAllowed: 'all', dropEffect: 'move', types: [] }
  })
  act(() => { target.dispatchEvent(event) })
  return event
}

// Rows measure 0 px in jsdom, so clientY 0 is a row's upper half and 1 its lower half.
function drag(id: string, onto: Element, clientY: number) {
  fire(row(id), 'dragstart')
  const over = fire(onto, 'dragover', clientY)
  fire(onto, 'drop', clientY)
  fire(row(id), 'dragend')
  return over
}

describe('dragging rows in the Threads tab', () => {
  it('lists the newest started thread first', () => {
    expect(shown()).toEqual(['d', 'c', 'b', 'a'])
  })

  it('drops a row before another one of a different project', () => {
    const over = drag('a', row('c'), 0)
    expect(over.defaultPrevented).toBe(true)
    expect(shown()).toEqual(['d', 'a', 'c', 'b'])
    expect(useAppStore.getState().threadFeedOrder).toEqual(['d', 'a', 'c', 'b'])
  })

  it('drops a row after another, including the last one', () => {
    drag('d', row('a'), 1)
    expect(shown()).toEqual(['c', 'b', 'a', 'd'])
  })

  it('drops a row below the last one at the end', () => {
    drag('c', feed(), 1)
    expect(shown()).toEqual(['d', 'b', 'a', 'c'])
  })

  it('shows where the row will land while it is dragged over', () => {
    fire(row('a'), 'dragstart')
    fire(row('c'), 'dragover', 0)
    expect(row('c').closest('.threads-sidebar-thread-container')?.classList.contains('drop-before')).toBe(true)
    fire(row('a'), 'dragend')
    expect(host.querySelector('.drop-before, .drop-after')).toBeNull()
  })

  it('still reorders with "Needs me" above the list, and its copies are neither dragged nor dropped on', () => {
    act(() => useAppStore.setState({ threadActivity: { b: 'awaiting_input' } }))
    const copy = host.querySelector<HTMLElement>('.threads-sidebar-needs-me [data-thread-id="b"]')!
    expect(copy).not.toBeNull()
    expect(copy.getAttribute('draggable')).toBe('false')
    drag('a', row('c'), 0)
    expect(shown()).toEqual(['d', 'a', 'c', 'b'])
    fire(row('d'), 'dragstart')
    expect(fire(copy, 'dragover', 0).defaultPrevented).toBe(false)
    expect(copy.closest('.threads-sidebar-thread-container')?.className).not.toMatch(/drop-(before|after)/)
    fire(row('d'), 'dragend')
  })

  it('keeps the dragged order when a later message arrives, and puts a newly started thread on top', () => {
    drag('a', row('d'), 0)
    expect(shown()).toEqual(['a', 'd', 'c', 'b'])
    act(() => {
      const { threads } = useAppStore.getState()
      useAppStore.setState({
        threads: [...threads.map((entry) => entry.id === 'b' ? { ...entry, updatedAt: '2026-02-01T00:00:00.000Z', order: -9 } : entry), thread('e', 5, 'p2')]
      })
    })
    expect(shown()).toEqual(['e', 'a', 'd', 'c', 'b'])
  })
})
