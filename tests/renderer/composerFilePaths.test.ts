// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer and its notices only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer, children }: { composer: never; children?: never }) => create(ComposerNoticeProvider, null, children, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let orchestrator: Record<string, unknown>
let threads: Record<string, unknown>

/** `window.mousse` for the chat: `orchestrator` and `threads` overrides answer; any other call stays pending. */
function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        if (key.startsWith('on')) return () => () => {}
        return () => pending()
      }
    })
  const sections: Record<string, unknown> = {
    orchestrator: section(orchestrator),
    threads: section(threads),
    // A pasted file has no path of its own.
    fileDrag: section({ pathOf: () => '' }),
    skills: section({ list: () => Promise.resolve({ skills: [] }) })
  }
  ;(window as unknown as { mousse: unknown }).mousse = new Proxy(sections, {
    get: (target, key) => {
      if (typeof key !== 'string') return undefined
      if (!(key in target)) target[key] = section({})
      return target[key]
    }
  })
}

async function settle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

async function mount(): Promise<void> {
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
}

const box = () => host.querySelector<HTMLTextAreaElement>('.composer-input')!

/** A paste in the composer whose clipboard holds `files` and, when given, `text`. Returns whether it was taken. */
async function paste(files: File[], text?: string): Promise<boolean> {
  const items = [
    ...files.map((file) => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    ...(text !== undefined ? [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] : [])
  ]
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { items, files, types: [], getData: () => text ?? '' } })
  await act(async () => { box().dispatchEvent(event) })
  return event.defaultPrevented
}

async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box(), text)
    box().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pressEnter(): Promise<void> {
  await act(async () => { box().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
}

async function remoteThread(): Promise<void> {
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  const now = new Date().toISOString()
  useAppStore.setState({ threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0, node: 'node-mac' }] as never })
}

/** A PNG of `width` × `height` as far as its header goes: what the composer reads of it before sending it as it is. */
function png(name: string, width = 32, height = 32): File {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return new File([bytes], name, { type: 'image/png' })
}

const sendButton = () => host.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')

const chipNames = () => [...host.querySelectorAll('.composer-attachments [title]')].map((node) => node.textContent?.trim()).filter(Boolean)

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:preview'), revokeObjectURL: vi.fn() }))
  orchestrator = {
    sendToThread: vi.fn(async () => ({ message: '', actions: [] })),
    isTurnActive: vi.fn(async () => false)
  }
  threads = {
    // A pasted file has no path of its own: the app writes it under the thread's temporary folder.
    attachmentPath: vi.fn(async (file: File, threadId: string | null) => `/tmp/mousse-attachments/${threadId}/1a2b3c4d-${file.name}`)
  }
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false,
    activeThreadId: 'thread-a',
    threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 }] as never,
    messages: [{ id: 'm-1', role: 'user', content: 'First message', timestamp: now }] as never
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

describe('a video or other file pasted in the composer', () => {
  it('becomes a chip, and the model gets its path in the message', async () => {
    await mount()
    const clip = new File([new Uint8Array([0, 0, 0, 24])], 'clip.mp4', { type: 'video/mp4' })
    expect(await paste([clip])).toBe(true)
    expect(chipNames()).toContain('clip.mp4')

    await type('what happens at 0:03?')
    await pressEnter()

    expect(threads.attachmentPath).toHaveBeenCalledWith(clip, 'thread-a')
    const [threadId, request] = (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, { content: string; images?: unknown[] }]
    expect(threadId).toBe('thread-a')
    expect(request.content).toBe('what happens at 0:03?\n\n[Attached files: clip.mp4 (/tmp/mousse-attachments/thread-a/1a2b3c4d-clip.mp4)]')
    expect(request.images ?? []).toEqual([])
  })

  it('names a file pasted without a name by the time and its type', async () => {
    await mount()
    await paste([new File([new Uint8Array([1])], 'blob', { type: 'video/webm' })])
    expect(chipNames().some((name) => /^paste-\d+\.webm$/.test(name!))).toBe(true)
  })

  it('leaves a paste of text alone, so the text is pasted', async () => {
    await mount()
    expect(await paste([], 'just words')).toBe(false)
    expect(chipNames()).toEqual([])
  })

  it('keeps the file and says why when it cannot be staged', async () => {
    threads.attachmentPath = vi.fn(async () => { throw new Error("Error invoking remote method 'attachments:stage': Error: clip.mp4 is larger than 200 MB. Drop or attach the file instead of pasting it.") })
    await mount()
    await paste([new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' })])
    await type('look')
    await pressEnter()
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    expect(host.textContent).toContain('clip.mp4 is larger than 200 MB.')
    expect(chipNames()).toContain('clip.mp4')
  })

  it('is refused as it is attached on a thread whose agent runs on another computer, with a line naming it', async () => {
    await remoteThread()
    await mount()
    await paste([new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' })])
    expect(chipNames()).toEqual([])
    expect(host.textContent).toContain("clip.mp4 wasn't attached")
    await type('look')
    await pressEnter()
    expect(threads.attachmentPath).not.toHaveBeenCalled()
  })
})

describe('a screenshot pasted in the composer', () => {
  /** What each attached image is called on its tile, in order. */
  const imageNames = () => [...host.querySelectorAll<HTMLElement>('.composer-attachments [data-attachment-id]')].map((tile) => tile.title.split(': ')[0])
  // A clipboard names every screenshot `image.png`.
  const screenshot = () => png('image.png')

  it('is named by its place among the message images, and the agent gets each one under its own name and file', async () => {
    await mount()
    await paste([screenshot()])
    await paste([screenshot()])
    await settle()
    expect(imageNames()).toEqual(['image-1.png', 'image-2.png'])

    await type('compare these')
    await pressEnter()
    const [, request] = (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, { content: string; images?: Array<{ name: string }> }]
    expect(request.images?.map((image) => image.name)).toEqual(['image-1.png', 'image-2.png'])
    expect(request.content).toContain('image-1.png (/tmp/mousse-attachments/thread-a/1a2b3c4d-image-1.png)')
    expect(request.content).toContain('image-2.png (/tmp/mousse-attachments/thread-a/1a2b3c4d-image-2.png)')
  })

  it('pasted two at once takes the next two numbers', async () => {
    await mount()
    await paste([screenshot(), screenshot()])
    await settle()
    expect(imageNames()).toEqual(['image-1.png', 'image-2.png'])
  })

  it('counts an image with a name of its own, which keeps that name', async () => {
    await mount()
    await paste([png('chart.png')])
    await paste([screenshot()])
    await settle()
    expect(imageNames()).toEqual(['chart.png', 'image-2.png'])
  })

  it('never takes the name of an image still in the message', async () => {
    await mount()
    await paste([screenshot()])
    await paste([screenshot()])
    await settle()
    await act(async () => { host.querySelector<HTMLButtonElement>('button[aria-label="Remove image-1.png"]')!.click() })
    await paste([screenshot()])
    await settle()
    expect(imageNames()).toEqual(['image-2.png', 'image-3.png'])
  })
})

describe('an image attached in the composer', () => {
  it('is prepared as it is attached, and the send carries what was prepared without reading it again', async () => {
    const reads = vi.spyOn(FileReader.prototype, 'readAsDataURL')
    await mount()
    const shot = png('shot.png')
    await paste([shot])
    await settle()
    expect(host.querySelector('.composer-attachment-status')).toBeNull()
    expect(reads).toHaveBeenCalledTimes(1)
    // Its file is written as it is attached, so the send does not wait for it.
    expect(threads.attachmentPath).toHaveBeenCalledWith(shot, 'thread-a')

    await type('what is this?')
    await pressEnter()
    const [, request] = (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, { content: string; images?: Array<{ name: string; mimeType: string; data: string }> }]
    expect(request.images).toEqual([{ name: 'shot.png', mimeType: 'image/png', data: btoa(String.fromCharCode(...new Uint8Array(await shot.arrayBuffer()))) }])
    expect(reads).toHaveBeenCalledTimes(1)
    // The message also names the image's file, for the agent to open once a compaction drops the image; written once.
    expect(request.content).toContain('shot.png (/tmp/mousse-attachments/thread-a/1a2b3c4d-shot.png)')
    expect(threads.attachmentPath).toHaveBeenCalledTimes(1)
  })

  it('that cannot be read here says it goes as a file, and is sent as its path', async () => {
    await mount()
    const heic = new File([new Uint8Array([1, 2, 3])], 'photo.heic', { type: 'image/heic' })
    await paste([heic])
    await settle()
    expect(host.querySelector('.composer-attachment-status')?.textContent).toBe('Sent as file')
    // It can't be read here, so its chip is a file chip, not a broken thumbnail.
    expect(host.querySelector('.composer-attachments img')).toBeNull()
    await type('and this?')
    await pressEnter()
    expect(threads.attachmentPath).toHaveBeenCalledWith(heic, 'thread-a')
    const [, request] = (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls[0]! as [string, { content: string; images?: unknown[] }]
    expect(request.content).toContain('photo.heic (/tmp/mousse-attachments/thread-a/1a2b3c4d-photo.heic)')
    expect(request.images ?? []).toEqual([])
  })

  it('that a thread on another computer cannot take is marked, and Send stays disabled with the reason', async () => {
    await remoteThread()
    await mount()
    await paste([new File([new Uint8Array([1, 2, 3])], 'photo.heic', { type: 'image/heic' })])
    await settle()
    await type('look')
    expect(host.querySelector('.composer-attachment-status')?.textContent).toBe("Can't be sent")
    expect(sendButton()?.disabled).toBe(true)
    expect(sendButton()?.title).toContain("photo.heic can't be sent")
    await pressEnter()
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
  })

  it('past the message image count is refused as it is attached, naming the file', async () => {
    await mount()
    for (let index = 0; index < 16; index += 1) await paste([png(`shot-${index}.png`)])
    await paste([png('one-too-many.png')])
    expect(host.textContent).toContain("one-too-many.png wasn't attached")
  })
})
