// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useFileWorkspaceStore, fileWorkspaceScope } from '../../src/renderer/stores/filesStore'
import { useReadAloudStore } from '../../src/renderer/readAloud/readAloudStore'
import { useMarkdownFileSpeech } from '../../src/renderer/readAloud/markdownFileSpeech'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@monaco-editor/react', () => ({ default: () => createElement('div', null, 'Source') }))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({
  MarkdownDocumentEditor: ({ onViewModeChange }: { onViewModeChange: (v: string) => void }) => createElement('button', { onClick: () => onViewModeChange('source') }, 'Source mode')
}))
vi.mock('../../src/renderer/components/FileTree', () => ({ FileTreeToolbar: () => null, FileTree: () => null }))
const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')
const { MainViewTabs } = await import('../../src/renderer/components/MainViewTabs')
const app = useAppStore.getState(), files = useFileWorkspaceStore.getState(), speech = useReadAloudStore.getState()
let host: HTMLElement, root: Root
const toggle = vi.fn((key: string) => useReadAloudStore.setState({ activeKey: key, status: 'playing' }))
const pause = vi.fn(() => useReadAloudStore.setState({ status: useReadAloudStore.getState().status === 'paused' ? 'playing' : 'paused' }))
const stop = vi.fn(() => useReadAloudStore.setState({ activeKey: null, status: 'idle' }))
const scope = fileWorkspaceScope('default', null, null)
const flush = async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)) }) }
const button = (label: string) => host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)
beforeEach(() => {
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => '/home/me', getActiveProjectPath: async () => null },
    workspace: { getStatus: async () => ({}) },
    fs: { readFile: async () => '# Notes\nRead this paragraph.', readFileInWorkspace: async () => ({ content: '# Notes\nRead this paragraph.', workspaceRoot: '/repo' }), writeFile: async () => {}, listDir: async () => [], listDrives: async () => ({ home: '/home/me', drives: [] }) }
  }
  useAppStore.setState({ profileId: 'default', activeThreadId: null, threads: [], projects: [], mainView: 'files', openedSurfaceKinds: ['files'], browserTabs: [], projectTerminalTabs: [], documentTabs: [] })
  useFileWorkspaceStore.setState({ workspaces: {} })
  useReadAloudStore.setState({ ...speech, toggle, togglePause: pause, stop })
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount()); host.remove()
  useAppStore.setState(app, true); useFileWorkspaceStore.setState(files, true); useReadAloudStore.setState(speech, true)
  useMarkdownFileSpeech.setState({ previews: {} })
})
async function open(path: string) {
  act(() => useFileWorkspaceStore.getState().openFile(scope, path))
  await act(async () => root.render(createElement('div', null, createElement(MainViewTabs), createElement(FilesPanel))))
  await flush()
}
it('reads a Markdown preview from its main pill, with waveform and pause/resume; Source stops it', async () => {
  await open('/home/me/notes.md')
  const read = button('Read aloud')!
  expect(read).not.toBeNull()
  expect(read.closest('.main-view-tab')?.textContent).toContain('notes.md')
  await act(async () => read.click())
  expect(toggle).toHaveBeenCalledWith(expect.any(String), '# Notes\nRead this paragraph.', { inThread: false })
  expect(button('Pause reading aloud')).not.toBeNull()
  await act(async () => button('Pause reading aloud')!.click())
  expect(button('Resume reading aloud')).not.toBeNull()
  await act(async () => button('Resume reading aloud')!.click())
  expect(pause).toHaveBeenCalledTimes(2)
  const source = [...host.querySelectorAll('button')].find(b => b.textContent === 'Source mode')!
  await act(async () => source.click())
  expect(button('Read aloud')).toBeNull()
  expect(stop).toHaveBeenCalled()
})
it.each(['txt', 'html'])('offers no speech for .%s files', async (extension) => {
  await open(`/home/me/notes.${extension}`)
  expect(button('Read aloud')).toBeNull()
})
it('cancels an unconfirmed voice selection when the preview closes', async () => {
  await open('/home/me/notes.md')
  const key = Object.keys(useMarkdownFileSpeech.getState().previews)[0]
  act(() => useReadAloudStore.setState({ pending: { key, text: 'Notes', threadId: null }, pickerOpen: true }))
  act(() => useFileWorkspaceStore.getState().closeFile(scope, '/home/me/notes.md'))
  await flush()
  expect(useReadAloudStore.getState().pending).toBeNull()
  expect(useReadAloudStore.getState().pickerOpen).toBe(false)
})
