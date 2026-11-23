import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: unknown[]) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())
/** What the folder picker answers next; `null` is Cancel. */
const picked = vi.hoisted(() => ({ path: null as string | null, defaultPath: undefined as string | undefined }))

vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: Handler) => { handlers.set(channel, handler) }, removeHandler: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class {},
  app: { getPath: () => '', getVersion: () => '0.0.0', on: () => undefined },
  shell: {},
  dialog: {
    showOpenDialog: async (options: { defaultPath?: string }) => {
      picked.defaultPath = options.defaultPath
      return picked.path ? { canceled: false, filePaths: [picked.path] } : { canceled: true, filePaths: [] }
    }
  },
  clipboard: {},
  nativeTheme: { on: () => undefined },
  screen: { on: () => undefined, getAllDisplays: () => [] },
  session: {},
  webContents: {}
}))

import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
import { ProjectManager } from '../src/mms/data/ProjectManager'
import { dispatchMethod } from '../src/mms/protocol/handlers'
import type { Project } from '../src/shared/types'

let root: string
let home: string
let projects: ProjectManager

/** The window's daemon: the real protocol handlers over a real project list in `home`. */
const request = (method: string, params?: unknown): Promise<unknown> =>
  dispatchMethod({ mms: { projects } as never, globalSequence: () => 0, connection: { clientType: 'gui' } as never }, method, params as object)
const inert = (base: object = {}): object => new Proxy(base, { get: (target, key) => key in target ? (target as Record<PropertyKey, unknown>)[key] : () => undefined })

const changeFolder = (projectId: string, defaultPath?: string): Promise<unknown> =>
  Promise.resolve(handlers.get('projects:changeFolder')!({ sender: { id: 1 } }, projectId, defaultPath))
const saved = (): Project[] => JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8')) as Project[]
const folder = (name: string): string => {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  return path
}

beforeAll(() => {
  registerGuiIpc({ guiMms: inert({ request, runWithSender: (_sender: unknown, run: () => unknown) => run() }), presentation: new PresentationState(), settings: inert(), browserView: inert(), repoRoot: '' } as unknown as GuiIpcServices, () => null)
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-change-folder-'))
  home = folder('home')
  projects = new ProjectManager(home)
  picked.path = null
  picked.defaultPath = undefined
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('Change folder', () => {
  it('points the same project at the folder picked, starting the picker at its current folder', async () => {
    const old = folder('app')
    const moved = folder('moved/app-v2')
    const { id } = projects.openProject(old)
    picked.path = moved

    const project = await changeFolder(id, old) as Project

    expect(picked.defaultPath).toBe(old)
    expect(project).toMatchObject({ id, path: moved, name: 'app-v2' })
    expect(saved()).toEqual([expect.objectContaining({ id, path: moved, name: 'app-v2' })])
  })

  it('keeps a name the person gave the project', async () => {
    const { id } = projects.openProject(folder('app'))
    projects.renameProject(id, 'Storefront')
    picked.path = folder('app-v2')
    await changeFolder(id)
    expect(saved()[0]).toMatchObject({ id, name: 'Storefront', path: picked.path })
  })

  it('changes nothing when the picker is cancelled', async () => {
    const old = folder('app')
    const { id } = projects.openProject(old)
    expect(await changeFolder(id, old)).toBeNull()
    expect(saved()[0]).toMatchObject({ id, path: old })
  })

  // Each refusal leaves the project where it was, and carries a code, so the window shows its reason and not a generic
  // failure.
  it.each([
    ['a path that is not there', () => join(root, 'gone'), 'invalid_params', /There is no folder at/],
    ['a file', () => { const file = join(root, 'notes.txt'); writeFileSync(file, 'x'); return file }, 'invalid_params', /There is no folder at/],
    ['the folder of another project', () => { const other = folder('other'); projects.openProject(other); return other }, 'conflict', /already the project other/],
    // Windows folders are the same whatever the case of their names.
    ...(process.platform === 'win32'
      ? [['the folder of another project, in other case', () => { projects.openProject(folder('other')); return join(root, 'OTHER') }, 'conflict', /already the project other/] as const]
      : [])
  ])('refuses %s', async (_name, target, code, message) => {
    const old = folder('app')
    const { id } = projects.openProject(old)
    picked.path = target()
    await expect(changeFolder(id, old)).rejects.toMatchObject({ code, message: expect.stringMatching(message) })
    expect(projects.getProject(id)).toMatchObject({ path: old, name: 'app' })
  })

  it('looks for the icon again in the new folder, and keeps a chosen icon inside the project relative to it', async () => {
    const { id } = projects.openProject(folder('app'))
    projects.recordDetectedIcon(id, 'favicon.svg')
    picked.path = folder('app-v2')
    await changeFolder(id)
    const after = saved()[0]!
    expect(after.detectedIconPath).toBeUndefined()
    expect(after.iconDetectedAt).toBeUndefined()

    projects.setProjectIcon(id, { mode: 'custom', path: join(picked.path, 'art', 'mark.png') })
    picked.path = folder('app-v3')
    await changeFolder(id)
    expect(saved()[0]).toMatchObject({ path: picked.path, iconPath: 'art/mark.png' })
  })
})

describe('projects.setPath', () => {
  it('is answered only for a window on the computer that holds the project, and only for an absolute folder', async () => {
    const { id } = projects.openProject(folder('app'))
    const call = (clientType: 'gui' | 'bridge', params: object) =>
      dispatchMethod({ mms: { projects } as never, globalSequence: () => 0, connection: { clientType } as never }, 'projects.setPath', params)
    await expect(call('bridge', { projectId: id, path: folder('elsewhere') })).rejects.toMatchObject({ code: 'forbidden' })
    await expect(call('gui', { projectId: id, path: 'relative/app' })).rejects.toMatchObject({ code: 'invalid_params' })
    await expect(call('gui', { projectId: 'missing', path: folder('elsewhere') })).rejects.toMatchObject({ code: 'project_not_found' })
    expect(projects.getProject(id)?.path).toBe(join(root, 'app'))
  })
})
