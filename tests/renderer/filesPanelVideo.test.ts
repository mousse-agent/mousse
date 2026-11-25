// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useFileWorkspaceStore } from '../../src/renderer/stores/filesStore'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@monaco-editor/react', () => ({ default: () => null }))
vi.mock('../../src/renderer/components/editors/MarkdownDocumentEditor', () => ({ MarkdownDocumentEditor: () => null }))
vi.mock('../../src/renderer/components/FileTree', () => ({
  FileTreeToolbar: () => null,
  FileTree: ({ onSelectFile }: { onSelectFile: (path: string) => void }) =>
    createElement('div', null,
      createElement('button', { type: 'button', className: 'open-video', onClick: () => onSelectFile('clip.mp4') }, 'clip.mp4'),
      createElement('button', { type: 'button', className: 'open-image', onClick: () => onSelectFile('shot.png') }, 'shot.png'))
}))

const { FilesPanel } = await import('../../src/renderer/components/FilesPanel')

let root: Root
let host: HTMLElement
const initialApp = useAppStore.getState()
const initialFiles = useFileWorkspaceStore.getState()

let readAsset: ReturnType<typeof vi.fn>
let assetStamp: ReturnType<typeof vi.fn>
let openMediaUrl: ReturnType<typeof vi.fn>
let releaseMediaUrl: ReturnType<typeof vi.fn>
let blobSeq = 0
let mediaSeq = 0

beforeEach(() => {
  blobSeq = 0
  mediaSeq = 0
  useAppStore.setState({ openedSurfaceKinds: ['files'], mainView: 'files' })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  readAsset = vi.fn(async () => ({
    data: new Uint8Array([137, 80, 78, 71]),
    mimeType: 'image/png',
    size: 4,
    mtimeMs: 100
  }))
  assetStamp = vi.fn(async () => ({ size: 50_000_000, mtimeMs: 100 }))
  openMediaUrl = vi.fn(async () => ({
    url: `mousse-media://asset/token-${++mediaSeq}`,
    mimeType: 'video/mp4',
    size: 50_000_000,
    mtimeMs: 100
  }))
  releaseMediaUrl = vi.fn(async () => undefined)
  URL.createObjectURL = vi.fn(() => `blob:test-${++blobSeq}`)
  URL.revokeObjectURL = vi.fn()
  ;(window as unknown as { mousse: unknown }).mousse = {
    app: { getFilesRoot: async () => '/repo' },
    fs: {
      readFile: async () => 'hello',
      readFileInWorkspace: async () => ({ content: 'hello', workspaceRoot: '/repo' }),
      writeFile: async () => undefined,
      readAsset,
      assetStamp,
      openMediaUrl,
      releaseMediaUrl
    },
    threads: { select: async () => undefined }
  }
  window.matchMedia = () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }) as unknown as MediaQueryList
})

afterEach(() => {
  vi.useRealTimers()
  act(() => root.unmount())
  host.remove()
  useAppStore.setState(initialApp, true)
  useFileWorkspaceStore.setState(initialFiles, true)
})

const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }

describe('FilesPanel video playback and asset polling', () => {
  it('streams videos via openMediaUrl without reading the full file, keeps playback uninterrupted across polls, and reloads only when changed', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    await act(async () => root.render(createElement(FilesPanel, { showing: true })))
    await act(async () => host.querySelector<HTMLButtonElement>('.open-video')!.click())
    await flush()

    const initialVideo = host.querySelector<HTMLVideoElement>('video')
    expect(initialVideo).not.toBeNull()
    expect(initialVideo!.getAttribute('src')).toBe('mousse-media://asset/token-1')
    expect(initialVideo!.getAttribute('preload')).toBe('metadata')
    expect(initialVideo!.playsInline).toBe(true)
    expect(openMediaUrl).toHaveBeenCalledTimes(1)
    expect(readAsset).not.toHaveBeenCalled()

    // Several 2-second poll ticks while unchanged: checks only 1-byte stamp, never reads full bytes or replaces <video>.
    for (let i = 0; i < 4; i++) {
      await act(async () => { vi.advanceTimersByTime(2_000) })
      await flush()
    }
    expect(assetStamp).toHaveBeenCalledTimes(4)
    expect(readAsset).not.toHaveBeenCalled()
    expect(openMediaUrl).toHaveBeenCalledTimes(1)
    expect(host.querySelector('video')).toBe(initialVideo)

    // When the file changes on disk, it opens a fresh streaming URL and releases the old one.
    assetStamp.mockResolvedValue({ size: 52_000_000, mtimeMs: 200 })
    openMediaUrl.mockResolvedValueOnce({
      url: 'mousse-media://asset/token-2',
      mimeType: 'video/mp4',
      size: 52_000_000,
      mtimeMs: 200
    })
    await act(async () => { vi.advanceTimersByTime(2_000) })
    await flush()

    expect(openMediaUrl).toHaveBeenCalledTimes(2)
    expect(releaseMediaUrl).toHaveBeenCalledWith('mousse-media://asset/token-1')
    expect(host.querySelector<HTMLVideoElement>('video')?.getAttribute('src')).toBe('mousse-media://asset/token-2')
  })

  it('does not overlap in-flight polls and stops polling when the panel is hidden', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    let resolveStamp!: (value: { size: number; mtimeMs: number }) => void
    assetStamp.mockImplementation(() => new Promise((resolve) => { resolveStamp = resolve }))

    await act(async () => root.render(createElement(FilesPanel, { showing: true })))
    await act(async () => host.querySelector<HTMLButtonElement>('.open-video')!.click())
    await flush()

    // First tick starts one stamp check; subsequent ticks while it is still pending do not pile up.
    await act(async () => { vi.advanceTimersByTime(6_000) })
    expect(assetStamp).toHaveBeenCalledTimes(1)

    await act(async () => resolveStamp({ size: 50_000_000, mtimeMs: 100 }))
    await flush()

    // Hiding the panel stops background polling completely.
    assetStamp.mockClear()
    await act(async () => root.render(createElement(FilesPanel, { showing: false })))
    await act(async () => { vi.advanceTimersByTime(10_000) })
    expect(assetStamp).not.toHaveBeenCalled()
  })

  it('releases the streaming handle when the panel unmounts', async () => {
    await act(async () => root.render(createElement(FilesPanel, { showing: true })))
    await act(async () => host.querySelector<HTMLButtonElement>('.open-video')!.click())
    await flush()
    expect(host.querySelector('video')?.getAttribute('src')).toBe('mousse-media://asset/token-1')

    act(() => root.unmount())
    expect(releaseMediaUrl).toHaveBeenCalledWith('mousse-media://asset/token-1')
  })

  it('uses assetStamp for image previews too and rereads bytes only when the stamp changes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    assetStamp.mockResolvedValue({ size: 4, mtimeMs: 100 })
    await act(async () => root.render(createElement(FilesPanel, { showing: true })))
    await act(async () => host.querySelector<HTMLButtonElement>('.open-image')!.click())
    await flush()

    expect(readAsset).toHaveBeenCalledTimes(1)
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:test-1')

    for (let i = 0; i < 3; i++) {
      await act(async () => { vi.advanceTimersByTime(2_000) })
      await flush()
    }
    expect(assetStamp).toHaveBeenCalledTimes(3)
    expect(readAsset).toHaveBeenCalledTimes(1)

    // File changed on disk -> rereads bytes and swaps blob URL.
    assetStamp.mockResolvedValue({ size: 5, mtimeMs: 200 })
    readAsset.mockResolvedValueOnce({
      data: new Uint8Array([137, 80, 78, 71, 1]),
      mimeType: 'image/png',
      size: 5,
      mtimeMs: 200
    })
    await act(async () => { vi.advanceTimersByTime(2_000) })
    await flush()
    expect(readAsset).toHaveBeenCalledTimes(2)
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:test-1')
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:test-2')
  })
})
