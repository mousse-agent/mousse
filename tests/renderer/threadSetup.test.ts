import { afterEach, describe, expect, it, vi } from 'vitest'
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
    expect(boundSendRefusal({ code: 'thread_busy', message: 'Wait for the current turn to finish.' }, true)).toBe('Not sent: this chat is busy. Send again when it is free.')
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

describe("the sidebar's New thread when the remembered model can no longer be used", () => {
  const opus = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }
  afterEach(() => { vi.unstubAllGlobals() })

  it('reuses the empty thread, which has the fallback model, instead of making a new one on every click', async () => {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const { useProviderSnapshotsStore } = await import('../../src/renderer/lib/providerSnapshots')
    const { createAndSelectProjectThread } = await import('../../src/renderer/lib/threadActions')
    const { model, snapshot } = await import('../providerSnapshotFixture')
    const empty = { id: 'empty', name: 'New Chat', projectId: 'p', createdAt: '', updatedAt: '', order: 0, modelOverride: opus } as never
    // Sonnet was remembered, then hidden: a new thread would start on the profile default, as the empty one did.
    useAppStore.setState({ threads: [empty], projects: [{ id: 'p', name: 'p', path: '/p', createdAt: '', order: 0, newThread: { model: { ...opus, model: 'sonnet' } } }] })
    useProviderSnapshotsStore.setState({ scopes: { 'project:p': { loading: false, snapshots: [snapshot({ models: { entries: [model('opus'), model('sonnet', { hidden: true })], source: 'live' } })] } } })
    const create = vi.fn(async () => ({ ...empty, id: 'made' }))
    vi.stubGlobal('window', { mousse: { threads: { create, select: vi.fn(async () => undefined) } } })
    await createAndSelectProjectThread('p')
    await createAndSelectProjectThread('p')
    expect(create).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeThreadId).toBe('empty')
  })
})
