// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '../../src/shared/types'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useFileWorkspaceStore, fileWorkspaceScope } from '../../src/renderer/stores/filesStore'
import { FileTree, FILE_TREE_ROW_HEIGHT } from '../../src/renderer/components/FileTree'
import { FileTreeMemory } from '../../src/renderer/components/fileTreeState'
import { rowWindow, UNMEASURED_ROWS } from '../../src/renderer/lib/virtualRows'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@monaco-editor/react', () => ({ default: () => createElement('div', { className: 'editor-stub' }) }))
// The Markdown editor shows what the panel hands it, with its Source and Preview switch.
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({
  MarkdownDocumentEditor: ({ path, keepModel, viewMode, onViewModeChange }: {
    path: string; keepModel?: boolean; viewMode?: string; onViewModeChange?: (mode: 'source' | 'preview') => void
  }) => createElement('div', { className: 'markdown-stub', 'data-path': path, 'data-keep': String(Boolean(keepModel)), 'data-view': viewMode },
    createElement('button', { type: 'button', className: 'markdown-source', onClick: () => onViewModeChange?.('source') }, 'Source'))
}))
// The other tabs: each says it is mounted. Terminals and browsers are not what these tests read.
vi.mock('../../src/renderer/components/ProjectTerminalPanel', () => ({ ProjectTerminalPanel: () => createElement('div', { className: 'terminal-stub' }) }))
vi.mock('../../src/renderer/components/BrowserPanel', () => ({ BrowserPanel: () => createElement('div', { className: 'browser-stub' }) }))
vi.mock('../../src/renderer/components/changes/ChangesPanel', () => ({ ChangesPanel: () => createElement('div', { className: 'changes-stub' }) }))
vi.mock('../../src/renderer/components/PullRequestPanel', () => ({ PullRequestPanel: () => createElement('div', { className: 'pr-stub' }) }))

const { MainViewPanel } = await import('../../src/renderer/components/MainViewPanel')

const HOME_ROWS = 557
const homeEntries: FileEntry[] = Array.from({ length: HOME_ROWS }, (_, index) => {
  const name = `${index < 20 ? 'dir' : 'file'}-${String(index).padStart(3, '0')}`
  return { name, path: name, kind: index < 20 ? 'directory' : 'file' } as FileEntry
})
const folderEntries: Record<string, FileEntry[]> = {
  'dir-000': [{ name: 'inner.ts', path: 'dir-000/inner.ts', kind: 'file' } as FileEntry]
}

let root: Root
let host: HTMLElement
let listDir: ReturnType<typeof vi.fn>
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  listDir = vi.fn(async (dir: string) => (dir === '' ? homeEntries : folderEntries[dir] ?? []))
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => '/home/me', getActiveProjectPath: async () => null },
    workspace: { getStatus: async () => ({}) },
    fs: { readFile: async () => 'hello', writeFile: async () => undefined, readAsset: async () => null, listDir, listDrives: async () => ({ home: '/home/me', drives: [] }) },
    pty: { list: async () => [] },
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
const rowNames = () => [...host.querySelectorAll('.file-tree-row')].map((row) => row.textContent)
const scroller = () => host.querySelector<HTMLElement>('.file-tree')!

/** Gives the tree a viewport jsdom does not lay out: `rows` rows tall. */
function sizeViewport(rows: number) {
  Object.defineProperty(scroller(), 'clientHeight', { configurable: true, value: rows * FILE_TREE_ROW_HEIGHT })
}
async function scrollTo(top: number) {
  await act(async () => {
    scroller().scrollTop = top
    scroller().dispatchEvent(new Event('scroll'))
  })
}

function renderTree(memory?: FileTreeMemory) {
  return act(async () => root.render(createElement(FileTree, {
    filesRoot: '/home/me', threadId: null, selectedPath: null, onSelectFile: () => undefined, refreshKey: 0, memory
  })))
}

describe('row window', () => {
  it('covers the viewport plus overscan, and a fixed number of rows before the list is measured', () => {
    expect(rowWindow(100, 10, HOME_ROWS, 8)).toEqual({ start: 92, end: 118 })
    expect(rowWindow(0, 0, HOME_ROWS, 8)).toEqual({ start: 0, end: UNMEASURED_ROWS + 8 })
    expect(rowWindow(550, 20, HOME_ROWS, 8)).toEqual({ start: 542, end: HOME_ROWS })
  })
})

describe('Files tree with a long folder', () => {
  it('draws only the rows on screen, at the full scroll height', async () => {
    await renderTree()
    await flush()
    const drawn = rowNames()
    expect(drawn.length).toBeGreaterThan(0)
    expect(drawn.length).toBeLessThanOrEqual(UNMEASURED_ROWS + 8)
    expect(host.querySelector<HTMLElement>('.file-tree-list')!.style.height).toBe(`${HOME_ROWS * FILE_TREE_ROW_HEIGHT}px`)

    sizeViewport(10)
    await scrollTo(300 * FILE_TREE_ROW_HEIGHT)
    const scrolled = rowNames()
    expect(scrolled.length).toBe(10 + 2 * 8)
    expect(scrolled[0]).toBe('file-292')
    expect(scrolled).toContain('file-300')
    expect(scrolled).not.toContain('dir-000')
  })

  it('comes back with its open folders and scroll offset at once, then reads them again quietly', async () => {
    const memory = new FileTreeMemory()
    await renderTree(memory)
    await flush()
    await act(async () => host.querySelector<HTMLButtonElement>('.file-tree-row[data-path="dir-000"]')!.click())
    await flush()
    expect(rowNames().slice(0, 3)).toEqual(['dir-000', 'inner.ts', 'dir-001'])
    sizeViewport(10)
    await scrollTo(40 * FILE_TREE_ROW_HEIGHT)
    act(() => root.unmount())

    // Reads that never answer: anything on screen now comes from what the tree kept.
    listDir.mockImplementation(() => new Promise(() => undefined))
    root = createRoot(host)
    await renderTree(memory)
    expect(host.querySelector('[aria-label="Loading files"]')).toBeNull()
    expect(scroller().scrollTop).toBe(40 * FILE_TREE_ROW_HEIGHT)
    expect(rowNames()).toContain('file-040')
    await scrollTo(0)
    expect(rowNames().slice(0, 3)).toEqual(['dir-000', 'inner.ts', 'dir-001'])
    // The folder and its open subfolder are read again behind the kept rows.
    expect(listDir.mock.calls.slice(-2).map(([dir]) => dir).sort()).toEqual(['', 'dir-000'])
  })
})

describe('Files tab while hidden', () => {
  const scope = () => fileWorkspaceScope(useAppStore.getState().profileId, null, null)

  async function renderPanel(open: boolean) {
    await act(async () => root.render(createElement(MainViewPanel, { open })))
    await flush()
  }

  beforeEach(() => {
    useAppStore.setState({ openedSurfaceKinds: ['files', 'git'], mainView: 'files', mainAreaOpen: true, activeThreadId: null })
  })

  it('mounts nothing of the tab while the panel is closed', async () => {
    useAppStore.setState({ mainAreaOpen: false })
    await renderPanel(true)
    expect(host.querySelector('.files-panel')).toBeNull()
    expect(host.querySelector('.file-tree-row')).toBeNull()
    expect(listDir).not.toHaveBeenCalled()

    // Closed by the layout (another workspace shows) counts the same.
    useAppStore.setState({ mainAreaOpen: true })
    await renderPanel(false)
    expect(host.querySelector('.files-panel')).toBeNull()
  })

  it('unmounts the tree when the panel closes or another tab shows, and restores folders, scroll and selection', async () => {
    await renderPanel(true)
    expect(rowNames().length).toBeGreaterThan(0)
    await act(async () => host.querySelector<HTMLButtonElement>('.file-tree-row[data-path="dir-000"]')!.click())
    await flush()
    await act(async () => host.querySelector<HTMLButtonElement>('.file-tree-row[data-path="dir-000/inner.ts"]')!.click())
    await flush()
    expect(useFileWorkspaceStore.getState().workspaces[scope()]?.activePath).toBe('dir-000/inner.ts')
    sizeViewport(10)
    await scrollTo(FILE_TREE_ROW_HEIGHT)

    act(() => useAppStore.setState({ mainAreaOpen: false }))
    await flush()
    expect(host.querySelector('.files-panel')).toBeNull()
    expect(host.querySelector('.editor-stub')).toBeNull()

    act(() => useAppStore.setState({ mainAreaOpen: true }))
    await flush()
    expect(scroller().scrollTop).toBe(FILE_TREE_ROW_HEIGHT)
    await scrollTo(0)
    expect(rowNames().slice(0, 2)).toEqual(['dir-000', 'inner.ts'])
    expect(host.querySelector('.file-tree-item.selected .file-tree-row')?.getAttribute('data-path')).toBe('dir-000/inner.ts')
    expect(host.querySelector('.editor-stub')).not.toBeNull()

    act(() => useAppStore.setState({ mainView: 'git' }))
    await flush()
    expect(host.querySelector('.files-panel')).toBeNull()
    expect(host.querySelector('.changes-stub')).not.toBeNull()
    act(() => useAppStore.setState({ mainView: 'files' }))
    await flush()
    await scrollTo(0)
    expect(rowNames().slice(0, 2)).toEqual(['dir-000', 'inner.ts'])
  })

  it('focuses the row of a closed preview after bringing it back into the drawn rows', async () => {
    await renderPanel(true)
    sizeViewport(10)
    await scrollTo(500 * FILE_TREE_ROW_HEIGHT)
    await act(async () => host.querySelector<HTMLButtonElement>('.file-tree-row[data-path="file-500"]')!.click())
    await flush()
    await scrollTo(0)
    expect(host.querySelector('.file-tree-row[data-path="file-500"]')).toBeNull()

    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close preview"]')!.click())
    await flush()
    expect((document.activeElement as HTMLElement | null)?.dataset.path).toBe('file-500')
    const top = scroller().scrollTop
    expect(top).toBeLessThanOrEqual(500 * FILE_TREE_ROW_HEIGHT)
    expect(top + 10 * FILE_TREE_ROW_HEIGHT).toBeGreaterThan(500 * FILE_TREE_ROW_HEIGHT)
  })

  it('brings a Markdown file back in the view it was left in, on its own kept model', async () => {
    listDir.mockImplementation(async (dir: string) => (dir === '' ? [{ name: 'notes.md', path: 'notes.md', kind: 'file' } as FileEntry] : []))
    await renderPanel(true)
    await act(async () => host.querySelector<HTMLButtonElement>('.file-tree-row[data-path="notes.md"]')!.click())
    await flush()
    const markdown = () => host.querySelector<HTMLElement>('.markdown-stub')
    expect(markdown()?.dataset.view).toBe('preview')
    // Named by the workspace, as other files are, so another thread's notes.md keeps its own model.
    expect(markdown()?.dataset.path).toBe(`${scope()} notes.md`)
    expect(markdown()?.dataset.keep).toBe('true')
    await act(async () => host.querySelector<HTMLButtonElement>('.markdown-source')!.click())
    expect(markdown()?.dataset.view).toBe('source')

    act(() => useAppStore.setState({ mainAreaOpen: false }))
    await flush()
    expect(markdown()).toBeNull()
    act(() => useAppStore.setState({ mainAreaOpen: true }))
    await flush()
    expect(markdown()?.dataset.view).toBe('source')
  })

  it('does not mount the Changes tab while the panel is closed', async () => {
    useAppStore.setState({ mainView: 'git', mainAreaOpen: false })
    await renderPanel(true)
    expect(host.querySelector('.changes-stub')).toBeNull()
    act(() => useAppStore.setState({ mainAreaOpen: true }))
    await flush()
    expect(host.querySelector('.changes-stub')).not.toBeNull()
  })
})
