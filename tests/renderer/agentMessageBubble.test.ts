// @vitest-environment jsdom
/**
 * A message another thread's agent sent, in the transcript: a bubble whose header names the agent ("Agent · <thread>") and
 * opens the sending thread, showing only the agent's words, with Copy of those words and no Edit. The label comes from
 * the stored origin, never from the text: a message stored before the words were marked shows whole, still labelled,
 * and a bot's message keeps the look it has.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/lib/threadActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/lib/threadActions')>()),
  selectThread: vi.fn(async () => undefined)
}))

import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { createTurnActions, TurnActionsContext } from '../../src/renderer/chat/components/agent-elements/turn-actions'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { PromptUndoProvider } from '../../src/renderer/components/PromptUndoControls'
import { selectThread } from '../../src/renderer/lib/threadActions'
import { useAppStore } from '../../src/renderer/stores/appStore'
import { useBotsStore } from '../../src/renderer/stores/botsStore'
import { agentMessage } from '../../src/mms/run/mcp/appTools/agentMessage'
import type { AgentOrigin, ChatMessage, Thread } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const SENDER = 'sender-thread'
const WORDS = 'Run the flaky test 20 times and tell me which seed fails.'

/** A message an agent sent as this change stores it: the labelled text and the origin that says where the words are. */
function sent(id: string, turnId: string, origin: Partial<AgentOrigin> = {}, words = WORDS): ChatMessage {
  const letter = agentMessage(SENDER, 'Fix flaky test', words)
  return {
    id, role: 'user', content: letter.text, timestamp: '2026-11-15T10:00:00.000Z', turnId,
    origin: { kind: 'agent', threadId: SENDER, runId: 'run:sender', hops: 1, title: 'Fix flaky test', body: { head: letter.head, tail: letter.tail }, ...origin }
  }
}
const reply = (turnId: string): ChatMessage => ({ id: `a-${turnId}`, role: 'assistant', content: `reply ${turnId}`, timestamp: '2026-11-15T10:00:01.000Z', turnId })
const typed = (turnId: string, text: string): ChatMessage => ({ id: `u-${turnId}`, role: 'user', content: text, timestamp: '2026-11-15T10:00:02.000Z', turnId })

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  // Each turn finished with a recorded start, so its prompt could be edited were it a person's.
  const proof = { compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }
  const actions = ['t1', 't2'].map((turnId) => ({ id: `action-${turnId}`, turnId, conversationBranchId: 'main', state: 'completed', nativeContextStartBoundary: { messageIndex: 0, ...proof }, nativeContextBoundary: { messageIndex: 2, ...proof } }))
  ;(window as unknown as { mousse: unknown }).mousse = { actions: { list: vi.fn(async () => ({ actions, receipts: [], journalGeneration: 1, activeBranchId: 'main' })) } }
  useAppStore.setState({ threads: [{ id: SENDER, name: 'Fix flaky test' } as Thread] })
  useBotsStore.setState({ bots: [] })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
  vi.mocked(selectThread).mockClear()
})

const show = async (messages: ChatMessage[]) => {
  await act(async () => {
    root.render(createElement(PromptUndoProvider, { threadId: 'thread-1', busy: false, revision: 1 },
      createElement(TurnActionsContext.Provider, { value: createTurnActions({ prompt: () => undefined, send: vi.fn(), editPrompt: vi.fn(async () => undefined) }) },
        createElement(MessageList, { messages: mousseToUIMessages(messages), status: 'ready' }))))
  })
  // The turns' history arrives after the first render; Edit shows on a person's prompt once it has.
  if (messages.some((message) => message.role === 'user' && !message.origin)) await vi.waitFor(() => expect(host.querySelector('button[aria-label="Edit"]')).not.toBeNull())
}
const bubbles = () => [...host.querySelectorAll<HTMLElement>('[data-mousse="user-message"]')]
const header = (bubble: HTMLElement) => bubble.querySelector<HTMLElement>('.chat-agent-sender')
const prompt = (id: string) => host.querySelector<HTMLElement>(`[data-prompt-id="${id}"]`)!

describe('a message another thread\'s agent sent', () => {
  it('shows "Agent · <sending thread>" and only the agent\'s words; the title opens the sending thread', async () => {
    await show([sent('m1', 't1'), reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)?.textContent).toBe('Agent·Fix flaky test')
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(WORDS)
    expect(bubble!.textContent).not.toContain('[Message from an agent')
    expect(bubble!.textContent).not.toContain('[End of message from an agent]')

    const link = header(bubble!)!.querySelector('a')!
    expect(link.getAttribute('href')).toBe(`mousse://thread/${SENDER}`)
    await act(async () => link.click())
    expect(selectThread).toHaveBeenCalledWith(SENDER)
  })

  it('offers Copy of the words and no Edit, while a person\'s prompt keeps Edit', async () => {
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    await show([sent('m1', 't1'), reply('t1'), typed('t2', 'Thanks, now fix it'), reply('t2')])
    expect(prompt('m1').querySelector('button[aria-label="Edit"]')).toBeNull()
    expect(prompt('u-t2').querySelector('button[aria-label="Edit"]')).not.toBeNull()
    await act(async () => prompt('m1').querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!.click())
    expect(writeText).toHaveBeenCalledWith(WORDS)
  })

  it('a sender that was deleted shows the title it had when it sent, with nothing to open', async () => {
    useAppStore.setState({ threads: [] })
    await show([sent('m1', 't1'), reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)?.textContent).toBe('Agent·Fix flaky test')
    expect(header(bubble!)!.querySelector('a')).toBeNull()
  })

  it('a message stored before its words were marked shows whole, still labelled', async () => {
    const old = sent('m1', 't1', { body: undefined, title: undefined })
    await show([old, reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)?.textContent).toBe('Agent·Fix flaky test')
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(old.content)
  })

  it('a long message folds behind "Show full message", measured on the words', async () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: () => void) {}
      observe() { this.callback() }
      unobserve() {}
      disconnect() {}
    })
    // jsdom lays nothing out: the text reads as 300px tall, past twice the agent fold (110px) and short of twice a person's.
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('chat-user-text') ? 300 : 0
    })
    try {
      await show([sent('m1', 't1'), reply('t1'), typed('t2', 'A person\'s prompt of the same height'), reply('t2')])
      expect(prompt('m1').querySelector('.chat-user-fold')?.textContent).toBe('Show full message')
      expect(prompt('u-t2').querySelector('.chat-user-fold')).toBeNull()
    } finally {
      height.mockRestore()
    }
  })

  it('a bot\'s message keeps its look: no header, its whole text', async () => {
    useBotsStore.setState({ bots: [{ id: 'bot-1', name: 'Alpha', homeThreadId: 'bot-home' } as never] })
    const fromBot: ChatMessage = { ...typed('t1', '[Message from your bot "Alpha". ...]\n\nGo ahead.\n\n[End of message from your bot]'), origin: { kind: 'agent', threadId: 'bot-home', runId: 'run:bot', hops: 1 } }
    await show([fromBot, reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)).toBeNull()
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(fromBot.content)
    expect(prompt(fromBot.id).querySelector('button[aria-label="Edit"]')).not.toBeNull()
  })
})
