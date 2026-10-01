import { describe, expect, it, vi } from 'vitest'
import { getFinalResponseLayout } from '../src/renderer/utils/responseTimeline'
import type { ChatMessage } from '../src/shared/types'

vi.stubGlobal('window', {
  mousse: {
    settings: {
      get: async () => ({
        provider: { llmProvider: 'x', model: 'y' },
        integrations: { skills: { enabledSkills: [] } }
      }),
      getOptions: async () => ({ llmProviders: [] }),
      set: async () => {},
      onChanged: () => () => {}
    },
    providers: { onChanged: () => () => {} },
    skills: { list: async () => ({ skills: [] }), onChanged: () => () => {} },
    orchestrator: {
      getContextUsage: async () => ({
        percent: 0,
        used: 0,
        limit: 1,
        modelName: null,
        source: 'estimated',
        categories: []
      })
    }
  }
})

describe('plan card work fold', () => {
  it('keeps plan cards out of the collapsed work fold so the preview stays visible', () => {
    const messages: ChatMessage[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'plan this',
        timestamp: '2026-08-01T00:00:00.000Z'
      },
      {
        id: 't1',
        role: 'system',
        content: '',
        kind: 'thinking',
        timestamp: '2026-08-01T00:00:01.000Z',
        thinking: { content: '…', status: 'complete' }
      },
      {
        id: 'p1',
        role: 'assistant',
        content: '# Plan',
        kind: 'plan_card',
        planCard: { originalRequest: 'plan this', planMarkdown: '# Plan\n\n- step' },
        timestamp: '2026-08-01T00:00:02.000Z'
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Follow-up note',
        timestamp: '2026-08-01T00:00:03.000Z'
      }
    ]

    const layout = getFinalResponseLayout(messages)
    expect(layout.finalResponseId).toBe('a1')
    expect(layout.workMessageIds.has('p1')).toBe(false)
    expect(layout.workMessageIds.has('t1')).toBe(true)
  })
})
