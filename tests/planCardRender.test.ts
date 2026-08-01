import { createElement } from 'react'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ChatMessageContent,
  resolvePlanCard
} from '../src/renderer/components/ChatMessageContent'
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

const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

describe('resolvePlanCard', () => {
  it('falls back to message content when planMarkdown is missing', () => {
    expect(
      resolvePlanCard('plan_card', { originalRequest: 'ship it', planMarkdown: '' }, '# From content')
    ).toEqual({
      originalRequest: 'ship it',
      planMarkdown: '# From content'
    })
  })

  it('returns null for ordinary assistant messages', () => {
    expect(resolvePlanCard('message', undefined, 'hello')).toBeNull()
  })
})

describe('plan card Markdown visibility', () => {
  it('renders plan Markdown inside plan-card-body for ChatMessageContent', () => {
    const markup = renderToStaticMarkup(
      createElement(ChatMessageContent, {
        role: 'assistant',
        content: '',
        kind: 'plan_card',
        planCard: {
          originalRequest: 'Build a login form',
          planMarkdown: '# Implementation Plan\n\n1. Add form\n2. Wire submit'
        }
      })
    )

    expect(markup).toContain('plan-card')
    expect(markup).toContain('plan-card-body')
    expect(markup).toContain('chat-markdown')
    expect(markup).toContain('Implementation Plan')
    expect(markup).toContain('<ol>')
    expect(markup).toContain('plan-card-footer')
    expect(markup).toMatch(/Implement Plan|implement-plan|composer-implement/i)
  })

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

  it('styles the plan body so Markdown cannot flex-shrink to zero height', () => {
    expect(appStyles).toMatch(/\.plan-card-body\s*\{[\s\S]*?flex-shrink:\s*0/)
    expect(appStyles).toMatch(/\.plan-card-body\s*\{[\s\S]*?min-height:\s*3rem/)
    expect(appStyles).toMatch(/\.message-body-plan-card\s*\{[\s\S]*?white-space:\s*normal/)
  })
})
