import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createReviewComment, parseChatReference, type ChatReference } from '../src/shared/chatReferences'
import type { ReviewFileEntry, ReviewScope } from '../src/shared/review'
import { buildComposerMessageContent } from '../src/renderer/components/ChatComposer'
import {
  commentCounts,
  commentScopeLabel,
  commentsForFile,
  scopeFromKey,
  scopeKey
} from '../src/renderer/components/review/reviewComments'
import { openChatReference } from '../src/renderer/components/ReferencePill'
import { useAppStore } from '../src/renderer/stores/appStore'
import { useChangesStore } from '../src/renderer/stores/changesStore'

// The composer pulls in the microphone worklet, which needs browser audio APIs; only its message builder is used here.
vi.mock('../src/renderer/dictation/microphone', () => ({}))

const TURN_1 ='run:thread:t1:ordinal:1'
const TURN_2 = 'run:thread:t1:ordinal:2'

function comment(overrides: Partial<Parameters<typeof createReviewComment>[0]> = {}): ChatReference {
  return createReviewComment({
    root: '/repo',
    path: 'src/a.ts',
    line: 12,
    endLine: 15,
    comment: 'Rename this',
    excerpt: 'const a = 1\nconst b = 2',
    reviewScope: `turn:${TURN_1}`,
    scopeLabel: 'Turn 1',
    ...overrides
  })
}

const entry = (path: string): ReviewFileEntry => ({ path, status: 'modified', additions: 1, deletions: 0, binary: false, countsExact: true })

describe('review comments', () => {
  it('creates a reference the parser accepts, with the absolute path and the selected lines', () => {
    const reference = comment({ root: 'C:\\repo', excerpt: 'line 12\nline 13\nline 14\nline 15' })
    expect(parseChatReference(reference)).toEqual(
      expect.objectContaining({
        kind: 'review-comment',
        title: 'a.ts:12-15',
        path: 'C:\\repo\\src\\a.ts',
        line: 12,
        endLine: 15,
        excerpt: 'line 12\nline 13\nline 14\nline 15',
        reviewScope: `turn:${TURN_1}`
      })
    )
  })

  describe('commentsForFile', () => {
    const base = { absolutePath: '/repo/src/a.ts', platform: 'linux' }

    it('matches by scope and absolute path and ignores other kinds', () => {
      const mine = comment()
      const otherFile = comment({ path: 'src/b.ts' })
      const file: ChatReference = { id: 'file:1', kind: 'file', title: 'a.ts', path: '/repo/src/a.ts', line: 12 }
      expect(commentsForFile([file, otherFile, mine], { ...base, reviewScope: `turn:${TURN_1}` })).toEqual([mine])
      expect(commentsForFile(undefined, { ...base, reviewScope: 'thread' })).toEqual([])
    })

    it('matches a backslash root against a forward-slash path on Windows only', () => {
      const reference = comment({ root: 'C:\\repo' })
      const query = { reviewScope: `turn:${TURN_1}`, absolutePath: 'C:/repo/src/A.ts' }
      expect(commentsForFile([reference], { ...query, platform: 'win32' })).toEqual([reference])
      expect(commentsForFile([reference], { ...query, platform: 'linux' })).toEqual([])
    })

    it('keeps a comment on one version of a file off every other version', () => {
      const onTurn1 = comment()
      const query = (reviewScope: string) => commentsForFile([onTurn1], { ...base, reviewScope })
      expect(query(`turn:${TURN_1}`)).toHaveLength(1)
      expect(query(`turn:${TURN_2}`)).toEqual([])
      expect(query('thread')).toEqual([])

      const staged = comment({ reviewScope: 'worktree:staged' })
      expect(commentsForFile([staged], { ...base, reviewScope: 'worktree:unstaged' })).toEqual([])
      expect(commentsForFile([staged], { ...base, reviewScope: 'worktree:staged' })).toEqual([staged])
    })
  })

  it('counts comments per changed file for the current scope', () => {
    const references = [comment(), comment({ line: 3, endLine: undefined }), comment({ path: 'src/b.ts' }), comment({ reviewScope: 'thread' })]
    const counts = commentCounts(references, {
      reviewScope: `turn:${TURN_1}`,
      root: '/repo',
      files: [entry('src/a.ts'), entry('src/b.ts'), entry('src/c.ts')],
      platform: 'linux'
    })
    expect(Object.fromEntries(counts)).toEqual({ 'src/a.ts': 2, 'src/b.ts': 1 })
  })

  describe('scope keys', () => {
    it.each<ReviewScope>([
      { kind: 'thread' },
      { kind: 'worktree' },
      { kind: 'worktree', staged: true },
      { kind: 'turn', turnId: TURN_1 },
      { kind: 'turn', turnId: 'run:thread:abc%3Adef:ordinal:3' }
    ])('round-trips %j', (scope) => {
      expect(scopeFromKey(scopeKey(scope))).toEqual(scope)
    })

    it('names the scopes a comment can be made on, and every key is a valid comment scope', () => {
      expect(scopeKey({ kind: 'worktree' })).toBe('worktree:unstaged')
      expect(scopeKey({ kind: 'worktree', staged: true })).toBe('worktree:staged')
      expect(scopeFromKey('turn:')).toBeNull()
      expect(scopeFromKey('worktree')).toBeNull()
      expect(commentScopeLabel({ kind: 'thread' })).toBe('This thread')
      expect(commentScopeLabel({ kind: 'worktree' })).toBe('Uncommitted')
      expect(commentScopeLabel({ kind: 'worktree', staged: true })).toBe('Staged changes')
      expect(commentScopeLabel({ kind: 'turn', turnId: TURN_1 }, [{ turnId: TURN_1, label: 'Fix it · 3:04 PM', prompt: 'Fix it', number: 1, endedAt: null, files: 1, undone: false, running: false }])).toBe('Turn: Fix it · 3:04 PM')
      expect(() => comment({ reviewScope: scopeKey({ kind: 'turn', turnId: TURN_1 }) })).not.toThrow()
    })
  })

})

describe('review comments in the composer', () => {
  beforeEach(() => {
    useAppStore.setState({ composerReferences: {}, activeThreadId: 't1' })
    useChangesStore.setState({ byThread: {} })
  })

  it('keeps two comments on the same path and line, and removes only the one asked for', () => {
    const first = comment({ line: 5, endLine: undefined, comment: 'first' })
    const second = comment({ line: 5, endLine: undefined, comment: 'second' })
    expect(first.id).not.toBe(second.id)
    const store = useAppStore.getState()
    store.addComposerReference('t1', first)
    store.addComposerReference('t1', second)
    expect(useAppStore.getState().composerReferences.t1.map((item) => item.comment)).toEqual(['first', 'second'])
    store.removeComposerReference('t1', first.id)
    expect(useAppStore.getState().composerReferences.t1.map((item) => item.comment)).toEqual(['second'])
  })

  it('appends a comment after a reference that is already there', () => {
    const file: ChatReference = { id: 'file:1', kind: 'file', title: 'a.ts', path: '/repo/src/a.ts' }
    const store = useAppStore.getState()
    store.addComposerReference('t1', file)
    store.addComposerReference('t1', comment())
    expect(useAppStore.getState().composerReferences.t1.map((item) => item.kind)).toEqual(['file', 'review-comment'])
  })

  it('sends every comment in one references block with lines, comment and excerpt', () => {
    const content = buildComposerMessageContent('fix it', [], [], [], [
      comment({ excerpt: 'const a = 1\nconst b = 2' }),
      comment({ path: 'src/b.ts', line: 3, endLine: undefined, comment: 'Second' })
    ])
    expect(content.match(/\[Mousse references data=/g)).toHaveLength(1)
    expect(content).toContain('Lines: 12–15')
    expect(content).toContain('Comment: Rename this')
    expect(content).toContain('Comment: Second')
    expect(content).toContain('```ts\nconst a = 1\nconst b = 2\n```')
  })

  describe('a clicked comment pill', () => {
    beforeEach(() => useChangesStore.setState({ byThread: {} }))

    it("asks for the comment's scope before showing its file", () => {
      useChangesStore.getState().show('t1', 'thread')
      useChangesStore.getState().revealComment('t1', { scope: { kind: 'turn', turnId: TURN_2 }, absolutePath: '/repo/src/a.ts', line: 12 })
      expect(useChangesStore.getState().byThread.t1).toMatchObject({
        requested: `turn:${TURN_2}`,
        pendingFile: { path: '/repo/src/a.ts', line: 12 }
      })
    })

    it('opens the file the list maps it to and offers the line once', () => {
      const store = useChangesStore.getState()
      store.revealComment('t1', { scope: { kind: 'thread' }, absolutePath: '/repo/src/a.ts', line: 12 })
      store.resolvePendingFile('t1', 'src/a.ts')
      expect(useChangesStore.getState().byThread.t1.pendingFile).toBeUndefined()
      expect(useChangesStore.getState().byThread.t1.openPath).toBe('src/a.ts')
      expect(useChangesStore.getState().takeReveal('t1', 'src/a.ts')).toEqual({ path: 'src/a.ts', line: 12 })
      expect(useChangesStore.getState().takeReveal('t1', 'src/a.ts')).toBeUndefined()
    })

    it('drops the request when the file is not in that scope', () => {
      const store = useChangesStore.getState()
      store.setOpenPath('t1', 'src/other.ts')
      store.revealComment('t1', { scope: { kind: 'thread' }, absolutePath: '/repo/src/a.ts', line: 12 })
      store.resolvePendingFile('t1', null)
      expect(useChangesStore.getState().byThread.t1.pendingFile).toBeUndefined()
      expect(useChangesStore.getState().byThread.t1.openPath).toBe('src/other.ts')
      expect(useChangesStore.getState().byThread.t1.reveal).toBeUndefined()
    })

    it('is routed to the Changes tab from a comment pill, on the uncommitted diff for a working-tree comment', () => {
      useAppStore.setState({ activeThreadId: 't1' })
      openChatReference(comment({ reviewScope: 'worktree:staged' }))
      expect(useChangesStore.getState().byThread.t1).toMatchObject({
        requested: 'uncommitted',
        pendingFile: { path: '/repo/src/a.ts', line: 12 }
      })
      expect(useAppStore.getState().mainView).toBe('git')
    })
  })
})
