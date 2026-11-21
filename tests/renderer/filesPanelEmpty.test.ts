// @vitest-environment jsdom
import { mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, posix, resolve, win32 } from 'node:path'
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadWindow } from '../../src/renderer/services/reloadWindow'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { fileWorkspaceScope, useFileWorkspaceStore } from '../../src/renderer/stores/filesStore'
import type { GitThreadHead, Thread } from '../../src/shared/types'
import { ownedTemp } from '../support/tmp'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement('textarea', { className: 'editor-stub', value, onChange: (event) => onChange(event.currentTarget.value) })
}))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
// The tree stub offers one file to open and shows which folder it lists.
vi.mock('../../src/renderer/components/FileTree', () => ({
  FileTreeToolbar: () => null,
  FileTree: ({ onSelectFile, filesRoot, listRoot }: { onSelectFile: (path: string) => void; filesRoot: string; listRoot?: string }) =>
    createElement('button', {
      type: 'button', className: 'tree-stub file-tree-row', 'data-path': 'notes.txt', 'data-root': filesRoot, 'data-list-root': listRoot ?? '',
      onClick: () => onSelectFile('notes.txt')
    }, 'notes.txt')
}))

const { MainViewTabs } = await import('../../src/renderer/components/MainViewTabs')
const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')

let root: Root
let host: HTMLElement
let listDir: ReturnType<typeof vi.fn>
let headsChanged: ((event: { threadIds: string[] }) => void) | undefined
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()
const threadFolders: Record<string, string | null> = {}
const threadHeads: Record<string, GitThreadHead> = {}

beforeEach(() => {
  useAppStore.setState({ openedSurfaceKinds: ['files'], mainView: 'files' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  listDir = vi.fn(async (_dir: string, _project?: string, _thread?: string | null, folder?: string) => {
    if (folder === '/missing') throw new Error('ENOENT: no such file or directory')
    return []
  })
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: {
      getFilesRoot: async (threadId?: string | null) => (threadId ? threadFolders[threadId] ?? '/home/me' : '/home/me'),
      getActiveProjectPath: async (threadId?: string | null) => (threadId ? threadFolders[threadId] ?? null : null)
    },
    git: {
      heads: async ({ threadIds }: { threadIds: string[] }) => ({ threads: Object.fromEntries(threadIds.map((id) => [id, threadHeads[id] ?? { project: true }])) }),
      onHeadsChanged: (listener: typeof headsChanged) => {
        headsChanged = listener
        return () => { headsChanged = undefined }
      }
    },
    workspace: { getStatus: async () => ({}) },
    fs: { readFile: async () => 'hello', writeFile: async () => undefined, readAsset: async () => null, listDir, listDrives: async () => ({ home: '/home/me', drives: [{ path: '/', label: '/' }] }) },
    threads: { select: async () => undefined }
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialApp, true)
  useFileWorkspaceStore.setState(initialFiles, true)
  for (const key of Object.keys(threadFolders)) delete threadFolders[key]
  for (const key of Object.keys(threadHeads)) delete threadHeads[key]
})

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const tree = () => host.querySelector<HTMLButtonElement>('.tree-stub')!
const sidebar = () => host.querySelector('.files-sidebar')!
const mountFiles = () => act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
const openLink = (path: string) => act(async () => {
  window.dispatchEvent(new CustomEvent('mousse:open-file', { detail: { path } }))
})
const browseTo = async (folder: string) => {
  if (!tree()) await act(async () => host.querySelector<HTMLButtonElement>('.main-view-tab-select[title="Files"]')!.click())
  await act(async () => {
    tree().dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true }))
  })
  const input = host.querySelector<HTMLInputElement>('.files-path-input')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, folder)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
}
const editor = () => host.querySelector<HTMLTextAreaElement>('.editor-stub')
const editText = (value: string) => act(async () => {
  const field = editor()!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
  field.dispatchEvent(new Event('input', { bubbles: true }))
})
async function restoreFileTabs() {
  const storageKey = useFileWorkspaceStore.persist.getOptions().name
  const saved = localStorage.getItem(storageKey)!
  await act(async () => root.unmount())
  root = createRoot(host)
  useFileWorkspaceStore.setState(initialFiles, true)
  localStorage.setItem(storageKey, saved)
  await useFileWorkspaceStore.persist.rehydrate()
  await mountFiles()
}
const crumbs = () => [...host.querySelectorAll<HTMLButtonElement>('.files-path-crumb')].map((crumb) => crumb.textContent)

function startedThread(id: string): Thread {
  return { id, name: id, startedAt: '2026-11-01T00:00:00.000Z' } as unknown as Thread
}

describe('Files panel without an open file', () => {
  it('gives the tree the whole panel, with no empty preview beside it', async () => {
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(host.textContent).not.toContain('Select a file')
    expect(host.querySelector('.files-editor')).toBeNull()
    expect(sidebar().classList.contains('resizable-panel-sidebar-fill')).toBe(true)
  })

  it('keeps files as independent tabs when Files closes, and reopening a file selects its existing tab', async () => {
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    await act(async () => tree().click())
    await flush()
    const tab = (title: string) => host.querySelector<HTMLButtonElement>(`.main-view-tab-select[title="${title}"]`)!
    expect(tab('notes.txt').getAttribute('aria-current')).toBe('page')
    expect(host.querySelector('[role="tablist"][aria-label="Open files"]')).toBeNull()
    await act(async () => tab('Files').click())
    expect(host.querySelector('.files-editor')).toBeNull()
    await act(async () => tree().click())
    expect(host.querySelectorAll('.main-view-tab-select[title="notes.txt"]')).toHaveLength(1)
    await act(async () => { window.dispatchEvent(new CustomEvent('mousse:open-file', { detail: { path: 'second.txt' } })) })
    await flush()
    expect(tab('second.txt').getAttribute('aria-current')).toBe('page')
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close Files"]')!.click())
    expect(tab('Files')).toBeNull()
    expect(tab('notes.txt')).not.toBeNull()
    await act(async () => tab('notes.txt').click())
    expect(host.querySelector('[role="region"][aria-label="notes.txt"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close notes.txt"]')!.click())
    await flush()
    expect(tab('second.txt').getAttribute('aria-current')).toBe('page')
  })

  it('shows only the current thread’s file tabs', async () => {
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1'), startedThread('t2')] })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    await act(async () => tree().click())
    await flush()
    expect(host.querySelector('[aria-label="Close notes.txt"]')).not.toBeNull()
    await act(async () => useAppStore.setState({ activeThreadId: 't2' }))
    await flush()
    expect(host.querySelector('[aria-label="Close notes.txt"]')).toBeNull()
    await act(async () => useAppStore.setState({ activeThreadId: 't1' }))
    await flush()
    expect(host.querySelector('[aria-label="Close notes.txt"]')).not.toBeNull()
  })

  it('restores a browsed file on a healthy drive even while the checkout lookup is pending or fails', async () => {
    const threadId = 'unavailable-worktree'
    threadFolders[threadId] = 'C:\\checkout'
    useAppStore.setState({ activeThreadId: threadId, threads: [{ ...startedThread(threadId), projectId: 'p1', worktreeEnabled: true }] })
    const readFile = vi.fn(async (name: string, _project?: string, _thread?: string | null, folder?: string) => {
      if (folder !== 'D:\\notes' || name !== 'saved.txt') throw new Error('Worktree drive not answering')
      return 'saved notes on D:'
    })
    window.mousse.fs.readFile = readFile
    await mountFiles()
    await openLink('D:/notes/saved.txt')
    expect(editor()?.value).toBe('saved notes on D:')

    let failRoot!: (error: Error) => void
    const rootLookup = new Promise<string>((_resolve, reject) => { failRoot = reject })
    window.mousse.app.getFilesRoot = () => rootLookup
    readFile.mockClear()
    await restoreFileTabs()
    expect(readFile).toHaveBeenCalledWith('saved.txt', undefined, threadId, 'D:\\notes')
    expect(editor()?.value).toBe('saved notes on D:')
    await act(async () => failRoot(new Error('Worktree drive not answering')))
    expect(editor()?.value).toBe('saved notes on D:')
  })

  it.each(['new pick during checkout outage', 'legacy tab reopened after checkout recovery'])('opens a healthy browsed file (%s)', async (scenario) => {
    const threadId = 'browsed-outside-checkout'
    const projectId = 'p1'
    const checkout = 'C:\\checkout'
    const folder = 'D:\\notes'
    const path = win32.join(folder, 'notes.txt')
    const scope = fileWorkspaceScope(useAppStore.getState().profileId, threadId, projectId)
    const legacy = scenario === 'legacy tab reopened after checkout recovery'
    threadFolders[threadId] = checkout
    useAppStore.setState({ activeThreadId: threadId, threads: [{ ...startedThread(threadId), projectId }] })
    if (legacy) useFileWorkspaceStore.setState({ workspaces: { [scope]: { openPaths: [path], activePath: path } } })
    const readFile = vi.fn(async (name: string, _project?: string, _thread?: string | null, root?: string) => {
      if (root !== folder || name !== 'notes.txt') throw new Error('Path is outside the project root')
      return 'healthy browsed notes'
    })
    window.mousse.fs.readFile = readFile

    await mountFiles()
    if (legacy) expect(host.textContent).toContain('Path is outside the project root')
    await browseTo(folder)
    window.mousse.app.getFilesRoot = async () => { throw new Error('Checkout drive not answering') }
    await act(async () => headsChanged?.({ threadIds: [threadId] }))
    expect(tree().dataset.listRoot).toBe(folder)
    if (legacy) {
      window.mousse.app.getFilesRoot = async () => checkout
      await act(async () => headsChanged?.({ threadIds: [threadId] }))
    }

    readFile.mockClear()
    await act(async () => tree().click())
    expect(readFile).toHaveBeenCalledWith('notes.txt', undefined, threadId, folder)
    expect(editor()?.value).toBe('healthy browsed notes')
    expect(host.querySelectorAll('[aria-label="Close notes.txt"]')).toHaveLength(1)

    readFile.mockClear()
    await restoreFileTabs()
    expect(readFile).toHaveBeenCalledWith('notes.txt', undefined, threadId, folder)
  })

  it.each(['saved target', 'older path-only snapshot'])('keeps a restored checkout file scoped to the thread (%s)', async (snapshot) => {
    const threadId = 'recovering-checkout'
    const projectId = 'p1'
    const project = 'C:\\checkout'
    const worktree = 'C:\\worktrees\\notes'
    const projectFile = win32.join(project, 'notes.txt')
    const worktreeFile = win32.join(worktree, 'notes.txt')
    const disk = new Map([[projectFile, 'same bytes'], [worktreeFile, 'same bytes']])
    threadFolders[threadId] = project
    useAppStore.setState({ activeThreadId: threadId, threads: [{ ...startedThread(threadId), projectId, worktreeEnabled: true }] })
    const target = (path: string, folder?: string) => {
      const root = folder ?? threadFolders[threadId]!
      const file = win32.resolve(root, path)
      if (!file.startsWith(root + '\\')) throw new Error('Path is outside the project root')
      return file
    }
    const readFile = vi.fn(async (path: string, _project?: string, _thread?: string | null, folder?: string) => disk.get(target(path, folder))!)
    const writeFile = vi.fn(async (path: string, content: string, _project?: string, _thread?: string | null, folder?: string) => {
      disk.set(target(path, folder), content)
    })
    window.mousse.fs.readFile = readFile
    window.mousse.fs.writeFile = writeFile
    await mountFiles()
    if (snapshot === 'older path-only snapshot') {
      const scope = fileWorkspaceScope(useAppStore.getState().profileId, threadId, projectId)
      await act(async () => {
        const storageKey = useFileWorkspaceStore.persist.getOptions().name
        localStorage.setItem(storageKey, JSON.stringify({ state: { workspaces: { [scope]: {
          openPaths: [projectFile], activePath: projectFile
        } } }, version: 0 }))
      })
    } else {
      await act(async () => tree().click())
      expect(editor()?.value).toBe('same bytes')
    }

    window.mousse.app.getFilesRoot = async () => { throw new Error('Worktree drive not answering') }
    readFile.mockClear()
    await restoreFileTabs()
    expect(readFile).not.toHaveBeenCalled()
    expect(editor()).toBeNull()

    window.mousse.app.getFilesRoot = async () => threadFolders[threadId]!
    await act(async () => headsChanged?.({ threadIds: [threadId] }))
    expect(readFile.mock.calls.map(([path, project, thread, folder]) => [win32.normalize(path), project, thread, folder]))
      .toEqual([[projectFile, undefined, threadId, undefined]])
    expect(editor()?.value).toBe('same bytes')
    await editText('my project edit')

    threadFolders[threadId] = worktree
    await act(async () => headsChanged?.({ threadIds: [threadId] }))
    const reload = vi.fn()
    await act(async () => { expect(await reloadWindow(reload)).toBe('unsaved') })
    expect(writeFile).not.toHaveBeenCalled()
    expect(disk.get(projectFile)).toBe('same bytes')
    expect(disk.get(worktreeFile)).toBe('same bytes')
    expect(editor()?.value).toBe('my project edit')

    await browseTo(project)
    await act(async () => tree().click())
    expect(editor()?.value).toBe('my project edit')
    await act(async () => { expect(await reloadWindow(reload)).toBe('reloaded') })
    expect(disk.get(projectFile)).toBe('my project edit')
    expect(disk.get(worktreeFile)).toBe('same bytes')
  })

  it.each([true, false])('opens distinct Windows filenames separately and reuses separator variants (canonical metadata: %s)', async (includeCanonicalPath) => {
    const threadId = 'windows-checkout'
    threadFolders[threadId] = 'C:\\checkout'
    useAppStore.setState({ activeThreadId: threadId, threads: [{ ...startedThread(threadId), projectId: 'p1' }] })
    const disk = new Map([['D:\\notes\\notes.txt', 'lowercase notes'], ['D:\\notes\\Notes.txt', 'uppercase notes']])
    window.mousse.fs.readFileDetails = async (path, _project, _thread, folder) => {
      const canonicalPath = win32.resolve(folder ?? threadFolders[threadId]!, path)
      const content = disk.get(canonicalPath)
      if (content === undefined) throw new Error('File not found')
      return includeCanonicalPath ? { content, canonicalPath } : { content }
    }

    await mountFiles()
    await openLink('D:\\notes\\notes.txt')
    expect(editor()?.value).toBe('lowercase notes')
    await openLink('D:\\notes\\Notes.txt')
    expect(editor()?.value).toBe('uppercase notes')
    await openLink('d:/notes/notes.txt')
    expect(editor()?.value).toBe('lowercase notes')
    expect(host.querySelectorAll('[aria-label="Close notes.txt"]')).toHaveLength(1)
    expect(host.querySelectorAll('[aria-label="Close Notes.txt"]')).toHaveLength(1)
  })

  it('reuses the same editor for alternate casing on a case-insensitive Windows volume', async () => {
    const threadId = 'case-insensitive-checkout'
    threadFolders[threadId] = 'C:\\checkout'
    const canonicalPath = 'C:\\checkout\\Notes.txt'
    const writeFile = vi.fn(async () => undefined)
    window.mousse.fs.readFile = async () => 'saved notes'
    window.mousse.fs.writeFile = writeFile
    useAppStore.setState({ activeThreadId: threadId, threads: [{ ...startedThread(threadId), projectId: 'p1' }] })
    window.mousse.fs.readFileDetails = async (path, _project, _thread, folder) => {
      if (win32.resolve(folder ?? threadFolders[threadId]!, path).toLowerCase() !== canonicalPath.toLowerCase()) throw new Error('File not found')
      return { content: 'saved notes', canonicalPath }
    }

    await mountFiles()
    await openLink('C:\\checkout\\Notes.txt')
    expect(editor()?.value).toBe('saved notes')
    await editText('edited notes')
    await openLink('c:/checkout/notes.txt')
    expect(editor()?.value).toBe('edited notes')
    expect(writeFile).not.toHaveBeenCalled()
    expect(host.querySelectorAll('[aria-label="Close Notes.txt"]')).toHaveLength(1)
    expect(host.querySelector('[aria-label="Close notes.txt"]')).toBeNull()
  })

  it.each([false, true])('keeps a junction tab separate from its direct target (retargeted: %s)', async (retargeted) => {
    const fixture = ownedTemp('mousse-files-junction-')
    const a = fixture.child('A')
    const b = fixture.child('B')
    const junction = fixture.child('junction')
    const fileA = join(a, 'notes.txt')
    const fileB = join(b, 'notes.txt')
    const threadId = 'junction-checkout'
    try {
      mkdirSync(a)
      mkdirSync(b)
      writeFileSync(fileA, 'same bytes')
      writeFileSync(fileB, 'same bytes')
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      symlinkSync(a, junction, linkType)
      threadFolders[threadId] = fixture.path
      useAppStore.setState({ activeThreadId: threadId, threads: [{ ...startedThread(threadId), projectId: 'p1' }] })
      const target = (path: string, folder?: string) => resolve(folder ?? fixture.path, path)
      window.mousse.fs.readFile = async (path, _project, _thread, folder) => readFileSync(target(path, folder), 'utf8')
      window.mousse.fs.readFileDetails = async (path, _project, _thread, folder) => {
        const file = target(path, folder)
        return { content: readFileSync(file, 'utf8'), canonicalPath: realpathSync.native(file) }
      }
      window.mousse.fs.writeFile = async (path, content, _project, _thread, folder) => {
        writeFileSync(target(path, folder), content)
      }

      await mountFiles()
      await openLink(join(junction, 'notes.txt'))
      expect(editor()?.value).toBe('same bytes')
      if (retargeted) {
        unlinkSync(junction)
        symlinkSync(b, junction, linkType)
      }

      await openLink(fileA)
      await editText('edit for A')
      await act(async () => { await reloadWindow(vi.fn()) })
      expect(readFileSync(fileA, 'utf8')).toBe('edit for A')
      expect(readFileSync(fileB, 'utf8')).toBe('same bytes')
      expect(host.querySelectorAll('[aria-label="Close notes.txt"]')).toHaveLength(2)
    } finally {
      await fixture.close()
    }
  })

  it('opens a picked file in a sibling tab; returning to Files shows the browser', async () => {
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    await act(async () => tree().click())
    await flush()
    // The tab names the file; the toolbar row holds only the tabs and the file's controls, not the name again.
    expect(host.querySelector('.main-view-tab-select[title="notes.txt"]')?.textContent).toBe('notes.txt')
    expect(host.querySelector('.files-editor-toolbar .files-toolbar-actions')?.textContent).not.toContain('notes.txt')
    expect(host.querySelector('.files-editor')?.getAttribute('aria-label')).toBe('notes.txt')
    expect(sidebar()).toBeNull()

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!.click())
    await flush()
    expect(host.querySelector('.files-editor')).toBeNull()
    expect(sidebar().classList.contains('resizable-panel-sidebar-fill')).toBe(true)
    expect(document.activeElement).toBe(tree())

    await act(async () => tree().click())
    await flush()
    const toolbar = host.querySelector<HTMLElement>('.files-editor-toolbar')!
    await act(async () => { toolbar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    await flush()
    expect(host.querySelector('.files-editor')).toBeNull()
  })
})

describe('the folder the Files tree shows', () => {
  it('is the thread’s working folder, which the daemon uses for relative paths', async () => {
    threadFolders.t1 = '/home/me/work/app'
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1')] })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(tree().dataset.root).toBe('/home/me/work/app')
    expect(tree().dataset.listRoot).toBe('')
    expect(crumbs()).toEqual(['/', 'home', 'me', 'work', 'app'])
  })

  it('uses checkout scope for a UNC checkout and preserves the share when browsing elsewhere', async () => {
    const threadId = 'unc-checkout'
    const checkout = '\\\\server\\share\\checkout'
    const folder = '\\\\server\\other-share\\notes'
    threadFolders[threadId] = checkout
    useAppStore.setState({ activeThreadId: threadId, threads: [{ ...startedThread(threadId), projectId: 'p1' }] })
    const readFile = vi.fn(async (name: string, _project?: string, _thread?: string | null, root?: string) => {
      if (!root && win32.normalize(name) === win32.join(checkout, 'notes.txt')) return 'checkout notes'
      if (root === folder && name === 'notes.txt') return 'browsed notes'
      throw new Error('Unexpected file target')
    })
    window.mousse.fs.readFile = readFile

    await mountFiles()
    expect(tree().dataset.root).toBe(checkout)
    await act(async () => tree().click())
    expect(editor()?.value).toBe('checkout notes')

    await browseTo('//server/other-share/notes')
    expect(listDir).toHaveBeenCalledWith('', undefined, threadId, folder)
    expect(tree().dataset.listRoot).toBe(folder)
    await act(async () => tree().click())
    expect(readFile).toHaveBeenLastCalledWith('notes.txt', undefined, threadId, folder)
    expect(editor()?.value).toBe('browsed notes')
    expect(host.querySelectorAll('[aria-label="Close notes.txt"]')).toHaveLength(2)
  })

  it('is home for a thread without a folder', async () => {
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1')] })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(tree().dataset.root).toBe('/home/me')
    // The daemon's own folder for the thread is listed by the thread, with no folder named.
    expect(tree().dataset.listRoot).toBe('')
  })

  it.each([
    { kind: 'standalone', projectId: undefined, folder: '/home/me' },
    { kind: 'non-Git project', projectId: 'p1', folder: '/home/me/work/notes' },
    { kind: 'project-folder', projectId: 'p1', folder: '/home/me/work/notes', worktreeEnabled: false }
  ])('browses a started $kind thread without a worktree', async ({ projectId, folder, worktreeEnabled }) => {
    threadFolders.t1 = folder
    threadHeads.t1 = worktreeEnabled === false
      ? { project: true }
      : { own: true, branch: null, generation: 0, lifecycle: 'unprovisioned' }
    useAppStore.setState({
      activeThreadId: 't1',
      threads: [{ ...startedThread('t1'), projectId, worktreeEnabled }],
      projects: projectId ? [{ id: projectId, name: 'Notes', path: folder }] as never : []
    })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(crumbs().at(-1)).toBe(folder.split('/').at(-1))
    expect(tree().dataset.root).toBe(folder)
    expect(tree().dataset.listRoot).toBe('')
    await act(async () => tree().click())
    expect(host.querySelector('[role="region"][aria-label="notes.txt"]')).not.toBeNull()
  })

  it('names the folder picked in the composer for an empty chat to the daemon', async () => {
    useAppStore.setState({
      composerWorkspaceDrafts: { __blank__: { projectId: 'p1', worktreeEnabled: false } },
      projects: [{ id: 'p1', name: 'Notes', path: '/home/me/work/notes' }] as never
    })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(tree().dataset.root).toBe('/home/me/work/notes')
    expect(tree().dataset.listRoot).toBe('/home/me/work/notes')
  })

  it('follows the daemon’s working folder when the first worktree is ready', async () => {
    const threadId = 'new-worktree'
    threadFolders[threadId] = '/home/me/work/notes'
    useAppStore.setState({
      activeThreadId: threadId,
      threads: [{ ...startedThread(threadId), projectId: 'p1' }]
    })
    await act(async () => root.render(createElement(FilesPanel)))
    await flush()
    expect(tree().dataset.root).toBe('/home/me/work/notes')

    threadFolders[threadId] = '/worktrees/notes'
    await act(async () => headsChanged?.({ threadIds: [threadId] }))
    expect(tree().dataset.root).toBe('/worktrees/notes')
    expect(tree().dataset.listRoot).toBe('')
  })

  it('opens the worktree copy in a separate tab and keeps pending edits in the project tab', async () => {
    const threadId = 'provisioning-autosave'
    const project = '/home/me/work/notes'
    const worktree = '/worktrees/notes'
    const disk = new Map([[project + '/notes.txt', 'same bytes'], [worktree + '/notes.txt', 'same bytes']])
    threadFolders[threadId] = project
    threadHeads[threadId] = { own: true, branch: null, generation: 0, lifecycle: 'provisioning' }
    useAppStore.setState({
      activeThreadId: threadId,
      threads: [{ ...startedThread(threadId), projectId: 'p1', worktreeEnabled: true }],
      projects: [{ id: 'p1', name: 'Notes', path: project }] as never
    })
    // The daemon resolves a relative path against the checkout in use when each call arrives.
    const target = (path: string, root?: string) => {
      const folder = root ?? threadFolders[threadId]!
      const absolute = posix.resolve(folder, path)
      if (!absolute.startsWith(folder + '/')) throw new Error('Path is outside the project root')
      return absolute
    }
    window.mousse.fs.readFile = async (path, _project, _thread, root) => disk.get(target(path, root))!
    window.mousse.fs.readFileDetails = async (path, _project, _thread, root) => {
      const canonicalPath = target(path, root)
      return { content: disk.get(canonicalPath)!, canonicalPath }
    }
    window.mousse.fs.writeFile = async (path, content, _project, _thread, root) => { disk.set(target(path, root), content) }

    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(tree().dataset.root).toBe(project)
    await act(async () => tree().click())
    const editor = host.querySelector<HTMLTextAreaElement>('.editor-stub')!
    expect(editor.value).toBe('same bytes')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'my project edit')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })

    threadFolders[threadId] = worktree
    threadHeads[threadId] = { own: true, branch: 'notes', generation: 0, lifecycle: 'ready', folder: worktree }
    await act(async () => headsChanged?.({ threadIds: [threadId] }))
    const reload = vi.fn()
    await act(async () => { expect.soft(await reloadWindow(reload)).toBe('unsaved') })
    expect(disk.get(worktree + '/notes.txt')).toBe('same bytes')
    expect(disk.get(project + '/notes.txt')).toBe('same bytes')
    expect(reload).not.toHaveBeenCalled()

    disk.set(worktree + '/notes.txt', 'worktree contents')
    await act(async () => host.querySelector<HTMLButtonElement>('.main-view-tab-select[title="Files"]')!.click())
    expect(tree().dataset.root).toBe(worktree)
    await act(async () => tree().click())
    expect(host.querySelector<HTMLTextAreaElement>('.editor-stub')?.value).toBe('worktree contents')

    const tab = (folder: string) => host.querySelector<HTMLButtonElement>(`.main-view-tab-select[title^="${folder}/notes.txt"]`)!
    expect(tab(worktree).getAttribute('aria-current')).toBe('page')
    expect(host.querySelectorAll('[aria-label="Close notes.txt"]')).toHaveLength(2)
    const projectTab = tab(project)
    await act(async () => projectTab.click())
    expect(host.querySelector<HTMLTextAreaElement>('.editor-stub')?.value).toBe('my project edit')
  })

  it('keeps where the person went for each thread, and follows the folder of a thread they did not move in', async () => {
    threadFolders.t1 = '/home/me/a'
    threadFolders.t2 = '/home/me/b'
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1'), startedThread('t2')] })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    const me = [...host.querySelectorAll<HTMLButtonElement>('.files-path-crumb')].find((crumb) => crumb.textContent === 'me')!
    await act(async () => me.click())
    await flush()
    expect(tree().dataset.root).toBe('/home/me')

    await act(async () => useAppStore.setState({ activeThreadId: 't2' }))
    await flush()
    expect(tree().dataset.root).toBe('/home/me/b')

    await act(async () => useAppStore.setState({ activeThreadId: 't1' }))
    await flush()
    expect(tree().dataset.root).toBe('/home/me')
  })

  it('takes a typed path with Ctrl+L and says so inline when the folder does not exist', async () => {
    threadFolders.t1 = '/home/me/a'
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1')] })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    await act(async () => { tree().dispatchEvent(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true, bubbles: true, cancelable: true })) })
    const input = host.querySelector<HTMLInputElement>('.files-path-input')!
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('/home/me/a')

    const type = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const enter = async () => { await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) }); await flush() }

    await type('/missing')
    await enter()
    expect(host.querySelector('.files-path-error')?.textContent).toBe('Folder not found')
    expect(tree().dataset.root).toBe('/home/me/a')

    await type('../b')
    await enter()
    expect(host.querySelector('.files-path-input')).toBeNull()
    expect(tree().dataset.root).toBe('/home/me/b')
  })
})
