// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageList } from '../../src/renderer/chat/components/agent-elements/message-list'
import { createTurnActions, TurnActionsContext } from '../../src/renderer/chat/components/agent-elements/turn-actions'
import { mousseToUIMessages } from '../../src/renderer/chat/adapters/mousseToUI'
import { editablePrompt, PromptUndoProvider } from '../../src/renderer/components/PromptUndoControls'
import type { ThreadActionHistory } from '../../src/renderer/utils/threadActionHistory'
import type { ChatMessage } from '../../src/shared/types'
import type { ThreadAction } from '../../src/shared/threadActions'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const proof = { compactionGeneration: 0, fidelity: 'exact' as const, safeBoundaryProof: 'test' }
const action = (turnId: string, extra: Partial<ThreadAction> = {}) => ({
  id: `action-${turnId}`, turnId, conversationBranchId: 'main', state: 'completed',
  nativeContextStartBoundary: { messageIndex: 0, ...proof }, nativeContextBoundary: { messageIndex: 2, ...proof }, ...extra
}) as ThreadAction
const turn = (turnId: string | undefined, prompt: string, seconds: number): ChatMessage[] => [
  { id: `u-${prompt}`, role: 'user', content: prompt, timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, seconds)).toISOString(), ...(turnId ? { turnId } : {}) },
  { id: `a-${prompt}`, role: 'assistant', content: `reply to ${prompt}`, timestamp: new Date(Date.UTC(2026, 10, 9, 10, 0, seconds + 1)).toISOString(), ...(turnId ? { turnId } : {}) }
]

describe('which prompts can be edited', () => {
  const history = (actions: ThreadAction[]): ThreadActionHistory => ({ actions, receipts: [], journalGeneration: 1, activeBranchId: 'main' })
  it('a finished turn on the active branch with a recorded start, including a stopped one', () => {
    expect(editablePrompt(history([action('t1')]), 't1')?.id).toBe('action-t1')
    expect(editablePrompt(history([action('t1', { state: 'stopped' })]), 't1')?.id).toBe('action-t1')
  })
  it('not a running turn, one on another branch, one with no recorded start or a legacy one, a chat with no files, or a copy', () => {
    expect(editablePrompt(history([action('t1', { state: 'running' })]), 't1')).toBeUndefined()
    expect(editablePrompt(history([action('t1', { conversationBranchId: 'other' })]), 't1')).toBeUndefined()
    expect(editablePrompt(history([action('t1', { nativeContextStartBoundary: undefined })]), 't1')).toBeUndefined()
    expect(editablePrompt(history([action('t1', { nativeContextStartBoundary: { messageIndex: 0, compactionGeneration: 0, fidelity: 'legacy' } })]), 't1')).toBeUndefined()
    expect(editablePrompt(history([action('t1', { scope: 'conversation' })]), 't1')).toBeUndefined()
    expect(editablePrompt(history([action('t1')]), undefined)).toBeUndefined()
  })
})

describe('editing a prompt in the transcript', () => {
  let host: HTMLDivElement
  let root: Root
  const activateBranch = vi.fn(async () => ({}))
  const history: ThreadActionHistory = {
    actions: [action('t1', { conversationBranchId: 'edited' }), action('t2', { conversationBranchId: 'edited' })], receipts: [], journalGeneration: 3, activeBranchId: 'edited',
    promptVersions: [{ turnId: 't2', versions: ['main', 'edited'], current: 1 }]
  }
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
    ;(window as unknown as { mousse: unknown }).mousse = { actions: { list: vi.fn(async () => history), activateBranch } }
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
    activateBranch.mockClear()
  })
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${label}"]`)]
  const show = async (editPrompt = vi.fn(async () => undefined)) => {
    // A turn on the edited branch (t2), its first turn (t1), and a copy of a fork's source that names no turn.
    const messages = mousseToUIMessages([...turn(undefined, 'Copied', 0), ...turn('t1', 'First', 10), ...turn('t2', 'Second', 20)])
    await act(async () => {
      root.render(createElement(PromptUndoProvider, { threadId: 'thread-1', busy: false, revision: 1 },
        createElement(TurnActionsContext.Provider, { value: createTurnActions({ prompt: () => undefined, send: vi.fn(), editPrompt }) },
          createElement(MessageList, { messages, status: 'ready' }))))
    })
    await vi.waitFor(() => expect(button('Edit').length).toBeGreaterThan(0))
    return editPrompt
  }

  it('offers Edit on each finished prompt but not on a copy, and sends the edited text for that prompt', async () => {
    const editPrompt = await show()
    expect(button('Edit')).toHaveLength(2)
    await act(async () => button('Edit')[0]!.click())
    const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit message"]')!
    expect(area.value).toBe('First')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'First, edited')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...host.querySelectorAll('button')].find((item) => item.textContent === 'Send')!.click())
    expect(editPrompt).toHaveBeenCalledExactlyOnceWith('u-First', 't1', 'First, edited')
    await vi.waitFor(() => expect(host.querySelector('textarea[aria-label="Edit message"]')).toBeNull())
  })

  it('Escape closes the editor without sending', async () => {
    const editPrompt = await show()
    await act(async () => button('Edit')[1]!.click())
    const area = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit message"]')!
    await act(async () => area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(host.querySelector('textarea[aria-label="Edit message"]')).toBeNull()
    expect(editPrompt).not.toHaveBeenCalled()
  })

  it('shows the edited prompt as version 2 of 2, and switches to the original', async () => {
    await show()
    expect(host.textContent).toContain('2/2')
    expect(button('Next version')[0]!.disabled).toBe(true)
    await act(async () => button('Previous version')[0]!.click())
    expect(activateBranch).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread-1', conversationBranchId: 'main' })
  })
})
