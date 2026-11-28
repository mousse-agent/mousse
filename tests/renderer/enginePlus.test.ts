// @vitest-environment jsdom
/**
 * Settings → Devices with Mousse Plus (Phase 4, M16 and M17): sign-in with the code typed on the Plus website,
 * the plan and what is left, the paid relay per class with copies paused by a line and never a prompt, the
 * top-up and outage lines, and "Remove on all my hosts" with each host's state (design D.1, D.3). The daemon is
 * stubbed at `platformRequest`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NetEngineDevice,
  NetEnginePlus,
  NetEngineRemoval,
  NetEngineStatus
} from '../../src/shared/netEngine/local'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')
const { removalText } = await import('../../src/renderer/components/netEngine/plusRows')

const phone: NetEngineDevice = { node: 'n1', name: 'Phone', shortId: 'a1b2c3d4', state: 'connected', online: true }
const LINKED: NetEnginePlus = {
  configured: true,
  linked: true,
  plan: 'active',
  bulk: { allowance: 50 * 1024 ** 3, available: 20 * 1024 ** 3 },
  interactive: { allowance: 1024 ** 3, available: 512 * 1024 ** 2 }
}

function daemon(initial: Partial<NetEngineStatus> = {}) {
  const state: { status: NetEngineStatus } = {
    status: {
      enabled: true,
      on: true,
      helper: { state: 'running' },
      identity: 'me',
      devices: [phone],
      approvals: [],
      ...initial
    }
  }
  const calls: Array<[string, any]> = []
  const changed = new Set<(change: { profileId?: string }) => void>()
  const request = vi.fn(async (method: string, params: any) => {
    calls.push([method, params])
    switch (method) {
      case 'netEngine.plus.signIn':
        return { userCode: 'WXYZ-1234', verifyUrl: 'https://plus.test/link', expiresAt: 0 }
      case 'netEngine.removeEverywhere.plan':
        return {
          hosts: [
            { host: 'h1', name: 'Studio', grant: 4 },
            { host: 'h2', name: 'Office', grant: 7 },
            { host: 'h3', name: 'Laptop', grant: null }
          ]
        }
      case 'bridge.nodes':
        return { nodes: [] }
      case 'net.status':
        return { enabled: false }
      default:
        return state.status
    }
  })
  const openLoginUrl = vi.fn(async () => ({ ok: true }))
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    providers: { openLoginUrl },
    netEngine: {
      onChanged: (cb: (change: { profileId?: string }) => void) => {
        changed.add(cb)
        return () => changed.delete(cb)
      }
    }
  }
  return {
    openLoginUrl,
    called: (method: string) => calls.filter(([name]) => name === method).map(([, params]) => params),
    change: async (next: Partial<NetEngineStatus>) => {
      state.status = { ...state.status, ...next }
      await act(async () => {
        for (const cb of changed) cb({})
      })
      await flush()
    }
  }
}

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
})

const flush = async () => {
  for (let i = 0; i < 6; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
}
const mount = async () => {
  await act(async () => root.render(createElement(EngineDevicesSection)))
  await flush()
}
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name
  )
const click = async (target: HTMLElement | null | undefined) => {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  await flush()
}
/** The chosen device's menu, where Remove on all my hosts sits. */
const canUseActions = (name: string) => document.querySelector<HTMLButtonElement>(`[aria-label="Actions for ${name}"]`)
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === label)
const text = () => (document.body.textContent ?? '').replace(/\s+/g, ' ')
/** The removed device's row title, and whether it reads as a warning. */
const removalTitle = () => {
  const title = host.querySelector('[data-removal="x1"] .settings-item-title')
  const span = title?.querySelector('span') ?? title
  return { line: span?.textContent?.trim(), warn: !!span?.classList.contains('settings-status-warn') }
}
const statusLines = () => [...document.querySelectorAll('[role="status"]')].map((item) => item.textContent?.trim())

describe('Mousse Plus in Settings → Devices', () => {
  it('shows nothing for Plus in a build without a Plus address', async () => {
    daemon({ plus: { configured: false, linked: false } })
    await mount()
    expect(button('Sign in')).toBeUndefined()
    expect(text()).not.toContain('Mousse Plus')
  })

  it('signs in with a code typed on the Plus website, and can stop', async () => {
    const d = daemon({ plus: { configured: true, linked: false } })
    await mount()
    await click(button('Sign in'))
    expect(d.called('netEngine.plus.signIn')).toHaveLength(1)
    expect(d.openLoginUrl).toHaveBeenCalledWith('https://plus.test/link')
    await d.change({
      plus: { configured: true, linked: false, link: { userCode: 'WXYZ-1234', verifyUrl: 'https://plus.test/link', expiresAt: 0 } }
    })
    expect(text()).toContain('Type WXYZ-1234 on the Plus website')
    await click(button('Open website'))
    expect(d.openLoginUrl).toHaveBeenCalledTimes(2)
    await click(button('Cancel'))
    expect(d.called('netEngine.plus.cancel')).toHaveLength(1)
  })

  it('turns the code back to Sign in when it expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const expiresAt = Math.floor(Date.now() / 1000) + 60
      daemon({
        plus: { configured: true, linked: false, link: { userCode: 'WXYZ-1234', verifyUrl: 'https://plus.test/link', expiresAt } }
      })
      await act(async () => root.render(createElement(EngineDevicesSection)))
      for (let i = 0; i < 6; i++) await act(async () => vi.advanceTimersByTime(0))
      expect(text()).toContain('Type WXYZ-1234 on the Plus website')
      await act(async () => vi.advanceTimersByTime(61_000))
      expect(text()).not.toContain('WXYZ-1234')
      expect(text()).toContain('The code expired. Sign in again.')
      expect(button('Sign in')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ['denied', 'Sign-in was declined.'],
    ['expired', 'The code expired. Sign in again.'],
    ['gone', 'Sign-in ended. Sign in again.']
  ])('says how a sign-in that did not finish ended: %s', async (linkResult, line) => {
    daemon({ plus: { configured: true, linked: false, linkResult } })
    await mount()
    expect(text()).toContain(line)
    expect(button('Sign in')).toBeTruthy()
  })

  it('shows the plan, what is left, and the paid relay per class with its remaining time', async () => {
    daemon({
      plus: {
        ...LINKED,
        relay: {
          interactive: { state: 'funded', bytesLeft: 1000, lastsSecs: 7200 },
          bulk: { state: 'funded', bytesLeft: 1000, lastsSecs: 300 }
        }
      }
    })
    await mount()
    expect(text()).toContain('Plus · Active')
    expect(text()).toContain('Typing: 512.0 MB of 1.00 GB left · Copies: 20.00 GB of 50.00 GB left')
    expect(host.querySelector('[data-plus-relay]')?.textContent).toBe('Typing: about 2h left · Copies: about 5m left')
    expect(statusLines()).toEqual([])
  })

  it('pauses copies over the paid relay with a line, never a prompt, while typing goes on', async () => {
    const d = daemon({
      plus: {
        ...LINKED,
        relay: {
          interactive: { state: 'funded', bytesLeft: 1000, lastsSecs: 7200 },
          bulk: { state: 'funded', bytesLeft: 0 }
        }
      }
    })
    await mount()
    await d.change({
      plus: {
        ...LINKED,
        relay: {
          interactive: { state: 'funded', bytesLeft: 1000, lastsSecs: 7200 },
          bulk: { state: 'paused', bytesLeft: 0, refillError: 'allowance_used' }
        }
      }
    })
    expect(host.querySelector('[data-plus-relay]')?.textContent).toBe('Typing: about 2h left · Copies: paused')
    expect(statusLines()).toEqual([
      'Copy allowance used up for this period.',
      'Copies over the paid relay are paused.'
    ])
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    // Resumed on its own: the line goes.
    await d.change({
      plus: { ...LINKED, relay: { bulk: { state: 'funded', bytesLeft: 9000, lastsSecs: 60 } } }
    })
    expect(statusLines()).toEqual([])
  })

  it('shows the top-up line when the typing balance is spent, and the outage line while Plus is down', async () => {
    daemon({
      plus: {
        ...LINKED,
        unreachableSince: 1_700_000_000,
        relay: { interactive: { state: 'unfunded', bytesLeft: 0, refillError: 'balance_empty' } }
      }
    })
    await mount()
    expect(statusLines()).toEqual([
      'Typing balance used up. Top up on the Plus website.',
      "Plus can't be reached. Showing what was last known."
    ])
    // What was last known still shows.
    expect(text()).toContain('Plus · Active')
  })

  it('refreshes and signs out from the menu', async () => {
    const d = daemon({ plus: LINKED })
    await mount()
    await click(button('Plus actions'))
    await click(menuItem('Refresh'))
    await click(button('Plus actions'))
    await click(menuItem('Sign out'))
    expect(d.called('netEngine.plus.refresh')).toHaveLength(1)
    expect(d.called('netEngine.plus.signOut')).toHaveLength(1)
  })
})

describe('Remove on all my hosts', () => {
  it('lists each host with the grant it named, says which hosts do not know the device, and removes on the chosen ones', async () => {
    const d = daemon()
    await mount()
    await click(canUseActions('Phone'))
    await click(menuItem('Remove on all my hosts…'))
    expect(d.called('netEngine.removeEverywhere.plan')).toEqual([{ node: 'n1' }])
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('Not known on Laptop')
    const office = dialog.querySelector<HTMLInputElement>('[data-host="h2"] input')!
    expect(office.checked).toBe(true)
    expect(dialog.querySelector('[data-host="h3"] input')).toBeNull()
    await click(office)
    await click(
      [...dialog.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === 'Remove')
    )
    expect(d.called('netEngine.removeEverywhere')).toEqual([{ node: 'n1', hosts: [{ host: 'h1', grant: 4 }] }])
  })

  it('offers it only once the helper has said who this computer is', async () => {
    daemon({ identity: undefined })
    await mount()
    await click(canUseActions('Phone'))
    expect(menuItem('Remove on all my hosts…')).toBeUndefined()
    expect(menuItem('Remove…')).toBeTruthy()
  })

  // Every state of design D.3, and the host named by its name here or the start of its id.
  const removal = (fields: Partial<NetEngineRemoval>): NetEngineRemoval => ({
    id: 'r1',
    host: 'h1aaaaaaaaaa',
    hostName: 'Studio',
    removed: 'x1',
    name: 'Phone',
    grant: 4,
    state: 'waiting',
    ...fields
  })
  it.each<[string, Partial<NetEngineRemoval>, string, boolean]>([
    ['applied', { state: 'done', result: 'applied' }, 'Removed', false],
    // A newer pairing of the device keeps its access on that host.
    ['stale', { state: 'done', result: 'stale' }, 'Already replaced by a newer pairing', true],
    ['refused', { state: 'done', result: 'refused' }, 'Refused', true],
    ['sent by mail', { state: 'sent' }, 'Waiting (sent)', false],
    ['fetched by the host', { state: 'delivered' }, 'Delivered, not confirmed', false],
    ['inbox full', { state: 'quota' }, 'Waiting for Studio to collect its mail', false],
    ['kept here', { state: 'waiting' }, 'Waits until this device reaches Studio', false],
    ['kept here, host unknown here', { state: 'waiting', hostName: undefined }, 'Waits until this device reaches h1aaaaaa', false],
    ['too old', { state: 'expired' }, "Couldn't remove from Studio; remove it there", true]
  ])('%s', (_name, fields, line, warn) => {
    const view = removalText(removal(fields))
    expect(view.line).toBe(line)
    expect(!!view.warn).toBe(warn)
  })

  it("shows each host's state under the removed device", async () => {
    daemon({
      removals: [
        removal({ id: 'r1', state: 'done', result: 'applied' }),
        removal({ id: 'r2', host: 'h2', hostName: 'Office', state: 'quota' })
      ]
    })
    await mount()
    expect(host.querySelector('[data-removal="x1"]')?.textContent?.replace(/\s+/g, ' ')).toContain(
      'Studio: Removed · Office: Waiting for Office to collect its mail'
    )
    expect(removalTitle()).toEqual({ line: 'Removing Phone on my hosts', warn: false })
  })

  it.each<[string, Array<Partial<NetEngineRemoval>>, string, boolean]>([
    ['every host removed it', [{ state: 'done', result: 'applied' }, { state: 'done', result: 'applied' }], 'Phone removed on my hosts', false],
    ['one host refused', [{ state: 'done', result: 'applied' }, { state: 'done', result: 'refused' }], 'Phone not removed on every host', true],
    ['one host keeps a newer pairing', [{ state: 'done', result: 'applied' }, { state: 'done', result: 'stale' }], 'Phone not removed on every host', true],
    ['one host never answered in time', [{ state: 'sent' }, { state: 'expired' }], 'Phone not removed on every host', true]
  ])('titles the removal by its hosts’ states: %s', async (_name, states, line, warn) => {
    daemon({
      removals: states.map((fields, index) => removal({ id: `r${index}`, host: `h${index}`, hostName: `Host ${index}`, ...fields }))
    })
    await mount()
    expect(removalTitle()).toEqual({ line, warn })
  })

  it('asks again for a host that named the device later, and sends the answer', async () => {
    const d = daemon({ removalAsks: [{ identity: 'x1', name: 'Phone', host: 'h3', hostName: 'Laptop', grant: 12 }] })
    await mount()
    expect(statusLines()).toContain('Phone is also on Laptop. Remove it there?RemoveKeep')
    await click(button('Keep'))
    expect(d.called('netEngine.removeEverywhere.answer')).toEqual([
      { identity: 'x1', host: 'h3', grant: 12, yes: false }
    ])
  })
})
