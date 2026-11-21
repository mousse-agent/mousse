import { describe, expect, it } from 'vitest'
import { branchNameFromModel, isIdNamedMousseBranch, isMousseBranchName, isMousseOwnedRef, normalizeBranchPrefix } from '../src/shared/mousseBranches'

describe('the branch prefix a person types', () => {
  it.each([
    ['mousse', 'mousse'],
    ['mousse/', 'mousse'],
    ['  team/alex//  ', 'team/alex'],
    ['my prefix!', 'my-prefix'],
    ['ünïcode', 'n-code'],
    ['.hidden/x.lock', 'hidden/x'],
    ['back\\slash', 'back/slash'],
    ['', ''],
    ['///', ''],
    // Inside the id-named branches' folders, older records would read the branch as another thread's.
    ['mousse/thread', 'mousse'],
    ['mousse/agent/x', 'mousse'],
    [undefined, 'mousse']
  ])('%j is kept as %j', (raw, prefix) => {
    expect(normalizeBranchPrefix(raw)).toBe(prefix)
  })
})

describe('the title model\'s answer for a branch name', () => {
  it.each([
    // Static: a slug under the person's prefix, whatever prefix the model added.
    ['static', 'mousse', 'Login button on Safari', 'mousse/login-button-on-safari'],
    ['static', 'mousse', '`fix/login-button`\nBecause it fixes it.', 'mousse/login-button'],
    ['static', '', 'login-button', 'login-button'],
    ['static', 'team/alex', 'Branch name: login-button', 'team/alex/login-button'],
    // Semantic: a known kind, then a slug; anything else names nothing.
    ['semantic', 'mousse', 'fix/login-button-on-safari', 'fix/login-button-on-safari'],
    ['semantic', 'mousse', 'Feat / Dark mode toggle', 'feat/dark-mode-toggle'],
    ['semantic', 'mousse', 'bugfix/login', undefined],
    ['semantic', 'mousse', 'login-button', undefined],
    // Custom: the whole name, only checked.
    ['custom', 'mousse', 'abc-123/login-button', 'abc-123/login-button'],
    ['custom', 'mousse', 'mousse/thread/other/main', undefined],
    ['custom', 'mousse', 'refs/heads/main', undefined],
    ['custom', 'mousse', 'a..b', undefined],
    ['custom', 'mousse', '-x', undefined],
    ['static', 'mousse', '', undefined],
    ['static', 'mousse', '日本語', undefined]
  ] as const)('%s with prefix %j: %j names %j', (mode, prefix, answer, name) => {
    expect(branchNameFromModel(answer, mode, prefix)).toBe(name)
  })

  it('is never longer than a branch name may be here', () => {
    expect(branchNameFromModel('x'.repeat(300), 'static', 'mousse')!.length).toBeLessThanOrEqual(80)
  })
})

describe('Mousse-owned branches by name (the rule older records rely on)', () => {
  it('are every valid name under mousse/, the id-named ones included, and nothing else', () => {
    for (const name of ['mousse/fix-the-login-button', 'mousse/1a2b3c4d', 'mousse/thread/0f/main', 'mousse/agent/worker', 'mousse/workflow/x/y']) expect(isMousseBranchName(name)).toBe(true)
    for (const name of ['main', 'feature/x', 'mousse', 'mousse/', 'mousse/../main', 'mousse/a..b', 'mousse/x.lock', 'mousse/.hidden', 'mousse/-x', 'mousse/a b', 'refs/heads/mousse/x', undefined, null]) expect(isMousseBranchName(name)).toBe(false)
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
