import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeProviderId, ProviderIcon, providerIconKey, providerMakerId, resetRegisteredIcons } from '../../src/renderer/lib/providerIcons'
import { makerLabelOf } from '../../src/renderer/components/ModelFamilyMenu'
import { applySnapshotsEvent, DEVICE_SCOPE, instanceBadges, useProviderSnapshotsStore } from '../../src/renderer/lib/providerSnapshots'
import { iconIdOf } from '../../src/renderer/components/providers/providerView'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { snapshot } from '../providerSnapshotFixture'
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
      expect(markup, id).toContain('<img ')
      expect(markup, id).not.toContain('mask-image')
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
      ['antigravity', 'antigravity'],
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

/** Two registry icons as the daemon sends them: a one-ink mark, and a tile with a white cut-out. */
const INK = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M0 0h16v16z"/></svg>').toString('base64')}`
const TILE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/><path fill="#fff" d="M4 4h8v8z"/></svg>').toString('base64')}`

function acpEntry(instanceId: string, agentId?: string, icon?: Pick<InstanceSnapshot, 'iconDataUrl' | 'iconMonochrome'>): InstanceSnapshot {
  return snapshot({
    instanceId,
    driver: 'acp',
    displayName: instanceId,
    builtIn: false,
    config: { home: 'default', args: [], env: {}, ...(agentId ? { source: { kind: 'registry', agentId, version: '1.0.0', distribution: 'binary' } } : {}) },
    ...icon
  })
}

describe('ACP agent logos', () => {
  afterEach(() => {
    useProviderSnapshotsStore.setState({ scopes: {} })
    resetRegisteredIcons()
  })
  const generic = () => render('acp')

  // Registry ids (tests/harness/fixtures/acp-registry-icons-2026-11-24.json) Mousse ships a logo for.
  it.each([
    ['acp:opencode', 'opencode'],
    ['acp:opencode-v2', 'opencode'],
    ['acp:gemini', 'google'],
    ['acp:antigravity-acp', 'antigravity'],
    ['acp:github-copilot-cli', 'copilot'],
    ['acp:qwen-code', 'qwen'],
    ['acp:kimi', 'kimi'],
    ['acp:kimi-code', 'kimi'],
    ['acp:minimax-code', 'minimax'],
    ['acp:mistral-vibe', 'mistral'],
    ['acp:glm-acp-agent', 'zhipu'],
    ['acp:grok-build', 'xai'],
    ['acp:cursor', 'cursor']
  ])('%s shows the %s logo Mousse ships', (providerId, brand) => {
    expect(normalizeProviderId(providerId)).toBe(brand)
    expect(render(providerId)).toBe(render(brand))
    expect(render(providerId)).not.toBe(generic())
  })

  // A custom entry (its own command, no registry source) is named freely: a brand's name inside
  // its id is not that brand.
  it.each([
    ['acp:metadata-agent', 'meta', 'Meta'],
    ['acp:openai-helper', 'openai', 'OpenAI'],
    ['acp:my-gemini-wrapper', 'google', 'Google'],
    ['acp:opencode-fork', 'opencode', 'OpenCode']
  ])('a custom %s shows the generic mark and is not %s', (providerId, brand, brandLabel) => {
    applySnapshotsEvent({ scope: DEVICE_SCOPE, snapshots: [acpEntry(providerId)] })
    expect(render(providerId)).toBe(generic())
    expect(providerIconKey(providerId)).toBe('generic')
    // The model picker names the maker of its models, since the entry is not that maker.
    expect(providerMakerId(providerId)).not.toBe(brand)
    expect(makerLabelOf(providerId, providerId.slice(4), { brandId: brand, brandLabel })).toBe(brandLabel)
  })

  it('takes the agent an entry runs from this computer first, and from other scopes only when they agree', () => {
    const project = (projectId: string) => ({ kind: 'project' as const, projectId })
    applySnapshotsEvent({ scope: project('a'), snapshots: [acpEntry('acp:work', 'opencode'), acpEntry('acp:shared', 'goose', { iconDataUrl: INK, iconMonochrome: true })] })
    applySnapshotsEvent({ scope: project('b'), snapshots: [acpEntry('acp:shared', 'goose', { iconDataUrl: INK, iconMonochrome: true }), acpEntry('acp:split', 'opencode')] })
    applySnapshotsEvent({ scope: project('c'), snapshots: [acpEntry('acp:split', 'tile-agent', { iconDataUrl: TILE, iconMonochrome: false })] })
    applySnapshotsEvent({ scope: DEVICE_SCOPE, snapshots: [acpEntry('acp:work', 'goose', { iconDataUrl: INK, iconMonochrome: true })] })
    // This computer's `acp:work` runs Goose, whatever scope loaded last.
    expect(providerIconKey('acp:work')).toBe('agent:goose')
    applySnapshotsEvent({ scope: project('a'), snapshots: [acpEntry('acp:work', 'opencode'), acpEntry('acp:shared', 'goose', { iconDataUrl: INK, iconMonochrome: true })] })
    expect(providerIconKey('acp:work')).toBe('agent:goose')
    // Only in projects: shown when they agree, generic when they run different agents.
    expect(providerIconKey('acp:shared')).toBe('agent:goose')
    expect(providerIconKey('acp:split')).toBe('generic')
    // A scope that is gone is forgotten.
    useProviderSnapshotsStore.setState((state) => ({ scopes: Object.fromEntries(Object.entries(state.scopes).filter(([key]) => key !== 'project:c')) }))
    expect(providerIconKey('acp:split')).toBe('opencode')
  })

  it('names an entry by the registry agent it runs, whatever it is called, else by its own id', () => {
    const rows: Array<[Parameters<typeof iconIdOf>[0], string]> = [
      [acpEntry('acp:opencode'), 'acp:opencode'],
      [acpEntry('acp:work', 'opencode'), 'opencode'],
      [acpEntry('acp:work', 'goose'), 'goose'],
      [acpEntry('acp:my-script'), 'acp:my-script'],
      // Callers that know only the driver and id (the downloads list) still reach the entry.
      [{ driver: 'acp', instanceId: 'acp:work' }, 'acp:work'],
      [{ driver: 'claude', instanceId: 'claude:work' }, 'claude'],
      [{ driver: 'pi', instanceId: 'pi:openai' }, 'pi:openai']
    ]
    for (const [entry, iconId] of rows) expect(iconIdOf(entry), entry.instanceId).toBe(iconId)
  })

  it('draws the icon a snapshot carries wherever the entry is named, by its id or its agent', () => {
    applySnapshotsEvent({
      scope: DEVICE_SCOPE,
      snapshots: [
        acpEntry('acp:work', 'goose', { iconDataUrl: INK, iconMonochrome: true }),
        acpEntry('acp:my-coding-agent', 'opencode'),
        acpEntry('acp:openai-helper', 'kilo'),
        acpEntry('acp:tile', 'tile-agent', { iconDataUrl: TILE, iconMonochrome: false })
      ]
    })
    // One ink follows the text colour, so it reads on light and dark themes.
    const work = render('acp:work')
    expect(work).toContain(INK)
    expect(work).toContain('background-color:currentColor')
    // Settings and the editor name it by its agent (`iconIdOf`).
    expect(render(iconIdOf(acpEntry('acp:work', 'goose')))).toBe(work)
    // A renamed OpenCode entry keeps the OpenCode logo Mousse ships.
    expect(render('acp:my-coding-agent')).toBe(render('opencode'))
    // An entry's own name never borrows another brand's logo; with no icon yet it is generic.
    expect(render('acp:openai-helper')).toBe(generic())
    // A tile with a cut-out is an image, never a mask (which would fill it to a square).
    expect(render('acp:tile')).toMatch(/^<img /)
    expect(render('acp:tile')).toContain(`src="${TILE}"`)
  })

  it('shows only SVG data URLs, never a remote icon', () => {
    applySnapshotsEvent({
      scope: DEVICE_SCOPE,
      snapshots: [
        acpEntry('acp:remote', 'remote', { iconDataUrl: 'https://cdn.agentclientprotocol.com/registry/v1/latest/goose.svg', iconMonochrome: true }),
        acpEntry('acp:escape', 'escape', { iconDataUrl: `${INK}")`, iconMonochrome: true }),
        acpEntry('acp:png', 'png', { iconDataUrl: 'data:image/png;base64,AAAA', iconMonochrome: false })
      ]
    })
    for (const id of ['acp:remote', 'acp:escape', 'acp:png']) expect(render(id), id).toBe(generic())
  })

  it('badges only entries that share a logo: two agents never, one agent twice yes', () => {
    applySnapshotsEvent({
      scope: DEVICE_SCOPE,
      snapshots: [
        acpEntry('acp:opencode', 'opencode'),
        acpEntry('acp:goose', 'goose', { iconDataUrl: INK, iconMonochrome: true }),
        acpEntry('acp:work', 'goose', { iconDataUrl: INK, iconMonochrome: true })
      ]
    })
    const entries = [['acp:opencode', 'OpenCode'], ['acp:goose', 'Goose'], ['acp:work', 'Goose Work']]
    const badges = instanceBadges(entries.map(([key, label]) => ({ key: key!, iconKey: providerIconKey(key!), label: label! })))
    expect(Object.fromEntries(badges)).toEqual({ 'acp:work': 'W' })
  })
})
