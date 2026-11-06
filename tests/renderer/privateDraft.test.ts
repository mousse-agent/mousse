import { describe, expect, it } from 'vitest'
import { composerWorkspaceFor, workspaceWithExpiry, workspaceWithPrivate } from '../../src/renderer/lib/newThread'
import type { NodeId } from '../../src/shared/net'

describe('Private in the new chat draft (issue #672)', () => {
  const projects = [{ id: 'here' }]

  it('brings a draft that named another computer back to this one', () => {
    const remote = { projectId: 'theirs', worktreeEnabled: true, node: 'nod_mac' as NodeId, localProjectId: 'here' }
    expect(workspaceWithPrivate(remote, true, projects)).toEqual({ projectId: 'here', worktreeEnabled: true, localOnly: true })
  })

  it('turns off without touching the rest of the draft', () => {
    expect(workspaceWithPrivate({ projectId: 'here', worktreeEnabled: false, localOnly: true }, false, projects)).toEqual({ projectId: 'here', worktreeEnabled: false })
  })

  it('reads an empty private thread as a private draft', () => {
    expect(composerWorkspaceFor(undefined, { projectId: 'here', localOnly: true }, false)).toEqual({ projectId: 'here', worktreeEnabled: false, localOnly: true })
  })
})

describe('expiry in the new chat draft (issue #672)', () => {
  it('starts a private draft with the Settings expiry and drops it again with Private', () => {
    const on = workspaceWithPrivate({ projectId: 'here', worktreeEnabled: false }, true, [{ id: 'here' }], 86_400_000)
    expect(on).toEqual({ projectId: 'here', worktreeEnabled: false, localOnly: true, expiryMs: 86_400_000, expiryFromPrivateDefault: true })
    expect(workspaceWithPrivate(on, false, [{ id: 'here' }])).toEqual({ projectId: 'here', worktreeEnabled: false })
  })

  it('keeps an expiry picked by hand when Private changes', () => {
    const picked = workspaceWithExpiry({ projectId: 'here', worktreeEnabled: false }, 3_600_000, true)
    expect(picked).toEqual({ projectId: 'here', worktreeEnabled: false, expiryMs: 3_600_000, expiryStopsRun: true })
    const on = workspaceWithPrivate(picked, true, [{ id: 'here' }], 86_400_000)
    expect(on.expiryMs).toBe(3_600_000)
    expect(workspaceWithPrivate(on, false, [{ id: 'here' }]).expiryMs).toBe(3_600_000)
    expect(workspaceWithExpiry(on, null, false)).toEqual({ projectId: 'here', worktreeEnabled: false, localOnly: true })
  })
})
