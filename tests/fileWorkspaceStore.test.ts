import { describe, expect, it } from 'vitest'
import { closeFileInSnapshot, fileWorkspaceScope, openFileInSnapshot } from '../src/renderer/stores/fileWorkspaceStore'

describe('files workspace persistence model', () => {
  it('scopes tabs by project and thread', () => {
    expect(fileWorkspaceScope('thread-a', 'project-a')).not.toBe(fileWorkspaceScope('thread-b', 'project-a'))
    expect(fileWorkspaceScope('thread-a', 'project-a')).not.toBe(fileWorkspaceScope('thread-a', 'project-b'))
  })

  it('keeps multiple paths and picks a neighboring tab when closing', () => {
    let snapshot = { openPaths: [] as string[], activePath: null as string | null }
    snapshot = openFileInSnapshot(snapshot, 'one.ts')
    snapshot = openFileInSnapshot(snapshot, 'two.ts')
    snapshot = openFileInSnapshot(snapshot, 'three.ts')
    expect(snapshot).toEqual({ openPaths: ['one.ts', 'two.ts', 'three.ts'], activePath: 'three.ts' })
    expect(closeFileInSnapshot(snapshot, 'three.ts')).toEqual({ openPaths: ['one.ts', 'two.ts'], activePath: 'two.ts' })
  })
})
