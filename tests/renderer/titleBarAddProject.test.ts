// @vitest-environment jsdom
/**
 * Add project sits in the title bar, between the sidebar toggle and New thread. It opens New project, whose Open a
 * folder adds the folder as a project, lists it at once, opens its group in the sidebar and starts a thread in it. The
 * Chats tab has no projects, so it has no Add project.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../../src/renderer/services/navigationGuards', () => ({ confirmNavigation: vi.fn(async () => true) }))
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/TitleBarNav', () => ({ TitleBarNav: () => null }))

const { TitleBar } = await import('../../src/renderer/components/TitleBar')
const { NewProjectDialog } = await import('../../src/renderer/components/NewProjectDialog')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useSidebarRevealStore } = await import('../../src/renderer/lib/sidebarReveal')

const at = '2026-11-18T10:00:00.000Z'
const added: Project = { id: 'p2', name: 'smiletrack', path: '/p/smiletrack', createdAt: at, order: 1 }
const made: Thread = { id: 't-new', name: 'New thread', createdAt: at, updatedAt: at, order: 0, projectId: 'p2' }
const projectsApi = { open: vi.fn(async (): Promise<Project | null> => added) }
const threadsApi = { create: vi.fn(async () => made), select: vi.fn(async () => undefined) }

function preload(): unknown {
  const call = (name: string) => (name.startsWith('on') ? () => () => {} : async () => undefined)
  const group = (known: Record<string, unknown> = {}) => new Proxy(known, { get: (target, key: string) => target[key] ?? call(key) })
  return new Proxy({ projects: group(projectsApi), threads: group(threadsApi) } as Record<string, unknown>, {
    get: (target, key: string) => target[key] ?? group()
  })
}

const keys = ['projects', 'threads', 'activeThreadId', 'sidebarMode', 'threadsSidebarOpen', 'threadsSidebarView', 'newProjectOpen'] as const
const initial = Object.fromEntries(keys.map((key) => [key, useAppStore.getInitialState()[key]]))

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(window as unknown as { mousse: unknown }).mousse = preload()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  useAppStore.setState({
    projects: [{ id: 'p1', name: 'mousse', path: '/p/mousse', createdAt: at, order: 0 }],
    threads: [],
    activeThreadId: null,
    sidebarMode: 'projects',
    threadsSidebarOpen: true,
    threadsSidebarView: 'threads'
  })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initial)
  useSidebarRevealStore.setState({ project: null })
  vi.clearAllMocks()
})

const render = () => act(() => root.render(createElement('div', null, createElement(TitleBar), createElement(NewProjectDialog))))
const startActions = () => [...host.querySelectorAll('.titlebar-start-actions button')].map((button) => button.getAttribute('aria-label'))
const addProject = () => host.querySelector<HTMLButtonElement>('header button[aria-label="Add project"]')
const dialog = () => host.querySelector('[role="dialog"][aria-label="New project"]')
/** Add project, then New project's Open a folder. */
const openFolder = async () => {
  await act(async () => addProject()!.click())
  const row = [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes('Open a folder'))!
  await act(async () => row.click())
}

describe('Add project in the title bar', () => {
  it('sits between the sidebar toggle and New thread, with its name as the tooltip', () => {
    render()
    expect(startActions()).toEqual(['Hide sidebar', 'Add project', 'New thread'])
    expect(addProject()!.title).toMatch(/^Add project/)
  })

  it('opens New project, whose Open a folder adds the project, lists it at once, opens its group in the sidebar and starts a thread in it', async () => {
    render()
    await act(async () => addProject()!.click())
    expect(dialog()).not.toBeNull()
    expect(projectsApi.open).not.toHaveBeenCalled()
    await act(async () => [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.textContent?.includes('Open a folder'))!.click())
    expect(projectsApi.open).toHaveBeenCalledTimes(1)
    expect(dialog()).toBeNull()
    const state = useAppStore.getState()
    expect(state.projects.map((project) => project.id)).toEqual(['p1', 'p2'])
    expect(state.threadsSidebarView).toBe('projects')
    expect(useSidebarRevealStore.getState().project?.projectId).toBe('p2')
    expect(threadsApi.create).toHaveBeenCalledWith(undefined, 'p2', { rememberedChoices: true })
    expect(state.activeThreadId).toBe('t-new')
  })

  it('adds nothing when the folder picker is cancelled, and New project stays open', async () => {
    projectsApi.open.mockResolvedValueOnce(null)
    render()
    await openFolder()
    expect(useAppStore.getState().projects.map((project) => project.id)).toEqual(['p1'])
    expect(threadsApi.create).not.toHaveBeenCalled()
    expect(dialog()).not.toBeNull()
  })

  it('is not offered in the Chats tab', () => {
    useAppStore.setState({ sidebarMode: 'chats' })
    render()
    expect(startActions()).toEqual(['Hide sidebar', 'New chat'])
  })
})
