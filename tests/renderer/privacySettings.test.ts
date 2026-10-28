// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceSnapshot, InstanceTelemetry } from '../../src/shared/harness/status'
import { EnvRow, ENFORCED_NOTE } from '../../src/renderer/components/providers/CliSections'
import { PRIVACY_STATEMENT, PrivacySettingsGroup } from '../../src/renderer/components/settings/PrivacySettingsGroup'
import { MousseConfigStore } from '../../src/mms/config/MousseConfigStore'
import { asSettingsPartial } from '../../src/mms/protocol/validators'
import { SettingsStore } from '../../src/mms/settings/SettingsStore'
import { SETTINGS_CLASSIFICATION } from '../../src/shared/profiles/settingsClassification'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root
let host: HTMLElement
let home: string
let store: SettingsStore

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  home = mkdtempSync(join(tmpdir(), 'mousse-privacy-settings-'))
  store = new SettingsStore(MousseConfigStore.load(home))
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  rmSync(home, { recursive: true, force: true })
  delete (window as { mousse?: unknown }).mousse
})

function snapshot(instanceId: string, displayName: string, telemetry: InstanceTelemetry, env: Record<string, string> = {}): InstanceSnapshot {
  return {
    instanceId,
    driver: 'claude',
    displayName,
    builtIn: instanceId === 'claude',
    scope: { kind: 'device' },
    enabled: { device: true, effective: true, setBy: 'device' },
    install: { state: 'installed', canInstall: false },
    runs: { state: 'yes' },
    auth: { state: 'signed_in' },
    compatibility: { state: 'tested' },
    caps: {} as InstanceSnapshot['caps'],
    config: { home: instanceId === 'claude' ? 'default' : 'private', args: [], env },
    models: { entries: [], source: 'none' },
    stale: false,
    telemetry
  }
}

const docsUrl = 'https://code.claude.com/docs/en/data-usage'
const own = snapshot('claude', 'Claude Code', { state: 'own_settings', agent: 'Claude Code', docsUrl })
const work = snapshot('claude:work', 'Work', { state: 'off', agent: 'Claude Code', variables: ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'], docsUrl }, { DISABLE_TELEMETRY: '0', KEEP: 'yes' })
const grok = { ...snapshot('grok', 'Grok', { state: 'no_switch', agent: 'Grok' }), driver: 'grok' as const }

const click = (target: Element) => act(() => { (target as HTMLElement).click() })
const flush = () => act(async () => { await Promise.resolve() })

describe('Settings > General > Privacy', () => {
  it('states that Mousse collects nothing, lists what it contacts, and each provider\'s agent telemetry', async () => {
    ;(window as { mousse?: unknown }).mousse = { providers: { snapshots: async () => [own, work, grok] } }
    act(() => root.render(createElement(PrivacySettingsGroup, { privacy: store.get().privacy, onUpdate: async () => {} })))
    await flush()
    const text = host.textContent ?? ''
    expect(text).toContain(PRIVACY_STATEMENT)
    expect(text).toContain('Mousse updates (GitHub)')
    expect(text).toContain('Agent telemetry for agents Mousse sets up')
    expect(text).toContain('Uses your own Claude Code settings.')
    expect(text).toContain('Off: Mousse sets DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING.')
    expect(text).toContain('No documented switch: Grok runs as it does by default.')
    // The vendor's page, for the agent on the user's own setup.
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    const links = [...host.querySelectorAll('button.privacy-link')]
    expect(links).toHaveLength(1)
    click(links[0]!)
    expect(open).toHaveBeenCalledWith(docsUrl, '_blank', 'noopener,noreferrer')
  })

  it('defaults to off, and saves Agent default for this profile', async () => {
    expect(store.get().privacy).toEqual({ agentTelemetry: 'off' })
    const updates = vi.fn()
    const draw = () => act(() => root.render(createElement(PrivacySettingsGroup, {
      privacy: store.get().privacy,
      onUpdate: async (partial) => {
        updates(partial)
        store.set(asSettingsPartial(partial) as typeof partial)
        draw()
      }
    })))
    draw()
    click(host.querySelector('[aria-label="Agent telemetry for agents Mousse sets up"]')!)
    click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Agent default')!)
    expect(updates).toHaveBeenCalledWith({ privacy: { agentTelemetry: 'agent_default' } })
    expect(new SettingsStore(MousseConfigStore.load(home)).get().privacy).toEqual({ agentTelemetry: 'agent_default' })
    expect(SETTINGS_CLASSIFICATION.find((entry) => entry.path === 'settings.privacy')).toMatchObject({ scope: 'profile' })
    // The daemon refuses anything else.
    for (const bad of [{ agentTelemetry: 'on' }, { other: true }, 'off']) expect(() => asSettingsPartial({ privacy: bad }), JSON.stringify(bad)).toThrow(/privacy/)
  })
})

describe('the provider editor\'s variables', () => {
  it('marks a launch variable the switch sets over, and only while it is off', () => {
    act(() => root.render(createElement(EnvRow, { snapshot: work, onSave: async () => {} })))
    const rows = [...host.querySelectorAll('.prov-env-row')]
    expect(rows.map((row) => row.querySelector('.prov-env-note')?.textContent ?? null)).toEqual([ENFORCED_NOTE, null])
    expect(ENFORCED_NOTE).toBe('Ignored: Privacy → Agent telemetry is off.')

    act(() => root.render(createElement(EnvRow, { snapshot: { ...work, telemetry: { state: 'agent_default', agent: 'Claude Code' } }, onSave: async () => {} })))
    expect(host.querySelector('.prov-env-note')).toBeNull()
  })
})
