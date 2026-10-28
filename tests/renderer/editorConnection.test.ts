import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  askOutcomeWords,
  editorConnectionHelp,
  helpForOpenResult,
  installSshServerWords,
  openedWords,
  signInAdvice,
  viaWords
} from '../../src/renderer/lib/editorConnection'
import { EditorStateNote } from '../../src/renderer/components/sideCard/EditorStateNote'
import { OpenInEditorView } from '../../src/renderer/components/sideCard/EditorMenuButton'
import { TUNNEL_REASONS, TUNNEL_LOCAL_FAILURES } from '../../src/shared/net/tunnel'
import type { EditorConnectionFailure, RemoteOpenResult } from '../../src/shared/remoteEditor'

const B = 'Computer B'
const help = (failure: EditorConnectionFailure, extra: { platform?: string; message?: string; command?: string } = {}) =>
  editorConnectionHelp({ failure, computer: B, ...extra })
const kinds = (failure: EditorConnectionFailure, extra = {}) => help(failure, extra).actions.map((action) => action.kind)

/** The side card shows a line and an action: nothing that reads as a paragraph. */
const terse = (text: string) => text.length <= 60 && !/[.!?] [A-Z]/.test(text)

describe('why an editor cannot open a folder of another computer, state by state', () => {
  it('offline: one line and Retry', () => {
    expect(help('offline')).toMatchObject({ message: 'Computer B offline', actions: [{ kind: 'retry', label: 'Retry' }] })
  })

  it('editor connections off: the action is Ask, and the warning is only a tooltip', () => {
    const state = help('editor_off')
    expect(state.message).toBe('Editor connections off on Computer B')
    expect(state.tip).toBe('Gives shell access')
    expect(state.actions).toEqual([{ kind: 'ask', label: 'Ask Computer B' }])
  })

  it('no SSH server: one line, with the step for that computer’s system behind "How to turn on"', () => {
    for (const platform of ['win32', 'darwin', 'linux', undefined]) {
      const state = help('no_ssh_server', { platform })
      expect(state.message).toBe('No SSH server on Computer B')
      expect(state.stepsLabel).toBe('How to turn on')
      expect(state.actions.map((action) => action.kind)).toEqual(['retry'])
    }
    expect(help('no_ssh_server', { platform: 'win32' }).steps).toContain('install OpenSSH Server')
    expect(help('no_ssh_server', { platform: 'darwin' }).steps).toContain('turn on Remote Login')
    expect(help('no_ssh_server', { platform: 'linux' }).steps).toContain('install openssh-server')
    expect(help('no_ssh_server').steps).toContain('install an SSH server')
    expect(installSshServerWords(B, 'win32')).not.toContain('Remote Login')
  })

  it('an SSH server that is not Windows’ own: one line, the folder and port steps behind "How to fix"', () => {
    const state = help('host_untrusted', { platform: 'win32' })
    expect(state.message).toBe("Windows can't vouch for SSH on Computer B")
    expect(state.steps).toContain('OpenSSH Server from Windows')
    expect(state.steps).toContain('C:\\ProgramData\\ssh')
    expect(state.stepsLabel).toBe('How to fix')
  })

  it('no host key: one line, the step for each system behind the link', () => {
    expect(help('no_host_key').message).toBe('No SSH host key on Computer B')
    expect(help('no_host_key', { platform: 'win32' }).steps).toContain('start the OpenSSH SSH Server service')
    expect(help('no_host_key', { platform: 'linux' }).steps).toContain('ssh-keygen -A')
    expect(help('no_host_key', { platform: 'darwin' }).steps).toContain('ssh-keygen -A')
  })

  it('limit and rate limit: a line, a tooltip and Retry', () => {
    expect(help('limit')).toMatchObject({ message: 'Too many connections to Computer B', tip: expect.stringContaining('Close an editor window') })
    expect(help('rate_limited')).toMatchObject({ message: 'Too many tries on Computer B', tip: 'Wait a minute.' })
    expect(kinds('limit')).toEqual(['retry'])
    expect(kinds('rate_limited')).toEqual(['retry'])
  })

  it('blocked, switched off and not allowed: a line, the place to change it as a tooltip, and no Ask for a blocked computer', () => {
    expect(help('blocked').message).toBe('Blocked by Computer B')
    expect(help('blocked').tip).toContain('Unblock this computer in Settings, Devices on Computer B')
    expect(kinds('blocked')).not.toContain('ask')
    expect(help('setting_off').tip).toContain('Let my other computers work on this computer')
    expect(help('capability').tip).toContain('Works on threads')
    expect(kinds('capability')).toEqual(['devices'])
    expect(help('net_off').message).toBe('Mousse Net off on Computer B')
  })

  it('a refused key: where the key goes for that system, and the command with its condition', () => {
    const withCommand = help('key_refused', { command: 'ssh-copy-id mousse-workbox-3fa2c1', platform: 'linux' })
    expect(withCommand.message).toBe('Computer B did not accept this key')
    expect(withCommand.command).toEqual({ text: 'ssh-copy-id mousse-workbox-3fa2c1', label: 'Copy command' })
    expect(withCommand.steps).toContain('~/.ssh/authorized_keys')
    expect(withCommand.steps).toContain('if Computer B accepts a password sign-in')
    // A Windows owner with an administrator account keeps the keys elsewhere.
    expect(help('key_refused', { platform: 'win32' }).steps).toContain('administrators_authorized_keys')
    expect(help('key_refused').command).toBeUndefined()
  })

  it('a failed sign-in: the line ssh itself printed is the tooltip', () => {
    expect(help('ssh_failed', { message: 'Host key verification failed.' })).toMatchObject({ message: 'Sign-in to Computer B failed', tip: 'Host key verification failed.' })
  })

  it('every reason a connection can fail with has one terse line and a way on, and none is a dead end', () => {
    const all: EditorConnectionFailure[] = [...TUNNEL_REASONS, ...TUNNEL_LOCAL_FAILURES, 'key_refused', 'ssh_failed']
    for (const failure of all) {
      const state = help(failure, { platform: 'linux' })
      expect(terse(state.message), `${failure}: ${state.message}`).toBe(true)
      expect(state.actions.length + (state.steps ? 1 : 0), failure).toBeGreaterThan(0)
      expect(state.message, failure).not.toMatch(/SSH route|arrives|not implemented|tunnel\.v1/)
      // Nothing that is explained at length hangs in the card: the long words are the tooltip or behind a link.
      expect(state.message.split(' ').length, failure).toBeLessThanOrEqual(9)
    }
  })
})

describe('the settings Mousse keeps on this computer', () => {
  const line = 'Include ~/.mousse/ssh/config'
  const refused = (code: string, includeLine?: string): Extract<RemoteOpenResult, { ok: false }> => ({ ok: false, reason: 'ssh_settings', code, message: 'detail', ...(includeLine ? { includeLine } : {}) })

  it.each([
    ['unwritable', 'read-only for this account'],
    ['not_owner', 'belongs to another account'],
    ['ssh_check_failed', 'could not read the settings Mousse wrote']
  ])('%s: one line, the reason and the exact line to copy behind "How to fix"', (code, words) => {
    const state = helpForOpenResult(refused(code, line), B)!
    expect(state.message).toBe('Could not update ~/.ssh/config')
    expect(state.steps).toContain(words)
    expect(state.stepsLabel).toBe('How to fix')
    expect(state.command).toEqual({ text: line, label: 'Copy line' })
    expect(state.actions.map((action) => action.kind)).toEqual(['retry'])
  })

  it('without a line to add, the reason is still behind the link', () => {
    expect(helpForOpenResult(refused('off'), B)!.steps).toBe('detail')
  })

  it('leaves the refusals that are not about a connection to their own words', () => {
    expect(helpForOpenResult({ ok: false, reason: 'folder_missing' }, B)).toBeUndefined()
    expect(helpForOpenResult({ ok: false, reason: 'failed', message: 'x' }, B)).toBeUndefined()
  })

  it('words a refused connection from the result of an open, with the system the computer reported', () => {
    expect(helpForOpenResult({ ok: false, reason: 'connection', failure: 'no_ssh_server' }, B, 'darwin')!.steps).toContain('Remote Login')
    expect(helpForOpenResult({ ok: false, reason: 'connection', failure: 'ssh_failed', message: 'boom' }, B)!.tip).toBe('boom')
  })
})

describe('what asking Computer B comes to', () => {
  const self = 'nod_abcdefghijklmnopqrstuvwxyz234567'
  const asked = askOutcomeWords({ ok: true, reply: { state: 'asked', expiresAt: 1 } }, B, self)

  it('says "Asked · waiting" and offers Retry', () => {
    expect(asked.message).toBe('Asked · waiting')
    expect(asked.actions.map((action) => action.kind)).toEqual(['retry'])
  })

  it('keeps the command for a computer with no screen behind "No screen on Computer B?", beside Retry', () => {
    expect(asked.stepsLabel).toBe('No screen on Computer B?')
    expect(asked.stepsAlongside).toBe(true)
    expect(asked.command).toEqual({ text: `mousse-cli bridge limits ${self} --editor on`, label: 'Copy command' })
    // Without this computer’s own id there is no command to give.
    const alone = askOutcomeWords({ ok: true, reply: { state: 'asked', expiresAt: 1 } }, B)
    expect(alone.command).toBeUndefined()
    expect(alone.stepsLabel).toBeUndefined()
  })

  it('says a waiting ask is still waiting, a "not now" was said, and too many asks were made', () => {
    expect(askOutcomeWords({ ok: true, reply: { state: 'pending', expiresAt: 1 } }, B).message).toBe('Asked · waiting')
    const declined = askOutcomeWords({ ok: true, reply: { state: 'declined_recently', retryAt: 1 } }, B, self)
    expect(declined.message).toBe('Computer B said not now')
    expect(declined.tip).toContain('Settings, Devices on Computer B')
    expect(askOutcomeWords({ ok: true, reply: { state: 'rate_limited', retryAt: 1 } }, B).message).toBe('Asked too often')
  })

  it('says the switch is on, and offers to open', () => {
    const on = askOutcomeWords({ ok: true, reply: { state: 'already_on' } }, B, self)
    expect(on.message).toBe('Computer B allows it')
    expect(on.actions).toEqual([{ kind: 'retry', label: 'Open' }])
    expect(on.command).toBeUndefined()
  })

  it('tells a blocked computer it is blocked and never offers the Ask again', () => {
    const blocked = askOutcomeWords({ ok: false, failure: 'blocked' }, B, self)
    expect(blocked.message).toBe('Blocked by Computer B')
    expect(blocked.actions.map((action) => action.kind)).not.toContain('ask')
    expect(askOutcomeWords({ ok: false, failure: 'offline' }, B).message).toBe('Computer B offline')
    expect(askOutcomeWords({ ok: false, failure: 'editor_off' }, B).actions.map((action) => action.kind)).not.toContain('ask')
  })
})

describe('how an open is said once it went through', () => {
  it('is a small badge, and the hosted relay is labelled "Mousse relay"', () => {
    expect(viaWords({ path: 'relay', transport: 'plus-relay' })).toBe('Mousse relay')
    expect(viaWords({ path: 'relay', transport: 'relay' })).toBe('Mousse relay')
    expect(viaWords({ path: 'direct', transport: 'tailscale' })).toBe('Tailscale')
    expect(viaWords({ path: 'direct', transport: 'direct' })).toBe('direct')
    expect(openedWords({ path: 'relay', transport: 'plus-relay' })).toBe('via Mousse relay')
  })

  it('advises on a sign-in check that did not pass, as a hint with no action (the editor is open already)', () => {
    const key = signInAdvice({ failure: 'key_refused', command: 'ssh-copy-id mousse-a' }, B, 'linux')
    expect(key.message).toBe('Computer B may ask for a key')
    expect(key.actions).toEqual([])
    expect(key.command?.text).toBe('ssh-copy-id mousse-a')
    expect(signInAdvice({ failure: 'ssh_failed', message: 'Connection reset' }, B)).toMatchObject({ message: 'Sign-in check failed', tip: 'Connection reset', actions: [] })
  })
})

describe('the state under the editor button, as it renders', () => {
  const noop = () => undefined
  const code = { id: 'vscode', label: 'VS Code', kind: 'editor', remote: true } as const
  const actionsOf = (state: ReturnType<typeof help>) => state.actions.map((action) => ({ key: action.kind, label: action.label, onClick: noop }))

  it('shows the line and its action, with the long words as a tooltip', () => {
    const state = help('limit')
    const markup = renderToStaticMarkup(createElement(EditorStateNote, { help: state, actions: actionsOf(state) }))
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Too many connections to Computer B')
    expect(markup).toContain('title="Close an editor window connected to Computer B.')
    expect(markup).toContain('data-action="retry"')
    expect(markup).toContain('Retry')
  })

  it('hides the steps behind their link until it is opened, and has no action next to the link', () => {
    const state = help('no_ssh_server', { platform: 'win32' })
    const markup = renderToStaticMarkup(createElement(EditorStateNote, { help: state, actions: actionsOf(state) }))
    expect(markup).toContain('No SSH server on Computer B')
    expect(markup).toContain('How to turn on')
    expect(markup).not.toContain('install OpenSSH Server')
    expect(markup).not.toContain('Retry')
    const opened = renderToStaticMarkup(createElement(EditorStateNote, { help: state, actions: actionsOf(state), opened: true }))
    expect(opened).toContain('install OpenSSH Server')
    expect(opened).toContain('Retry')
  })

  it('shows a command with a copy button once its steps are open', () => {
    const state = help('key_refused', { command: 'ssh-copy-id mousse-a' })
    const hidden = renderToStaticMarkup(createElement(EditorStateNote, { help: state, actions: [] }))
    expect(hidden).not.toContain('ssh-copy-id')
    const markup = renderToStaticMarkup(createElement(EditorStateNote, { help: state, actions: [], opened: true }))
    expect(markup).toContain('<code>ssh-copy-id mousse-a</code>')
    expect(markup).toContain('Copy command')
  })

  it('keeps Retry in sight beside a side-path link (a computer with no screen)', () => {
    const state = askOutcomeWords({ ok: true, reply: { state: 'asked', expiresAt: 1 } }, B, 'nod_x')
    const markup = renderToStaticMarkup(createElement(EditorStateNote, { help: state, actions: actionsOf(state as never), tone: 'status' }))
    expect(markup).toContain('Asked · waiting')
    expect(markup).toContain('Retry')
    expect(markup).toContain('No screen on Computer B?')
    expect(markup).not.toContain('mousse-cli')
    expect(markup).toContain('role="status"')
  })

  it('sits under the button of the editor item, whose button stays usable', () => {
    const state = help('offline')
    const markup = renderToStaticMarkup(
      createElement(OpenInEditorView, {
        path: B,
        editors: [code],
        lastId: null,
        onOpen: async () => undefined,
        extra: createElement(EditorStateNote, { help: state, actions: actionsOf(state) })
      })
    )
    expect(markup).toContain('Open in VS Code')
    expect(markup).toContain('Computer B offline')
    expect(markup).not.toContain('aria-disabled')
  })

  it('can make the button itself the Ask, with the warning as its tooltip', () => {
    const markup = renderToStaticMarkup(
      createElement(OpenInEditorView, {
        path: B,
        editors: [code],
        lastId: null,
        onOpen: async () => undefined,
        primary: { label: 'Ask Computer B', title: 'Gives shell access', onClick: noop }
      })
    )
    expect(markup).toContain('Ask Computer B')
    expect(markup).toContain('title="Gives shell access"')
    expect(markup).not.toContain('Open in VS Code')
  })
})
