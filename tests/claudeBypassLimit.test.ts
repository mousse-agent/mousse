import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeAutoModeDisabled, claudeBypassDisabled } from '../src/mms/harness/vendors/claude/accountSubject'
import { CLAUDE_AUTO_MODE_DISABLED } from '../src/mms/harness/vendors/claude/ClaudeSubscriptionProviderService'
import { effectivePermissionMode, supportedPermissionModes } from '../src/shared/permissionMode'

/** Whether Claude Code's settings forbid bypassing permissions, read from the files it reads. */
describe('Claude bypass limit', () => {
  const read = (files: Record<string, string>) => (path: string) => {
    const text = files[path]
    if (text === undefined) throw new Error('ENOENT')
    return text
  }
  const disable = JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } })
  const check = (files: Record<string, string>, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
    claudeBypassDisabled(options.env ?? {}, { readText: read(files), home: '/users/me', platform: 'linux', ...(options.cwd ? { cwd: options.cwd } : {}) })

  it('is off when no settings file says otherwise', () => {
    expect(check({})).toBe(false)
    expect(check({ [join('/users/me', '.claude', 'settings.json')]: '{"permissions":{"allow":["Bash"]}}' })).toBe(false)
    expect(check({ [join('/users/me', '.claude', 'settings.json')]: 'not json' })).toBe(false)
  })

  it('reads the user settings, the instance config directory, and the managed policy', () => {
    expect(check({ [join('/users/me', '.claude', 'settings.json')]: disable })).toBe(true)
    // An instance with its own Claude home reads that home, not the user's.
    const env = { CLAUDE_CONFIG_DIR: '/homes/work' }
    expect(check({ [join('/users/me', '.claude', 'settings.json')]: disable }, { env })).toBe(false)
    expect(check({ [join('/homes/work', 'settings.json')]: disable }, { env })).toBe(true)
    expect(check({ '/etc/claude-code/managed-settings.json': disable })).toBe(true)
  })

  it('reads the project settings only when the turn has a folder', () => {
    const files = { [join('/work/app', '.claude', 'settings.local.json')]: disable }
    expect(check(files)).toBe(false)
    expect(check(files, { cwd: '/work/app' })).toBe(true)
    expect(check({ [join('/work/app', '.claude', 'settings.json')]: disable }, { cwd: '/work/app' })).toBe(true)
    expect(check(files, { cwd: '/work/other' })).toBe(false)
  })

  it('reads the files again every time, so an edit applies to the next turn', () => {
    const files: Record<string, string> = {}
    const settings = join('/users/me', '.claude', 'settings.json')
    expect(check(files)).toBe(false)
    files[settings] = disable
    expect(check(files)).toBe(true)
    delete files[settings]
    expect(check(files)).toBe(false)
  })
})

/** Whether Claude Code's settings turn its auto mode off: a thread set to Auto then runs as Auto-accept edits. */
describe('Claude auto mode limit', () => {
  const read = (files: Record<string, string>) => (path: string) => {
    const text = files[path]
    if (text === undefined) throw new Error('ENOENT')
    return text
  }
  const user = join('/users/me', '.claude', 'settings.json')
  const check = (files: Record<string, string>, cwd?: string) =>
    claudeAutoModeDisabled({}, { readText: read(files), home: '/users/me', platform: 'linux', ...(cwd ? { cwd } : {}) })

  it('reads disableAutoMode at the top level and in the permissions block, from the same files as the bypass limit', () => {
    expect(check({})).toBe(false)
    expect(check({ [user]: JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }) })).toBe(false)
    expect(check({ [user]: JSON.stringify({ disableAutoMode: 'disable' }) })).toBe(true)
    expect(check({ [user]: JSON.stringify({ permissions: { disableAutoMode: 'disable' } }) })).toBe(true)
    expect(check({ '/etc/claude-code/managed-settings.json': JSON.stringify({ disableAutoMode: 'disable' }) })).toBe(true)
    const project = { [join('/work/app', '.claude', 'settings.local.json')]: JSON.stringify({ disableAutoMode: 'disable' }) }
    expect(check(project)).toBe(false)
    expect(check(project, '/work/app')).toBe(true)
  })

  it('is reported by the Claude Code entry as Auto being unavailable, so the thread runs as Auto-accept edits', () => {
    const limits = { unavailable: { auto: CLAUDE_AUTO_MODE_DISABLED } }
    const supported = supportedPermissionModes({ toolControl: 'approval_only', autoPermissionMode: true }, limits)
    expect(effectivePermissionMode('auto', supported, { agent: 'Claude Code', limits })).toEqual({ mode: 'accept_edits', reason: CLAUDE_AUTO_MODE_DISABLED })
  })
})
