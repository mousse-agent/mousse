// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useFileWorkspaceStore } from '../../src/renderer/stores/filesStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The editor stub types into the open file, like the real editor's onChange. */
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (value: string) => void }) =>
    createElement('textarea', { className: 'editor-stub', value, onChange: (event: { target: { value: string } }) => onChange(event.target.value) })
}))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
vi.mock('../../src/renderer/components/FilesSearch', () => ({ FilesSearch: () => null }))
/** The tree stub shows one file row, or none when its folder is collapsed. */
const tree = { showRow: true }
vi.mock('../../src/renderer/components/FileTree', () => ({
  FileTreeToolbar: () => null,
  FileTree: ({ onSelectFile }: { onSelectFile: (path: string) => void }) => createElement('div', null,
    createElement('button', { type: 'button', className: 'tree-open', onClick: () => onSelectFile('notes.txt') }, 'open notes.txt'),
    tree.showRow && createElement('button', { type: 'button', className: 'file-tree-row', 'data-path': 'notes.txt' }, 'notes.txt'))
}))

const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')

let root: Root
let host: HTMLElement
let writeFile: ReturnType<typeof vi.fn>
const initialFiles = useFileWorkspaceStore.getState()

beforeEach(() => {
  tree.showRow = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  writeFile = vi.fn(async () => undefined)
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => '/repo' },
    fs: { readFile: async () => 'hello', writeFile, readAsset: async () => null },
    threads: { select: async () => undefined }
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useFileWorkspaceStore.setState(initialFiles, true)
})

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const tab = () => host.querySelector<HTMLButtonElement>('[role="tab"]')

async function openNotes() {
  await act(async () => root.render(createElement(FilesPanel)))
  await act(async () => host.querySelector<HTMLButtonElement>('.tree-open')?.click())
  await flush()
  expect(tab()?.textContent).toBe('notes.txt')
}

describe('closing the last open file', () => {
  it('with Delete, puts focus on the file’s row in the tree once the tab strip is gone', async () => {
    await openNotes()
    tab()!.focus()
    await act(async () => { tab()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })) })
    await flush()
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.file-tree-row'))
  })

  it('with the close button, puts focus on the empty editor when the file’s row is not shown', async () => {
    tree.showRow = false
    await openNotes()
    const close = host.querySelector<HTMLButtonElement>('.ui-tab-close')!
    close.focus()
    await act(async () => close.click())
    await flush()
    expect(host.querySelector('[role="tablist"]')).toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.files-editor-empty'))
    expect(document.activeElement?.textContent).toBe('Select a file from the tree')
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
