import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { EditorSshSettingsView } from '../../src/renderer/components/devices/EditorSshSettings'
import { EditorSshNoticeView } from '../../src/renderer/components/sideCard/EditorSshNotice'
import { editorSshProblemWords, editorSshSwitch } from '../../src/renderer/lib/editorSsh'
import type { EditorSshStatus } from '../../src/shared/net/local'

const NOTICE = 'Mousse added an Include line to ~/.ssh/config so your editor can reach your other computers. You can remove it in Settings.'
const LINE = 'Include ~/.mousse/ssh/config'

const status = (patch: Partial<EditorSshStatus> = {}): EditorSshStatus => ({
  available: true,
  enabled: true,
  included: false,
  includeLine: LINE,
  userConfig: '~/.ssh/config',
  mousseConfig: '/home/me/.mousse/ssh/config',
  knownHosts: '/home/me/.mousse/ssh/known_hosts',
  noticePending: false,
  computers: [],
  ...patch
})

const html = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element)
const noop = () => {}

describe('the one-time notice after the Include line was added', () => {
  it('says what was added and offers Undo', () => {
    const out = html(createElement(EditorSshNoticeView, { status: status({ included: true, noticePending: true, notice: NOTICE }), onUndo: noop, onDismiss: noop }))
    expect(out).toContain('Mousse added an Include line to ~/.ssh/config so your editor can reach your other computers.')
    expect(out).toContain('Undo')
    expect(out).toContain('Got it')
    expect(out).toContain('role="status"')
  })

  it('shows nothing once it was seen, or before the status is read', () => {
    expect(html(createElement(EditorSshNoticeView, { status: status({ included: true }), onUndo: noop, onDismiss: noop }))).toBe('')
    expect(html(createElement(EditorSshNoticeView, { status: null, onUndo: noop, onDismiss: noop }))).toBe('')
  })

  it('shows why an undo failed', () => {
    const out = html(createElement(EditorSshNoticeView, { status: status({ noticePending: true, notice: NOTICE }), error: 'Could not remove the line.', onUndo: noop, onDismiss: noop }))
    expect(out).toContain('role="alert"')
    expect(out).toContain('Could not remove the line.')
  })
})

describe('why Mousse could not set up, in plain words', () => {
  it('names the file and the exact line to add by hand when it is read-only or belongs to someone else', () => {
    const readOnly = editorSshProblemWords({ code: 'unwritable', message: 'EACCES' }, LINE)
    expect(readOnly).toBe(`~/.ssh/config is read-only for this account, so Mousse left it alone. To add it yourself, put this line at the very top of ~/.ssh/config: ${LINE}`)
    const owner = editorSshProblemWords({ code: 'not_owner', message: 'x' }, LINE)
    expect(owner).toContain('belongs to another account')
    expect(owner).toContain(LINE)
  })

  it('says the ssh on this computer could not read the settings, and that nothing was changed', () => {
    const words = editorSshProblemWords({ code: 'ssh_check_failed', message: 'Bad permissions' }, LINE)
    expect(words).toContain('could not read the settings Mousse wrote')
    expect(words).toContain('left ~/.ssh/config as it was')
    expect(words).toContain(LINE)
  })

  it('says there is no ssh, and passes on messages that already say what to do', () => {
    expect(editorSshProblemWords({ code: 'no_ssh', message: 'x' }, LINE)).toContain('could not find ssh')
    expect(editorSshProblemWords({ code: 'off', message: 'Editor connections through ssh are off. Turn them on in Settings.' })).toBe('Editor connections through ssh are off. Turn them on in Settings.')
  })

  it('leaves the line out when the daemon did not send one', () => {
    expect(editorSshProblemWords({ code: 'unwritable', message: 'x' })).not.toContain('Include')
  })
})

describe('the Settings switch', () => {
  it('is off and waits while editor connections do not exist yet', () => {
    const control = editorSshSwitch(status())
    expect(control.on).toBe(false)
    expect(control.disabled).toBe(true)
    expect(control.description).toContain('Not needed yet')
    expect(control.description).toContain('computers you set up over SSH open in your editor without it')
  })

  it('is on, and can be undone, while the line is in ~/.ssh/config', () => {
    const control = editorSshSwitch(status({ included: true }))
    expect(control).toMatchObject({ on: true, disabled: false })
    expect(control.description).toContain('On')
  })

  it('can be turned on again after an undo', () => {
    const control = editorSshSwitch(status({ enabled: false }))
    expect(control).toMatchObject({ on: false, disabled: false })
    expect(control.description).toContain('Mousse added nothing to ~/.ssh/config')
  })

  it('says to delete a line the person edited, and to move one that sits below a Host line', () => {
    expect(editorSshSwitch(status({ included: true, edited: true })).description).toContain('delete it from ~/.ssh/config yourself')
    expect(editorSshSwitch(status({ included: true, scoped: true })).description).toContain('move it to the top of ~/.ssh/config')
  })

  it('is unavailable when the build has no home to write to', () => {
    expect(editorSshSwitch(status({ available: false }))).toMatchObject({ on: false, disabled: true })
  })
})

describe('the Settings row', () => {
  const view = (patch: Partial<EditorSshStatus> | null, props: { busy?: boolean; error?: string } = {}) =>
    html(createElement(EditorSshSettingsView, { status: patch ? status(patch) : null, onToggle: noop, onDismissNotice: noop, ...props }))

  it('shows the switch under Editors', () => {
    const out = view({ included: true })
    expect(out).toContain('Editors')
    expect(out).toContain('Let my editor reach my other computers')
    expect(out).toContain('role="switch"')
    expect(out).toContain('aria-checked="true"')
  })

  it('shows nothing before the status is read or where it is unavailable', () => {
    expect(view(null)).toBe('')
    expect(view({ available: false })).toBe('')
  })

  it('keeps the notice with Undo in the row while it is pending', () => {
    const out = view({ included: true, noticePending: true, notice: NOTICE })
    expect(out).toContain('Mousse added an Include line')
    expect(out).toContain('Undo')
  })

  it('shows a problem found at rest, with the line to add by hand', () => {
    const out = view({ included: true, problem: { code: 'ssh_check_failed', message: 'Bad permissions' } })
    expect(out).toContain('role="alert"')
    expect(out).toContain('could not read the settings Mousse wrote')
    expect(out).toContain(LINE)
  })

  it('shows the failure of the last action', () => {
    expect(view({ enabled: false }, { error: '~/.ssh/config is read-only for this account, so Mousse left it alone.' })).toContain('read-only for this account')
  })
})
