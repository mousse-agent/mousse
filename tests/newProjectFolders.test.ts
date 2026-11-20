/**
 * New project's folders on this computer: a typed path opens as it is, and a new empty project's folder is made first
 * (never over anything already there), then becomes a Git repository. Real folders; the service is a recorder.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), requests: [] as Array<{ method: string; params: unknown }> }))
vi.mock('electron', () => ({
  ipcMain: { handle: (c: string, f: Function) => h.handlers.set(c, f), removeHandler() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: class { static isSupported() { return false } },
  powerMonitor: {}, app: { getPath: () => '', getVersion: () => 'test', on() {} }, shell: {}, dialog: {}, clipboard: {}, nativeTheme: { on() {} }, screen: { on() {}, getAllDisplays: () => [] }, session: {}, webContents: {}
}))
import { registerGuiIpc, type GuiIpcServices } from '../src/main/ipc/registerGuiIpc'
import { PresentationState } from '../src/main/mms/PresentationState'
import { expandFolderPath, makeProjectFolder } from '../src/main/ipc/projectFolders'

const inert = (base: object = {}): any => new Proxy(base, { get: (t, k) => k in t ? (t as any)[k] : () => undefined })
beforeAll(() => {
  const window = { isDestroyed: () => false, isFocused: () => false, webContents: { id: 1, send() {} } }
  const guiMms = inert({
    runWithSender: (_sender: unknown, run: () => unknown) => run(),
    request: async (method: string, params: unknown) => {
      h.requests.push({ method, params })
      if (method === 'projects.open') return { project: { id: 'p1', path: (params as { path: string }).path }, projects: [] }
      if (method === 'threads.list') return { threads: [] }
      return {}
    },
    on() {},
    getWindowBindingForSender: () => ({ profileId: 'p' })
  })
  registerGuiIpc({ guiMms, presentation: new PresentationState(), settings: inert({ get: () => ({}) }), browserView: inert(), repoRoot: '' } as GuiIpcServices, () => window as any)
})

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mousse-new-project-'))
  h.requests.length = 0
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const open = (target?: unknown) => h.handlers.get('projects:open')!({ sender: { id: 1 } }, target)
const methods = () => h.requests.map((request) => request.method)

describe('projects:open with a typed folder', () => {
  it('makes a new empty project: the folder, then the project, then its Git repository', async () => {
    const path = join(root, 'web-app')
    expect(await open({ path, create: true })).toMatchObject({ id: 'p1', path })
    expect(readdirSync(path)).toEqual([])
    expect(h.requests).toEqual([
      { method: 'projects.open', params: { path } },
      { method: 'git.init', params: { projectId: 'p1' } },
      { method: 'threads.list', params: undefined }
    ])
  })

  it('uses an empty folder that is already there', async () => {
    const path = join(root, 'empty')
    mkdirSync(path)
    await open({ path, create: true })
    expect(methods()).toEqual(['projects.open', 'git.init', 'threads.list'])
  })

  it.each([
    ['a folder with files', (path: string) => { mkdirSync(path); writeFileSync(join(path, 'keep.txt'), 'mine') }, 'already has files'],
    ['a file of that name', (path: string) => writeFileSync(path, 'mine'), 'already there'],
    ['a missing folder to go in', () => undefined, 'does not exist']
  ])('refuses %s and changes nothing', async (_name, arrange, message) => {
    const path = _name === 'a missing folder to go in' ? join(root, 'nowhere', 'web-app') : join(root, 'taken')
    arrange(path)
    const before = existsSync(path) ? (readdirSync(root).length) : -1
    await expect(open({ path, create: true })).rejects.toThrow(message)
    expect(h.requests).toEqual([])
    if (_name === 'a folder with files') expect(readFileSync(join(path, 'keep.txt'), 'utf8')).toBe('mine')
    if (_name === 'a file of that name') expect(readFileSync(path, 'utf8')).toBe('mine')
    if (before === -1) expect(existsSync(join(root, 'nowhere'))).toBe(false)
  })

  it('adds a folder that is already there, as it is, with no Git step', async () => {
    const path = join(root, 'existing')
    mkdirSync(path)
    writeFileSync(join(path, 'README.md'), 'hi')
    await open({ path })
    expect(methods()).toEqual(['projects.open', 'threads.list'])
    expect(readdirSync(path)).toEqual(['README.md'])
  })
})

describe('expandFolderPath', () => {
  it.each([
    ['~', homedir()],
    ['~/dev/web-app', join(homedir(), 'dev', 'web-app')]
  ])('reads %s from the home folder', (typed, expected) => {
    expect(expandFolderPath(typed)).toBe(expected)
  })

  it.each(['dev/web-app', 'web-app', '', process.platform === 'win32' ? 'C:\\' : '/'])('refuses %j', (typed) => {
    expect(() => expandFolderPath(typed)).toThrow()
  })

  it('makes nothing outside the path it is given', async () => {
    const path = join(root, 'one')
    await makeProjectFolder(path)
    expect(readdirSync(root)).toEqual(['one'])
  })
})
