// @vitest-environment jsdom
import { act, createElement, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '../../src/shared/types'
import { MOUSSE_REFERENCE_MIME } from '../../src/shared/chatReferences'
import { TabBar } from '../../src/renderer/components/ui/TabBar'
import { FileTree } from '../../src/renderer/components/FileTree'
import { DocumentPanel } from '../../src/renderer/components/DocumentPanel'
import { ProjectTerminalPanel } from '../../src/renderer/components/ProjectTerminalPanel'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { LOADER_DELAY_MS } from '../../src/renderer/components/ui/DelayedLoader'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const initialStore = useAppStore.getState()

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`)
  return value
}
const press = async (element: Element, key: string, init: KeyboardEventInit = {}) => {
  await act(async () => { element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })) })
}
const click = async (element: Element | null | undefined) => {
  await act(async () => { (must(element, 'element') as HTMLElement).click() })
}
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const tabButtons = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
const buttonByText = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === text)

describe('shared tab strip', () => {
  function Harness({ refuse = new Set<string>() }: { refuse?: Set<string> }) {
    const [tabs, setTabs] = useState(['a.ts', 'b.ts', 'c.ts'])
    const [active, setActive] = useState<string | null>('b.ts')
    return createElement(TabBar, {
      label: 'Open files',
      activeId: active,
      tabs: tabs.map((id) => ({ id, name: id })),
      onSelect: setActive,
      onClose: async (id: string) => {
        if (refuse.has(id)) return false
        const index = tabs.indexOf(id)
        const next = tabs.filter((tab) => tab !== id)
        setTabs(next)
        if (active === id) setActive(next[Math.min(index, next.length - 1)] ?? null)
        return true
      }
    })
  }

  it('gives the strip one tab stop and moves selection with the arrow keys, Home and End', async () => {
    await act(async () => root.render(createElement(Harness)))
    expect(tabButtons().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1])
    expect(host.querySelectorAll('.ui-tab-close')[0].getAttribute('aria-label')).toBe('Close a.ts')
    tabButtons()[1].focus()
    await press(tabButtons()[1], 'ArrowRight')
    expect(document.activeElement?.textContent).toBe('c.ts')
    expect(tabButtons()[2].getAttribute('aria-selected')).toBe('true')
    await press(tabButtons()[2], 'ArrowRight')
    expect(document.activeElement?.textContent).toBe('a.ts')
    await press(tabButtons()[0], 'End')
    expect(document.activeElement?.textContent).toBe('c.ts')
    await press(tabButtons()[2], 'Home')
    expect(document.activeElement?.textContent).toBe('a.ts')
    // The selected tab is a filled background: the class carries it, never an edge.
    expect(host.querySelector('.ui-tab.active')?.textContent).toBe('a.ts')
  })

  it('closes the focused tab with Delete and puts focus on the tab selected next', async () => {
    await act(async () => root.render(createElement(Harness)))
    tabButtons()[1].focus()
    await press(tabButtons()[1], 'Delete')
    await flush()
    expect(tabButtons().map((tab) => tab.textContent)).toEqual(['a.ts', 'c.ts'])
    expect(document.activeElement?.textContent).toBe('c.ts')
    await press(tabButtons()[1], 'Delete')
    await flush()
    expect(document.activeElement?.textContent).toBe('a.ts')
    await press(tabButtons()[0], 'Delete')
    await flush()
    expect(tabButtons()).toHaveLength(0)
    expect(document.activeElement?.getAttribute('role')).toBe('tablist')
  })

  it('keeps a tab that refuses to close, and focus on it', async () => {
    await act(async () => root.render(createElement(Harness, { refuse: new Set(['b.ts']) })))
    tabButtons()[1].focus()
    await press(tabButtons()[1], 'Delete')
    await flush()
    expect(tabButtons()).toHaveLength(3)
    expect(document.activeElement?.textContent).toBe('b.ts')
  })
})

describe('Files tree', () => {
  const entries: Record<string, FileEntry[]> = {
    '': [{ name: 'src', path: 'src', kind: 'directory' } as FileEntry, { name: 'README.md', path: 'README.md', kind: 'file' } as FileEntry],
    src: [{ name: 'main.ts', path: 'src/main.ts', kind: 'file' } as FileEntry]
  }

  function mountTree(listDir: (path: string) => Promise<FileEntry[]>) {
    ;(window as unknown as { mousse: unknown }).mousse = { fs: { listDir } }
    useAppStore.setState({ activeThreadId: 't1', threads: [{ id: 't1', projectId: 'p1' }] as never })
    return act(async () => root.render(createElement(FileTree, {
      filesRoot: '/work/app', rootLabel: 'app', threadId: 't1', selectedPath: null, onSelectFile: () => undefined, refreshKey: 0
    })))
  }
  const row = (name: string) => must([...host.querySelectorAll<HTMLButtonElement>('.file-tree-row')].find((button) => button.textContent === name), name)

  it('shows Retry in place when a folder cannot be read, and Retry reads only that folder again', async () => {
    let failSrc = true
    const listDir = vi.fn(async (path: string) => {
      if (path === 'src' && failSrc) throw new Error('EACCES: permission denied')
      return entries[path]
    })
    await mountTree(listDir)
    await click(row('src'))
    await flush()
    const error = must(host.querySelector('.file-tree-children .file-tree-error'), 'folder error')
    expect(error.getAttribute('role')).toBe('alert')
    expect(error.textContent).toContain('Couldn’t read this folder')
    expect(error.querySelector('span')?.getAttribute('title')).toContain('EACCES')
    // The rest of the tree stays.
    expect(row('README.md')).toBeTruthy()
    failSrc = false
    const rootReads = listDir.mock.calls.filter(([path]) => path === '').length
    await click(error.querySelector('button'))
    await flush()
    expect(row('main.ts')).toBeTruthy()
    expect(host.querySelector('.file-tree-error')).toBeNull()
    expect(listDir.mock.calls.filter(([path]) => path === '').length).toBe(rootReads)
  })

  it('shows Retry when the root cannot be read', async () => {
    let fail = true
    await mountTree(async (path) => {
      if (fail) throw new Error('offline')
      return entries[path]
    })
    await flush()
    const error = must(host.querySelector('.file-tree-error'), 'root error')
    fail = false
    await click(error.querySelector('button'))
    await flush()
    expect(row('README.md')).toBeTruthy()
  })

  it('opens the row menu with Shift+F10; Add to chat adds the same scoped reference a drag carries', async () => {
    await mountTree(async (path) => entries[path])
    await flush()
    const readme = row('README.md')
    readme.focus()
    await press(readme, 'F10', { shiftKey: true })
    const menu = must(document.querySelector('[role="menu"]'), 'menu')
    expect(menu.getAttribute('aria-label')).toBe('Actions for README.md')
    expect(document.activeElement?.textContent).toBe('Add to chat')
    await click(buttonByText('Add to chat'))
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(readme)

    const added = useAppStore.getState().composerReferences.t1
    expect(added).toHaveLength(1)
    const data = new Map<string, string>()
    const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), effectAllowed: 'none' } as unknown as DataTransfer
    const dragStart = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: DataTransfer }
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
    await act(async () => { readme.dispatchEvent(dragStart) })
    const dragged = JSON.parse(must(data.get(MOUSSE_REFERENCE_MIME), 'drag payload'))
    const { id: _addedId, ...addedRest } = added[0]
    const { id: _dragId, ...draggedRest } = dragged
    expect(addedRest).toEqual(draggedRest)
    expect(addedRest).toEqual({ kind: 'file', title: 'README.md', path: '/work/app/README.md', threadId: 't1', projectId: 'p1' })
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Added README.md to chat')
  })

  it('copies the full path from the menu, and says so when the clipboard refuses', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await mountTree(async (path) => entries[path])
    await flush()
    const folder = row('src')
    await act(async () => { folder.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
    await click(buttonByText('Copy path'))
    await flush()
    expect(writeText).toHaveBeenCalledWith('/work/app/src')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Path copied')

    writeText.mockRejectedValueOnce(new Error('denied'))
    await click(host.querySelector('.file-tree-more'))
    await click(buttonByText('Copy path'))
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t copy the path')
  })

  it('closes the menu with Escape and returns focus to the row', async () => {
    await mountTree(async (path) => entries[path])
    await flush()
    const readme = row('README.md')
    readme.focus()
    await press(readme, 'ContextMenu')
    await press(must(document.activeElement, 'menu item'), 'Escape')
    expect(document.querySelector('[role="menu"]')).toBeNull()
    expect(document.activeElement).toBe(readme)
  })
})

describe('Documents', () => {
  const docs = [
    { id: 'd1', title: 'Plan', markdown: '# Plan\n\n- one\n' },
    { id: 'd2', title: 'Notes', markdown: 'Some *notes*' }
  ]

  it('says one muted line when nothing is open', async () => {
    useAppStore.setState({ documentTabs: [], activeDocumentTabId: null })
    await act(async () => root.render(createElement(DocumentPanel)))
    expect(host.textContent).toBe('No documents open')
    expect(host.querySelector('svg')).toBeNull()
  })

  it('copies the active document’s exact Markdown and announces it', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    useAppStore.setState({ documentTabs: docs as never, activeDocumentTabId: 'd2' })
    await act(async () => root.render(createElement(DocumentPanel)))
    await click(host.querySelector('button[aria-label="Copy Markdown"]'))
    await flush()
    expect(writeText).toHaveBeenCalledWith('Some *notes*')
    expect(host.querySelector('[role="status"]')?.textContent).toBe('Copied')
  })

  it('shows a copy failure', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('denied') } }, configurable: true })
    useAppStore.setState({ documentTabs: docs as never, activeDocumentTabId: 'd1' })
    await act(async () => root.render(createElement(DocumentPanel)))
    await click(host.querySelector('button[aria-label="Copy Markdown"]'))
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Couldn’t copy the Markdown')
  })

  it('switches and closes the exact document from the keyboard', async () => {
    useAppStore.setState({ documentTabs: [...docs, { id: 'd3', title: 'Spec', markdown: 'spec' }] as never, activeDocumentTabId: 'd1' })
    await act(async () => root.render(createElement(DocumentPanel)))
    tabButtons()[0].focus()
    await press(tabButtons()[0], 'ArrowRight')
    expect(useAppStore.getState().activeDocumentTabId).toBe('d2')
    await press(tabButtons()[1], 'Delete')
    await flush()
    expect(useAppStore.getState().documentTabs.map((tab) => tab.id)).toEqual(['d1', 'd3'])
    expect(document.activeElement?.textContent).toBe('Spec')
    expect(host.querySelector('.document-preview-body')?.textContent).toBe('spec')
  })
})

describe('terminal held on another computer', () => {
  function mountTerminal(kill: (ptyId: string) => Promise<void>) {
    ;(window as unknown as { mousse: unknown }).mousse = {
      app: { getFilesRoot: async () => '/work/app' },
      pty: {
        list: async () => [{ ptyId: 'pty-9', heldBy: { name: 'Laptop' } }],
        kill,
        onData: () => () => undefined,
        onExit: () => () => undefined
      }
    }
    useAppStore.setState({ activeThreadId: 't1', mainView: 'terminal', projectTerminalTabs: [], threads: [{ id: 't1', projectId: 'p1' }] as never })
    return act(async () => root.render(createElement(ProjectTerminalPanel)))
  }

  it('keeps the holder and the error when Stop fails, and removes it once Retry succeeds', async () => {
    let fail = true
    const kill = vi.fn(async () => { if (fail) throw new Error('offline') })
    await mountTerminal(kill)
    await flush()
    expect(host.querySelector('.terminal-remote-holder')?.textContent).toContain('Laptop has a terminal open')
    await click(buttonByText('Stop'))
    await flush()
    expect(host.querySelector('.terminal-remote-holder')).not.toBeNull()
    expect(host.querySelector('.terminal-remote-holder [role="alert"]')?.textContent).toBe('Couldn’t stop it')
    fail = false
    await click(buttonByText('Retry'))
    await flush()
    expect(kill).toHaveBeenCalledTimes(2)
    expect(host.querySelector('.terminal-remote-holder')).toBeNull()
  })

  it('shows no loading text while the folder is unknown, only the delayed loader', async () => {
    vi.useFakeTimers()
    ;(window as unknown as { mousse: unknown }).mousse = {
      app: { getFilesRoot: () => new Promise(() => undefined) },
      pty: { list: async () => [], kill: async () => undefined, onData: () => () => undefined, onExit: () => () => undefined }
    }
    useAppStore.setState({ activeThreadId: 't1', mainView: 'terminal', projectTerminalTabs: [] })
    await act(async () => root.render(createElement(ProjectTerminalPanel)))
    expect(host.textContent).toBe('')
    expect(host.querySelector('[role="status"]')).toBeNull()
    await act(async () => { vi.advanceTimersByTime(LOADER_DELAY_MS) })
    expect(host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe('Loading terminal')
    expect(host.textContent).toBe('')
  })
})
