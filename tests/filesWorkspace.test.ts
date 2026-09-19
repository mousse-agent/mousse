import { describe, expect, it, vi } from 'vitest'
import { closeFileInSnapshot, fileWorkspaceScope, openFileInSnapshot } from '../src/renderer/stores/filesStore'
import { normalizeWorkspacePath, SerializedAutosave, reconcileExternalContent } from '../src/renderer/utils/fileWorkspace'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('files workspace persistence model', () => {
  it('scopes tabs by profile, project and thread', () => {
    expect(fileWorkspaceScope('one', 'thread-a', 'project-a')).not.toBe(fileWorkspaceScope('two', 'thread-a', 'project-a'))
    expect(fileWorkspaceScope('one', 'thread-a', 'project-a')).not.toBe(fileWorkspaceScope('one', 'thread-b', 'project-a'))
    expect(fileWorkspaceScope('one', 'thread-a', 'project-a')).not.toBe(fileWorkspaceScope('one', 'thread-a', 'project-b'))
  })

  it('keeps multiple paths and picks a neighboring tab when closing', () => {
    let snapshot = { openPaths: [] as string[], activePath: null as string | null }
    snapshot = openFileInSnapshot(snapshot, 'one.ts')
    snapshot = openFileInSnapshot(snapshot, 'two.ts')
    snapshot = openFileInSnapshot(snapshot, 'three.ts')
    expect(snapshot).toEqual({ openPaths: ['one.ts', 'two.ts', 'three.ts'], activePath: 'three.ts' })
    expect(closeFileInSnapshot(snapshot, 'three.ts')).toEqual({ openPaths: ['one.ts', 'two.ts'], activePath: 'two.ts' })
  })

  it('canonicalizes tree-relative and link-absolute workspace paths to one tab path', () => {
    expect(normalizeWorkspacePath('src\\editor.ts', 'C:\\repo')).toBe('src/editor.ts')
    expect(normalizeWorkspacePath('C:\\repo\\src\\editor.ts', 'C:\\repo')).toBe('src/editor.ts')
    expect(normalizeWorkspacePath('/repo/src/../README.md', '/repo')).toBe('README.md')
    expect(normalizeWorkspacePath('/elsewhere/file.ts', '/repo')).toBe('/elsewhere/file.ts')
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

  it('rebases realistic edits made while its own write is in flight', async () => {
    let disk = 'a'
    const firstWrite = deferred<void>()
    const writes: string[] = []
    const save = new SerializedAutosave({
      read: async () => disk,
      write: async (content) => {
        writes.push(content)
        if (writes.length === 1) await firstWrite.promise
        disk = content
      },
      onSaved: vi.fn(), onConflict: vi.fn(), onError: vi.fn(), delay: 1
    })
    save.schedule({ content: 'b', baseline: 'a' })
    const flushing = save.flush()
    await vi.waitFor(() => expect(writes).toEqual(['b']))
    // savedContent in the real UI is still "a" until the first write resolves.
    save.schedule({ content: 'c', baseline: 'a' })
    firstWrite.resolve()
    await flushing
    expect(writes).toEqual(['b', 'c'])
    expect(disk).toBe('c')
  })

  it('rebases an edit queued during a delayed preflight read', async () => {
    let disk = 'a'
    const firstRead = deferred<string>()
    let reads = 0
    const writes: string[] = []
    const save = new SerializedAutosave({
      read: async () => ++reads === 1 ? firstRead.promise : disk,
      write: async (content) => { writes.push(content); disk = content },
      onSaved: vi.fn(), onConflict: vi.fn(), onError: vi.fn(), delay: 1
    })
    save.schedule({ content: 'b', baseline: 'a' })
    const flushing = save.flush()
    save.schedule({ content: 'c', baseline: 'a' })
    firstRead.resolve('a')
    await flushing
    expect(writes).toEqual(['b', 'c'])
  })

  it('does not rebase a pending attempt with a genuinely different baseline', async () => {
    let disk = 'a'
    const firstWrite = deferred<void>()
    const write = vi.fn(async (content: string) => {
      if (content === 'b') await firstWrite.promise
      disk = content
    })
    const onConflict = vi.fn()
    const save = new SerializedAutosave({ read: async () => disk, write, onSaved: vi.fn(), onConflict, onError: vi.fn(), delay: 1 })
    save.schedule({ content: 'b', baseline: 'a' })
    const flushing = save.flush()
    await vi.waitFor(() => expect(write).toHaveBeenCalledTimes(1))
    save.schedule({ content: 'mine', baseline: 'external-baseline' })
    firstWrite.resolve()
    await flushing
    expect(write).toHaveBeenCalledTimes(1)
    expect(onConflict).toHaveBeenCalledWith('b')
  })

  it('disposes pending follow-up writes and suppresses stale completion callbacks', async () => {
    let disk = 'a'
    const firstWrite = deferred<void>()
    const writes: string[] = []
    const onSaved = vi.fn()
    const save = new SerializedAutosave({
      read: async () => disk,
      write: async (content) => { writes.push(content); await firstWrite.promise; disk = content },
      onSaved, onConflict: vi.fn(), onError: vi.fn(), delay: 1
    })
    save.schedule({ content: 'b', baseline: 'a' })
    const flushing = save.flush()
    await vi.waitFor(() => expect(writes).toEqual(['b']))
    save.schedule({ content: 'c', baseline: 'a' })
    save.dispose()
    firstWrite.resolve()
    await flushing
    expect(writes).toEqual(['b'])
    expect(onSaved).not.toHaveBeenCalled()
  })

  it('retains the latest pending edit after a write failure for explicit retry', async () => {
    let disk = 'a'
    let fail = true
    const write = vi.fn(async (content: string) => {
      if (fail) throw new Error('offline')
      disk = content
    })
    const onError = vi.fn()
    const save = new SerializedAutosave({ read: async () => disk, write, onSaved: vi.fn(), onConflict: vi.fn(), onError, delay: 1 })
    save.schedule({ content: 'b', baseline: 'a' })
    await save.flush()
    expect(onError).toHaveBeenCalledOnce()
    fail = false
    await save.flush()
    expect(disk).toBe('b')
    expect(write).toHaveBeenCalledTimes(2)
  })
})
