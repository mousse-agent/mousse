// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { InstanceSnapshot, InstanceTelemetry } from '../../src/shared/harness/status'
import { EnvRow, ENFORCED_NOTE, TelemetryRow } from '../../src/renderer/components/providers/CliSections'
import { PRIVACY_STATEMENT, PrivacySettingsGroup } from '../../src/renderer/components/settings/PrivacySettingsGroup'

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
})

function snapshot(telemetry: InstanceTelemetry, env: Record<string, string> = {}): InstanceSnapshot {
  return {
    instanceId: 'claude:work',
    driver: 'claude',
    displayName: 'Work',
    builtIn: false,
    scope: { kind: 'device' },
    enabled: { device: true, effective: true, setBy: 'device' },
    install: { state: 'installed', canInstall: false },
    runs: { state: 'yes' },
    auth: { state: 'signed_in' },
    compatibility: { state: 'tested' },
    caps: {} as InstanceSnapshot['caps'],
    config: { home: 'private', args: [], env },
    models: { entries: [], source: 'none' },
    stale: false,
    telemetry
  }
}

const off: InstanceTelemetry = { setting: 'off', defaultSetting: 'off', variables: ['DISABLE_TELEMETRY', 'DISABLE_ERROR_REPORTING'] }
const click = (target: Element) => act(() => { (target as HTMLElement).click() })

describe('Settings > General > Privacy', () => {
  it('states that Mousse collects nothing, lists what it contacts, and says where agent telemetry is set', () => {
    act(() => root.render(createElement(PrivacySettingsGroup)))
    const text = host.textContent ?? ''
    expect(text).toContain(PRIVACY_STATEMENT)
    expect(text).toContain('Mousse updates (GitHub)')
    expect(text).toContain('Set for each provider in Settings → Providers.')
  })
})

describe('a provider\'s Telemetry row', () => {
  it('offers the agent\'s own setting and Off, and saves the choice', async () => {
    const saved = vi.fn(async () => {})
    act(() => root.render(createElement(TelemetryRow, { snapshot: snapshot({ ...off, setting: 'agent_setting', defaultSetting: 'agent_setting' }), onSave: saved })))
    const trigger = host.querySelector<HTMLElement>('[aria-label="Telemetry"]')!
    expect(trigger.textContent).toContain("Agent's own setting")
    // The tooltip says what Off sets, and that the agent's files stay as they are.
    expect(trigger.closest('[title]')?.getAttribute('title')).toBe("Off starts the agent with DISABLE_TELEMETRY, DISABLE_ERROR_REPORTING. Mousse never changes the agent's own files.")
    click(trigger)
    click([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((option) => option.textContent === 'Off')!)
    await act(async () => { await Promise.resolve() })
    expect(saved).toHaveBeenCalledWith('off')
  })

  it('shows a small chip, with its reason in the tooltip, for an agent without a switch', () => {
    act(() => root.render(createElement(TelemetryRow, { snapshot: snapshot({ setting: 'none' }), onSave: async () => {} })))
    const chip = host.querySelector('.prov-model-chip')!
    expect(chip.textContent).toBe('No switch')
    expect(chip.getAttribute('title')).toContain('Mousse sets nothing')
    expect(host.querySelector('[aria-label="Telemetry"]')).toBeNull()
  })
})

describe('the provider editor\'s variables', () => {
  it('marks a launch variable the switch sets over, and only while it is Off', () => {
    act(() => root.render(createElement(EnvRow, { snapshot: snapshot(off, { DISABLE_TELEMETRY: '0', KEEP: 'yes' }), onSave: async () => {} })))
    const rows = [...host.querySelectorAll('.prov-env-row')]
    expect(rows.map((row) => row.querySelector('.prov-env-note')?.textContent ?? null)).toEqual([ENFORCED_NOTE, null])

    act(() => root.render(createElement(EnvRow, { snapshot: snapshot({ ...off, setting: 'agent_setting' }, { DISABLE_TELEMETRY: '0' }), onSave: async () => {} })))
    expect(host.querySelector('.prov-env-note')).toBeNull()
  })
})
