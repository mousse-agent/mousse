import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  askOutcomeWords,
  editorConnectionHelp,
  helpForOpenResult,
  installSshServerWords,
  openedWords,
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

describe('why an editor cannot open a folder of another computer, state by state', () => {
  it('offline: says so, and offers to try again', () => {
    expect(help('offline')).toMatchObject({
      message: 'Computer B is offline.',
      next: 'Turn it on or reconnect it, then try again.',
      actions: [{ kind: 'retry', label: 'Try again' }]
    })
  })

  it('editor connections off: says it is shell access that Computer B has to allow, and offers to Ask it', () => {
    const state = help('editor_off')
    expect(state.message).toBe('Editor connections from this computer are off on Computer B.')
    expect(state.next).toContain('shell access')
    expect(state.actions).toEqual([{ kind: 'ask', label: 'Ask Computer B' }])
  })

  it('no SSH server: names what to do on that computer’s system, and says the files can still be browsed', () => {
    const windows = help('no_ssh_server', { platform: 'win32' })
    expect(windows.message).toBe('Computer B has no SSH server running.')
    expect(windows.next).toContain('install OpenSSH Server')
    const mac = help('no_ssh_server', { platform: 'darwin' })
    expect(mac.next).toContain('turn on Remote Login')
    const linux = help('no_ssh_server', { platform: 'linux' })
    expect(linux.next).toContain('install openssh-server')
    for (const state of [windows, mac, linux, help('no_ssh_server')]) {
      expect(state.next).toContain('browse and edit its files in the Files panel')
      expect(state.actions.map((action) => action.kind)).toEqual(['retry'])
    }
    // An unknown system still gets a next step.
    expect(help('no_ssh_server').next).toContain('install an SSH server')
    expect(installSshServerWords(B, 'win32')).not.toContain('Remote Login')
  })

  it('an SSH server that is not Windows’ own: says why Mousse does not vouch for it and what to do', () => {
    const state = help('host_untrusted', { platform: 'win32' })
    expect(state.message).toContain('does not vouch for it')
    expect(state.next).toContain('OpenSSH Server from Windows')
    expect(state.next).toContain('C:\\ProgramData\\ssh')
    expect(state.actions.map((action) => action.kind)).toEqual(['retry'])
  })

  it('no host key: says what to do on each system', () => {
    expect(help('no_host_key', { platform: 'win32' }).next).toContain('start the OpenSSH SSH Server service')
    expect(help('no_host_key', { platform: 'linux' }).next).toContain('ssh-keygen -A')
    expect(help('no_host_key', { platform: 'darwin' }).next).toContain('ssh-keygen -A')
    expect(help('no_host_key').message).toBe('Mousse cannot read the SSH host key of Computer B.')
  })

  it('limit and rate limit: say what to wait for or close', () => {
    expect(help('limit').next).toContain('Close an editor window')
    expect(help('rate_limited').next).toBe('Wait a minute, then try again.')
    expect(kinds('limit')).toEqual(['retry'])
    expect(kinds('rate_limited')).toEqual(['retry'])
  })

  it('blocked, switched off and not allowed: say where to change it, with no Ask for a blocked computer', () => {
    expect(help('blocked').message).toBe('Computer B has blocked this computer.')
    expect(help('blocked').next).toContain('Unblock this computer in Settings, Devices on Computer B')
    expect(kinds('blocked')).not.toContain('ask')
    expect(help('setting_off').next).toContain('Let my other computers work on this computer')
    expect(help('capability').next).toContain('Works on threads')
    expect(kinds('capability')).toEqual(['retry', 'devices'])
    expect(help('net_off').message).toBe('Mousse Net is turned off on Computer B.')
  })

  it('a refused key: gives the command to run, or says which file to add the key to', () => {
    const withCommand = help('key_refused', { command: 'ssh-copy-id mousse-workbox-3fa2c1' })
    expect(withCommand.message).toBe('The SSH server on Computer B did not accept this computer\'s key.')
    expect(withCommand.command).toEqual({ text: 'ssh-copy-id mousse-workbox-3fa2c1', label: 'Copy command' })
    const withoutCommand = help('key_refused')
    expect(withoutCommand.command).toBeUndefined()
    expect(withoutCommand.next).toContain('authorized_keys')
  })

  it('a failed sign-in: shows the line ssh itself printed', () => {
    const state = help('ssh_failed', { message: 'Host key verification failed.' })
    expect(state.detail).toBe('Host key verification failed.')
    expect(state.actions.map((action) => action.kind)).toEqual(['retry'])
  })

  it('every reason a connection can fail with has words and a next step, and none is a dead end', () => {
    const all: EditorConnectionFailure[] = [...TUNNEL_REASONS, ...TUNNEL_LOCAL_FAILURES, 'key_refused', 'ssh_failed']
    for (const failure of all) {
      const state = help(failure, { platform: 'linux' })
      expect(state.message.length, failure).toBeGreaterThan(10)
      expect(state.message, failure).toContain('Computer B')
      expect(state.next ?? state.command, failure).toBeTruthy()
      expect(state.actions.length, failure).toBeGreaterThan(0)
      // No jargon of the plan, no promise of a later feature.
      expect(`${state.message} ${state.next}`, failure).not.toMatch(/SSH route|arrives|not implemented|tunnel\.v1/)
    }
  })
})

describe('the settings Mousse keeps on this computer, from the first PR of this set', () => {
  const line = 'Include ~/.mousse/ssh/config'
  const refused = (code: string, includeLine?: string): Extract<RemoteOpenResult, { ok: false }> => ({ ok: false, reason: 'ssh_settings', code, message: 'detail', ...(includeLine ? { includeLine } : {}) })

  it.each([
    ['unwritable', 'read-only for this account'],
    ['not_owner', 'belongs to another account'],
    ['ssh_check_failed', 'could not read the settings Mousse wrote']
  ])('%s: says so, offers the exact line to copy, and a way to try again', (code, words) => {
    const state = helpForOpenResult(refused(code, line), B)!
    expect(state.message).toContain(words)
    expect(state.command).toEqual({ text: line, label: 'Copy line' })
    expect(state.actions.map((action) => action.kind)).toEqual(['retry'])
  })

  it('without a line to add, still says what to do next', () => {
    const state = helpForOpenResult(refused('off'), B)!
    expect(state.message).toBe('detail')
    expect(state.next).toBe('Fix that, then try again.')
  })

  it('leaves the refusals that are not about a connection to their own words', () => {
    expect(helpForOpenResult({ ok: false, reason: 'folder_missing' }, B)).toBeUndefined()
    expect(helpForOpenResult({ ok: false, reason: 'failed', message: 'x' }, B)).toBeUndefined()
  })

  it('words a refused connection from the result of an open, with the system the computer reported', () => {
    expect(helpForOpenResult({ ok: false, reason: 'connection', failure: 'no_ssh_server' }, B, 'darwin')!.next).toContain('Remote Login')
    expect(helpForOpenResult({ ok: false, reason: 'connection', failure: 'ssh_failed', message: 'boom' }, B)!.detail).toBe('boom')
  })
})

describe('what asking Computer B comes to', () => {
  const self = 'nod_abcdefghijklmnopqrstuvwxyz234567'
  it('says it was asked, and that the folder can be opened again once someone there allows it', () => {
    const asked = askOutcomeWords({ ok: true, reply: { state: 'asked', expiresAt: 1 } }, B, self)
    expect(asked.message).toBe('Asked Computer B.')
    expect(asked.next).toContain('When someone there allows it, open the folder again.')
    expect(asked.actions.map((action) => action.kind)).toEqual(['retry'])
  })

  it('gives a computer with no screen the command to run on it', () => {
    const asked = askOutcomeWords({ ok: true, reply: { state: 'asked', expiresAt: 1 } }, B, self)
    expect(asked.next).toContain('If Computer B has no screen, run this on it:')
    expect(asked.command).toEqual({ text: `mousse-cli bridge limits ${self} --editor on`, label: 'Copy command' })
    // Without this computer’s own id there is no command to give.
    expect(askOutcomeWords({ ok: true, reply: { state: 'asked', expiresAt: 1 } }, B).command).toBeUndefined()
  })

  it('says a waiting ask is still waiting, a "not now" was said, and too many asks were made', () => {
    expect(askOutcomeWords({ ok: true, reply: { state: 'pending', expiresAt: 1 } }, B).message).toBe('Computer B has not answered your ask yet.')
    const declined = askOutcomeWords({ ok: true, reply: { state: 'declined_recently', retryAt: 1 } }, B, self)
    expect(declined.message).toBe('Computer B said not now.')
    expect(declined.next).toContain('Settings, Devices on Computer B')
    expect(askOutcomeWords({ ok: true, reply: { state: 'rate_limited', retryAt: 1 } }, B).message).toBe('You have asked Computer B a few times already.')
  })

  it('says the switch is already on, and then opens again', () => {
    const on = askOutcomeWords({ ok: true, reply: { state: 'already_on' } }, B, self)
    expect(on.message).toBe('Computer B already allows editor connections from this computer.')
    expect(on.command).toBeUndefined()
  })

  it('tells a blocked computer it is blocked and never offers the Ask again', () => {
    const blocked = askOutcomeWords({ ok: false, failure: 'blocked' }, B, self)
    expect(blocked.message).toBe('Computer B has blocked this computer.')
    expect(blocked.actions.map((action) => action.kind)).not.toContain('ask')
    const offline = askOutcomeWords({ ok: false, failure: 'offline' }, B)
    expect(offline.message).toBe('Computer B is offline.')
    // A computer that cannot be asked at all is not offered an Ask it would refuse.
    expect(askOutcomeWords({ ok: false, failure: 'editor_off' }, B).actions.map((action) => action.kind)).not.toContain('ask')
  })
})

describe('how an open is said once it went through', () => {
  it('says how the connection runs, and labels the hosted relay "Mousse relay"', () => {
    expect(viaWords({ path: 'relay', transport: 'plus-relay' })).toBe('Mousse relay')
    expect(viaWords({ path: 'relay', transport: 'relay' })).toBe('Mousse relay')
    expect(viaWords({ path: 'direct', transport: 'tailscale' })).toBe('Tailscale')
    expect(viaWords({ path: 'direct', transport: 'direct' })).toBe('a direct connection')
    expect(openedWords(B, { path: 'relay', transport: 'plus-relay' })).toBe('Opening on Computer B through Mousse relay.')
    expect(openedWords(B)).toBe('Opening on Computer B.')
  })
})

describe('the state under the editor button, as it renders', () => {
  const noop = () => undefined
  const code = { id: 'vscode', label: 'VS Code', kind: 'editor', remote: true } as const

  it('shows the sentence, the next step and one button for each action', () => {
    const state = help('editor_off')
    const markup = renderToStaticMarkup(
      createElement(EditorStateNote, { help: state, actions: state.actions.map((action) => ({ key: action.kind, label: action.label, onClick: noop })) })
    )
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Editor connections from this computer are off on Computer B.')
    expect(markup).toContain('shell access')
    expect(markup).toContain('data-action="ask"')
    expect(markup).toContain('Ask Computer B')
  })

  it('shows a command with a copy button, and what ssh printed', () => {
    const state = help('key_refused', { command: 'ssh-copy-id mousse-a' })
    const markup = renderToStaticMarkup(createElement(EditorStateNote, { help: state, actions: [] }))
    expect(markup).toContain('<code>ssh-copy-id mousse-a</code>')
    expect(markup).toContain('Copy command')
    const failed = renderToStaticMarkup(createElement(EditorStateNote, { help: help('ssh_failed', { message: 'Connection reset' }), actions: [] }))
    expect(failed).toContain('Connection reset')
  })

  it('is a status, not an alert, for progress and for the answer to an ask', () => {
    const markup = renderToStaticMarkup(createElement(EditorStateNote, { help: { message: 'Asked Computer B.' }, actions: [], tone: 'status' }))
    expect(markup).toContain('role="status"')
    expect(markup).not.toContain('role="alert"')
  })

  it('sits under the button of the editor item, whose button stays usable', () => {
    const state = help('no_ssh_server', { platform: 'win32' })
    const markup = renderToStaticMarkup(
      createElement(OpenInEditorView, {
        path: B,
        editors: [code],
        lastId: null,
        onOpen: async () => undefined,
        extra: createElement(EditorStateNote, { help: state, actions: state.actions.map((action) => ({ key: action.kind, label: action.label, onClick: noop })) })
      })
    )
    expect(markup).toContain('Open in VS Code')
    expect(markup).toContain('Computer B has no SSH server running.')
    expect(markup).toContain('install OpenSSH Server')
    expect(markup).toContain('Try again')
    expect(markup).not.toContain('aria-disabled')
  })
})
