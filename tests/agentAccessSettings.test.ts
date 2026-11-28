import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { MousseConfigStore } from '../src/mms/config/MousseConfigStore'
import { SettingsStore } from '../src/mms/settings/SettingsStore'
import { SETTINGS_CLASSIFICATION } from '../src/shared/profiles/settingsClassification'
import { asSettingsPartial } from '../src/mms/protocol/validators'
import { getDefaultSettings, normalizeAgentAccessSettings } from '../src/shared/settings'

describe('agent access settings (SPEC §15.1)', () => {
  it('defaults to no approval answers and no subagents on other devices', () => {
    expect(normalizeAgentAccessSettings()).toEqual({ answerApprovals: false, remoteSubagents: false, computerUse: true, computers: [], fromOtherDevices: false })
    expect(getDefaultSettings().agentAccess).toEqual({ answerApprovals: false, remoteSubagents: false, computerUse: true, computers: [], fromOtherDevices: false })
    expect(normalizeAgentAccessSettings(null)).toEqual({ answerApprovals: false, remoteSubagents: false, computerUse: true, computers: [], fromOtherDevices: false })
  })

  it('drops the removed level and project list of an older profile, and keeps its approvals switch', () => {
    expect(normalizeAgentAccessSettings({ level: 'lineage', projectIds: ['p1'], projectsUnreadable: true, answerApprovals: true } as never)).toEqual({ answerApprovals: true, remoteSubagents: false, computerUse: true, computers: [], fromOtherDevices: false })
    expect(normalizeAgentAccessSettings({ answerApprovals: 'yes' as never }).answerApprovals).toBe(false)
  })

  it('allows no other computer by default, and reads a malformed computer list as none', () => {
    expect(normalizeAgentAccessSettings({ computers: ['node-a', 'node-b', 'node-a'] }).computers).toEqual(['node-a', 'node-b'])
    for (const computers of ['node-a', 7, [7], ['node-a', ''], [null]])
      expect(normalizeAgentAccessSettings({ computers: computers as never }).computers, JSON.stringify(computers)).toEqual([])
    expect(asSettingsPartial({ agentAccess: { computers: ['node-a'] } })).toEqual({ agentAccess: { computers: ['node-a'] } })
    for (const bad of [{ computers: 'node-a' }, { computers: [''] }, { computers: [1] }])
      expect(() => asSettingsPartial({ agentAccess: bad }), JSON.stringify(bad)).toThrow(/agentAccess/)
  })

  it('keeps subagents on other devices off unless the switch is exactly on', () => {
    expect(normalizeAgentAccessSettings({ remoteSubagents: true }).remoteSubagents).toBe(true)
    for (const value of [undefined, false, 'true', 1])
      expect(normalizeAgentAccessSettings({ remoteSubagents: value as never }).remoteSubagents, JSON.stringify(value)).toBe(false)
    expect(asSettingsPartial({ agentAccess: { remoteSubagents: true } })).toEqual({ agentAccess: { remoteSubagents: true } })
    expect(() => asSettingsPartial({ agentAccess: { remoteSubagents: 'yes' } })).toThrow(/agentAccess/)
  })

  it('keeps threads started from other devices off other computers unless that switch is exactly on', () => {
    expect(normalizeAgentAccessSettings({ fromOtherDevices: true }).fromOtherDevices).toBe(true)
    for (const value of [undefined, false, 'true', 1])
      expect(normalizeAgentAccessSettings({ fromOtherDevices: value as never }).fromOtherDevices, JSON.stringify(value)).toBe(false)
    expect(asSettingsPartial({ agentAccess: { fromOtherDevices: true } })).toEqual({ agentAccess: { fromOtherDevices: true } })
    expect(() => asSettingsPartial({ agentAccess: { fromOtherDevices: 'yes' } })).toThrow(/agentAccess/)
  })

  it('the settings protocol refuses a malformed agentAccess patch, and lets an older client send the removed keys', () => {
    expect(() => asSettingsPartial({ agentAccess: { level: 'read', projectIds: ['p1'], answerApprovals: false } })).not.toThrow()
    for (const bad of [{ answerApprovals: 'yes' }, { extra: 1 }])
      expect(() => asSettingsPartial({ agentAccess: bad }), JSON.stringify(bad)).toThrow(/agentAccess/)
    expect(() => asSettingsPartial({ agentAccess: 'manage' })).toThrow()
  })

  it('is a profile setting', () => {
    expect(SETTINGS_CLASSIFICATION.find((entry) => entry.path === 'settings.agentAccess')).toMatchObject({ scope: 'profile' })
  })

  it('persists the switches through a configuration reload', () => {
    const home = mkdtempSync(join(tmpdir(), 'mousse-agent-access-settings-'))
    try {
      const settings = new SettingsStore(MousseConfigStore.load(home))
      settings.set({ agentAccess: { answerApprovals: true, remoteSubagents: true, computers: ['node-a'] } })
      const reloaded = new SettingsStore(MousseConfigStore.load(home))
      expect(reloaded.get().agentAccess).toEqual({ answerApprovals: true, remoteSubagents: true, computerUse: true, computers: ['node-a'], fromOtherDevices: false })
      reloaded.set({ agentAccess: { answerApprovals: false } as never })
      expect(new SettingsStore(MousseConfigStore.load(home)).get().agentAccess).toEqual({ answerApprovals: false, remoteSubagents: true, computerUse: true, computers: ['node-a'], fromOtherDevices: false })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})
