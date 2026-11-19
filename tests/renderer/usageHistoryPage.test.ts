// @vitest-environment jsdom
/**
 * The Usage page: History and Limits tabs; the history's tiles, filters, projects and priciest sessions; and history
 * added up across the person's computers, each sending only its totals over the device link.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderUsage } from '../../src/shared/providerAuth'
import { USAGE_AGENT_LABELS, type UsageAgentId, type UsageHistoryRequest, type UsageHistoryResponse } from '../../src/shared/usageHistory'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { SubscriptionUsagePage } = await import('../../src/renderer/components/SubscriptionUsagePage')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { useComputersStore, NO_COMPUTERS } = await import('../../src/renderer/lib/computers')

const providers: ProviderUsage[] = [
  { id: 'claude-subscription', label: 'Claude subscription', status: 'available', proxy: { address: '127.0.0.1:8317', key: 'saved' }, windows: [{ id: 'seven_day', label: 'Weekly limit', remainingPercent: 58 }] },
  { id: 'xai', label: 'Grok (xAI)', authType: 'oauth', status: 'error', windows: [], problem: 'session_expired', message: 'Grok session expired.' }
]

/** A history as a computer would send it: each agent's tokens on the last day of the range, 10% of them output. */
function history(request: UsageHistoryRequest, tokens: Partial<Record<UsageAgentId, number>>): UsageHistoryResponse {
  const days = request.range === '7d' ? 7 : request.range === '90d' ? 90 : 30
  const dayKeys = Array.from({ length: days }, (_, i) => new Date(Date.UTC(2026, 9, 21) + i * 86_400_000).toISOString().slice(0, 10))
  const rows = Object.entries(tokens).filter(([id]) => !request.agent || id === request.agent) as Array<[UsageAgentId, number]>
  const last = (value: number) => dayKeys.map((_, i) => (i === days - 1 ? value : 0))
  const agents = rows.map(([id, total]) => ({
    id, label: USAGE_AGENT_LABELS[id], sessions: 2, unpricedTokens: 0, costUsd: total / 1e6,
    tokens: { input: 0, cacheRead: total * 0.9, cacheWrite: 0, output: total * 0.1 }, series: last(total), costSeries: last(total / 1e6)
  }))
  const sum = rows.reduce((total, [, value]) => total + value, 0)
  return {
    range: request.range, bucket: 'day', buckets: dayKeys.map((key) => Date.parse(`${key}T00:00:00Z`)), dayKeys, agents,
    models: rows.map(([id, total]) => ({ model: `${id}-model`, agent: id, tokens: total, costUsd: total / 1e6, priced: true })),
    days: [{ day: dayKeys[days - 1]!, tokens: sum, costUsd: sum / 1e6, sessions: 2 * rows.length }],
    totals: { input: 0, cacheRead: sum * 0.9, cacheWrite: 0, output: sum * 0.1 },
    costUsd: sum / 1e6, costByKind: { input: 0, cacheRead: sum * 0.4 / 1e6, cacheWrite: 0, output: sum * 0.6 / 1e6 }, costUnsplitUsd: 0,
    costBySpeed: { fast: 0, standard: sum / 1e6, unknown: 0 },
    // Every computer sends its projects and sessions here; only this computer's may be shown.
    projects: rows.length ? [{ name: `${rows[0]![0]}-project`, tokens: sum, costUsd: sum / 1e6, sessions: 2 }] : [],
    topSessions: rows.map(([id, total], n) => ({
      agent: id, session: `ses-${id}`, model: `${id}-model`, project: `${id}-project`, tokens: total, costUsd: total / 1e6,
      firstAt: 1, lastAt: Date.UTC(2026, 10, 18), ...(n === 0 ? { threadId: 'thr_1', title: 'Fix the login page' } : {})
    })),
    agentIds: Object.keys(tokens) as UsageAgentId[], cacheSavingsUsd: 1, sessions: 2 * rows.length,
    sources: [{ agent: 'claude-code', path: '/home/me/.claude/projects', status: 'read', files: 3, readFiles: 0 }], readAt: '2026-11-19T12:00:00Z', scanMs: 40
  }
}

const usageHistory = vi.fn(async (request: UsageHistoryRequest) => history(request, { 'claude-code': 1_500_000, codex: 500_000 }))
const kept = (used: number) => [{ id: 'claude-subscription', label: 'Claude subscription', windows: [
  { id: 'five_hour', label: '5-hour', points: [[Date.now() - 3_600_000, used]], resets: [] },
  { id: 'seven_day', label: 'Weekly', points: [[Date.now() - 3_600_000, used / 2]], resets: [] }
] }]
const limitTrends = vi.fn(async (_range: string) => ({ trends: kept(30) }))
const platformRequest = vi.fn(async (method: string, params: { target?: string } & UsageHistoryRequest): Promise<unknown> => {
  if (method !== 'bridge.hub.usageHistory') throw Object.assign(new Error('no'), { code: 'method_not_found' })
  if (params.target === 'nod_laptop') return history(params, { 'claude-code': 1_000_000, grok: 200_000 })
  if (params.target === 'nod_old') throw Object.assign(new Error('unknown'), { code: 'method_not_found' })
  return { range: params.range }
})
let root: Root | undefined
let host: HTMLElement | undefined

beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  usageHistory.mockClear()
  limitTrends.mockClear()
  platformRequest.mockClear()
  useAppStore.setState({ profileId: 'prf_work' })
  useComputersStore.setState(NO_COMPUTERS)
  ;(window as unknown as { mousse: unknown }).mousse = {
    providers: {
      usageSlots: async () => ({ slots: providers.map((provider) => ({ id: provider.id, label: provider.label, instanceId: provider.id, ...(provider.authType ? { authType: provider.authType } : {}) })) }),
      getUsageFor: async ({ providerId, preview }: { providerId: string; preview?: boolean }) => (preview ? {} : { provider: providers.find((provider) => provider.id === providerId) }),
      usageHistory,
      limitTrends,
      onSnapshots: () => () => {},
      openLoginUrl: vi.fn()
    },
    platformRequest: { request: platformRequest }
  }
})
afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = undefined
})

const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0)) })
async function render() {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () => { root!.render(createElement(SubscriptionUsagePage, { onClose: () => {} })) })
  await settle()
}
const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!
const visible = (element: HTMLElement | null) => !!element && !element.closest('[hidden]')
const total = () => q('[data-testid="usage-history-total"]')?.textContent
const click = async (element: HTMLElement) => { await act(async () => element.click()); await settle() }
const pick = async (testId: string, option: string) => {
  await click(q(`[data-testid="${testId}"]`)!)
  await click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((element) => element.textContent?.includes(option))!)
}

describe('the Usage page tabs', () => {
  it('opens on History with tokens and cost together; Limits shows the plans instead; the choice is kept', async () => {
    await render()
    expect(q('h1')).toBeNull()
    expect(q('[aria-label="Back"]')).toBeNull()
    expect([...document.querySelectorAll('[role="tab"]')].map((element) => element.textContent)).toEqual(['History', 'Limits'])
    expect(tab('History').getAttribute('aria-selected')).toBe('true')
    expect(total()).toBe('2M')
    expect(q('[data-testid="usage-history-cost"]')!.textContent).toBe('$2.00')
    expect(visible(q('[data-testid="usage-window"]'))).toBe(false)

    await click(tab('Limits'))
    expect(usageHistory).toHaveBeenCalledTimes(1)
    expect(visible(q('[data-testid="usage-history"]'))).toBe(false)
    expect(visible(q('[data-testid="usage-window"]'))).toBe(true)

    act(() => root!.unmount())
    await render()
    expect(tab('Limits').getAttribute('aria-selected')).toBe('true')
  })

  it('Limits shows the trends kept on this computer, read again for another range; an empty state without readings', async () => {
    await render()
    expect(limitTrends).not.toHaveBeenCalled()
    await click(tab('Limits'))
    expect(limitTrends).toHaveBeenLastCalledWith('7d')
    const trends = q('[data-testid="usage-limit-trends"]')!
    expect(visible(trends)).toBe(true)
    expect(trends.textContent).toContain('5-hour')
    expect(trends.textContent).toContain('Weekly')
    await click([...trends.querySelectorAll<HTMLElement>('[role="radio"]')].find((element) => element.textContent === '24h')!)
    expect(limitTrends).toHaveBeenLastCalledWith('24h')

    act(() => root!.unmount())
    limitTrends.mockResolvedValue({ trends: [] })
    await render()
    expect(limitTrends).toHaveBeenCalled()
    expect(q('[data-testid="usage-limit-trends-empty"]')?.textContent).toBe('No limit readings yet')
    expect(visible(q('[data-testid="usage-window"]'))).toBe(true)
  })

  it('the needs-attention chip opens Limits at its section', async () => {
    const scrolled: Element[] = []
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this) }
    await render()
    await click(q('[data-testid="usage-attention-chip"]')!)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })
    expect(tab('Limits').getAttribute('aria-selected')).toBe('true')
    expect(visible(q('#usage-attention'))).toBe(true)
    expect(scrolled.map((element) => element.id)).toEqual(['usage-attention'])
  })
})

describe('the history', () => {
  it('a tile takes its agent out of the chart and back', async () => {
    await render()
    const codex = () => q('[data-testid="usage-agent-tile"][data-agent="codex"]')!
    await click(codex())
    expect(codex().getAttribute('aria-pressed')).toBe('false')
    expect(q('.usage-history-readout')!.textContent).toContain('1 of 2 agents')
    await click(codex())
    expect(q('.usage-history-readout')!.textContent).toContain('All agents')
  })

  it('the provider filter reads that provider only, and still offers the others', async () => {
    await render()
    await pick('usage-history-agent', 'Codex')
    expect(usageHistory).toHaveBeenLastCalledWith(expect.objectContaining({ agent: 'codex' }))
    expect(total()).toBe('500K')
    await click(q('[data-testid="usage-history-agent"]')!)
    expect([...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)).toEqual(['All providers', 'Claude Code', 'Codex'])
  })

  it('lists this computer\'s projects and priciest sessions, a session opening the thread that ran it', async () => {
    await render()
    expect(q('[data-testid="usage-history-projects"]')!.textContent).toContain('claude-code-project')
    const sessions = q('[data-testid="usage-history-sessions"]')!
    expect(q('[data-testid="usage-session-link"]')!.textContent).toBe('Fix the login page')
    // A session no Mousse thread ran is named by its agent, with nothing to open.
    expect(sessions.textContent).toContain('Codex session')
    expect(sessions.querySelectorAll('[data-testid="usage-session-link"]')).toHaveLength(1)
  })

  it('shows no computer filter on a computer with no others', async () => {
    await render()
    expect(q('[data-testid="usage-history-device"]')).toBeNull()
    expect(platformRequest).not.toHaveBeenCalledWith('bridge.hub.usageHistory', expect.anything())
  })
})

describe('history across computers', () => {
  const computers = (...entries: Array<[string, string]>) => useComputersStore.setState({
    loaded: true, routed: true, devices: [],
    byNode: Object.fromEntries(entries.map(([node, name]) => [node, { node, name, online: true } as never]))
  })

  it('All devices adds each computer\'s own totals, and names a computer that could not send them', async () => {
    computers(['nod_laptop', 'Laptop'], ['nod_old', 'Old desktop'], ['nod_bad', 'Odd box'])
    await render()
    expect(platformRequest).toHaveBeenCalledWith('bridge.hub.usageHistory', expect.objectContaining({ target: 'nod_laptop', range: '30d' }))
    expect(total()).toBe('3.2M')
    expect(q('[data-testid="usage-agent-tile"][data-agent="grok"]')).not.toBeNull()
    const sources = q('[data-testid="usage-history-sources"]')!.textContent!
    expect(sources).toContain('2 computers')
    expect(sources).toContain('Old desktop: older version or no permission')
    expect(sources).toContain('Odd box: sent an unreadable reply')
    // Project names stay on each computer: across them the lists are this computer's, and say so.
    const projects = q('[data-testid="usage-history-projects"]')!.textContent!
    expect(projects).toContain('This device only')
    expect(projects).not.toContain('grok')
    expect(q('[data-testid="usage-history-sessions"]')!.textContent).not.toContain('Grok session')
  })

  it('one computer picked: only its history, read over the device link', async () => {
    computers(['nod_laptop', 'Laptop'])
    await render()
    usageHistory.mockClear()
    await pick('usage-history-device', 'Laptop')
    expect(usageHistory).not.toHaveBeenCalled()
    expect(total()).toBe('1.2M')
    expect(q('[data-testid="usage-history-projects"]')!.textContent).toContain('Project names stay on each device')
    expect(q('[data-testid="usage-history-sessions"]')).toBeNull()
  })
})
