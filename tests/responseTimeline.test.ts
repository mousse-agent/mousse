import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '../src/shared/types'
import {
  coalesceAssistantMessagesForDisplay,
  formatWorkingFor,
  getActiveResponseLayout,
  getFinalResponseLayout,
  getResponseTurnWorkLayouts
} from '../src/renderer/utils/responseTimeline'

const message = (overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage => ({
  content: '',
  timestamp: '2026-08-03T12:00:00.000Z',
  ...overrides
})

describe('assistant response display', () => {
  it('combines assistant text blocks from one turn across hidden tool work', () => {
    const messages = [
      message({ id: 'user', role: 'user', content: 'Fix it' }),
      message({ id: 'intro', role: 'assistant', content: 'I will inspect it.' }),
      message({ id: 'tool', role: 'system', kind: 'tool_call' }),
      message({ id: 'follow-up', role: 'assistant', content: 'I found the file.' }),
      message({ id: 'answer', role: 'assistant', content: 'The fix is complete.', responseMetadata: { modelName: 'test' } })
    ]

    expect(coalesceAssistantMessagesForDisplay(messages)).toEqual([
      messages[0],
      messages[2],
      {
        ...messages[4],
        id: 'intro',
        content: 'I will inspect it.\n\nI found the file.\n\nThe fix is complete.'
      }
    ])
  })

  it('keeps a single early assistant text before work until a later reply arrives', () => {
    const messages = [
      message({ id: 'user', role: 'user', content: 'Fix it' }),
      message({ id: 'intro', role: 'assistant', content: 'I will inspect it.' }),
      message({ id: 'tool', role: 'system', kind: 'tool_call' })
    ]

    expect(coalesceAssistantMessagesForDisplay(messages).map((entry) => entry.id)).toEqual([
      'user', 'intro', 'tool'
    ])
  })

  it('keeps plan cards separate from assistant text', () => {
    const messages = [
      message({ id: 'user', role: 'user' }),
      message({ id: 'intro', role: 'assistant', content: 'Plan follows.' }),
      message({ id: 'plan', role: 'assistant', kind: 'plan_card' }),
      message({ id: 'answer', role: 'assistant', content: 'Implemented.' })
    ]

    expect(coalesceAssistantMessagesForDisplay(messages).map((entry) => entry.id)).toEqual([
      'user', 'intro', 'plan', 'answer'
    ])
  })
})

describe('active response work layout', () => {
  it('groups current-turn thinking and tools but leaves a streaming answer visible', () => {
    const layout = getActiveResponseLayout([
      message({ id: 'user', role: 'user', content: 'Build it' }),
      message({ id: 'thinking', role: 'system', kind: 'thinking' }),
      message({ id: 'tool', role: 'system', kind: 'tool_call' }),
      message({ id: 'answer', role: 'assistant', streaming: true, content: 'Here is the result' })
    ])

    expect([...layout.workMessageIds]).toEqual(['thinking', 'tool'])
    expect(layout.startedAt).toBe('2026-08-03T12:00:00.000Z')
  })

  it('keeps completed intermediate text visible while a turn remains active', () => {
    const layout = getActiveResponseLayout([
      message({ id: 'user', role: 'user' }),
      message({ id: 'intro', role: 'assistant', content: 'I will inspect it.' }),
      message({ id: 'tool', role: 'system', kind: 'tool_call' }),
      message({ id: 'answer', role: 'assistant', streaming: true, content: 'Done' })
    ])

    expect([...layout.workMessageIds]).toEqual(['tool'])
    expect(layout.startedAt).toBe('2026-08-03T12:00:00.000Z')
  })

  it('formats a live elapsed label', () => {
    expect(formatWorkingFor(65_000)).toBe('Working · 1m 5s elapsed')
  })
})

describe('completed response work layout', () => {
  it('folds work but not assistant text emitted before the final answer', () => {
    const layout = getFinalResponseLayout([
      message({ id: 'user', role: 'user' }),
      message({ id: 'intro', role: 'assistant', content: 'I will inspect it.' }),
      message({ id: 'thinking', role: 'system', kind: 'thinking' }),
      message({ id: 'tool', role: 'system', kind: 'tool_call' }),
      message({ id: 'answer', role: 'assistant', content: 'Done' })
    ])

    expect(layout.finalResponseId).toBe('answer')
    expect([...layout.workMessageIds]).toEqual(['thinking', 'tool'])
  })

  it('folds work around a stopped partial response', () => {
    const layout = getFinalResponseLayout([
      message({ id: 'user', role: 'user' }),
      message({ id: 'thinking', role: 'system', kind: 'thinking' }),
      message({ id: 'answer', role: 'assistant', content: 'Partial', incomplete: true })
    ])

    expect(layout.finalResponseId).toBe('answer')
    expect([...layout.workMessageIds]).toEqual(['thinking'])
  })
})

describe('per-turn response work layouts', () => {
  it('groups work that arrives after an assistant placeholder into the same turn', () => {
    const layouts = getResponseTurnWorkLayouts([
      message({ id: 'user', role: 'user' }),
      message({ id: 'thinking', role: 'system', kind: 'thinking' }),
      message({ id: 'answer', role: 'assistant', content: 'Working on it' }),
      message({ id: 'tool', role: 'system', kind: 'tool_call' })
    ])

    expect(layouts).toHaveLength(1)
    expect(layouts[0].turnId).toBe('user')
    expect(layouts[0].firstWorkMessageId).toBe('thinking')
    expect([...layouts[0].workMessageIds]).toEqual(['thinking', 'tool'])
  })

  it('creates a separate disclosure for every completed turn', () => {
    const layouts = getResponseTurnWorkLayouts([
      message({ id: 'user-1', role: 'user' }),
      message({ id: 'thinking-1', role: 'system', kind: 'thinking' }),
      message({ id: 'answer-1', role: 'assistant', content: 'First' }),
      message({ id: 'user-2', role: 'user' }),
      message({ id: 'tool-2', role: 'system', kind: 'tool_call' }),
      message({ id: 'answer-2', role: 'assistant', content: 'Second' })
    ])

    expect(layouts.map((layout) => layout.turnId)).toEqual(['user-1', 'user-2'])
    expect(layouts.map((layout) => [...layout.workMessageIds])).toEqual([
      ['thinking-1'],
      ['tool-2']
    ])
  })

  it('keeps assistant text, plans, and context notes outside work', () => {
    const [layout] = getResponseTurnWorkLayouts([
      message({ id: 'user', role: 'user' }),
      message({ id: 'plan', role: 'assistant', kind: 'plan_card' }),
      message({ id: 'context', role: 'system', kind: 'context_compaction' }),
      message({ id: 'tool', role: 'system', kind: 'tool_call' }),
      message({ id: 'answer', role: 'assistant', content: 'Done' })
    ])

    expect([...layout.workMessageIds]).toEqual(['tool'])
  })
})
