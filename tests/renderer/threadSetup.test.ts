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

describe("the sidebar's New thread before the project's provider listing has loaded", () => {
  const opus = { instanceId: 'claude', llmProvider: 'claude-subscription', model: 'opus' }
  afterEach(() => { vi.unstubAllGlobals() })

  async function setup(listing: () => Promise<unknown>) {
    const { useAppStore } = await import('../../src/renderer/stores/appStore')
    const { useProviderSnapshotsStore } = await import('../../src/renderer/lib/providerSnapshots')
    const { createAndSelectProjectThread } = await import('../../src/renderer/lib/threadActions')
    const empty = { id: 'empty', name: 'New Chat', projectId: 'p', createdAt: '', updatedAt: '', order: 0, modelOverride: opus } as never
    // Sonnet is remembered for the project; the empty thread is on Opus.
    useAppStore.setState({ threads: [empty], activeThreadId: null, projects: [{ id: 'p', name: 'p', path: '/p', createdAt: '', order: 0, newThread: { model: { ...opus, model: 'sonnet' } } }] })
    useProviderSnapshotsStore.setState({ scopes: {} })
    const snapshots = vi.fn(listing)
    const create = vi.fn(async () => ({ ...(empty as object), id: 'made', modelOverride: { ...opus, model: 'sonnet' } }))
    vi.stubGlobal('window', { mousse: { threads: { create, select: vi.fn(async () => undefined) }, providers: { snapshots } } })
    return { useAppStore, createAndSelectProjectThread, create, snapshots }
  }

  it('keeps the remembered model without waiting, and fetches the listing for next time', async () => {
    const { model, snapshot } = await import('../providerSnapshotFixture')
    const page = await setup(async () => [snapshot({ models: { entries: [model('opus'), model('sonnet')], source: 'live' } })])
    await page.createAndSelectProjectThread('p')
    expect(page.snapshots).toHaveBeenCalledTimes(1)
    expect(page.create).toHaveBeenCalledWith(undefined, 'p', { rememberedChoices: true })
    expect(page.useAppStore.getState().activeThreadId).toBe('made')
  })

  it('never waits for a provider listing that is still being checked', async () => {
    // A first listing can wait on the providers' start-up checks for half a minute; this one never answers.
    const page = await setup(() => new Promise(() => undefined))
    const opened = page.createAndSelectProjectThread('p')
    const result = await Promise.race([opened.then(() => 'opened'), new Promise((resolve) => setTimeout(() => resolve('waited'), 500))])
    expect(result).toBe('opened')
    expect(page.useAppStore.getState().activeThreadId).toBe('made')
  })

  it('keeps a newer copy of the new thread, and does nothing for a profile switched away from meanwhile', async () => {
    const page = await setup(() => new Promise(() => undefined))
    let finish!: (thread: unknown) => void
    page.create.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }) as never)
    const opened = page.createAndSelectProjectThread('p')
    // The service pushes the new thread with a later change before the create answers.
    const pushed = { id: 'made', name: 'Renamed already', projectId: 'p', createdAt: '', updatedAt: '', order: -1 }
    page.useAppStore.getState().upsertThread(pushed as never)
    finish({ ...pushed, name: 'New Chat' })
    await opened
    expect(page.useAppStore.getState().threads.find((entry) => entry.id === 'made')?.name).toBe('Renamed already')

    const later = await setup(() => new Promise(() => undefined))
    let answer!: (thread: unknown) => void
    later.create.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }) as never)
    const switching = later.createAndSelectProjectThread('p')
    later.useAppStore.setState({ profileId: 'another-profile', threads: [], activeThreadId: null })
    answer({ id: 'late', name: 'New Chat', projectId: 'p', createdAt: '', updatedAt: '', order: 0 })
    await switching
    expect(later.useAppStore.getState().threads).toEqual([])
    expect(later.useAppStore.getState().activeThreadId).toBeNull()
  })

  it('keeps the remembered model when the listing cannot be read, instead of reusing a thread on another model', async () => {
    const page = await setup(async () => { throw new Error('The service did not answer') })
    await page.createAndSelectProjectThread('p')
    expect(page.create).toHaveBeenCalledTimes(1)
    expect(page.useAppStore.getState().activeThreadId).toBe('made')
  })
})
