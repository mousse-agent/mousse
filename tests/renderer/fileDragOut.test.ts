// @vitest-environment jsdom
/**
 * Dragging a file out of the window: a file tree row and a composer chip hand the system the real file (the app's
 * `fileDrag` bridge, stubbed here), and the same drag dropped back on the composer still means what the window's own
 * drag meant: a tree row adds its reference, a chip is not attached twice. Any other dropped file is attached.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileTree } from '../../src/renderer/components/FileTree'
import { ChatComposer, type AttachedFile, type ChatComposerProps } from '../../src/renderer/components/ChatComposer'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { MOUSSE_REFERENCE_MIME } from '../../src/shared/chatReferences'
import type { FileEntry } from '../../src/shared/types'

vi.mock('../../src/renderer/dictation/useDictation', () => ({
  useDictation: () => ({ isRecording: false, recordingPending: false, transcribing: false, recordingDuration: 0, levels: null, error: undefined, dismissError: () => {}, notice: null, start: () => {}, stop: () => {} })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class NoResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const REMOTE = `nod_${'a'.repeat(26)}:t1`
const entries: Record<string, FileEntry[]> = { '': [{ name: 'README.md', path: 'README.md', kind: 'file' }] }

let roots: Root[]
let hosts: HTMLElement[]
let bridge: { start: ReturnType<typeof vi.fn>; startComposerFile: ReturnType<typeof vi.fn>; pathOf: ReturnType<typeof vi.fn> }
/** Where each dropped file is on this computer, as the preload's `pathOf` would say. */
const paths = new Map<File, string>()

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', NoResizeObserver)
  Element.prototype.scrollIntoView ??= () => {}
  // An attached image gets a preview URL.
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:preview')
  roots = []
  hosts = []
  paths.clear()
  bridge = {
    start: vi.fn(async (request: { item: { path?: string } }) => ({ path: `/work/app/${request.item.path}` })),
    startComposerFile: vi.fn(async (file: File) => ({ path: `/tmp/mousse-drag/x/${file.name}` })),
    pathOf: vi.fn((file: File) => paths.get(file) ?? '')
  }
  ;(window as unknown as { mousse: unknown }).mousse = { fs: { listDir: async (path: string) => entries[path] ?? [] }, fileDrag: bridge }
})

afterEach(() => {
  for (const root of roots) act(() => root.unmount())
  for (const host of hosts) host.remove()
  document.body.innerHTML = ''
  // The drag is over once the mouse moves with no button down.
  window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }))
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function mount(element: ReturnType<typeof createElement>): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  hosts.push(host)
  roots.push(root)
  await act(async () => { root.render(element) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return host
}

async function mountTree(threadId: string): Promise<HTMLElement> {
  useAppStore.setState({ activeThreadId: threadId, threads: [{ id: threadId, projectId: 'p1' }] as never })
  return mount(createElement(FileTree, { filesRoot: '/work/app', threadId, selectedPath: null, onSelectFile: () => undefined, refreshKey: 0 }))
}

async function mountComposer(attachedFiles: AttachedFile[] = []) {
  const onAttachedFilesChange = vi.fn()
  const onAddReference = vi.fn()
  const props: ChatComposerProps = {
    input: '',
    onInputChange: () => {},
    attachedFiles,
    onAttachedFilesChange,
    voiceMessages: [],
    onVoiceMessagesChange: () => {},
    enabledSkills: [],
    loading: false,
    disabled: false,
    onSend: () => {},
    onAddReference,
    mentionScope: { scopeKey: 't1', threadId: 't1' }
  }
  const host = await mount(createElement(ChatComposer, props))
  return { host, onAttachedFilesChange, onAddReference }
}

/** A `dragstart` on `element`; the reference data the window's own drag carries lands in `data`. */
async function dragStart(element: Element) {
  const data = new Map<string, string>()
  const event = new Event('dragstart', { bubbles: true, cancelable: true }) as Event & { dataTransfer: DataTransfer }
  Object.defineProperty(event, 'dataTransfer', { value: { setData: (type: string, value: string) => data.set(type, value), effectAllowed: 'none' } })
  await act(async () => { element.dispatchEvent(event) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return { event, data }
}

async function drop(composer: HTMLElement, files: File[]): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { types: ['Files'], files, getData: () => '' } })
  await act(async () => { composer.querySelector('[data-mousse="composer"]')!.dispatchEvent(event) })
}

const treeRow = (host: HTMLElement, path: string) => host.querySelector(`.file-tree-row[data-path="${path}"]`)!

describe('a file tree row', () => {
  it('drags the real file out, and dropped back on the composer adds its reference instead of attaching it', async () => {
    const tree = await mountTree('t1')
    const { event } = await dragStart(treeRow(tree, 'README.md'))
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.start).toHaveBeenCalledWith({ threadId: 't1', item: { kind: 'workspace', path: 'README.md' } })

    const composer = await mountComposer()
    const dropped = new File(['# app'], 'README.md')
    paths.set(dropped, '/work/app/README.md')
    await drop(composer.host, [dropped])
    expect(composer.onAddReference).toHaveBeenCalledWith(expect.objectContaining({ kind: 'file', title: 'README.md', path: '/work/app/README.md', threadId: 't1' }))
    expect(composer.onAttachedFilesChange).not.toHaveBeenCalled()
  })

  it('keeps the window\'s own drag for a thread on another computer', async () => {
    const tree = await mountTree(REMOTE)
    const { event, data } = await dragStart(treeRow(tree, 'README.md'))
    expect(event.defaultPrevented).toBe(false)
    expect(bridge.start).not.toHaveBeenCalled()
    expect(JSON.parse(data.get(MOUSSE_REFERENCE_MIME)!)).toMatchObject({ kind: 'file', title: 'README.md' })
  })
})

describe('a composer chip', () => {
  it('drags its file out, and dropped back on its composer is not attached a second time', async () => {
    const file = new File(['png'], 'shot.png', { type: 'image/png' })
    const composer = await mountComposer([{ id: 'a1', file }])
    const chip = composer.host.querySelector('.composer-attachments [draggable="true"]')!
    const { event } = await dragStart(chip)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge.startComposerFile).toHaveBeenCalledWith(file, { threadId: 't1' })

    const back = new File(['png'], 'shot.png', { type: 'image/png' })
    paths.set(back, '/tmp/mousse-drag/x/shot.png')
    await drop(composer.host, [back])
    expect(composer.onAttachedFilesChange).not.toHaveBeenCalled()
  })

  it('attaches any other dropped file, and the same file once the drag is over', async () => {
    const file = new File(['png'], 'shot.png', { type: 'image/png' })
    const composer = await mountComposer([{ id: 'a1', file }])
    await dragStart(composer.host.querySelector('.composer-attachments [draggable="true"]')!)
    const other = new File(['pdf'], 'report.pdf')
    paths.set(other, '/Users/me/report.pdf')
    await drop(composer.host, [other])
    expect(composer.onAttachedFilesChange).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }))
    const later = new File(['png'], 'shot.png', { type: 'image/png' })
    paths.set(later, '/tmp/mousse-drag/x/shot.png')
    await drop(composer.host, [later])
    expect(composer.onAttachedFilesChange).toHaveBeenCalledTimes(2)
  })
})
