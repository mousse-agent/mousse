// @vitest-environment jsdom
/**
 * The Projects tab: a dragged project shows a line where it will land, and drops before a project from its
 * upper half or after it from its lower half, so it can also go last. Threads in a project do the same.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const thread = (id: string, order: number): Thread => ({
  id,
  name: `Thread ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  order,
  projectId: 'p1'
})

const appKeys = ['projects', 'threads', 'activeThreadId', 'threadsSidebarView', 'threadActivity'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getState()[key]]))

let host: HTMLDivElement
let root: Root
const reorderProjects = vi.fn(async (_ids: string[]) => undefined)
const reorderThreads = vi.fn(async (_projectId: string, _ids: string[]) => undefined)

beforeEach(async () => {
  reorderProjects.mockClear()
  reorderThreads.mockClear()
  ;(window as unknown as { mousse: object }).mousse = {
    editors: { list: async () => [], open: async () => undefined },
    projects: { reorder: reorderProjects },
    threads: { reorder: reorderThreads }
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  useAppStore.setState({
    projects: ['p1', 'p2', 'p3'].map((id, order) => ({ id, name: id, path: `/p/${id}`, createdAt: '2026-01-01T00:00:00.000Z', order })),
    threads: [thread('a', 0), thread('b', 1), thread('c', 2)],
    activeThreadId: 'a',
    threadsSidebarView: 'projects',
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

const project = (id: string) => host.querySelector<HTMLElement>(`.threads-sidebar-project[data-project-id="${id}"]`)!
const threadRow = (id: string) => host.querySelector<HTMLElement>(`.threads-sidebar-project [data-thread-id="${id}"]`)!
const lines = () => [...host.querySelectorAll('.drop-before, .drop-after')]

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
describe('dragging projects and their threads', () => {
  it('shows a line before or after the project it would land next to, and clears it when the drag ends', () => {
    fire(project('p1'), 'dragstart')
    fire(project('p3'), 'dragover', 0)
    expect(project('p3').classList.contains('drop-before')).toBe(true)
    fire(project('p3'), 'dragover', 1)
    expect(project('p3').classList.contains('drop-after')).toBe(true)
    expect(lines()).toHaveLength(1)
    // Over itself it cannot land, so no line promises a place.
    fire(project('p1'), 'dragover', 0)
    expect(lines()).toHaveLength(0)
    fire(project('p1'), 'dragend')
    expect(lines()).toHaveLength(0)
  })

  it('drops a project before another from its upper half, and after the last one from its lower half', () => {
    fire(project('p3'), 'dragstart')
    fire(project('p2'), 'drop', 0)
    expect(reorderProjects).toHaveBeenLastCalledWith(['p1', 'p3', 'p2'])
    expect(lines()).toHaveLength(0)
    fire(project('p1'), 'dragstart')
    fire(project('p3'), 'drop', 1)
    expect(reorderProjects).toHaveBeenLastCalledWith(['p2', 'p3', 'p1'])
  })

  it('shows a line between threads of a project and drops a thread after the last one', () => {
    fire(threadRow('a'), 'dragstart')
    fire(threadRow('c'), 'dragover', 1)
    expect(threadRow('c').closest('.threads-sidebar-thread-container')?.classList.contains('drop-after')).toBe(true)
    fire(threadRow('c'), 'drop', 1)
    expect(reorderThreads).toHaveBeenLastCalledWith('p1', ['b', 'c', 'a'])
    expect(lines()).toHaveLength(0)
  })
})
