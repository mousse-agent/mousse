// @vitest-environment jsdom
/**
 * Send link and Enter link (design 1b §5): in Let a device in, the host's link with its code and tries left, the
 * end after three wrong codes; in Use another computer, the joiner's paste, the consent with the destinations,
 * "Also let" unticked and "Also share" under it, the six code boxes and the swapped-link text; the "Pairing didn't
 * finish" row; and a `mousse://` link that opened Mousse, with the profile choice when more than one profile has
 * networking on. The daemon is stubbed at `platformRequest`.
 */
import { act, createElement, Fragment } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessPreset } from '../../src/shared/net/accessPresets'
import type { NetEngineDevice, NetEngineStatus } from '../../src/shared/netEngine/local'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { EngineDevicesSection } =
  await import('../../src/renderer/components/netEngine/EngineDevicesSection')
const { LetDeviceInDialog } = await import('../../src/renderer/components/netEngine/LetDeviceInDialog')
const { UseComputerDialog } = await import('../../src/renderer/components/netEngine/UseComputerDialog')
const { PairLinkHost } = await import('../../src/renderer/components/netEngine/PairLinkHost')
const { engineRow } = await import('../../src/renderer/components/netEngine/engineRows')
const { useAppStore } = await import('../../src/renderer/stores/appStore')

const LINK = 'mousse://pair#AAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const TAILNET = 'tcp://100.101.7.2:7443'

type Profile = { id: string; displayName: string; networked?: boolean }

/** The daemon: a status the test changes, the link facts, and every call it was asked. */
function daemon(
  initial: Partial<NetEngineStatus> = {},
  options: {
    damaged?: boolean
    shareable?: Array<{ route: string; label: string; cls: string }>
  } = {}
) {
  const state: { status: NetEngineStatus; profiles: Profile[] } = {
    status: {
      enabled: true,
      on: true,
      helper: { state: 'running' },
      devices: [],
      approvals: [],
      sendLink: true,
      ...initial
    },
    profiles: []
  }
  const calls: Array<[string, any]> = []
  const changed = new Set<(change: { profileId?: string }) => void>()
  let invites = 0
  const request = vi.fn(async (method: string, params: any) => {
    calls.push([method, params])
    switch (method) {
      case 'netEngine.invite':
        invites += 1
        return { invitation: `inv${invites}`, uri: LINK, code: '123456', attemptsLeft: 3 }
      case 'netEngine.join.preview':
        // The daemon refuses what it cannot decode (`bad_ticket`).
        if (options.damaged) throw new Error("This isn't a Mousse pairing code.")
        return {
          invitation: 'inv-j',
          kind: 2,
          destinations: [
            {
              route: 'tcp://192.168.1.20:7443',
              label: '192.168.1.20:7443',
              cls: 'lan',
              automatic: true
            },
            { route: TAILNET, label: '100.101.7.2:7443', cls: 'tailnet', automatic: false }
          ],
          shareable: options.shareable ?? []
        }
      case 'netEngine.join':
        // The join waits for the code until the test ends.
        return new Promise(() => undefined)
      case 'net.status':
        return { enabled: false }
      case 'bridge.nodes':
        return { nodes: [] }
      default:
        return state.status
    }
  })
  const pairLink = { waiting: null as string | null, arrived: new Set<() => void>() }
  ;(window as unknown as { mousse: unknown }).mousse = {
    platformRequest: { request },
    netEngine: {
      onChanged: (cb: (change: { profileId?: string }) => void) => {
        changed.add(cb)
        return () => changed.delete(cb)
      },
      takePairLink: async () => {
        const link = pairLink.waiting
        pairLink.waiting = null
        return link
      },
      onPairLink: (cb: () => void) => {
        pairLink.arrived.add(cb)
        return () => pairLink.arrived.delete(cb)
      }
    },
    profiles: {
      list: async () => ({
        defaultProfileId: 'p1',
        profiles: state.profiles.map((profile) => ({
          slug: profile.id,
          status: 'active',
          revision: 1,
          isDefault: profile.id === 'p1',
          ...profile
        }))
      }),
      bind: vi.fn()
    }
  }
  return {
    state,
    called: (method: string) =>
      calls.filter(([name]) => name === method).map(([, params]) => params),
    /** Main says a `mousse://` link arrived. */
    arrive: async (link: string) => {
      pairLink.waiting = link
      await act(async () => {
        for (const cb of pairLink.arrived) cb()
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
const mount = async (element: ReturnType<typeof createElement>) => {
  await act(async () => root.render(element))
  await flush()
}
const text = () => document.body.textContent?.replace(/\s+/g, ' ') ?? ''
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (item) => item.textContent?.trim() === name || item.getAttribute('aria-label') === name
  )
const click = async (target: HTMLElement | undefined | null) => {
  expect(target).toBeTruthy()
  await act(async () => target!.click())
  await flush()
}
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const field = (label: string) =>
  document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
const submit = async (input: HTMLInputElement) => {
  await act(async () => input.form!.requestSubmit())
  await flush()
}

/**
 * A dialog with the status the daemon gives now; the answer re-renders it with a changed status. `in`: Let a device
 * in; `out`: Use another computer.
 */
async function dialog(d: ReturnType<typeof daemon>, side: 'in' | 'out') {
  const render = () =>
    root.render(
      side === 'in'
        ? createElement(LetDeviceInDialog, {
            status: d.state.status,
            onClose: () => undefined,
            onSetUp: () => undefined
          })
        : createElement(UseComputerDialog, { status: d.state.status, onClose: () => undefined })
    )
  await act(async () => render())
  await flush()
  return async (next: Partial<NetEngineStatus>) => {
    d.state.status = { ...d.state.status, ...next }
    await act(async () => render())
    await flush()
  }
}

/** The "Also let <name> use this computer" switch. */
const ALSO_LET = () =>
  [...document.querySelectorAll<HTMLElement>('[role="switch"]')].find((item) =>
    document.getElementById(item.getAttribute('aria-labelledby') ?? '')?.textContent?.startsWith('Also let ')
  )

describe('Let a device in while networking starts', () => {
  it('waits with how far it is, no error, and shows the code once the helper runs', async () => {
    const d = daemon({ on: false, helper: { state: 'starting', step: 'launch' } })
    const update = await dialog(d, 'in')
    expect(d.called('netEngine.invite')).toEqual([])
    expect(document.querySelector('[role="alert"]')).toBeNull()
    expect(text()).toContain('Getting ready to connect… 25%')

    await update({ helper: { state: 'starting', step: 'hello' } })
    expect(text()).toContain('50%')

    await update({ on: true, helper: { state: 'running' } })
    expect(d.called('netEngine.invite')).toEqual([{}])
    expect(document.querySelector('[aria-label="Pairing QR code"]')).toBeTruthy()
  })
})

describe('Send link (§5.1)', () => {
  it('asks what the device may do first, then shows the link with Copy, the code apart from it, the tries left, and the end after three wrong codes', async () => {
    const d = daemon()
    const update = await dialog(d, 'in')
    await click(button('Link'))
    // No Allow follows a link: the level is picked before the link exists, Work on threads first.
    expect(text()).toContain('What can it do here?')
    const radio = (label: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Access"] [role="radio"]')].find(
        (row) => row.querySelector('.engine-choice-label')?.textContent === label
      )
    expect(radio('Work on threads')?.getAttribute('aria-checked')).toBe('true')
    expect(button('Customize')).toBeTruthy()
    expect(d.called('netEngine.invite')).toEqual([{}])
    await click(radio('View and chat'))
    expect(button('Make link')?.classList.contains('ui-btn-primary')).toBe(true)
    await click(button('Make link'))
    // The dialog's own code first, then the link with its level.
    const view = { kind: 'link', access: accessPreset('view').fields }
    expect(d.called('netEngine.invite')).toEqual([{}, view])
    expect(field('Link').value).toBe(LINK)
    expect(button('Copy link')).toBeTruthy()
    expect(text()).toContain('123 456')
    expect(text()).toContain('3 tries left')
    expect(text()).toContain('Send the link in a chat. Read the code to them another way.')

    // A wrong code: a new code and one try fewer.
    await update({ links: [{ invitation: 'inv2', code: '654321', attemptsLeft: 2 }] })
    expect(text()).toContain('654 321')
    expect(text()).toContain('2 tries left')

    await update({
      links: [{ invitation: 'inv2', code: '654321', attemptsLeft: 0, ended: 'attempts_exhausted' }]
    })
    expect(text()).toContain('Three wrong codes. This link no longer works.')
    await click(button('New link'))
    expect(d.called('netEngine.invite')).toEqual([{}, view, view])
  })

  it('is offered only when the helper speaks Send link', async () => {
    await dialog(daemon({ sendLink: undefined }), 'in')
    expect(document.querySelector('[aria-label="Pairing QR code"]')).toBeTruthy()
    expect(button('Link')).toBeUndefined()
  })
})

describe('Scan or paste a sent link (§5.3)', () => {
  it('takes a sent link in the one paste field, asks consent with the destinations, one way unless ticked, then asks for the code', async () => {
    const d = daemon(
      {},
      { shareable: [{ route: 'tcp://203.0.113.7:7443', label: '203.0.113.7:7443', cls: 'public' }] }
    )
    const update = await dialog(d, 'out')
    await type(field('Pairing link'), LINK)
    await submit(field('Pairing link'))
    expect(text()).toContain('Use the computer in this link from here?')
    expect(text()).toContain('192.168.1.20:7443 (Same network), 100.101.7.2:7443 (Tailscale)')
    expect(ALSO_LET()!.getAttribute('aria-checked')).toBe('false')
    // One way: nothing of this computer's is offered to share.
    expect(text()).not.toContain('Internet 203.0.113.7:7443')
    await click(ALSO_LET())
    const share = [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
      box.parentElement!.textContent?.includes('Internet 203.0.113.7:7443')
    )!
    expect(share.checked).toBe(false)
    await click(ALSO_LET())

    await click(button('Connect'))
    expect(d.called('netEngine.join')).toEqual([{ ticket: LINK, arrival: 'link', back: false }])
    expect(text()).toContain('Connecting…')

    await update({ joins: [{ invitation: 'inv-j', needsCode: true, attemptsLeft: 3 }] })
    expect(text()).toContain('Type the code shown on the other computer.')
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[aria-label^="Digit "]')]
    expect(boxes).toHaveLength(6)
    expect(button('Confirm')!.disabled).toBe(true)
    for (const [at, digit] of [...'123456'].entries()) await type(boxes[at]!, digit)
    await click(button('Confirm'))
    expect(d.called('netEngine.join.code')).toEqual([{ invitation: 'inv-j', code: '123456' }])

    // A wrong code says the link may have been swapped.
    await update({
      joins: [{ invitation: 'inv-j', needsCode: true, attemptsLeft: 2, wrong: true }]
    })
    expect(text()).toContain(
      "That code didn't work. If you typed it exactly, the link may have been swapped; get a new one another way."
    )
    expect(text()).toContain('2 tries left')
  })

  it('sends "Also let" and a ticked "Also share" route', async () => {
    const d = daemon(
      {},
      { shareable: [{ route: 'tcp://203.0.113.7:7443', label: '203.0.113.7:7443', cls: 'public' }] }
    )
    await dialog(d, 'out')
    await type(field('Pairing link'), LINK)
    await submit(field('Pairing link'))
    await click(ALSO_LET())
    await click(
      [...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].find((box) =>
        box.parentElement!.textContent?.includes('Internet 203.0.113.7:7443')
      )
    )
    await click(button('Connect'))
    expect(d.called('netEngine.join')[0]).toMatchObject({ back: true, share: ['tcp://203.0.113.7:7443'] })
  })

  it('says a damaged link is damaged, and joins nothing', async () => {
    const d = daemon({}, { damaged: true })
    await dialog(d, 'out')
    await type(field('Pairing link'), LINK)
    await submit(field('Pairing link'))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'This link is damaged. Ask for a new one.'
    )
    expect(button('Connect')).toBeUndefined()
    expect(d.called('netEngine.join')).toEqual([])
  })
})

describe('a Send link that did not finish (§5.4)', () => {
  const device = (fields: Partial<NetEngineDevice>): NetEngineDevice => ({
    node: 'n1',
    name: 'Studio',
    shortId: 'a1b2c3d4',
    state: 'finishing',
    online: false,
    unfinished: true,
    ...fields
  })
  it.each([
    ['the link is still valid', { linkValid: true }, ['retry', 'remove']],
    ['the link has expired', {}, ['remove']]
  ] as const)('reads "Pairing didn\'t finish" when %s', (_name, fields, actions) => {
    const view = engineRow(device(fields))
    expect(view.line).toBe("Pairing didn't finish")
    expect(view.actions).toEqual(actions)
  })

  it('asks for the code of a join Retry repeated, in Settings → Devices', async () => {
    const d = daemon({
      devices: [device({ linkValid: true })],
      joins: [{ invitation: 'inv-r', node: 'n1', needsCode: true, attemptsLeft: 2 }]
    })
    await mount(createElement(EngineDevicesSection))
    expect(text()).toContain('Type the code shown on the other computer.')
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[aria-label^="Digit "]')]
    await type(boxes[0]!, '654321')
    await click(button('Confirm'))
    expect(d.called('netEngine.join.code')).toEqual([{ invitation: 'inv-r', code: '654321' }])
  })
})

describe('a mousse:// link that opened Mousse (§5.2)', () => {
  const both = () =>
    createElement(Fragment, null, createElement(PairLinkHost), createElement(EngineDevicesSection))

  it('opens Scan or paste with it in Settings → Devices', async () => {
    const d = daemon()
    d.state.profiles = [{ id: 'p1', displayName: 'Work', networked: true }]
    useAppStore.setState({ profileId: 'p1' })
    await mount(both())
    await d.arrive(LINK)
    expect(d.called('netEngine.join.preview')).toContainEqual({ ticket: LINK })
    expect(text()).toContain('Use the computer in this link from here?')
  })

  it('asks which profile joins when more than one has networking on', async () => {
    const d = daemon()
    d.state.profiles = [
      { id: 'p1', displayName: 'Work', networked: true },
      { id: 'p2', displayName: 'Home', networked: true },
      { id: 'p3', displayName: 'Off' }
    ]
    useAppStore.setState({ profileId: 'p1' })
    await mount(both())
    await d.arrive(LINK)
    expect(text()).toContain('Which profile joins?')
    expect(button('Home')).toBeTruthy()
    expect(button('Off')).toBeUndefined()
    expect(d.called('netEngine.join.preview')).toEqual([])
    await click(button('Work'))
    expect(d.called('netEngine.join.preview')).toContainEqual({ ticket: LINK })
  })
})
