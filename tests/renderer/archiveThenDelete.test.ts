// @vitest-environment jsdom
/**
 * Thread → Archive → Delete in the sidebar: a thread in use offers Archive and no Delete; an archived thread offers
 * Unarchive and Delete; Archived has Clear all. Every delete asks first, names what goes, and is for good.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThreadsContextMenu, type ThreadsContextMenuTarget } from '../../src/renderer/components/ThreadsContextMenu'
import { ThreadsSidebar } from '../../src/renderer/components/ThreadsSidebar'
import { clearAllRequest, deleteDialogCopy, deleteThreads } from '../../src/renderer/lib/archivedThreads'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LAPTOP = 'nod_laptop'
vi.mock('../../src/renderer/lib/computers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/lib/computers')>()),
  useComputers: () => ({ loaded: true, routed: true, byNode: { [LAPTOP]: { node: LAPTOP, name: 'Laptop', online: true } }, devices: [] })
}))

const at = '2026-10-25T10:00:00.000Z'
const thread = (id: string, over: Partial<Thread> = {}): Thread => ({ id, name: `Thread ${id}`, createdAt: at, updatedAt: at, startedAt: at, order: 0, ...over })

const appKeys = ['projects', 'threads', 'activeThreadId', 'threadsSidebarView', 'threadFeedOrder'] as const
const appOriginal = Object.fromEntries(appKeys.map((key) => [key, useAppStore.getState()[key]]))

let host: HTMLDivElement
let root: Root
let deleted: string[]
let refuse: Record<string, string>

const render = async (element: ReturnType<typeof createElement>) => { await act(async () => root.render(element)) }
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('button')]
const byLabel = (label: string) => buttons().find((button) => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label)
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')
const click = async (element: HTMLElement | undefined | null) => {
  if (!element) throw new Error('nothing to click')
  await act(async () => { element.click() })
}

beforeEach(() => {
  deleted = []
  refuse = {}
  ;(window as unknown as { mousse: object }).mousse = {
    threads: {
      delete: vi.fn(async (threadId: string) => {
        if (refuse[threadId]) throw { code: 'thread_delete_blocked', message: refuse[threadId] }
        deleted.push(threadId)
      }),
      settle: vi.fn(async () => undefined),
      pin: vi.fn(async () => undefined)
    }
  }
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(appOriginal)
})

describe('the thread menu', () => {
  const menu = (target: Partial<ThreadsContextMenuTarget>, onRemove = vi.fn()) => render(createElement(ThreadsContextMenu, {
    x: 0, y: 0, target: { type: 'thread', id: 't', name: 'Fix login', pinned: false, ...target },
    onClose: () => undefined, onPin: () => undefined, onArchive: () => undefined, onRegenerateTitle: () => undefined, onRename: () => undefined, onRemove
  }))
  const items = () => [...document.querySelectorAll<HTMLButtonElement>('.threads-context-menu button')].map((button) => button.textContent?.trim())

  it('offers Archive and no Delete for a thread that is not archived', async () => {
    await menu({ settled: false })
    expect(items()).toContain('Archive')
    expect(items().some((item) => /delete|remove/i.test(item ?? ''))).toBe(false)
  })

  it('offers Unarchive and Delete for an archived thread', async () => {
    const onRemove = vi.fn()
    await menu({ settled: true }, onRemove)
    expect(items()).toEqual(expect.arrayContaining(['Unarchive', 'Delete…']))
    expect(items()).not.toContain('Settle')
    await click(buttons().find((button) => button.textContent?.trim() === 'Delete…'))
    expect(onRemove).toHaveBeenCalledTimes(1)
  })

  it('leaves the delete of an archived thread on another computer to that computer', async () => {
    await menu({ settled: true, node: LAPTOP, computerName: 'Laptop' })
    const remove = buttons().find((button) => button.textContent?.trim() === 'Delete…')!
    expect(remove.disabled).toBe(true)
    expect(remove.title).toBe('Delete on Laptop')
  })
})

describe('the Archived section', () => {
  beforeEach(async () => {
    useAppStore.setState({
      projects: [],
      threads: [
        thread('live', { name: 'In use' }),
        thread('old1', { name: 'Old one', settledAt: at }),
        thread('old2', { name: 'Old two', settledAt: at }),
        thread(`${LAPTOP}:far`, { name: 'Far away', settledAt: at, node: LAPTOP })
      ],
      activeThreadId: null,
      threadsSidebarView: 'threads',
      threadFeedOrder: []
    })
    await render(createElement(ThreadsSidebar))
  })

  const row = (id: string) => host.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`)?.closest<HTMLElement>('.threads-sidebar-thread-container')
  const open = async () => {
    const toggle = host.querySelector<HTMLButtonElement>('.threads-sidebar-section-settled .threads-sidebar-heading-toggle')
    if (toggle?.getAttribute('aria-expanded') === 'false') await click(toggle)
  }

  it('is called Archived, and a thread in use has no Delete', async () => {
    expect(host.textContent).toContain('Archived')
    expect(host.textContent).not.toContain('Settled')
    expect(host.textContent).not.toContain('Recently deleted')
    expect(row('live')?.querySelector('[data-action="delete"]')).toBeNull()
    expect(byLabel('Archive In use')).toBeTruthy()
  })

  it('asks before deleting an archived thread, names it and its subagent threads, and deletes it for good', async () => {
    await open()
    const remove = row('old1')!.querySelector<HTMLButtonElement>('[data-action="delete"]')!
    expect(remove.getAttribute('aria-label')).toBe('Delete Old one…')
    await click(remove)
    expect(dialog()?.textContent).toContain('Delete “Old one”?')
    expect(dialog()?.textContent).toContain('subagent threads for good')
    // Focus is in the dialog, never on Delete: a stray Enter deletes nothing.
    expect(dialog()?.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('archived-delete-confirm')
    expect(deleted).toEqual([])
    await click(document.querySelector<HTMLElement>('[data-testid="archived-delete-confirm"]'))
    expect(deleted).toEqual(['old1'])
    expect(dialog()).toBeNull()
  })

  it('deletes nothing when the confirmation is cancelled', async () => {
    await open()
    await click(row('old2')!.querySelector<HTMLButtonElement>('[data-action="delete"]'))
    await act(async () => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    expect(dialog()).toBeNull()
    expect(deleted).toEqual([])
  })

  it('leaves an archived thread of another computer to that computer', async () => {
    await open()
    const remove = row(`${LAPTOP}:far`)!.querySelector<HTMLButtonElement>('[data-action="delete"]')!
    expect(remove.disabled).toBe(true)
    expect(remove.title).toBe('Delete on Laptop')
  })

  it('clears all archived threads of this computer after a confirmation that names how many', async () => {
    const clear = host.querySelector<HTMLButtonElement>('[data-testid="archived-clear-all"]')!
    expect(clear.textContent).toBe('Clear all')
    expect(clear.getAttribute('aria-label')).toBe('Delete all archived threads…')
    await click(clear)
    expect(dialog()?.textContent).toContain('Delete 2 archived threads?')
    expect(dialog()?.textContent).toContain('Threads on other computers stay.')
    expect(deleted).toEqual([])
    await click(document.querySelector<HTMLElement>('[data-testid="archived-delete-confirm"]'))
    expect(deleted).toEqual(['old1', 'old2'])
    expect(dialog()).toBeNull()
  })

  it('keeps the dialog open with the reason when a delete is refused, holding only what is left', async () => {
    refuse.old1 = 'A run is still stopping.'
    await click(host.querySelector<HTMLButtonElement>('[data-testid="archived-clear-all"]'))
    await click(document.querySelector<HTMLElement>('[data-testid="archived-delete-confirm"]'))
    expect(deleted).toEqual(['old2'])
    const alert = document.querySelector('[data-testid="archived-delete-error"]')
    expect(alert?.getAttribute('role')).toBe('alert')
    expect(alert?.textContent).toBe('“Old one” was not deleted: A run is still stopping.')
    expect(dialog()?.textContent).toContain('Delete 1 archived thread?')
  })
})

describe('the words and the loop', () => {
  it('names one thread, or how many, and says the subagent threads go too', () => {
    expect(deleteDialogCopy({ kind: 'one', thread: { id: 'a', name: 'Fix login' } })).toEqual({
      title: 'Delete “Fix login”?',
      body: 'Deletes it and its subagent threads for good, with their worktrees and unpublished changes. This can’t be undone.',
      confirm: 'Delete'
    })
    const all = deleteDialogCopy(clearAllRequest([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C', node: LAPTOP }]))
    expect(all.title).toBe('Delete 2 archived threads?')
    expect(all.confirm).toBe('Delete 2')
    expect(all.body).toContain('Threads on other computers stay.')
  })

  it('goes on after a failure and says which thread stayed', async () => {
    const remove = vi.fn(async (id: string) => { if (id === 'b') throw new Error('busy') })
    const result = await deleteThreads([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }], remove)
    expect(remove).toHaveBeenCalledTimes(3)
    expect(result).toEqual({ deleted: ['a', 'c'], error: '“B” was not deleted: busy' })
  })
})
