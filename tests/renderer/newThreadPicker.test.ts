// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project, Thread } from '../../src/shared/types'

const actions = vi.hoisted(() => ({
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async (_projectId: string) => undefined),
  createAndSelectNoProjectThread: vi.fn(async () => undefined),
}))
vi.mock('../../src/renderer/lib/threadActions', () => actions)
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/TitleBarNav', () => ({ TitleBarNav: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TitleBar } = await import('../../src/renderer/components/TitleBar')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useComputersStore } = await import('../../src/renderer/lib/computers')

const project = (id: string, extra: Partial<Project> = {}): Project => ({
  id,
  name: id,
  path: `C:\\dev\\${id}`,
  createdAt: '2026-10-01T00:00:00.000Z',
  order: 0,
  ...extra
})
const thread = (id: string, projectId: string, updatedAt: string) =>
  ({ id, name: id, projectId, createdAt: updatedAt, updatedAt, startedAt: updatedAt, order: 0 }) as unknown as Thread

let host: HTMLDivElement
let root: Root
const pin = vi.fn(async (projectId: string) => project(projectId))

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { mousse: { app: { setAttentionCount: vi.fn(async () => undefined) }, projects: { pin } } })
  useComputersStore.setState({ loaded: true, byNode: { mac: { node: 'mac', name: 'Mac mini', online: true } } })
  useAppStore.setState({
    sidebarMode: 'threads',
    threadsSidebarOpen: true,
    projects: [project('web'), project('api', { node: 'mac', path: '/Users/me/api' }), project('docs')],
    threads: [thread('t1', 'web', '2026-11-20T09:00:00.000Z'), thread('t2', 'api', '2026-11-19T09:00:00.000Z')],
    lastNewThreadProjectId: 'api',
    newThreadPicker: true
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const show = async () => { await act(async () => root.render(createElement(TitleBar))) }
const clickNewThread = async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="New thread"]')!.click())
}
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"][aria-label="New thread"]')
const input = () => dialog()!.querySelector<HTMLInputElement>('input')!
const options = () => [...dialog()!.querySelectorAll<HTMLElement>('[role="option"]')]
const optionNames = () => options().map((option) => option.querySelector('.new-thread-picker-name')!.textContent)
const highlighted = () => options().find((option) => option.getAttribute('aria-selected') === 'true')?.querySelector('.new-thread-picker-name')?.textContent
const press = async (key: string, init: KeyboardEventInit = {}) => {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('opens a picker of every computer\'s projects from New thread, newest used first, and Enter starts in the last picked one', async () => {
  await show()
  expect(dialog()).toBeNull()
  await clickNewThread()
  expect(optionNames()).toEqual(['web', 'api', 'docs'])
  const api = options()[1]!.textContent!
  expect(api).toContain('Mac mini')
  // A home folder shows as ~; the tooltip keeps the full path.
  expect(options()[1]!.querySelector('[title="/Users/me/api"]')!.textContent).toBe('~/api')
  expect(options()[2]!.textContent).toContain('This computer')
  expect(highlighted()).toBe('api')
  await press('Enter')
  expect(actions.createAndSelectProjectThread).toHaveBeenCalledWith('api')
  expect(actions.createAndSelectThread).not.toHaveBeenCalled()
  expect(dialog()).toBeNull()
})

it('moves through the cards with the arrows and starts the one clicked', async () => {
  await show()
  await clickNewThread()
  await press('ArrowRight')
  expect(highlighted()).toBe('docs')
  await press('ArrowLeft')
  await press('ArrowLeft')
  expect(highlighted()).toBe('web')
  await act(async () => options()[2]!.click())
  expect(actions.createAndSelectProjectThread).toHaveBeenCalledWith('docs')
})

it('stars a project with its star or Ctrl+D, and lists starred projects first', async () => {
  useAppStore.setState({ projects: [project('web'), project('api', { node: 'mac' }), project('docs', { pinnedAt: '2026-11-01T00:00:00.000Z' })] })
  await show()
  await clickNewThread()
  expect(optionNames()).toEqual(['docs', 'web', 'api'])
  expect(dialog()!.querySelector('[role="group"][aria-label="Starred"]')!.textContent).toContain('docs')
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('button[aria-label="Star web"]')!.click())
  expect(pin).toHaveBeenLastCalledWith('web', true)
  expect(actions.createAndSelectProjectThread).not.toHaveBeenCalled()
  await press('d', { ctrlKey: true })
  expect(pin).toHaveBeenLastCalledWith('api', true)
  await press('ArrowUp')
  expect(highlighted()).toBe('docs')
  await press('d', { ctrlKey: true })
  expect(pin).toHaveBeenLastCalledWith('docs', false)
})

it('filters by name, computer or folder as you type', async () => {
  await show()
  await clickNewThread()
  await type('mac')
  expect(optionNames()).toEqual(['api'])
  await type('c:\\dev\\do')
  expect(optionNames()).toEqual(['docs'])
  await press('Enter')
  expect(actions.createAndSelectProjectThread).toHaveBeenCalledWith('docs')
})

it('does not start a thread on an offline computer\'s project', async () => {
  useAppStore.setState({ projects: [project('api', { node: 'mac', offline: true })], threads: [] })
  await show()
  await clickNewThread()
  expect(options()[0]!.textContent).toContain('Offline')
  await press('Enter')
  await act(async () => options()[0]!.click())
  expect(actions.createAndSelectProjectThread).not.toHaveBeenCalled()
  expect(dialog()).not.toBeNull()
})

it('starts without a project, adds a project, or closes on Escape', async () => {
  await show()
  await clickNewThread()
  await act(async () => [...dialog()!.querySelectorAll('button')].find((button) => button.textContent === 'No project')!.click())
  expect(actions.createAndSelectNoProjectThread).toHaveBeenCalled()
  expect(dialog()).toBeNull()
  await clickNewThread()
  await act(async () => [...dialog()!.querySelectorAll('button')].find((button) => button.textContent === 'Add project')!.click())
  // Add project closes the picker and opens New project.
  expect(dialog()).toBeNull()
  expect(useAppStore.getState().newProjectOpen).toBe(true)
  await act(async () => useAppStore.setState({ newProjectOpen: false }))
  await clickNewThread()
  await press('Escape')
  expect(dialog()).toBeNull()
  expect(actions.createAndSelectProjectThread).not.toHaveBeenCalled()
})

it('starts a thread at once when there is no project to pick', async () => {
  useAppStore.setState({ projects: [], threads: [] })
  await show()
  await clickNewThread()
  expect(dialog()).toBeNull()
  expect(actions.createAndSelectThread).toHaveBeenCalled()
})

it('starts a thread at once when the picker is turned off in Settings', async () => {
  useAppStore.setState({ newThreadPicker: false })
  await show()
  await clickNewThread()
  expect(dialog()).toBeNull()
  expect(actions.createAndSelectThread).toHaveBeenCalled()
})
