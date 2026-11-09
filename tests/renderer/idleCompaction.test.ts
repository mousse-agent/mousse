// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/renderer/lib/settingsNavigation', () => ({ openSettingsSection: vi.fn() }))
import { ComposerFooter, type ComposerFooterProps } from '../../src/renderer/components/ComposerFooter'
import {
  idleCompactionChip,
  promptCacheState,
  promptCacheText,
  shortDuration
} from '../../src/renderer/lib/promptCache'
import type { ProviderWithStatus } from '../../src/renderer/lib/providerSnapshots'
import { normalizeContextSettings, type IdleCompactionSetting } from '../../src/shared/settings'
import { CONTEXT_DRAFT_CATEGORY, type ContextPromptCache, type ContextUsageSnapshot } from '../../src/shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const MINUTE = 60_000
const HOUR = 60 * MINUTE

let root: Root
let host: HTMLElement
beforeEach(() => {
  host = document.createElement('div')
  host.className = 'composer'
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

/** A thread whose last request was `idleMs` ago, with the cache lifetime the provider reported (if any). */
function usage(tokens: number, idleMs: number, ttlMs: number | undefined, extra: Partial<ContextPromptCache> = {}): ContextUsageSnapshot {
  return {
    percent: Math.round((tokens / 1_000_000) * 100),
    used: tokens,
    limit: 1_000_000,
    modelName: null,
    source: 'measured',
    categories: [{ label: 'Prompt cache', color: '#22c55e', tokens }],
    promptCache: { lastRequestAt: Date.now() - idleMs, ...(ttlMs ? { ttlMs } : {}), ...extra }
  }
}

describe('the prompt cache line', () => {
  it('counts down while warm, then says how long ago it expired', () => {
    const now = 10 * HOUR
    expect(promptCacheText(promptCacheState({ lastRequestAt: now - MINUTE - 1, ttlMs: 5 * MINUTE }, now))).toBe('Cache warm · 4m left')
    expect(promptCacheText(promptCacheState({ lastRequestAt: now - (2 * HOUR + 12 * MINUTE), ttlMs: HOUR }, now))).toBe('Cache expired 1h 12m ago')
    expect(promptCacheText(promptCacheState({ lastRequestAt: now - 5 * MINUTE, ttlMs: 5 * MINUTE }, now))).toBe('Cache expired <1m ago')
  })

  it('shows idle time when the provider reports no lifetime', () => {
    const now = 10 * HOUR
    expect(promptCacheText(promptCacheState({ lastRequestAt: now - (HOUR + 12 * MINUTE) }, now))).toBe('Idle 1h 12m')
    expect(promptCacheText(promptCacheState({ lastRequestAt: now - 20_000 }, now))).toBe('Idle <1m')
  })

  it('writes durations short', () => {
    expect(shortDuration(59_999)).toBe('<1m')
    expect(shortDuration(4 * MINUTE + 1, 'up')).toBe('5m')
    expect(shortDuration(2 * HOUR)).toBe('2h')
    expect(shortDuration(51 * HOUR)).toBe('2d 3h')
  })
})

describe('when the Full/Compact chip shows', () => {
  const chip = (snapshot: ContextUsageSnapshot, patch: Partial<{ setting: IdleCompactionSetting; canCompact: boolean; runActive: boolean; compacting: boolean }> = {}) =>
    idleCompactionChip({ usage: snapshot, now: Date.now(), setting: 'suggest', canCompact: true, runActive: false, compacting: false, ...patch })

  it('suggests once the cache expired on a long thread with no run going', () => {
    expect(chip(usage(182_000, 2 * HOUR, HOUR))).toBe('suggest')
    // Still warm: nothing to decide.
    expect(chip(usage(182_000, 10 * MINUTE, HOUR))).toBeNull()
  })

  it('without a lifetime, suggests after an hour idle', () => {
    expect(chip(usage(182_000, HOUR + MINUTE, undefined))).toBe('suggest')
    expect(chip(usage(182_000, 30 * MINUTE, undefined))).toBeNull()
  })

  it('stays away on a short thread, during a run, with the suggestion off, and where nothing can compact', () => {
    expect(chip(usage(39_000, 2 * HOUR, HOUR))).toBeNull()
    // The unsent draft is not part of the context.
    const drafted = usage(30_000, 2 * HOUR, HOUR)
    drafted.categories.push({ label: CONTEXT_DRAFT_CATEGORY, color: '#8b5cf6', tokens: 20_000 })
    expect(chip(drafted)).toBeNull()
    expect(chip(usage(182_000, 2 * HOUR, HOUR), { runActive: true })).toBeNull()
    expect(chip(usage(182_000, 2 * HOUR, HOUR), { setting: 'off' })).toBeNull()
    expect(chip(usage(182_000, 2 * HOUR, HOUR), { canCompact: false })).toBeNull()
    const fresh = usage(182_000, 0, undefined)
    delete fresh.promptCache
    expect(chip(fresh)).toBeNull()
  })

  it('reads Compacting… while a compaction runs, whatever the cache says', () => {
    expect(chip(usage(182_000, MINUTE, HOUR), { compacting: true, runActive: true })).toBe('compacting')
  })
})

function provider(): ProviderWithStatus {
  return {
    id: 'claude-subscription',
    label: 'Claude Code',
    models: [{ id: 'opus', label: 'Opus 5.5' }],
    caps: { toolControl: 'exact', autoPermissionMode: true, contextUsage: 'reported' } as ProviderWithStatus['caps']
  }
}

function render(contextUsage: ContextUsageSnapshot, options: { open?: boolean; setting?: IdleCompactionSetting; compacting?: boolean; loading?: boolean } = {}) {
  const onCompactNow = vi.fn()
  const onContextOpenChange = vi.fn()
  const props: ComposerFooterProps = {
    run: {
      providers: [provider()],
      selectedProviderId: 'claude-subscription',
      selectedModelId: 'opus',
      modelMenuOpen: false,
      onModelMenuOpenChange: vi.fn(),
      onModelSelect: vi.fn(),
      onOpenSettings: vi.fn(),
      contextUsage,
      contextCompactionSetting: normalizeContextSettings({ idleCompaction: options.setting ?? 'suggest' }),
      contextOpen: options.open ?? false,
      onContextOpenChange,
      onCompactNow,
      compacting: options.compacting ?? false
    },
    loading: options.loading ?? false,
    onAttachClick: vi.fn()
  }
  act(() => root.render(createElement(ComposerFooter, props)))
  return { onCompactNow }
}

const chipButton = () => document.querySelector<HTMLElement>('.composer-idle-chip')
const menuRows = () => [...document.querySelectorAll<HTMLElement>('.composer-idle-menu [role="menuitemradio"]')]
const cacheLine = () => document.querySelector('.context-usage-cache')

describe('the composer chip', () => {
  it('stays on Full and offers Compact now, which starts the compaction', () => {
    const { onCompactNow } = render(usage(182_000, 2 * HOUR + 12 * MINUTE, HOUR))
    expect(chipButton()?.textContent).toBe('Full · 182K')
    expect(chipButton()?.getAttribute('aria-haspopup')).toBe('menu')
    act(() => chipButton()!.click())
    expect(document.querySelector('.composer-idle-menu-head')?.textContent).toBe('Cache expired 1h 12m ago')
    expect(menuRows().map((row) => row.getAttribute('aria-label'))).toEqual([
      'Compact now. Summarizes older messages',
      'Full history. Re-reads 182K'
    ])
    // Full is what the next message does until a person picks otherwise.
    expect(menuRows()[1]!.getAttribute('aria-checked')).toBe('true')
    expect(onCompactNow).not.toHaveBeenCalled()
    act(() => menuRows()[0]!.click())
    expect(onCompactNow).toHaveBeenCalledOnce()
    expect(document.querySelector('.composer-idle-menu')).toBeNull()
  })

  it('names the price of re-reading only where the thread pays per token', () => {
    render(usage(182_000, 2 * HOUR, HOUR, { uncachedUsdPerMTok: 3.75 }))
    act(() => chipButton()!.click())
    expect(menuRows()[1]!.textContent).toContain('Re-reads 182K · ≈$0.68')
  })

  it('reads Compacting… while it runs, and is gone when the setting is off or a run goes', () => {
    render(usage(182_000, 2 * HOUR, HOUR), { compacting: true })
    expect(chipButton()?.textContent).toBe('Compacting…')
    expect(chipButton()?.tagName).toBe('SPAN')
    render(usage(182_000, 2 * HOUR, HOUR), { setting: 'off' })
    expect(chipButton()).toBeNull()
    render(usage(182_000, 2 * HOUR, HOUR), { loading: true })
    expect(chipButton()).toBeNull()
  })
})

describe('the context popover cache line', () => {
  it('says the cache expired, with Compact now', () => {
    const { onCompactNow } = render(usage(182_000, 2 * HOUR + 12 * MINUTE, HOUR), { open: true })
    expect(cacheLine()?.textContent).toContain('Cache expired 1h 12m ago')
    expect(cacheLine()?.querySelector('.context-usage-cache-dot')?.classList.contains('is-cold')).toBe(true)
    const compact = [...cacheLine()!.querySelectorAll('button')].find((button) => button.textContent === 'Compact now')!
    act(() => compact.click())
    expect(onCompactNow).toHaveBeenCalledOnce()
  })

  it('counts down while warm, with nothing to do', () => {
    render(usage(182_000, MINUTE, 5 * MINUTE), { open: true })
    expect(cacheLine()?.textContent).toBe('Cache warm · 4m left')
    expect(cacheLine()?.querySelector('.context-usage-cache-dot')?.classList.contains('is-warm')).toBe(true)
    expect(cacheLine()?.querySelector('button')).toBeNull()
  })

  it('keeps the line but offers no Compact now with the suggestion off', () => {
    render(usage(182_000, 2 * HOUR, undefined), { open: true, setting: 'off' })
    expect(cacheLine()?.textContent).toBe('Idle 2h')
    expect(cacheLine()?.querySelector('button')).toBeNull()
  })
})
