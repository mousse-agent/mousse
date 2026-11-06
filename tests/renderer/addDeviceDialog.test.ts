import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  AddDeviceChooser,
  InviteComputerDialog,
  addDeviceRoutes,
  type AddDeviceState
} from '../../src/renderer/components/devices/AddDeviceDialog'
import { CopyButton } from '../../src/renderer/components/settings/IconButtons'
import { accountSection } from '../../src/renderer/lib/settingsNavigation'
import { PAIRING_DISCLOSURE } from '../../src/renderer/lib/netDevices'

const ready: AddDeviceState = { hasIdentity: true, unlocked: true, authority: true, protectedKeys: true }
const fresh: AddDeviceState = { hasIdentity: false, unlocked: false, authority: false, protectedKeys: false }
const blocked = (state: AddDeviceState) => Object.fromEntries(addDeviceRoutes(state).map((route) => [route.id, route.blocked]))

describe('Add device routes', () => {
  it('offers the three routes in order', () => {
    expect(addDeviceRoutes(ready).map((route) => route.title)).toEqual(['Invite a computer', 'Join with invitation', 'Remote machine over SSH'])
  })

  it('lets the computer that manages the devices invite and set up over SSH, and never join again', () => {
    expect(blocked(ready)).toEqual({ invite: undefined, join: 'Only on a device that is not set up yet.', ssh: undefined })
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

describe('Add device chooser', () => {
  const html = renderToStaticMarkup(createElement(AddDeviceChooser, { routes: addDeviceRoutes(fresh), onChoose: () => undefined, onClose: () => undefined }))
  const buttons = [...html.matchAll(/<button[^>]*data-route="([a-z]+)"[^>]*>(.*?)<\/button>/g)].map((match) => ({
    route: match[1],
    tag: match[0],
    disabled: /aria-disabled="true"/.test(match[0]),
    text: match[2]
  }))

  it('names the dialog for assistive tech without a visible title', () => {
    expect(html).toContain('aria-label="Add device"')
    expect(html).not.toContain('<h3')
  })

  it('keeps unavailable routes focusable and says why beside each', () => {
    expect(buttons.map((button) => [button.route, button.disabled])).toEqual([['invite', true], ['join', false], ['ssh', true]])
    // aria-disabled, not disabled, so the keyboard still reaches the route and reads its need.
    for (const button of buttons) expect(button.tag).not.toMatch(/ disabled=""/)
    expect(buttons[0].text).toContain('Turn on networking first.')
    expect(buttons[1].text).toContain('Paste an invitation from one of your devices.')
    const described = /aria-describedby="([^"]+)"/.exec(buttons[0].tag)?.[1]
    expect(html).toContain(`id="${described}">Turn on networking first.`)
  })
})

describe('Invite a computer', () => {
  const render = (patch: Partial<Parameters<typeof InviteComputerDialog>[0]> = {}) => renderToStaticMarkup(createElement(InviteComputerDialog, {
    ready: true, busy: false, now: 1_000_000, onCreate: () => undefined, onBack: () => undefined, onClose: () => undefined, ...patch
  }))

  it('says what pairing allows before an invitation exists', () => {
    const html = render()
    expect(html).toContain(PAIRING_DISCLOSURE.replace(/'/g, '&#x27;'))
    expect(html).toContain('>Create invitation</button>')
    expect(html).toContain('aria-label="Back"')
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
