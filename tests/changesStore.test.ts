import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../src/renderer/stores/appStore'
import { capViewed, useChangesStore } from '../src/renderer/stores/changesStore'

describe('changes store', () => {
  beforeEach(() => {
    useChangesStore.setState({ byThread: {}, viewed: {}, fileViews: {} })
  })

  it('asks for a turn for one thread without touching another', () => {
    const store = useChangesStore.getState()
    store.setOpenPath('t1', 'a.ts')
    store.openTurn('t2', 'run:thread:t2:ordinal:1')
    expect(useChangesStore.getState().byThread.t2).toMatchObject({ requested: 'turn:run:thread:t2:ordinal:1', openPath: null })
    expect(useChangesStore.getState().byThread.t1.openPath).toBe('a.ts')
    expect(useChangesStore.getState().byThread.t1.requested).toBeUndefined()
  })

  it('asks for Last turn when the turn is the one Last turn is pinned to', () => {
    const store = useChangesStore.getState()
    store.show('t1', 'last', 'run:1')
    store.openTurn('t1', 'run:1', 'src/app.ts')
    expect(useChangesStore.getState().byThread.t1).toMatchObject({ requested: 'last', pendingFile: { path: 'src/app.ts' } })
  })

  it('hands a request over once', () => {
    const store = useChangesStore.getState()
    store.openThread('t1')
    expect(store.takeRequest('t1')).toBe('thread')
    expect(useChangesStore.getState().takeRequest('t1')).toBeUndefined()
  })

  it("remembers the user's choice apart from a scope the panel showed by itself", () => {
    const store = useChangesStore.getState()
    store.show('t1', 'uncommitted')
    expect(useChangesStore.getState().byThread.t1).toMatchObject({ scopeId: 'uncommitted', chosen: null })
    store.choose('t1', 'last', 'run:2')
    expect(useChangesStore.getState().byThread.t1).toMatchObject({ scopeId: 'last', chosen: 'last', pinnedTurnId: 'run:2' })
    // Showing another scope keeps the pin, so Last turn comes back on the same turn.
    store.show('t1', 'thread')
    expect(useChangesStore.getState().byThread.t1).toMatchObject({ scopeId: 'thread', chosen: 'last', pinnedTurnId: 'run:2' })
  })

  it('keeps a viewed mark per key, moving a re-marked file to the newest end', () => {
    const store = useChangesStore.getState()
    store.markViewed('a', 'v1')
    store.markViewed('b', 'v1')
    store.markViewed('a', 'v2')
    expect(Object.entries(useChangesStore.getState().viewed)).toEqual([['b', 'v1'], ['a', 'v2']])
    store.clearViewed('b')
    expect(useChangesStore.getState().viewed).toEqual({ a: 'v2' })
  })

  it('drops the oldest marks past the limit', () => {
    expect(capViewed({ a: '1', b: '2', c: '3' }, 2)).toEqual({ b: '2', c: '3' })
    const small = { a: '1' }
    expect(capViewed(small, 2)).toBe(small)
  })

  it("merges a file's scroll and expanded context", () => {
    const store = useChangesStore.getState()
    store.saveFileView('k', { scrollTop: 40 })
    store.saveFileView('k', { expanded: true })
    expect(useChangesStore.getState().fileViews.k).toEqual({ scrollTop: 40, expanded: true })
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
