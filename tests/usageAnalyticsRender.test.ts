import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildLineEditSnapshot, buildUsageStatsSnapshot } from '../src/shared/lineEditStats'
import { LineEditHeatmap } from '../src/renderer/components/LineEditHeatmap'

describe('Settings usage analytics rendering', () => {
  it('renders metric/provider/model controls and graphical token summaries', () => {
    const usage = buildUsageStatsSnapshot([{
      timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test',
      input: 1_000, output: 250, cacheRead: 500, cacheWrite: 50
    }])
    const html = renderToStaticMarkup(React.createElement(LineEditHeatmap, {
      stats: buildLineEditSnapshot({}), usage
    }))

    expect(html).toContain('Heatmap metric')
    expect(html).toContain('Provider filter')
    expect(html).toContain('Model filter')
    expect(html).toContain('Tokens in')
    expect(html).toContain('Tokens out')
    expect(html).toContain('Cached')
    expect(html).toContain('Cache ratio')
    expect(html).toContain('usage-stat-track')
    expect(html).toContain('openai')
    expect(html).toContain('gpt-test')
  })
})
