import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { SETTINGS_CLASSIFICATION } from '../src/shared/profiles/settingsClassification'
import { getDefaultSettings, isAgentAccessLevel, narrowAgentAccess, normalizeAgentAccessSettings } from '../src/shared/settings'

describe('agent access settings (SPEC §15.1)', () => {
  it('defaults to the narrowest level, every project, and no approval answers', () => {
    expect(normalizeAgentAccessSettings()).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false })
    expect(getDefaultSettings().agentAccess).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false })
  })

  it('normalizes an unknown level to lineage, drops non-string and empty project ids, and coerces the toggle to a boolean', () => {
    expect(normalizeAgentAccessSettings({ level: 'root' as never }).level).toBe('lineage')
    expect(normalizeAgentAccessSettings({ level: undefined }).level).toBe('lineage')
    expect(normalizeAgentAccessSettings({ level: 'manage' }).level).toBe('manage')
    expect(normalizeAgentAccessSettings({ projectIds: ['a', 7, '', null, 'a', 'b'] as never }).projectIds).toEqual(['a', 'b'])
    expect(normalizeAgentAccessSettings({ projectIds: 'a' as never }).projectIds).toEqual([])
    expect(normalizeAgentAccessSettings({ answerApprovals: 'yes' as never }).answerApprovals).toBe(false)
    expect(normalizeAgentAccessSettings({ answerApprovals: true }).answerApprovals).toBe(true)
    expect(normalizeAgentAccessSettings(null)).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false })
  })

  it('narrows to the narrower level and ignores an absent or unknown one', () => {
    expect(narrowAgentAccess('manage', 'read')).toBe('read')
    expect(narrowAgentAccess('read', 'manage', 'lineage')).toBe('lineage')
    expect(narrowAgentAccess('manage', undefined, null)).toBe('manage')
    expect(narrowAgentAccess(undefined, null)).toBeUndefined()
    expect(narrowAgentAccess('bogus' as never, 'read')).toBe('read')
    expect(isAgentAccessLevel('read')).toBe(true)
    expect(isAgentAccessLevel('admin')).toBe(false)
    expect(isAgentAccessLevel(undefined)).toBe(false)
  })

  it('is a profile setting', () => {
    expect(SETTINGS_CLASSIFICATION.find((entry) => entry.path === 'settings.agentAccess')).toMatchObject({ scope: 'profile' })
  })

  it('persists the level, the project list and the toggle through a configuration reload, and normalizes what was stored', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-agent-access-settings-'))
    try {
      const settings = new SettingsStore(MousseConfigStore.load(home))
      expect(settings.get().agentAccess).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false })
      settings.set({ agentAccess: { level: 'manage', projectIds: ['p1', 'p2'], answerApprovals: true } })
      let reloaded = new SettingsStore(MousseConfigStore.load(home))
      expect(reloaded.get().agentAccess).toEqual({ level: 'manage', projectIds: ['p1', 'p2'], answerApprovals: true })
      // A narrower project list replaces the earlier one rather than merging into it.
      reloaded.set({ agentAccess: { projectIds: ['p2'] } as never })
      reloaded = new SettingsStore(MousseConfigStore.load(home))
      expect(reloaded.get().agentAccess).toEqual({ level: 'manage', projectIds: ['p2'], answerApprovals: true })
      // A level that is not one of the three reads back as the narrowest.
      reloaded.set({ agentAccess: { level: 'superuser' } as never })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess.level).toBe('lineage')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
