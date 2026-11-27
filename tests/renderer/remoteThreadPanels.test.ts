// @vitest-environment jsdom
// The Files and Terminal tabs of a thread that runs on another computer. `files.root` is answered for a window of the
// thread's own computer only (the router refuses it from another), so the bridge here refuses it the same way.
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry } from '../../src/shared/types'
import { qualifyId } from '../../src/shared/threadRef'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useFileWorkspaceStore } from '../../src/renderer/stores/filesStore'
import { LOADER_DELAY_MS } from '../../src/renderer/components/ui/DelayedLoader'

vi.mock('@monaco-editor/react', () => ({ default: () => null }))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    loadAddon() {}
    open(parent: HTMLElement) { parent.appendChild(document.createElement('div')).className = 'xterm' }
    onData() { return { dispose() {} } }
    focus() {}
    write() {}
    dispose() {}
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} proposeDimensions() { return { cols: 80, rows: 24 } } } }))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')
const { ProjectTerminalPanel } = await import('../../src/renderer/components/ProjectTerminalPanel')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const NODE = 'nod_0123456789abcdefghjkmnpqrs'
const REMOTE = qualifyId(NODE, 'thread-1')
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()
let host: HTMLElement
let root: Root

function bridge(getStatus: () => Promise<unknown>, extra: Record<string, unknown> = {}) {
  const listDir = vi.fn(async (): Promise<FileEntry[]> => [{ name: 'README.md', path: 'README.md', kind: 'file' } as FileEntry])
  const create = vi.fn(async (_request: Record<string, unknown>) => ({ ptyId: 'pty-remote' }))
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: {
      getFilesRoot: async () => { throw new Error("Error invoking remote method 'app:getFilesRoot': files.root is not available from another computer") },
      getActiveProjectPath: async () => null
    },
    workspace: { getStatus },
    git: { onHeadsChanged: () => () => undefined },
    fs: { listDir, listDrives: async () => ({ home: '/home/me', drives: [] }) },
    pty: { list: async () => [], isAlive: async () => true, create, resize: async () => undefined, kill: async () => undefined, onData: () => () => undefined, onExit: () => () => undefined },
    ...extra
  }
  return { listDir, create }
}

function showRemoteThread(projectId: string | null) {
  useAppStore.setState({
    profileId: 'default',
    activeThreadId: REMOTE,
    threads: [{ id: REMOTE, node: NODE, projectId, name: 'Remote', startedAt: '2026-11-08T00:00:00.000Z' }] as never,
    openedSurfaceKinds: ['files'],
    mainView: 'files',
    mainAreaOpen: true
  })
}

beforeEach(() => {
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialApp, true)
  useFileWorkspaceStore.setState(initialFiles, true)
  vi.useRealTimers()
})

const flush = async () => { for (let i = 0; i < 4; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const rows = () => [...host.querySelectorAll('.file-tree-row')].map((row) => row.textContent)

describe('Files of a thread on another computer', () => {
  // What that computer's workspace lookup can answer, and where the tree then lists.
  it.each([
    ['its ready worktree', { metadata: { lifecycle: 'ready', generation: 1 }, execution: { projectPath: '/remote/worktree', primaryPath: '/remote/project', lifecycle: 'ready' } }],
    ['its project folder, before its worktree is made', { metadata: null, execution: { projectPath: '/remote/project', primaryPath: '/remote/project', lifecycle: 'unprovisioned' } }]
  ])('lists %s through the thread', async (_case, status) => {
    const { listDir } = bridge(async () => status)
    showRemoteThread(qualifyId(NODE, 'p1'))
    await act(async () => root.render(createElement(FilesPanel)))
    await flush()
    expect(rows()).toEqual(['README.md'])
    // Listed by the thread on its own computer, not by a folder named from here.
    expect(listDir).toHaveBeenCalledWith('', undefined, REMOTE, undefined)
  })

  it.each([
    ['that computer does not answer', qualifyId(NODE, 'p1'), async () => { throw new Error('The computer is offline') }],
    ['the thread has no folder', null, async () => ({ metadata: null, execution: { projectPath: '', primaryPath: '', lifecycle: 'unprovisioned' } })]
  ])('says the folder is unavailable when %s, instead of loading forever', async (_case, projectId, getStatus) => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { listDir } = bridge(getStatus)
    showRemoteThread(projectId)
    await act(async () => root.render(createElement(FilesPanel)))
    await flush()
    await act(async () => { vi.advanceTimersByTime(LOADER_DELAY_MS) })
    expect(host.querySelector('[aria-label="Loading files"]')).toBeNull()
    expect(host.textContent).toContain('The thread’s folder is unavailable.')
    expect(listDir).not.toHaveBeenCalled()
  })
})

describe('Terminal of a thread on another computer', () => {
  it('opens one with no folder named here, without waiting on the folder lookup', async () => {
    // The lookup never answers: the terminal there starts in the thread's own folder and needs none.
    const { create } = bridge(() => new Promise(() => undefined))
    showRemoteThread(qualifyId(NODE, 'p1'))
    useAppStore.setState({ mainView: 'terminal', projectTerminalTabs: [] })
    await act(async () => root.render(createElement(ProjectTerminalPanel)))
    await flush()
    const newTerminal = [...host.querySelectorAll('button')].find((button) => button.textContent === 'New terminal')
    expect(newTerminal).toBeDefined()
    await act(async () => newTerminal!.click())
    await flush()
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ threadId: REMOTE }))
    expect(create.mock.calls[0]![0]).not.toHaveProperty('cwd')
    expect(host.querySelector('.xterm-wrapper[data-pty-id="pty-remote"]')).not.toBeNull()
  })
})
