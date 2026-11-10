import { describe, expect, it } from 'vitest'
import { boundSendRefusal, needsSetup, setupRefusalLine } from '../../src/renderer/lib/threadSetup'
import { matchesRememberedChoices } from '../../src/renderer/lib/threadActions'

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

  it('names a bound send the daemon refused, and leaves any other refusal to the usual line', () => {
    expect(boundSendRefusal({ code: 'thread_settings_changed', message: 'changed' })).toBe('Not sent: settings changed. Check and send again.')
    expect(boundSendRefusal({ code: 'computer_outdated', message: 'x', details: { name: 'Studio' } })).toBe('Update Mousse on Studio to send from here.')
    expect(boundSendRefusal({ code: 'thread_busy', message: 'Wait for the current turn to finish.' })).toBeUndefined()
  })
})

describe("the sidebar's New thread", () => {
  const opus = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }
  it('reuses an empty thread only while it starts with what its project remembers', () => {
    expect(matchesRememberedChoices({}, undefined)).toBe(true)
    expect(matchesRememberedChoices({ permissionMode: 'full' }, { permissionMode: 'ask' })).toBe(false)
    expect(matchesRememberedChoices({ permissionMode: 'ask', modelOverride: opus }, { permissionMode: 'ask', model: opus })).toBe(true)
    expect(matchesRememberedChoices({ modelOverride: { ...opus, model: 'sonnet' } }, { model: opus })).toBe(false)
    // A thread that leaves the checkout to the default shows the remembered one anyway.
    expect(matchesRememberedChoices({}, { worktreeEnabled: false })).toBe(true)
    expect(matchesRememberedChoices({ worktreeEnabled: true }, { worktreeEnabled: false })).toBe(false)
  })
})
