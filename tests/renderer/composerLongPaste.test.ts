// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATTACHMENT_LINES_ROOM, LONG_PASTE_BYTES } from '../../src/renderer/lib/longPaste'
import { MESSAGE_TOO_LONG, REMOTE_PASTE_TOO_LONG } from '../../src/renderer/lib/composerFilePaths'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The transcript is not part of this check: the shell shows the composer and its notices only.
vi.mock('../../src/renderer/chat/components/MousseAgentChatShell', async () => {
  const { createElement: create } = await import('react')
  const { ComposerNoticeProvider } = await import('../../src/renderer/components/ComposerNotice')
  return {
    MousseAgentChatShell: (props: { composer: never; children?: never; turnActions?: unknown }) => {
      shell.turnActions = props.turnActions as typeof shell.turnActions
      return create(ComposerNoticeProvider, null, props.children, props.composer)
    }
  }
})
vi.mock('../../src/renderer/dictation/microphone', () => ({}))

/** What the chat hands its transcript: the actions a prompt's Edit calls. */
const shell = vi.hoisted(() => ({ turnActions: undefined as undefined | { editPrompt?: (promptId: string, turnId: string, text: string) => Promise<void> } }))

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
    activeThreadId: 'thread-a', composerDrafts: {},
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

/** A log of `lines` lines, over the long-paste size, whose last line says where it ends. */
function longLog(lines: number): string {
  const width = Math.ceil(LONG_PASTE_BYTES / (lines - 1))
  return Array.from({ length: lines }, (_, i) => (i === lines - 1 ? 'END OF LOG: exit 137' : `line ${i} `.padEnd(width, 'x'))).join('\n')
}

async function pressKey(key: string, init: KeyboardEventInit = {}): Promise<boolean> {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  await act(async () => { box().dispatchEvent(event) })
  return event.defaultPrevented
}

async function click(node: Element | null | undefined): Promise<void> {
  expect(node).toBeTruthy()
  await act(async () => { (node as HTMLElement).click() })
  await settle()
}

const insertButton = () => host.querySelector('.composer-attachments [aria-label="Insert as text"]')
const lastSent = () => (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as { content: string } | undefined

describe('a long text paste in the composer', () => {
  it('becomes a text file on the message, which the agent reads in full from its path', async () => {
    await mount()
    const log = longLog(1240)
    expect(await paste([], log)).toBe(true)
    expect(box().value).toBe('')
    expect(chipNames()).toContain('Pasted text, 1,240 lines')

    await type('why did it exit?')
    await pressEnter()

    const staged = (threads.attachmentPath as ReturnType<typeof vi.fn>).mock.calls[0] as [File, string]
    expect(staged[1]).toBe('thread-a')
    expect(staged[0].type).toBe('text/plain')
    expect(await staged[0].text()).toBe(log)
    expect(lastSent()?.content).toBe(`why did it exit?\n\n[Attached files: Pasted text, 1,240 lines (/tmp/mousse-attachments/thread-a/1a2b3c4d-${staged[0].name})]`)
  })

  it('leaves text just under the size in the box', async () => {
    await mount()
    expect(await paste([], 'x'.repeat(LONG_PASTE_BYTES - 1))).toBe(false)
    expect(chipNames()).toEqual([])
  })

  it('goes into the box as text from the chip, and the file is not sent', async () => {
    await mount()
    const log = longLog(400)
    await type('before ')
    await paste([], log)
    await click(insertButton())
    expect(chipNames()).toEqual([])
    expect(box().value).toBe(`before ${log}`)
  })

  it('opens from its chip to show the text, with Insert as text there too', async () => {
    await mount()
    const log = longLog(50)
    await paste([], log)
    await click(host.querySelector('.composer-attachments [aria-label="Open Pasted text, 50 lines"]'))
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('END OF LOG: exit 137')
    await click([...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Insert as text'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(box().value).toBe(log)
  })

  it('is taken back by Undo right after the paste, and not once something was typed', async () => {
    await mount()
    await paste([], longLog(100))
    expect(await pressKey('z', { ctrlKey: true })).toBe(true)
    expect(chipNames()).toEqual([])
    expect(box().value).toBe('')

    await type('keep this')
    await paste([], longLog(100))
    await type('keep this and more')
    expect(await pressKey('z', { metaKey: true })).toBe(false)
    expect(chipNames()).toContain('Pasted text, 100 lines')
  })

  it('goes into the message as text on a thread whose agent runs on another computer', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    useAppStore.setState({ threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0, node: 'node-mac' }] as never })
    await mount()
    const log = longLog(300) + '\n```js\nconst a = 1\n```'
    await paste([], log)
    await type('read this')
    await pressEnter()
    expect(threads.attachmentPath).not.toHaveBeenCalled()
    // The log holds a three-backtick fence, so the block uses four.
    const fence = '`'.repeat(4)
    expect(lastSent()?.content).toBe(`read this\n\nPasted text, 303 lines:\n${fence}\n${log}\n${fence}`)
  })

  it('is refused on a thread on another computer when the message would be too long to send', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    useAppStore.setState({ threads: [{ id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0, node: 'node-mac' }] as never })
    await mount()
    await paste([], 'x'.repeat(600 * 1024))
    await type('read this')
    await pressEnter()
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    expect(host.textContent).toContain(REMOTE_PASTE_TOO_LONG)
    expect(chipNames()).toContain('Pasted text, 1 line')
  })

  it('becomes a file when the box already holds nearly all a message can carry, and the message still sends', async () => {
    await mount()
    await type('y'.repeat(512 * 1024 - ATTACHMENT_LINES_ROOM - 1000))
    expect(await paste([], 'short enough to fit')).toBe(false)
    expect(await paste([], 'z'.repeat(1001))).toBe(true)
    expect(chipNames()).toContain('Pasted text, 1 line')
    await pressEnter()
    expect(lastSent()?.content.length).toBeLessThanOrEqual(512 * 1024)
  })

  it('says a message is too long to send instead of sending it', async () => {
    await mount()
    await type('y'.repeat(512 * 1024 + 1))
    await pressEnter()
    expect(orchestrator.sendToThread).not.toHaveBeenCalled()
    expect(host.textContent).toContain(MESSAGE_TOO_LONG)
  })

  it('stays with its thread while another thread is open', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    useAppStore.setState({ threads: [
      { id: 'thread-a', name: 'A', createdAt: now, updatedAt: now, startedAt: now, order: 0 },
      { id: 'thread-b', name: 'B', createdAt: now, updatedAt: now, startedAt: now, order: 1 }
    ] as never })
    await mount()
    await paste([], longLog(80))
    await act(async () => { useAppStore.setState({ activeThreadId: 'thread-b' }) })
    await settle()
    expect(chipNames()).toEqual([])
    await act(async () => { useAppStore.setState({ activeThreadId: 'thread-a' }) })
    await settle()
    expect(chipNames()).toContain('Pasted text, 80 lines')
  })
})

describe('editing a sent message', () => {
  it('sends the edited text with the files the message carried, a long paste among them', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    const marker = '[Attached files: Pasted text, 1,240 lines (/tmp/mousse-attachments/thread-a/1a2b3c4d-pasted-text-1.txt)]'
    useAppStore.setState({ messages: [{ id: 'm-1', role: 'user', content: `why did it exit?\n\n${marker}`, timestamp: now }] as never })
    const fork = vi.fn(async () => ({ branch: { id: 'branch-2' } }))
    await mount()
    const mousse = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    mousse.actions.list = async () => ({
      journalGeneration: 1, activeBranchId: 'main',
      actions: [{ id: 'act-1', turnId: 'turn-1', conversationBranchId: 'main', scope: 'files', state: 'done', nativeContextStartBoundary: { safeBoundaryProof: true, fidelity: 'exact' } }]
    })
    mousse.actions.fork = fork
    await act(async () => { await shell.turnActions!.editPrompt!('m-1', 'turn-1', 'why did it exit with 137?') })
    expect(fork).toHaveBeenCalled()
    expect(lastSent()?.content).toBe(`why did it exit with 137?\n\n${marker}`)
  })

  it('does not take a marker quoted inside pasted text for an attached file', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const now = new Date().toISOString()
    // A long paste sent to a thread on another computer: its text, which quotes a marker, is in a fence.
    const quoted = '[Attached files: report.txt (/remote/report.txt)]'
    useAppStore.setState({ messages: [{ id: 'm-1', role: 'user', content: ['look', '', 'Pasted text, 3 lines:', '```', 'before', quoted, 'after', '```'].join('\n'), timestamp: now }] as never })
    await mount()
    const mousse = (window as unknown as { mousse: Record<string, Record<string, unknown>> }).mousse
    mousse.actions.list = async () => ({
      journalGeneration: 1, activeBranchId: 'main',
      actions: [{ id: 'act-1', turnId: 'turn-1', conversationBranchId: 'main', scope: 'files', state: 'done', nativeContextStartBoundary: { safeBoundaryProof: true, fidelity: 'exact' } }]
    })
    mousse.actions.fork = vi.fn(async () => ({ branch: { id: 'branch-2' } }))
    await act(async () => { await shell.turnActions!.editPrompt!('m-1', 'turn-1', 'look again') })
    expect(lastSent()?.content).toBe('look again')
  })
})
