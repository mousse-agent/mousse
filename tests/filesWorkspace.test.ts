import { describe, expect, it, vi } from 'vitest'
import { closeFileInSnapshot, fileWorkspaceScope, openFileInSnapshot } from '../src/renderer/stores/filesStore'
import { SerializedAutosave, reconcileExternalContent } from '../src/renderer/utils/fileWorkspace'

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

describe('file external-update reconciliation', () => {
  it('applies disk changes only to a clean editor', () => {
    expect(reconcileExternalContent('old', 'old', 'agent edit')).toEqual({ kind: 'replace', content: 'agent edit' })
    expect(reconcileExternalContent('old', 'my edit', 'agent edit')).toEqual({ kind: 'conflict', diskContent: 'agent edit' })
    expect(reconcileExternalContent('old', 'my edit', 'old')).toEqual({ kind: 'unchanged' })
  })
})

describe('SerializedAutosave', () => {
  it('preflights disk state and does not overwrite an external edit', async () => {
    const write = vi.fn(async () => undefined)
    const onConflict = vi.fn()
    const save = new SerializedAutosave({
      read: async () => 'external', write, onSaved: vi.fn(), onConflict, onError: vi.fn(), delay: 1
    })
    save.schedule({ content: 'mine', baseline: 'original' })
    await save.flush()
    expect(write).not.toHaveBeenCalled()
    expect(onConflict).toHaveBeenCalledWith('external')
  })

  it('serializes edits made while a write is in flight', async () => {
    let disk = 'a'
    let release!: () => void
    const firstWrite = new Promise<void>((resolve) => { release = resolve })
    const writes: string[] = []
    const save = new SerializedAutosave({
      read: async () => disk,
      write: async (content) => {
        writes.push(content)
        if (writes.length === 1) await firstWrite
        disk = content
      },
      onSaved: vi.fn(), onConflict: vi.fn(), onError: vi.fn(), delay: 1
    })
    save.schedule({ content: 'b', baseline: 'a' })
    const flushing = save.flush()
    await Promise.resolve()
    save.schedule({ content: 'c', baseline: 'b' })
    release()
    await flushing
    expect(writes).toEqual(['b', 'c'])
  })
})
