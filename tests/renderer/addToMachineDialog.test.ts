// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Project } from '../../src/shared/types'
import type { Device } from '../../src/renderer/lib/netDevices'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { AddToMachineDialog } = await import('../../src/renderer/components/AddToMachineDialog')
const { useSourceControl } = await import('../../src/renderer/lib/sourceControl')
const { qualifyId } = await import('../../src/shared/threadRef')

const project = (id: string, path: string, extra: Partial<Project> = {}): Project => ({ id, name: id.split(':').pop()!, path, createdAt: '2026-10-01T00:00:00.000Z', order: 0, ...extra })
const device = (node: string, name: string, extra: Partial<Device> = {}): Device =>
  ({ node, name, caps: [], keyEpoch: 1, expiresAt: 0, self: false, revoked: false, state: 'open', kind: 'computer', ...extra }) as Device

const MAC = 'nod_mac'
/** Where browsing the Mac mini starts: its home folder and its disk. */
const places = { path: null, parent: null, folders: [{ name: 'Home', path: '/Users/me' }, { name: 'Macintosh HD', path: '/' }] }
const home = { path: '/Users/me', parent: '/Users', folders: [{ name: 'dev', path: '/Users/me/dev' }] }
const dev = { path: '/Users/me/dev', parent: '/Users/me', folders: [{ name: 'api', path: '/Users/me/dev/api' }] }
/** What the Mac mini answers: its GitHub account, its folders, and a clone. */
const mac: { github: Record<string, unknown>; folders: Record<string, unknown>; clone: () => Promise<unknown> } = { github: {}, folders: {}, clone: async () => ({}) }
const platform = vi.fn(async (method: string, params?: { node?: string; path?: string }): Promise<unknown> => {
  if (method === 'sourceControl.projectSource') return { repository: 'acme/web-app', branch: 'feature/login' }
  if (params?.node !== MAC) throw new Error(`unexpected ${method} here`)
  if (method === 'sourceControl.status') return { providers: [mac.github] }
  if (method === 'sourceControl.connect') {
    mac.github = { ...mac.github, operation: { id: 'op1', phase: 'code', code: 'AB12-CD34', url: 'https://github.com/login/device' } }
    return mac.github
  }
  if (method === 'folders.browse') {
    const view = mac.folders[params.path ?? '']
    if (!view) throw Object.assign(new Error('That folder does not exist on this computer.'), { code: 'not_found' })
    return view
  }
  if (method === 'sourceControl.clone') return await mac.clone()
  throw new Error(`unexpected ${method}`)
})

let host: HTMLDivElement
let root: Root
beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, { mousse: { platformRequest: { request: platform } } })
  useSourceControl.setState({ computers: {} })
  mac.github = { id: 'github', name: 'GitHub', state: 'connected', account: 'me' }
  mac.folders = { '': places, '/Users/me': home, '/Users/me/dev': dev }
  mac.clone = async () => ({ project: project('p9', '/Users/me/dev/web-app') })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const local = project('web-app', 'C:\\dev\\web-app')
/** The Mac mini has another project in ~/dev; the Studio already has web-app; the old laptop is offline. */
const show = async (extra: Project[] = []) => {
  const onAdded = vi.fn()
  const onClose = vi.fn()
  const projects = [local, project(`${MAC}:api`, '/Users/me/dev/api', { node: MAC }), project('nod_studio:web', '/home/s/web-app', { node: 'nod_studio', sameAs: 'web-app' }), ...extra]
  await act(async () => root.render(createElement(AddToMachineDialog, {
    project: local,
    projects,
    devices: [device('nod_studio', 'Studio'), device('nod_old', 'Old laptop', { state: 'closed' }), device(MAC, 'Mac mini')],
    withProject: new Set(['nod_studio']),
    onAdded,
    onClose
  })))
  await act(async () => { await Promise.resolve() })
  return { onAdded, onClose }
}
const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!
const button = (label: string) => [...dialog().querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === label)!
const labelled = (label: string) => dialog().querySelector<HTMLElement>(`[aria-label="${label}"]`)!
const click = async (element: HTMLElement) => { await act(async () => element.click()) }
/** Lets that computer's answers about the folder picked come in. */
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = async (input: HTMLElement, key: string) => { await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })) }) }
const hint = () => dialog().querySelector('[role="status"]')?.textContent ?? ''

it('clones the project on a computer without it, on the branch here, into its projects folder; the composer gets that project', async () => {
  const { onAdded } = await show()
  // Only computers without it, the connected one first; the Studio already has it.
  expect(dialog().querySelector('[aria-label="Computer"]')!.textContent).toContain('Mac mini')
  expect(dialog().textContent).toContain('acme/web-app')
  expect(dialog().textContent).toContain('feature/login')
  // The path bar: the folders down to the clone's own, each one to go to.
  expect(button('dev')).toBeTruthy()
  expect(button('web-app')).toBeTruthy()
  expect(dialog().textContent).toContain('Connected · me')
  await click(button('Clone'))
  expect(platform).toHaveBeenCalledWith('sourceControl.clone', { node: MAC, provider: 'github', repository: 'acme/web-app', path: '/Users/me/dev/web-app', branch: 'feature/login' })
  expect(onAdded).toHaveBeenCalledWith(MAC, expect.objectContaining({ id: qualifyId(MAC, 'p9'), node: MAC, sameAs: 'web-app' }))
})

it("offers that computer's checkout of it first, and uses it without cloning", async () => {
  const { onAdded } = await show([project(`${MAC}:old`, '/Users/me/dev/web-app-old', { node: MAC, similarTo: 'web-app' })])
  expect(dialog().textContent).toContain('Its checkout there')
  await click(button('Add'))
  expect(platform).not.toHaveBeenCalledWith('sourceControl.clone', expect.anything())
  expect(onAdded).toHaveBeenCalledWith(MAC, expect.objectContaining({ id: `${MAC}:old` }))
})

it('picks where the clone goes by browsing that computer', async () => {
  mac.folders = {
    ...mac.folders,
    '/Users/me/dev': { path: '/Users/me/dev', parent: '/Users/me', folders: [{ name: 'work', path: '/Users/me/dev/work' }] },
    '/Users/me/dev/work': { path: '/Users/me/dev/work', parent: '/Users/me/dev', folders: [] }
  }
  await show()
  await click(labelled('Browse Mac mini'))
  await settle()
  await click(button('work'))
  await settle()
  expect(hint()).toBe('')
  await click(button('Clone'))
  expect(platform).toHaveBeenCalledWith('sourceControl.clone', expect.objectContaining({ path: '/Users/me/dev/work/web-app' }))
})

it('clones into a typed path, saying which folders the clone makes there', async () => {
  await show()
  await click(labelled('Type a path'))
  const field = labelled('Folder on Mac mini') as HTMLInputElement
  // "~" is that computer's home folder, and a trailing "/" means "in this folder".
  await type(field, '~/code/new/')
  await press(field, 'Enter')
  await settle()
  expect(hint()).toContain('code/new')
  await click(button('Clone'))
  expect(platform).toHaveBeenCalledWith('sourceControl.clone', expect.objectContaining({ path: '/Users/me/code/new/web-app' }))
})

it('makes a new folder while browsing, which the clone creates', async () => {
  mac.folders = { ...mac.folders, '/Users/me/dev': { path: '/Users/me/dev', parent: '/Users/me', folders: [] } }
  await show()
  await click(labelled('Browse Mac mini'))
  await settle()
  await click(button('New folder'))
  const name = labelled('New folder name') as HTMLInputElement
  await type(name, 'scratch')
  await press(name, 'Enter')
  await settle()
  expect(hint()).toContain('scratch')
  await click(button('Clone'))
  expect(platform).toHaveBeenCalledWith('sourceControl.clone', expect.objectContaining({ path: '/Users/me/dev/scratch/web-app' }))
})

it('holds Clone back while the typed path is not a full one, keeps it on leaving the field, and Escape goes back', async () => {
  const { onClose } = await show()
  await click(labelled('Type a path'))
  const field = labelled('Folder on Mac mini') as HTMLInputElement
  await type(field, 'code/web-app')
  expect(button('Clone').disabled).toBe(true)
  // Leaving the field (as pressing Clone does) keeps the text to be fixed, and Clone held back.
  await act(async () => { field.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
  expect((labelled('Folder on Mac mini') as HTMLInputElement).value).toBe('code/web-app')
  expect(button('Clone').disabled).toBe(true)
  await press(field, 'Escape')
  expect(dialog().querySelector('input[aria-label="Folder on Mac mini"]')).toBeNull()
  expect(onClose).not.toHaveBeenCalled()
  await click(button('Clone'))
  expect(platform).toHaveBeenCalledWith('sourceControl.clone', expect.objectContaining({ path: '/Users/me/dev/web-app' }))
})

it('connects GitHub on that computer from here when it is not, showing the code it relays, before Add is possible', async () => {
  mac.github = { id: 'github', name: 'GitHub', state: 'signed-out' }
  await show()
  expect(button('Clone').disabled).toBe(true)
  await click(button('Connect'))
  expect(platform).toHaveBeenCalledWith('sourceControl.connect', { node: MAC, provider: 'github' })
  expect(dialog().querySelector('[aria-label="One-time code"]')!.textContent).toBe('AB12-CD34')
})

it("shows that computer's refusal and changes nothing; Close does nothing else", async () => {
  mac.clone = async () => { throw Object.assign(new Error('That folder is not empty. Choose a new or empty folder.'), { code: 'project_refused' }) }
  const { onAdded, onClose } = await show()
  await click(button('Clone'))
  expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('That folder is not empty. Choose a new or empty folder.')
  expect(onAdded).not.toHaveBeenCalled()
  await click(dialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!)
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(onAdded).not.toHaveBeenCalled()
})

it("says when that computer's GitHub could not be checked, instead of checking forever", async () => {
  const usual = platform.getMockImplementation()!
  platform.mockImplementation(async (method: string) => {
    if (method === 'sourceControl.projectSource') return { repository: 'acme/web-app', branch: 'main' }
    throw Object.assign(new Error('Mac mini is offline.'), { code: 'peer_offline' })
  })
  try {
    await show()
    expect(dialog().textContent).toContain('Could not check')
    expect(dialog().textContent).not.toContain('Checking…')
    expect(dialog().querySelector('[role="alert"]')).not.toBeNull()
  } finally {
    platform.mockImplementation(usual)
  }
})
