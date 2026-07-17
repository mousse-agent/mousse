import { describe, expect, it } from 'vitest'
import { handleTextStreamEvent, type StreamingLlmTextEvent } from '../src/mms/orchestrator/LlmClient'

describe('handleTextStreamEvent', () => {
  it('retains independent text blocks from a provider response', () => {
    const events: StreamingLlmTextEvent[] = []
    const content = new Map<number, string>()
    const partial = {} as never

    handleTextStreamEvent({ type: 'text_delta', contentIndex: 0, delta: 'Before tools', partial }, (event) => events.push(event), content)
    handleTextStreamEvent({ type: 'text_end', contentIndex: 0, content: 'Before tools', partial }, (event) => events.push(event), content)
    handleTextStreamEvent({ type: 'text_delta', contentIndex: 1, delta: 'Final answer', partial }, (event) => events.push(event), content)
    handleTextStreamEvent({ type: 'text_end', contentIndex: 1, content: 'Final answer', partial }, (event) => events.push(event), content)

    expect(events).toEqual([
      { phase: 'start', content: '', contentIndex: 0 },
      { phase: 'delta', content: 'Before tools', contentIndex: 0 },
      { phase: 'complete', content: 'Before tools', contentIndex: 0 },
      { phase: 'start', content: '', contentIndex: 1 },
      { phase: 'delta', content: 'Final answer', contentIndex: 1 },
      { phase: 'complete', content: 'Final answer', contentIndex: 1 }
    ])
  })
})
