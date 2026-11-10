import { describe, expect, it } from 'vitest'
import { needsSetup, setupRefusalLine } from '../../src/renderer/lib/threadSetup'

describe("a new chat's thread setup", () => {
  it('is needed only when there is a model or a mode to set', () => {
    expect(needsSetup({})).toBe(false)
    expect(needsSetup({ permissionMode: 'ask' })).toBe(true)
    expect(needsSetup({ model: { llmProvider: 'claude-subscription', model: 'opus' } })).toBe(true)
  })

  it('says to update an older computer, and otherwise that nothing was sent', () => {
    expect(setupRefusalLine('computer_outdated', 'Studio')).toBe('Update Mousse on Studio to send from here.')
    expect(setupRefusalLine('thread_settings_changed', 'Studio')).toBe("Not sent: couldn't apply your settings on Studio.")
    expect(setupRefusalLine('failed', 'Studio')).toBe("Not sent: couldn't apply your settings on Studio.")
  })
})
