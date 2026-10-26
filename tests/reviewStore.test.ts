import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'
import { useReviewStore } from '../src/renderer/stores/reviewStore'

describe('review store', () => {
  beforeEach(() => {
    useReviewStore.setState({ byThread: {} })
  })

  it('opens a turn for one thread without touching another', () => {
    const store = useReviewStore.getState()
    store.selectFile('t1', 'a.ts')
    store.openTurn('t2', 'run:thread:t2:ordinal:1')
    expect(useReviewStore.getState().byThread.t2).toMatchObject({ scope: { kind: 'turn', turnId: 'run:thread:t2:ordinal:1' }, selectedPath: null })
    expect(useReviewStore.getState().byThread.t1).toMatchObject({ scope: null, selectedPath: 'a.ts' })
  })

  it('keeps each thread\'s scope and file when switching between threads', () => {
    const store = useReviewStore.getState()
    store.openTurn('t1', 'run:1')
    store.selectFile('t1', 'src/a.ts')
    store.openThread('t2')
    store.selectFile('t2', 'src/b.ts')
    store.setScope('t1', { kind: 'worktree' })
    const { byThread } = useReviewStore.getState()
    expect(byThread.t1).toMatchObject({ scope: { kind: 'worktree' }, selectedPath: 'src/a.ts' })
    expect(byThread.t2).toMatchObject({ scope: { kind: 'thread' }, selectedPath: 'src/b.ts' })
  })

  it('saves view state per thread and path', () => {
    const store = useReviewStore.getState()
    store.saveViewState('t1', 'a.ts', { scrollTop: 10 })
    store.saveViewState('t1', 'b.ts', { scrollTop: 20 })
    store.saveViewState('t2', 'a.ts', { scrollTop: 30 })
    store.saveViewState('t1', 'a.ts', { scrollTop: 40 })
    const { byThread } = useReviewStore.getState()
    expect(byThread.t1.viewState).toEqual({ 'a.ts': { scrollTop: 40 }, 'b.ts': { scrollTop: 20 } })
    expect(byThread.t2.viewState).toEqual({ 'a.ts': { scrollTop: 30 } })
  })

  it('hands out a reveal once, only for its file', () => {
    const store = useReviewStore.getState()
    store.reveal('t1', { path: 'a.ts', line: 12, scope: { kind: 'turn', turnId: 'run:1' } })
    expect(useReviewStore.getState().byThread.t1).toMatchObject({ scope: { kind: 'turn', turnId: 'run:1' }, selectedPath: 'a.ts' })
    expect(store.takeReveal('t1', 'other.ts')).toBeUndefined()
    expect(store.takeReveal('t1', 'a.ts')).toEqual({ path: 'a.ts', line: 12 })
    expect(store.takeReveal('t1', 'a.ts')).toBeUndefined()
    expect(useReviewStore.getState().byThread.t1.selectedPath).toBe('a.ts')
  })

  it('keeps the current scope when a reveal names none', () => {
    const store = useReviewStore.getState()
    store.setScope('t1', { kind: 'thread' })
    store.reveal('t1', { path: 'a.ts', line: 3 })
    expect(useReviewStore.getState().byThread.t1.scope).toEqual({ kind: 'thread' })
  })
})

describe('review whitespace setting', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ignores leading and trailing whitespace by default', () => {
    expect(useAppStore.getState().reviewIgnoreWhitespace).toBe(true)
  })

  it('persists per profile with the rest of the personal workspace', () => {
    const saved = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => saved.get(key) ?? null,
        setItem: (key: string, value: string) => { saved.set(key, value) },
        removeItem: (key: string) => { saved.delete(key) }
      }
    })
    const { activateProfile } = useAppStore.getState()

    activateProfile('alpha')
    useAppStore.getState().setReviewIgnoreWhitespace(false)
    expect(JSON.parse(saved.get('mousse-profile-alpha-workspace')!)).toMatchObject({ reviewIgnoreWhitespace: false })

    // Another profile starts from the default, and the first one gets its choice back.
    activateProfile('beta')
    expect(useAppStore.getState().reviewIgnoreWhitespace).toBe(true)
    activateProfile('alpha')
    expect(useAppStore.getState().reviewIgnoreWhitespace).toBe(false)
  })
})
