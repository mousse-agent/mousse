import { describe, expect, it } from 'vitest'
import { upsertMessage } from '../src/renderer/stores/appStore'
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
})
