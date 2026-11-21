// @vitest-environment jsdom
/**
 * A pairing whose other direction does not come up says what to do for the route it uses, and the inviting
 * window stops waiting at the row's stuck bound, with Retry.
 */
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import type { NetEngineDevice } from '../../src/shared/netEngine/local'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { engineRow } = await import('../../src/renderer/components/netEngine/engineRows')
const { JoinedLine } = await import('../../src/renderer/components/netEngine/SendLinkParts')

const stuck = (fields: Partial<NetEngineDevice>): NetEngineDevice => ({
  node: 'n1',
  name: 'Studio',
  shortId: 'a1b2c3d4',
  state: 'finishing',
  online: true,
  stuck: true,
  ...fields
})

const LAN = "Studio can't reach this computer. Let Mousse through this computer's firewall, then Retry."
const TAILNET = 'Keep Tailscale on and online on both computers, then Retry.'
const SHARED = 'Check the address this computer shares, then Retry.'

describe('what a stuck pairing says, by route', () => {
  it.each([
    ['LAN', { route: 'lan' as const }, LAN],
    ['no route up, found on the LAN', { online: false }, LAN],
    ['tailnet', { route: 'tailnet' as const }, TAILNET],
    ['a port forward', { route: 'public' as const }, SHARED],
    ['a relay', { route: 'relay' as const }, SHARED],
    ['a tunnel address added by hand', { online: false, addresses: ['wss://t.example.com/mousse-net/1'] }, SHARED]
  ])('%s', (_what, fields, detail) => {
    expect(engineRow(stuck(fields)).detail).toBe(detail)
  })

  it('the inviting window shows why and Retry once the row is stuck', async () => {
    const request = vi.fn(async () => undefined)
    ;(window as unknown as { mousse: unknown }).mousse = { platformRequest: { request } }
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => root.render(createElement(JoinedLine, { device: stuck({ route: 'tailnet' }) })))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(TAILNET)
    await act(async () => host.querySelector('button')!.click())
    expect(request).toHaveBeenCalledWith('netEngine.retry', { node: 'n1' })
    await act(async () => root.render(createElement(JoinedLine, { device: stuck({ stuck: false }) })))
    expect(host.textContent).toBe('Studio can use this computer; finishing the other direction…')
    root.unmount()
  })
})
