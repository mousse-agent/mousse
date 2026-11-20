// @vitest-environment jsdom
/**
 * Settings → Devices for the new networking (design §5.2, §7): the switch, each paired computer's row and its
 * actions, the same-account notice, and the Add device dialog (Show QR with the approval inside it, Scan with
 * its confirmation). The daemon is stubbed at `platformRequest`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetEngineDevice, NetEngineRelay, NetEngineStatus } from '../../src/shared/netEngine/local'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')
const { AddEngineDeviceDialog } = await import('../../src/renderer/components/netEngine/AddEngineDeviceDialog')
const { engineRow, CLOCK_MESSAGE, SHARED_ACCOUNT_LINE } = await import('../../src/renderer/components/netEngine/engineRows')

const device = (fields: Partial<NetEngineDevice> & { node: string }): NetEngineDevice => ({
  name: 'Studio',
  shortId: 'a1b2c3d4',
  state: 'connected',
  online: true,
  ...fields
})

describe('a device row (§5.2)', () => {
  // The inputs: each row state, the two failing directions, the refusal, the clock, before and after the bound.
  const rows: Array<[string, Partial<NetEngineDevice>, string, string[]]> = [
    ['connected', {}, 'Connected', ['access', 'address', 'remove']],
    ['finishing, within the bound', { state: 'finishing', online: false }, 'Finishing pairing…', []],
    ['finishing, past the bound', { state: 'finishing', online: false, stuck: true }, 'Finishing pairing…', ['retry', 'remove']],
    ['it cannot reach this computer', { unreachable: 'in' }, "Studio can't reach this computer", ['retry', 'remove']],
    ['this computer cannot reach it', { unreachable: 'out', online: false }, "This computer can't reach Studio", ['retry', 'remove']],
    ['it no longer accepts this one', { notAccepted: true, online: false }, 'Studio no longer accepts this computer', ['remove']],
    ['certificate outside its window', { certificateWindow: true, online: false }, CLOCK_MESSAGE, ['retry', 'remove']],
    ['removing', { state: 'removing', online: false }, 'Removing…', []],
    ['offline', { state: 'offline', online: false }, 'Offline', ['access', 'address', 'retry', 'remove']],
    ['one direction up, within the bound', { state: 'connecting' }, 'Connecting…', ['access', 'address', 'retry', 'remove']],
    ['one direction up, past the bound', { state: 'connecting', unreachable: 'in' }, "Studio can't reach this computer", ['retry', 'remove']]
  ]
  it.each(rows)('%s', (_name, fields, line, actions) => {
    const view = engineRow(device({ node: 'n1', ...fields }))
    expect(view.line).toBe(line)
    expect(view.actions).toEqual(actions)
  })

  it('gives every failing state its fix as a tooltip', () => {
    for (const [, fields] of rows.filter(([, , , actions]) => actions.includes('retry')))
      expect(engineRow(device({ node: 'n1', ...fields })).detail ?? '').not.toBe('')
  })
})

/** The daemon behind the section: a status, and every call it was asked. */
function daemon(
  initial: Partial<NetEngineStatus> = {},
  answers: Record<string, (params: any) => unknown> = {}
) {
  const state: { status: NetEngineStatus } = {
    status: {
      enabled: true,
      on: true,
      helper: { state: 'running' },
      devices: [],
      approvals: [],
      ...initial
    }
  }
  const calls: Array<[string, any]> = []
  const changed = new Set<(change: { profileId?: string }) => void>()
  const request = vi.fn(async (method: string, params: any) => {
    calls.push([method, params])
    if (answers[method]) return answers[method]!(params)
    switch (method) {
      case 'netEngine.status':
        return state.status
      case 'netEngine.invite':
        return { invitation: 'inv1', uri: 'mousse://pair?n=Studio#AAAAAAAAAAAAAAAAAAAAAAAA' }
      case 'bridge.nodes':
        return {
          nodes: [
            {
              node: 'n1',
              name: 'Studio',
              self: false,
              revoked: false,
              caps: ['read'],
              kind: 'computer',
              state: 'open',
              routes: [],
              policy: { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, agentReach: false, work: false }
            }
          ]
        }
      case 'net.status':
        return { enabled: false }
      default:
        return state.status
    }
  })
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    netEngine: {
      onChanged: (cb: (change: { profileId?: string }) => void) => {
        changed.add(cb)
        return () => changed.delete(cb)
      }
    }
  }
  return {
    state,
    calls,
    called: (method: string) => calls.filter(([name]) => name === method).map(([, params]) => params),
    /** The daemon's status changes and it says so, as `netEngine:changed` does. */
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
const mount = async (element = createElement(EngineDevicesSection)) => {
  await act(async () => root.render(element))
  await flush()
}
const button = (name: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    typeof name === 'string'
      ? item.textContent?.trim() === name || item.getAttribute('aria-label') === name
      : name.test(item.textContent ?? '')
  )
const click = async (target: HTMLElement | undefined) => {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  await flush()
}
const menuItems = async (name: string) => {
  await click(button(`Actions for ${name}`))
  return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].map((item) => item.textContent?.trim())
}
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const rowOf = (node: string) => host.querySelector<HTMLElement>(`[data-device-node="${node}"]`)
/** A row's text as read, spaces collapsed (an icon sits where the double space is). */
const rowText = (node: string) => (rowOf(node)?.textContent ?? '').replace(/\s+/g, ' ')

describe('Settings → Devices, new networking', () => {
  it('turns the switch on and off through the daemon', async () => {
    const d = daemon({ enabled: false, on: false, helper: { state: 'off' } })
    await mount()
    const toggle = host.querySelector<HTMLElement>('[role="switch"]')!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(d.called('netEngine.enable')).toHaveLength(1)
  })

  it.each([
    ['Start at login', true],
    ['Not now', false]
  ])('asks once about starting at login, and "%s" answers it', async (name, start) => {
    const question = 'Start Mousse at login so your other computers can reach this one?'
    const d = daemon({ loginStart: 'ask' })
    await mount()
    expect(host.textContent).toContain(question)
    expect(button('Start at login')).toBeTruthy()
    expect(button('Not now')).toBeTruthy()
    await click(button(name))
    expect(d.called('netEngine.loginStart')).toEqual([{ start }])
    await d.change({ loginStart: undefined })
    expect(host.textContent).not.toContain(question)
  })

  it('shows "Let my other devices work here" while v1 is off, and turning it off goes to the daemon', async () => {
    const label = "Let my other devices work on this device's threads"
    const toggle = () => host.querySelector<HTMLElement>(`[role="switch"][aria-label="${label}"]`)
    // v1 on: its own Devices group has the switch, so this one does not.
    daemon({})
    await mount()
    expect(toggle()).toBeNull()
    act(() => root.unmount())
    root = createRoot(host)
    const d = daemon({ workOnThreads: true })
    await mount()
    expect(toggle()?.getAttribute('aria-checked')).toBe('true')
    await click(toggle()!)
    expect(d.called('netEngine.workOnThreads')).toEqual([{ enabled: false }])
    await d.change({ workOnThreads: false })
    expect(toggle()?.getAttribute('aria-checked')).toBe('false')
    expect(host.textContent).toContain('no other device can open or change this device’s threads')
  })

  it('shows nothing in a build without the helper while the switch is off', async () => {
    daemon({ enabled: false, on: false, helper: { state: 'not_in_build' } })
    await mount()
    expect(host.textContent).toBe('')
  })

  it('shows each row with its id, state and where it is found, and the actions its state allows', async () => {
    daemon({
      devices: [
        device({ node: 'n1', addresses: ['tcp://192.168.1.20:47100'] }),
        device({ node: 'n2', name: 'Laptop', shortId: 'ffee0011', unreachable: 'out', online: false })
      ]
    })
    await mount()
    expect(rowText('n1')).toContain('a1b2c3d4 · Connected · 192.168.1.20:47100')
    expect(rowText('n2')).toContain("ffee0011 · This computer can't reach Laptop · LAN")
    expect(await menuItems('Laptop')).toEqual(['Retry', 'Remove…'])
  })

  it('opens Access under the row, marking the row, from the row menu', async () => {
    daemon({ devices: [device({ node: 'n1' })] })
    await mount()
    expect(await menuItems('Studio')).toEqual(['Access', 'Add address…', 'Remove…'])
    await click(button('Access'))
    expect(rowOf('n1')!.classList.contains('engine-row-selected')).toBe(true)
    expect(host.textContent).toContain('Access from this device')
  })

  it('adds an address and removes a computer through the daemon', async () => {
    const d = daemon({ devices: [device({ node: 'n1' })] })
    await mount()
    await menuItems('Studio')
    await click(button('Add address…'))
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Address and port"]')!, '192.168.1.20:47100')
    await click(button('Add'))
    expect(d.called('netEngine.address.add')).toEqual([{ node: 'n1', address: '192.168.1.20:47100' }])

    await menuItems('Studio')
    await click(button('Remove…'))
    await click(button('Remove'))
    expect(d.called('netEngine.remove')).toEqual([{ node: 'n1' }])
  })

  it('says once that profiles in this account can read each other, with the reason as its tooltip', async () => {
    const d = daemon()
    await mount()
    expect(host.textContent).not.toContain(SHARED_ACCOUNT_LINE)
    await d.change({ sharedAccount: true })
    const notice = [...host.querySelectorAll<HTMLElement>('[title]')].find((item) => item.textContent === SHARED_ACCOUNT_LINE)
    expect(notice?.title).toMatch(/separate accounts/)
  })
})

describe('Add device', () => {
  it('shows a code, asks inside the dialog, and says the other direction is finishing', async () => {
    const d = daemon()
    await mount()
    await click(button('Add device'))
    await click(button('Show QR'))
    expect(d.called('netEngine.invite')).toHaveLength(1)
    expect(document.querySelector('[aria-label="Pairing QR code"]')).toBeTruthy()

    await d.change({ approvals: [{ request: 'r1', invitation: 'inv1', name: 'Laptop (Work)', device: 'ffee0011' }] })
    expect(document.body.textContent).toContain('Is Laptop (Work) next to you?')
    await click(button('Yes'))
    expect(d.called('netEngine.approve')).toEqual([{ request: 'r1', yes: true }])

    await d.change({ approvals: [], devices: [device({ node: 'n3', name: 'Laptop (Work)', state: 'finishing' })] })
    expect(document.body.textContent).toContain('Laptop (Work) can use this computer; finishing the other direction…')
  })

  it('ends the invitation when the dialog closes before anyone joined', async () => {
    const d = daemon()
    await mount()
    await click(button('Add device'))
    await click(button('Show QR'))
    await click(button('Close'))
    expect(d.called('netEngine.invite.cancel')).toEqual([{ invitation: 'inv1' }])
  })

  it('without a camera, says to scan from the other computer, and confirms a pasted link before joining', async () => {
    const d = daemon()
    const onClose = vi.fn()
    await mount(createElement(AddEngineDeviceDialog, { status: d.state.status, onClose, initial: 'scan', camera: async () => undefined }))
    expect(document.body.textContent).toContain('Scan from the other computer instead.')
    const link = 'mousse://pair?n=Studio%20Mac#AAAAAAAAAAAAAAAAAAAAAAAA'
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]')!, link)
    await click(button('Continue'))
    expect(document.body.textContent).toContain('Connect to Studio Mac? Studio Mac will also be able to use this computer.')
    expect(d.called('netEngine.join')).toEqual([])
    await click(button('Connect'))
    expect(d.called('netEngine.join')).toEqual([{ ticket: link }])
    expect(onClose).toHaveBeenCalled()
  })

  it('reads camera frames as often as the daemon says (the engine limit scanIntervalMs)', async () => {
    const d = daemon({ scanIntervalMs: 75 })
    const every = vi.spyOn(globalThis, 'setInterval')
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const stream = { getTracks: () => [] } as unknown as MediaStream
    try {
      await mount(createElement(AddEngineDeviceDialog, { status: d.state.status, onClose: () => undefined, initial: 'scan', camera: async () => stream }))
      await act(async () => undefined)
      expect(every.mock.calls.map(([, ms]) => ms)).toContain(75)
    } finally {
      vi.restoreAllMocks()
    }
  })
})

describe('routes (1b §1.3, §1.5)', () => {
  const tailnet = (host: string) => ({ route: `tcp://${host}:47100`, label: `${host}:47100`, cls: 'tailnet' as const })

  it('lists the ticket destinations with their class, and shares only the routes ticked', async () => {
    const d = daemon({}, {
      'netEngine.join.preview': () => ({
        kind: 1,
        destinations: [{ ...tailnet('100.101.7.2'), automatic: false }],
        shareable: [tailnet('100.101.7.9')]
      })
    })
    await mount(createElement(AddEngineDeviceDialog, { status: d.state.status, onClose: () => undefined, initial: 'scan', camera: async () => undefined }))
    const link = 'mousse://pair?n=Studio#AAAAAAAAAAAAAAAAAAAAAAAA'
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]')!, link)
    await click(button('Continue'))
    expect(document.body.textContent).toContain('100.101.7.2:47100 (Tailnet)')
    const box = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    expect(box.checked).toBe(false)
    expect(box.closest('label')?.textContent).toBe('Tailnet 100.101.7.9:47100')

    await click(button('Connect'))
    expect(d.called('netEngine.join').at(-1)).toEqual({ ticket: link })
  })

  it('sends a ticked route in the join', async () => {
    const d = daemon({}, {
      'netEngine.join.preview': () => ({ kind: 1, destinations: [], shareable: [tailnet('100.101.7.9')] }),
      'netEngine.join': () => {
        throw new Error('stop here')
      }
    })
    await mount(createElement(AddEngineDeviceDialog, { status: d.state.status, onClose: () => undefined, initial: 'scan', camera: async () => undefined }))
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]')!, 'mousse://pair?n=Studio#AAAAAAAAAAAAAAAAAAAAAAAA')
    await click(button('Continue'))
    await click(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!)
    await click(button('Connect'))
    expect(d.called('netEngine.join').at(-1)).toMatchObject({ share: ['tcp://100.101.7.9:47100'] })
  })

  it('names the class a device is connected on, and offers its offered addresses with Use', async () => {
    const d = daemon({
      devices: [device({ node: 'n1', route: 'tailnet', offered: ['wss://x.example/mousse-net/1'] })]
    })
    await mount()
    expect(rowText('n1')).toContain('a1b2c3d4 · Connected · Tailnet')
    expect(host.textContent).toContain('Addresses Studio offered')
    expect(host.textContent).toContain('x.example')
    await click(button('Use'))
    expect(d.called('netEngine.address.use')).toEqual([{ node: 'n1' }])
  })

  it('saves Reach through the daemon, tests a route, and says a failed test may be the network', async () => {
    const d = daemon(
      {
        routes: ['tcp://192.168.1.20:47100', 'wss://x.example/mousse-net/1'],
        reach: { lan: true, tailnet: false, public: [], tunnels: ['wss://x.example/mousse-net/1'], port: 47100, wsPort: 47101 }
      },
      {
        'netEngine.routes.test': () => ({ ok: false, reason: 'unreachable' }),
        'netEngine.routes.config': () => ({ restarted: true })
      }
    )
    await mount()
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Tunnel URL"]')!.value).toBe('https://x.example')
    expect(host.textContent).toContain('cloudflared tunnel --url http://127.0.0.1:47101')
    await click(host.querySelector<HTMLElement>('[role="switch"][aria-label="Tailnet"]') ?? undefined)
    expect(d.called('netEngine.routes.config')).toEqual([{ tailnet: true }])

    const tests = [...document.querySelectorAll<HTMLButtonElement>('button')].filter((item) => item.textContent === 'Test')
    await click(tests.at(-1))
    expect(d.called('netEngine.routes.test')).toEqual([{ route: 'wss://x.example/mousse-net/1' }])
    const failed = [...host.querySelectorAll<HTMLElement>('[role="status"]')].find((item) => item.textContent === "Couldn't confirm from this network")
    expect(failed?.title).toMatch(/Saving still works/)
  })
})

describe('relays (Phase 3 §B.5, §B.9, §B.11)', () => {
  const DESTINATION = 'relay://relay.example.net:443'
  const relay = (fields: Partial<NetEngineRelay> = {}): NetEngineRelay => ({
    id: 'aa11',
    endpoint: 'relay.example.net:443',
    state: 'registered',
    callers: 3,
    callersMax: 256,
    ...fields
  })
  const relayRow = (endpoint: string) =>
    [...host.querySelectorAll<HTMLElement>('.settings-item')].find(
      (item) => item.querySelector('.settings-item-title')?.textContent === endpoint
    )

  it('adds your own relay from a pasted link, with Reach shown for relays alone', async () => {
    const d = daemon({ relays: { available: true, list: [] } })
    await mount()
    expect(host.textContent).toContain('Your own relay')
    const link = `mousse-relay://relay.example.net:443/#${'A'.repeat(43)}.${'C'.repeat(22)}`
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Relay link"]')!, link)
    await click(button('Add'))
    expect(d.called('netEngine.relay.enroll')).toEqual([{ link }])
  })

  it('says why a link was refused', async () => {
    daemon(
      { relays: { available: true, list: [] } },
      {
        'netEngine.relay.enroll': () => {
          throw new Error('This link was used already, or has expired.')
        }
      }
    )
    await mount()
    await type(host.querySelector<HTMLInputElement>('input[aria-label="Relay link"]')!, 'mousse-relay://x:1/#a.b')
    await click(button('Add'))
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('This link was used already, or has expired.')
  })

  it('lists each relay with its state, live, and offers New relay key and Remove', async () => {
    const d = daemon({ relays: { available: true, list: [relay()] } })
    await mount()
    expect(relayRow('relay.example.net:443')?.textContent).toContain('Connected · 3 of 256 devices')

    await click(button('New relay key'))
    expect(d.called('netEngine.relay.rotate')).toEqual([{ relay: 'aa11' }])
    // The helper answers before the relay takes the new key: pending, with no end time yet, and no second rotation.
    await d.change({ relays: { available: true, list: [relay({ newKeyPending: true })] } })
    expect(relayRow('relay.example.net:443')?.textContent).toContain('New key pending')
    expect(relayRow('relay.example.net:443')?.textContent).not.toContain('Rotating until')
    expect(button('New relay key')?.disabled).toBe(true)
    await d.change({ relays: { available: true, list: [relay({ rotatingUntil: Date.now() + 3_600_000 })] } })
    expect(relayRow('relay.example.net:443')?.textContent).toContain('Rotating until')
    expect(relayRow('relay.example.net:443')?.textContent).not.toContain('New key pending')

    // The helper's relay.state reaches the window as a status change.
    await d.change({
      relays: {
        available: true,
        list: [relay({ state: 'retrying', reason: 'relay_unreachable', retryAt: Date.now() + 30_000 })]
      }
    })
    const line = [...relayRow('relay.example.net:443')!.querySelectorAll<HTMLElement>('[title]')].find((item) =>
      item.textContent?.startsWith('Retrying at ')
    )
    expect(line?.title).toBe("Couldn't reach the relay.")
    expect(relayRow('relay.example.net:443')?.textContent).not.toContain('of 256 devices')
    expect(button('New relay key')?.disabled).toBe(true)

    await click(button('Remove relay relay.example.net:443'))
    await click(button('Remove'))
    expect(d.called('netEngine.relay.remove')).toEqual([{ relay: 'aa11' }])
  })

  it('turns "Retrying at" into "Retrying…" once its time passes, without a new status', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      daemon({ relays: { available: true, list: [relay({ state: 'retrying', reason: 'relay_new_thing', retryAt: Date.now() + 5_000 })] } })
      await act(async () => root.render(createElement(EngineDevicesSection)))
      for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(relayRow('relay.example.net:443')?.textContent).toContain('Retrying at ')
      // A reason with no words in the app shows a fixed line, never the helper's word.
      const line = [...relayRow('relay.example.net:443')!.querySelectorAll<HTMLElement>('[title]')].find((item) =>
        item.textContent?.startsWith('Retrying')
      )
      expect(line?.title).toBe('The connection to the relay ended.')
      await act(async () => { await vi.advanceTimersByTimeAsync(5_100) })
      expect(relayRow('relay.example.net:443')?.textContent).toContain('Retrying…')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows how many devices a relay lists without inventing its limit', async () => {
    daemon({ relays: { available: true, list: [relay({ callersMax: undefined })] } })
    await mount()
    expect(relayRow('relay.example.net:443')?.textContent).toContain('Connected · 3 devices')
  })

  it('says a relay that refused this computer is refused', async () => {
    daemon({ relays: { available: true, list: [relay({ state: 'refused', reason: 'relay_removed' })] } })
    await mount()
    expect(relayRow('relay.example.net:443')?.textContent).toContain('The relay refused this computer')
  })

  it('labels a connection through a relay with the relay', async () => {
    daemon({ devices: [device({ node: 'n1', route: 'relay', via: 'relay.example.net:443' })] })
    await mount()
    expect(rowText('n1')).toContain('a1b2c3d4 · Connected · Through relay relay.example.net:443')
  })

  it('asks once on the row before dialling an offered relay, and Allow goes to the daemon', async () => {
    const d = daemon({ devices: [device({ node: 'n1', relay: { offered: [DESTINATION] } })] })
    await mount()
    expect(host.textContent).toContain('Studio can be reached through relay relay.example.net:443. Allow?')
    await click(button('Allow'))
    expect(d.called('netEngine.relay.allow')).toEqual([{ node: 'n1', destination: DESTINATION }])
  })

  it('offers Not now beside Allow, which goes to the daemon instead', async () => {
    const d = daemon({ devices: [device({ node: 'n1', relay: { offered: [DESTINATION] } })] })
    await mount()
    await click(button('Not now'))
    expect(d.called('netEngine.relay.dismiss')).toEqual([{ node: 'n1', destination: DESTINATION }])
    expect(d.called('netEngine.relay.allow')).toEqual([])
  })

  it('takes an allowed relay back from the row menu', async () => {
    const d = daemon({ devices: [device({ node: 'n1', relay: { allowed: [DESTINATION] } })] })
    await mount()
    expect(host.textContent).not.toContain('Allow?')
    expect(await menuItems('Studio')).toContain('Stop using relay relay.example.net:443')
    await click(button('Stop using relay relay.example.net:443'))
    expect(d.called('netEngine.relay.disallow')).toEqual([{ node: 'n1', destination: DESTINATION }])
  })

  it('says only when relay info is out of date, with why as its tooltip', async () => {
    const d = daemon({ devices: [device({ node: 'n1' })] })
    await mount()
    expect(rowText('n1')).not.toContain('Relay info')
    await d.change({ devices: [device({ node: 'n1', relay: { stale: true } })] })
    const note = [...rowOf('n1')!.querySelectorAll<HTMLElement>('[title]')].find(
      (item) => item.textContent === 'Relay info out of date'
    )
    expect(note?.title).toMatch(/tried last/)
  })

  it('says a device past the limit is not reachable through the relay, with the limit the helper names', async () => {
    const d = daemon({
      devices: [device({ node: 'n1', relay: { limit: { callersMax: 128 } } }), device({ node: 'n2', name: 'Laptop' })]
    })
    await mount()
    expect(rowText('n1')).toContain('Not reachable through the relay (limit 128)')
    expect(rowText('n2')).not.toContain('Not reachable')
    await d.change({ devices: [device({ node: 'n1', relay: { limit: {} } })] })
    expect(rowText('n1')).toContain('Not reachable through the relay (over its limit)')
  })

  it('lists a ticket’s relay among the destinations as the relay it goes through', async () => {
    const d = daemon({}, {
      'netEngine.join.preview': () => ({
        kind: 1,
        destinations: [{ route: `relay://relay.example.net:443/${'A'.repeat(43)}/${'B'.repeat(43)}`, label: 'relay.example.net:443', cls: 'relay', automatic: false, destination: DESTINATION }],
        shareable: []
      })
    })
    await mount(createElement(AddEngineDeviceDialog, { status: d.state.status, onClose: () => undefined, initial: 'scan', camera: async () => undefined }))
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]')!, 'mousse://pair?n=Studio#AAAAAAAAAAAAAAAAAAAAAAAA')
    await click(button('Continue'))
    expect(document.body.textContent).toContain('Through relay relay.example.net:443')
  })
})

describe('Add over SSH (1b §3.4)', () => {
  const resolved = { routeId: 'r1', user: 'me', hostname: 'box.example', port: 22, pinned: false }

  it('trusts the host key shown, lists every profile with New profile, and connects the one picked', async () => {
    const d = daemon(
      { reach: { lan: true, tailnet: false, public: [], tunnels: [] } },
      {
        'netEngine.ssh.resolve': () => resolved,
        'netEngine.ssh.probe': () => ({ keyType: 'ssh-ed25519', sha256: 'SHA256:abc', inUserKnownHosts: true }),
        'netEngine.ssh.trust': () => ({}),
        'netEngine.ssh.profiles': () => ({
          computer: 'Box',
          os: 'macos',
          profiles: [
            { selector: 'a'.repeat(26), label: 'Main', networking: true },
            { selector: 'b'.repeat(26), label: 'Work', networking: true, identity: 'ff' }
          ]
        }),
        'netEngine.ssh.connect': () => ({ node: 'n9' })
      }
    )
    const onClose = vi.fn()
    await mount(createElement(AddEngineDeviceDialog, { status: d.state.status, onClose }))
    await click(button('Over SSH'))
    await type(document.querySelector<HTMLInputElement>('input[aria-label="SSH address"]')!, 'me@box.example')
    await click(button('Continue'))
    expect(document.body.textContent).toContain('ssh-ed25519 SHA256:abc')
    expect(d.called('netEngine.ssh.profiles')).toEqual([])
    await click(button('Trust'))
    expect(d.called('netEngine.ssh.trust')).toEqual([{ routeId: 'r1', sha256: 'SHA256:abc', host: 'box.example' }])
    const labels = [...document.querySelectorAll('label')].map((item) => item.textContent)
    expect(labels).toEqual(['Main', 'Work', 'New profile'])
    await click([...document.querySelectorAll<HTMLInputElement>('input[type="radio"]')][1])
    await click(button('Connect'))
    expect(d.called('netEngine.ssh.connect')).toEqual([
      { routeId: 'r1', target: 'me@box.example', host: 'box.example', user: 'me', selector: 'b'.repeat(26) }
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it('offers Over SSH only when the helper speaks protocol 1.1', async () => {
    const d = daemon()
    await mount(createElement(AddEngineDeviceDialog, { status: d.state.status, onClose: () => undefined }))
    expect(button('Over SSH')).toBeUndefined()
  })
})
