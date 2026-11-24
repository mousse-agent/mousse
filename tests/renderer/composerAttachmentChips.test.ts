// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LONG_PASTE_BYTES } from '../../src/renderer/lib/longPaste'
import { attachmentChipTokenFor } from '../../src/renderer/lib/composerAttachmentChips'

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
    skills: section({ list: () => Promise.resolve({ skills: [] }) }),
    // `@Sett` finds one file of the project.
    fs: section({ search: async () => ({ root: '/work/app', results: [{ kind: 'file', path: 'src/settings/SettingsPanel.tsx', positions: [] }], indexing: false, truncated: false }) })
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
  Element.prototype.scrollIntoView = () => {}
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

/** Puts the caret just before `text` in the box. */
function caretBefore(text: string): void {
  const at = box().value.indexOf(text)
  expect(at).toBeGreaterThanOrEqual(0)
  box().setSelectionRange(at, at)
}

/** The box's text with each chip as `[name]`: what a person reads in it. */
const shown = () => box().value.replace(/\u2068[\u2003\u2060\u00a0]*([^\u2068\u2069]*?)\u2060*\u2069/g, (_, name: string) => `[${name.replace(/\u00a0/g, ' ').replace(/\u2011/g, '-')}]`)
/** A PNG as far as its header goes: what the composer reads of it before sending it as it is. */
function image(name: string): File {
  const bytes = new Uint8Array(64)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  new DataView(bytes.buffer).setUint32(16, 32)
  new DataView(bytes.buffer).setUint32(20, 32)
  return new File([bytes], name, { type: 'image/png' })
}
const text = (name: string) => new File(['hello'], name, { type: 'text/plain' })
const lastSent = () => (orchestrator.sendToThread as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as { content: string } | undefined
const removeButton = (name: string) => host.querySelector(`.composer-attachments [aria-label="Remove ${name}"]`)

describe('an attachment placed among the text', () => {
  it('shows as a chip where it was pasted as well as in the row, and the agent reads it in place', async () => {
    await mount()
    await type('compare with the old one')
    caretBefore(' with')
    await paste([image('before.png')])
    caretBefore(' the old')
    await paste([text('notes.txt')])
    expect(shown()).toBe('compare [before.png] with [notes.txt] the old one')
    expect(chipNames()).toContain('notes.txt')

    await settle()
    await pressEnter()
    expect(lastSent()?.content).toMatch(/^compare \[image 1: before\.png\] with \[file: notes\.txt\] the old one/)
  })

  it('goes to the row only when pasted into an empty box', async () => {
    await mount()
    await paste([text('notes.txt')])
    expect(box().value).toBe('')
    expect(chipNames()).toContain('notes.txt')
  })

  it('takes its chips out of the text when removed from the row, and an undo that brings a chip back brings it back', async () => {
    await mount()
    await type('look at this one')
    caretBefore(' one')
    await paste([text('notes.txt')])
    const withChip = box().value
    await click(removeButton('notes.txt'))
    expect(box().value).toBe('look at this one')
    expect(chipNames()).not.toContain('notes.txt')

    // Undo puts the text back as it was; the attachment comes back with its chip.
    await type(withChip)
    expect(shown()).toBe('look at this [notes.txt] one')
    expect(chipNames()).toContain('notes.txt')
  })

  it('stays in the row when its chip is deleted from the text', async () => {
    await mount()
    await type('look at this one')
    caretBefore(' one')
    await paste([text('notes.txt')])
    caretBefore(' one')
    await pressKey('Backspace')
    expect(shown()).toBe('look at this one')
    expect(chipNames()).toContain('notes.txt')
  })

  it('a long paste among text leaves its chip there, and Undo right after takes both back', async () => {
    await mount()
    await type('the log says why')
    caretBefore(' says')
    await paste([], 'x'.repeat(LONG_PASTE_BYTES))
    expect(shown()).toBe('the log [Pasted text, 1 line] says why')
    // The key takes the attachment back; the text box's own undo takes the chip's text back.
    expect(await pressKey('z', { ctrlKey: true })).toBe(false)
    await type('the log says why')
    expect(chipNames()).toEqual([])
  })

  it('picked with @ among text, shows as a chip in place of the query as well as in the row', async () => {
    await mount()
    await type('make the header in @Sett')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)) })
    await settle()
    expect(await pressKey('Enter')).toBe(true)
    await settle()
    expect(shown()).toBe('make the header in [SettingsPanel.tsx] ')
    expect(host.querySelector('.composer-attachments [aria-label="Remove SettingsPanel.tsx"]')).toBeTruthy()

    await type(`${box().value}match`)
    await pressEnter()
    expect(lastSent()?.content).toMatch(/^make the header in \[file: SettingsPanel\.tsx\] match/)
  })

  it('reads as its plain name in a draft whose attachment is gone (the app restarted)', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const token = attachmentChipTokenFor({ key: 'file:gone', name: 'old notes.txt', kind: 'file' }, new Map())
    useAppStore.setState({ composerDrafts: { 'thread-a': `see ${token} again` } })
    await mount()
    expect(box().value).toBe('see old notes.txt again')
  })
})
