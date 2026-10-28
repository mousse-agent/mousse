// @vitest-environment jsdom
/**
 * The editor item of a thread that runs on another computer, mounted: what a click on it comes to for each
 * state of the connection, and what Ask does. The daemon and the main process are replaced by `window.mousse`.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteAskResult, RemoteOpenResult } from '../../src/shared/remoteEditor'
import type { EditorInfo } from '../../src/shared/types'

const code: EditorInfo = { id: 'vscode', label: 'VS Code', kind: 'editor', remote: true }
const state = vi.hoisted(() => ({
  route: 'mousse' as 'mousse' | 'ssh' | 'none',
  devices: [] as Array<Record<string, unknown>>,
  openDevice: vi.fn()
}))

vi.mock('../../src/renderer/stores/editorsStore', () => {
  const editors = [{ id: 'vscode', label: 'VS Code', kind: 'editor', remote: true }]
  return {
    useEditorsStore: (select: (value: { editors: unknown[] }) => unknown) => select({ editors }),
    loadEditors: async () => undefined,
    refreshEditors: async () => undefined
  }
})
vi.mock('../../src/renderer/lib/computers', () => ({
  UNKNOWN_COMPUTER_NAME: 'Another computer',
  useComputers: () => ({ loaded: true, routed: true, byNode: {}, devices: state.devices }),
  useComputer: () => undefined
}))
vi.mock('../../src/renderer/components/sideCard/useRemoteRoute', () => ({
  useRemoteRoute: () => ({ kind: state.route, reload: () => undefined })
}))
vi.mock('../../src/renderer/lib/settingsNavigation', () => ({ openDevice: (node: string) => state.openDevice(node) }))
vi.mock('../../src/renderer/components/sideCard/EditorSshNotice', () => ({ EditorSshNotice: () => null }))
vi.mock('../../src/renderer/components/devices/ApproveSshRouteDialog', () => ({ ApproveSshRouteDialog: () => null }))

const { OpenInRemoteEditor } = await import('../../src/renderer/components/sideCard/EditorMenuButton')

const NODE = 'nod_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const SELF = 'nod_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const THREAD = `${NODE}:t1`

describe('the editor item of a thread on another computer, state by state', () => {
  let host: HTMLDivElement
  let root: Root
  let openRemote: ReturnType<typeof vi.fn>
  let askAccess: ReturnType<typeof vi.fn>

  const settle = async () => {
    for (let round = 0; round < 6; round += 1) await act(async () => { await new Promise((done) => setTimeout(done, 0)) })
  }
  const mount = async (options: { opens?: RemoteOpenResult[]; asks?: RemoteAskResult[]; platform?: string; device?: Record<string, unknown> } = {}) => {
    state.devices = [
      { node: SELF, self: true, name: 'This computer', state: 'open' },
      { node: NODE, name: 'Computer B', state: 'open', platform: options.platform ?? 'linux', ...options.device }
    ]
    const opens = [...(options.opens ?? [])]
    const asks = [...(options.asks ?? [])]
    openRemote = vi.fn(async () => opens.length > 1 ? opens.shift()! : opens[0] ?? { ok: true })
    askAccess = vi.fn(async () => asks.length > 1 ? asks.shift()! : asks[0])
    ;(window as unknown as { mousse: unknown }).mousse = { editors: { openRemote, askAccess, list: async () => [code] } }
    act(() => root.render(createElement(OpenInRemoteEditor, { threadId: THREAD, node: NODE, computer: 'Computer B', profileId: 'p1' })))
    await settle()
  }
  const text = () => host.textContent ?? ''
  const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent?.trim() === label)
  const click = async (label: string) => {
    const target = button(label)
    if (!target) throw new Error(`no button "${label}" in: ${text()}`)
    await act(async () => { target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })) })
    await settle()
  }

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    state.route = 'mousse'
    state.openDevice.mockReset()
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })
  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('editor connections off: says so, offers Ask Computer B, and Ask puts the question to that computer', async () => {
    await mount({
      opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }, { ok: true, via: { path: 'relay', transport: 'plus-relay' } }],
      asks: [{ ok: true, reply: { state: 'asked', expiresAt: Date.now() + 600_000 } }]
    })
    expect(text()).not.toContain('Ask Computer B')
    await click('Open in VS Code')
    expect(text()).toContain('Editor connections from this computer are off on Computer B.')
    expect(text()).toContain('shell access')
    expect(button('Ask Computer B')).toBeDefined()

    await click('Ask Computer B')
    expect(askAccess).toHaveBeenCalledExactlyOnceWith(THREAD)
    expect(text()).toContain('Asked Computer B.')
    expect(text()).toContain('When someone there allows it, open the folder again.')
    // A computer with no screen gets the command that turns the switch on, with this computer's own id.
    expect(text()).toContain(`mousse-cli bridge limits ${SELF} --editor on`)
    expect(button('Ask Computer B')).toBeUndefined()

    // Once someone allowed it, Try again opens the editor and says how it runs.
    await click('Try again')
    expect(openRemote).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Opening on Computer B through Mousse relay.')
    expect(text()).not.toContain('Asked Computer B.')
  })

  it('a computer that blocked this one: says so and is not offered a second ask', async () => {
    await mount({ opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }], asks: [{ ok: false, failure: 'blocked', message: 'Computer B refused this device.' }] })
    await click('Open in VS Code')
    await click('Ask Computer B')
    expect(text()).toContain('Computer B has blocked this computer.')
    expect(text()).toContain('Unblock this computer in Settings, Devices on Computer B')
    expect(button('Ask Computer B')).toBeUndefined()
    expect(button('Try again')).toBeDefined()
  })

  it.each([
    ['declined_recently', 'Computer B said not now.'],
    ['rate_limited', 'You have asked Computer B a few times already.'],
    ['pending', 'Computer B has not answered your ask yet.'],
    ['already_on', 'Computer B already allows editor connections from this computer.']
  ] as const)('says what an ask that came back %s means', async (reply, words) => {
    await mount({
      opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }],
      asks: [{ ok: true, reply: { state: reply, retryAt: 1, expiresAt: 1 } as never }]
    })
    await click('Open in VS Code')
    await click('Ask Computer B')
    expect(text()).toContain(words)
    expect(button('Try again')).toBeDefined()
  })

  it('shows the checking line while the connection is being looked at, and the opened line after', async () => {
    let finish: (result: RemoteOpenResult) => void = () => undefined
    await mount()
    openRemote.mockImplementation(() => new Promise<RemoteOpenResult>((done) => { finish = done }))
    await click('Open in VS Code')
    expect(text()).toContain('Checking the connection to Computer B…')
    await act(async () => { finish({ ok: true, via: { path: 'direct', transport: 'tailscale' } }) })
    await settle()
    expect(text()).not.toContain('Checking the connection')
    expect(text()).toContain('Opening on Computer B through Tailscale.')
  })

  it.each([
    ['win32', 'install OpenSSH Server'],
    ['darwin', 'turn on Remote Login'],
    ['linux', 'install openssh-server']
  ])('no SSH server on a %s computer: says what to do there', async (platform, words) => {
    await mount({ platform, opens: [{ ok: false, reason: 'connection', failure: 'no_ssh_server' }] })
    await click('Open in VS Code')
    expect(text()).toContain('Computer B has no SSH server running.')
    expect(text()).toContain(words)
    expect(text()).toContain('browse and edit its files in the Files panel')
    expect(button('Try again')).toBeDefined()
  })

  it.each([
    ['host_untrusted', 'does not vouch for it'],
    ['no_host_key', 'Mousse cannot read the SSH host key of Computer B.'],
    ['limit', 'already has all the editor connections it may have on Computer B'],
    ['rate_limited', 'are being opened too fast'],
    ['unsupported', 'cannot carry editor connections']
  ] as const)('%s: says it in plain words, with a way on', async (failure, words) => {
    await mount({ platform: 'win32', opens: [{ ok: false, reason: 'connection', failure }] })
    await click('Open in VS Code')
    expect(text()).toContain(words)
    expect(button('Try again')).toBeDefined()
  })

  it('a refused key: shows the command that adds this computer’s key, ready to copy', async () => {
    await mount({ opens: [{ ok: false, reason: 'connection', failure: 'key_refused', command: 'ssh-copy-id mousse-workbox-3fa2c1' }] })
    await click('Open in VS Code')
    expect(text()).toContain('did not accept this computer\'s key')
    expect(text()).toContain('ssh-copy-id mousse-workbox-3fa2c1')
    expect(button('Try again')).toBeDefined()
  })

  it.each([
    ['ssh_check_failed', 'could not read the settings Mousse wrote'],
    ['unwritable', 'read-only for this account'],
    ['not_owner', 'belongs to another account']
  ])('the settings Mousse keeps here, %s: says so and offers the line to add by hand', async (problem, words) => {
    await mount({ opens: [{ ok: false, reason: 'ssh_settings', code: problem, message: 'detail', includeLine: 'Include ~/.mousse/ssh/config' }] })
    await click('Open in VS Code')
    expect(text()).toContain(words)
    expect(text()).toContain('Include ~/.mousse/ssh/config')
    expect(button('Try again')).toBeDefined()
  })

  it('offline: said before any click, and Try again looks again', async () => {
    await mount({ device: { state: 'closed' }, opens: [{ ok: false, reason: 'connection', failure: 'offline' }] })
    expect(text()).toContain('Computer B is offline.')
    expect(text()).toContain('Turn it on or reconnect it, then try again.')
    expect(openRemote).not.toHaveBeenCalled()
    await click('Try again')
    expect(openRemote).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Computer B is offline.')
  })

  it('a computer that went offline after an answer is offline now, not what the old answer said', async () => {
    await mount({ opens: [{ ok: false, reason: 'connection', failure: 'host_untrusted' }] })
    await click('Open in VS Code')
    expect(text()).toContain('does not vouch for it')
    state.devices = state.devices.map((entry) => (entry.node === NODE ? { ...entry, state: 'closed' } : entry))
    act(() => root.render(createElement(OpenInRemoteEditor, { threadId: THREAD, node: NODE, computer: 'Computer B', profileId: 'p1' })))
    await settle()
    expect(text()).toContain('Computer B is offline.')
    expect(text()).not.toContain('does not vouch for it')
  })

  it('a computer that is only connecting is not called offline', async () => {
    await mount({ device: { state: 'connecting' } })
    expect(text()).not.toContain('is offline')
  })

  it('opens with the hint when the editor’s Remote - SSH extension may be missing, never blocking', async () => {
    await mount({ opens: [{ ok: true, hint: 'If VS Code asks for the Remote - SSH extension, install ms-vscode-remote.remote-ssh, then open this folder again.' }] })
    await click('Open in VS Code')
    expect(text()).toContain('install ms-vscode-remote.remote-ssh')
    expect(openRemote).toHaveBeenCalledTimes(1)
    expect(button('Try again')).toBeUndefined()
  })

  it('keeps the way to approve an SSH address that a computer offers, for computers set up that way', async () => {
    state.route = 'none'
    await mount({ device: { sshOffer: { endpoint: 'dev@box.example.com:22' } } })
    expect(text()).toContain('approve the SSH address Computer B offers (dev@box.example.com:22)')
    expect(button('Approve address…')).toBeDefined()
    // Nothing of the interim wording is left.
    expect(text()).not.toMatch(/needs to reach it over SSH|Mousse sets SSH up only on Linux/)
  })

  it('with no connection of any kind, sends to Devices at that computer', async () => {
    state.route = 'none'
    await mount()
    expect(text()).toContain('cannot open Computer B’s folder from this computer yet')
    await click('Open Devices…')
    expect(state.openDevice).toHaveBeenCalledWith(NODE)
  })

  it('shows the ask’s own failure when it throws, instead of nothing', async () => {
    await mount({ opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }] })
    askAccess.mockRejectedValue(new Error('Error invoking remote method \'editors:askAccess\': Error: The other computer answered in a way this version does not know.'))
    await click('Open in VS Code')
    await click('Ask Computer B')
    expect(text()).toContain('does not know')
  })
})
