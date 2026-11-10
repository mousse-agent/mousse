// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RowMenu } from '../../src/renderer/components/integrations/RowMenu'
import {
  InviteComputerDialog,
  addDeviceRoutes,
  type AddDeviceState
} from '../../src/renderer/components/devices/AddDeviceDialog'
import { CopyButton } from '../../src/renderer/components/settings/IconButtons'
import { accountSection } from '../../src/renderer/lib/settingsNavigation'
import { PAIRING_DISCLOSURE } from '../../src/renderer/lib/netDevices'

const ready: AddDeviceState = { hasIdentity: true, unlocked: true, authority: true, protectedKeys: true }
const fresh: AddDeviceState = { hasIdentity: false, unlocked: false, authority: false, protectedKeys: false }
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const blocked = (state: AddDeviceState) => Object.fromEntries(addDeviceRoutes(state).map((route) => [route.id, route.blocked]))

describe('Add device routes', () => {
  it('offers the routes in order, with a phone only in a build with Mousse ID', () => {
    expect(addDeviceRoutes(ready).map((route) => route.title)).toEqual(['Invite a computer', 'Remote machine over SSH', 'Join with invitation'])
    expect(addDeviceRoutes({ ...ready, phone: {} }).map((route) => route.id)).toEqual(['invite', 'phone', 'ssh', 'join'])
  })

  it('lets the computer that manages the devices invite and set up over SSH, and never join again', () => {
    expect(blocked(ready)).toEqual({ invite: undefined, join: 'Only on a device that is not set up yet.', ssh: undefined })
  })

  it('says what adding a phone needs, and holds everything but joining while this computer reconnects', () => {
    expect(blocked({ ...ready, phone: { blocked: 'Sign in to add phones.' } }).phone).toBe('Sign in to add phones.')
    expect(blocked({ ...ready, phone: {}, lapsed: true })).toEqual({
      invite: 'Wait for this computer to reconnect first.',
      phone: 'Wait for this computer to reconnect first.',
      ssh: 'Wait for this computer to reconnect first.',
      join: 'Only on a device that is not set up yet.'
    })
  })

  it('lets a device that is not set up only join, and says what inviting needs', () => {
    expect(blocked(fresh)).toEqual({ invite: 'Turn on networking first.', join: undefined, ssh: 'Turn on networking first.' })
  })

  it('names the first thing a device needs before it can invite', () => {
    expect(blocked({ ...ready, unlocked: false }).invite).toBe('Unlock this device first.')
    expect(blocked({ ...ready, authority: false }).invite).toBe('Add it from the computer that manages your devices.')
    expect(blocked({ ...ready, protectedKeys: false }).invite).toBe('Protect network keys first.')
    // Unlocking comes before anything else on a locked device.
    expect(blocked({ ...ready, unlocked: false, authority: false, protectedKeys: false }).invite).toBe('Unlock this device first.')
  })
})

describe('Add device menu', () => {
  it('lists every route with its detail, and keeps an unavailable one focusable with its need', async () => {
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const chosen = vi.fn()
    const routes = addDeviceRoutes({ ...fresh, phone: { blocked: 'Sign in to add phones.' } })
    await act(async () => root.render(createElement(RowMenu, {
      label: 'Add device',
      buttonClassName: 'settings-btn',
      trigger: 'Add device',
      items: routes.map((route) => ({ label: route.title, detail: route.blocked ?? route.detail, disabled: !!route.blocked, action: `add-${route.id}`, onSelect: () => chosen(route.id) }))
    })))
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
    expect(trigger.textContent).toBe('Add device')
    await act(async () => trigger.click())
    const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
    expect(items.map((item) => [item.dataset.action, item.getAttribute('aria-disabled') === 'true', item.disabled])).toEqual([
      ['add-invite', true, false], ['add-phone', true, false], ['add-ssh', true, false], ['add-join', false, false]
    ])
    expect(items[1].textContent).toBe('Add a phoneSign in to add phones.')
    await act(async () => items[0].click())
    expect(chosen).not.toHaveBeenCalled()
    await act(async () => items[3].click())
    expect(chosen).toHaveBeenCalledWith('join')
    act(() => root.unmount())
    host.remove()
  })
})

describe('Invite a computer', () => {
  const render = (patch: Partial<Parameters<typeof InviteComputerDialog>[0]> = {}) => renderToStaticMarkup(createElement(InviteComputerDialog, {
    ready: true, busy: false, now: 1_000_000, onCreate: () => undefined, onClose: () => undefined, ...patch
  }))

  it('says what pairing allows before an invitation exists', () => {
    const html = render()
    expect(html).toContain(PAIRING_DISCLOSURE.replace(/'/g, '&#x27;'))
    expect(html).toContain('>Create invitation</button>')
    // Opened straight from the Add device menu, so there is no route to go back to.
    expect(html).not.toContain('aria-label="Back"')
  })

  it('cannot create an invitation until this device is ready', () => {
    expect(render({ ready: false })).toMatch(/<button[^>]*disabled=""[^>]*>Create invitation<\/button>/)
  })

  it('shows the full invitation, where to paste it, its expiry and a copy that says Copied', () => {
    const html = render({ invitation: { text: 'mj1_full-invitation-text', expiresAt: 1_000_000 + 9 * 60_000 + 41_000 } })
    expect(html).toContain('>mj1_full-invitation-text</textarea>')
    expect(html).toContain('Add device → Join with invitation')
    expect(html).toContain('Share it privately.')
    expect(html).toContain('Expires in 9:41')
    expect(html).toContain('aria-label="Copy invitation"')
    expect(html).toContain('class="copy-announce-status" role="status"')
    expect(html).not.toContain('Create invitation')
  })

  it('offers a new invitation once one expires, and no longer shows the old one', () => {
    const html = render({ invitation: { text: 'mj1_old', expiresAt: 999_000 } })
    expect(html).toContain('This invitation expired.')
    expect(html).not.toContain('mj1_old')
    expect(html).toContain('>Create new invitation</button>')
  })
})

describe('Copy button', () => {
  it('stays a single icon button unless asked to announce', () => {
    const plain = renderToStaticMarkup(createElement(CopyButton, { text: 'x', label: 'Copy command' }))
    expect(plain).toMatch(/^<button/)
    expect(plain).not.toContain('role="status"')
  })
})

describe('Old Account links', () => {
  it('go to sign-in on Devices when the build has Mousse ID, else to Activity', () => {
    expect(accountSection(true)).toBe('connections')
    expect(accountSection(false)).toBe('activity')
  })
})
