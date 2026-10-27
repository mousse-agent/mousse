import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SUGGEST_NO_MODEL_CODE,
  SUGGEST_NO_MODEL_TITLE,
  applySuggestion,
  suggestButtonState,
  type SuggestButtonInput,
  type SuggestionRequest
} from '../src/renderer/components/sideCard/commitSuggestLogic'
import { GIT_BUSY_REASON, emptyCommitForm, gitErrorCode, type CommitForm } from '../src/renderer/components/sideCard/gitSectionLogic'
import { suggestGitCommitMessage, useGitStatusStore } from '../src/renderer/stores/gitStatusStore'

const idle: SuggestButtonInput = { fileCount: 3, suggesting: false, committing: false, blockedReason: null, noModel: false }

describe('Suggest button', () => {
  it('is available when there are changes and nothing else is running', () => {
    expect(suggestButtonState(idle)).toEqual({ label: 'Suggest', disabled: false, title: 'Write a message from the changes this commit takes' })
  })

  it('shows progress and cannot be pressed twice', () => {
    expect(suggestButtonState({ ...idle, suggesting: true })).toMatchObject({ label: 'Suggesting…', disabled: true })
  })

  it('is disabled with the reason when no title model is chosen, even with changes', () => {
    expect(suggestButtonState({ ...idle, noModel: true })).toEqual({ label: 'Suggest', disabled: true, title: SUGGEST_NO_MODEL_TITLE })
    expect(SUGGEST_NO_MODEL_TITLE).toMatch(/title model/)
    expect(SUGGEST_NO_MODEL_CODE).toBe('git_suggest_no_model')
  })

  it('is disabled without changes, while another Git action runs and while a commit runs', () => {
    expect(suggestButtonState({ ...idle, fileCount: 0 })).toMatchObject({ disabled: true, title: 'No changes to describe' })
    expect(suggestButtonState({ ...idle, blockedReason: GIT_BUSY_REASON })).toMatchObject({ disabled: true, title: GIT_BUSY_REASON })
    expect(suggestButtonState({ ...idle, committing: true })).toMatchObject({ disabled: true })
  })
})

describe('a suggestion arriving after the box changed', () => {
  const scope = { branch: 'feature', head: 'abc' }
  const form = (message: string, patch: Partial<CommitForm> = {}): CommitForm => ({
    ...emptyCommitForm(scope),
    draft: { message, prefilled: null },
    ...patch
  })
  const request = (baseline = ''): SuggestionRequest => ({ scope, baseline })

  it('fills the empty box it was asked for', () => {
    expect(applySuggestion(form(''), request(), 'Add retry').draft).toEqual({ message: 'Add retry', prefilled: null })
  })

  it('replaces the text it was asked to replace, when that text is still there', () => {
    expect(applySuggestion(form('old draft'), request('old draft'), 'Add retry').draft.message).toBe('Add retry')
  })

  it('never overwrites what the user typed meanwhile', () => {
    const typed = form('my own message')
    expect(applySuggestion(typed, request(''), 'Add retry')).toBe(typed)
    const edited = form('old draft, edited')
    expect(applySuggestion(edited, request('old draft'), 'Add retry')).toBe(edited)
  })

  it('never overwrites an amend prefill that landed meanwhile', () => {
    const prefilled = form('Previous message', { draft: { message: 'Previous message', prefilled: 'Previous message' } })
    expect(applySuggestion(prefilled, request(''), 'Add retry')).toBe(prefilled)
  })

  it('is dropped when the branch or the HEAD changed, since it described other changes', () => {
    const elsewhere = emptyCommitForm({ branch: 'other', head: 'abc' })
    expect(applySuggestion(elsewhere, request(), 'Add retry')).toBe(elsewhere)
    const newHead = emptyCommitForm({ branch: 'feature', head: 'def' })
    expect(applySuggestion(newHead, request(), 'Add retry')).toBe(newHead)
  })

  it('keeps the amend choice and ignores an empty answer', () => {
    const amending = form('', { amendChecked: true })
    expect(applySuggestion(amending, request(), 'Add retry').amendChecked).toBe(true)
    expect(applySuggestion(amending, request(), '  ')).toBe(amending)
  })
})

describe('suggesting through the store', () => {
  const scope = { projectId: 'project-1', workspaceThreadId: null }
  const threadScope = { projectId: 'project-1', workspaceThreadId: 'thread-1' }

  beforeEach(() => {
    useGitStatusStore.setState({ entries: {} })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const install = (suggest: ReturnType<typeof vi.fn>) => vi.stubGlobal('window', { mousse: { git: { suggestCommitMessage: suggest } } })

  it('asks for the folder\'s scope and the branch the box belongs to, and changes nothing else', async () => {
    const suggest = vi.fn(async () => ({ message: 'Add retry', truncated: true }))
    install(suggest)
    useGitStatusStore.setState({
      entries: { '/repo': { status: { isRepo: true, branch: 'feature', upstream: null, tracking: 'none', ahead: 0, behind: 0, changes: [] }, commits: [], branches: null, diffStats: null, loading: false, loaded: true, error: null, fetchedAt: 0 } }
    })
    expect(await suggestGitCommitMessage('/repo', scope)).toEqual({ message: 'Add retry', truncated: true })
    await suggestGitCommitMessage('/repo', threadScope)
    expect(suggest.mock.calls).toEqual([[scope, { expectedBranch: 'feature' }], [threadScope, { expectedBranch: 'feature' }]])
  })

  it('rejects with the code the daemon gave, so the button can tell "no model" from a failure', async () => {
    install(vi.fn(async () => { throw { code: 'git_suggest_no_model', message: 'Choose a title model in Settings to have commit messages suggested.' } }))
    const error = await suggestGitCommitMessage('/repo', scope).catch((caught) => caught)
    expect(gitErrorCode(error)).toBe(SUGGEST_NO_MODEL_CODE)
  })
})
