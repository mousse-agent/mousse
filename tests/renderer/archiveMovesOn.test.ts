// @vitest-environment jsdom
/**
 * Archiving the thread open in the pane opens the next thread in its project (or the one before it when it was the
 * last), from the sidebar's menu and from the Archive shortcut. Archiving any other thread leaves the pane alone.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { archiveOpenThread } from '../../src/renderer/lib/threadActions'
import { threadAfterArchive } from '../../src/renderer/lib/threadOrder'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = (minute: number) => `2026-11-13T10:${String(minute).padStart(2, '0')}:00.000Z`
const thread = (id: string, projectId: string | undefined, minute: number, over: Partial<Thread> = {}): Thread =>
  ({ id, name: `Thread ${id}`, projectId, createdAt: at(minute), updatedAt: at(minute), startedAt: at(minute), order: 0, ...over }) as Thread
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id, path: `/repo/${id}`, createdAt: at(0), ...over }) as Project

describe('the thread opened after an archive', () => {
  const projects = [project('p'), project('q')]
  // In the sidebar's order: a1, a2, a3 in p; b1 in q; o1 without a project.
  const threads = [
    thread('a1', 'p', 1), thread('a2', 'p', 2), thread('a3', 'p', 3),
    thread('b1', 'q', 4), thread('o1', undefined, 5), thread('gone', 'p', 6, { settledAt: at(7) })
  ]
  it.each([
    ['the next one in its project', 'a1', 'a2'],
    ['the one after it in the middle', 'a2', 'a3'],
    ['the one before it when it was the last', 'a3', 'a2'],
    ['nothing when it was its project\'s only thread', 'b1', null],
    ['a thread without a project, among those without one', 'o1', null],
  ] as const)('%s', (_name, threadId, expected) => {
    expect(threadAfterArchive({ projects, threads, threadId })).toBe(expected)
  })
})

let host: HTMLDivElement
let root: Root
let select: ReturnType<typeof vi.fn>
let settle: ReturnType<typeof vi.fn>
const original = Object.fromEntries((['projects', 'threads', 'activeThreadId', 'threadsSidebarView'] as const).map((key) => [key, useAppStore.getState()[key]]))

beforeEach(() => {
  select = vi.fn(async () => undefined)
  settle = vi.fn(async (threadId: string, archived: boolean) => {
    useAppStore.setState({ threads: useAppStore.getState().threads.map((t) => (t.id === threadId ? { ...t, settledAt: archived ? at(30) : undefined } : t)) })
  })
  ;(window as unknown as { mousse: object }).mousse = {
    threads: { settle, select, pin: vi.fn(async () => undefined), delete: vi.fn(async () => undefined) },
    editors: { list: vi.fn(async () => []) },
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  useAppStore.setState({
    projects: [project('p')],
    threads: [thread('a1', 'p', 1), thread('a2', 'p', 2), thread('a3', 'p', 3)],
    activeThreadId: 'a2',
    threadsSidebarView: 'projects',
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(original)
})

const archiveFromMenu = async (threadId: string) => {
  await act(async () => root.render(createElement(ThreadsSidebar)))
  const row = host.querySelector<HTMLElement>(`[data-thread-id="${threadId}"]`)!
  await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })) })
  const archive = [...document.querySelectorAll<HTMLButtonElement>('.threads-context-menu button')].find((button) => button.textContent?.trim() === 'Archive')!
  await act(async () => { archive.click() })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

describe('archiving from the sidebar', () => {
  it('opens the next thread in the project when the archived one was open', async () => {
    await archiveFromMenu('a2')
    expect(settle).toHaveBeenCalledWith('a2', true)
    expect(select).toHaveBeenCalledWith('a3')
  })

  it('leaves the pane on its thread when another one is archived', async () => {
    await archiveFromMenu('a1')
    expect(settle).toHaveBeenCalledWith('a1', true)
    expect(select).not.toHaveBeenCalled()
  })
})

describe('the Archive shortcut', () => {
  it('archives the open thread and opens the next one in its project', async () => {
    await act(async () => { await archiveOpenThread() })
    expect(settle).toHaveBeenCalledWith('a2', true)
    expect(select).toHaveBeenCalledWith('a3')
  })
})
