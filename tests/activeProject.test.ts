import { describe, expect, it } from 'vitest'
import { folderKey, gitScopeFor, resolveActiveProject, type ActiveProjectInput } from '../src/renderer/lib/activeProject'

describe('active project', () => {
  const projects = [
    { id: 'p1', path: '/work/one' },
    { id: 'p2', path: '/work/two' }
  ]
  const base: ActiveProjectInput = {
    isNewChat: false,
    draftProjectId: 'p1',
    threadProjectId: 'p1',
    projects,
    resolved: { path: '/work/one', loading: false }
  }

  it('keeps the thread own project and folder once the chat has started', () => {
    expect(resolveActiveProject(base)).toEqual({ projectId: 'p1', path: '/work/one', key: 'project:p1', loading: false, workspaceThreadId: null })
    // A stale draft for a started thread changes nothing.
    expect(resolveActiveProject({ ...base, draftProjectId: 'p2' })).toMatchObject({ projectId: 'p1', path: '/work/one' })
  })

  it('follows the project picked in the composer on a new empty chat', () => {
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: 'p2' })).toEqual({
      projectId: 'p2',
      path: '/work/two',
      key: 'project:p2',
      loading: false,
      workspaceThreadId: null
    })
  })

  it('does not wait for the lookup when the draft decides the project', () => {
    const resolved = { path: null, loading: true }
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: 'p2', resolved }).loading).toBe(false)
  })

  it('has no folder for a draft project that no longer exists', () => {
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: 'gone' })).toEqual({
      projectId: 'gone',
      path: null,
      key: null,
      loading: false,
      workspaceThreadId: null
    })
  })

  it('has no project for a blank new chat, and keeps the resolved folder for other callers', () => {
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: undefined, threadProjectId: null })).toEqual({
      projectId: null,
      path: '/work/one',
      key: null,
      loading: false,
      workspaceThreadId: null
    })
  })

  it('reports no project for a started thread without one, and a pending lookup', () => {
    expect(resolveActiveProject({ ...base, threadProjectId: null }).projectId).toBeNull()
    expect(resolveActiveProject({ ...base, resolved: { path: null, loading: true } })).toMatchObject({
      path: null,
      loading: true
    })
  })

  it('names the thread when the folder is its own worktree, and never for a new chat', () => {
    const worktree = { path: '/wt/thread-1', loading: false, workspaceThreadId: 'thread-1' }
    expect(resolveActiveProject({ ...base, resolved: worktree })).toEqual({
      projectId: 'p1',
      path: '/wt/thread-1',
      key: 'thread:thread-1',
      loading: false,
      workspaceThreadId: 'thread-1'
    })
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: 'p2', resolved: worktree }).workspaceThreadId).toBeNull()
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: undefined, threadProjectId: null, resolved: worktree }).workspaceThreadId).toBeNull()
  })

  it('scopes a Git mutation to the project folder or to the thread worktree', () => {
    const project = resolveActiveProject(base)
    expect(gitScopeFor(project)).toEqual({ projectId: 'p1', workspaceThreadId: null })
    const worktree = resolveActiveProject({ ...base, resolved: { path: '/wt/thread-1', loading: false, workspaceThreadId: 'thread-1' } })
    expect(gitScopeFor(worktree)).toEqual({ projectId: 'p1', workspaceThreadId: 'thread-1' })
  })

  it('caches a folder under its thread or project, never under its path', () => {
    expect(folderKey({ projectId: 'p1', workspaceThreadId: null })).toBe('project:p1')
    expect(folderKey({ projectId: 'p1', workspaceThreadId: 'thread-1' })).toBe('thread:thread-1')
    expect(folderKey({ projectId: null, workspaceThreadId: null })).toBeNull()
    // Two projects (two computers' qualified ids) at the same path are two folders.
    const a = resolveActiveProject({ ...base, threadProjectId: 'nod_a:p1', resolved: { path: '/work/one', loading: false } })
    const b = resolveActiveProject({ ...base, threadProjectId: 'nod_b:p1', resolved: { path: '/work/one', loading: false } })
    expect(a.path).toBe(b.path)
    expect(a.key).not.toBe(b.key)
  })

  it('has no key until the folder is known', () => {
    expect(resolveActiveProject({ ...base, resolved: { path: null, loading: true } }).key).toBeNull()
  })
})
