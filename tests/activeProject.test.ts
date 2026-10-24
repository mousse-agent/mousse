import { describe, expect, it } from 'vitest'
import { resolveActiveProject, type ActiveProjectInput } from '../src/renderer/lib/activeProject'

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
    expect(resolveActiveProject(base)).toEqual({ projectId: 'p1', path: '/work/one', loading: false })
    // A stale draft for a started thread changes nothing.
    expect(resolveActiveProject({ ...base, draftProjectId: 'p2' })).toMatchObject({ projectId: 'p1', path: '/work/one' })
  })

  it('follows the project picked in the composer on a new empty chat', () => {
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: 'p2' })).toEqual({
      projectId: 'p2',
      path: '/work/two',
      loading: false
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
      loading: false
    })
  })

  it('has no project for a blank new chat, and keeps the resolved folder for other callers', () => {
    expect(resolveActiveProject({ ...base, isNewChat: true, draftProjectId: undefined, threadProjectId: null })).toEqual({
      projectId: null,
      path: '/work/one',
      loading: false
    })
  })

  it('reports no project for a started thread without one, and a pending lookup', () => {
    expect(resolveActiveProject({ ...base, threadProjectId: null }).projectId).toBeNull()
    expect(resolveActiveProject({ ...base, resolved: { path: null, loading: true } })).toMatchObject({
      path: null,
      loading: true
    })
  })
})
