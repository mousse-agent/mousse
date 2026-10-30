import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { SETTINGS_CLASSIFICATION } from '../src/shared/profiles/settingsClassification'
import { asSettingsPartial } from '../src/mms/protocol/validators'
import { getDefaultSettings, isAgentAccessLevel, narrowAgentAccess, normalizeAgentAccessSettings } from '../src/shared/settings'

describe('agent access settings (SPEC §15.1)', () => {
  it('defaults to the narrowest level, every project, and no approval answers', () => {
    expect(normalizeAgentAccessSettings()).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false, computers: [] })
    expect(getDefaultSettings().agentAccess).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false, computers: [] })
  })

  it('normalizes an unknown level to lineage, drops non-string and empty project ids, and coerces the toggle to a boolean', () => {
    expect(normalizeAgentAccessSettings({ level: 'root' as never }).level).toBe('lineage')
    expect(normalizeAgentAccessSettings({ level: undefined }).level).toBe('lineage')
    expect(normalizeAgentAccessSettings({ level: 'manage' }).level).toBe('manage')
    expect(normalizeAgentAccessSettings({ projectIds: ['a', 'b', 'a'] }).projectIds).toEqual(['a', 'b'])
    expect(normalizeAgentAccessSettings({ level: 'manage', projectIds: [] })).toMatchObject({ level: 'manage', projectIds: [] })
    expect(normalizeAgentAccessSettings({ answerApprovals: 'yes' as never }).answerApprovals).toBe(false)
    expect(normalizeAgentAccessSettings({ level: 'manage', answerApprovals: true }).answerApprovals).toBe(true)
    expect(normalizeAgentAccessSettings(null)).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false, computers: [] })
  })

  it('the answer switch reads as off below the manage level, whoever wrote the level', () => {
    for (const level of ['lineage', 'read', undefined, 'root'] as const)
      expect(normalizeAgentAccessSettings({ level: level as never, answerApprovals: true }).answerApprovals, String(level)).toBe(false)
    expect(normalizeAgentAccessSettings({ answerApprovals: true }).answerApprovals).toBe(false)
  })

  it('a malformed project list fails closed to lineage, never to every project', () => {
    for (const projectIds of ['a', 7, {}, [123], ['a', 7], ['a', ''], [null]]) {
      expect(normalizeAgentAccessSettings({ level: 'manage', projectIds: projectIds as never, answerApprovals: true }), JSON.stringify(projectIds)).toEqual({
        level: 'lineage', projectIds: [], answerApprovals: false, computers: []
      })
    }
    // An absent list is every project, which is what an empty one means.
    expect(normalizeAgentAccessSettings({ level: 'read' })).toMatchObject({ level: 'read', projectIds: [] })
  })

  it('allows no other computer by default, and reads a malformed computer list as none', () => {
    expect(normalizeAgentAccessSettings({ computers: ['node-a', 'node-b', 'node-a'] }).computers).toEqual(['node-a', 'node-b'])
    for (const computers of ['node-a', 7, [7], ['node-a', ''], [null]])
      expect(normalizeAgentAccessSettings({ level: 'read', computers: computers as never }).computers, JSON.stringify(computers)).toEqual([])
    // A malformed project list fails closed for the level; the computers chosen are kept, they are a separate grant.
    expect(normalizeAgentAccessSettings({ projectIds: 'p' as never, computers: ['node-a'] })).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false, computers: ['node-a'] })
    expect(asSettingsPartial({ agentAccess: { computers: ['node-a'] } })).toEqual({ agentAccess: { computers: ['node-a'] } })
    for (const bad of [{ computers: 'node-a' }, { computers: [''] }, { computers: [1] }])
      expect(() => asSettingsPartial({ agentAccess: bad }), JSON.stringify(bad)).toThrow(/agentAccess/)
  })

  it('the settings protocol refuses a malformed agentAccess patch', () => {
    expect(asSettingsPartial({ agentAccess: { level: 'read', projectIds: ['p1'], answerApprovals: false } })).toEqual({ agentAccess: { level: 'read', projectIds: ['p1'], answerApprovals: false } })
    expect(asSettingsPartial({ agentAccess: { projectIds: [] } })).toEqual({ agentAccess: { projectIds: [] } })
    for (const bad of [{ projectIds: 'p1' }, { projectIds: [123] }, { projectIds: [''] }, { level: 'root' }, { answerApprovals: 'yes' }, { extra: 1 }])
      expect(() => asSettingsPartial({ agentAccess: bad }), JSON.stringify(bad)).toThrow(/agentAccess/)
    expect(() => asSettingsPartial({ agentAccess: 'manage' })).toThrow()
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
      expect(settings.get().agentAccess).toEqual({ level: 'lineage', projectIds: [], answerApprovals: false, computers: [] })
      settings.set({ agentAccess: { level: 'manage', projectIds: ['p1', 'p2'], answerApprovals: true } })
      let reloaded = new SettingsStore(MousseConfigStore.load(home))
      expect(reloaded.get().agentAccess).toEqual({ level: 'manage', projectIds: ['p1', 'p2'], answerApprovals: true, computers: [] })
      // A narrower project list replaces the earlier one rather than merging into it.
      reloaded.set({ agentAccess: { projectIds: ['p2'] } as never })
      reloaded = new SettingsStore(MousseConfigStore.load(home))
      expect(reloaded.get().agentAccess).toEqual({ level: 'manage', projectIds: ['p2'], answerApprovals: true, computers: [] })
      // A partial update that only lowers the level (from the CLI, another client or a script) clears the switch in the
      // store itself, and raising the level again does not bring it back.
      reloaded.set({ agentAccess: { level: 'read' } as never })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess).toEqual({ level: 'read', projectIds: ['p2'], answerApprovals: false, computers: [] })
      reloaded.set({ agentAccess: { level: 'manage' } as never })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess).toEqual({ level: 'manage', projectIds: ['p2'], answerApprovals: false, computers: [] })
      // Turning it on is its own, explicit write at the manage level.
      reloaded.set({ agentAccess: { answerApprovals: true } as never })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess.answerApprovals).toBe(true)
      reloaded.set({ agentAccess: { level: 'lineage' } as never })
      reloaded.set({ agentAccess: { level: 'manage' } as never })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess.answerApprovals).toBe(false)
      // A level that is not one of the three reads back as the narrowest.
      reloaded.set({ agentAccess: { level: 'superuser' } as never })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess.level).toBe('lineage')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
