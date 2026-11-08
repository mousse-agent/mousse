// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useFileWorkspaceStore } from '../../src/renderer/stores/filesStore'
import type { FileEntry, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@monaco-editor/react', () => ({ default: () => createElement('div', { className: 'editor-stub' }) }))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
vi.mock('../../src/renderer/components/FileTree', () => ({
  FileTreeToolbar: () => null,
  FileTree: () => createElement('div', { className: 'file-tree' }, createElement('button', { type: 'button', className: 'file-tree-row tree-stub' }, 'tree'))
}))

const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')

let root: Root
let host: HTMLElement
let listDir: ReturnType<typeof vi.fn>
let search: ReturnType<typeof vi.fn>
let filesRoot = '/home/me'
let projectFolder: string | null = null
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()

const disk: Record<string, FileEntry[]> = {
  '': [
    { name: 'docs', path: 'docs', kind: 'directory' },
    { name: 'node_modules', path: 'node_modules', kind: 'directory' },
    { name: 'notes.md', path: 'notes.md', kind: 'file' },
    { name: 'photo.png', path: 'photo.png', kind: 'file' }
  ],
  docs: [{ name: 'plan-notes.md', path: 'docs/plan-notes.md', kind: 'file' }]
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  listDir = vi.fn(async (dir: string) => disk[dir] ?? [])
  search = vi.fn(async () => ({
    root: '/repo', source: 'git', results: [{ path: 'src/notes.ts', kind: 'file', score: 1, positions: [] }],
    indexed: 1, indexedAt: null, truncated: false, indexing: false, complete: true
  }))
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => filesRoot, getActiveProjectPath: async () => projectFolder },
    workspace: { getStatus: async () => ({}) },
    fs: {
      listDir, search, readFile: async () => 'hello', writeFile: async () => undefined, readAsset: async () => null,
      listDrives: async () => ({ home: '/home/me', drives: [{ path: '/', label: '/' }] })
    },
    threads: { select: async () => undefined }
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialApp, true)
  useFileWorkspaceStore.setState(initialFiles, true)
  filesRoot = '/home/me'
  projectFolder = null
})

const flush = async (ms = 0) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) }) }
const header = () => host.querySelector('.files-header')!
const input = () => host.querySelector<HTMLInputElement>('.files-search-input')!
const rows = () => [...host.querySelectorAll('.files-search-row')].map((row) => row.textContent)
const browse = () => host.querySelector<HTMLElement>('.files-browse')!
const key = async (target: Element, init: KeyboardEventInit) => {
  await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })) })
}
const type = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush(200)
  await flush()
}

async function renderPanel() {
  await act(async () => root.render(createElement(FilesPanel)))
  await flush()
}

describe('search in the Files header', () => {
  it('replaces the title with a focused field, and Escape clears the text, then leaves search', async () => {
    await renderPanel()
    expect(header().classList.contains('searching')).toBe(false)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search files"]')!.click())
    expect(header().classList.contains('searching')).toBe(true)
    expect(host.querySelector('.files-header-title')!.hasAttribute('inert')).toBe(true)
    expect(document.activeElement).toBe(input())

    await type('notes')
    expect(browse().hidden).toBe(true)
    await key(input(), { key: 'Escape' })
    expect(input().value).toBe('')
    expect(browse().hidden).toBe(false)
    expect(header().classList.contains('searching')).toBe(true)

    await key(input(), { key: 'Escape' })
    expect(header().classList.contains('searching')).toBe(false)
    expect(host.querySelector('.files-header-search')!.hasAttribute('inert')).toBe(true)
  })

  it('opens with Ctrl+F from the tree, and closes with its close button', async () => {
    await renderPanel()
    await key(host.querySelector('.tree-stub')!, { key: 'f', ctrlKey: true })
    expect(header().classList.contains('searching')).toBe(true)
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close search"]')!.click())
    expect(header().classList.contains('searching')).toBe(false)
  })
})

describe('searching a folder that is not a project', () => {
  it('walks the folder in the path bar by name, without the project index, and opens a result', async () => {
    await renderPanel()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search files"]')!.click())
    await type('notes')
    expect(host.textContent).not.toContain('needs a project')
    expect(search).not.toHaveBeenCalled()
    expect(rows()).toEqual(['notes.md', 'plan-notes.mddocs/'])
    expect(listDir.mock.calls.map((call) => call[0])).not.toContain('node_modules')

    await key(input(), { key: 'Enter' })
    await flush()
    expect(host.querySelector('[role="tab"]')?.textContent).toContain('notes.md')
    // The results stay for the next pick.
    expect(rows()).toHaveLength(2)
  })
})

describe('searching inside the project', () => {
  it('uses the project index', async () => {
    filesRoot = '/repo'
    projectFolder = '/repo'
    useAppStore.setState({
      activeThreadId: 't1',
      threads: [{ id: 't1', name: 't1', projectId: 'p1', startedAt: '2026-11-01T00:00:00.000Z' } as unknown as Thread],
      projects: [{ id: 'p1', name: 'Repo', path: '/repo' }] as never
    })
    await renderPanel()
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Search files"]')!.click())
    await type('notes')
    expect(search).toHaveBeenCalledWith('notes', expect.anything(), 'p1', 't1')
    expect(rows()).toEqual(['notes.tssrc/'])
  })
})
