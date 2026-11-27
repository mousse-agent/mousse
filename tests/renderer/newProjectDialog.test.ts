// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project } from '../../src/shared/types'

const actions = vi.hoisted(() => ({
  createAndSelectThread: vi.fn(async () => undefined),
  createAndSelectProjectThread: vi.fn(async () => undefined),
  createAndSelectNoProjectThread: vi.fn(async () => undefined),
  listProjectAndStartThread: vi.fn(async (_project: unknown) => undefined)
}))
const remote = vi.hoisted(() => ({ openRemoteProject: vi.fn() }))
vi.mock('../../src/renderer/lib/threadActions', () => actions)
vi.mock('../../src/renderer/lib/remoteComputers', () => ({ openRemoteProject: remote.openRemoteProject, remoteErrorMessage: (_e: unknown, name: string) => `Could not reach ${name}`, remoteReason: (_e: unknown, name: string) => `Could not reach ${name}` }))
vi.mock('../../src/renderer/components/WindowCaptionButtons', () => ({ WindowCaptionButtons: () => null }))
vi.mock('../../src/renderer/components/TitleBarNav', () => ({ TitleBarNav: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { TitleBar } = await import('../../src/renderer/components/TitleBar')
const { NewProjectDialog } = await import('../../src/renderer/components/NewProjectDialog')
const { ToastHost, dismissToast } = await import('../../src/renderer/components/ui/Toast')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useComputersStore } = await import('../../src/renderer/lib/computers')
const { qualifyId } = await import('../../src/shared/threadRef')
const { useSourceControl } = await import('../../src/renderer/lib/sourceControl')

const project = (id: string, path: string, extra: Partial<Project> = {}): Project => ({ id, name: id, path, createdAt: '2026-10-01T00:00:00.000Z', order: 0, ...extra })

let host: HTMLDivElement
let root: Root
/** What the daemon answers about GitHub: the account, and its repositories when connected. */
const github: { status: Record<string, unknown>; repositories: { nameWithOwner: string; private: boolean }[] } = { status: {}, repositories: [] }
/** The GitHub account of the Mac mini, and what it answers to a clone or a folder read. */
const mac: { status: Record<string, unknown>; folders: Record<string, unknown> } = { status: {}, folders: {} }
const platform = vi.fn(async (method: string, params?: { node?: string; path?: string }): Promise<unknown> => {
  const there = params?.node === 'nod_mac'
  if (method === 'sourceControl.status') return { providers: [there ? mac.status : github.status] }
  if (method === 'sourceControl.repositories') return { repositories: there ? [] : github.repositories, fetchedAt: Date.now() }
  if (method === 'sourceControl.connect' && there) {
    mac.status = { ...mac.status, operation: { id: 'op1', phase: 'code', code: 'AB12-CD34', url: 'https://github.com/login/device' } }
    return mac.status
  }
  if (method === 'sourceControl.clone' && there) {
    return { project: project('p9', '/Users/me/dev/web-app') }
  }
  if (method === 'folders.browse' && there) return mac.folders[params?.path ?? '']
  throw new Error(`unexpected ${method}`)
})
const api = {
  open: vi.fn(async (_target?: unknown): Promise<Project | null> => null),
  chooseFolder: vi.fn(async (): Promise<string | null> => null),
  cloneRepository: vi.fn(async (_input: unknown): Promise<{ project: { id: string; name: string; path: string } }> => ({ project: { id: 'web-app', name: 'web-app', path: 'C:\\dev\\web-app' } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, {
    mousse: {
      app: { setAttentionCount: vi.fn(async () => undefined) },
      projects: { open: api.open, chooseFolder: api.chooseFolder },
      github: { cloneRepository: api.cloneRepository },
      platformRequest: { request: platform }
    }
  })
  useSourceControl.setState({ computers: {} })
  github.status = { id: 'github', name: 'GitHub', state: 'signed-out' }
  mac.status = { id: 'github', name: 'GitHub', state: 'connected', account: 'me' }
  mac.folders = {}
  useComputersStore.setState({ loaded: true, byNode: {} })
  useAppStore.setState({
    sidebarMode: 'threads',
    newProjectOpen: false,
    newProjectParent: null,
    projects: [project('a', 'C:\\dev\\a'), project('b', 'C:\\dev\\b')],
    threads: []
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  act(() => dismissToast())
})

const show = async () => {
  await act(async () => root.render(createElement('div', null, createElement(TitleBar), createElement(NewProjectDialog), createElement(ToastHost))))
}
const openDialog = async () => {
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Add project"]')!.click())
}
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"][aria-label="New project"]')
const input = () => dialog()!.querySelector<HTMLInputElement>('input')!
const rowTitles = () => [...dialog()!.querySelectorAll('[role="option"] .thread-search-result-title')].map((title) => title.textContent)
const press = async (key: string) => {
  await act(async () => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}
const type = async (text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), text)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('opens from Add project; Open a folder runs the folder picker and the new project starts a thread', async () => {
  const added = project('site', 'C:\\dev\\site')
  api.open.mockResolvedValueOnce(added)
  await show()
  await openDialog()
  expect(rowTitles()).toEqual(['Open a folder…', 'Clone a repository…', 'New empty project…'])
  await press('Enter')
  expect(api.open).toHaveBeenCalledWith()
  expect(actions.listProjectAndStartThread).toHaveBeenCalledWith(added)
  expect(dialog()).toBeNull()
})

it('clones a pasted GitHub URL into the folder most projects are in, then starts a thread there', async () => {
  await show()
  await openDialog()
  await type('https://github.com/acme/web-app')
  expect(rowTitles()[0]).toBe('Clone acme/web-app')
  expect(dialog()!.textContent).toContain('into C:\\dev\\web-app')
  await press('Enter')
  expect(api.cloneRepository).toHaveBeenCalledWith({ repository: 'acme/web-app', destination: 'C:\\dev\\web-app' })
  expect(actions.listProjectAndStartThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'web-app', path: 'C:\\dev\\web-app' }))
})

it('makes a new empty project, asking where it goes when no folder is known, and remembers the folder', async () => {
  useAppStore.setState({ projects: [] })
  api.chooseFolder.mockResolvedValueOnce('D:\\work')
  api.open.mockResolvedValueOnce(project('notes', 'D:\\work\\notes'))
  await show()
  await openDialog()
  await type('notes')
  expect(rowTitles()).toEqual(['New empty project “notes”'])
  await press('Enter')
  expect(api.chooseFolder).toHaveBeenCalled()
  expect(api.open).toHaveBeenCalledWith({ path: 'D:\\work\\notes', create: true })
  expect(useAppStore.getState().newProjectParent).toBe('D:\\work')
})

it('adds a typed folder, and shows a failure in the dialog, which stays open', async () => {
  api.open.mockRejectedValueOnce(new Error('That folder already has files in it. Open it as a project instead.'))
  await show()
  await openDialog()
  await type('C:\\work\\api')
  expect(rowTitles()).toEqual(['Add C:\\work\\api'])
  await press('Enter')
  expect(api.open).toHaveBeenCalledWith({ path: 'C:\\work\\api' })
  expect(dialog()!.querySelector('[role="alert"]')!.textContent).toContain('already has files')
  expect(actions.listProjectAndStartThread).not.toHaveBeenCalled()
})

it('keeps a clone going after Esc, then offers a thread in a toast', async () => {
  let finish!: (value: { project: { id: string; name: string; path: string } }) => void
  api.cloneRepository.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await show()
  await openDialog()
  await type('acme/web-app')
  await press('Enter')
  expect(dialog()!.querySelector('[role="status"]')!.textContent).toContain('Cloning acme/web-app…')
  // The field keeps the keyboard while it clones, so Esc reaches the dialog from where the focus is.
  expect(input().disabled).toBe(false)
  expect(document.activeElement).toBe(input())
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
  expect(dialog()).toBeNull()
  await act(async () => finish({ project: { id: 'web-app', name: 'web-app', path: 'C:\\dev\\web-app' } }))
  expect(actions.listProjectAndStartThread).not.toHaveBeenCalled()
  // Toasts draw in their own layer on the page.
  expect(document.body.textContent).toContain('web-app')
  expect(document.body.textContent).toContain('Project ready')
  await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'New thread')!.click())
  expect(actions.listProjectAndStartThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'web-app' }))
})

it('on another computer, offers its project folders and adds a typed path there', async () => {
  useComputersStore.setState({ loaded: true, byNode: { nod_mac: { node: 'nod_mac', name: 'Mac mini', online: true } } })
  useAppStore.setState({ projects: [project('a', 'C:\\dev\\a'), project('api', '/Users/me/dev/api', { node: 'nod_mac' })] })
  remote.openRemoteProject.mockResolvedValueOnce({ ok: true, project: project('p9', '/Users/me/dev/site') })
  await show()
  await openDialog()
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Computer"]')!.click())
  const mac = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => !dialog()!.contains(option) && option.textContent?.includes('Mac mini'))!
  await act(async () => mac.click())
  expect(input().placeholder).toContain('Mac mini')
  expect(rowTitles()).toEqual(['Add a folder on Mac mini…', 'Clone a repository…', '/Users/me/dev/'])
  await press('ArrowDown')
  await press('ArrowDown')
  await press('Tab')
  expect(input().value).toBe('/Users/me/dev/')
  await type('/Users/me/dev/site')
  await press('Enter')
  expect(remote.openRemoteProject).toHaveBeenCalledWith('nod_mac', '/Users/me/dev/site')
  expect(actions.listProjectAndStartThread).toHaveBeenCalledWith(expect.objectContaining({ id: qualifyId('nod_mac', 'p9'), node: 'nod_mac' }))
})

it('opens a project that is already where a new one would go, instead of offering to make it', async () => {
  useAppStore.setState({ projects: [project('a', 'C:\\dev\\a'), project('notes', 'C:\\dev\\notes')] })
  await show()
  await openDialog()
  await type('notes')
  expect(rowTitles()).toEqual(['Open “notes”'])
  await press('Enter')
  expect(api.open).not.toHaveBeenCalled()
  expect(actions.listProjectAndStartThread).toHaveBeenCalledWith(expect.objectContaining({ id: 'notes' }))
})

it('keeps the field focused after a failure, so typing goes on', async () => {
  api.open.mockRejectedValueOnce(new Error('That folder already has files in it. Open it as a project instead.'))
  await show()
  await openDialog()
  await type('fresh')
  await press('Enter')
  expect(dialog()!.querySelector('[role="alert"]')).not.toBeNull()
  expect(document.activeElement).toBe(input())
})


const clickRow = async (title: string) => {
  const row = [...dialog()!.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((option) => option.querySelector('.thread-search-result-title')?.textContent === title)!
  await act(async () => row.click())
}

it("lists the signed-in account's repositories under Clone a repository, filters them as you type, and clones the one picked", async () => {
  github.status = { id: 'github', name: 'GitHub', state: 'connected', account: 'me' }
  github.repositories = [
    { nameWithOwner: 'me/notes', private: true },
    { nameWithOwner: 'acme/web-app', private: false },
    { nameWithOwner: 'acme/api', private: false }
  ]
  await show()
  await openDialog()
  await clickRow('Clone a repository…')
  expect(rowTitles().slice(0, 3)).toEqual(['me/notes', 'acme/web-app', 'acme/api'])
  await type('web')
  expect(rowTitles()).toContain('acme/web-app')
  expect(rowTitles()).not.toContain('me/notes')
  await clickRow('acme/web-app')
  expect(api.cloneRepository).toHaveBeenCalledWith({ repository: 'acme/web-app', destination: 'C:\\dev\\web-app' })
})

it('offers to connect GitHub under Clone a repository when it is not connected, in Settings → Source control', async () => {
  await show()
  await openDialog()
  await clickRow('Clone a repository…')
  expect(rowTitles()[0]).toBe('Connect GitHub…')
  await clickRow('Connect GitHub…')
  expect(dialog()).toBeNull()
  expect(useAppStore.getState().settingsOpen).toBe(true)
})

const pickMac = async () => {
  useComputersStore.setState({ loaded: true, byNode: { nod_mac: { node: 'nod_mac', name: 'Mac mini', online: true } } })
  await show()
  await openDialog()
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Computer"]')!.click())
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => !dialog()!.contains(entry) && entry.textContent?.includes('Mac mini'))!
  await act(async () => option.click())
}

it("clones on another computer into its projects folder, with that computer's GitHub, and adds the project there", async () => {
  useAppStore.setState({ projects: [project('a', 'C:\\dev\\a'), project('nod_mac:api', '/Users/me/dev/api', { node: 'nod_mac' })] })
  await pickMac()
  await type('acme/web-app')
  expect(rowTitles()).toEqual(['Clone acme/web-app'])
  expect(dialog()!.textContent).toMatch(/into (~|\/Users\/me)\/dev\/web-app/)
  await press('Enter')
  expect(platform).toHaveBeenCalledWith('sourceControl.clone', { node: 'nod_mac', provider: 'github', repository: 'acme/web-app', path: '/Users/me/dev/web-app' })
  expect(api.cloneRepository).not.toHaveBeenCalled()
  expect(actions.listProjectAndStartThread).toHaveBeenCalledWith(expect.objectContaining({ id: qualifyId('nod_mac', 'p9'), node: 'nod_mac' }))
})

it('connects GitHub on the other computer from here, showing the one-time code it relays', async () => {
  mac.status = { id: 'github', name: 'GitHub', state: 'missing', install: { via: 'brew', automatic: true, command: 'brew install gh', url: 'https://github.com/cli/cli#installation' } }
  await pickMac()
  await type('acme/web-app')
  expect(rowTitles()).toEqual(['Clone acme/web-app', 'Connect GitHub on Mac mini…'])
  expect(dialog()!.textContent).toContain('brew install gh')
  await press('Enter')
  expect(platform).toHaveBeenCalledWith('sourceControl.connect', { node: 'nod_mac', provider: 'github' })
  expect(platform).not.toHaveBeenCalledWith('sourceControl.clone', expect.anything())
  expect(dialog()!.querySelector('[aria-label="One-time code"]')!.textContent).toBe('AB12-CD34')
})

it('adds a folder of another computer with no projects yet, picked by browsing its folders, and starts a thread there', async () => {
  mac.folders = {
    '': { path: null, parent: null, folders: [{ name: 'Home', path: '/Users/me' }] },
    '/Users/me': { path: '/Users/me', parent: '/Users', folders: [{ name: 'dev', path: '/Users/me/dev' }] },
    '/Users/me/dev': { path: '/Users/me/dev', parent: '/Users/me', folders: [{ name: 'site', path: '/Users/me/dev/site' }] },
    '/Users/me/dev/site': { path: '/Users/me/dev/site', parent: '/Users/me/dev', folders: [] }
  }
  remote.openRemoteProject.mockResolvedValueOnce({ ok: true, project: project('p9', '/Users/me/dev/site') })
  await pickMac()
  expect(rowTitles()).toEqual(['Add a folder on Mac mini…', 'Clone a repository…'])
  await press('Enter')
  // That computer's folders, from its places: the system's folder picker here is never opened.
  expect(platform).toHaveBeenCalledWith('folders.browse', { node: 'nod_mac' })
  expect(api.open).not.toHaveBeenCalled()
  await clickRow('Home')
  await clickRow('dev')
  await clickRow('site')
  expect(rowTitles()[0]).toBe('Add this folder')
  await clickRow('Add this folder')
  expect(remote.openRemoteProject).toHaveBeenCalledWith('nod_mac', '/Users/me/dev/site')
  expect(actions.listProjectAndStartThread).toHaveBeenCalledWith(expect.objectContaining({ id: qualifyId('nod_mac', 'p9'), node: 'nod_mac' }))
})

it('ends browsing when another computer is picked, so a folder listed by one is never added on another', async () => {
  mac.folders = { '': { path: '/Users/me', parent: null, folders: [] } }
  await pickMac()
  await press('Enter')
  expect(rowTitles()[0]).toBe('Add this folder')
  await act(async () => dialog()!.querySelector<HTMLButtonElement>('[aria-label="Computer"]')!.click())
  const here = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => !dialog()!.contains(entry) && entry.textContent === 'This computer')!
  await act(async () => here.click())
  expect(rowTitles()).not.toContain('Add this folder')
  expect(remote.openRemoteProject).not.toHaveBeenCalled()
})

it('asks where a clone goes on the other computer by browsing its folders, never by typing a path', async () => {
  mac.folders = {
    '': { path: null, parent: null, folders: [{ name: 'Home', path: '/Users/me' }] },
    '/Users/me': { path: '/Users/me', parent: '/Users', folders: [{ name: 'dev', path: '/Users/me/dev' }, { name: 'Documents', path: '/Users/me/Documents' }] },
    '/Users/me/dev': { path: '/Users/me/dev', parent: '/Users/me', folders: [] }
  }
  await pickMac()
  await type('acme/web-app')
  expect(dialog()!.textContent).toContain('Choose where it goes first')
  await press('Enter')
  expect(platform).toHaveBeenCalledWith('folders.browse', { node: 'nod_mac' })
  await clickRow('Home')
  expect(rowTitles()).toEqual(['Use this folder', '..', 'dev', 'Documents'])
  await clickRow('dev')
  await clickRow('Use this folder')
  expect(platform).toHaveBeenCalledWith('sourceControl.clone', { node: 'nod_mac', provider: 'github', repository: 'acme/web-app', path: '/Users/me/dev/web-app' })
})
