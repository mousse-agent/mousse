// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_FILES_REFUSAL } from '../../src/renderer/lib/composerFilePaths'

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

  it('is refused on a thread whose agent runs on another computer, before anything is sent', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    useAppStore.setState({ threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0, node: 'node-mac' }] as never })
    await mount()
    await paste([new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' })])
    await type('look')
    await pressEnter()
    expect(threads.attachmentPath).not.toHaveBeenCalled()
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    expect(host.textContent).toContain(REMOTE_FILES_REFUSAL)
  })
})
