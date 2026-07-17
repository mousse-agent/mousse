import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import {
  isAgentAwaitingResponse,
  reconcileAgentMessages,
  upsertAgentMessage
} from '../src/renderer/components/MousseAgentChat'

const message = (id: string, role: ChatMessage['role'], streaming = false): ChatMessage => ({
  id,
  role,
  content: id,
  timestamp: '2026-07-15T00:00:00.000Z',
  ...(streaming ? { streaming: true } : {})
})

describe('MousseAgentChat message reconciliation', () => {
  it('retains a completed assistant turn when a stale history snapshot arrives', () => {
    const earlier = message('assistant-1', 'assistant')
    const latest = message('assistant-2', 'assistant')

    expect(reconcileAgentMessages([earlier, latest], [earlier])).toEqual([earlier, latest])
  })

  it('removes only a superseded streaming assistant placeholder during a sync', () => {
    const done = message('assistant-1', 'assistant')
    const streaming = message('assistant-2', 'assistant', true)

    expect(reconcileAgentMessages([done, streaming], [done])).toEqual([done])
  })

  it('updates an existing streamed response in place instead of duplicating it', () => {
    const initial = message('assistant-1', 'assistant', true)
    const complete = { ...initial, content: 'complete', streaming: false }

    expect(upsertAgentMessage([initial], complete)).toEqual([complete])
  })

  it('keeps the pre-thinking state scoped to an agent awaiting its own response', () => {
    const user = message('user-1', 'user')
    const thinking: ChatMessage = {
      ...message('thinking-1', 'system'),
      kind: 'thinking',
      thinking: { content: 'Working', status: 'complete' }
    }

    expect(isAgentAwaitingResponse([user, thinking])).toBe(true)
    expect(isAgentAwaitingResponse([user, thinking, message('assistant-1', 'assistant')])).toBe(false)
    expect(isAgentAwaitingResponse([])).toBe(false)
  })
})
