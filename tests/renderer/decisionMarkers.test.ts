// @vitest-environment jsdom
/**
 * Decisions that are reached another way than their first prompt still pause a theme (#1142): the host key every SSH
 * dialog confirms (adding a device, renaming an address, approving a route), and an editor request answered in
 * Settings → Devices after its dialog was dismissed, and the composer's permission menu, whose Full access row a theme
 * could otherwise show as "Ask before acting". The pause itself is tests/renderer/theme-css-electron.test.ts.
 */
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HostKeyConfirm } from '../../src/renderer/components/devices/HostKeyConfirm'
import { DeviceAccessView } from '../../src/renderer/components/devices/DeviceAccessRows'
import { PermissionModeSection, permissionChoice } from '../../src/renderer/components/ComposerPermissionPicker'

const marked = (html: string) => /data-mousse-decision=""/.test(html)

describe('decision markers on shared and left-behind prompts', () => {
  it.each(['unknown', 'changed'] as const)('a %s host key to trust is a decision', (state) => {
    const html = renderToStaticMarkup(createElement(HostKeyConfirm, { hostKey: { type: 'ssh-ed25519', fingerprint: 'SHA256:abc', state }, busy: false, onConfirm: () => {} }))
    expect(html).toContain('Trust this host key')
    expect(marked(html)).toBe(true)
  })

  it('an editor request waiting in Settings → Devices is a decision; the row without one is not', () => {
    const props = { name: 'Phone', policy: { terminal: false, editor: false } as never, busy: false, onSetTerminal: () => {}, onSetEditor: () => {}, onAllow: () => {}, onNotNow: () => {} }
    const asking = renderToStaticMarkup(createElement(DeviceAccessView, { ...props, ask: { node: 'n1', name: 'Phone', at: 0, expiresAt: 1 } as never }))
    expect(asking).toContain('Allow')
    expect(marked(asking)).toBe(true)
    expect(marked(renderToStaticMarkup(createElement(DeviceAccessView, props)))).toBe(false)
  })

  it('the composer\'s permission menu, Full access row included, is a decision', () => {
    const control = { mode: 'ask' as const, agent: 'Claude Code', onSelect: () => {} }
    const html = renderToStaticMarkup(createElement(PermissionModeSection, { control, choice: permissionChoice(control), onPicked: () => {} }))
    expect(html).toContain('aria-label="Full access.')
    expect(marked(html)).toBe(true)
  })
})
