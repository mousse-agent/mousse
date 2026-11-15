// @vitest-environment jsdom
/**
 * The settle notice in the sender's chat (SPEC §15.1): Mousse's notice row, which names the thread it is about with its
 * thread chip (a click opens it), never the person's bubble or an agent's, and never the text the model reads.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '../../src/shared/types'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { useAppStore } from '../../src/renderer/stores/appStore'

const openLinkedThread = vi.fn()
vi.mock('../../src/renderer/utils/chatLinks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/renderer/utils/chatLinks')>()),
  openLinkedThread: (threadId: string) => openLinkedThread(threadId)
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  openLinkedThread.mockClear()
  // The two threads the notices are about, as this window lists them: one finished, one waiting on its person.
  const thread = (id: string, name: string) => ({ id, name, projectId: 'p1', createdAt: at(0), updatedAt: at(0) })
  useAppStore.setState({ threads: [thread('t2', 'Fix build'), thread('t3', 'Release notes')] as never })
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const at = (n: number) => new Date(Date.UTC(2026, 10, 15, 12, 0, n)).toISOString()

describe('a settle notice in the sender\'s chat', () => {
  it('is one notice row per thread: its thread chip, which opens it, and what happened there; not a user bubble and not the model\'s text', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Ask the other thread to fix the build.', timestamp: at(0), turnId: 'run-1' },
      { id: 'a1', role: 'assistant', content: 'Sent it; Mousse will tell me.', timestamp: at(1) },
      {
        id: 'n1', role: 'user', timestamp: at(2), turnId: 'run-2',
        content: '[Mousse notice, not from the user or any agent: about the message you sent with notify.]\nThe work your message started in thread "Fix build" (mousse://thread/t2) finished.\nIts reply:\nSECRET MODEL TEXT',
        settleNotice: [
          { watchId: 'w1', threadId: 't2', title: 'Fix build', event: 'ended', status: 'completed', runId: 'r1', cut: true },
          { watchId: 'w2', threadId: 't3', title: 'Release notes', event: 'needs_input' }
        ]
      },
      { id: 'a2', role: 'assistant', content: 'The build is fixed.', timestamp: at(3) }
    ]
    act(() => root.render(createElement(MessageList, { messages: mousseToUIMessages(messages), status: 'ready' })))
    expect([...host.querySelectorAll('.chat-user-bubble')].map((el) => el.textContent?.trim())).toEqual(['Ask the other thread to fix the build.'])
    expect(host.textContent).not.toContain('SECRET MODEL TEXT')
    const note = host.querySelector<HTMLElement>('[role="note"][aria-label="Notice from Mousse"]')!
    const rows = [...note.querySelectorAll<HTMLElement>('.subagent-notice-row')]
    expect(rows.map((row) => row.querySelector('.thread-chip-title')?.textContent)).toEqual(['Fix build', 'Release notes'])
    expect(rows.map((row) => [...row.querySelectorAll('.subagent-notice-detail')].map((el) => el.textContent).join(' '))).toEqual(['finished · partial reply', 'is waiting for a person'])
    const chip = rows[1]!.querySelector<HTMLAnchorElement>('a.thread-chip')!
    expect(chip.getAttribute('href')).toBe('mousse://thread/t3')
    act(() => chip.click())
    expect(openLinkedThread).toHaveBeenCalledWith('t3')
  })
})
