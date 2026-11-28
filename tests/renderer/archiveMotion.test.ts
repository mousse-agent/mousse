// @vitest-environment jsdom
/**
 * A thread archived or unarchived from anywhere (here: its update simply arrives, as from a bot, another device or
 * the menu) moves with motion in the sidebar: its old row stays in its old list while it fades and closes, and a row
 * opens in its new place, only when that place is on screen. With reduced motion the row moves at once. jsdom has no
 * layout, so this checks which rows exist and that each is animated; how the motion looks is in the PR's recording.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useSidebarOpenStore } from '../../src/renderer/lib/sidebarOpen'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const at = (minute: number) => `2026-11-15T10:${String(minute).padStart(2, '0')}:00.000Z`
const thread = (id: string, minute: number, over: Partial<Thread> = {}): Thread =>
  ({ id, name: `Thread ${id}`, projectId: 'p', createdAt: at(minute), updatedAt: at(minute), startedAt: at(minute), order: 0, ...over }) as Thread
const project: Project = { id: 'p', name: 'p', path: '/repo/p', createdAt: at(0) } as Project

const original = Object.fromEntries((['projects', 'threads', 'activeThreadId', 'threadsSidebarView'] as const).map((key) => [key, useAppStore.getState()[key]]))
const originalMatchMedia = window.matchMedia
const originalAnimate = Element.prototype.animate
const originalGetAnimations = Element.prototype.getAnimations

let host: HTMLDivElement
let root: Root
let reduced: boolean
let animated: { element: Element; keyframes: Keyframe[] }[]

beforeEach(() => {
  reduced = false
  animated = []
  window.matchMedia = ((query: string) => ({ matches: reduced && query.includes('reduce'), media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
  Element.prototype.animate = function (this: Element, keyframes: Keyframe[]) {
    animated.push({ element: this, keyframes })
    return { finished: Promise.resolve(), cancel() {} } as unknown as Animation
  } as typeof Element.prototype.animate
  Element.prototype.getAnimations = () => []
  ;(window as unknown as { mousse: object }).mousse = {
    threads: { archive: vi.fn(async () => undefined), select: vi.fn(async () => undefined), pin: vi.fn(async () => undefined) },
    editors: { list: vi.fn(async () => []) },
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  useAppStore.setState({ projects: [project], threads: [thread('a1', 1), thread('a2', 2), thread('old', 0, { archivedAt: at(3) })], activeThreadId: 'a1', threadsSidebarView: 'projects' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  useSidebarOpenStore.setState({ groups: new Set(), archived: false })
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(original)
  window.matchMedia = originalMatchMedia
  Element.prototype.animate = originalAnimate
  Element.prototype.getAnimations = originalGetAnimations
})

const archivedSection = () => host.querySelector<HTMLElement>('section[aria-label="Archived"]')!
/** The rows of a thread, by where they sit: under Archived, or in the project's list. */
const rowsOf = (threadId: string) => {
  const rows = [...host.querySelectorAll<HTMLElement>(`[data-thread-id="${threadId}"]`)]
    .map((button) => button.closest<HTMLElement>('.threads-sidebar-thread-container')!)
  return { archived: rows.filter((row) => archivedSection().contains(row)), listed: rows.filter((row) => !archivedSection().contains(row)) }
}
const wasAnimated = (row: HTMLElement | undefined) => animated.some((entry) => entry.element === row)
const setArchivedHere = async (threadId: string, archived: boolean) => {
  await act(async () => {
    useAppStore.setState({ threads: useAppStore.getState().threads.map((t) => (t.id === threadId ? { ...t, archivedAt: archived ? at(30) : undefined } : t)) })
  })
}
const mount = async ({ archivedOpen }: { archivedOpen: boolean }) => {
  await act(async () => root.render(createElement(ThreadsSidebar)))
  if (archivedOpen) {
    const heading = archivedSection().querySelector<HTMLButtonElement>('button[aria-expanded]')!
    await act(async () => { heading.click() })
  }
}
const afterTheMove = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)) })

describe('archiving moves the row with motion', () => {
  it('keeps the old row closing in the project while the row opens under an open Archived, then drops the old one', async () => {
    await mount({ archivedOpen: true })
    await setArchivedHere('a2', true)

    const during = rowsOf('a2')
    expect(during.listed).toHaveLength(1)
    expect(during.listed[0]!.hasAttribute('inert')).toBe(true)
    expect(wasAnimated(during.listed[0])).toBe(true)
    expect(during.archived).toHaveLength(1)
    expect(wasAnimated(during.archived[0])).toBe(true)

    await afterTheMove()
    const after = rowsOf('a2')
    expect(after.listed).toHaveLength(0)
    expect(after.archived).toHaveLength(1)
    expect(after.archived[0]!.hasAttribute('inert')).toBe(false)
  })

  it('with Archived closed, only the old row moves and the count changes at once', async () => {
    await mount({ archivedOpen: false })
    await setArchivedHere('a2', true)

    expect(archivedSection().querySelector('.threads-sidebar-archived-count')?.textContent).toBe('2')
    expect(rowsOf('a2').archived).toHaveLength(0)
    expect(wasAnimated(rowsOf('a2').listed[0])).toBe(true)
    await afterTheMove()
    expect(rowsOf('a2').listed).toHaveLength(0)
  })

  it('unarchiving moves the row out of Archived and back into its project', async () => {
    await mount({ archivedOpen: true })
    await setArchivedHere('old', false)

    const during = rowsOf('old')
    expect(during.archived).toHaveLength(1)
    expect(during.archived[0]!.hasAttribute('inert')).toBe(true)
    expect(wasAnimated(during.archived[0])).toBe(true)
    expect(during.listed).toHaveLength(1)
    expect(wasAnimated(during.listed[0])).toBe(true)

    await afterTheMove()
    expect(rowsOf('old').archived).toHaveLength(0)
    expect(rowsOf('old').listed).toHaveLength(1)
  })

  it('undone at once, the row that was closing comes back and opens again', async () => {
    await mount({ archivedOpen: true })
    await setArchivedHere('a2', true)
    const closing = rowsOf('a2').listed[0]
    await setArchivedHere('a2', false)

    const reopened = rowsOf('a2').listed
    expect(reopened).toHaveLength(1)
    expect(reopened[0]!.hasAttribute('inert')).toBe(false)
    expect(animated.filter((entry) => entry.element === closing)).toHaveLength(2)
    await afterTheMove()
    expect(rowsOf('a2').listed).toHaveLength(1)
    expect(rowsOf('a2').archived).toHaveLength(0)
  })

  it('starts to move when Archive is clicked, before the service answers, and moves back when it fails', async () => {
    let answer!: { resolve: () => void; reject: (error: Error) => void }
    const archive = vi.fn(() => new Promise<void>((resolve, reject) => { answer = { resolve, reject } }))
    ;(window as unknown as { mousse: { threads: { archive: unknown } } }).mousse.threads.archive = archive
    await mount({ archivedOpen: true })
    const archiveButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Archive Thread a2"]')!

    await act(async () => { archiveButton().click() })
    expect(archive).toHaveBeenCalledWith('a2', true)
    // Still unanswered: the old row is already closing and the new one opening under Archived.
    expect(rowsOf('a2').listed[0]!.hasAttribute('inert')).toBe(true)
    expect(wasAnimated(rowsOf('a2').listed[0])).toBe(true)
    expect(rowsOf('a2').archived).toHaveLength(1)

    await act(async () => { answer.reject(new Error('refused')) })
    await afterTheMove()
    expect(rowsOf('a2').archived).toHaveLength(0)
    expect(rowsOf('a2').listed).toHaveLength(1)
    expect(rowsOf('a2').listed[0]!.hasAttribute('inert')).toBe(false)

    // Answered, the row stays archived while the thread's update arrives.
    await act(async () => { archiveButton().click() })
    await act(async () => { answer.resolve() })
    await setArchivedHere('a2', true)
    await afterTheMove()
    expect(rowsOf('a2').listed).toHaveLength(0)
    expect(rowsOf('a2').archived).toHaveLength(1)
  })

  it('lists the most recently archived first, and a thread a bot keeps out of the sidebar once it is archived', async () => {
    useAppStore.setState({
      threads: [
        thread('started-late', 50, { archivedAt: at(51) }),
        thread('started-early', 5, { archivedAt: at(55) }),
        thread('bot-archived', 20, { hidden: true, archivedAt: at(53) }),
        thread('bot-open', 21, { hidden: true }),
        thread('a1', 1),
      ],
    })
    await mount({ archivedOpen: true })
    const archivedIds = [...archivedSection().querySelectorAll<HTMLElement>('[data-thread-id]')].map((row) => row.dataset.threadId)
    expect(archivedIds).toEqual(['started-early', 'bot-archived', 'started-late'])
    expect(rowsOf('bot-open').listed).toHaveLength(0)
  })

  it('with reduced motion, the row moves at once and nothing animates', async () => {
    reduced = true
    await mount({ archivedOpen: true })
    animated = []
    await setArchivedHere('a2', true)

    expect(rowsOf('a2').listed).toHaveLength(0)
    expect(rowsOf('a2').archived).toHaveLength(1)
    expect(animated.filter((entry) => entry.element.closest('.threads-sidebar-thread-container'))).toHaveLength(0)
  })
})
