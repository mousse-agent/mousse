// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerProjectPicker, ComposerThreadSettings, workspaceChoiceLabel, workspaceWithBranch, workspaceWithMode, type ComposerDeviceProps } from '../../src/renderer/components/ComposerWorkspaceToolbar'
import type { Device } from '../../src/renderer/lib/netDevices'
import type { ComposerWorkspace } from '../../src/renderer/lib/newThread'
import type { NodeId } from '../../src/shared/net'
import type { Project } from '../../src/shared/types'
import { useGitStatusStore } from '../../src/renderer/stores/gitStatusStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const project: Project = { id: 'p1', name: 'acme-web', path: '/work/acme-web', createdAt: '2026-11-01T00:00:00Z', order: 0 }

function computer(node: string, name: string, self = false): Device {
  return { node: node as NodeId, name, caps: [], keyEpoch: 1, expiresAt: 0, kind: 'computer', self, revoked: false, state: 'open' }
}

function deviceProps(devices: Device[]): ComposerDeviceProps {
  return {
    localName: 'Studio Mac',
    devices,
    onRefresh: () => {},
    onSelect: () => {},
    onOpenRemoteProject: async () => undefined
  }
}

function renderSettings(workspace: ComposerWorkspace, device?: ComposerDeviceProps, extra: { onPrivateChange?: (localOnly: boolean) => void } = {}) {
  const onChange = vi.fn()
  act(() => root.render(createElement(ComposerThreadSettings, { workspace, disabled: false, device, onChange, ...extra })))
  return { onChange }
}

function renderPicker(workspace: ComposerWorkspace) {
  const onChange = vi.fn()
  act(() => root.render(createElement(ComposerProjectPicker, {
    projects: [project],
    workspace,
    disabled: false,
    onChange,
    onOpenProject: async () => {},
    onError: () => {}
  })))
  return { onChange }
}

const workspaceButton = () => host.querySelector<HTMLButtonElement>('button[aria-label^="Where to work"]')
const workspaceItem = (worktree: boolean) =>
  document.querySelector<HTMLButtonElement>(`[role="dialog"][aria-label="Where to work"] [role="radio"][data-worktree="${worktree}"]`)!
const branchOption = (name: string) =>
  document.querySelector<HTMLButtonElement>(`[role="dialog"][aria-label="Where to work"] [role="option"][data-branch="${name}"]`)
const computerButton = () => host.querySelector<HTMLButtonElement>('[aria-label="Run on"]')

describe('new thread project picker', () => {
  it('reads the project, or "No project"', () => {
    renderPicker({ worktreeEnabled: false })
    expect(host.querySelector('[aria-label="Project"]')!.textContent).toBe('No project')
    renderPicker({ projectId: 'p1', worktreeEnabled: false })
    expect(host.querySelector('[aria-label="Project"]')!.textContent).toBe('acme-web')
  })

  it('ends the project menu with "Add project"', () => {
    renderPicker({ projectId: 'p1', worktreeEnabled: false })
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Project"]')!.click())
    const add = document.querySelector('[role="menu"][aria-label="Select project"] [data-project-id="__open_project__"]')
    expect(add!.textContent).toBe('Add project')
  })
})

describe('Add project on another computer', () => {
  it('browses that computer’s folders and adds the one picked there', async () => {
    const browse = vi.fn(async (_method: string, params: { node?: string; path?: string }) => {
      if (!params.path) return { path: null, parent: null, folders: [{ name: 'Home', path: '/home/me' }] }
      if (params.path === '/home/me') return { path: '/home/me', parent: '/home', folders: [{ name: 'code', path: '/home/me/code' }] }
      return { path: params.path, parent: '/home/me', folders: [] }
    })
    ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request: browse } }
    const onOpenRemoteProject = vi.fn(async (_path: string): Promise<string | undefined> => undefined)
    const device = { ...deviceProps([computer('n-self', 'Studio Mac', true), computer('n-mini', 'Mac mini')]), onOpenRemoteProject }
    act(() => root.render(createElement(ComposerProjectPicker, {
      projects: [],
      workspace: { node: 'n-mini' as NodeId, worktreeEnabled: false },
      disabled: false,
      device,
      onChange: vi.fn(),
      onOpenProject: async () => {},
      onError: () => {}
    })))
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Project"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-project-id="__open_project__"]')!.click())
    const folders = () => document.querySelector<HTMLElement>('[aria-label="Folders on Mac mini"]')!
    const folder = (name: string) => [...folders().querySelectorAll('button')].find((button) => button.textContent === name)!
    expect(browse).toHaveBeenCalledWith('folders.browse', { node: 'n-mini' })
    await act(async () => folder('Home').click())
    await act(async () => folder('code').click())
    expect(browse).toHaveBeenLastCalledWith('folders.browse', { node: 'n-mini', path: '/home/me/code' })
    // The folder browsed to is the one added: nothing was typed.
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder path on Mac mini"]')!.value).toBe('/home/me/code')
    const add = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Add')!
    await act(async () => add.click())
    expect(onOpenRemoteProject).toHaveBeenCalledWith('/home/me/code')
  })

  it('holds Add while a folder loads, and a folder that fails keeps the one shown before', async () => {
    let release: (value: unknown) => void = () => {}
    const browse = vi.fn(async (_method: string, params: { node?: string; path?: string }) => {
      if (!params.path) return { path: '/home/me', parent: '/home', folders: [{ name: 'code', path: '/home/me/code' }, { name: 'locked', path: '/home/me/locked' }] }
      if (params.path === '/home/me/locked') throw Object.assign(new Error('That folder cannot be read.'), { code: 'forbidden' })
      return new Promise((resolve) => { release = resolve })
    })
    ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request: browse } }
    const onOpenRemoteProject = vi.fn(async (_path: string): Promise<string | undefined> => undefined)
    const device = { ...deviceProps([computer('n-self', 'Studio Mac', true), computer('n-mini', 'Mac mini')]), onOpenRemoteProject }
    act(() => root.render(createElement(ComposerProjectPicker, {
      projects: [],
      workspace: { node: 'n-mini' as NodeId, worktreeEnabled: false },
      disabled: false,
      device,
      onChange: vi.fn(),
      onOpenProject: async () => {},
      onError: () => {}
    })))
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Project"]')!.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-project-id="__open_project__"]')!.click())
    const folder = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Folders on Mac mini"] button')].find((button) => button.textContent === name)!
    const add = () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Add')!
    await act(async () => folder('locked').click())
    expect(document.body.textContent).toContain('That folder cannot be read.')
    expect(folder('code')).toBeDefined()
    await act(async () => folder('code').click())
    // Still on /home/me until /home/me/code arrives: Add would add the folder shown before.
    expect(add().disabled).toBe(true)
    await act(async () => release({ path: '/home/me/code', parent: '/home/me', folders: [] }))
    expect(add().disabled).toBe(false)
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Folder path on Mac mini"]')!.value).toBe('/home/me/code')
  })
})

type GitMock = Record<'status' | 'log' | 'branches' | 'diffStats', ReturnType<typeof vi.fn>>

/** The project folder's Git as the daemon answers it; a repository on `master` unless told otherwise. */
function mockGit(options: { isRepo?: boolean; status?: () => Promise<unknown>; branches?: () => Promise<unknown> } = {}): GitMock {
  const git: GitMock = {
    status: vi.fn(options.status ?? (async () => ({ isRepo: options.isRepo ?? true, branch: 'master' }))),
    log: vi.fn(async () => []),
    branches: vi.fn(options.branches ?? (async () => ({ current: 'master', branches: ['master', 'feat/x', 'mousse/old-thread', 'remotes/origin/master'] }))),
    diffStats: vi.fn(async () => ({ additions: 0, deletions: 0, filesChanged: 0 }))
  }
  ;(window as unknown as { mousse: unknown }).mousse = { git }
  return git
}

/** Renders the row and lets the shared Git read settle. */
async function renderSettled(workspace: ComposerWorkspace) {
  const rendered = renderSettings(workspace)
  await act(async () => {})
  return rendered
}

describe('new thread settings row', () => {
  beforeEach(() => {
    useGitStatusStore.setState({ entries: {} })
    mockGit()
  })
  afterEach(() => {
    delete (window as unknown as { mousse?: unknown }).mousse
  })

  it('offers the checkout or a worktree only once a project is picked', async () => {
    await renderSettled({ worktreeEnabled: false })
    expect(workspaceButton()).toBeNull()
    const { onChange } = await renderSettled({ projectId: 'p1', worktreeEnabled: false })
    expect(workspaceButton()!.textContent).toBe('master')
    await act(async () => workspaceButton()!.click())
    expect(workspaceItem(false).getAttribute('aria-checked')).toBe('true')
    expect(workspaceItem(true).getAttribute('aria-checked')).toBe('false')
    act(() => workspaceItem(true).click())
    expect(onChange).toHaveBeenCalledWith({ projectId: 'p1', worktreeEnabled: true, worktreePicked: true })
  })

  it('goes back to the current checkout from a worktree', async () => {
    const { onChange } = await renderSettled({ projectId: 'p1', worktreeEnabled: true })
    expect(workspaceButton()!.textContent).toBe('master (new)')
    await act(async () => workspaceButton()!.click())
    act(() => workspaceItem(false).click())
    expect(onChange).toHaveBeenCalledWith({ projectId: 'p1', worktreeEnabled: false, worktreePicked: true })
  })

  it('labels the button with the branch: the checkout branch, or the worktree base marked (new)', () => {
    expect(workspaceChoiceLabel(false, 'master')).toBe('master')
    expect(workspaceChoiceLabel(true, 'master')).toBe('master (new)')
    expect(workspaceChoiceLabel(true, 'master', 'feat/x')).toBe('feat/x (new)')
    // A detached checkout, never the mode's name.
    expect(workspaceChoiceLabel(false, null)).toBe('HEAD')
    expect(workspaceChoiceLabel(true, null)).toBe('HEAD (new)')
  })

  it('hides the branch menu for a folder without Git, and the thread works in the folder itself', async () => {
    mockGit({ isRepo: false })
    const { onChange } = await renderSettled({ projectId: 'p1', worktreeEnabled: true, baseBranch: 'feat/x' })
    expect(workspaceButton()).toBeNull()
    expect(onChange).toHaveBeenCalledWith({ projectId: 'p1', worktreeEnabled: false, worktreePicked: true })
    // The row keeps the computer on the left and Private / Archive after on the right, with nothing between.
    expect(host.querySelector('.new-thread-row-start')!.children).toHaveLength(1)
  })

  it('keeps the branch menu hidden while the folder is still being read, instead of flashing it', async () => {
    let answer!: (value: unknown) => void
    mockGit({ status: () => new Promise((resolve) => { answer = resolve }) })
    const { onChange } = await renderSettled({ projectId: 'p1', worktreeEnabled: true })
    expect(workspaceButton()).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    await act(async () => answer({ isRepo: true, branch: 'master' }))
    expect(workspaceButton()!.textContent).toBe('master (new)')
  })

  it('holds the branch name\'s place with a muted bar, not "Current checkout", until the branches are read', async () => {
    mockGit({ branches: async () => { throw new Error('busy') } })
    await renderSettled({ projectId: 'p1', worktreeEnabled: false })
    expect(workspaceButton()!.querySelector('.new-thread-branch-placeholder')).not.toBeNull()
    expect(workspaceButton()!.textContent).toBe('')
  })

  it('reads the project\'s Git through the shared store, not once per render', async () => {
    const git = mockGit()
    await renderSettled({ projectId: 'p1', worktreeEnabled: false })
    await renderSettled({ projectId: 'p1', worktreeEnabled: true })
    expect(git.status).toHaveBeenCalledTimes(1)
  })

  it('starts a worktree from another branch, and keeps the checkout on its own branch', () => {
    const checkout = { projectId: 'p1', worktreeEnabled: false }
    // Another branch can only be a worktree's start: the folder never switches branch for a thread.
    expect(workspaceWithBranch(checkout, 'feat/x', 'master')).toEqual({ projectId: 'p1', worktreeEnabled: true, baseBranch: 'feat/x' })
    // The folder's own branch is sent as nothing, so a daemon without the field does the same.
    expect(workspaceWithBranch({ ...checkout, worktreeEnabled: true, baseBranch: 'feat/x' }, 'master', 'master')).toEqual({ projectId: 'p1', worktreeEnabled: true })
    expect(workspaceWithBranch(checkout, 'master', 'master')).toEqual(checkout)
    // A mode chosen here is the person's pick, which a send remembers for the project.
    expect(workspaceWithMode({ projectId: 'p1', worktreeEnabled: true, baseBranch: 'feat/x' }, false)).toEqual({ ...checkout, worktreePicked: true })
    expect(workspaceWithMode({ projectId: 'p1', worktreeEnabled: true, baseBranch: 'feat/x' }, true)).toEqual({ projectId: 'p1', worktreeEnabled: true, worktreePicked: true, baseBranch: 'feat/x' })
  })

  it('lists the branches above the modes; a branch pick keeps the menu open, a mode pick closes it', async () => {
    const { onChange } = await renderSettled({ projectId: 'p1', worktreeEnabled: false })
    expect(workspaceButton()!.textContent).toBe('master')
    await act(async () => workspaceButton()!.click())
    expect(branchOption('master')!.getAttribute('aria-selected')).toBe('true')
    // Thread worktree branches and remote-tracking ones are left out.
    expect(branchOption('mousse/old-thread')).toBeNull()
    expect(branchOption('remotes/origin/master')).toBeNull()
    act(() => branchOption('feat/x')!.click())
    expect(onChange).toHaveBeenLastCalledWith({ projectId: 'p1', worktreeEnabled: true, baseBranch: 'feat/x' })
    expect(document.querySelector('[role="dialog"][aria-label="Where to work"]')).not.toBeNull()
    act(() => workspaceItem(true).click())
    expect(document.querySelector('[role="dialog"][aria-label="Where to work"]')).toBeNull()
  })

  it('turns Private on with a pressed incognito toggle', () => {
    const onPrivateChange = vi.fn()
    renderSettings({ worktreeEnabled: false }, undefined, { onPrivateChange })
    const toggle = host.querySelector<HTMLButtonElement>('button[aria-label="Make private"]')!
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    act(() => toggle.click())
    expect(onPrivateChange).toHaveBeenCalledWith(true)
    renderSettings({ worktreeEnabled: false, localOnly: true }, undefined, { onPrivateChange })
    expect(host.querySelector('button[aria-label="Make private"]')!.getAttribute('aria-pressed')).toBe('true')
  })

  it('reads "This computer", not a menu, when there is no other one to pick', () => {
    for (const device of [undefined, deviceProps([computer('n-self', 'Studio Mac', true)])]) {
      renderSettings({ projectId: 'p1', worktreeEnabled: false }, device)
      const item = host.querySelector<HTMLElement>('[aria-label="Runs on this computer"]')!
      expect(item.textContent).toBe('This computer')
      expect(item.tagName).not.toBe('BUTTON')
      expect(item.querySelector('button')).toBeNull()
      expect(item.querySelector('svg')).not.toBeNull()
      expect(computerButton()).toBeNull()
    }
  })

  it('offers the computer when another one is connected', () => {
    renderSettings({ projectId: 'p1', worktreeEnabled: false }, deviceProps([computer('n-self', 'Studio Mac', true), computer('n-linux', 'Build Linux')]))
    expect(computerButton()!.textContent).toBe('Studio Mac')
    expect(computerButton()!.getAttribute('aria-haspopup')).toBe('menu')
    expect(host.querySelector('[aria-label="Runs on this computer"]')).toBeNull()
  })

  it('with a project, lists only the computers that have it, then Add to machine', () => {
    const onAddToMachine = vi.fn()
    const devices = [computer('n-self', 'Studio Mac', true), computer('n-linux', 'Build Linux'), computer('n-mini', 'Mac mini')]
    renderSettings({ projectId: 'p1', worktreeEnabled: false }, { ...deviceProps(devices), projectComputers: new Set(['n-linux']), onAddToMachine })
    act(() => computerButton()!.click())
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Run on"] button')]
    expect(items.map((item) => item.textContent)).toEqual(['Studio Mac', 'Build Linux', 'Add to machine'])
    act(() => items[2]!.click())
    expect(onAddToMachine).toHaveBeenCalledTimes(1)
  })

  it('offers Add to machine even when no other computer has the project yet', () => {
    const devices = [computer('n-self', 'Studio Mac', true), computer('n-mini', 'Mac mini')]
    renderSettings({ projectId: 'p1', worktreeEnabled: false }, { ...deviceProps(devices), projectComputers: new Set(), onAddToMachine: () => {} })
    act(() => computerButton()!.click())
    expect([...document.querySelectorAll('[role="menu"][aria-label="Run on"] button')].map((item) => item.textContent)).toEqual(['Studio Mac', 'Add to machine'])
  })
})
