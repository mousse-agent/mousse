// @vitest-environment jsdom
/**
 * The editor item of a thread that runs on another computer, mounted: what a click on it comes to for each
 * state of the connection, and what Ask does. The daemon and the main process are replaced by `window.mousse`.
 * Every state is one terse line and one action; longer words are a tooltip or sit behind a link.
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
vi.mock('../../src/renderer/components/sideCard/EditorSshToast', () => ({ EditorSshToast: () => null }))
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
  const titles = () => [...host.querySelectorAll('[title]')].map((element) => element.getAttribute('title'))

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
    vi.useRealTimers()
  })

  it('editor connections off: the button itself becomes "Ask Computer B", with the warning as its tooltip and no paragraph', async () => {
    await mount({
      opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }, { ok: true, via: { path: 'relay', transport: 'plus-relay' } }],
      asks: [{ ok: true, reply: { state: 'asked', expiresAt: Date.now() + 600_000 } }]
    })
    expect(button('Ask Computer B')).toBeUndefined()
    await click('Open in VS Code')
    const ask = button('Ask Computer B')!
    expect(ask).toBeDefined()
    expect(ask.title).toBe('Gives shell access')
    expect(button('Open in VS Code')).toBeUndefined()
    // No note and no sentence under it.
    expect(host.querySelector('.side-card-open-editor-note')).toBeNull()
    expect(text()).not.toMatch(/shell access|has to allow/)

    await click('Ask Computer B')
    expect(askAccess).toHaveBeenCalledExactlyOnceWith(THREAD)
    expect(text()).toContain('Asked · waiting')
    expect(button('Open in VS Code')).toBeDefined()
    expect(button('Ask Computer B')).toBeUndefined()
    // The command for a computer with no screen is behind a link, not in the way.
    expect(text()).not.toContain('mousse-cli')
    await click('No screen on Computer B?')
    expect(text()).toContain(`mousse-cli bridge limits ${SELF} --editor on`)

    // Once someone allowed it, Retry opens the editor and says how it runs, in a few words.
    await click('Retry')
    expect(openRemote).toHaveBeenCalledTimes(2)
    expect(text()).toContain('via Mousse relay')
    expect(text()).not.toContain('Asked · waiting')
  })

  it('looks again while an ask waits, and says so when the other computer allowed it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    await mount({
      opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }],
      asks: [
        { ok: true, reply: { state: 'asked', expiresAt: Date.now() + 600_000 } },
        { ok: true, reply: { state: 'already_on' } }
      ]
    })
    await click('Open in VS Code')
    await click('Ask Computer B')
    expect(text()).toContain('Asked · waiting')
    await act(async () => { await vi.advanceTimersByTimeAsync(31_000) })
    await settle()
    expect(askAccess).toHaveBeenCalledTimes(2)
    expect(text()).toContain('Computer B allows it')
    expect(button('Open')).toBeDefined()
  })

  it('a computer that blocked this one: one line, no second ask', async () => {
    await mount({ opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }], asks: [{ ok: false, failure: 'blocked', message: 'Computer B refused this device.' }] })
    await click('Open in VS Code')
    await click('Ask Computer B')
    expect(text()).toContain('Blocked by Computer B')
    expect(titles().join(' ')).toContain('Unblock this computer in Settings, Devices on Computer B')
    expect(button('Ask Computer B')).toBeUndefined()
    expect(button('Retry')).toBeDefined()
  })

  it.each([
    ['declined_recently', 'Computer B said not now'],
    ['rate_limited', 'Asked too often'],
    ['pending', 'Asked · waiting'],
    ['already_on', 'Computer B allows it']
  ] as const)('an ask that came back %s: %s', async (reply, words) => {
    await mount({
      opens: [{ ok: false, reason: 'connection', failure: 'editor_off' }],
      asks: [{ ok: true, reply: { state: reply, retryAt: 1, expiresAt: Date.now() + 600_000 } as never }]
    })
    await click('Open in VS Code')
    await click('Ask Computer B')
    expect(text()).toContain(words)
    expect(button(reply === 'already_on' ? 'Open' : 'Retry')).toBeDefined()
  })

  it('says "Checking…" while the connection is being looked at, and a small "via" badge after', async () => {
    let finish: (result: RemoteOpenResult) => void = () => undefined
    await mount()
    openRemote.mockImplementation(() => new Promise<RemoteOpenResult>((done) => { finish = done }))
    await click('Open in VS Code')
    expect(text()).toContain('Checking…')
    expect(text()).not.toContain('Checking the connection')
    await act(async () => { finish({ ok: true, via: { path: 'direct', transport: 'tailscale' } }) })
    await settle()
    expect(text()).not.toContain('Checking')
    expect(text()).toContain('via Tailscale')
    expect(host.querySelectorAll('.side-card-open-editor-via')).toHaveLength(1)
  })

  it.each([
    ['win32', 'install OpenSSH Server'],
    ['darwin', 'turn on Remote Login'],
    ['linux', 'install openssh-server']
  ])('no SSH server on a %s computer: one line, the step for it behind "How to turn on"', async (platform, words) => {
    await mount({ platform, opens: [{ ok: false, reason: 'connection', failure: 'no_ssh_server' }] })
    await click('Open in VS Code')
    expect(text()).toContain('No SSH server on Computer B')
    expect(text()).not.toContain(words)
    await click('How to turn on')
    expect(text()).toContain(words)
    expect(button('Retry')).toBeDefined()
  })

  it.each([
    ['host_untrusted', "Windows can't vouch for SSH on Computer B", 'How to fix'],
    ['no_host_key', 'No SSH host key on Computer B', 'How to fix'],
    ['limit', 'Too many connections to Computer B', 'Retry'],
    ['rate_limited', 'Too many tries on Computer B', 'Retry'],
    ['unsupported', 'Computer B needs a Mousse update', 'Retry'],
    ['timeout', 'Computer B did not answer', 'Retry']
  ] as const)('%s: one line and one action', async (failure, line, action) => {
    await mount({ platform: 'win32', opens: [{ ok: false, reason: 'connection', failure }] })
    await click('Open in VS Code')
    expect(text()).toContain(line)
    expect(button(action)).toBeDefined()
    expect(host.querySelectorAll('.side-card-open-editor-note p').length).toBeLessThanOrEqual(1)
  })

  it('a sign-in check that did not pass is a hint after the editor started, never a refusal', async () => {
    await mount({ opens: [{ ok: true, via: { path: 'direct', transport: 'direct' }, advice: { failure: 'key_refused', command: 'ssh-copy-id mousse-workbox-3fa2c1' } }] })
    await click('Open in VS Code')
    expect(openRemote).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Computer B may ask for a key')
    expect(button('Retry')).toBeUndefined()
    expect(text()).not.toContain('ssh-copy-id')
    await click('How to fix')
    expect(text()).toContain('ssh-copy-id mousse-workbox-3fa2c1')
  })

  it.each([
    ['ssh_check_failed', 'could not read the settings Mousse wrote'],
    ['unwritable', 'read-only for this account'],
    ['not_owner', 'belongs to another account']
  ])('the settings Mousse keeps here, %s: one line, the reason and the line to add behind "How to fix"', async (problem, words) => {
    await mount({ opens: [{ ok: false, reason: 'ssh_settings', code: problem, message: 'detail', includeLine: 'Include ~/.mousse/ssh/config' }] })
    await click('Open in VS Code')
    expect(text()).toContain('Could not update ~/.ssh/config')
    expect(text()).not.toContain(words)
    await click('How to fix')
    expect(text()).toContain(words)
    expect(text()).toContain('Include ~/.mousse/ssh/config')
    expect(button('Retry')).toBeDefined()
  })

  it('offline: said before any click, and Retry looks again', async () => {
    await mount({ device: { state: 'closed' }, opens: [{ ok: false, reason: 'connection', failure: 'offline' }] })
    expect(text()).toContain('Computer B offline')
    expect(openRemote).not.toHaveBeenCalled()
    await click('Retry')
    expect(openRemote).toHaveBeenCalledTimes(1)
    expect(text()).toContain('Computer B offline')
  })

  it('a computer that went offline after an answer is offline now, not what the old answer said', async () => {
    await mount({ opens: [{ ok: false, reason: 'connection', failure: 'host_untrusted' }] })
    await click('Open in VS Code')
    expect(text()).toContain("Windows can't vouch")
    state.devices = state.devices.map((entry) => (entry.node === NODE ? { ...entry, state: 'closed' } : entry))
    act(() => root.render(createElement(OpenInRemoteEditor, { threadId: THREAD, node: NODE, computer: 'Computer B', profileId: 'p1' })))
    await settle()
    expect(text()).toContain('Computer B offline')
    expect(text()).not.toContain("Windows can't vouch")
  })

  it('a computer this one is trying to reach again is not connected either, as everywhere else in the app', async () => {
    await mount({ device: { state: 'connecting' } })
    expect(text()).toContain('Computer B offline')
  })

  it('opens with a small hint when the editor’s Remote - SSH extension may be missing, never blocking', async () => {
    await mount({ opens: [{ ok: true, hint: 'If VS Code asks for the Remote - SSH extension, install ms-vscode-remote.remote-ssh, then open this folder again.' }] })
    await click('Open in VS Code')
    expect(text()).toContain('Remote - SSH may be needed')
    expect(titles().join(' ')).toContain('install ms-vscode-remote.remote-ssh')
    expect(openRemote).toHaveBeenCalledTimes(1)
    expect(button('Retry')).toBeUndefined()
  })

  it('keeps the way to approve an SSH address that a computer offers, for computers set up that way', async () => {
    state.route = 'none'
    await mount({ device: { sshOffer: { endpoint: 'dev@box.example.com:22' } } })
    expect(text()).toContain('Computer B offers SSH (dev@box.example.com:22)')
    expect(button('Approve address…')).toBeDefined()
    expect(text()).not.toMatch(/needs to reach it over SSH|Mousse sets SSH up only on Linux/)
  })

  it('with no connection of any kind, one line and a way to Devices at that computer', async () => {
    state.route = 'none'
    await mount()
    expect(text()).toContain('No connection to Computer B')
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

  it('no state in the side card is a paragraph', async () => {
    const failures = ['offline', 'blocked', 'setting_off', 'capability', 'net_off', 'no_ssh_server', 'no_host_key', 'host_untrusted', 'limit', 'rate_limited', 'unsupported', 'timeout', 'far_end_error'] as const
    for (const failure of failures) {
      await mount({ opens: [{ ok: false, reason: 'connection', failure }] })
      await click('Open in VS Code')
      const note = host.querySelector('.side-card-open-editor-note')?.textContent ?? ''
      expect(note.length, `${failure}: ${note}`).toBeLessThan(80)
      act(() => root.unmount())
      root = createRoot(host)
    }
  })
})
