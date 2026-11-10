// @vitest-environment jsdom
/**
 * File links that arrive before the Files tab has mounted all open, through the real Files tab's open path. Each
 * open waits for the files root; an open that starts while another is still waiting replaces it, so the held
 * links must be opened one after another, not all at once.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useFileWorkspaceStore, fileWorkspaceScope } from '../../src/renderer/stores/filesStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@monaco-editor/react', () => ({ default: () => createElement('div', { className: 'editor-stub' }) }))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
vi.mock('../../src/renderer/components/ProjectTerminalPanel', () => ({ ProjectTerminalPanel: () => null }))
vi.mock('../../src/renderer/components/BrowserPanel', () => ({ BrowserPanel: () => null }))
vi.mock('../../src/renderer/components/changes/ChangesPanel', () => ({ ChangesPanel: () => createElement('div', { className: 'changes-stub' }) }))
vi.mock('../../src/renderer/components/PullRequestPanel', () => ({ PullRequestPanel: () => null }))

const { MainViewPanel } = await import('../../src/renderer/components/MainViewPanel')

let root: Root
let host: HTMLElement
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()
const rootRequests: Array<() => void> = []

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: {
      // Each open waits here; the test lets them through one at a time.
      getFilesRoot: () => new Promise<string>((done) => { rootRequests.push(() => done('/home/me')) }),
      getActiveProjectPath: async () => null
    },
    workspace: { getStatus: async () => ({}) },
    fs: { readFile: async () => 'hello', writeFile: async () => undefined, readAsset: async () => null, listDir: async () => [], listDrives: async () => ({ home: '/home/me', drives: [] }) },
    pty: { list: async () => [] },
    threads: { select: async () => undefined }
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  useAppStore.setState({ openedSurfaceKinds: ['git'], mainView: 'git', mainAreaOpen: true, activeThreadId: null })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialApp, true)
  useFileWorkspaceStore.setState(initialFiles, true)
  vi.unstubAllGlobals()
})

const settle = () => act(async () => { for (let i = 0; i < 20; i += 1) await new Promise((done) => setTimeout(done, 0)) })

it('opens every link held before the Files tab mounted, in order', async () => {
  act(() => root.render(createElement(MainViewPanel)))
  await settle()
  expect(host.querySelector('.files-panel')).toBeNull()
  act(() => {
    window.dispatchEvent(new CustomEvent('mousse:open-file', { detail: { path: 'a.ts' } }))
    window.dispatchEvent(new CustomEvent('mousse:open-file', { detail: { path: 'b.ts' } }))
    window.dispatchEvent(new CustomEvent('mousse:open-file', { detail: { path: 'c.ts' } }))
  })
  // The links mount the Files tab; its chunk loads and it opens them. Waiting roots are let through a batch at a
  // time (the tab also reads its own root when it mounts). Opened all at once, each open would replace the one
  // before it and only the last file would open.
  const openPaths = () => useFileWorkspaceStore.getState().workspaces[fileWorkspaceScope(useAppStore.getState().profileId, null, null)]?.openPaths ?? []
  for (let i = 0; i < 50 && openPaths().length < 3; i += 1) {
    await settle()
    const waiting = rootRequests.splice(0)
    await act(async () => { for (const release of waiting) release() })
  }
  await settle()
  expect(openPaths()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  expect(useAppStore.getState().openedSurfaceKinds).toContain('files')
})
