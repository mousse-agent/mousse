import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import {
  buildPermissionModeChangeNotice,
  DEFAULT_PERMISSION_MODE,
  describePermissionMode,
  effectivePermissionMode,
  getLastUserPermissionMode,
  isStricter,
  narrowPermissionMode,
  normalizePermissionMode,
  permissionCeilingOf,
  permissionModeAllows,
  supportedPermissionModes
} from '../src/shared/permissionMode'
import { BRIDGE_REMOTE_METHODS } from '../src/mms/bridge/remote/capabilities'
import type { DriverContext } from '../src/mms/harness/driver'
import { CODEX_CAPS, CODEX_PERMISSION_LIMITS, codexDriver } from '../src/mms/harness/drivers/codex'
import type { CodexProviderService } from '../src/mms/harness/vendors/codex/CodexProviderService'
import { acpPermissionKey,actionOf, piToolAction, PERMISSION_KEYS } from '../src/shared/permissionKeys'
import { getDefaultSettings, normalizePermissionSettings } from '../src/shared/settings'

describe('permission modes', () => {
  it('reads a missing or unknown value as the strictest mode, so an unreadable record never widens a thread', () => {
    expect(normalizePermissionMode('full')).toBe('full')
    expect(normalizePermissionMode('auto')).toBe('ask')
    expect(normalizePermissionMode(undefined)).toBe('ask')
    expect(normalizePermissionMode(3)).toBe('ask')
    // A profile that never chose a default gets the default; one that holds an unreadable value asks.
    expect(normalizePermissionSettings({}).defaultMode).toBe(DEFAULT_PERMISSION_MODE)
    expect(normalizePermissionSettings(undefined).defaultMode).toBe(DEFAULT_PERMISSION_MODE)
    expect(normalizePermissionSettings({ defaultMode: 'nope' as never }).defaultMode).toBe('ask')
  })

  it('defaults new threads to Auto-accept edits and keeps the profile default through a reload', () => {
    expect(getDefaultSettings().permissions).toEqual({ defaultMode: 'accept_edits' })
    const home = mkdtempSync(join(tmpdir(), 'mousse-permission-settings-'))
    try {
      const settings = new SettingsStore(MousseConfigStore.load(home))
      expect(settings.get().permissions.defaultMode).toBe('accept_edits')
      settings.set({ permissions: { defaultMode: 'ask' } })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().permissions).toEqual({ defaultMode: 'ask' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('narrows to the strictest mode', () => {
    expect(narrowPermissionMode('full', 'accept_edits')).toBe('accept_edits')
    expect(narrowPermissionMode('full', 'accept_edits', 'ask')).toBe('ask')
    expect(narrowPermissionMode('full', undefined)).toBe('full')
    expect(isStricter('ask', 'full')).toBe(true)
    expect(isStricter('full', 'full')).toBe(false)
  })

  it('allows an action without asking only as far as the mode goes', () => {
    expect(permissionModeAllows('ask', 'edit')).toBe(false)
    expect(permissionModeAllows('ask', 'command')).toBe(false)
    expect(permissionModeAllows('accept_edits', 'edit')).toBe(true)
    expect(permissionModeAllows('accept_edits', 'command')).toBe(false)
    expect(permissionModeAllows('accept_edits', 'tool')).toBe(false)
    expect(permissionModeAllows('full', 'tool')).toBe(true)
  })

  it('narrows over a lineage: each ancestor counts, not only the parent', () => {
    const threads = [
      { id: 'root', permissionMode: 'accept_edits' as const },
      { id: 'mid', lineage: { parentThreadId: 'root' }, permissionMode: 'full' as const },
      { id: 'leaf', lineage: { parentThreadId: 'mid' } }
    ]
    expect(permissionCeilingOf(threads[2], threads, 'full')).toBe('accept_edits')
    expect(permissionCeilingOf(threads[0], threads, 'full')).toBe('full')
    // An ancestor without a stored mode follows the profile default.
    expect(permissionCeilingOf({ id: 'child', lineage: { parentThreadId: 'plain' } }, [{ id: 'plain' }], 'ask')).toBe('ask')
  })

  it('supports every mode with tool control, and only Full access without it', () => {
    expect(supportedPermissionModes({ toolControl: 'exact' })).toEqual(['ask', 'accept_edits', 'full'])
    expect(supportedPermissionModes({ toolControl: 'approval_only' })).toEqual(['ask', 'accept_edits', 'full'])
    expect(supportedPermissionModes({ toolControl: 'uncontrolled' })).toEqual(['full'])
    expect(supportedPermissionModes({})).toEqual(['full'])
    expect(supportedPermissionModes({ toolControl: 'approval_only' }, { bypassDisabled: true })).toEqual(['ask', 'accept_edits'])
    expect(supportedPermissionModes({ toolControl: 'approval_only' }, { unavailable: { accept_edits: 'no' } })).toEqual(['ask', 'full'])
  })

  it('resolves to the requested mode, the nearest stricter one with a reason, or a refusal', () => {
    const all = supportedPermissionModes({ toolControl: 'approval_only' })
    expect(effectivePermissionMode('accept_edits', all)).toEqual({ mode: 'accept_edits' })

    const noBypass = { bypassDisabled: true }
    const limited = supportedPermissionModes({ toolControl: 'approval_only' }, noBypass)
    expect(effectivePermissionMode('full', limited, { limits: noBypass })).toEqual({ mode: 'accept_edits', reason: 'Claude Code settings disallow bypassing permissions' })

    const noEdits = { unavailable: { accept_edits: 'Codex cannot auto-accept edits while asking for commands' } }
    const codex = supportedPermissionModes({ toolControl: 'approval_only' }, noEdits)
    expect(effectivePermissionMode('accept_edits', codex, { limits: noEdits })).toEqual({ mode: 'ask', reason: 'Codex cannot auto-accept edits while asking for commands' })

    const generic = supportedPermissionModes({ toolControl: 'uncontrolled' })
    expect(effectivePermissionMode('full', generic)).toEqual({ mode: 'full' })
    for (const mode of ['ask', 'accept_edits'] as const) {
      const refused = effectivePermissionMode(mode, generic, { agent: 'Gemini' })
      expect(refused).toMatchObject({ refused: true })
      expect(refused.reason).toBe('Gemini approves tools itself; set this thread to Full access or pick another agent.')
    }
  })

  it('does not offer Auto-accept edits on Codex: the thread asks about edits too, with the reason', () => {
    // No recorded app-server exchange proves a patch applies after Mousse's automatic answer while a
    // mutating command still waits, so the Codex driver reports the mode as unavailable.
    const runtime = codexDriver({ builtIn: () => ({ vendorMirror: () => ({}) }) as unknown as CodexProviderService }).create({ builtIn: true, config: {} } as DriverContext)
    const limits = runtime.permissionLimits?.()
    expect(limits).toBe(CODEX_PERMISSION_LIMITS)
    // Full access also turns Codex's sandbox off; the composer reads this from the limits, not from a name.
    expect(limits?.sandboxOffInFull).toBe(true)
    const supported = supportedPermissionModes(CODEX_CAPS, limits)
    expect(supported).toEqual(['ask', 'full'])
    expect(effectivePermissionMode('accept_edits', supported, { agent: 'Codex', limits })).toEqual({
      mode: 'ask',
      reason: 'Codex cannot auto-accept edits while asking for commands'
    })
    expect(effectivePermissionMode('ask', supported, { limits })).toEqual({ mode: 'ask' })
    expect(effectivePermissionMode('full', supported, { limits })).toEqual({ mode: 'full' })
  })

  it('is not exposed over the Bridge: a remote client cannot loosen a thread\'s mode', () => {
    expect(Object.keys(BRIDGE_REMOTE_METHODS).filter((method) => /permission/i.test(method))).toEqual([])
    expect(BRIDGE_REMOTE_METHODS).not.toHaveProperty('threads.setPermissionMode')
  })

  it('tells the agent about a change in plain words', () => {
    const notice = buildPermissionModeChangeNotice('accept_edits', 'ask')
    expect(notice).toContain(describePermissionMode('accept_edits'))
    expect(notice).toContain(describePermissionMode('ask'))
    expect(notice).toContain('ask the user')
  })

  it('tracks the last user turn, reading a legacy visible message as the default and skipping hidden wakes', () => {
    expect(getLastUserPermissionMode([])).toBeUndefined()
    expect(getLastUserPermissionMode([{ role: 'assistant' }])).toBeUndefined()
    expect(getLastUserPermissionMode([{ role: 'user' }])).toBe(DEFAULT_PERMISSION_MODE)
    expect(getLastUserPermissionMode([{ role: 'user', permissionMode: 'full' }, { role: 'user', hidden: true }])).toBe('full')
    expect(getLastUserPermissionMode([{ role: 'user', permissionMode: 'ask' }, { role: 'assistant' }])).toBe('ask')
  })
})

describe('permission keys', () => {
  it('names a class of action per provider', () => {
    expect(actionOf(PERMISSION_KEYS.claudeCommand)).toBe('command')
    expect(actionOf(PERMISSION_KEYS.claudeEdit)).toBe('edit')
    expect(actionOf('claude:tool:WebFetch')).toBe('tool')
    expect(actionOf(PERMISSION_KEYS.codexFileChange)).toBe('edit')
    expect(actionOf(PERMISSION_KEYS.mousseIntegrate)).toBe('edit')
    expect(actionOf(acpPermissionKey('edit'))).toBe('edit')
    expect(actionOf(acpPermissionKey('delete'))).toBe('edit')
    expect(actionOf(acpPermissionKey('move'))).toBe('edit')
    expect(actionOf(acpPermissionKey('execute'))).toBe('command')
    expect(actionOf(acpPermissionKey(undefined))).toBe('tool')
  })

  it('classifies pi tools, legacy aliases included', () => {
    expect(piToolAction('bash')).toBe('command')
    expect(piToolAction('run_command')).toBe('command')
    expect(piToolAction('edit')).toBe('edit')
    expect(piToolAction('write')).toBe('edit')
    expect(piToolAction('write_file')).toBe('edit')
    expect(piToolAction('read')).toBeNull()
    expect(piToolAction('git_diff')).toBeNull()
  })
})
