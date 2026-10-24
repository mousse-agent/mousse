import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CliProviderConfig } from '../src/shared/providerAuth'
import { CliConnectStep } from '../src/renderer/components/providers/AddProviderView'
import { CliProviderRow, type CliProviderRowProps } from '../src/renderer/components/providers/CliProviderRow'
import { CLI_PROVIDERS, cliHealth } from '../src/renderer/components/providers/cliProviders'
import type { CliInstall } from '../src/renderer/components/providers/useCliInstall'

const [claude, codex, antigravity] = CLI_PROVIDERS
const agy = (patch: Partial<CliProviderConfig> = {}): CliProviderConfig => ({ instanceId: 'antigravity', args: [], env: {}, ...patch })
const installed = agy({ resolvedBinaryPath: '/mousse/agy_acp_server', version: '1.1.1' })
const health = (config: CliProviderConfig | undefined, configured: boolean) =>
  cliHealth(antigravity, { claude: null, codex: null, config, configured })

describe('Antigravity health', () => {
  it('is Not installed, with the download explained, when there is no agent and no manual path', () => {
    const state = health(agy(), false)
    expect(state).toMatchObject({ health: 'attention', label: 'Not installed', action: 'install' })
    expect(state.detail).toContain("Mousse downloads Google's official Antigravity agent")
    expect(state.detail).toContain("Your agy CLI isn't used")
  })

  it('keeps naming the path when a manual path runs nothing', () => {
    expect(health(agy({ binaryPath: '/tmp/nope' }), false)).toMatchObject({
      label: 'Not found', detail: 'Nothing runs at /tmp/nope', action: 'install'
    })
  })

  it('is Signed out once installed, saying the agy CLI sign-in is not shared', () => {
    expect(health(installed, false)).toEqual({
      health: 'attention',
      label: 'Signed out',
      detail: "Sign in with Google here. Your agy CLI sign-in isn't shared.",
      action: 'sign-in'
    })
  })

  it('is Ready when installed and signed in', () => {
    expect(health(installed, true)).toEqual({ health: 'ready', label: 'Ready', detail: 'Signed in', action: 'sign-out' })
  })

  it('waits for the settings before judging, unless the daemon already lists it signed in', () => {
    expect(health(undefined, false)).toMatchObject({ label: 'Checking' })
    expect(health(undefined, true)).toMatchObject({ label: 'Ready' })
  })

  it('leaves Claude Code and Codex unchanged', () => {
    const missing = { instanceId: 'claude' as const, args: [], env: {} }
    expect(cliHealth(claude, { claude: null, codex: null, config: missing, configured: false })).toEqual({
      health: 'attention', label: 'Not found', detail: 'Claude Code is not installed'
    })
    expect(cliHealth(codex, { claude: null, codex: { state: 'signed_out', message: 'Run codex login' }, config: undefined, configured: false }))
      .toEqual({ health: 'attention', label: 'Signed out', detail: 'Run codex login' })
  })
})

const install = (patch: Partial<CliInstall> = {}): CliInstall => ({
  busy: false, progress: null, error: null, start: async () => undefined, cancel: async () => undefined, ...patch
})
const noop = async () => undefined
const row = (cli: typeof antigravity, props: Partial<CliProviderRowProps>) =>
  renderToStaticMarkup(createElement(CliProviderRow, {
    cli, enabled: true, open: true, onOpenChange: () => undefined, models: [],
    state: { health: 'unknown', label: 'Checking' }, onToggle: noop, onRemove: noop, onSaveConfig: noop,
    onRefreshModels: noop, onSignIn: noop, onRecheck: noop, ...props
  }))
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((match) => match[1]).filter(Boolean)
const antigravityRow = (config: CliProviderConfig | undefined, configured: boolean, extra: Partial<CliProviderRowProps> = {}) =>
  row(antigravity, { config, state: health(config, configured), install: install(), onInstall: noop, onSignOut: noop, ...extra })

describe('Antigravity row actions', () => {
  it('offers Install, and no sign-in, when not installed', () => {
    const html = antigravityRow(agy(), false)
    expect(buttons(html)).toContain('Install')
    expect(buttons(html)).not.toContain('Sign in')
    expect(buttons(html)).not.toContain('Sign out')
    expect(html).toContain('Your agy CLI isn&#x27;t used')
  })

  it('shows progress and Cancel while installing', () => {
    const html = antigravityRow(agy(), false, { install: install({ busy: true, progress: 'Downloading Google Antigravity ACP agent…' }) })
    expect(html).toContain('Downloading Google Antigravity ACP agent…')
    expect(buttons(html)).toContain('Cancel')
    expect(buttons(html)).not.toContain('Install')
  })

  it('shows an install error in the row', () => {
    const html = antigravityRow(agy(), false, { install: install({ error: 'Google download failed (503)' }) })
    expect(html).toContain('Google download failed (503)')
    expect(buttons(html)).toContain('Install')
  })

  it('offers Sign in, and no Install, when installed and signed out', () => {
    const list = buttons(antigravityRow(installed, false))
    expect(list).toContain('Sign in')
    expect(list).not.toContain('Install')
    expect(list).not.toContain('Sign out')
  })

  it('offers Sign out, and no Install, when ready', () => {
    const list = buttons(antigravityRow(installed, true))
    expect(list).toContain('Sign out')
    expect(list).not.toContain('Install')
    expect(list).not.toContain('Sign in')
  })

  it('keeps the Claude Code and Codex rows as they were', () => {
    const missing = row(claude, { config: { instanceId: 'claude', args: [], env: {} }, state: { health: 'attention', label: 'Not found', detail: 'Claude Code is not installed' } })
    expect(buttons(missing)).not.toContain('Install')
    expect(buttons(missing)).not.toContain('Sign in')
    const signedOut = row(codex, { state: { health: 'attention', label: 'Signed out', detail: 'Run codex login' } })
    expect(buttons(signedOut)).toContain('Sign in')
    expect(buttons(signedOut)).not.toContain('Sign out')
    const ready = row(codex, { state: { health: 'ready', label: 'Ready', detail: 'Signed in through your terminal' } })
    expect(buttons(ready)).not.toContain('Sign in')
    expect(buttons(ready)).not.toContain('Sign out')
  })
})

const step = (cli: typeof antigravity, config: CliProviderConfig | undefined, extra: Partial<Parameters<typeof CliConnectStep>[0]> = {}) =>
  renderToStaticMarkup(createElement(CliConnectStep, {
    cli, config, busy: false, disabled: false, error: null, install: install(), onAdd: () => undefined, onInstall: () => undefined, ...extra
  }))

describe('Add Antigravity step', () => {
  it('leads with Install and keeps the executable path behind a small option when not installed', () => {
    const html = step(antigravity, agy())
    expect(buttons(html)).toEqual(['Use an existing agent binary', 'Install'])
    expect(html).not.toContain('executable path')
    expect(buttons(html)).not.toContain('Add')
  })

  it('shows progress and Cancel while installing', () => {
    const html = step(antigravity, agy(), { install: install({ busy: true, progress: 'Verifying agent and local harness…' }) })
    expect(html).toContain('Verifying agent and local harness…')
    expect(buttons(html)).toEqual(['Cancel'])
  })

  it('shows an install error', () => {
    expect(step(antigravity, agy(), { install: install({ error: 'Google download failed (503)' }) })).toContain('Google download failed (503)')
  })

  it('adds without a path when already installed', () => {
    const html = step(antigravity, installed)
    expect(buttons(html)).toEqual(['Add'])
    expect(html).toContain('Antigravity executable path')
  })

  it('still asks for the executable for Claude Code when it is not found', () => {
    const html = step(claude, { instanceId: 'claude', args: [], env: {} })
    expect(html).toContain('Not found automatically')
    expect(buttons(html)).toEqual(['Add'])
  })
})
