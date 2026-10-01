import { describe, expect, it } from 'vitest'
import { reconcileMessageSnapshot, upsertMessage, useAppStore } from '../src/renderer/stores/appStore'
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
