import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  findOverflowingUserMessageIds,
  sameMessageIdSet,
  stickyUserMessagePreview
} from '../src/renderer/utils/stickyUserMessage'
import { chunkTimelineIntoTurns, turnChunkKey } from '../src/renderer/utils/toolTimelineGroups'
import type { ChatMessage } from '../src/shared/types'

const orchestratorSource = readFileSync(
  new URL('../src/renderer/components/OrchestratorChat.tsx', import.meta.url),
  'utf8'
)
const agentChatSource = readFileSync(
  new URL('../src/renderer/components/MousseAgentChat.tsx', import.meta.url),
  'utf8'
)
const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

function message(id: string, role: ChatMessage['role']): ChatMessage {
  return { id, role, content: id, timestamp: '2026-01-01T00:00:00.000Z' } as ChatMessage
}

describe('sticky user message sections', () => {
  it('reduces large collapsed messages to their first non-empty line with an ellipsis', () => {
    expect(stickyUserMessagePreview('\n  First line  \nSecond line\nThird line')).toBe('First line...')
    expect(stickyUserMessagePreview('')).toBe('Message...')
  })

  it('starts a new turn block at every user prompt', () => {
    const groups = [
      { type: 'message', message: message('sys', 'system') },
      { type: 'message', message: message('u1', 'user') },
      { type: 'message', message: message('a1', 'assistant') },
      { type: 'tool-group', messages: [message('t1', 'system'), message('t2', 'system')] },
      { type: 'message', message: message('u2', 'user') },
      { type: 'message', message: message('a2', 'assistant') }
    ] as const

    const chunks = chunkTimelineIntoTurns([...groups])
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toHaveLength(1)
    expect(chunks[1]).toHaveLength(3)
    expect(chunks[2]).toHaveLength(2)
    expect(turnChunkKey(chunks[1], 1)).toBe('turn:u1')
  })

  it('keeps leading non-user timeline entries in one block instead of dropping them', () => {
    const chunks = chunkTimelineIntoTurns([
      { type: 'message', message: message('sys', 'system') },
      { type: 'message', message: message('a0', 'assistant') }
    ])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toHaveLength(2)
  })

  it('pins every prompt through CSS inside its own turn block', () => {
    expect(appStyles).toMatch(
      /\.message-user\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;[\s\S]*?max-height:\s*176px;[\s\S]*?overflow:\s*hidden;/
    )
    expect(appStyles).toMatch(/\.chat-turn-block\s*\{[\s\S]*?display:\s*flex;/)
    expect(appStyles).not.toMatch(/message-user-sticky-active/)
    expect(orchestratorSource).toMatch(/className="chat-turn-block"/)
    expect(agentChatSource).toMatch(/className="chat-turn-block"/)
  })

  it('never derives the pin from scroll geometry', () => {
    for (const source of [orchestratorSource, agentChatSource]) {
      expect(source).not.toMatch(/findStickyUserMessageId/)
      expect(source).not.toMatch(/stickyOwnerLockUntilRef/)
      expect(source).not.toMatch(/message-user-sticky-active/)
    }
  })

  it('adds the fade only to prompts whose capped body actually overflows', () => {
    const bodies: Record<string, { scrollHeight: number; clientHeight: number }> = {
      tall: { scrollHeight: 220, clientHeight: 174 },
      short: { scrollHeight: 120, clientHeight: 174 }
    }
    const container = {
      querySelectorAll: () =>
        Object.keys(bodies).map((id) => ({
          dataset: { messageId: id },
          querySelector: () => bodies[id]
        }))
    } as unknown as HTMLElement

    expect([...findOverflowingUserMessageIds(container)]).toEqual(['tall'])
    expect(appStyles).toMatch(
      /\.message-user\.message-user-sticky-overflow:not\(\.message-user-sticky-collapsed\)::after\s*\{[\s\S]*?linear-gradient/
    )
  })

  it('treats an unchanged overflow set as identical so measuring cannot loop', () => {
    expect(sameMessageIdSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true)
    expect(sameMessageIdSet(new Set(['a']), new Set(['a', 'b']))).toBe(false)
  })

  it('remeasures overflow after layout-only timeline changes', () => {
    for (const source of [orchestratorSource, agentChatSource]) {
      expect(source).toMatch(/new ResizeObserver\(scheduleStickyOverflowMeasure\)/)
    }
    expect(orchestratorSource).toMatch(/observer\.observe\(timeline \?\? container\)/)
  })

  it('adds an accessible arrow toggle to sticky user prompts', () => {
    expect(orchestratorSource).toMatch(/message-user-sticky-toggle/)
    expect(orchestratorSource).toMatch(/aria-label=\{isStickyCollapsed \? 'Expand sticky message' : 'Collapse sticky message'\}/)
    expect(orchestratorSource).toMatch(/aria-expanded=\{!isStickyCollapsed\}/)
    expect(orchestratorSource).toMatch(/ChevronUp/)
    expect(orchestratorSource).toMatch(/ChevronDown/)
    expect(orchestratorSource).toMatch(/stickyCollapsedById/)
  })

  it('keeps collapse state per message id', () => {
    expect(orchestratorSource).toMatch(
      /setStickyCollapsedById\(\(current\) => \(\{[\s\S]*?\.\.\.current,[\s\S]*?\[msg\.id\]: !current\[msg\.id\]/
    )
    expect(orchestratorSource).toMatch(
      /const isStickyCollapsed = isStickyUser && Boolean\(stickyCollapsedById\[msg\.id\]\)/
    )
  })

  it('shows a compact preview when collapsed and full content when expanded', () => {
    expect(orchestratorSource).toMatch(/message-user-sticky-collapsed/)
    expect(orchestratorSource).toMatch(/message-user-sticky-preview/)
    expect(orchestratorSource).toMatch(/isStickyCollapsed \? \([\s\S]*message-user-sticky-preview/)
    expect(orchestratorSource).toMatch(/isStickyCollapsed \? \([\s\S]*\) : \([\s\S]*ChatMessageContent/)
  })

  it('stops following output when the user scrolls up and resumes at the bottom', () => {
    expect(orchestratorSource).toMatch(/if \(event\.deltaY < 0\) followLatestRef\.current = false/)
    expect(orchestratorSource).toMatch(/followLatestRef\.current = distanceFromBottom <= 24/)
    expect(orchestratorSource).toMatch(/if \(container && followLatestRef\.current\)/)
  })

  it('styles the toggle so it does not own the scroll surface', () => {
    expect(appStyles).toMatch(
      /\.message-user \.message-user-sticky-toggle\s*\{[\s\S]*?pointer-events:\s*auto/
    )
    expect(appStyles).toMatch(
      /\.message-user \.message-user-sticky-toggle\s*\{[\s\S]*?touch-action:\s*manipulation/
    )
    expect(appStyles).toMatch(/\.message-user-sticky-preview-text\s*\{[\s\S]*?text-overflow:\s*ellipsis/)
    expect(appStyles).toMatch(
      /\.message-user-sticky-collapsed \.message-user-sticky-toggle\s*\{[\s\S]*?top:\s*50%;[\s\S]*?transform:\s*translateY\(-50%\)/
    )
    expect(appStyles).toMatch(
      /\.message-user \.message-user-sticky-toggle\s*\{[\s\S]*?padding:\s*0;[\s\S]*?line-height:\s*0/
    )
    expect(appStyles).toMatch(
      /\.message-user \.message-user-sticky-toggle svg\s*\{[\s\S]*?display:\s*block/
    )
  })
})
