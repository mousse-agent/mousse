import { describe, expect, it } from 'vitest'
import { describeStatus, type InstanceSnapshot } from '../../src/shared/harness/status'

type Overrides = { [K in keyof InstanceSnapshot]?: InstanceSnapshot[K] extends object ? Partial<InstanceSnapshot[K]> : InstanceSnapshot[K] }

/** A checked, enabled, signed-in Claude Code instance; each case changes one axis. */
function snapshot(overrides: Overrides = {}): InstanceSnapshot {
  const base: InstanceSnapshot = {
    instanceId: 'claude',
    driver: 'claude',
    displayName: 'Claude Code',
    builtIn: true,
    scope: { kind: 'device' },
    enabled: { device: true, effective: true, setBy: 'device' },
    install: { state: 'installed', canInstall: false },
    runs: { state: 'yes' },
    auth: { state: 'signed_in', account: { id: 'acct-1', label: 'Max plan' } },
    compatibility: { state: 'tested' },
    binary: { path: '/usr/local/bin/claude', version: '2.1.0', source: 'path' },
    caps: {
      steer: 'native', interrupt: true, rollback: 'none', fork: 'native', events: 'rich',
      containment: 'weak', historyInjection: 'native', mcp: true, childPolicy: 'enforced', planMode: true, contextUsage: 'reported'
    },
    models: { entries: [], source: 'live' },
    checkedAt: '2026-10-25T10:00:00.000Z',
    stale: false,
    lastGoodAt: '2026-10-25T10:00:00.000Z'
  }
  const merged = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(overrides)) {
    const current = (base as unknown as Record<string, unknown>)[key]
    merged[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object'
      ? { ...current, ...value }
      : value
  }
  return merged as unknown as InstanceSnapshot
}

describe('describeStatus', () => {
  const cases: Array<[string, Overrides, { headline: string; tone: string; action: string | null }]> = [
    ['signed in shows the account', {}, { headline: 'Signed in · Max plan', tone: 'ready', action: null }],
    ['no sign-in needed is available', { auth: { state: 'not_required', account: undefined } }, { headline: 'Available', tone: 'ready', action: null }],
    ['off on the device', { enabled: { device: false, effective: false, setBy: 'device' } }, { headline: 'Disabled', tone: 'disabled', action: 'enable' }],
    ['off for the project', { scope: { kind: 'project', projectId: 'p1' }, enabled: { device: true, project: false, effective: false, setBy: 'project' } }, { headline: 'Disabled', tone: 'disabled', action: 'enable' }],
    ['installing', { install: { state: 'installing', operationId: 'op-1', progress: { message: 'Downloading 40%' } } }, { headline: 'Installing', tone: 'neutral', action: 'cancel_install' }],
    ['never checked', { checkedAt: undefined, lastGoodAt: undefined }, { headline: 'Checking provider status', tone: 'neutral', action: null }],
    ['override that does not run', { runs: { state: 'no', failure: 'override_not_found' }, binary: { path: 'C:\\tools\\claude.exe', source: 'override' } }, { headline: 'Override not found', tone: 'error', action: 'fix_override' }],
    ['not installed, Mousse can install', { install: { state: 'not_installed', canInstall: true }, runs: { state: 'no', failure: 'not_on_path' } }, { headline: 'Not found', tone: 'warning', action: 'install' }],
    ['not installed, user installs', { install: { state: 'not_installed' }, runs: { state: 'no', failure: 'not_on_path' } }, { headline: 'Not found', tone: 'warning', action: 'recheck' }],
    ['broken install', { install: { state: 'broken', canInstall: true } }, { headline: 'Install is broken', tone: 'error', action: 'install' }],
    ['binary exits on start', { runs: { state: 'no', failure: 'exited', message: 'claude exited with code 1' } }, { headline: 'Unavailable', tone: 'error', action: 'recheck' }],
    ['signed out is neutral', { auth: { state: 'signed_out', account: undefined } }, { headline: 'Not signed in', tone: 'neutral', action: 'sign_in' }],
    ['signed out does not repeat the method', { auth: { state: 'signed_out', account: undefined, methodLabel: 'Claude Code sign-in' } }, { headline: 'Not signed in', tone: 'neutral', action: 'sign_in' }],
    ['expired sign-in', { auth: { state: 'expired' } }, { headline: 'Sign-in expired', tone: 'warning', action: 'sign_in' }],
    ['refreshing sign-in', { auth: { state: 'refreshing' } }, { headline: 'Refreshing sign-in', tone: 'neutral', action: null }],
    ['sign-in not checked', { auth: { state: 'unknown', account: undefined } }, { headline: 'Installed · Sign-in not checked', tone: 'neutral', action: 'recheck' }],
    ['runs unknown', { runs: { state: 'unknown' } }, { headline: 'Needs attention', tone: 'warning', action: 'recheck' }],
    ['install unknown is not reported as installed', { install: { state: 'unknown' }, runs: { state: 'unknown' }, auth: { state: 'unknown' } }, { headline: 'Needs attention', tone: 'warning', action: 'recheck' }],
    ['known broken version', { compatibility: { state: 'known_broken' }, update: { kind: 'one_click', owner: 'npm' } }, { headline: 'Known broken version', tone: 'error', action: 'update' }],
    ['too old', { compatibility: { state: 'too_old', testedRange: '>=2.0.0' }, update: { kind: 'advisory', command: 'npm i -g @anthropic-ai/claude-code' } }, { headline: 'Unsupported version', tone: 'warning', action: 'update' }],
    ['newer than tested never blocks', { compatibility: { state: 'newer_than_tested', testedRange: '2.0–2.1' } }, { headline: 'Signed in · Max plan', tone: 'ready', action: null }],
    ['one-click update', { update: { kind: 'one_click', owner: 'npm', latestVersion: '2.2.0' } }, { headline: 'Signed in · Max plan', tone: 'ready', action: 'update' }],
    ['stale without a good check', { stale: true, checkedAt: undefined, lastGoodAt: undefined }, { headline: 'Status unknown', tone: 'warning', action: 'recheck' }]
  ]

  it.each(cases)('%s', (_name, overrides, expected) => {
    const status = describeStatus(snapshot(overrides))
    expect({ headline: status.headline, tone: status.tone, action: status.nextStep?.action ?? null }).toEqual(expected)
  })

  it('keeps the last good status when a check times out', () => {
    const status = describeStatus(snapshot({ stale: true, runs: { state: 'yes' } }))
    expect(status).toMatchObject({ headline: 'Signed in · Max plan', tone: 'ready', nextStep: { action: 'recheck' } })
    expect(status.detail).toMatch(/last good status/)
  })

  it('names the override path that failed', () => {
    const status = describeStatus(snapshot({ runs: { state: 'no', failure: 'override_not_found' }, binary: { path: '/opt/claude', source: 'override' } }))
    expect(status.detail).toContain('/opt/claude')
  })

  it('gives an advisory update as a command to copy', () => {
    const status = describeStatus(snapshot({ compatibility: { state: 'too_old' }, update: { kind: 'advisory', command: 'brew upgrade codex' } }))
    expect(status.nextStep).toEqual({ action: 'update', label: 'Copy update command', command: 'brew upgrade codex' })
  })

  it('says an update is available for an unproven owner, with no step to take', () => {
    const status = describeStatus(snapshot({ update: { kind: 'notice', latestVersion: '2.2.0' } }))
    expect(status).toMatchObject({ headline: 'Signed in · Max plan', tone: 'ready', detail: 'Update available: 2.2.0.', nextStep: null })
  })

  it("uses the driver's wording when it names the same step", () => {
    const hint = { action: 'sign_in' as const, label: 'Run claude auth login', command: 'claude auth login' }
    expect(describeStatus(snapshot({ auth: { state: 'signed_out' }, nextStep: hint })).nextStep).toEqual(hint)
    expect(describeStatus(snapshot({ runs: { state: 'unknown' }, nextStep: hint })).nextStep).toEqual({ action: 'recheck', label: 'Check again' })
  })

  it('shows install progress', () => {
    const status = describeStatus(snapshot({ install: { state: 'installing', progress: { message: 'Verifying' } } }))
    expect(status).toMatchObject({ headline: 'Installing', detail: 'Verifying', nextStep: null })
  })
})
