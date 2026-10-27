import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { PullRequestCreateFormBody } from '../src/renderer/components/sideCard/PullRequestCreateForm'
import {
  applyBaseBranches,
  applyDraft,
  baseChoices,
  canSubmitPullRequest,
  editPullRequestForm,
  emptyPullRequestForm,
  pullRequestFormError,
  pullRequestFormInput,
  pullRequestScopeKey,
  type PullRequestFormState
} from '../src/renderer/components/sideCard/pullRequestFormLogic'
import type { GitPullRequestInfo, PullRequestScope } from '../src/shared/pullRequests'

const scope: PullRequestScope = { threadId: 't1', originThreadId: 't1', path: '/repo/a', branch: 'feature/login' }
const draft = { title: 'Retry the login', body: 'It retries.', base: 'main' }

const form = (patch: Partial<PullRequestFormState> = {}): PullRequestFormState => ({ ...emptyPullRequestForm(scope), ...patch })

describe('pull request form logic', () => {
  it('starts empty, bound to its scope', () => {
    const empty = emptyPullRequestForm(scope)
    expect(empty).toMatchObject({ title: '', body: '', base: '', draft: false, existing: null, edited: { title: false, body: false, base: false } })
    expect(empty.scopeKey).toBe(pullRequestScopeKey(scope))
    expect(pullRequestScopeKey({ ...scope, branch: 'other' })).not.toBe(empty.scopeKey)
    expect(pullRequestScopeKey({ ...scope, originThreadId: null })).not.toBe(empty.scopeKey)
  })

  it('fills the fields the user has not touched with a draft', () => {
    expect(applyDraft(emptyPullRequestForm(scope), draft)).toMatchObject(draft)
  })

  it('keeps a field the user edited, and fills the others', () => {
    const edited = editPullRequestForm(emptyPullRequestForm(scope), 'title', 'My own title')
    expect(applyDraft(edited, draft)).toMatchObject({ title: 'My own title', body: 'It retries.', base: 'main' })
    const body = editPullRequestForm(emptyPullRequestForm(scope), 'body', 'Mine')
    expect(applyDraft(body, draft)).toMatchObject({ title: 'Retry the login', body: 'Mine' })
    const base = editPullRequestForm(emptyPullRequestForm(scope), 'base', 'release')
    expect(applyDraft(base, draft).base).toBe('release')
  })

  it('replaces the title and description when asked to draft again, but never the chosen base', () => {
    const edited = editPullRequestForm(editPullRequestForm(editPullRequestForm(emptyPullRequestForm(scope), 'title', 'Mine'), 'body', 'Mine'), 'base', 'release')
    const again = applyDraft(edited, draft, { overwrite: true })
    expect(again).toMatchObject({ title: 'Retry the login', body: 'It retries.', base: 'release' })
    expect(again.edited).toEqual({ title: false, body: false, base: true })
  })

  it('preselects the default branch once the choices arrive, unless a base is already set', () => {
    const branches = { defaultBranch: 'main', branches: ['main', 'release', 'feature/login'] }
    expect(applyBaseBranches(emptyPullRequestForm(scope), branches).base).toBe('main')
    expect(applyBaseBranches(form({ base: 'release' }), branches).base).toBe('release')
    expect(applyBaseBranches(emptyPullRequestForm(scope), { defaultBranch: null, branches: ['dev'] }).base).toBe('dev')
    expect(applyBaseBranches(emptyPullRequestForm(scope), { defaultBranch: null, branches: [] }).base).toBe('')
  })

  it('offers the repository\'s branches without the pull request\'s own, and a base chosen but not listed', () => {
    const branches = { defaultBranch: 'main', branches: ['main', 'release', 'feature/login'] }
    expect(baseChoices(branches, 'main', 'feature/login')).toEqual(['main', 'release'])
    expect(baseChoices(branches, 'hotfix', 'feature/login')).toEqual(['hotfix', 'main', 'release'])
    expect(baseChoices(null, '', 'feature/login')).toEqual([])
  })

  it('submits only with a title of 1 to 256 characters, a base, and nothing running', () => {
    const ready = form({ title: ' A title ', base: 'main' })
    expect(canSubmitPullRequest(ready, false)).toBe(true)
    expect(canSubmitPullRequest(ready, true)).toBe(false)
    expect(canSubmitPullRequest(form({ title: '   ', base: 'main' }), false)).toBe(false)
    expect(canSubmitPullRequest(form({ title: 'x'.repeat(257), base: 'main' }), false)).toBe(false)
    expect(canSubmitPullRequest(form({ title: 'x'.repeat(256), base: 'main' }), false)).toBe(true)
    expect(canSubmitPullRequest(form({ title: 'A title', base: '' }), false)).toBe(false)
    expect(canSubmitPullRequest(form({ title: 'A title', base: 'main', existing: {} as GitPullRequestInfo }), false)).toBe(false)
  })

  it('builds the request from the form', () => {
    expect(pullRequestFormInput(form({ title: ' A title ', body: 'Body\n', base: ' main ', draft: true }))).toEqual({
      title: 'A title',
      body: 'Body\n',
      base: 'main',
      draft: true
    })
  })

  it('shows a failure as one plain line', () => {
    expect(pullRequestFormError(new Error("Error invoking remote method 'pullRequests:create': Error: The branch changed while this was open. Review it, then try again."))).toBe(
      'The branch changed while this was open. Review it, then try again.'
    )
    expect(pullRequestFormError(new Error(''))).toBe('The pull request could not be created.')
  })
})

describe('pull request form markup', () => {
  const handlers = {
    onEdit: vi.fn(),
    onDraftChange: vi.fn(),
    onDraftAgain: vi.fn(),
    onSubmit: vi.fn(),
    onClose: vi.fn()
  }
  const render = (patch: Partial<Parameters<typeof PullRequestCreateFormBody>[0]> = {}) =>
    renderToStaticMarkup(createElement(PullRequestCreateFormBody, {
      form: form({ title: 'Retry the login', body: 'It retries.', base: 'main' }),
      branch: 'feature/login',
      baseBranches: { defaultBranch: 'main', branches: ['main', 'release', 'feature/login'] },
      drafting: false,
      submitting: false,
      error: null,
      ...handlers,
      ...patch
    }))

  it('shows the title, description, base choices with the default selected, the draft switch and the actions', () => {
    const html = render()
    expect(html).toContain('aria-label="Pull request title"')
    expect(html).toContain('value="Retry the login"')
    expect(html).toContain('>It retries.</textarea>')
    expect(html).toMatch(/<option value="main" selected="">main<\/option>/)
    expect(html).toContain('<option value="release">release</option>')
    expect(html).not.toContain('<option value="feature/login"')
    expect(html).toContain('Draft pull request')
    expect(html).toContain('feature/login → main')
    expect(html).toContain('>Draft from thread<')
    expect(html).toMatch(/class="side-card-git-submit"(?![^>]*disabled)[^>]*>Create</)
    expect(html).toContain('>Cancel<')
  })

  it('disables Create without a title and while creating, but not while a draft is being written', () => {
    expect(render({ form: form({ title: '', base: 'main' }) })).toMatch(/class="side-card-git-submit"[^>]*disabled=""[^>]*>Create</)
    const drafting = render({ drafting: true })
    expect(drafting).toMatch(/class="side-card-git-submit"(?![^>]*disabled)[^>]*>Create</)
    expect(drafting).toContain('Drafting…')
    expect(render({ submitting: true })).toContain('>Creating…<')
  })

  it('shows a failure and keeps the form', () => {
    const html = render({ error: 'GraphQL: Head sha can\'t be blank' })
    expect(html).toContain('role="alert"')
    expect(html).toContain('Head sha can&#x27;t be blank')
    expect(html).toContain('value="Retry the login"')
  })

  it('shows the existing open pull request instead of the form', () => {
    const existing: GitPullRequestInfo = {
      number: 77,
      title: 'Already open',
      url: 'https://github.com/acme/app/pull/77',
      state: 'open',
      isDraft: true,
      checks: 'none',
      checkCounts: { passed: 0, failed: 0, pending: 0, waiting: 0, total: 0 }
    }
    const html = render({ form: form({ title: 'x', base: 'main', existing }) })
    expect(html).toContain('already has an open pull request')
    expect(html).toContain('#77')
    expect(html).toContain('Already open')
    expect(html).toContain('>Draft<')
    expect(html).toContain('>Close<')
    expect(html).not.toContain('Pull request title')
    expect(html).not.toContain('>Create<')
  })
})
