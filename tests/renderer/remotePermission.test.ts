import { afterEach, describe, expect, it } from 'vitest'
import { readRemoteComposerOptions, remotePermissionCeiling, remotePermissionView } from '../../src/renderer/lib/remoteComputers'

describe('the permission mode a thread of another computer runs in', () => {
  it('is the thread\'s own mode, or that computer\'s default, never this computer\'s', () => {
    expect(remotePermissionView({ threadMode: 'accept_edits', permission: { defaultMode: 'full' } }).mode).toBe('accept_edits')
    expect(remotePermissionView({ permission: { defaultMode: 'full' } }).mode).toBe('full')
    expect(remotePermissionView({ permission: { defaultMode: 'ask' } }).mode).toBe('ask')
  })

  it('is capped by what that computer lets this device have, whichever way the other two point', () => {
    expect(remotePermissionView({ permission: { defaultMode: 'full', limit: 'accept_edits' } })).toEqual({ mode: 'accept_edits', limit: 'accept_edits' })
    expect(remotePermissionView({ threadMode: 'full', permission: { defaultMode: 'ask', limit: 'accept_edits' } }).mode).toBe('accept_edits')
    expect(remotePermissionView({ threadMode: 'ask', permission: { defaultMode: 'full', limit: 'full' } }).mode).toBe('ask')
  })

  it('shows the strictest mode until that computer\'s rules are known, never a looser one than will run', () => {
    expect(remotePermissionView({})).toEqual({ mode: 'ask' })
    expect(remotePermissionView({ threadMode: 'full' }).mode).toBe('full')
  })
})

describe('what the picker offers for a thread of another computer', () => {
  it('stops at the device limit and says whose limit it is', () => {
    const { ceiling, reason } = remotePermissionCeiling(undefined, 'accept_edits', 'Studio')
    expect(ceiling).toBe('accept_edits')
    expect(reason).toBe('Studio lets this device use Auto-accept edits at most. Raise the limit for this device on Studio, in Settings, Devices.')
  })

  it('keeps a subagent\'s stricter lineage ceiling, and offers everything when there is nothing to hold it down', () => {
    expect(remotePermissionCeiling('ask', 'accept_edits', 'Studio')).toEqual({ ceiling: 'ask' })
    expect(remotePermissionCeiling('full', 'accept_edits', 'Studio').ceiling).toBe('accept_edits')
    expect(remotePermissionCeiling(undefined, undefined, 'Studio')).toEqual({})
    expect(remotePermissionCeiling('ask', undefined, 'Studio')).toEqual({ ceiling: 'ask' })
  })
})

describe('reading another computer\'s composer options', () => {
  afterEach(() => { delete (globalThis as { window?: unknown }).window })
  const answer = (value: unknown) => {
    ;(globalThis as { window?: unknown }).window = { mousse: { platformRequest: { request: async () => value } } }
  }

  it('carries the default mode and the device limit', async () => {
    answer({ providers: [], defaultModel: null, permission: { defaultMode: 'full', limit: 'accept_edits' } })
    expect((await readRemoteComposerOptions('nod_a' as never)).permission).toEqual({ defaultMode: 'full', limit: 'accept_edits' })
  })

  it('has none from a computer that predates them, or says something that is not a mode', async () => {
    answer({ providers: [], defaultModel: null })
    expect((await readRemoteComposerOptions('nod_a' as never)).permission).toBeUndefined()
    answer({ providers: [], defaultModel: null, permission: { defaultMode: 'root', limit: 'ask' } })
    expect((await readRemoteComposerOptions('nod_a' as never)).permission).toBeUndefined()
    answer({ providers: [], defaultModel: null, permission: { defaultMode: 'ask', limit: 'root' } })
    expect((await readRemoteComposerOptions('nod_a' as never)).permission).toEqual({ defaultMode: 'ask' })
  })
})
