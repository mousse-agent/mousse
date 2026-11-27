// @vitest-environment jsdom
import { act, createElement, Fragment, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChainHoldNotice, createChainHoldClient, type ChainHoldClient } from '../../src/renderer/chat/components/ChainHoldNotice'
import { ComposerNoticeProvider, ComposerNoticeSlot } from '../../src/renderer/components/ComposerNotice'
import { useAppStore } from '../../src/renderer/stores/appStore'
import type { ChainHoldView, TurnState } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * The card of a chain of agent messages held at its budget (issue #1443), mounted in the composer's dock as the chat
 * mounts it, reading the thread's turn state (pushed from the computer that runs it): how many messages, who is
 * talking, and Continue or Stop.
 */
const hold = (patch: Partial<ChainHoldView> = {}): ChainHoldView => ({
  chainId: 'chain:run:1',
  used: 12,
  held: 2,
  between: [{ threadId: 't1', title: 'Lead' }, { threadId: 't2', title: null }],
  ...patch
})
const turn = (chainHold?: ChainHoldView): TurnState => ({ threadId: 't1', turnId: null, phase: 'idle', updatedAt: '2026-11-17T10:00:00.000Z', ...(chainHold ? { chainHold } : {}) })

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  useAppStore.setState({ turnStates: {} })
})

const line = () => host.querySelector<HTMLElement>('.composer-notice-text')
const notice = () => host.querySelector<HTMLElement>('.composer-notice')
const names = () => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).map((button) => button.getAttribute('aria-label') ?? button.textContent)
const button = (label: string) => Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find((entry) => (entry.getAttribute('aria-label') ?? entry.textContent)?.startsWith(label))!
const inSlot = (child: ReactNode) => createElement(ComposerNoticeProvider, null, createElement(Fragment, null, createElement(ComposerNoticeSlot), child))
const show = (client: ChainHoldClient, threadId: string | null = 't1') => act(() => root.render(inSlot(createElement(ChainHoldNotice, { threadId, client }))))
// Through the store's own update, as a pushed turn state arrives.
const setTurn = (chainHold?: ChainHoldView) => act(() => { useAppStore.getState().setTurnState(turn(chainHold)) })

describe('the held chain card', () => {
  it('shows nothing until a chain is held; then one line, the threads in the tooltip, Continue and Stop; it goes when nothing is held', () => {
    const client: ChainHoldClient = { answer: vi.fn(async () => undefined) }
    setTurn(undefined)
    show(client)
    expect(notice()).toBeNull()
    setTurn(hold())
    expect(line()!.querySelector('.composer-notice-title-full')!.textContent).toBe('Agents paused · 12 messages · 2 waiting')
    expect(line()!.textContent).toContain('"Lead" and an untitled thread')
    expect(line()!.title).toContain('Agents in "Lead" and an untitled thread sent each other 12 messages without you.')
    expect(notice()!.dataset.tone).toBe('warning')
    expect(names()).toEqual(['Continue', 'Stop'])
    setTurn(undefined)
    expect(notice()).toBeNull()
  })

  it.each(['continue', 'stop'] as const)('%s answers the chain it shows, on the thread it shows on', async (answer) => {
    const client: ChainHoldClient = { answer: vi.fn(async () => undefined) }
    setTurn(hold())
    show(client)
    await act(async () => { button(answer === 'continue' ? 'Continue' : 'Stop').click() })
    expect(client.answer).toHaveBeenCalledWith('t1', 'chain:run:1', answer)
  })

  it('a refused answer shows its error in place of the line; the buttons work again', async () => {
    const client: ChainHoldClient = { answer: vi.fn(async () => { throw new Error('Nothing of this chain is held any more.') }) }
    setTurn(hold())
    show(client)
    await act(async () => { button('Continue').click() })
    expect(line()!.textContent).toContain('Nothing of this chain is held any more.')
    expect(notice()!.dataset.tone).toBe('error')
    await act(async () => { button('Stop').click() })
    expect(client.answer).toHaveBeenCalledTimes(2)
  })

  it('shows nothing where no thread is open (a new chat)', () => {
    setTurn(hold())
    show({ answer: vi.fn(async () => undefined) }, null)
    expect(notice()).toBeNull()
  })

  it('the client asks threads.chainHold', async () => {
    const request = vi.fn(async () => undefined)
    await createChainHoldClient({ request } as never).answer('t1', 'chain:run:1', 'stop')
    expect(request).toHaveBeenCalledWith('threads.chainHold', { threadId: 't1', chainId: 'chain:run:1', answer: 'stop' })
  })
})
