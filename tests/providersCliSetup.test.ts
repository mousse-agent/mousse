import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { describeStatus, type InstanceSnapshot } from '../src/shared/harness/status'
import type { ProviderLoginOption } from '../src/shared/providerAuth'
import { AgentConnectStep, addChoices } from '../src/renderer/components/providers/AddProviderDialog'
import { AccountRow, BinaryRow, SetupRow, UpdateRow, type InstanceActions } from '../src/renderer/components/providers/CliSections'
import { displayModels, movedOrder } from '../src/renderer/components/providers/ProviderModelsSection'
import { AgentEditor, allowsCustomModels } from '../src/renderer/components/providers/ProviderEditor'
import { ProviderListRow } from '../src/renderer/components/providers/parts'
import { offersRedirectPaste, refusedText } from '../src/renderer/components/providers/SignInDialog'
import { switchStateOf } from '../src/renderer/components/providers/providerView'
import { model, snapshot, type SnapshotOverrides } from './providerSnapshotFixture'

const noop = async () => undefined
const actions: InstanceActions = {
  enable: noop, install: noop, cancelInstall: noop, update: noop, signIn: noop, signOut: noop, recheck: noop, configure: noop
}
const buttons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean)
const labels = (html: string) => [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1])

function setupRow(overrides: SnapshotOverrides) {
  const entry = snapshot(overrides)
  return renderToStaticMarkup(createElement(SetupRow, { snapshot: entry, status: describeStatus(entry), actions }))
}

describe('Setup row: the status and its one next step', () => {
  it('waits while the first check runs, with no buttons', () => {
    const html = setupRow({ checkedAt: undefined, lastGoodAt: undefined })
    expect(html).toContain('Checking provider status')
    expect(buttons(html)).toEqual([])
    expect(labels(html)).not.toContain('Check again')
  })

  it('offers Install as soon as an installable agent is known to be missing', () => {
    const html = setupRow({ driver: 'antigravity', install: { state: 'not_installed', canInstall: true }, runs: { state: 'no', failure: 'not_on_path' } })
    expect(buttons(html)).toEqual(['Install'])
    expect(html).toContain('CLI not detected on PATH.')
  })

  it('only offers Check again when the user installs the CLI', () => {
    const html = setupRow({ install: { state: 'not_installed', canInstall: false }, runs: { state: 'no', failure: 'not_on_path' } })
    expect(buttons(html)).toEqual([])
    expect(labels(html)).toContain('Check again')
  })

  it('shows install progress and Cancel while installing', () => {
    const html = setupRow({ install: { state: 'installing', operationId: 'op-1', canInstall: true, progress: { message: 'Downloading', fraction: 0.4 } } })
    expect(html).toContain('Downloading (40%)')
    expect(buttons(html)).toEqual(['Cancel'])
  })

  it('signs in with a button when Mousse runs the sign-in', () => {
    const html = setupRow({ driver: 'antigravity', auth: { state: 'signed_out', account: undefined } })
    expect(html).toContain('Not signed in')
    expect(buttons(html)).toEqual(['Sign in'])
  })

  it('shows the terminal command, not a button, when the CLI signs in by itself', () => {
    const html = setupRow({
      auth: { state: 'signed_out', account: undefined },
      nextStep: { action: 'sign_in', label: 'Sign in', command: 'claude' }
    })
    expect(buttons(html)).not.toContain('Sign in')
    expect(html).toContain('prov-command')
    expect(html).toContain('>claude</code>')
    expect(labels(html)).toContain('Check again')
  })

  it('says a terminal sign-in once: the short status, then the command (D4)', () => {
    const command = '$env:CLAUDE_CONFIG_DIR="C:\h"; claude auth login'
    const html = setupRow({
      auth: { state: 'signed_out', account: undefined, methodLabel: 'Claude Code sign-in', message: `Claude Code isn't signed in. Run \`${command}\` in a terminal, then check again.` },
      nextStep: { action: 'sign_in', label: 'Sign in', command }
    })
    expect(html).not.toContain('isn&#x27;t signed in')
    expect(html.split('claude auth login').length - 1).toBe(2) // the code text and its title
    expect(html).toContain('Run this in a terminal, then check again.')
  })

  it('offers to clear or change an override that does not run', () => {
    const html = setupRow({ runs: { state: 'no', failure: 'override_not_found' }, binary: { path: 'C:\\tools\\claude.exe', source: 'override' } })
    expect(html).toContain('Mousse cannot run C:\\tools\\claude.exe')
    expect(buttons(html)).toContain('Use the default')
    expect(labels(html)).toContain('Change path')
  })

  it('turns a switched-off instance back on', () => {
    expect(buttons(setupRow({ enabled: { device: false, effective: false, setBy: 'device' } }))).toEqual(['Turn on'])
  })

  it('shows the signed-in status and nothing more when ready (D7)', () => {
    const html = setupRow({ auth: { account: { id: 'a', label: 'ChatGPT Plus' } } })
    expect(html).toContain('Signed in · ChatGPT Plus')
    expect(buttons(html)).toEqual([])
    expect(labels(html)).toContain('Check again')
  })
})

describe('Runtime rows', () => {
  it('shows the resolved executable with its version and source', () => {
    const html = renderToStaticMarkup(createElement(BinaryRow, { snapshot: snapshot() }))
    expect(html).toContain('/usr/local/bin/claude')
    expect(html).toContain('v2.1.0 · Found on PATH · installed with npm')
  })

  it('says Not found once checked without a binary', () => {
    const html = renderToStaticMarkup(createElement(BinaryRow, { snapshot: snapshot({ binary: undefined }) }))
    expect(html).toContain('Not found')
  })

  it('offers a one-click update only with a proven owner', () => {
    const html = renderToStaticMarkup(createElement(UpdateRow, {
      snapshot: snapshot({ update: { kind: 'one_click', owner: 'npm', latestVersion: '2.2.0' } }), actions
    }))
    expect(html).toContain('is-one-click')
    expect(html).toContain('Update to v2.2.0')
    expect(buttons(html)).toEqual(['Update now'])
  })

  it('shows an advisory update as a command to copy, with no update button', () => {
    const html = renderToStaticMarkup(createElement(UpdateRow, {
      snapshot: snapshot({ update: { kind: 'advisory', command: 'npm i -g @anthropic-ai/claude-code', latestVersion: '2.2.0' } }), actions
    }))
    expect(html).toContain('is-advisory')
    expect(html).toContain('npm i -g @anthropic-ai/claude-code')
    expect(buttons(html)).not.toContain('Update now')
    expect(labels(html)).toContain('Copy update command')
  })

  it('renders nothing without an update', () => {
    expect(renderToStaticMarkup(createElement(UpdateRow, { snapshot: snapshot(), actions }))).toBe('')
  })
})

function listRow(entry: InstanceSnapshot, scope: Parameters<typeof switchStateOf>[1]) {
  return renderToStaticMarkup(createElement(ProviderListRow, {
    iconId: 'claude',
    name: entry.displayName,
    status: describeStatus(entry),
    toggle: switchStateOf(entry, scope),
    selected: false,
    onSelect: () => undefined,
    onToggle: noop,
    onReset: scope.kind === 'project' ? noop : undefined
  }))
}

describe('Scope: device ceiling and project overrides', () => {
  const project = { kind: 'project', projectId: 'p1' } as const

  it('shows no override marker on the device', () => {
    const html = listRow(snapshot(), { kind: 'device' })
    expect(labels(html)).not.toContain('Overridden for this project. Show where this value comes from')
  })

  it('marks a project override and offers the reset to the device setting', () => {
    const entry = snapshot({ scope: project, enabled: { device: true, project: false, effective: false, setBy: 'project' } })
    const html = listRow(entry, project)
    expect(html).toContain('title="Overridden for this project"')
    expect(html).toContain('title="Reset to the device setting"')
    expect(html).toContain('>Disabled</span>')
    expect(html).toContain('is-off')
  })

  it('inherits without a marker when the project sets nothing', () => {
    const html = listRow(snapshot({ scope: project }), project)
    expect(html).not.toContain('Overridden for this project')
  })

  it('locks the switch in a project when the device has it off', () => {
    const entry = snapshot({ scope: project, enabled: { device: false, effective: false, setBy: 'device' } })
    expect(switchStateOf(entry, project)).toEqual({ checked: false, locked: true, overridden: false, deviceEnabled: false })
    expect(listRow(entry, project)).toContain('Turned off on this device. Turn it on for the device first.')
  })
})

describe('Sign-out', () => {
  const accountRow = (overrides: SnapshotOverrides) =>
    renderToStaticMarkup(createElement(AccountRow, { snapshot: snapshot(overrides), actions }))

  it('follows the daemon: offered only when the snapshot says Mousse owns the sign-in', () => {
    expect(buttons(accountRow({}))).toEqual([])
    expect(buttons(accountRow({ auth: { canSignOut: false } }))).toEqual([])
    expect(buttons(accountRow({ auth: { canSignOut: true } }))).toEqual(['Sign out'])
    expect(accountRow({ auth: { state: 'signed_out', account: undefined, canSignOut: true } })).toBe('')
  })

  it('shows the account by its label, never its hashed id', () => {
    expect(accountRow({ auth: { account: { id: 'h4sh', label: 'ChatGPT Plus' }, methodLabel: 'ChatGPT sign-in' } })).toContain('ChatGPT Plus · ChatGPT sign-in')
    const unlabelled = accountRow({ auth: { account: { id: 'h4sh' }, methodLabel: 'Claude Code sign-in' } })
    expect(unlabelled).not.toContain('h4sh')
    expect(unlabelled).toContain('Claude Code sign-in')
  })
})

const loginOption = (id: string, patch: Partial<ProviderLoginOption> = {}): ProviderLoginOption =>
  ({ id, label: id, authType: 'api_key', configured: false, ...patch }) as ProviderLoginOption

describe('Add provider choices', () => {
  const claude = snapshot()
  const codex = snapshot({ instanceId: 'codex', driver: 'codex', displayName: 'Codex' })
  const antigravity = snapshot({ instanceId: 'antigravity', driver: 'antigravity', displayName: 'Antigravity', enabled: { device: false, effective: false, setBy: 'device' } })

  it('offers a second Claude Code account, turns a switched-off agent back on, and skips agents already on', () => {
    const choices = addChoices([claude, codex, antigravity], [])
    expect(choices.map((choice) => [choice.kind, choice.label])).toEqual([
      ['new', 'Claude Code · another account'],
      ['enable', 'Antigravity']
    ])
  })

  it('lists model APIs not connected yet, without the agents’ own sign-ins', () => {
    const choices = addChoices([claude, codex], [
      loginOption('claude-subscription', { authType: 'oauth' }),
      loginOption('codex', { authType: 'oauth' }),
      loginOption('openai'),
      loginOption('anthropic', { configured: true })
    ])
    expect(choices.filter((choice) => choice.kind === 'api').map((choice) => choice.label)).toEqual(['openai'])
  })

  it('shows a provider with several sign-in methods once, with its methods to choose from', () => {
    const choices = addChoices([claude, codex], [
      loginOption('github-copilot', { label: 'GitHub Copilot' }),
      loginOption('github-copilot', { label: 'GitHub Copilot', authType: 'oauth' }),
      loginOption('openai', { label: 'OpenAI' })
    ])
    const api = choices.filter((choice) => choice.kind === 'api')
    expect(api.map((choice) => [choice.label, choice.group])).toEqual([
      ['GitHub Copilot', 'Subscriptions'],
      ['OpenAI', 'API keys']
    ])
    const copilot = api[0] as Extract<(typeof api)[number], { kind: 'api' }>
    expect(copilot.options.map((option) => option.authType)).toEqual(['oauth', 'api_key'])
  })

  it('offers Install for a switched-off agent Mousse installs itself', () => {
    const missing = snapshot({
      instanceId: 'antigravity', driver: 'antigravity', displayName: 'Antigravity',
      enabled: { device: false, effective: false, setBy: 'device' },
      install: { state: 'not_installed', canInstall: true }, runs: { state: 'no' }, binary: undefined
    })
    const [choice] = addChoices([missing], []).filter((entry) => entry.kind === 'enable')
    const html = renderToStaticMarkup(createElement(AgentConnectStep, {
      choice: choice as Extract<typeof choice, { kind: 'enable' }>, busy: false, disabled: false, error: null, onAdd: () => undefined, onInstall: () => undefined
    }))
    expect(buttons(html)).toEqual(['Use an existing binary', 'Install'])
  })

  it('makes the path optional when the CLI was found', () => {
    const [choice] = addChoices([snapshot({ enabled: { device: false, effective: false, setBy: 'device' } })], [])
    const html = renderToStaticMarkup(createElement(AgentConnectStep, {
      choice: choice as Extract<typeof choice, { kind: 'enable' }>, busy: false, disabled: false, error: null, onAdd: () => undefined
    }))
    expect(html).toContain('placeholder="/usr/local/bin/claude"')
    expect(html).toContain('Optional. Leave empty to use the one Mousse finds.')
    expect(buttons(html)).toEqual(['Add'])
  })
})

describe('custom models', () => {
  it('are offered only where the daemon says the runtime can run one', () => {
    expect(allowsCustomModels(snapshot({ models: { canAddCustom: false } }))).toBe(false)
    expect(allowsCustomModels(snapshot({ models: { canAddCustom: true } }))).toBe(true)
    expect(allowsCustomModels(snapshot({ driver: 'antigravity' }))).toBe(false)
  })
})

describe('models section order', () => {
  const entries = [model('a'), model('b', { favorite: true }), model('c', { hidden: true }), model('d'), model('e', { favorite: true })]

  it('groups favorites, then the rest, then hidden, keeping the saved order inside each group', () => {
    expect(displayModels(entries).map((entry) => entry.id)).toEqual(['b', 'e', 'a', 'd', 'c'])
  })

  it('moves a model within its group only', () => {
    const display = displayModels(entries)
    expect(movedOrder(display, 'd', -1)).toEqual(['b', 'e', 'd', 'a', 'c'])
    expect(movedOrder(display, 'a', -1)).toBeNull()
    expect(movedOrder(display, 'c', -1)).toBeNull()
  })
})

describe('Sign-in dialog', () => {
  const link = (acceptsRedirectPaste?: boolean) =>
    ({ promptId: 'p1', type: 'auth_url', url: 'https://example.test/auth', usesCallbackServer: true, ...(acceptsRedirectPaste === undefined ? {} : { acceptsRedirectPaste }) }) as const

  it('offers the pasted address only while the sign-in accepts one', () => {
    expect(offersRedirectPaste(link(true))).toBe(true)
    expect(offersRedirectPaste(link(false))).toBe(false)
    expect(offersRedirectPaste(link())).toBe(false)
  })

  it('says why a refused answer did nothing', () => {
    expect(refusedText({ promptId: 'p1', kind: 'redirect_url', value: 'http://localhost/x' })).toContain('paste it here')
    expect(refusedText({ promptId: 'p2', kind: 'input', value: 'x' })).toContain('Try again')
  })
})

describe('Agent editor scope', () => {
  const editor = (scope: InstanceSnapshot['scope']) => {
    const entry = snapshot({ scope })
    return renderToStaticMarkup(createElement(AgentEditor, { snapshot: entry, status: describeStatus(entry), actions, onSaveModelPrefs: noop, onRefreshModels: noop }))
  }

  it('in a project scope, says runtime, environment and models apply to the whole device', () => {
    const notes = (html: string) => html.split('Applies to this device, in every project.').length - 1
    expect(notes(editor({ kind: 'project', projectId: 'p1' }))).toBe(3)
    expect(notes(editor({ kind: 'device' }))).toBe(0)
  })
})
