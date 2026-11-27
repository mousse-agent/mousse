// @vitest-environment jsdom
/**
 * Settings → Devices for the new networking (design §5.2, §7): the switch, the list of devices with which way each
 * works and the chosen one's detail (routes, access, actions), the same-account notice, and the two add
 * dialogs: Let a device in (how it connects, the code, Allow with a level) and Use another computer (the check
 * before Connect, one way unless "Also let" is ticked, SSH). The daemon is stubbed at `platformRequest`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetEngineDevice, NetEngineRelay, NetEngineStatus } from '../../src/shared/netEngine/local'
import { accessPreset } from '../../src/shared/net/accessPresets'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } = await import('../../src/renderer/components/netEngine/EngineDevicesSection')
const { AccessAskHost } = await import('../../src/renderer/components/netEngine/AccessAskHost')
const { UseComputerDialog } = await import('../../src/renderer/components/netEngine/UseComputerDialog')
const { useAppStore } = await import('../../src/renderer/stores/appStore')
const { NO_COMPUTERS, useComputersStore } = await import('../../src/renderer/lib/computers')
const { engineRow, engineSideRow, engineSides, clockMessage, SHARED_ACCOUNT_LINE } = await import(
  '../../src/renderer/components/netEngine/engineRows'
)

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
    ['certificate outside its window', { certificateWindow: true, online: false }, clockMessage('Studio'), ['retry', 'remove']],
    ['SSH sign-in refused (parked)', { sshParked: 'auth_denied', state: 'offline', online: false }, 'SSH sign-in to Studio was refused', ['retry', 'remove']],
    ['SSH key changed (parked)', { sshParked: 'host_key_changed', state: 'offline', online: false }, "Studio's SSH key changed", ['retry', 'remove']],
    ['SSH key not checked (parked)', { sshParked: 'host_key_unknown', state: 'connecting', online: false }, "Check Studio's SSH key", ['retry', 'remove']],
    ['removing', { state: 'removing', online: false }, 'Removing…', []],
    ['offline', { state: 'offline', online: false }, "Can't reach it · open Mousse on Studio", ['access', 'address', 'retry', 'remove']],
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

describe('a direction of a pairing', () => {
  it.each([
    ['both ways', {}, ['out', 'in']],
    ['this computer uses it', { direction: 'out' as const }, ['out']],
    ['it uses this computer', { direction: 'in' as const }, ['in']],
    ['still being made', { state: 'finishing' as const }, ['out']]
  ])('lists %s under its direction', (_name, fields, sides) => {
    expect(engineSides(device({ node: 'n1', ...fields }))).toEqual(sides)
  })

  it('puts Access on Can use, routes on Computers I use, and a down direction only on its own row', () => {
    const both = device({ node: 'n1' })
    expect(engineSideRow(both, 'in')).toMatchObject({ line: 'Connected', actions: ['access', 'remove'] })
    expect(engineSideRow(both, 'out')).toMatchObject({ line: 'Connected', actions: ['address', 'remove'] })
    const inDown = device({ node: 'n1', unreachable: 'in' })
    expect(engineSideRow(inDown, 'in')).toMatchObject({ line: "Studio can't reach this computer", warn: true })
    expect(engineSideRow(inDown, 'out')).toMatchObject({ line: 'Connected' })
    // Not connected now is normal for a device that uses this computer.
    const away = device({ node: 'n1', direction: 'in', state: 'offline', online: false })
    expect(engineSideRow(away, 'in')).toMatchObject({ line: 'Not connected now' })
    expect(engineSideRow(away, 'in').warn).toBeUndefined()
  })

  it('says on Can use when a level change is not applied yet, keeping Access and Remove', () => {
    const pending = device({ node: 'n1', accessPending: true })
    expect(engineSideRow(pending, 'in')).toMatchObject({
      line: 'Access change not applied yet',
      warn: true,
      actions: ['access', 'remove']
    })
    expect(engineSideRow(pending, 'out')).toMatchObject({ line: 'Connected' })
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
        return { invitation: 'inv1', uri: 'mousse://pair?n=Studio#AAAAAAAAAAAAAAAAAAAAAAAA', expiresAt: Math.floor(Date.now() / 1000) + 300 }
      case 'bridge.nodes':
        return {
          nodes: [
            {
              node: 'n1',
              name: 'Studio',
              self: false,
              revoked: false,
              caps: ['read', 'chat', 'write', 'terminal', 'settings'],
              kind: 'computer',
              state: 'open',
              source: 'engine',
              routes: [],
              policy: { blocked: false, maxPermissionMode: 'accept_edits', terminal: false, editor: false, agentReach: false, work: false }
            }
          ]
        }
      case 'netEngine.join.preview':
        return { kind: 1, destinations: [], shareable: [] }
      case 'net.status':
        return { enabled: false }
      case 'bridge.activity':
        return { entries: [], rules: [], counts: [], uncertain: 0, refused: 0, reads: { calls: 0, bytes: 0, hours: [] } }
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
  // Settings shows only once the window's profile is bound; before that nothing reads the computers.
  useAppStore.setState({ profileReady: true })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  // Each case starts with no computers listed, as a fresh window does.
  useComputersStore.setState(NO_COMPUTERS)
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
/** A row of a list to pick one from, by its name. */
const radio = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find(
    (row) => row.querySelector('.engine-choice-label')?.textContent === label
  )
const click = async (target: HTMLElement | undefined) => {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  await flush()
}
/** Chooses a device in the list, by its name; its detail shows beside the list. */
const choose = (name: string) => click(host.querySelector<HTMLElement>(`[data-device-node] button[aria-label="${name}"]`) ?? undefined)
/** A device's menu, in its detail: chosen first when it isn't. */
const menuItems = async (name: string) => {
  if (!button(`Actions for ${name}`)) await choose(name)
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
/** A device's row in the list. */
const rowOf = (node: string) => host.querySelector<HTMLElement>(`[data-device-node="${node}"]`)
/** A row's text as read, spaces collapsed. */
const rowText = (node: string) => (rowOf(node)?.textContent ?? '').replace(/\s+/g, ' ')
/** The chosen device's detail, and its text as read. */
const detail = () => host.querySelector<HTMLElement>('[data-device-detail]')
const detailText = () => (detail()?.textContent ?? '').replace(/\s+/g, ' ')
/** The devices in the list, by node, in order. */
const listNodes = () => [...host.querySelectorAll<HTMLElement>('[data-device-node]')].map((row) => row.dataset.deviceNode)

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

  it('says networking is not in a build without the helper, with no switch', async () => {
    daemon({ enabled: false, on: false, helper: { state: 'not_in_build' } })
    await mount()
    expect(host.textContent).toContain("Networking isn't in this build.")
    expect(host.querySelector('[role="switch"][aria-label="Networking"]')).toBeNull()
  })

  it('shows each device with its state, which way it works and how it is connected, its id only as a tooltip, and the actions its state allows', async () => {
    daemon({
      devices: [
        device({ node: 'n1', addresses: ['tcp://192.168.1.20:47100'] }),
        device({ node: 'n2', name: 'Laptop', shortId: 'ffee0011', unreachable: 'out', online: false }),
        device({ node: 'n3', name: 'Mini', shortId: '04a223d6', state: 'finishing', stuck: true, route: 'tailnet' })
      ]
    })
    await mount()
    // The first device shows at once.
    expect(detailText()).toContain('Connected · same network · Both ways')
    expect(rowText('n1')).not.toContain('a1b2c3d4')
    expect(detail()!.querySelector('[title="Id a1b2c3d4"]')).toBeTruthy()
    expect(rowText('n2')).toContain("This computer can't reach Laptop")
    // Two lines: the name, then the state and the direction; no id and no separator left hanging.
    expect(rowText('n3')).toContain('Finishing pairing… · I use it')
    expect(rowText('n3')).not.toMatch(/04a223d6|· ·|·\s*$/)
    expect(rowOf('n3')!.querySelector('[title*="Keep Tailscale on and online on both computers, then Retry."]')).toBeTruthy()
    expect(await menuItems('Laptop')).toEqual(['Retry', 'Remove…'])
  })

  it('lists every pairing once, saying which way it works', async () => {
    daemon({
      devices: [
        device({ node: 'both' }),
        device({ node: 'uses', name: 'Server', direction: 'out' }),
        device({ node: 'usedBy', name: 'Phone-ish', direction: 'in' })
      ]
    })
    await mount()
    expect(listNodes()).toEqual(['both', 'uses', 'usedBy'])
    expect(rowText('both')).toContain('Both ways')
    expect(rowText('uses')).toContain('I use it')
    expect(rowText('usedBy')).toContain('Uses this computer')
    expect(rowOf('usedBy')!.querySelector('[title="It uses this computer; this one doesn’t use it"]')).toBeTruthy()
    expect(button(/Use another computer/)).toBeTruthy()
    expect(button(/Let a device in/)).toBeTruthy()
  })

  it('shows the chosen device beside the list, its routes and its access, highlighting only its row', async () => {
    daemon({ devices: [device({ node: 'n1', route: 'lan' }), device({ node: 'n2', name: 'Server', direction: 'out' })] })
    await mount()
    const pressed = (node: string) => rowOf(node)!.querySelector('button')!.getAttribute('aria-pressed')
    expect(pressed('n1')).toBe('true')
    expect(pressed('n2')).toBe('false')
    expect(host.querySelector('[aria-label="Routes to Studio"]')).toBeTruthy()
    expect(detailText()).toContain('Access from this device')
    expect(await menuItems('Studio')).toEqual(['Remove…'])

    await choose('Server')
    expect(pressed('n1')).toBe('false')
    expect(pressed('n2')).toBe('true')
    expect(detail()!.dataset.deviceDetail).toBe('n2')
    // This computer uses it one way: its routes, and no access here.
    expect(host.querySelector('[aria-label="Routes to Server"]')).toBeTruthy()
    expect(detailText()).not.toContain('Access here')
  })

  it('moves through the list with the arrow keys, one tab stop for the whole list', async () => {
    daemon({
      devices: [device({ node: 'n1' }), device({ node: 'n2', name: 'Server' }), device({ node: 'n3', name: 'Mini' })]
    })
    await mount()
    const rowButton = (node: string) => rowOf(node)!.querySelector<HTMLButtonElement>('button')!
    const key = async (target: HTMLElement, name: string) => {
      await act(async () => target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true })))
      await flush()
    }
    expect([rowButton('n1').tabIndex, rowButton('n2').tabIndex, rowButton('n3').tabIndex]).toEqual([0, -1, -1])
    rowButton('n1').focus()
    await key(rowButton('n1'), 'ArrowDown')
    expect(document.activeElement).toBe(rowButton('n2'))
    expect(detail()!.dataset.deviceDetail).toBe('n2')
    expect([rowButton('n1').tabIndex, rowButton('n2').tabIndex]).toEqual([-1, 0])
    await key(rowButton('n2'), 'End')
    expect(document.activeElement).toBe(rowButton('n3'))
    await key(rowButton('n3'), 'ArrowDown')
    expect(detail()!.dataset.deviceDetail).toBe('n3')
    await key(rowButton('n3'), 'Home')
    expect(document.activeElement).toBe(rowButton('n1'))
    expect(detail()!.dataset.deviceDetail).toBe('n1')
  })

  it('says on an unchosen row what waits on this owner, and opens on the first device that needs something', async () => {
    daemon({
      devices: [
        device({ node: 'n1' }),
        device({ node: 'n2', name: 'Server', offered: ['wss://x.example/mousse-net/1'] }),
        device({ node: 'n3', name: 'Mini', direction: 'out', olderApp: true }),
        device({ node: 'n4', name: 'Desk', direction: 'in', other: { offer: 'ask', asked: 'declined' } }),
        device({ node: 'n5', name: 'Box', direction: 'in', other: { offer: 'ask', asked: 'waiting' } })
      ]
    })
    await mount()
    expect(detail()!.dataset.deviceDetail).toBe('n2')
    const need = (node: string) => rowOf(node)!.querySelector<HTMLElement>('[data-device-needs]')
    expect(need('n1')).toBeNull()
    expect(need('n2')!.textContent).toBe('New route')
    expect(need('n2')!.title).toBe('Server offered new ways to reach it')
    expect(need('n3')!.textContent).toBe('Older Mousse')
    expect(need('n4')!.textContent).toBe('Said Not now')
    expect(need('n4')!.title).toBe('Desk said Not now')
    // Waiting on the other computer's owner is not this owner's to do.
    expect(need('n5')).toBeNull()
  })

  it('shows the level picked at Allow for a device that uses this computer one way, which the old networking calls disconnected', async () => {
    // One way, this computer never dials the device, so the old networking's node says disconnected while the
    // engine says connected (as two real computers paired this way showed).
    daemon({ devices: [device({ node: 'n1', route: 'lan', direction: 'in' })] }, {
      'bridge.nodes': () => ({
        nodes: [{
          node: 'n1', name: 'Studio', self: false, revoked: false, caps: ['read', 'chat', 'write', 'terminal', 'settings'],
          kind: 'computer', state: 'closed', source: 'engine', routes: [], connection: 'disconnected',
          policy: { blocked: false, ...accessPreset('view').fields }
        }]
      })
    })
    await mount()
    expect(detailText()).toContain('Connected · same network · Uses this computer')
    expect(detailText()).toContain('View and chat')
  })

  it('ends one direction of a pairing both ways from its menu, saying the other stays', async () => {
    const d = daemon({ features: ['grant-revoke-local'], devices: [device({ node: 'n1' })] })
    await mount()
    expect(await menuItems('Studio')).toEqual(['Stop using Studio…', 'Stop Studio using this computer…'])
    await click(button('Stop Studio using this computer…'))
    expect(document.body.textContent).toContain('Stop Studio using this computer?')
    expect(document.body.textContent).toContain('This computer still uses it.')
    await click(button('Remove'))
    expect(d.called('netEngine.remove')).toEqual([{ node: 'n1', direction: 'in' }])

    await menuItems('Studio')
    await click(button('Stop using Studio…'))
    expect(document.body.textContent).toContain('It can still use this computer.')
    await click(button('Remove'))
    expect(d.called('netEngine.remove').at(-1)).toEqual({ node: 'n1', direction: 'out' })
  })

  it('says Remove ends both directions where networking can’t end one, and removes the pairing', async () => {
    const d = daemon({ devices: [device({ node: 'n1' })] })
    await mount()
    expect(await menuItems('Studio')).toEqual(['Remove…'])
    await click(button('Remove…'))
    expect(document.body.textContent).toContain('this removes both')
    await click(button('Remove'))
    expect(d.called('netEngine.remove')).toEqual([{ node: 'n1' }])
  })

  it('removes a one-way pairing whole, and keeps the tip to remove it on the other computer too', async () => {
    const d = daemon({ features: ['grant-revoke-local'], devices: [device({ node: 'n1', direction: 'in' })] })
    await mount()
    await menuItems('Studio')
    await click(button('Remove…'))
    expect(document.body.textContent).toContain('Remove Studio?')
    expect(document.querySelector('[title="Remove it on the other computer too, or it keeps trying to connect."]')).toBeTruthy()
    await click(button('Remove'))
    expect(d.called('netEngine.remove')).toEqual([{ node: 'n1' }])
  })

  it('says when a computer used one way runs an older Mousse', async () => {
    daemon({ devices: [device({ node: 'n1', direction: 'out', olderApp: true })] })
    await mount()
    expect(detailText()).toContain('Studio runs an older Mousse')
    expect(detailText()).toContain('Update it, or connect again with “Also let” ticked.')
  })

  it('says that an older Mousse let in is used from here only once added from here', async () => {
    daemon({ devices: [device({ node: 'n1', direction: 'in', olderApp: true })] })
    await mount()
    expect(detailText()).toContain('Studio runs an older Mousse')
    expect(detailText()).toContain('To use it from here, add it from this computer.')
    expect(rowText('n1')).toContain('Uses this computer')
  })

  it('shows its routes, the one in use first, adds a Tailscale fallback that the add allows, and removes a route', async () => {
    const d = daemon({
      features: ['grant-revoke-local'],
      devices: [device({ node: 'n1', route: 'lan', online: true, addresses: ['tcp://192.168.1.20:47100', 'wss://studio.example.com/mousse-net/1'] })]
    })
    await mount()
    const routes = () =>
      [...host.querySelectorAll<HTMLElement>('[aria-label="Routes to Studio"] [data-route-state]')].map((row) =>
        (row.textContent ?? '').replace(/\s+/g, ' ').trim()
      )
    expect(routes()[0]).toMatch(/^Same network\s*192\.168\.1\.20:47100 · In use/)
    expect(routes()).toContainEqual(expect.stringMatching(/^Tunnel\s*studio\.example\.com · Available/))

    await click(button('Add route'))
    expect(button('Tailscale')!.getAttribute('aria-checked')).toBe('true')
    await type(document.querySelector<HTMLInputElement>('input[aria-label="Tailscale address"]')!, '100.101.7.9')
    expect(button('Add')!.title).toBe('Adding it allows it.')
    await click(button('Add'))
    // The port comes from the address it already has; the owner's add is the route's approval.
    expect(d.called('netEngine.address.add')).toEqual([{ node: 'n1', address: '100.101.7.9:47100' }])

    await click(button('Actions for Tunnel studio.example.com'))
    await click(button('Remove route'))
    expect(d.called('netEngine.address.remove')).toEqual([{ node: 'n1', address: 'wss://studio.example.com/mousse-net/1' }])

    await menuItems('Studio')
    await click(button('Stop using Studio…'))
    await click(button('Remove'))
    expect(d.called('netEngine.remove')).toEqual([{ node: 'n1', direction: 'out' }])
  })

  it('lists the same network on a computer used one way, and the ticket hints approved at Connect as fallbacks', async () => {
    daemon({
      devices: [
        device({
          node: 'n1',
          direction: 'out',
          route: 'tailnet',
          approvedAddresses: ['tcp://100.101.7.9:47100', 'wss://studio.example.com/mousse-net/1']
        })
      ]
    })
    await mount()
    const routes = [...host.querySelectorAll<HTMLElement>('[aria-label="Routes to Studio"] [data-route-state]')].map(
      (row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
    expect(routes[0]).toMatch(/^Tailscale\s*100\.101\.7\.9:47100 · In use/)
    expect(routes).toContainEqual(expect.stringMatching(/^Same network\s*Found automatically · Available/))
    expect(routes).toContainEqual(expect.stringMatching(/^Tunnel\s*studio\.example\.com · Available/))
    // Approved at Connect, not added here: nothing to remove on the row.
    expect(button('Actions for Tunnel studio.example.com')).toBeUndefined()
  })

  it('lists the same network ahead of SSH on a computer added over SSH', async () => {
    daemon({ devices: [device({ node: 'n1', direction: 'out', route: 'ssh', source: 'ssh', ssh: 'me@box.example' })] })
    await mount()
    const routes = [...host.querySelectorAll<HTMLElement>('[aria-label="Routes to Studio"] [data-route-state]')].map(
      (row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
    expect(routes[0]).toMatch(/^SSH\s*me@box\.example · In use/)
    expect(routes).toContainEqual(expect.stringMatching(/^Same network\s*Found automatically · Available/))
  })

  it('lists the same network once when it has a same-network address', async () => {
    daemon({
      devices: [device({ node: 'n1', direction: 'out', route: 'lan', approvedAddresses: ['tcp://192.168.1.20:47100'] })]
    })
    await mount()
    const routes = [...host.querySelectorAll<HTMLElement>('[aria-label="Routes to Studio"] [data-route-state]')].map(
      (row) => (row.textContent ?? '').replace(/\s+/g, ' ').trim()
    )
    expect(routes.filter((route) => route.startsWith('Same network'))).toEqual([
      expect.stringMatching(/^Same network\s*192\.168\.1\.20:47100 · In use/)
    ])
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

/** A Use another computer dialog, on its Scan step. */
const scanDialog = async (status: NetEngineStatus, camera: () => Promise<MediaStream | undefined> = async () => undefined) => {
  const onClose = vi.fn()
  await mount(createElement(UseComputerDialog, { status, onClose, camera }))
  await click(button('Scan its code'))
  return onClose
}
const pasteLink = async (link = 'mousse://pair?n=Studio#AAAAAAAAAAAAAAAAAAAAAAAA') => {
  await type(document.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]')!, link)
  await click(button('Continue'))
}
const ALSO_LET = (name: string) =>
  [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
    box.closest('label')?.textContent?.includes(`Also let ${name} use this computer`)
  )

describe('Let a device in', () => {
  const ways = {
    ways: [
      { way: 'tunnel', state: 'unavailable', reason: 'not_configured', routes: [] },
      { way: 'tailnet', state: 'off', reason: 'disabled', routes: [] },
      { way: 'lan', state: 'ready', routes: ['tcp://192.168.1.20:47100'] }
    ]
  }

  it('offers Turn on for a way whose switch is off while the helper still listens on it, and only then', async () => {
    // As a real helper answered with Tailscale's switch saved off: restart_required, cleared by turning it on.
    const restart = { ways: [{ way: 'lan', state: 'ready', routes: ['tcp://192.168.1.20:47100'] }, { way: 'tailnet', state: 'unavailable', reason: 'restart_required', routes: [] }] }
    for (const tailnet of [false, true]) {
      const d = daemon(
        { features: ['route-readiness', 'invite-way'], reach: { lan: true, tailnet, public: [], tunnels: [] } as unknown as NetEngineStatus['reach'] },
        { 'netEngine.routes.available': () => restart, 'netEngine.routes.config': () => ({}) }
      )
      await mount()
      await click(button(/Let a device in/))
      expect(document.body.textContent).toContain('Needs networking restarted')
      if (tailnet) expect(button('Turn on')).toBeFalsy()
      else {
        await click(button('Turn on'))
        expect(d.called('netEngine.routes.config')).toEqual([{ tailnet: true }])
      }
      act(() => root.unmount())
      document.body.innerHTML = ''
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
  })

  it('lists the ways with readiness in plain words, turns one on, and makes a code for the way picked', async () => {
    const d = daemon(
      { features: ['route-readiness', 'invite-way'] },
      { 'netEngine.routes.available': () => ways, 'netEngine.routes.config': () => ({}) }
    )
    await mount()
    await click(button(/Let a device in/))
    expect(document.body.textContent).toContain('Use this computer from your phone or another computer')
    expect(document.body.textContent).toContain('How will it connect?')
    const choice = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((row) => row.textContent?.startsWith(label))
    // Nearest first; the ready one is picked, with a background, and the others say why.
    expect([...document.querySelectorAll<HTMLElement>('[role="radio"] .engine-choice-label')].map((item) => item.textContent)).toEqual([
      'Same Wi-Fi',
      'Tailscale',
      'Cloudflare Tunnel'
    ])
    expect(choice('Same Wi-Fi')!.getAttribute('aria-checked')).toBe('true')
    expect(choice('Same Wi-Fi')!.classList.contains('selected')).toBe(true)
    // Its name, and under it the success dot before its status.
    const ready = choice('Same Wi-Fi')!.querySelector('.engine-choice-hint')!
    expect(ready.textContent).toBe('Ready')
    expect(ready.firstElementChild?.classList.contains('engine-ready-dot')).toBe(true)
    expect(choice('Tailscale')!.querySelector('.engine-ready-dot')).toBeNull()
    expect(choice('Tailscale')!.textContent).toContain('Off')
    expect(choice('Tailscale')!.getAttribute('aria-disabled')).toBe('true')
    expect(choice('Cloudflare')!.textContent).toContain('Not set up')
    expect(button('Set up')).toBeTruthy()
    // Nothing is made before Make code.
    expect(d.called('netEngine.invite')).toEqual([])
    await click(button('Turn on'))
    expect(d.called('netEngine.routes.config')).toEqual([{ tailnet: true }])

    expect(button('Make code')!.classList.contains('ui-btn-primary')).toBe(true)
    await click(button('Make code'))
    expect(d.called('netEngine.invite')).toEqual([{ way: 'lan' }])
    expect(document.querySelector('[aria-label="Pairing QR code"]')).toBeTruthy()
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Link to share"]')?.value).toContain('mousse://pair')
    expect(button('Copy link')).toBeTruthy()
    expect(document.querySelector('[role="timer"]')?.textContent).toMatch(
      /^Works over Same Wi-Fi · used once · expires in [45]:\d\d$/
    )
    expect(document.body.textContent).toContain(
      'Can you SSH into this computer? Add it from the other computer instead. No code needed.'
    )
  })

  it('makes a code at once, and says so, where networking can’t pick the way', async () => {
    const d = daemon()
    await mount()
    await click(button(/Let a device in/))
    expect(d.called('netEngine.routes.available')).toEqual([])
    expect(d.called('netEngine.invite')).toEqual([{}])
    expect(document.querySelector('[role="timer"]')?.textContent).toMatch(/^used once · expires in [45]:\d\d$/)
    expect(document.body.textContent).toContain('Update networking to pick how it connects.')
  })

  it('opened while networking starts, waits for the ways and shows the picker, making no code', async () => {
    // A starting helper has not said what it offers yet.
    const d = daemon({ helper: { state: 'starting' } }, { 'netEngine.routes.available': () => ways })
    await mount()
    await click(button(/Let a device in/))
    expect(d.called('netEngine.invite')).toEqual([])
    await d.change({ helper: { state: 'running' }, features: ['route-readiness', 'invite-way'] })
    expect(document.body.textContent).toContain('How will it connect?')
    expect(radio('Same Wi-Fi')!.getAttribute('aria-checked')).toBe('true')
    expect(d.called('netEngine.invite')).toEqual([])
  })

  it('asks Allow with Work on threads picked, sends the level with Allow, and says it can use this computer', async () => {
    const d = daemon()
    await mount()
    await click(button(/Let a device in/))
    expect(document.body.textContent).toContain('Can you SSH into this computer?')
    await d.change({ approvals: [{ request: 'r1', invitation: 'inv1', name: 'Laptop (Work)', device: 'ffee0011' }] })
    expect(document.body.textContent).toContain('Let Laptop (Work) use this computer?')
    // Only the question: no SSH hint, no other way to send a code, and no id nothing else shows.
    expect(document.body.textContent).not.toContain('Can you SSH into this computer?')
    expect(button('Send a link with a code instead')).toBeUndefined()
    expect(document.body.textContent).not.toContain('ffee0011')
    const picked = document.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Access"] [aria-checked="true"]')
    expect(picked?.querySelector('.engine-choice-label')?.textContent).toBe('Work on threads')
    expect(picked?.querySelector('.engine-choice-hint')?.textContent).toBe('Works on threads · no shell')
    expect(button('Allow')!.classList.contains('ui-btn-primary')).toBe(true)
    expect(button('Not now')!.classList.contains('ui-btn-primary')).toBe(false)
    await click(radio('Full control'))
    await click(button('Allow'))
    expect(d.called('netEngine.approve')).toEqual([{ request: 'r1', yes: true, access: accessPreset('full').fields }])

    await d.change({ approvals: [], devices: [device({ node: 'n3', name: 'Laptop (Work)', direction: 'in', state: 'offline', online: false })] })
    expect(document.body.textContent).toContain('Laptop (Work) can use this computer.')
  })

  it('opens the single switches under Customize, and Not now refuses with no level', async () => {
    const d = daemon()
    await mount()
    await click(button(/Let a device in/))
    await d.change({ approvals: [{ request: 'r1', invitation: 'inv1', name: 'Laptop', device: 'ffee0011' }] })
    await click(button('Customize'))
    await click(document.querySelector<HTMLElement>('[role="switch"][aria-label="Terminals"]') ?? undefined)
    expect(document.querySelector('[role="radiogroup"][aria-label="Access"] [aria-checked="true"]')).toBeNull()
    await click(button('Not now'))
    expect(d.called('netEngine.approve')).toEqual([{ request: 'r1', yes: false }])
  })

  it('sets the bot level under Customize: down from Full control to Use, and back to Full control by hand', async () => {
    const d = daemon()
    await mount()
    await click(button(/Let a device in/))
    await d.change({ approvals: [{ request: 'r1', invitation: 'inv1', name: 'Laptop', device: 'ffee0011' }] })
    const picked = () => document.querySelector('[role="radiogroup"][aria-label="Access"] [aria-checked="true"] .engine-choice-label')?.textContent
    const bots = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="group"][aria-label="Customize"] [role="radiogroup"][aria-label="Bots"] [role="radio"]')].find((item) => item.textContent === label)
    await click(radio('Full control'))
    await click(button('Customize'))
    expect(bots('Full')?.getAttribute('aria-checked')).toBe('true')
    await click(bots('Use'))
    expect(picked()).toBeUndefined()
    // Every other switch at Full control and the bot level at Full again: Full control is picked.
    await click(bots('Full'))
    expect(picked()).toBe('Full control')
    await click(bots('Use'))
    await click(button('Allow'))
    expect(d.called('netEngine.approve')).toEqual([{ request: 'r1', yes: true, access: { ...accessPreset('full').fields, bots: 'use' } }])
  })

  it('matches Full control from Work on threads by turning every switch on and the bot level to Full', async () => {
    const d = daemon()
    await mount()
    await click(button(/Let a device in/))
    await d.change({ approvals: [{ request: 'r1', invitation: 'inv1', name: 'Laptop', device: 'ffee0011' }] })
    await click(button('Customize'))
    for (const name of ['Terminals', 'Editor connections', 'Full access mode', 'Agents change all threads'])
      await click(document.querySelector<HTMLElement>(`[role="switch"][aria-label="${name}"]`) ?? undefined)
    const label = () => document.querySelector('[role="radiogroup"][aria-label="Access"] [aria-checked="true"] .engine-choice-label')?.textContent
    expect(label()).toBeUndefined()
    await click([...document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Bots"] [role="radio"]')].find((item) => item.textContent === 'Full'))
    expect(label()).toBe('Full control')
  })

  it('ends the invitation when the dialog closes before anyone joined', async () => {
    const d = daemon()
    await mount()
    await click(button(/Let a device in/))
    await click(button('Close'))
    expect(d.called('netEngine.invite.cancel')).toEqual([{ invitation: 'inv1' }])
  })
})

describe('Use another computer', () => {
  const lanHint = { route: 'tcp://192.168.1.20:47100', way: 'lan', eligibility: 'automatic', local: 'interface_present' }
  const checked = (probe: unknown, hints: unknown[] = [lanHint]) => ({
    'netEngine.join.preview': () => ({ kind: 1, name: 'Studio', destinations: [], shareable: [] }),
    'netEngine.join.check': () => ({ kind: 1, name: 'Studio', hints }),
    'netEngine.join.probe': () => probe
  })

  it('offers its link, its code and SSH, and joins one way unless "Also let" is ticked', async () => {
    const d = daemon({ reach: { lan: true, tailnet: false, public: [], tunnels: [] } })
    const onClose = vi.fn()
    await mount(createElement(UseComputerDialog, { status: d.state.status, onClose }))
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Pairing link"]')?.placeholder).toBe('Paste its link')
    expect(button('Continue')!.classList.contains('ui-btn-primary')).toBe(true)
    // The other two ways side by side under the link field, as secondary buttons.
    const others = [...document.querySelectorAll<HTMLButtonElement>('.engine-dialog-alt > button')]
    expect(others.map((item) => item.textContent)).toEqual(['Scan its code', 'Connect over SSH'])
    expect(others.some((item) => item.classList.contains('ui-btn-primary'))).toBe(false)
    const link = 'mousse://pair?n=Studio%20Mac#AAAAAAAAAAAAAAAAAAAAAAAA'
    await pasteLink(link)
    expect(document.body.textContent).toContain('Use Studio Mac from here')
    expect(ALSO_LET('Studio Mac')!.checked).toBe(false)
    expect(d.called('netEngine.join')).toEqual([])
    await click(button('Connect'))
    expect(d.called('netEngine.join')).toEqual([{ ticket: link, back: false }])
    expect(onClose).toHaveBeenCalled()
  })

  it('says it can be reached only when the check from here answered, and which way it connects', async () => {
    const d = daemon({ features: ['route-readiness', 'join-probe'] }, checked({ reachable: true, route: 'tcp://192.168.1.20:47100' }))
    await scanDialog(d.state.status)
    await pasteLink()
    expect(d.called('netEngine.join.check')).toHaveLength(1)
    expect(d.called('netEngine.join.probe')).toHaveLength(1)
    expect(document.body.textContent).toContain('Connects over Same Wi-Fi')
    expect(document.body.textContent).toContain('Studio can be reached from this computer')
    // A tick before it; the address it answered on in the tooltip of "Connects over".
    const reached = [...document.querySelectorAll<HTMLElement>('.engine-check-line')].find((line) =>
      line.textContent?.includes('can be reached')
    )!
    expect(reached.firstElementChild?.classList.contains('engine-check-icon')).toBe(true)
    expect(reached.firstElementChild?.classList.contains('ok')).toBe(true)
    expect(reached.getAttribute('title')).toBeNull()
    const over = [...document.querySelectorAll<HTMLElement>('p')].find((line) => line.textContent === 'Connects over Same Wi-Fi')
    expect(over?.getAttribute('title')).toBe('tcp://192.168.1.20:47100')
    expect(button('Connect')!.disabled).toBe(false)
    expect(button('Connect')!.classList.contains('ui-btn-primary')).toBe(true)
  })

  it('says a neutral line when the check couldn’t tell', async () => {
    const d = daemon({ features: ['route-readiness', 'join-probe'] }, checked({ reachable: null, reason: 'timeout' }))
    await scanDialog(d.state.status)
    await pasteLink()
    expect(document.body.textContent).not.toContain('can be reached')
    expect(document.body.textContent).toContain('Couldn’t check from here. Connect still tries.')
    expect(button('Connect')!.disabled).toBe(false)
  })

  it('says why it can’t work and what to do, with Check again, before anything is sent', async () => {
    const d = daemon({ features: ['route-readiness', 'join-probe'] }, checked({ reachable: false, reason: 'refused' }))
    await scanDialog(d.state.status)
    await pasteLink()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('Studio didn’t answer over Same Wi-Fi.')
    // A warning icon before the failure.
    expect(document.querySelector('[role="alert"] > .engine-check-icon.warn')).toBeTruthy()
    expect(document.body.textContent).toContain('Check both are on the same Wi-Fi and Mousse is open on Studio.')
    expect(button('Connect')!.disabled).toBe(true)
    await click(button('Check again'))
    expect(d.called('netEngine.join.check')).toHaveLength(2)
    expect(d.called('netEngine.join')).toEqual([])
  })

  it('doesn’t try a link this computer has no way to use', async () => {
    const tailnetOnly = { route: 'tcp://100.101.7.2:47100', way: 'tailnet', eligibility: 'skip', local: 'no_matching_interface' }
    const d = daemon({ features: ['route-readiness', 'join-probe'] }, checked({ reachable: true, route: 'x' }, [tailnetOnly]))
    await scanDialog(d.state.status)
    await pasteLink()
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('This computer isn’t on Tailscale.')
    expect(d.called('netEngine.join.probe')).toEqual([])
    expect(button('Connect')!.disabled).toBe(true)
  })

  it('reads camera frames as often as the daemon says (the engine limit scanIntervalMs)', async () => {
    const d = daemon({ scanIntervalMs: 75 })
    const every = vi.spyOn(globalThis, 'setInterval')
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    const stream = { getTracks: () => [] } as unknown as MediaStream
    try {
      await scanDialog(d.state.status, async () => stream)
      await act(async () => undefined)
      expect(every.mock.calls.map(([, ms]) => ms)).toContain(75)
    } finally {
      vi.restoreAllMocks()
    }
  })

  it('without a camera, says to scan from the other computer instead', async () => {
    const d = daemon()
    await scanDialog(d.state.status)
    expect(document.body.textContent).toContain('Scan from the other computer instead.')
  })
})

describe('routes (1b §1.3, §1.5)', () => {
  const tailnet = (host: string) => ({ route: `tcp://${host}:47100`, label: `${host}:47100`, cls: 'tailnet' as const })

  it('lists the ticket destinations, says how it reaches this computer once "Also let" is ticked, and offers other ways unticked', async () => {
    const publicRoute = { route: 'tcp://203.0.113.7:7443', label: '203.0.113.7:7443', cls: 'public' as const }
    const d = daemon({}, {
      'netEngine.join.preview': () => ({
        kind: 1,
        destinations: [{ ...tailnet('100.101.7.2'), automatic: false }],
        sameWay: [tailnet('100.101.7.9')],
        shareable: [publicRoute]
      })
    })
    await scanDialog(d.state.status)
    const link = 'mousse://pair?n=Studio#AAAAAAAAAAAAAAAAAAAAAAAA'
    await pasteLink(link)
    expect(document.body.textContent).toContain('100.101.7.2:47100 (Tailscale)')
    // One way: nothing of this computer's is shared.
    expect(document.body.textContent).not.toContain('reaches this computer')
    expect(document.body.textContent).not.toContain('Other ways to reach this computer')
    await click(ALSO_LET('Studio'))
    // Both ways: it reaches this computer the way this one reaches it, with no box to tick.
    expect(document.body.textContent).toContain('Studio reaches this computer the same way: Tailscale 100.101.7.9:47100')
    const box = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
      (item) => item.closest('label')?.textContent === 'Internet 203.0.113.7:7443'
    )!
    expect(box.checked).toBe(false)

    await click(button('Connect'))
    expect(d.called('netEngine.join').at(-1)).toEqual({ ticket: link, back: true })
  })

  it('sends a ticked route in the join', async () => {
    const d = daemon({}, {
      'netEngine.join.preview': () => ({ kind: 1, destinations: [], shareable: [tailnet('100.101.7.9')] }),
      'netEngine.join': () => {
        throw new Error('stop here')
      }
    })
    await scanDialog(d.state.status)
    await pasteLink()
    await click(ALSO_LET('Studio'))
    await click(
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find(
        (item) => item.closest('label')?.textContent === 'Tailscale 100.101.7.9:47100'
      )
    )
    await click(button('Connect'))
    expect(d.called('netEngine.join').at(-1)).toMatchObject({ back: true, share: ['tcp://100.101.7.9:47100'] })
  })

  it('names the class a device is connected on, and offers its offered addresses with Use', async () => {
    const d = daemon({
      devices: [device({ node: 'n1', route: 'tailnet', offered: ['wss://x.example/mousse-net/1'] })]
    })
    await mount()
    expect(detailText()).toContain('Connected · via Tailscale')
    expect(host.textContent).toContain('Studio offered new ways to reach it')
    expect([...host.querySelectorAll<HTMLElement>('[title]')].some((item) => item.title.includes('x.example'))).toBe(true)
    await click(button('Use'))
    expect(d.called('netEngine.address.use')).toEqual([{ node: 'n1' }])
  })

  it('sets up Cloudflare Tunnel from its way in Let a device in, and makes a code for it only once it runs', async () => {
    const lan = { way: 'lan', state: 'ready', routes: ['tcp://192.168.1.20:47100'] }
    let tunnel: Record<string, unknown> = { way: 'tunnel', state: 'unavailable', reason: 'not_configured', routes: [] }
    const d = daemon(
      {
        features: ['route-readiness', 'invite-way', 'managed-tunnel'],
        reach: { lan: true, tailnet: false, public: [], tunnels: [], wsPort: 47101 },
        sendLink: true,
        cloudflare: { state: 'off' }
      },
      { 'netEngine.routes.available': () => ({ ways: [lan, tunnel] }) }
    )
    await mount()
    await click(button(/Let a device in/))
    await click(radio('Cloudflare Tunnel')!.querySelector<HTMLButtonElement>('button')!)
    // The setup is a step of the dialog: the tunnel on the owner's own domain is picked.
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Cloudflare Tunnel')
    expect(radio('Set one up')!.getAttribute('aria-checked')).toBe('true')
    expect(button('Make code')).toBeUndefined()
    await click(button('Sign in to Cloudflare'))
    expect(d.called('netEngine.cloudflare.connect')).toEqual([{}])

    for (const state of ['preparing', 'sign_in', 'connecting'] as const) {
      await d.change({ cloudflare: { state } })
      expect(button('Make code')).toBeUndefined()
      if (state === 'sign_in') {
        // Closed mid-way, Reach this computer opens the same step again.
        await click(button('Close'))
        await click(button('Continue setup'))
        expect(radio('Set one up')).toBeTruthy()
        expect(button('Cancel')).toBeTruthy()
      }
    }
    expect(d.called('netEngine.invite')).toEqual([])

    // The tunnel is published: the helper reports the tunnel way ready.
    tunnel = { way: 'tunnel', state: 'ready', routes: ['wss://mousse.example.net/mousse-net/1'] }
    await d.change({ cloudflare: { state: 'connected', hostname: 'mousse.example.net' } })
    expect(document.body.textContent).toContain('mousse.example.net is running')
    await click(button('Make code'))
    expect(d.called('netEngine.invite')).toEqual([{ way: 'tunnel' }])
    expect(document.querySelector('[role="timer"]')?.textContent).toMatch(/^Works over Cloudflare Tunnel · /)
    // A link instead carries the same way alone.
    await click(button('Send a link with a code instead'))
    await click(button('Make link'))
    expect(d.called('netEngine.invite').at(-1)).toMatchObject({ kind: 'link', way: 'tunnel' })
  })

  it('makes no code for a running tunnel the helper does not report ready, and says why', async () => {
    const d = daemon(
      {
        features: ['route-readiness', 'invite-way', 'managed-tunnel'],
        reach: { lan: true, tailnet: false, public: [], tunnels: [], wsPort: 47101 },
        cloudflare: { state: 'connected', hostname: 'mousse.example.net' }
      },
      {
        'netEngine.routes.available': () => ({
          ways: [{ way: 'tunnel', state: 'unavailable', reason: 'origin_unavailable', routes: [] }]
        })
      }
    )
    await mount()
    await click(button(/Let a device in/))
    await click(radio('Cloudflare Tunnel')!.querySelector<HTMLButtonElement>('button')!)
    expect(document.body.textContent).toContain('mousse.example.net · Tunnel isn’t answering')
    expect(button('Make code')!.disabled).toBe(true)
    expect(d.called('netEngine.invite')).toEqual([])
  })

  it('sends a person with their own tunnel to Reach this computer for its address', async () => {
    const d = daemon(
      {
        features: ['route-readiness', 'invite-way', 'managed-tunnel'],
        reach: { lan: true, tailnet: false, public: [], tunnels: [], wsPort: 47101 },
        cloudflare: { state: 'off' }
      },
      {
        'netEngine.routes.available': () => ({
          ways: [{ way: 'tunnel', state: 'unavailable', reason: 'not_configured', routes: [] }]
        })
      }
    )
    await mount()
    await click(button(/Let a device in/))
    await click(radio('Cloudflare Tunnel')!.querySelector<HTMLButtonElement>('button')!)
    await click(radio('Use my own tunnel'))
    await click(button('Paste address'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(d.called('netEngine.cloudflare.connect')).toEqual([])
  })

  it('asks before forgetting a Cloudflare connection', async () => {
    const d = daemon({
      reach: { lan: false, tailnet: false, public: [], tunnels: [], wsPort: 47101 },
      cloudflare: { state: 'failed', canForget: true }
    })
    await mount()
    await click(button('Set up'))
    await click(button('Forget connection…'))
    expect(d.called('netEngine.cloudflare.forget')).toEqual([])
    await click(button('Forget connection'))
    expect(d.called('netEngine.cloudflare.forget')).toEqual([{}])
  })

  it('copies the local tunnel origin before saving a URL and sends a pairing link over it after setup', async () => {
    const reach = { lan: false, tailnet: false, public: [], tunnels: [], wsPort: 47101 }
    const d = daemon({ reach, sendLink: true, features: ['invite-way'] })
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    try {
      await mount()
      const moreWays = [...host.querySelectorAll('summary')].find((item) =>
        item.textContent?.includes('More ways')
      )
      await click(moreWays)
      await click(button('Copy local origin'))
      expect(writeText).toHaveBeenCalledWith('http://127.0.0.1:47101')
      expect(d.called('netEngine.routes.config')).toEqual([])
      expect(button('Send pairing link')).toBeUndefined()

      await d.change({ reach: { ...reach, tunnels: ['wss://x.example/mousse-net/1'] } })
      await click(button('Send pairing link'))
      await click(button('Make link'))
      expect(d.called('netEngine.invite')).toEqual([expect.objectContaining({ kind: 'link', way: 'tunnel' })])
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
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
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Tunnel address"]')!.value).toBe('https://x.example')
    // Port forward and the tunnel sit under More ways; nothing asks for a command.
    expect(host.querySelector('details.settings-advanced input[aria-label="Tunnel address"]')).toBeTruthy()
    expect(host.textContent).not.toMatch(/cloudflared|tailscale funnel/)
    await click(host.querySelector<HTMLElement>('[role="switch"][aria-label="Tailscale"]') ?? undefined)
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
    // Cancel goes to the helper; while it ends, the row says so and offers no second Cancel.
    await click(button('Cancel'))
    expect(d.called('netEngine.relay.rotate').at(-1)).toEqual({ relay: 'aa11', cancel: true })
    await d.change({ relays: { available: true, list: [relay({ newKeyPending: true, cancelling: true })] } })
    expect(relayRow('relay.example.net:443')?.textContent).toContain('Cancelling…')
    expect(relayRow('relay.example.net:443')?.textContent).not.toContain('New key pending')
    expect(button('Cancel')).toBeUndefined()
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

  it('holds New relay key back while the key chain is full, until the time the helper names', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    try {
      daemon({ relays: { available: true, list: [relay({ chainFull: true, chainFullUntil: Date.now() + 60_000 })] } })
      await act(async () => root.render(createElement(EngineDevicesSection)))
      for (let i = 0; i < 6; i++) await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(relayRow('relay.example.net:443')?.textContent).toContain('Too many key changes. Try again after ')
      expect(button('New relay key')?.disabled).toBe(true)
      await act(async () => { await vi.advanceTimersByTimeAsync(60_100) })
      expect(relayRow('relay.example.net:443')?.textContent).not.toContain('Too many key changes')
      expect(button('New relay key')?.disabled).toBe(false)
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
    expect(detailText()).toContain('Connected · through relay relay.example.net:443')
  })

  it('asks once in its detail before dialling an offered relay, and Allow goes to the daemon', async () => {
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

  it('takes an allowed relay back from its menu', async () => {
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
    expect(detailText()).not.toContain('Relay info')
    await d.change({ devices: [device({ node: 'n1', relay: { stale: true } })] })
    const note = [...detail()!.querySelectorAll<HTMLElement>('[title]')].find(
      (item) => item.textContent === 'Relay info out of date'
    )
    expect(note?.title).toMatch(/tried last/)
  })

  it('says a device past the limit is not reachable through the relay, with the limit the helper names', async () => {
    const d = daemon({
      devices: [device({ node: 'n1', relay: { limit: { callersMax: 128 } } }), device({ node: 'n2', name: 'Laptop' })]
    })
    await mount()
    expect(detailText()).toContain('Not reachable through the relay (limit 128)')
    await choose('Laptop')
    expect(detailText()).not.toContain('Not reachable')
    await d.change({ devices: [device({ node: 'n1', relay: { limit: {} } })] })
    expect(detailText()).toContain('Not reachable through the relay (over its limit)')
  })

  it('lists a ticket’s relay among the destinations as the relay it goes through', async () => {
    const d = daemon({}, {
      'netEngine.join.preview': () => ({
        kind: 1,
        destinations: [{ route: `relay://relay.example.net:443/${'A'.repeat(43)}/${'B'.repeat(43)}`, label: 'relay.example.net:443', cls: 'relay', automatic: false, destination: DESTINATION }],
        shareable: []
      })
    })
    await scanDialog(d.state.status)
    await pasteLink()
    expect(document.body.textContent).toContain('Through relay relay.example.net:443')
  })
})

describe('Connect over SSH (1b §3.4)', () => {
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
    await mount(createElement(UseComputerDialog, { status: d.state.status, onClose }))
    await click(button('Connect over SSH'))
    expect(document.body.textContent).toContain('Uses your SSH keys or agent, never a password.')
    expect(document.querySelector<HTMLInputElement>('input[aria-label="SSH address"]')?.placeholder).toBe('Host or SSH config alias')
    await type(document.querySelector<HTMLInputElement>('input[aria-label="SSH address"]')!, 'me@box.example')
    await click(button('Continue'))
    expect(document.body.textContent).toContain('ssh-ed25519 SHA256:abc')
    expect(d.called('netEngine.ssh.profiles')).toEqual([])
    await click(button('Trust and continue'))
    expect(d.called('netEngine.ssh.trust')).toEqual([{ routeId: 'r1', sha256: 'SHA256:abc', host: 'box.example' }])
    expect(document.body.textContent).toContain('Profile on Box')
    // The same row list as the levels, not native radio buttons.
    expect(document.querySelector('input[type="radio"]')).toBeNull()
    const labels = [...document.querySelectorAll('[role="radio"] .engine-choice-label')].map((item) => item.textContent)
    expect(labels).toEqual(['Main', 'Work', 'New profile…'])
    // What Connect does: Box lets this computer in, nothing the other way, no port, all over SSH.
    const effects = [...document.querySelectorAll('[aria-label="What Connect does"] li')].map((item) => item.textContent)
    expect(effects).toEqual([
      'Box lets this computer in. Nothing the other way.',
      'Box opens no port.',
      'Every connection goes through SSH.'
    ])
    await click(radio('Work'))
    await click(button('Connect'))
    expect(d.called('netEngine.ssh.connect')).toEqual([
      { routeId: 'r1', target: 'me@box.example', host: 'box.example', user: 'me', selector: 'b'.repeat(26) }
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it('keeps a failed Connect’s error shown and signs in to list profiles only once', async () => {
    const d = daemon(
      { reach: { lan: true, tailnet: false, public: [], tunnels: [] } },
      {
        'netEngine.ssh.resolve': () => ({ ...resolved, pinned: true }),
        'netEngine.ssh.profiles': () => ({
          computer: 'Box',
          os: 'macos',
          profiles: [{ selector: 'a'.repeat(26), label: 'Main', networking: true }]
        }),
        'netEngine.ssh.connect': () => {
          throw new Error('Mousse isn’t running for me on box.example.')
        }
      }
    )
    await mount(createElement(UseComputerDialog, { status: d.state.status, onClose: () => undefined }))
    await click(button('Connect over SSH'))
    await type(document.querySelector<HTMLInputElement>('input[aria-label="SSH address"]')!, 'me@box.example')
    await click(button('Continue'))
    await click(button('Connect'))
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('isn’t running')
    expect(button('Connect')).toBeDefined()
    expect(d.called('netEngine.ssh.profiles')).toHaveLength(1)
  })

  it('offers Connect over SSH only when the helper speaks protocol 1.1', async () => {
    const d = daemon()
    await mount(createElement(UseComputerDialog, { status: d.state.status, onClose: () => undefined }))
    expect(button('Connect over SSH')).toBeUndefined()
  })
})

describe('the other direction of a one-way pairing', () => {
  const menuItem = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
      item.textContent?.startsWith(label)
    )

  it('asks from a device that uses this computer, and shows Waiting with a spinner and Cancel', async () => {
    const d = daemon({ devices: [device({ node: 'n1', direction: 'in', other: { offer: 'ask' } })] })
    await mount()
    expect(await menuItems('Studio')).toEqual(['Use Studio from here…', 'Remove…'])
    await click(menuItem('Use Studio from here…'))
    expect(d.called('netEngine.access.ask')).toEqual([{ node: 'n1' }])

    await d.change({ devices: [device({ node: 'n1', direction: 'in', other: { offer: 'ask', asked: 'waiting' } })] })
    expect(host.textContent).toContain('Waiting for Studio to allow this…')
    expect(host.querySelector('.ui-loader[role="status"]')).toBeTruthy()
    await menuItems('Studio')
    expect(menuItem('Use Studio from here…')!.getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('Use Studio from here…')!.textContent).toContain('Waiting for an answer.')
    await click(button('Cancel'))
    expect(d.called('netEngine.access.cancel')).toEqual([{ node: 'n1' }])
  })

  it.each([
    ['declined', 'Studio said Not now'],
    ['expired', 'No answer from Studio']
  ] as const)('says when the request was %s, with no spinner', async (asked, line) => {
    const d = daemon({ devices: [device({ node: 'n1', direction: 'in', other: { offer: 'ask', asked } })] })
    await mount()
    expect(host.textContent).toContain(line)
    expect(host.querySelector('.ui-loader[role="status"]')).toBeNull()
    await click(button('Dismiss'))
    expect(d.called('netEngine.access.cancel')).toEqual([{ node: 'n1' }])
  })

  it('offers it disabled, saying why, while not connected, and not at all where the pairing can’t', async () => {
    daemon({
      devices: [
        device({ node: 'n1', direction: 'in', other: { offer: 'ask', blocked: 'Not connected right now.' } }),
        device({ node: 'n2', name: 'Server', direction: 'in' })
      ]
    })
    await mount()
    await menuItems('Studio')
    expect(menuItem('Use Studio from here…')!.getAttribute('aria-disabled')).toBe('true')
    expect(menuItem('Use Studio from here…')!.textContent).toContain('Not connected right now.')
    // Its menu closes; the other device's opens.
    await menuItems('Studio')
    expect(await menuItems('Server')).toEqual(['Remove…'])
  })

  it('lets a computer this one uses in from its menu: the Allow prompt with how it connects, and the level picked', async () => {
    const d = daemon({ devices: [device({ node: 'n1', direction: 'out', route: 'lan', other: { offer: 'let' } })] })
    await mount()
    expect((await menuItems('Studio'))[0]).toBe('Let Studio use this computer…')
    await click(menuItem('Let Studio use this computer…'))
    expect(document.body.textContent).toContain('Let Studio use this computer?')
    expect(document.body.textContent).toContain('Connects over Same Wi-Fi, already in use.')
    await click(radio('Full control'))
    await click(button('Allow'))
    expect(d.called('netEngine.access.let')).toEqual([{ node: 'n1', access: accessPreset('full').fields }])
    expect(document.body.textContent).not.toContain('Let Studio use this computer?')
  })

  it('shows the Allow prompt app-wide when a paired computer asks, and sends Allow with its level or Not now', async () => {
    const d = daemon({
      devices: [device({ node: 'n1', direction: 'out', route: 'tailnet', other: { offer: 'let' } })],
      accessAsks: [{ node: 'n1', request: 'r1', name: 'Studio' }]
    })
    // Devices alone does not ask: the app-wide host does, once, wherever the window is.
    await mount()
    expect(document.body.textContent).not.toContain('Let Studio use this computer?')
    await mount(createElement(AccessAskHost))
    expect(document.body.textContent).toContain('Let Studio use this computer?')
    expect(document.body.textContent).toContain('Connects over Tailscale, already in use.')
    await click(button('Allow'))
    expect(d.called('netEngine.access.answer')).toEqual([
      { node: 'n1', request: 'r1', yes: true, access: accessPreset('work').fields }
    ])

    await d.change({ accessAsks: [{ node: 'n1', request: 'r2', name: 'Studio' }] })
    await click(button('Not now'))
    expect(d.called('netEngine.access.answer').at(-1)).toEqual({ node: 'n1', request: 'r2', yes: false })
  })
})
