import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThinkingCollapsed } from '../../src/renderer/chat/components/agent-elements/tools/thinking-tool'

const step = {
  id: 'thought-1',
  type: 'tool-call' as const,
  toolName: 'Thinking',
  toolDetail: '',
  duration: 0,
  toolVariant: 'thinking' as const,
  thoughtContent: '**Planning**\nRead the file first.',
}

const thinkingIcon = (html: string) => html.match(/<svg[^>]*class="[^"]*thinking-icon[^"]*"[^>]*>/)?.[0] ?? ''

describe('Thinking icon', () => {
  it('pulses while the thought streams', () => {
    const html = renderToStaticMarkup(createElement(ThinkingCollapsed, { step, state: 'animating', onComplete: () => {} }))
    expect(thinkingIcon(html)).toContain('is-thinking')
  })

  it('is still once the thought is done', () => {
    const html = renderToStaticMarkup(createElement(ThinkingCollapsed, { step, state: 'complete', onComplete: () => {} }))
    expect(thinkingIcon(html)).not.toBe('')
    expect(thinkingIcon(html)).not.toContain('is-thinking')
  })

  it('is still with motion off or reduced', () => {
    const css = readFileSync('src/renderer/styles/thinking-icon.css', 'utf8')
    expect(css).toMatch(/\[data-motion='off'\] \.thinking-icon\.is-thinking\s*\{\s*animation: none !important;/)
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.thinking-icon\.is-thinking\s*\{\s*animation: none !important;/)
  })
})

describe('Thinking shimmer in light themes', () => {
  const globalCss = readFileSync('src/renderer/styles/global.css', 'utf8')
  const agentCss = readFileSync('src/renderer/chat/components/agent-elements/agent-ui.css', 'utf8')

  it('gives light (and system on a light OS) two different shimmer colours, from theme tokens', () => {
    const pairs = [...globalCss.matchAll(/--an-shimmer-base: ([^;]+);\s*--an-shimmer-peak: ([^;]+);/g)]
    expect(pairs).toHaveLength(2)
    for (const [, base, peak] of pairs) {
      expect(base).not.toBe(peak)
      expect(`${base}${peak}`).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    }
  })

  it('sweeps the label with the pair', () => {
    expect(agentCss).toContain('var(--an-shimmer-base, var(--an-foreground-subtle, #a3a3a3))')
    expect(agentCss).toContain('var(--an-shimmer-peak, var(--an-foreground-muted, #737373))')
  })
})
