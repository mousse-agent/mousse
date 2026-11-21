// @vitest-environment jsdom
/**
 * A message steered into a running reply has its own actions, like a prompt: when it was sent, Read aloud, Copy and, for a
 * person's steer, Repeat this. It has no Edit and no Undo, since a steer has no checkpoint of its own to go back to.
 * An agent's steer, like an agent's prompt, has no Repeat this.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { createTurnActions, TurnActionsContext } from '../../src/renderer/chat/components/agent-elements/turn-actions'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { formatMessageTime } from '../../src/renderer/chat/components/agent-elements/utils/message-time'
import { PromptUndoProvider } from '../../src/renderer/components/PromptUndoControls'
import { useReadAloudStore } from '../../src/renderer/readAloud/readAloudStore'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useBotsStore } from '../../src/renderer/stores/botsStore'
import type { ChatMessage, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  const proof = { compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }
  const actions = [{ id: 'action-t1', turnId: 't1', conversationBranchId: 'main', state: 'completed', nativeContextStartBoundary: { messageIndex: 0, ...proof }, nativeContextBoundary: { messageIndex: 4, ...proof } }]
  ;(window as unknown as { mousse: unknown }).mousse = { actions: { list: vi.fn(async () => ({ actions, receipts: [], journalGeneration: 1, activeBranchId: 'main' })) } }
  useAppStore.setState({ threads: [{ id: 'thread-1', name: 'Fix the build' } as Thread, { id: 'sender', name: 'Helper' } as Thread] })
  useBotsStore.setState({ bots: [] })
  useReadAloudStore.setState({ activeKey: null, status: 'idle', pending: null, pickerOpen: false, selection: null })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

const at = '2026-11-15T10:00:00.000Z'
const transcript: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'Fix the build', timestamp: at, turnId: 't1' },
  { id: 'a1', role: 'assistant', content: 'Looking at it', timestamp: at, turnId: 't1' },
  { id: 's1', role: 'user', content: 'use pnpm, not npm', timestamp: at, turnId: 't1', steered: true },
  { id: 's2', role: 'user', content: 'Also check the lockfile', timestamp: at, turnId: 't1', steered: true, origin: { kind: 'agent', threadId: 'sender', runId: 'run:sender', hops: 1, title: 'Helper' } },
  { id: 'a2', role: 'assistant', content: 'Done', timestamp: at, turnId: 't1' }
]

async function show() {
  await act(async () => {
    root.render(createElement(PromptUndoProvider, { threadId: 'thread-1', busy: false, revision: 1 },
      createElement(TurnActionsContext.Provider, { value: createTurnActions({ prompt: () => undefined, send: vi.fn(), editPrompt: vi.fn(async () => undefined) }) },
        createElement(MessageList, { messages: mousseToUIMessages(transcript), status: 'ready' }))))
  })
  // The prompt's Edit shows once the turn's history has arrived, so a steer's missing Edit is not just early.
  await vi.waitFor(() => expect(host.querySelector('[data-prompt-id="u1"] button[aria-label="Edit"]')).not.toBeNull())
}
const steer = (id: string) => host.querySelector<HTMLElement>(`[data-steered-id="${id}"]`)!
const button = (scope: HTMLElement, name: string) => scope.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)

describe('a steered message\'s actions', () => {
  it('a person\'s steer offers Read aloud, Copy and Repeat this, and no Edit or Undo', async () => {
    await show()
    const item = steer('s1')
    expect(item.querySelector('.chat-message-toolbar')!.textContent).toContain(formatMessageTime(at)!)
    expect(button(item, 'Read aloud')).not.toBeNull()
    expect(button(item, 'Copy')).not.toBeNull()
    expect(button(item, 'Message actions')).not.toBeNull()
    expect(button(item, 'Edit')).toBeNull()
    expect(button(item, 'Undo')).toBeNull()
  })

  it('an agent\'s steer offers Read aloud and Copy, without Repeat this', async () => {
    await show()
    const item = steer('s2')
    expect(button(item, 'Read aloud')).not.toBeNull()
    expect(button(item, 'Copy')).not.toBeNull()
    expect(button(item, 'Message actions')).toBeNull()
    expect(button(item, 'Edit')).toBeNull()
  })

  it('Read aloud reads that steer\'s words', async () => {
    await show()
    act(() => button(steer('s1'), 'Read aloud')!.click())
    // No voice chosen yet: the picker opens with the read waiting on it.
    expect(useReadAloudStore.getState().pending).toMatchObject({ key: 'user-s1', text: 'use pnpm, not npm' })
  })

  it('Copy keeps the steer\'s actions shown while it says Copied', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => undefined) } })
    await show()
    const toolbar = () => steer('s1').querySelector<HTMLElement>('.chat-message-toolbar')!
    expect(toolbar().hasAttribute('data-pinned')).toBe(false)
    act(() => button(steer('s1'), 'Copy')!.click())
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('use pnpm, not npm')
    expect(toolbar().hasAttribute('data-pinned')).toBe(true)
    // Only the steer that was copied.
    expect(steer('s2').querySelector('.chat-message-toolbar')!.hasAttribute('data-pinned')).toBe(false)
  })
})
