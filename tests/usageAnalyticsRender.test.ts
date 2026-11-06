import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { buildLineEditSnapshot, buildUsageStatsSnapshot } from '../src/shared/lineEditStats'
import { LineEditHeatmap } from '../src/renderer/components/LineEditHeatmap'

// The themed select renders options only while open; the stub lists them as markup.
vi.mock('../src/renderer/components/ui/Select', () => import('./support/selectStub'))

describe('Settings usage analytics rendering', () => {
  it('renders the token summary figures from the snapshot, with no filter when there is one provider and one model', () => {
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
    expect(html).not.toContain('Provider filter')
    expect(html).not.toContain('Model filter')
    // Counts carry no bar; only the cache ratio gets a gauge.
    expect(html).not.toContain('usage-stat-track')
    expect(html.match(/class="usage-gauge"/g)).toHaveLength(1)
  })

  it('lists the providers and models as filters when there is more than one', () => {
    const usage = buildUsageStatsSnapshot([
      { timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 },
      { timestamp: '2026-08-26T10:00:00.000Z', provider: 'anthropic', model: 'claude-test', input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }
    ])
    const html = renderToStaticMarkup(React.createElement(LineEditHeatmap, { stats: buildLineEditSnapshot({}), usage }))
    expect(html).toContain('aria-label="Provider filter"')
    expect(html).toContain('aria-label="Model filter"')
    expect(html).toContain('openai')
    expect(html).toContain('GPT-Test')
  })

  it('says none is recorded instead of showing dashes, a plain 0% and no gauge at zero, and compacts large counts', () => {
    const render = (usage: ReturnType<typeof buildUsageStatsSnapshot>) => renderToStaticMarkup(React.createElement(LineEditHeatmap, {
      stats: buildLineEditSnapshot({}), usage
    }))

    const empty = render(buildUsageStatsSnapshot([]))
    expect(empty).not.toContain('usage-gauge')
    expect(empty).toContain('No token usage recorded yet')
    expect(empty).not.toContain('Cache ratio')
    expect(empty).not.toContain('—')

    const uncached = render(buildUsageStatsSnapshot([{
      timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test',
      input: 1_250_000, output: 40, cacheRead: 0, cacheWrite: 0
    }]))
    const text = uncached.replace(/<[^>]+>/g, '|')
    expect(uncached).not.toContain('usage-gauge')
    expect(text).toMatch(/Cache ratio\|+0%/)
    // Compact in the machine's locale: 1.3M in US English, 12.5L in Indian English.
    const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(1_250_000)
    expect(text.replace(/\|+/g, '|')).toContain(`|Tokens in|${compact}|`)
    expect(text).toMatch(/Cached\|+0\|/)
  })
})

describe('Activity history states', () => {
  const render = (props: Partial<React.ComponentProps<typeof LineEditHeatmap>>) => renderToStaticMarkup(React.createElement(LineEditHeatmap, {
    stats: buildLineEditSnapshot({}), ...props
  }))

  it('an empty edit history is one line: no total, heatmap, legend or highlights', () => {
    const html = render({ usage: buildUsageStatsSnapshot([]) })
    expect(html).toContain('No edits recorded yet')
    expect(html).toContain('aria-label="Heatmap metric"')
    expect(html).not.toContain('lines edited')
    expect(html).not.toContain('line-edit-grid')
    expect(html).not.toContain('Fewer')
    expect(html).not.toContain('Most active')
  })

  it('a recorded history keeps the heatmap and shows only the highlights it has', () => {
    const html = render({ stats: buildLineEditSnapshot({ '2025-03-04': { orchestrator: 12, manual: 0 } }), usage: null })
    expect(html).toMatch(/>12<.*lines edited/)
    expect(html).toContain('line-edit-grid')
    expect(html).toContain('Fewer')
    expect(html).toContain('Most active month')
    expect(html).toContain('Longest streak')
    // No edit today, so there is no current streak to show.
    expect(html).not.toContain('Current streak')
  })

  it('token usage that failed to load is unavailable, not zero; while it loads its group holds a pending slot, no figures', () => {
    const failed = render({ usage: null, usageFailed: true })
    expect(failed).toContain('Token usage unavailable')
    expect(failed).not.toContain('Tokens in')
    expect(failed).not.toContain('Provider filter')

    const loading = render({ usage: null })
    expect(loading).toContain('Token usage')
    expect(loading).toContain('data-testid="activity-pending"')
    expect(loading).not.toContain('Tokens in')
    expect(loading).not.toContain('No token usage')
  })

  it('edits that failed to load say so, and never hide token usage that loaded', () => {
    const usage = buildUsageStatsSnapshot([{ timestamp: '2026-08-25T10:00:00.000Z', provider: 'openai', model: 'gpt-test', input: 1_000, output: 250, cacheRead: 0, cacheWrite: 0 }])
    const html = render({ stats: null, statsFailed: true, usage })
    expect(html).toContain('Couldn’t load activity.')
    expect(html).not.toContain('No edits recorded yet')
    expect(html).not.toContain('lines edited')
    expect(html.replace(/<[^>]+>/g, '|')).toMatch(/Tokens in\|+1,000\b/)

    const pending = render({ stats: null, usage })
    expect(pending).toContain('data-testid="activity-pending"')
    expect(pending).not.toContain('No edits recorded yet')
    expect(pending).not.toContain('Loading activity…')
  })
})
