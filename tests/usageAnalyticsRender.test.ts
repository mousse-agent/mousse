import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { buildLineEditSnapshot, buildUsageStatsSnapshot } from '../src/shared/lineEditStats'
import { LineEditHeatmap } from '../src/renderer/components/LineEditHeatmap'

// The themed select renders options only while open; the stub lists them as markup.
vi.mock('../src/renderer/components/ui/Select', () => import('./support/selectStub'))

describe('Settings usage analytics rendering', () => {
  it('renders the token summary figures and the provider and model options from the snapshot', () => {
    const usage = buildUsageStatsSnapshot([{
      timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test',
      input: 1_000, output: 250, cacheRead: 500, cacheWrite: 50
    }])
    const html = renderToStaticMarkup(React.createElement(LineEditHeatmap, {
      stats: buildLineEditSnapshot({}), usage
    }))

    // Visible text with tags removed: the figures come from the snapshot, cache = read + write.
    const text = html.replace(/<[^>]+>/g, '|')
    expect(text).toMatch(/Tokens in\|+1,000\b/)
    expect(text).toMatch(/Tokens out\|+250\b/)
    expect(text).toMatch(/Cached\|+550\b/)
    expect(text).toMatch(/Cache ratio\|+33\.3%/)
    expect(text).toContain('openai')
    expect(text).toContain('gpt-test')
    // Counts carry no bar; only the cache ratio gets a gauge.
    expect(html).not.toContain('usage-stat-track')
    expect(html.match(/class="usage-gauge"/g)).toHaveLength(1)
  })

  it('shows a dash and no gauge without data, a plain 0% and no gauge at zero, and compacts large counts', () => {
    const render = (usage: ReturnType<typeof buildUsageStatsSnapshot>) => renderToStaticMarkup(React.createElement(LineEditHeatmap, {
      stats: buildLineEditSnapshot({}), usage
    }))

    const empty = render(buildUsageStatsSnapshot([]))
    expect(empty).not.toContain('usage-gauge')
    expect(empty.replace(/<[^>]+>/g, '|')).toMatch(/Cache ratio\|+—/)

    const uncached = render(buildUsageStatsSnapshot([{
      timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test',
      input: 1_250_000, output: 40, cacheRead: 0, cacheWrite: 0
    }]))
    const text = uncached.replace(/<[^>]+>/g, '|')
    expect(uncached).not.toContain('usage-gauge')
    expect(text).toMatch(/Cache ratio\|+0%/)
    expect(text).toMatch(/Tokens in\|+1\.3M/)
    expect(text).toMatch(/Cached\|+0\|/)
  })
})
