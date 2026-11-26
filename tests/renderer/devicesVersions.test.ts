// @vitest-environment jsdom
/**
 * Settings → Devices says which computers run another Mousse than this one: "Behind" or "Newer" on the row, the
 * versions and whether it updates itself in the tooltip, and under a computer that is behind how it gets updated:
 * from here when this computer installed it over SSH or its app takes update requests, otherwise "Update on <name>". The daemon is stubbed at
 * `platformRequest`; rows of both networkings are read from `bridge.nodes`, as the section reads them.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')
const { useUpdateStore } = await import('../../src/renderer/stores/updateStore')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { NO_COMPUTERS, useComputersStore } = await import('../../src/renderer/lib/computers')

const policy = { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, bots: true, agentReach: 'launched', work: true }
const row = (node: string, name: string, extra: Record<string, unknown>) => ({
  node,
  name,
  caps: ['read', 'chat', 'write', 'settings'],
  keyEpoch: 1,
  expiresAt: Date.now() + 86_400_000,
  kind: 'computer',
  self: false,
  revoked: false,
  state: 'open',
  connection: 'connected',
  routeHeld: true,
  policy,
  ...extra
})
const unsigned = { channel: 'stable', self: false, reason: 'Updates on macOS need a signed build.' }

let answers: Record<string, unknown> = {}
const request = vi.fn(async (method: string, params?: unknown) => {
  if (method in answers) {
    const answer = answers[method]
    return typeof answer === 'function' ? answer(params) : answer
  }
  switch (method) {
    case 'netEngine.status': return { enabled: false, on: false, helper: { state: 'off' }, devices: [], approvals: [] }
    case 'net.status':
      return { enabled: true, keystore: 'unlocked', protected: true, routes: [], peers: [], self: { node: 'node_a', user: 'user_a', isAuthority: true } }
    case 'net.transport.list': return { manifests: [], records: {}, settings: {} }
    case 'net.ssh.list': return { records: [] }
    case 'bridge.activity': return { entries: [], rules: [], counts: [], uncertain: 0, refused: 0, reads: { calls: 0, bytes: 0, hours: [] } }
    default: return {}
  }
})

let root: Root
let host: HTMLElement
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  request.mockClear()
  answers = {}
  useUpdateStore.setState({ currentVersion: '0.9.2' })
  // Settings shows only once the window's profile is bound; before that nothing reads the computers.
  useAppStore.setState({ profileReady: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    app: { getInfo: async () => ({ deviceName: 'Studio Mac' }) },
    editorAsks: { list: async () => [], onChanged: () => () => undefined }
  }
})
afterEach(() => {
  act(() => root.unmount())
  // Each case starts with no computers listed, as a fresh window does.
  useComputersStore.setState(NO_COMPUTERS)
  document.body.innerHTML = ''
  vi.useRealTimers()
})

const flush = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const mount = async () => {
  await act(async () => root.render(createElement(EngineDevicesSection)))
  await flush()
}
/** A device's first row (Computers I use comes first), its text with spaces collapsed. */
const rowText = (node: string) => (host.querySelector(`[data-device-node="${node}"]`)?.textContent ?? '').replace(/\s+/g, ' ')
const titled = (text: string) => [...host.querySelectorAll<HTMLElement>('[title]')].find((item) => item.textContent?.trim() === text)
const button = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === name)

describe('Settings → Devices, versions', () => {
  it('tags the old networking’s computers Behind or Newer, with their versions and whether they update themselves as the tooltip', async () => {
    answers['bridge.nodes'] = {
      nodes: [
        row('node_a', 'Studio Mac', { self: true, version: '0.9.2' }),
        row('node_b', 'Laptop', { version: '0.9.0', update: unsigned, olderThanThis: true, newerThanThis: false }),
        row('node_c', 'Desk PC', { version: '0.9.3', update: { channel: 'nightly', self: true }, olderThanThis: false, newerThanThis: true }),
        row('node_d', 'Mini', { version: '0.9.2', olderThanThis: false, newerThanThis: false }),
        // An older build that reported no version is never called behind.
        row('node_e', 'Old box', { olderThanThis: false })
      ]
    }
    await mount()
    expect(rowText('node_b')).toMatch(/· Behind/)
    expect(titled('Behind')?.title).toBe(
      "Laptop runs 0.9.0 (stable), this computer 0.9.2. It can't update itself: Updates on macOS need a signed build."
    )
    expect(rowText('node_c')).toMatch(/· Newer/)
    expect(titled('Newer')?.title).toBe('Desk PC runs 0.9.3 (nightly), this computer 0.9.2. It updates itself.')
    for (const node of ['node_d', 'node_e']) expect(rowText(node)).not.toMatch(/Behind|Newer/)
    // Only the computer behind gets a way to update it; this computer didn't install it, so it's updated there.
    expect(host.textContent).toContain('Update on Laptop')
    expect(host.textContent).not.toContain('Update on Desk PC')
    expect(host.textContent).not.toContain('Update on Mini')
  })

  it('updates a computer this one installed over SSH from here, through its update dialog', async () => {
    answers['bridge.nodes'] = {
      nodes: [row('node_b', 'Laptop', { version: '0.9.0', update: unsigned, olderThanThis: true })]
    }
    answers['net.ssh.list'] = {
      records: [{ id: 'ssh1', endpoint: 'laptop.local', node: 'node_b', phase: 'done', owner: 'managed', version: '0.9.0', recoverable: false, createdAt: 1, updatedAt: 1 }]
    }
    answers['net.ssh.update'] = { ok: true, version: '0.9.2' }
    await mount()
    expect(host.textContent).toContain('Update Laptop from here')
    expect(host.textContent).not.toContain('Update on Laptop')
    await act(async () => button('Update…')!.click())
    await flush()
    await act(async () => button('Update')!.click())
    await flush()
    expect(request.mock.calls.filter(([method]) => method === 'net.ssh.update').map(([, params]) => params)).toEqual([{ id: 'ssh1' }])
    expect(document.body.textContent).toContain('Laptop now runs Mousse 0.9.2.')
  })

  it('tags a computer paired through the new networking, and says to update it there', async () => {
    answers['netEngine.status'] = {
      enabled: true,
      on: true,
      helper: { state: 'running' },
      approvals: [],
      devices: [{ node: 'n1', name: 'Studio', shortId: 'a1b2c3d4', state: 'connected', online: true }]
    }
    answers['net.status'] = { enabled: false }
    answers['bridge.nodes'] = {
      nodes: [row('n1', 'Studio', { source: 'engine', version: '0.9.0', update: unsigned, olderThanThis: true, newerThanThis: false })]
    }
    await mount()
    expect(rowText('n1')).toMatch(/Connected.*· Behind/)
    expect(titled('Update on Studio')?.title).toContain("Studio runs 0.9.0 (stable), this computer 0.9.2. It can't update itself")
  })
  it('updates a computer whose app takes requests from here: its running turns, Install with that count, and Close cancels', async () => {
    const taking = { channel: 'stable', self: true, requests: true }
    answers['bridge.nodes'] = {
      nodes: [
        row('node_b', 'Laptop', { version: '0.9.0', update: taking, olderThanThis: true }),
        // Updates itself, but its app has not said it takes requests: updated there, and asked once whether it does now.
        row('node_c', 'Desk PC', { version: '0.9.0', update: { channel: 'stable', self: true }, olderThanThis: true })
      ]
    }
    const asks: Array<Record<string, unknown>> = []
    answers['net.update.there'] = (params: Record<string, unknown>) => {
      asks.push(params)
      if (params.step === 'prepare') return { job: 'j1', phase: 'preparing', runningTurns: 2 }
      if (params.step === 'status') return { job: 'j1', phase: 'ready', runningTurns: 2 }
      if (params.step === 'install') return { job: 'j1', phase: 'countdown', runningTurns: 2, installAt: Date.now() + 10_000 }
      return {}
    }
    await mount()
    expect(asks).toEqual([{ node: 'node_c', step: 'refresh' }])
    expect(host.textContent).toContain('Update Laptop from here')
    expect(host.textContent).toContain('Update on Desk PC')
    expect(host.textContent).not.toMatch(/Update all/i)

    await act(async () => button('Update')!.click())
    await flush()
    expect(asks.at(-1)).toEqual({ node: 'node_b', step: 'prepare', version: '0.9.2' })
    expect(document.body.textContent).toContain('Update Laptop to 0.9.2?')
    await act(async () => vi.advanceTimersByTime(1_000))
    await flush()
    expect(document.body.textContent).toContain('2 running turns on Laptop will stop.')
    expect(document.body.textContent).toContain('Other Mousse homes sharing its install stop too.')
    await act(async () => button('Install')!.click())
    await flush()
    expect(asks.at(-1)).toEqual({ node: 'node_b', step: 'install', job: 'j1', runningTurns: 2 })
    expect(document.body.textContent).toContain('Updating Laptop in a few seconds.')
  })

  it('cancels the request there when the dialog closes before Install', async () => {
    answers['bridge.nodes'] = {
      nodes: [row('node_b', 'Laptop', { version: '0.9.0', update: { channel: 'stable', self: true, requests: true }, olderThanThis: true })]
    }
    const asks: Array<Record<string, unknown>> = []
    answers['net.update.there'] = (params: Record<string, unknown>) => {
      asks.push(params)
      return { job: 'j1', phase: params.step === 'prepare' ? 'preparing' : 'ready', runningTurns: 0 }
    }
    await mount()
    await act(async () => button('Update')!.click())
    await flush()
    await act(async () => vi.advanceTimersByTime(1_000))
    await flush()
    expect(document.body.textContent).toContain('No turns are running on Laptop.')
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click())
    await flush()
    expect(asks.at(-1)).toEqual({ node: 'node_b', step: 'cancel', job: 'j1' })
    expect(document.body.textContent).not.toContain('Update Laptop to 0.9.2?')
  })
})
