import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DeviceAccessView, type DeviceAccessViewProps } from '../../src/renderer/components/devices/DeviceAccessRows'
import type { EditorAskView } from '../../src/shared/bridge/editorAsk'
import type { BridgeNodePolicy } from '../../src/shared/net/local'
import type { NodeId } from '../../src/shared/net/ids'

const policy = (patch: Partial<BridgeNodePolicy> = {}): BridgeNodePolicy => ({
  blocked: false,
  maxPermissionMode: 'accept_edits',
  terminal: false,
  editor: false,
  ...patch
})

const ask: EditorAskView = { node: 'nod_b' as NodeId, name: 'Computer B', at: 1, expiresAt: 2 }

const view = (patch: Partial<DeviceAccessViewProps> = {}) =>
  renderToStaticMarkup(createElement(DeviceAccessView, {
    name: 'Computer B', policy: policy(), busy: false,
    onSetTerminal: () => undefined, onSetEditor: () => undefined, onAllow: () => undefined, onNotNow: () => undefined,
    ...patch
  }))

/** The switches in the order they render, with their label and state. */
const switches = (html: string) =>
  [...html.matchAll(/<button[^>]*role="switch"[^>]*>/g)].map((match) => ({
    label: /aria-label="([^"]*)"/.exec(match[0])?.[1],
    checked: /aria-checked="true"/.test(match[0]),
    disabled: /disabled=""/.test(match[0])
  }))

describe('terminal and editor rows for a device', () => {
  it('shows Terminals then Editor connections, next to each other', () => {
    const html = view()
    const terminal = html.indexOf('Terminals from this device')
    const editor = html.indexOf('Editor connections from this device')
    expect(terminal).toBeGreaterThan(-1)
    expect(editor).toBeGreaterThan(terminal)
    expect(html.match(/class="settings-item indent"/g)).toHaveLength(2)
    expect(switches(html).map((row) => row.label)).toEqual(['Terminals from Computer B', 'Editor connections from Computer B'])
  })

  it('follows the policy for each switch', () => {
    expect(switches(view()).map((row) => row.checked)).toEqual([false, false])
    expect(switches(view({ policy: policy({ terminal: true }) })).map((row) => row.checked)).toEqual([true, false])
    expect(switches(view({ policy: policy({ editor: true }) })).map((row) => row.checked)).toEqual([false, true])
  })

  it('says an editor connection is shell access over this computer\'s SSH server', () => {
    // One short phrase on each row; the longer words are the tooltip.
    const off = view()
    expect(off.match(/Off · shell access/g)).toHaveLength(2)
    expect(off).toContain('title="Computer B&#x27;s editor signs in to this computer&#x27;s own SSH server as you, so one needs to be running.')
    expect(off).toContain('turn this off or turn Mousse Net off')
    const on = view({ policy: policy({ editor: true, terminal: true }) })
    expect(on.match(/On · shell access/g)).toHaveLength(2)
    expect(on).toContain('title="Computer B can open, type into and stop terminals')
  })

  it('answers a waiting ask in the editor row and keeps the switch', () => {
    const html = view({ ask })
    expect(html).toContain('Asked · shell access')
    const actions = [...html.matchAll(/data-action="([a-z-]+)"/g)].map((match) => match[1])
    expect(actions).toEqual(['decline-editor-ask', 'allow-editor-ask'])
    expect(html).toContain('Not now</button>')
    expect(html).toContain('Allow</button>')
    expect(switches(html)).toHaveLength(2)
  })

  it('offers no answer buttons without an ask', () => {
    const html = view()
    expect(html).not.toContain('data-action=')
    expect(html).not.toContain('Not now')
    expect(html).not.toContain('asked to open its editor')
  })

  it('holds the switches and buttons while a change runs', () => {
    const html = view({ busy: true, ask })
    expect(switches(html).every((row) => row.disabled)).toBe(true)
    expect(html.match(/data-action="(allow|decline)-editor-ask" disabled=""/g)).toHaveLength(2)
  })
})
