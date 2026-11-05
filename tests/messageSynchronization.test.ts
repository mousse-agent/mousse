import { describe, expect, it } from 'vitest'
import { reconcileMessageSnapshot, sortMessagesDeterministic, upsertMessage, useAppStore } from '../src/renderer/stores/appStore'
import type { ChatMessage } from '../src/shared/types'

const stopped: ChatMessage = {
  id: 'assistant-1',
  role: 'assistant',
  content: '(Stopped)',
  timestamp: '2026-07-15T12:00:00.000Z',
  incomplete: true,
  streaming: false
}

describe('renderer message synchronization', () => {
  it('keeps the arrival order of messages that share a timestamp, whatever their ids', () => {
    const at = '2026-07-15T12:00:00.000Z'
    // The id of the tool call sorts before the id of the text it followed.
    const text: ChatMessage = { id: 'f0-text', role: 'assistant', content: 'Looking at the code first.', timestamp: at, turnId: 't1' }
    const tool: ChatMessage = { id: '0a-tool', role: 'assistant', content: 'Read checkout.ts', timestamp: at, turnId: 't1' }
    const user: ChatMessage = { id: 'u1', role: 'user', content: 'Fix it', timestamp: '2026-07-15T11:59:59.000Z', turnId: 't1' }
    expect(upsertMessage(upsertMessage([user], text), tool).map((message) => message.id)).toEqual(['u1', 'f0-text', '0a-tool'])
    // A late, older message still sorts by time; the tie keeps its order.
    const late: ChatMessage = { ...user, id: 'u0', timestamp: '2026-07-15T11:59:58.000Z' }
    expect(sortMessagesDeterministic([user, text, tool, late]).map((message) => message.id)).toEqual(['u0', 'u1', 'f0-text', '0a-tool'])
    expect(reconcileMessageSnapshot([user, text, tool], [user, text, tool]).map((message) => message.id)).toEqual(['u1', 'f0-text', '0a-tool'])
  })

  it('retains a completion update even if the initial message event is delayed', () => {
    expect(upsertMessage([], stopped)).toEqual([stopped])
  })

  it('does not duplicate a delayed initial event after the completion update', () => {
    const streaming = { ...stopped, content: '', incomplete: undefined, streaming: true }
    expect(upsertMessage([stopped], streaming)).toEqual([stopped])
  })

  it('keeps live rows missing from a stale long-thread snapshot', () => {
    const history = Array.from({ length: 1_000 }, (_, index): ChatMessage => ({
      id: `history-${String(index).padStart(4, '0')}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `message ${index}`,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
    }))
    const optimistic: ChatMessage = {
      id: 'optimistic:new', role: 'user', content: 'latest prompt',
      timestamp: '2026-07-15T12:00:01.000Z'
    }
    const stream: ChatMessage = {
      id: 'assistant-new', role: 'assistant', content: 'partial answer', streaming: true,
      timestamp: '2026-07-15T12:00:02.000Z'
    }

    const reconciled = reconcileMessageSnapshot([...history, optimistic, stream], history)
    expect(reconciled).toHaveLength(1_002)
    expect(reconciled.slice(-2)).toEqual([optimistic, stream])
  })

  it('keeps ordinary snapshot reconciliation while authoritative restores replace the selected transcript', () => {
    useAppStore.setState({ profileId: 'message-sync', activeThreadId: 'task', messages: [stopped] })
    useAppStore.getState().applyThreadMessages({ threadId: 'task', messages: [] }, 'message-sync')
    expect(useAppStore.getState().messages).toEqual([stopped])
    useAppStore.getState().applyThreadMessages({ threadId: 'task', messages: [], replace: true }, 'message-sync')
    expect(useAppStore.getState().messages).toEqual([])
    useAppStore.getState().applyThreadMessages({ threadId: 'task', messages: [stopped], replace: true }, 'message-sync')
    expect(useAppStore.getState().messages).toEqual([stopped])
  })

  it('does not shorten streaming text when a lagging snapshot arrives', () => {
    const live = { ...stopped, content: 'a much longer partial answer', incomplete: undefined, streaming: true }
    const stale = { ...live, content: 'a much' }
    expect(reconcileMessageSnapshot([live], [stale])).toEqual([live])
  })
})
