import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ThinkingIcon } from '../../src/renderer/lib/icons'
import { LiveThinkingRow, ThinkingCollapsed } from '../../src/renderer/chat/components/agent-elements/tools/thinking-tool'

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
  it('is the atom, with the orbits in their own group around a still centre', () => {
    const html = renderToStaticMarkup(createElement(ThinkingIcon, { size: 18 }))
    expect(html).toContain('width="18"')
    expect(html).toMatch(/<circle[^>]*r="4"/)
    expect(html).toContain('<g class="thinking-icon-orbit">')
    expect(html).not.toMatch(/<g class="thinking-icon-orbit">[^]*<circle/)
  })

  it('rotates while the thought streams', () => {
    const html = renderToStaticMarkup(createElement(ThinkingCollapsed, { step, state: 'animating', onComplete: () => {} }))
    expect(thinkingIcon(html)).toContain('is-thinking')
  })

  it('rotates on the row a turn shows before its first output', () => {
    expect(thinkingIcon(renderToStaticMarkup(createElement(LiveThinkingRow)))).toContain('is-thinking')
  })

  it('is still once the thought is done', () => {
    const html = renderToStaticMarkup(createElement(ThinkingCollapsed, { step, state: 'complete', onComplete: () => {} }))
    expect(thinkingIcon(html)).not.toBe('')
    expect(thinkingIcon(html)).not.toContain('is-thinking')
  })

  it('sweeps with the label shimmer: same period, set once on the row', () => {
    const html = renderToStaticMarkup(createElement(LiveThinkingRow))
    expect(html).toContain('--an-shimmer-duration:1.2s')
    expect(html).toMatch(/an-text-shimmer[^>]*animation-duration:1.2s/)
    const css = readFileSync('src/renderer/styles/thinking-icon.css', 'utf8')
    expect(css).toMatch(/\.thinking-icon\.is-thinking\s*\{[^}]*animation:\s*thinking-icon-sweep var\(--an-shimmer-duration/)
  })

  it('neither sweeps nor turns with motion off or reduced', () => {
    const css = readFileSync('src/renderer/styles/thinking-icon.css', 'utf8')
    expect(css).toMatch(/\[data-motion='off'\] \.thinking-icon\.is-thinking,\s*\[data-motion='off'\] \.thinking-icon\.is-thinking \.thinking-icon-orbit\s*\{\s*animation: none !important;/)
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.thinking-icon\.is-thinking,\s*\.thinking-icon\.is-thinking \.thinking-icon-orbit\s*\{\s*animation: none !important;/)
  })
})
