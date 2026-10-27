import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { normalizeProviderId, ProviderIcon } from '../../src/renderer/lib/providerIcons'
import { SubagentAvatar } from '../../src/renderer/components/SubagentAvatar'
import { subagentBadgeTone, subagentIconId, threadProviderId, type SubagentBadgeTone } from '../../src/renderer/components/subagentStatus'
import type { SubagentState } from '../../src/shared/subagents'
import { placeTooltip } from '../../src/renderer/components/AppTooltip'

const render = (providerId: string) => renderToStaticMarkup(createElement(ProviderIcon, { providerId, size: 16 }))

describe('ProviderIcon colours', () => {
  it('draws the Claude and Anthropic marks in Claude orange', () => {
    for (const id of ['claude', 'claude-subscription', 'anthropic', 'pi:anthropic', 'claude:work']) {
      const markup = render(id)
      expect(markup, id).toContain('data-provider-mark="mono"')
      expect(markup, id).toContain('background-color:#D97757')
    }
  })

  it('draws black marks in the text colour so they read on dark and light themes', () => {
    for (const id of ['codex', 'openai', 'xai', 'cursor']) {
      const markup = render(id)
      expect(markup, id).toContain('background-color:currentColor')
      expect(markup, id).toContain('mask-image')
    }
  })

  it('keeps multi-colour logos as their own artwork with no filter', () => {
    for (const id of ['antigravity', 'google', 'mistral']) {
      const markup = render(id)
      expect(markup, id).toMatch(/^<img /)
      expect(markup, id).not.toContain('filter')
    }
  })
})

describe('placeTooltip', () => {
  const viewport = { width: 1000, height: 800 }
  const box = { width: 120, height: 24 }

  const element = { top: 300, left: 100, width: 30, height: 30 }

  it('keeps the default tooltip centred above the element', () => {
    expect(placeTooltip(element, box, viewport)).toEqual({ top: 268, left: 55 })
  })

  it('puts a left tooltip just outside the left edge, vertically centred', () => {
    const anchor = { top: 300, left: 400, width: 40, height: 30, side: 'left' as const }
    expect(placeTooltip(anchor, box, viewport)).toEqual({ top: 303, left: 272 })
  })

  it('flips a left tooltip to the right only when the left has no room', () => {
    const anchor = { top: 300, left: 60, width: 40, height: 30, side: 'left' as const }
    expect(placeTooltip(anchor, box, viewport)).toEqual({ top: 303, left: 108 })
  })

  it('clamps a left tooltip to the window', () => {
    const anchor = { top: 790, left: 400, width: 40, height: 10, side: 'left' as const }
    expect(placeTooltip(anchor, box, viewport)).toEqual({ top: 768, left: 272 })
  })
})

describe('subagent provider icons', () => {
  it('maps the providers a subagent runs on to their logos', () => {
    const cases: Array<[string, string]> = [
      ['claude', 'claude'],
      ['claude:work', 'claude'],
      ['codex', 'openai'],
      ['cursor', 'cursor'],
      ['opencode', 'opencode'],
      ['antigravity', 'google'],
      ['pi:openai', 'openai']
    ]
    for (const [provider, logo] of cases) expect(normalizeProviderId(subagentIconId(provider, null)), provider).toBe(logo)
  })

  it('falls back to the provider the subagent inherited, then to the generic mark', () => {
    expect(subagentIconId(null, 'codex')).toBe('codex')
    expect(subagentIconId('cursor', 'codex')).toBe('cursor')
    expect(subagentIconId(null, null)).toBe('')
    expect(render('')).toContain('<svg')
  })

  it("takes a thread's provider from its override, else the default provider", () => {
    expect(threadProviderId('codex', 'claude')).toBe('codex')
    expect(threadProviderId(undefined, 'claude')).toBe('claude')
    expect(threadProviderId('', '')).toBeNull()
  })

  it('colours the status dot by state', () => {
    const tone = (state: SubagentState, pending = false) => subagentBadgeTone({ state, pending })
    expect(['queued', 'starting', 'working'].map((state) => tone(state as SubagentState))).toEqual(['running', 'running', 'running'])
    expect(tone('done', true)).toBe('running')
    expect([tone('needs_input'), tone('waiting'), tone('paused')]).toEqual(['attention', 'attention', 'attention'])
    expect(tone('done')).toBe('done')
    expect([tone('failed'), tone('interrupted')]).toEqual(['failed', 'failed'])
    expect([tone('stopped'), tone('idle')]).toEqual(['idle', 'idle'])
  })

  it('draws the dot on the icon only when given a state', () => {
    const avatar = (tone?: SubagentBadgeTone) => renderToStaticMarkup(createElement(SubagentAvatar, { providerId: 'claude', tone }))
    expect(avatar('running')).toContain('class="subagent-avatar-badge" data-tone="running"')
    expect(avatar()).not.toContain('subagent-avatar-badge')
  })
})
