import type {
  GitPullRequestInfo,
  PullRequestBaseBranches,
  PullRequestDraft,
  PullRequestFormInput,
  PullRequestScope
} from '../../../shared/pullRequests'
import { ipcErrorLine } from '../../lib/errorText'

export const PULL_REQUEST_TITLE_LIMIT = 256

/** The create form's contents. A field the user has edited is never overwritten by a draft. */
export interface PullRequestFormState {
  /** The scope the form was opened for; a form belongs to one folder, branch and originating thread. */
  scopeKey: string
  title: string
  body: string
  base: string
  draft: boolean
  edited: { title: boolean; body: boolean; base: boolean }
  /** Set when the branch already had an open pull request: it is shown instead of a new one. */
  existing: GitPullRequestInfo | null
}

export function pullRequestScopeKey(scope: PullRequestScope): string {
  return [scope.path, scope.branch, scope.originThreadId ?? '', scope.threadId ?? '', scope.projectId ?? ''].join('\u0000')
}

export function emptyPullRequestForm(scope: PullRequestScope): PullRequestFormState {
  return {
    scopeKey: pullRequestScopeKey(scope),
    title: '',
    body: '',
    base: '',
    draft: false,
    edited: { title: false, body: false, base: false },
    existing: null
  }
}

export function editPullRequestForm(
  form: PullRequestFormState,
  field: 'title' | 'body' | 'base',
  value: string
): PullRequestFormState {
  return { ...form, [field]: value, edited: { ...form.edited, [field]: true } }
}

/** Puts a drafted title, description and base into the fields the user has not touched; `overwrite` replaces the title and description too. */
export function applyDraft(
  form: PullRequestFormState,
  draft: Pick<PullRequestDraft, 'title' | 'body' | 'base'>,
  options: { overwrite?: boolean } = {}
): PullRequestFormState {
  const overwrite = options.overwrite === true
  return {
    ...form,
    title: overwrite || !form.edited.title ? draft.title : form.title,
    body: overwrite || !form.edited.body ? draft.body : form.body,
    base: !form.edited.base && draft.base ? draft.base : form.base,
    edited: overwrite ? { ...form.edited, title: false, body: false } : form.edited
  }
}

/** Preselects the repository's default branch once the choices arrive, unless a base was picked or drafted. */
export function applyBaseBranches(form: PullRequestFormState, baseBranches: PullRequestBaseBranches): PullRequestFormState {
  if (form.base) return form
  const base = baseBranches.defaultBranch ?? baseBranches.branches[0] ?? ''
  return base ? { ...form, base } : form
}

/** The base choices: the repository's, without the branch the pull request comes from, plus a base that is chosen but not listed. */
export function baseChoices(baseBranches: PullRequestBaseBranches | null, current: string, branch: string): string[] {
  const names = (baseBranches?.branches ?? []).filter((name) => name !== branch)
  return current && current !== branch && !names.includes(current) ? [current, ...names] : names
}

export function canSubmitPullRequest(form: PullRequestFormState, busy: boolean): boolean {
  const title = form.title.trim()
  return !busy && form.existing === null && title.length >= 1 && title.length <= PULL_REQUEST_TITLE_LIMIT && form.base.trim() !== ''
}

export function pullRequestFormInput(form: PullRequestFormState): PullRequestFormInput {
  return { title: form.title.trim(), body: form.body, base: form.base.trim(), draft: form.draft }
}

/** One line for a failed draft or create, without the transport's prefix. */
export function pullRequestFormError(error: unknown): string {
  return ipcErrorLine(error).replace(/^(?:error|fatal):\s*/i, '') || 'The pull request could not be created.'
}
