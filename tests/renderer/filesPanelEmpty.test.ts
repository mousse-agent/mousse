// @vitest-environment jsdom
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useFileWorkspaceStore } from '../../src/renderer/stores/filesStore'
import type { Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@monaco-editor/react', () => ({
  default: ({ value, options }: { value: string; options: { readOnly?: boolean; ariaLabel?: string } }) =>
    createElement('textarea', { value, readOnly: options.readOnly, onChange: () => undefined, 'aria-label': options.ariaLabel })
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
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()
/** The working folder each thread resolves to; the daemon gives every thread the home folder. */
const threadFolders: Record<string, string | null> = {}

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
      getFilesRoot: async () => '/home/me',
      getActiveProjectPath: async (threadId?: string | null) => (threadId ? threadFolders[threadId] ?? null : null)
    },
    workspace: { getStatus: async () => ({}) },
    fs: { readFile: async () => 'hello', readFileInWorkspace: async () => ({ content: 'hello', workspaceRoot: '/repo' }), writeFile: async () => undefined, readAsset: async () => null, listDir, listDrives: async () => ({ home: '/home/me', drives: [{ path: '/', label: '/' }] }) },
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
})

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const tree = () => host.querySelector<HTMLButtonElement>('.tree-stub')!
const sidebar = () => host.querySelector('.files-sidebar')!
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

  it('shows the contents of a thread file from a legacy service in a read-only editor', async () => {
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1')] })
    window.mousse.fs.readFileInWorkspace = async () => ({ content: 'legacy file contents' })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    await act(async () => tree().click())
    await flush()
    const editor = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="notes.txt"]')
    expect(editor?.value).toBe('legacy file contents')
    expect(editor?.readOnly).toBe(true)
    expect(host.textContent).toContain('Read-only until the service is updated')
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
  it('is the thread’s working folder, named to the daemon, rather than the home folder', async () => {
    threadFolders.t1 = '/home/me/work/app'
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1')] })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(tree().dataset.root).toBe('/home/me/work/app')
    expect(tree().dataset.listRoot).toBe('/home/me/work/app')
    expect(crumbs()).toEqual(['/', 'home', 'me', 'work', 'app'])
  })

  it('is home for a thread without a folder', async () => {
    useAppStore.setState({ activeThreadId: 't1', threads: [startedThread('t1')] })
    await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
    await flush()
    expect(tree().dataset.root).toBe('/home/me')
    // The daemon's own folder for the thread is listed by the thread, with no folder named.
    expect(tree().dataset.listRoot).toBe('')
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
