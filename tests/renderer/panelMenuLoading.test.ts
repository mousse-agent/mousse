// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MainViewTabs } from '../../src/renderer/components/MainViewTabs'
import { OpenSurfacePicker } from '../../src/renderer/components/OpenSurfaceMenu'
import { WorkspaceLoading, WORKSPACE_SKELETON_DELAY_MS } from '../../src/renderer/components/WorkspaceLoading'
import { ProfileSwitcher } from '../../src/renderer/components/profiles/ProfileSwitcher'
import { surfaceTabItems } from '../../src/renderer/lib/surfaces'
import { RESIZER_KEY_STEP, resizerKeyTarget } from '../../src/renderer/lib/resizerKeys'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { ProjectTerminalTab } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
const initialState = useAppStore.getState()

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

const terminal = (id: string, title: string): ProjectTerminalTab => ({ id, ownerThreadId: null, ptyId: null, title, exited: false })
const text = (node: Element | null | undefined) => node?.textContent?.trim()

describe('terminal tab labels', () => {
  it('numbers plain terminals from the second and keeps quick action names', () => {
    const items = surfaceTabItems({
      opened: ['terminal'],
      // "Terminal 4" is a title older builds stored; it is renumbered by position.
      terminals: [terminal('a', 'Terminal'), terminal('b', 'npm test'), terminal('c', 'Terminal 4'), terminal('d', 'Terminal')],
      browsers: [],
      documents: []
    })
    expect(items.map((item) => item.label)).toEqual(['Terminal', 'npm test', 'Terminal 2', 'Terminal 3'])
  })

  it('reads "Terminal" when it is the only one', () => {
    const items = surfaceTabItems({ opened: ['terminal'], terminals: [terminal('a', 'Terminal 1')], browsers: [], documents: [] })
    expect(items.map((item) => item.label)).toEqual(['Terminal'])
  })

  it('gives a new terminal the plain title', () => {
    useAppStore.getState().addProjectTerminalTab(null)
    useAppStore.getState().addProjectTerminalTab(null)
    expect(useAppStore.getState().projectTerminalTabs.map((tab) => tab.title)).toEqual(['Terminal', 'Terminal'])
  })
})

describe('resizer keys', () => {
  it('moves 16px with Left and Right and stops at the bounds', () => {
    expect(RESIZER_KEY_STEP).toBe(16)
    expect(resizerKeyTarget('ArrowLeft', 260, 180, 480)).toBe(244)
    expect(resizerKeyTarget('ArrowRight', 260, 180, 480)).toBe(276)
    expect(resizerKeyTarget('ArrowLeft', 190, 180, 480)).toBe(180)
    expect(resizerKeyTarget('ArrowRight', 470, 180, 480)).toBe(480)
  })

  it('jumps to the minimum and maximum with Home and End and ignores other keys', () => {
    expect(resizerKeyTarget('Home', 260, 180, 480)).toBe(180)
    expect(resizerKeyTarget('End', 260, 180, 480)).toBe(480)
    expect(resizerKeyTarget('ArrowUp', 260, 180, 480)).toBeUndefined()
    expect(resizerKeyTarget('Enter', 260, 180, 480)).toBeUndefined()
  })
})

describe('the "+" panel menu', () => {
  const openPanels = () => useAppStore.setState({
    activeThreadId: null,
    openedSurfaceKinds: ['browser', 'git', 'terminal'],
    projectTerminalTabs: [terminal('t1', 'Terminal')],
    browserTabs: [{ id: 'b1', ownerThreadId: null, url: 'about:blank', title: 'New tab', zoomFactor: 1, deviceToolbarOpen: false, devicePreset: 'responsive' }],
    mainView: 'browser',
    mainAreaOpen: true,
    documentsTabVisible: false
  })
  const addButton = () => host.querySelector<HTMLButtonElement>('.main-view-tab-add')!
  const menu = () => document.querySelector<HTMLElement>('.surface-menu-popover')
  const rows = () => [...menu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
  const row = (label: string) => rows().find((item) => text(item.querySelector('.surface-menu-row-label')) === label)!
  const press = (key: string) => act(() => {
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
  const render = () => {
    openPanels()
    act(() => root.render(createElement(MainViewTabs)))
    act(() => addButton().click())
  }

  it('is labelled "Add panel" and opens a keyboard menu on its first row', () => {
    render()
    expect(addButton().getAttribute('aria-label')).toBe('Add panel')
    expect(addButton().title).toBe('Add panel')
    expect(addButton().getAttribute('aria-haspopup')).toBe('menu')
    expect(menu()!.getAttribute('role')).toBe('menu')
    expect(menu()!.getAttribute('aria-label')).toBe('Add panel')
    expect(rows()).toHaveLength(5)
    expect(document.activeElement).toBe(rows()[0])
    press('ArrowDown')
    expect(document.activeElement).toBe(rows()[1])
    press('End')
    expect(document.activeElement).toBe(rows()[4])
    press('Escape')
    expect(menu()).toBeNull()
    expect(document.activeElement).toBe(addButton())
  })

  it('marks open panels "Open", reads "New terminal", and shows no shortcut hints', () => {
    render()
    expect(rows().map((item) => text(item.querySelector('.surface-menu-row-label')))).toEqual(['Browser', 'New terminal', 'Files', 'Changes', 'Pull request'])
    expect(rows().map((item) => text(item.querySelector('.surface-menu-state')) ?? null)).toEqual(['Open', null, null, 'Open', null])
    expect(menu()!.querySelector('kbd')).toBeNull()
  })

  it('focuses the tab of an open panel instead of adding one', async () => {
    render()
    await act(async () => { row('Changes').click() })
    const state = useAppStore.getState()
    expect(state.mainView).toBe('git')
    expect(state.openedSurfaceKinds).toEqual(['browser', 'git', 'terminal'])
    expect(menu()).toBeNull()
    act(() => addButton().click())
    await act(async () => { row('Browser').click() })
    expect(useAppStore.getState().mainView).toBe('browser')
    expect(useAppStore.getState().browserTabs).toHaveLength(1)
  })

  it('adds another terminal from "New terminal"', () => {
    render()
    act(() => row('New terminal').click())
    expect(useAppStore.getState().projectTerminalTabs).toHaveLength(2)
    expect([...host.querySelectorAll('.main-view-tab-label')].map(text)).toEqual(['Browser', 'Changes', 'Terminal', 'Terminal 2'])
  })

  it('closes a tab on middle-click', () => {
    render()
    const diff = [...host.querySelectorAll('.main-view-tab')].find((tab) => text(tab.querySelector('.main-view-tab-label')) === 'Changes')!
    act(() => { diff.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true })) })
    expect(useAppStore.getState().openedSurfaceKinds).toEqual(['browser', 'terminal'])
  })
})

describe('the empty app panel', () => {
  it('says "Add a panel" above a plain list that keeps its shortcut hints', () => {
    act(() => root.render(createElement(OpenSurfacePicker)))
    expect(text(host.querySelector('.surface-picker > .surface-picker-title'))).toBe('Add a panel')
    expect(host.querySelector('.surface-picker-title + .surface-menu-list')).not.toBeNull()
    expect(host.querySelector('[role="menuitem"]')).toBeNull()
    expect(host.querySelectorAll('.surface-menu-row')).toHaveLength(5)
    expect(text(host.querySelectorAll('.surface-menu-row')[1]?.querySelector('.surface-menu-row-label'))).toBe('Terminal')
    expect(host.querySelectorAll('kbd').length).toBeGreaterThan(0)
  })
})

describe('workspace loading', () => {
  it('shows no text, and the skeleton only once loading takes longer than 160ms', () => {
    vi.useFakeTimers()
    act(() => root.render(createElement(WorkspaceLoading, { sidebarWidth: 260 })))
    const loading = host.querySelector('[data-workspace-loading="connection"]')!
    expect(loading.getAttribute('aria-busy')).toBe('true')
    expect(loading.textContent).toBe('')
    expect(host.querySelector('.workspace-loading-sidebar')).toBeNull()
    expect(host.querySelector('.workspace-loading-composer')).toBeNull()
    act(() => { vi.advanceTimersByTime(WORKSPACE_SKELETON_DELAY_MS - 1) })
    expect(host.querySelector('.workspace-loading-composer')).toBeNull()
    act(() => { vi.advanceTimersByTime(1) })
    expect(WORKSPACE_SKELETON_DELAY_MS).toBe(160)
    expect(host.querySelector('.workspace-loading-sidebar')).not.toBeNull()
    expect(host.querySelector('.workspace-loading-composer')).not.toBeNull()
    expect(loading.textContent).toBe('')
  })

  it('shows a failure at once as one error block with Retry', () => {
    const onRetry = vi.fn()
    act(() => root.render(createElement(WorkspaceLoading, { conversationOnly: true, error: 'Service unavailable', onRetry })))
    const alert = host.querySelector('[data-workspace-loading="content"] [role="alert"]')!
    expect(text(alert.querySelector('.workspace-loading-error-title'))).toBe('Could not load workspace')
    expect(text(alert.querySelector('.workspace-loading-detail'))).toBe('Service unavailable')
    expect(host.querySelector('[aria-busy="true"]')).toBeNull()
    const retry = alert.querySelector<HTMLButtonElement>('button')!
    expect(text(retry)).toBe('Retry')
    act(() => retry.click())
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('the profile footer', () => {
  const profile = { id: 'prf_alpha', displayName: 'A very long profile name that does not fit', status: 'active', isDefault: true, revision: 1, color: '#4d6088' }

  beforeEach(() => {
    useAppStore.setState({ profileId: 'prf_alpha' })
    ;(window as unknown as { mousse: unknown }).mousse = {
      profiles: {
        list: async () => ({ profiles: [profile], defaultProfileId: 'prf_alpha' }),
        status: async () => ({ binding: { profileId: 'prf_alpha' } })
      }
    }
  })

  afterEach(() => {
    delete (window as unknown as { mousse?: unknown }).mousse
  })

  it('shows one line without a Mousse ID, and the row "…" says "Profile options"', async () => {
    await act(async () => root.render(createElement(ProfileSwitcher)))
    const trigger = host.querySelector<HTMLButtonElement>('.profile-sidebar-trigger')!
    expect([...trigger.querySelectorAll('.profile-sidebar-text > *')].map(text)).toEqual([profile.displayName])
    expect(trigger.textContent).not.toContain('Mousse profile')
    await act(async () => trigger.click())
    expect(document.querySelector<HTMLButtonElement>('.profile-menu-kebab')!.title).toBe('Profile options')
  })
})

describe('archiving the profile in use', () => {
  const alpha = { id: 'prf_alpha', displayName: 'Work', status: 'active', isDefault: false, revision: 1, color: '#4d6088' }
  const beta = { id: 'prf_beta', displayName: 'Personal', status: 'active', isDefault: true, revision: 1, color: '#6a4d88' }
  let finishArchive: () => void
  let bind: ReturnType<typeof vi.fn>

  beforeEach(() => {
    useAppStore.setState({ profileId: 'prf_alpha' })
    bind = vi.fn(async (ref: string) => ({ profile: ref === beta.id ? beta : alpha }))
    ;(window as unknown as { mousse: unknown }).mousse = {
      profiles: {
        list: async () => ({ profiles: [alpha, beta], defaultProfileId: 'prf_beta' }),
        status: async () => ({ binding: { profileId: 'prf_alpha' } }),
        bind,
        archive: () => new Promise<void>((resolve) => { finishArchive = resolve })
      }
    }
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  afterEach(() => {
    delete (window as unknown as { mousse?: unknown }).mousse
    vi.restoreAllMocks()
  })

  it('keeps the profile rows disabled until the archive is done, after moving to the default profile', async () => {
    await act(async () => root.render(createElement(ProfileSwitcher)))
    const trigger = host.querySelector<HTMLButtonElement>('.profile-sidebar-trigger')!
    await act(async () => trigger.click())
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Work profile actions"]')!.click())
    const archive = [...document.querySelectorAll<HTMLButtonElement>('.profile-row-menu button')].find((button) => button.textContent?.includes('Archive'))!
    await act(async () => archive.click())
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(bind).toHaveBeenCalledWith('prf_beta')

    // The window moved to the default profile; the archive itself is still running.
    if (!document.querySelector('.profile-menu-profile')) await act(async () => trigger.click())
    const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.profile-menu-profile')]
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().every((row) => row.disabled)).toBe(true)

    await act(async () => { finishArchive(); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(rows().every((row) => !row.disabled)).toBe(true)
  })
})

