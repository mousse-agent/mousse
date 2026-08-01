import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const orchestratorSource = readFileSync(
  new URL('../src/renderer/components/OrchestratorChat.tsx', import.meta.url),
  'utf8'
)
const appStyles = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')

describe('sticky user message collapse', () => {
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
  })
})
