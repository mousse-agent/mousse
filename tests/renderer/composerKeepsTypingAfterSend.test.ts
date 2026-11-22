// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell shows the composer only; this file is about what the composer holds.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return { MousseAgentChatShell: ({ composer }: { composer: never }) => create(ComposerNoticeProvider, null, composer) }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

let root: Root
let host: HTMLElement
let orchestrator: Record<string, unknown>
/** The pasted image's file on disk, written while the send is still being prepared: held until the test lets it finish. */
let staged: () => void

function stubBridge(): void {
  const pending = () => new Promise(() => undefined)
  const section = (overrides: Record<string, unknown>): unknown =>
    new Proxy(overrides, {
      get: (target, key) => {
        if (typeof key !== 'string') return undefined
        if (key in target) return target[key]
        if (key.startsWith('on')) return () => () => undefined
        return () => pending()
      }
    })
  const written = new Promise<void>((resolve) => { staged = resolve })
  const sections: Record<string, unknown> = {
    orchestrator: section(orchestrator),
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    threads: section({ attachmentPath: async (_file: File) => { await written; return '/tmp/mousse-attachments/shot.png' } }),
    fileDrag: section({ pathOf: () => '' }),
    queue: section({ list: async () => [] })
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

const composer = () => host.querySelector<HTMLTextAreaElement>('.composer-input')!
async function type(text: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(composer(), text)
    composer().dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function pasteImage(): Promise<void> {
  const shot = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
  const paste = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(paste, 'clipboardData', { value: { items: [{ kind: 'file', getAsFile: () => shot }], files: [], getData: () => '' } })
  await act(async () => { composer().dispatchEvent(paste) })
  await settle()
}

beforeEach(async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: () => 'blob:shot', revokeObjectURL: () => undefined }))
  orchestrator = { isTurnActive: vi.fn(async () => false) }
  const now = new Date().toISOString()
  const { useAppStore } = await import('../../src/renderer/stores/appStore')
  // A thread that already had a turn, idle now.
  useAppStore.setState({
    profileId: 'prf_test', profileReady: true, workspaceReady: true, loading: false, threadActivity: {},
    turnStates: { 'thread-a': { phase: 'completed', turnId: 'run-1' } } as never,
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

/** Sends "Look at this" with a pasted image, and types on while its file is still being written. */
async function sendAndTypeOn(): Promise<void> {
  stubBridge()
  const { OrchestratorChat } = await import('../../src/renderer/components/OrchestratorChat')
  await act(async () => root.render(createElement(OrchestratorChat)))
  await settle()
  await pasteImage()
  await type('Look at this')
  await act(async () => { composer().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await settle()
  // Not cleared yet: the words typed after Enter land behind the sent text.
  await type('Look at this and the logs')
  await act(async () => { staged() })
  await settle(20)
}

describe('text typed after Enter while the send is still being prepared', () => {
  it('stays in the composer as the next message when the send clears it', async () => {
    orchestrator.sendToThread = vi.fn(() => new Promise(() => undefined))
    await sendAndTypeOn()
    expect(orchestrator.sendToThread).toHaveBeenCalledTimes(1)
    const [, request] = (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls[0] as [string, { content: string }]
    expect(request.content).toMatch(/^Look at this\n\n\[Attached files: /)
    expect(composer().value).toBe(' and the logs')
  })

  it('comes back after the refused message, as the draft was', async () => {
    orchestrator.sendToThread = vi.fn(async () => { throw new Error('The thread was deleted') })
    await sendAndTypeOn()
    expect(composer().value).toBe('Look at this and the logs')
  })
})
