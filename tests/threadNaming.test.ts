/**
 * The one request that names a new thread and its branch (`threadNaming.ts`): what is read from its answer. The branch
 * is what follows its label, exactly as the model wrote it; only `branchNameFromModel` judges it.
 */
import { describe, expect, it } from 'vitest'
import { parseThreadNaming } from '../src/mms/orchestrator/threadNaming'
import { branchNameFromModel } from '../src/shared/mousseBranches'

describe('reading the naming answer', () => {
  it.each([
    ['two labelled lines', 'Title: OAuth callback loop\nBranch: oauth-callback-loop', 'OAuth callback loop', 'oauth-callback-loop'],
    ['underscores and slashes in the branch', 'Title: Release task\nBranch: release/task_123', 'Release task', 'release/task_123'],
    ['labels in bold, case kept', '**Title:** Login page\n**Branch:** fix/Login_Page', 'Login page', 'fix/Login_Page'],
    ['the branch first', 'Branch: login-page\nTitle: Login page', 'Login page', 'login-page'],
    ['a title alone', 'OAuth callback loop', 'OAuth callback loop', undefined],
    ['a title that names nothing', 'Title: UNTITLED\nBranch: misc-work', null, 'misc-work'],
    ['a branch alone', 'Branch: login-page', null, 'login-page']
  ])('%s', (_case, answer, title, branch) => {
    expect(parseThreadNaming(answer)).toEqual({ title, ...(branch ? { branch } : {}) })
  })

  it('hands the branch to the branch-name check as written', () => {
    const { branch } = parseThreadNaming('Title: Release task\nBranch: release/task_123')
    expect(branchNameFromModel(branch, 'custom', 'mousse')).toBe('release/task_123')
  })
})
