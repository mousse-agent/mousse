// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const navigation = vi.hoisted(() => ({ openSettingsSection: vi.fn() }))
vi.mock('../../src/renderer/lib/settingsNavigation', () => ({ openSettingsSection: navigation.openSettingsSection }))
import { ComposerFooter, type ComposerFooterProps } from '../../src/renderer/components/ComposerFooter'
import { contextUsageKnown, contextUsageLevel, contextUsageSummary } from '../../src/renderer/components/ContextUsagePopover'
import type { CompactionSetting } from '../../src/shared/contextCompaction'
import type { ProviderWithStatus } from '../../src/renderer/lib/providerSnapshots'
import { computeContextUsage } from '../../src/mms/orchestrator/contextUsage'
import { CONTEXT_DRAFT_CATEGORY, type ContextUsageSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function provider(contextUsage: 'reported' | 'none' = 'reported'): ProviderWithStatus {
  return {
    id: 'claude-subscription',
    label: 'Claude Code',
    models: [{ id: 'opus', label: 'Opus 5.5' }],
    caps: { toolControl: 'exact', autoPermissionMode: true, contextUsage } as ProviderWithStatus['caps']
  }
}

function usage(used: number, limit = 200_000, extra: Partial<ContextUsageSnapshot> = {}): ContextUsageSnapshot {
  return {
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    used,
    limit,
    modelName: null,
    source: 'measured',
    categories: used > 0 ? [{ label: 'Prompt cache', color: '#22c55e', tokens: used }] : [],
    ...extra
  }
}

function render(contextUsage: ContextUsageSnapshot, options: { open?: boolean; reports?: 'reported' | 'none'; compaction?: CompactionSetting } = {}) {
  const onContextOpenChange = vi.fn()
  const props: ComposerFooterProps = {
    providers: [provider(options.reports)],
    selectedProviderId: 'claude-subscription',
    selectedModelId: 'opus',
    modelMenuOpen: false,
    onModelMenuOpenChange: vi.fn(),
    onModelSelect: vi.fn(),
    onOpenSettings: vi.fn(),
    contextUsage,
    ...(options.compaction ? { contextCompactionSetting: options.compaction } : {}),
    contextOpen: options.open ?? false,
    onContextOpenChange,
    onAttachClick: vi.fn()
  }
  act(() => root.render(createElement(ComposerFooter, props)))
  return { onContextOpenChange }
}

const ring = () => document.querySelector<HTMLButtonElement>('.context-usage-btn')
const ringLevel = () => document.querySelector('.context-usage-ring')?.getAttribute('class')

describe('context ring', () => {
  it('is hidden on a new chat, before the first measurement and when the provider reports none', () => {
    render(usage(0))
    expect(ring()).toBeNull()

    // A typed draft is not context yet.
    render(usage(12, 200_000, { source: 'estimated', categories: [{ label: CONTEXT_DRAFT_CATEGORY, color: '#8b5cf6', tokens: 12 }] }))
    expect(ring()).toBeNull()

    // The composer's placeholder before the first snapshot arrives has no capacity.
    render(usage(0, 0))
    expect(ring()).toBeNull()

    render(usage(124_000), { reports: 'none' })
    expect(ring()).toBeNull()
  })

  it('is hidden for a provider that reports usage but has no measured window yet', () => {
    render(computeContextUsage({
      messages: [], draftInput: '', contextLimit: 0, modelName: 'opus',
      lastMeasuredInput: 2_000, lastMeasuredCacheRead: 40_000, lastMeasuredCacheWrite: 0, measuredAtMessageLength: 0
    }))
    expect(ring()).toBeNull()
  })

  it('names the share and totals in its tooltip and colours by level', () => {
    render(usage(124_000))
    expect(ring()?.title).toBe('62% · 124K of 200K')
    expect(ring()?.getAttribute('aria-label')).toBe('Context usage: 62% · 124K of 200K tokens')
    expect(ringLevel()).toContain('is-normal')

    render(usage(160_000))
    expect(ringLevel()).toContain('is-warning')

    render(usage(184_000))
    expect(ringLevel()).toContain('is-danger')
  })

  it('marks an estimate with ~ and a tiny share as <1%', () => {
    expect(contextUsageSummary(usage(900, 200_000, { source: 'estimated' }))).toBe('<1% · ~900 of 200K')
  })

  it('opens a popover with one line of share and totals above the bar', () => {
    render(usage(124_000), { open: true })
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.getAttribute('aria-label')).toBe('Context usage: 62% · 124K of 200K tokens')
    const summary = dialog?.querySelector('.context-usage-summary')
    expect(summary?.textContent).toBe('62% · 124K of 200K')
    expect(summary?.nextElementSibling?.querySelector('.context-usage-bar')).not.toBeNull()
    expect(dialog?.textContent).toContain('Prompt cache')
  })

  it('closes its popover when usage becomes unknown', () => {
    const { onContextOpenChange } = render(usage(0), { open: true })
    expect(onContextOpenChange).toHaveBeenCalledWith(false)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})

describe('compaction in the popover', () => {
  const at = (compactionTokens: number | 'model-max'): CompactionSetting => ({ compactionEnabled: true, compactionTokens })
  const barMark = () => document.querySelector<HTMLElement>('.context-usage-bar-compaction')
  const compactionLine = () => document.querySelector('.context-usage-compaction-text')?.textContent

  it('leaves the ring as it is', () => {
    render(usage(124_000, 1_000_000), { compaction: at(300_000) })
    expect(ring()?.title).toBe('12% · 124K of 1M')
    expect(ring()?.querySelectorAll('svg > *')).toHaveLength(2)
  })

  it('marks the same point on the popover bar', () => {
    render(usage(124_000, 1_000_000), { compaction: at(300_000), open: true })
    expect(barMark()?.style.left).toBe('30%')

    render(usage(124_000, 1_000_000), { compaction: { compactionEnabled: false, compactionTokens: 300_000 }, open: true })
    expect(barMark()).toBeNull()

    render(usage(124_000, 1_000_000, { compactedByRuntime: true }), { compaction: at(300_000), open: true })
    expect(barMark()).toBeNull()

    render(usage(124_000, 1_000_000), { open: true })
    expect(barMark()).toBeNull()
  })

  it('caps a size beyond the window as the daemon does', () => {
    render(usage(124_000, 200_000), { compaction: at(300_000), open: true })
    expect(barMark()?.style.left).toBe('91.808%')
    expect(compactionLine()).toBe('Compacts at 184K')
  })

  it('says where the context compacts in the popover', () => {
    render(usage(124_000, 1_000_000), { compaction: at(300_000), open: true })
    expect(compactionLine()).toBe('Compacts at 300K')

    render(usage(124_000, 1_000_000), { compaction: at('model-max'), open: true })
    expect(compactionLine()).toBe('Compacts at 950K')

    render(usage(124_000, 1_000_000, { compactedByRuntime: true }), { compaction: at(300_000), open: true })
    expect(compactionLine()).toBe('Compacts near the limit')

    render(usage(124_000, 1_000_000), { compaction: { compactionEnabled: false, compactionTokens: 'model-max' }, open: true })
    expect(compactionLine()).toBe('Compaction off')
  })

  it('has no compaction line before the setting is read', () => {
    render(usage(124_000, 1_000_000), { open: true })
    expect(document.querySelector('.context-usage-compaction')).toBeNull()
  })

  it('opens Settings at the Compact context row from Change', () => {
    navigation.openSettingsSection.mockClear()
    const { onContextOpenChange } = render(usage(124_000, 1_000_000), { compaction: at(300_000), open: true })
    const change = document.querySelector<HTMLButtonElement>('.context-usage-compaction-change')
    expect(change?.textContent).toBe('Change')
    expect(change?.classList.contains('btn-ghost')).toBe(true)
    act(() => change?.click())
    expect(onContextOpenChange).toHaveBeenCalledWith(false)
    expect(navigation.openSettingsSection).toHaveBeenCalledWith('context')
  })
})

describe('context usage helpers', () => {
  it('switches level at 75% and 90%', () => {
    expect([0, 74, 75, 89, 90, 100].map(contextUsageLevel)).toEqual(['normal', 'normal', 'warning', 'warning', 'danger', 'danger'])
  })

  it('counts usage as known only with capacity and context tokens', () => {
    expect(contextUsageKnown(usage(1))).toBe(true)
    expect(contextUsageKnown(usage(0))).toBe(false)
    expect(contextUsageKnown(usage(500, 0))).toBe(false)
  })
})
