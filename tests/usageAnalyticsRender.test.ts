import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildLineEditSnapshot, buildUsageStatsSnapshot } from '../src/shared/lineEditStats'
import { LineEditHeatmap } from '../src/renderer/components/LineEditHeatmap'

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
  })
})
