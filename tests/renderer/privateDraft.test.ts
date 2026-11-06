import { describe, expect, it } from 'vitest'
import { composerWorkspaceFor, workspaceWithPrivate } from '../../src/renderer/lib/newThread'
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
