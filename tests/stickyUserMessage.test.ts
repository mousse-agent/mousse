import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  findStickyUserMessageId,
  stickyUserMessagePreview
} from '../src/renderer/utils/stickyUserMessage'

const orchestratorSource = readFileSync(
  new URL('../src/renderer/components/OrchestratorChat.tsx', import.meta.url),
  'utf8'
)
const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

describe('sticky user message collapse', () => {
  it('reduces large collapsed messages to their first non-empty line with an ellipsis', () => {
    expect(stickyUserMessagePreview('\n  First line  \nSecond line\nThird line')).toBe('First line...')
    expect(stickyUserMessagePreview('')).toBe('Message...')
  })

  it('selects the newest prompt at the sticky edge instead of retaining an older one', () => {
    const messages = [
      { dataset: { messageId: 'old' }, getBoundingClientRect: () => ({ top: 0 }) },
      { dataset: { messageId: 'latest' }, getBoundingClientRect: () => ({ top: 1 }) },
      { dataset: { messageId: 'future' }, getBoundingClientRect: () => ({ top: 20 }) }
    ]
    const container = {
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => messages
    } as unknown as HTMLElement

    expect(findStickyUserMessageId(container)).toBe('latest')
  })

  it('keeps the latest user message that has actually crossed the sticky boundary', () => {
    expect(orchestratorSource).toMatch(/findStickyUserMessageId\(container\)/)
  })

  it('rechecks sticky visibility after layout-only timeline changes', () => {
    expect(orchestratorSource).toMatch(/new ResizeObserver\(scheduleStickyUserUpdate\)/)
    expect(orchestratorSource).toMatch(/observer\.observe\(timeline \?\? container\)/)
  })

  it('adds an accessible arrow toggle only on the active sticky user message', () => {
    expect(orchestratorSource).toMatch(/message-user-sticky-toggle/)
    expect(orchestratorSource).toMatch(/aria-label=\{isStickyCollapsed \? 'Expand sticky message' : 'Collapse sticky message'\}/)
    expect(orchestratorSource).toMatch(/aria-expanded=\{!isStickyCollapsed\}/)
    expect(orchestratorSource).toMatch(/ChevronUp/)
    expect(orchestratorSource).toMatch(/ChevronDown/)
    expect(orchestratorSource).toMatch(/stickyCollapsedById/)
  })

  it('keeps collapse state and geometry per message id when sticky ownership changes', () => {
    expect(orchestratorSource).toMatch(
      /setStickyCollapsedById\(\(current\) => \(\{[\s\S]*?\.\.\.current,[\s\S]*?\[msg\.id\]: !current\[msg\.id\]/
    )
    expect(orchestratorSource).toMatch(
      /const isStickyCollapsed = msg\.role === 'user' && Boolean\(stickyCollapsedById\[msg\.id\]\)/
    )
    expect(orchestratorSource).not.toMatch(
      /const isStickyCollapsed = isStickyUser && Boolean\(stickyCollapsedById\[msg\.id\]\)/
    )
  })

  it('shows a compact preview when collapsed and full content when expanded', () => {
    expect(orchestratorSource).toMatch(/message-user-sticky-collapsed/)
    expect(orchestratorSource).toMatch(/message-user-sticky-preview/)
    expect(orchestratorSource).toMatch(/isStickyCollapsed \? \([\s\S]*message-user-sticky-preview/)
    expect(orchestratorSource).toMatch(/isStickyCollapsed \? \([\s\S]*\) : \([\s\S]*ChatMessageContent/)
  })

  it('pins sticky ownership while collapse reflow settles', () => {
    expect(orchestratorSource).toMatch(/stickyOwnerLockUntilRef/)
    expect(orchestratorSource).toMatch(/performance\.now\(\) >= stickyOwnerLockUntilRef\.current/)
    expect(orchestratorSource).toMatch(/stickyOwnerLockUntilRef\.current = performance\.now\(\) \+ 400/)
    expect(orchestratorSource).toMatch(/onWheel=\{handleMessagesWheel\}/)
    expect(orchestratorSource).toMatch(/onTouchMove=\{handleMessagesTouchMove\}/)
  })

  it('stops following output when the user scrolls up and resumes at the bottom', () => {
    expect(orchestratorSource).toMatch(/if \(event\.deltaY < 0\) followLatestRef\.current = false/)
    expect(orchestratorSource).toMatch(/followLatestRef\.current = distanceFromBottom <= 24/)
    expect(orchestratorSource).toMatch(/if \(container && followLatestRef\.current\)/)
  })

  it('styles the toggle so it does not own the scroll surface', () => {
    expect(appStyles).toMatch(
      /\.message-user-sticky-active \.message-user-sticky-toggle\s*\{[\s\S]*?pointer-events:\s*auto/
    )
    expect(appStyles).toMatch(
      /\.message-user-sticky-active \.message-user-sticky-toggle\s*\{[\s\S]*?touch-action:\s*manipulation/
    )
    expect(appStyles).toMatch(/\.message-user-sticky-preview-text\s*\{[\s\S]*?text-overflow:\s*ellipsis/)
    expect(appStyles).toMatch(
      /\.message-user-sticky-collapsed \.message-user-sticky-toggle\s*\{[\s\S]*?top:\s*50%;[\s\S]*?transform:\s*translateY\(-50%\)/
    )
    expect(appStyles).toMatch(
      /\.message-user-sticky-active \.message-user-sticky-toggle\s*\{[\s\S]*?padding:\s*0;[\s\S]*?line-height:\s*0/
    )
    expect(appStyles).toMatch(
      /\.message-user-sticky-active \.message-user-sticky-toggle svg\s*\{[\s\S]*?display:\s*block/
    )
  })
})
