// @vitest-environment jsdom
/**
 * Add provider → More ACP agents: each agent in the list shows its own logo, the list answers
 * before the registry icons arrive and draws them as they do, and an icon found there also reaches
 * an added entry of that agent elsewhere in the app. Mounted with only the registry search stubbed.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RegistryAgentList } from '../../src/renderer/components/providers/RegistryAgents'
import { ProviderIcon, resetRegisteredIcons } from '../../src/renderer/lib/providerIcons'
import { applySnapshotsEvent, DEVICE_SCOPE, useProviderSnapshotsStore } from '../../src/renderer/lib/providerSnapshots'
import type { RegistryAgentView } from '../../src/shared/harness/types'
import { snapshot } from '../providerSnapshotFixture'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** Two registry icons as the daemon sends them: a one-ink mark, and a tile with a white cut-out. */
const INK = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16z"/></svg>').toString('base64')}`
const TILE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/><path fill="#fff" d="M4 4h8v8z"/></svg>').toString('base64')}`

const agent = (id: string, name: string, patch: Partial<RegistryAgentView> = {}): RegistryAgentView => ({
  id,
  name,
  version: '1.0.0',
  description: '',
  authors: [],
  license: 'MIT',
  distribution: 'npx',
  checksum: 'none',
  ...patch
})

let root: Root
let host: HTMLElement
let search: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  search = vi.fn()
  ;(window as unknown as { mousse: unknown }).mousse = { providers: { registry: { search } } }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
  useProviderSnapshotsStore.setState({ scopes: {} })
  resetRegisteredIcons()
})

/** The Add dialog's agent list, and (when given) an added entry's logo elsewhere in the app. */
function mount(entryId?: string) {
  const list = createElement(RegistryAgentList, { query: '', onQuery: () => undefined, selectedId: null, disabled: false, onSelect: () => undefined })
  const entry = entryId ? createElement('span', { id: 'entry' }, createElement(ProviderIcon, { providerId: entryId, size: 16 })) : null
  act(() => root.render(createElement(Fragment, null, list, entry)))
}

const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })
const row = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((item) => item.querySelector('.prov-choice-label')?.textContent === name)
/** The logo an element draws: a brand Mousse ships, `agent:<registry id>` for a registry icon, or `generic`. */
const logoOf = (element: Element | null | undefined) => element?.querySelector('[data-provider-icon]')?.getAttribute('data-provider-icon') ?? null

describe('ACP agents in Add provider', () => {
  it("shows each agent's own logo: Mousse's for a known brand, else the registry icon, else the generic mark", async () => {
    search.mockResolvedValue([
      agent('gemini', 'Gemini CLI'),
      agent('goose', 'Goose', { iconDataUrl: INK, iconMonochrome: true }),
      agent('tile-agent', 'Tile', { iconDataUrl: TILE, iconMonochrome: false }),
      agent('plain', 'Plain')
    ])
    mount()
    await wait(300)
    expect(['Gemini CLI', 'Goose', 'Tile', 'Plain'].map((name) => logoOf(row(name)))).toEqual(['google', 'agent:goose', 'agent:tile-agent', 'generic'])
    // One ink follows the text colour (a mask); a tile with a cut-out stays an image of itself.
    expect(row('Goose')!.querySelector('[data-provider-icon]')!.getAttribute('data-provider-mark')).toBe('mono')
    const tile = row('Tile')!.querySelector('[data-provider-icon]')!
    expect(tile.tagName).toBe('IMG')
    expect(tile.getAttribute('src')).toBe(TILE)
    // Nothing is loaded from the registry: no image comes from the network.
    for (const image of document.querySelectorAll('img')) expect(image.getAttribute('src')).toMatch(/^data:/)
  })

  it('lists the agents before their icons arrive, then draws each icon in the list and on an added entry', async () => {
    // An entry added from the registry whose snapshot does not carry the icon yet.
    applySnapshotsEvent({
      scope: DEVICE_SCOPE,
      snapshots: [snapshot({ instanceId: 'acp:work', driver: 'acp', displayName: 'Work', builtIn: false, config: { home: 'default', args: [], env: {}, source: { kind: 'registry', agentId: 'goose', version: '1.0.0', distribution: 'npx' } } })]
    })
    search
      .mockResolvedValueOnce([agent('goose', 'Goose', { iconPending: true })])
      .mockResolvedValue([agent('goose', 'Goose', { iconDataUrl: INK, iconMonochrome: true })])
    mount('acp:work')
    await wait(300)
    expect(row('Goose')).toBeDefined()
    expect([logoOf(row('Goose')), logoOf(document.getElementById('entry'))]).toEqual(['generic', 'generic'])
    // The list asks again while an icon is on its way, and stops once none is.
    await wait(1_000)
    expect([logoOf(row('Goose')), logoOf(document.getElementById('entry'))]).toEqual(['agent:goose', 'agent:goose'])
    await wait(20_000)
    expect(search).toHaveBeenCalledTimes(2)
  })
})
