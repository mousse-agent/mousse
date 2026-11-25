// @vitest-environment jsdom
/**
 * The model picker's provider rail with ACP agents: each agent shows its own logo (not the generic
 * mark), and only a second entry of the same agent gets a badge; two different agents never do.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerFooter, type ComposerFooterProps, type ComposerRunProps } from '../../src/renderer/components/ComposerFooter'
import { resetRegisteredIcons } from '../../src/renderer/lib/providerIcons'
import { applySnapshotsEvent, DEVICE_SCOPE, useProviderSnapshotsStore, type ProviderWithStatus } from '../../src/renderer/lib/providerSnapshots'
import type { InstanceSnapshot } from '../../src/shared/harness/status'
import { snapshot } from '../providerSnapshotFixture'

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
  useProviderSnapshotsStore.setState({ scopes: {} })
  resetRegisteredIcons()
})

const INK = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h16v16z"/></svg>').toString('base64')}`
const TILE = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/><path fill="#fff" d="M4 4h8v8z"/></svg>').toString('base64')}`

function acpEntry(instanceId: string, displayName: string, agentId: string, icon?: Pick<InstanceSnapshot, 'iconDataUrl' | 'iconMonochrome'>): InstanceSnapshot {
  return snapshot({
    instanceId,
    driver: 'acp',
    displayName,
    builtIn: false,
    config: { home: 'default', args: [], env: {}, source: { kind: 'registry', agentId, version: '1.0.0', distribution: 'binary' } },
    ...icon
  })
}

function listing(instanceId: string, label: string): ProviderWithStatus {
  return {
    id: instanceId,
    instanceId,
    label,
    models: [{ id: `${instanceId}-model`, label: `${label} model` }],
    caps: { toolControl: 'exact', autoPermissionMode: false, contextUsage: 'none' } as ProviderWithStatus['caps']
  }
}

function openPicker(providers: ProviderWithStatus[]) {
  const props: ComposerFooterProps = {
    run: {
      providers,
      selectedProviderId: providers[0]!.id,
      selectedInstanceId: providers[0]!.instanceId,
      selectedModelId: providers[0]!.models[0]!.id,
      modelMenuOpen: true,
      onModelMenuOpenChange: vi.fn(),
      onModelSelect: vi.fn(),
      modelReadOnly: false,
      onOpenSettings: vi.fn(),
      contextUsage: { used: 0, limit: 0, percent: 0 } as unknown as ComposerRunProps['contextUsage'],
      contextOpen: false,
      onContextOpenChange: vi.fn()
    } as ComposerRunProps,
    onAttachClick: vi.fn()
  }
  act(() => root.render(createElement(ComposerFooter, props)))
}

const tab = (name: string) => document.querySelector<HTMLElement>(`.model-picker-rail [role="tab"][aria-label="${name}"]`)!
const badge = (name: string) => tab(name).querySelector('.model-picker-instance-badge')?.textContent ?? null
/** The logo a tab draws: a brand, `agent:<registry id>` for a registry icon, or `generic`. */
const logo = (name: string) => tab(name).querySelector('[data-provider-icon]')?.getAttribute('data-provider-icon') ?? null

describe('ACP agents on the model picker rail', () => {
  it('shows each agent its own logo, and badges only a second entry of the same agent', () => {
    openPicker([listing('acp:opencode', 'OpenCode'), listing('acp:goose', 'Goose'), listing('acp:work', 'Goose Work'), listing('acp:tile', 'Tile')])
    // The entries' snapshots arrive after the menu opened: until then every agent but OpenCode
    // looked the same (generic), and the badges follow the logos once they are known.
    act(() => applySnapshotsEvent({
      scope: DEVICE_SCOPE,
      snapshots: [
        acpEntry('acp:opencode', 'OpenCode', 'opencode'),
        acpEntry('acp:goose', 'Goose', 'goose', { iconDataUrl: INK, iconMonochrome: true }),
        acpEntry('acp:work', 'Goose Work', 'goose', { iconDataUrl: INK, iconMonochrome: true }),
        acpEntry('acp:tile', 'Tile', 'tile-agent', { iconDataUrl: TILE, iconMonochrome: false })
      ]
    }))
    expect([logo('OpenCode'), logo('Goose'), logo('Goose Work'), logo('Tile')]).toEqual(['opencode', 'agent:goose', 'agent:goose', 'agent:tile-agent'])
    expect([badge('OpenCode'), badge('Goose'), badge('Goose Work'), badge('Tile')]).toEqual([null, null, 'W', null])
  })
})
