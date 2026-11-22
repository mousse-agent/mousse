// @vitest-environment jsdom
import { act, createElement, Fragment, StrictMode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { fileWorkspaceScope, useFileWorkspaceStore } from '../../src/renderer/stores/filesStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The editor stub types into the open file, like the real editor's onChange. */
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement('textarea', { className: 'editor-stub', value, onChange: (event: { target: { value: string } }) => onChange(event.target.value) })
}))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
/** The tree stub shows the file's row, or not when its folder is collapsed, and always a README row. */
const tree = { showRow: true }
vi.mock('../../src/renderer/components/FileTree', () => ({
  FileTreeToolbar: () => null,
  FileTree: ({ onSelectFile }: { onSelectFile: (path: string) => void }) => createElement('div', null,
    createElement('button', { type: 'button', className: 'tree-open', onClick: () => onSelectFile('notes.txt') }, 'open notes.txt'),
    tree.showRow && createElement('button', { type: 'button', className: 'file-tree-row', 'data-path': 'notes.txt' }, 'notes.txt'),
    createElement('button', { type: 'button', className: 'file-tree-row', 'data-path': 'README.md' }, 'README.md'))
}))

const { MainViewTabs } = await import('../../src/renderer/components/MainViewTabs')
const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')

let root: Root
let host: HTMLElement
let writeFile: ReturnType<typeof vi.fn>
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()

beforeEach(() => {
  useAppStore.setState({ openedSurfaceKinds: ['files'], mainView: 'files' })
  tree.showRow = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  writeFile = vi.fn(async () => undefined)
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => '/repo' },
    fs: { readFile: async () => 'hello', readFileInWorkspace: async () => ({
      content: await window.mousse.fs.readFile('note.txt'), workspaceRoot: '/repo'
    }), writeFile, readAsset: async () => null },
    threads: { select: async () => undefined }
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialApp, true)
  useFileWorkspaceStore.setState(initialFiles, true)
})

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const tab = () => host.querySelector<HTMLButtonElement>('.main-view-tab-select[title="/repo/notes.txt"], .main-view-tab-select[title^="notes.txt"]')

async function openNotes() {
  await act(async () => root.render(createElement(Fragment, null, createElement(MainViewTabs), createElement(FilesPanel))))
  await act(async () => host.querySelector<HTMLButtonElement>('.tree-open')?.click())
  await flush()
  expect(tab()?.textContent).toBe('notes.txt')
}

describe('closing the last open file', () => {
  it('with Delete, returns focus to Files', async () => {
    await openNotes()
    tab()!.focus()
    await act(async () => { tab()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })) })
    await flush()
    expect(tab()).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.main-view-tab-select[title="Files"]'))
  })

  it('with the close button, returns focus to Files even when the tree row was not shown', async () => {
    tree.showRow = false
    await openNotes()
    const close = host.querySelector<HTMLButtonElement>('[aria-label="Close notes.txt"]')!
    close.focus()
    await act(async () => close.click())
    await flush()
    expect(tab()).toBeNull()
    expect(host.querySelector('.files-editor')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.main-view-tab-select[title="Files"]'))
  })

  it('keeps the tab, and focus on it, when unsaved edits cannot be saved', async () => {
    writeFile.mockRejectedValue(new Error('disk full'))
    await openNotes()
    const editor = host.querySelector<HTMLTextAreaElement>('.editor-stub')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, 'hello, edited')
      editor.dispatchEvent(new Event('input', { bubbles: true }))
    })
    tab()!.focus()
    await act(async () => { tab()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })) })
    await flush()
    await flush()
    expect(writeFile).toHaveBeenCalled()
    expect(tab()?.textContent).toBe('notes.txt •')
    expect(document.activeElement).toBe(tab())
  })
})

describe('closing tabs', () => {
  it('keeps the panel while another tab is open, and closes it with the last tab', async () => {
    useAppStore.setState({ mainAreaOpen: true })
    await openNotes()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close notes.txt"]')!.click())
    await flush()
    expect(useAppStore.getState().mainAreaOpen).toBe(true)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close Files"]')!.click())
    await flush()
    expect(useAppStore.getState().mainAreaOpen).toBe(false)
  })
})

describe('an open file', () => {
  it('that was open before a restart loads, even through the development double mount', async () => {
    let finishRead!: (text: string) => void
    ;(window as unknown as { mousse: { fs: { readFile: () => Promise<string> } } }).mousse.fs.readFile = () => new Promise((resolve) => { finishRead = resolve })
    useFileWorkspaceStore.getState().openFile(fileWorkspaceScope(useAppStore.getState().profileId, useAppStore.getState().activeThreadId, null), 'notes.txt')
    await act(async () => root.render(createElement(StrictMode, null, createElement(FilesPanel))))
    await act(async () => finishRead('restored text'))
    await flush()
    expect(host.querySelector('.panel-error')).toBeNull()
    expect(host.querySelector<HTMLTextAreaElement>('.editor-stub')?.value).toBe('restored text')
  })
})

describe('background refresh of an open file', () => {
  it('clears "Refresh failed" once a later refresh reads the file again, even when it did not change', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      let fail = false
      ;(window as unknown as { mousse: { fs: { readFile: () => Promise<string> } } }).mousse.fs.readFile = async () => {
        if (fail) throw new Error('disk unavailable')
        return 'hello'
      }
      await openNotes()
      fail = true
      await act(async () => { vi.advanceTimersByTime(2_000) })
      await flush()
      expect(host.querySelector('.panel-error')?.textContent).toContain('Refresh failed')
      fail = false
      await act(async () => { vi.advanceTimersByTime(2_000) })
      await flush()
      expect(host.querySelector('.panel-error')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
