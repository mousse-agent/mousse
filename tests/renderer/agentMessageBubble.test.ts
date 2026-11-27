// @vitest-environment jsdom
/**
 * A message another thread's agent sent, in the transcript: a bubble whose header names the agent ("Agent · <thread>") and
 * opens the sending thread, showing only the agent's words, with Copy of those words and no Edit. The label comes from
 * the stored origin, never from the text: a message stored before the words were marked shows whole, still labelled.
 * A message the owner's bot sent shows the bot's face, drawn still, and its name, with "open" for its chat.
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
import { agentMessage, botMessage } from '../../src/mms/run/mcp/appTools/agentMessage'
import { useChatsStore } from '../../src/renderer/stores/chatsStore'
import { NO_COMPUTERS, useComputersStore } from '../../src/renderer/lib/computers'
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

  it('an agent on another computer is named by the title it sent, with nothing to open here, and offers no Edit', async () => {
    // As the routed send stores it: the envelope this computer built, and the sender as `from` (no thread of this computer).
    const letter = agentMessage('far-thread', 'Yo', WORDS, { computer: 'ANIMATRIX' })
    const far: ChatMessage = {
      id: 'm1', role: 'user', content: letter.text, timestamp: '2026-11-15T10:00:00.000Z', turnId: 't1',
      origin: { kind: 'agent', from: { node: 'nod_far', thread: 'far-thread', run: 'run:far', title: 'Yo' }, hops: 1, body: { head: letter.head, tail: letter.tail } }
    }
    await show([far, reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)?.textContent).toBe('Agent·Yo')
    expect(header(bubble!)!.querySelector('a')).toBeNull()
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(WORDS)
    expect(prompt('m1').querySelector('button[aria-label="Edit"]')).toBeNull()
  })

  it('an agent of this computer that wrote in a thread of another computer is named by its thread here, which the title opens', async () => {
    // This computer is `nod_self`; the message sits in a thread that runs on another computer, sent by SENDER here.
    useComputersStore.setState({ ...NO_COMPUTERS, loaded: true, routed: true, devices: [{ node: 'nod_self', self: true } as never] })
    const letter = agentMessage(SENDER, 'Old title', WORDS, { computer: 'HERE' })
    const mine: ChatMessage = {
      id: 'm1', role: 'user', content: letter.text, timestamp: '2026-11-15T10:00:00.000Z', turnId: 't1',
      origin: { kind: 'agent', from: { node: 'nod_self', thread: SENDER, run: 'run:here', title: 'Old title' }, hops: 1, body: { head: letter.head, tail: letter.tail } }
    }
    try {
      await show([mine, reply('t1')])
      const [bubble] = bubbles()
      expect(header(bubble!)?.textContent).toBe('Agent·Fix flaky test')
      await act(async () => header(bubble!)!.querySelector('a')!.click())
      expect(selectThread).toHaveBeenCalledWith(SENDER)
    } finally {
      useComputersStore.setState(NO_COMPUTERS)
    }
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

})

describe('a message the owner\'s bot sent', () => {
  const BOT_WORDS = 'Go ahead and ship it.'
  const alpha = { id: 'bot-1', name: 'Alpha', homeThreadId: 'bot-home', look: { colour: 'blue', accessory: 'none' } }

  /** As this change stores it: the labelled text, where the bot's words are, and the bot. */
  const fromBot = (): ChatMessage => {
    const letter = botMessage('Alpha', BOT_WORDS)
    return { ...typed('t1', letter.text), origin: { kind: 'agent', threadId: 'bot-home', runId: 'run:bot', hops: 1, body: { head: letter.head, tail: letter.tail }, bot: { id: 'bot-1', name: 'Alpha' } } }
  }

  it('shows the bot\'s face and "<name> · open" over its words alone; open opens its chat; no Edit', async () => {
    useBotsStore.setState({ bots: [alpha as never], loaded: true })
    const openBot = vi.fn(async () => undefined)
    useChatsStore.setState({ openBot })
    const message = fromBot()
    await show([message, reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)?.textContent).toBe('Alpha·open')
    expect(header(bubble!)!.querySelector('.bot-face')).not.toBeNull()
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(BOT_WORDS)
    expect(bubble!.textContent).not.toContain('[Message from your bot')
    expect(prompt(message.id).querySelector('button[aria-label="Edit"]')).toBeNull()
    await act(async () => header(bubble!)!.querySelector<HTMLButtonElement>('button')!.click())
    expect(openBot).toHaveBeenCalledWith('bot-1')
  })

  it('a message stored before it named the bot or marked its words shows the same, found by the bot\'s chat thread', async () => {
    useBotsStore.setState({ bots: [alpha as never], loaded: true })
    const message: ChatMessage = { ...typed('t1', botMessage('Alpha', BOT_WORDS).text), origin: { kind: 'agent', threadId: 'bot-home', runId: 'run:bot', hops: 1 } }
    await show([message, reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)?.textContent).toBe('Alpha·open')
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(BOT_WORDS)
  })

  it('a bot of another computer shows the name and face that came with its message, not the agent label, with nothing to open', async () => {
    useBotsStore.setState({ bots: [alpha as never], loaded: true })
    // As the routed send stores it: the sender as `from`, and the bot with its look (this computer has no record of it).
    const letter = agentMessage('far-chat', 'Pip', BOT_WORDS, { computer: 'ANIMATRIX' })
    const far: ChatMessage = {
      ...typed('t1', letter.text),
      origin: { kind: 'agent', from: { node: 'nod_far', thread: 'far-chat', run: 'run:far', title: 'Pip' }, hops: 1, body: { head: letter.head, tail: letter.tail }, bot: { id: 'far-bot', name: 'Pip', look: { colour: 'teal', accessory: 'crown' } } }
    }
    await show([far, reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)!.querySelector('.chat-agent-sender-kind')?.textContent).toBe('Pip')
    expect(header(bubble!)?.textContent).not.toContain('Agent')
    expect(header(bubble!)!.querySelector('.bot-face')).not.toBeNull()
    expect(header(bubble!)!.querySelector('button')).toBeNull()
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(BOT_WORDS)
  })

  it('a bot this window does not list shows the name it had when it sent, with nothing to open', async () => {
    useBotsStore.setState({ bots: [], loaded: true })
    await show([fromBot(), reply('t1')])
    const [bubble] = bubbles()
    expect(header(bubble!)?.textContent).toBe('Alpha')
    expect(header(bubble!)!.querySelector('button')).toBeNull()
    expect(bubble!.querySelector('.chat-user-text')?.textContent).toBe(BOT_WORDS)
  })
})
