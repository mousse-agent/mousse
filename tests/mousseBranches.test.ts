import { describe, expect, it } from 'vitest'
import { isIdNamedMousseBranch, isMousseBranchName, isMousseOwnedRef, THREAD_BRANCH_SLUG_MAX, threadBranchName, threadBranchSlug } from '../src/shared/mousseBranches'

describe('thread branch names', () => {
  it('are a short lowercase ASCII slug of the first message', () => {
    expect(threadBranchSlug('Fix the login button on Safari!')).toBe('fix-the-login-button-on-safari')
    expect(threadBranchSlug('  Crème brûlée — résumé ÅNGSTRÖM  ')).toBe('creme-brulee-resume-angstrom')
    expect(threadBranchSlug('Add `foo/bar.ts` & update ../docs (v2)')).toBe('add-foo-bar-ts-update-docs-v2')
    const long = threadBranchSlug('Refactor the provider layer so that every adapter shares one session loop and one retry policy')
    expect(long.length).toBeLessThanOrEqual(THREAD_BRANCH_SLUG_MAX)
    expect(long).toBe('refactor-the-provider-layer-so-that')
    expect(threadBranchSlug('x'.repeat(100))).toHaveLength(THREAD_BRANCH_SLUG_MAX)
    expect(threadBranchSlug('日本語だけ 🙂')).toBe('')
  })

  it('live under mousse/, fall back to the thread id when the message has no usable word, and get a suffix when taken', () => {
    const none = () => false
    expect(threadBranchName('Fix the login button', 'b7c1e2d3-0000-4000-8000-000000000000', none)).toBe('mousse/fix-the-login-button')
    expect(threadBranchName('🙂', 'B7C1E2D3-0000-4000-8000-000000000000', none)).toBe('mousse/thread-b7c1e2d3')
    expect(threadBranchName(undefined, 'abc', none)).toBe('mousse/thread-abc')
    const taken = new Set(['mousse/fix-the-login-button', 'mousse/fix-the-login-button-2'])
    expect(threadBranchName('Fix the login button', 'id', (name) => taken.has(name))).toBe('mousse/fix-the-login-button-3')
  })

  it('never take a name the id-named branches need', () => {
    expect(threadBranchName('Thread', 'id', () => false)).toBe('mousse/thread-2')
    expect(threadBranchName('agent', 'id', () => false)).toBe('mousse/agent-2')
    expect(threadBranchName('Workflow!', 'id', () => false)).toBe('mousse/workflow-2')
  })
})

describe('Mousse-owned branches', () => {
  it('are every valid name under mousse/, the id-named ones included, and nothing else', () => {
    for (const name of ['mousse/fix-the-login-button', 'mousse/thread/0f/main', 'mousse/agent/worker', 'mousse/workflow/x/y']) expect(isMousseBranchName(name)).toBe(true)
    for (const name of ['main', 'feature/x', 'mousse', 'mousse/', 'mousse/../main', 'mousse/a..b', 'mousse/x.lock', 'mousse/.hidden', 'mousse/a b', 'refs/heads/mousse/x', undefined, null]) expect(isMousseBranchName(name)).toBe(false)
    expect(isIdNamedMousseBranch('mousse/thread/0f/main')).toBe(true)
    expect(isIdNamedMousseBranch('mousse/fix-the-login-button')).toBe(false)
    expect(isIdNamedMousseBranch('mousse/thread-ab12cd34')).toBe(false)
  })

  it('as refs: Mousse\'s own refs and branches under refs/heads/mousse/', () => {
    expect(isMousseOwnedRef('refs/mousse/threads/t/main')).toBe(true)
    expect(isMousseOwnedRef('refs/heads/mousse/fix-the-login-button')).toBe(true)
    expect(isMousseOwnedRef('refs/heads/mousse/thread/t/main')).toBe(true)
    expect(isMousseOwnedRef('refs/heads/feature/x')).toBe(false)
    expect(isMousseOwnedRef('refs/heads/mousse')).toBe(false)
    expect(isMousseOwnedRef('refs/tags/mousse/x')).toBe(false)
  })
})
