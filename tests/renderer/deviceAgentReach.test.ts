// @vitest-environment jsdom
/**
 * Issue #1160, agent reach: on the computer that runs the threads, Settings → Devices → a computer's Limits sets which
 * threads that computer's agents may change here, and the device's activity list says which actions its agents made.
 * The page is mounted as a person uses it, with only the daemon stubbed; the daemon's side of `bridge.policy` is
 * covered in `tests/net/bridge/routed/agentMark.test.ts`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BridgeNodePolicy } from '../../src/shared/net/local'
import type { DeviceActivity } from '../../src/shared/bridge/deviceActivity'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')

let root: Root
let host: HTMLElement
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('nothing to click')
  await act(async () => { (element as HTMLElement).click() })
  await flush()
}
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label)
const reachSelect = () => document.querySelector<HTMLSelectElement>('[role="dialog"] select[data-field="agent-reach"]')
const choose = async (select: HTMLSelectElement, value: string) => {
  await act(async () => {
    select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const NOW = Date.now()
let policy: BridgeNodePolicy
const activity = (): DeviceActivity => ({
  node: 'nod_mac' as DeviceActivity['node'],
  since: NOW - 7 * 86_400_000,
  counts: [{ method: 'orchestrator.send', count: 1 }],
  uncertain: 0,
  refused: 1,
  entries: [
    { at: NOW - 60_000, method: 'orchestrator.send', kind: 'refused', outcome: 'agent_reach', actor: 'agent', thread: { id: 't-1', name: 'Release notes' } },
    { at: NOW - 120_000, method: 'orchestrator.send', kind: 'change', outcome: 'ok', thread: { id: 't-2', name: 'Fix the build' } }
  ],
  reads: { calls: 0, bytes: 0, hours: [] },
  rules: []
})
const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
  switch (method) {
    case 'netEngine.status': return { enabled: false, on: false, helper: { state: 'off' }, devices: [], approvals: [] }
    case 'net.status': return { enabled: true, keystore: 'unlocked', protected: true, self: { node: 'nod_self', isAuthority: true }, transports: [], peers: [], routes: [], workOnThreads: true }
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.nodes': return {
      nodes: [
        { node: 'nod_self', name: 'Desk', caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: true, revoked: false, state: 'open' },
        { node: 'nod_mac', name: 'Mac', caps: ['read', 'chat', 'write', 'settings'], keyEpoch: 1, expiresAt: 0, kind: 'computer', self: false, revoked: false, state: 'open', policy }
      ]
    }
    case 'bridge.activity': return activity()
    case 'bridge.policy': {
      const { node: _node, ...change } = params!
      policy = { ...policy, ...change }
      return { policy }
    }
    default: return {}
  }
})

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  request.mockClear()
  policy = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: 'use', agentReach: 'launched' }
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    app: { getInfo: async () => ({ deviceName: 'Desk' }) },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

/** Chooses a device in the list; its detail, with its Access, shows beside the list. */
const openAccess = async (name: string) => {
  await act(async () => document.querySelector<HTMLElement>(`[data-device-node] button[aria-label="${name}"]`)!.click())
  for (let i = 0; i < 5; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

/** Mounts the page and opens Mac's Access, where its Limits and activity are. */
const showDevices = async () => {
  await act(async () => root.render(createElement(EngineDevicesSection)))
  await flush()
  await openAccess('Mac')
}
const policyCalls = () => request.mock.calls.filter(([method]) => method === 'bridge.policy')

describe('Settings → Devices → Limits: what a device\'s agents may change here', () => {
  it('reads the saved choice and saves each one alone, which the dialog then reads back', async () => {
    await showDevices()
    await click(button('Limits…'))
    const label = reachSelect()!.closest('label')!
    expect(label.textContent).toContain('Agents on Mac may change')
    expect([...reachSelect()!.options].map((option) => [option.value, option.textContent])).toEqual([
      ['none', 'Nothing'], ['launched', 'Threads they started'], ['all', 'All threads']
    ])
    expect(reachSelect()!.value).toBe('launched')
    // Nothing changed yet: nothing to save.
    expect(button('Save')!.disabled).toBe(true)

    for (const value of ['none', 'all', 'launched'] as const) {
      const before = policyCalls().length
      await choose(reachSelect()!, value)
      await click(button('Save'))
      expect(policyCalls().slice(before)).toEqual([['bridge.policy', { node: 'nod_mac', agentReach: value }]])
      // The dialog closed; opened again, it shows what the daemon now has.
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      await click(button('Limits…'))
      expect(reachSelect()!.value).toBe(value)
    }
  })

  it('says it covers what that device\'s agents do here, that it is no barrier, and what to use instead', async () => {
    await showDevices()
    await click(button('Limits…'))
    const words = document.querySelector('[role="dialog"]')!.textContent!
    expect(words).toContain('Mac’s agents may start, message, steer and stop on this computer')
    expect(words).toContain('They read threads here as Mac does')
    expect(words).toContain('not a barrier: for one you do not trust, block it or lower its highest permission mode')
  })

  it('a computer whose service predates the setting shows no choice, and saving another limit never sends one', async () => {
    const { agentReach: _gone, ...older } = policy
    policy = older
    await showDevices()
    await click(button('Limits…'))
    expect(reachSelect()).toBeNull()
    await click(document.querySelector<HTMLElement>('[role="dialog"] [role="switch"][aria-label="Terminals from Mac"]'))
    await click(button('Save'))
    expect(policyCalls()).toEqual([['bridge.policy', { node: 'nod_mac', terminal: true }]])
  })

  it('marks the actions its agents made in the device\'s activity, and only those', async () => {
    await showDevices()
    await click(button('Show details'))
    const rows = [...host.querySelectorAll('.devices-activity-list li')].map((row) => row.textContent ?? '')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('by an agent')
    expect(rows[0]).toContain('refused: outside what its agents may change here')
    expect(rows[1]).not.toContain('agent')
  })
})
