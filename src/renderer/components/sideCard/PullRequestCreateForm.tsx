import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import type { PullRequestBaseBranches, PullRequestScope } from '../../../shared/pullRequests'
import {
  closeCreatePullRequestForm,
  draftPullRequestFor,
  loadPullRequestBaseBranches,
  submitCreatePullRequest
} from '../../stores/pullRequestStore'
import { Switch } from '../settings/SettingsRow'
import { CardPopover } from './CardPopover'
import {
  PULL_REQUEST_TITLE_LIMIT,
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
} from './pullRequestFormLogic'

interface FormBodyProps {
  form: PullRequestFormState
  /** The branch the pull request comes from. */
  branch: string
  baseBranches: PullRequestBaseBranches | null
  /** A title and description are being drafted. */
  drafting: boolean
  /** The pull request is being created. */
  submitting: boolean
  error: string | null
  titleRef?: RefObject<HTMLInputElement | null>
  onEdit: (field: 'title' | 'body' | 'base', value: string) => void
  onDraftChange: (draft: boolean) => void
  onDraftAgain: () => void
  onSubmit: () => void
  onClose: () => void
}

/** The form's contents, given its state; `PullRequestCreateForm` supplies the state and the popover. */
export function PullRequestCreateFormBody({
  form,
  branch,
  baseBranches,
  drafting,
  submitting,
  error,
  titleRef,
  onEdit,
  onDraftChange,
  onDraftAgain,
  onSubmit,
  onClose
}: FormBodyProps) {
  if (form.existing) {
    const { existing } = form
    return (
      <div className="side-card-git-pr-form">
        <p className="side-card-git-pr-note">This branch already has an open pull request, so none was created.</p>
        <button
          type="button"
          className="side-card-git-pr side-card-git-pr-existing"
          title={existing.title}
          onClick={() => window.open(existing.url, '_blank', 'noopener,noreferrer')}
        >
          <span className="side-card-git-pr-number">#{existing.number}</span>
          <span className="side-card-git-pr-title">{existing.title}</span>
          {existing.isDraft && <span className="side-card-git-pr-suffix">Draft</span>}
        </button>
        <div className="side-card-git-popover-actions">
          <button type="button" className="side-card-git-submit" onClick={onClose}>Close</button>
        </div>
      </div>
    )
  }

  const choices = baseChoices(baseBranches, form.base, branch)
  const submitOnShortcut = (event: { key: string; metaKey: boolean; ctrlKey: boolean; preventDefault: () => void }) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      onSubmit()
    }
  }
  return (
    <div className="side-card-git-pr-form">
      <input
        ref={titleRef}
        type="text"
        className="side-card-git-pr-title-input"
        value={form.title}
        maxLength={PULL_REQUEST_TITLE_LIMIT}
        placeholder={drafting ? 'Drafting a title…' : 'Title'}
        aria-label="Pull request title"
        spellCheck
        disabled={submitting}
        onChange={(event) => onEdit('title', event.target.value)}
        onKeyDown={submitOnShortcut}
      />
      <textarea
        className="side-card-git-message side-card-git-pr-body"
        value={form.body}
        rows={8}
        placeholder={drafting ? 'Drafting a description…' : 'Description'}
        aria-label="Pull request description"
        disabled={submitting}
        onChange={(event) => onEdit('body', event.target.value)}
        onKeyDown={submitOnShortcut}
      />
      <label className="side-card-git-pr-base">
        <span>Into</span>
        <select
          value={form.base}
          aria-label="Base branch"
          disabled={submitting || choices.length === 0}
          onChange={(event) => onEdit('base', event.target.value)}
        >
          {choices.length === 0 && <option value="">No branches</option>}
          {choices.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </label>
      <label className="side-card-git-amend">
        <span>Draft pull request</span>
        <Switch checked={form.draft} label="Draft pull request" disabled={submitting} onChange={onDraftChange} />
      </label>
      {error && (
        <p className="side-card-git-error" role="alert" title={error}>
          {error}
        </p>
      )}
      <div className="side-card-git-popover-footer">
        <span className="side-card-git-hint" title={`${branch} into ${form.base || '…'}`}>
          {branch} → {form.base || '…'}
        </span>
        <div className="side-card-git-popover-actions">
          <button type="button" className="side-card-git-submit side-card-git-submit-quiet" disabled={drafting || submitting} onClick={onDraftAgain}>
            {drafting ? 'Drafting…' : 'Draft from thread'}
          </button>
          <button type="button" className="side-card-git-submit side-card-git-submit-quiet" disabled={submitting} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="side-card-git-submit" disabled={!canSubmitPullRequest(form, submitting)} onClick={onSubmit}>
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}

interface PullRequestCreateFormProps {
  /** The scope the form is open for in this section; null when it is closed or open for another folder or branch. */
  scope: PullRequestScope | null
  anchorRef: RefObject<HTMLElement | null>
}

/**
 * The Create PR form: title, description, base branch and draft toggle, drafted from the thread and the
 * branch's commits. Everything it asks the daemon carries the scope it opened with. Closing keeps what was
 * typed for the same scope; creating the pull request (or opening for another scope) starts afresh.
 */
export function PullRequestCreateForm({ scope, anchorRef }: PullRequestCreateFormProps) {
  const [form, setForm] = useState<PullRequestFormState | null>(null)
  const [baseBranches, setBaseBranches] = useState<PullRequestBaseBranches | null>(null)
  const [drafting, setDrafting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  /** The scope whose draft and base branches were last requested. */
  const startedKey = useRef<string | null>(null)
  /** A draft that lands once the create has started would change text that is already being sent. */
  const submittingRef = useRef(false)
  const scopeKey = scope ? pullRequestScopeKey(scope) : null

  const runDraft = useCallback(async (forScope: PullRequestScope, key: string, base: string | undefined, overwrite: boolean) => {
    setDrafting(true)
    setError(null)
    try {
      const draft = await draftPullRequestFor(forScope, base)
      if (submittingRef.current) return
      setForm((previous) => (previous?.scopeKey === key ? applyDraft(previous, draft, { overwrite }) : previous))
    } catch (draftError) {
      setError(pullRequestFormError(draftError))
    } finally {
      setDrafting(false)
    }
  }, [])

  useEffect(() => {
    if (!scope || scopeKey === null || startedKey.current === scopeKey) return
    startedKey.current = scopeKey
    setForm(emptyPullRequestForm(scope))
    setBaseBranches(null)
    setError(null)
    void runDraft(scope, scopeKey, undefined, false)
    loadPullRequestBaseBranches(scope).then(
      (branches) => {
        if (startedKey.current !== scopeKey) return
        setBaseBranches(branches)
        setForm((previous) => (previous?.scopeKey === scopeKey ? applyBaseBranches(previous, branches) : previous))
      },
      () => undefined
    )
  }, [scope, scopeKey, runDraft])

  /** Dismissing (Escape, a click outside) keeps what was typed for the same scope. */
  const close = useCallback(() => closeCreatePullRequestForm(), [])
  /** Cancel, or closing the existing pull request's notice, is the user's word that the form is done. */
  const discard = useCallback(() => {
    startedKey.current = null
    setForm(null)
    closeCreatePullRequestForm()
  }, [])
  const submit = async () => {
    if (!scope || !form || !canSubmitPullRequest(form, submitting)) return
    submittingRef.current = true
    setSubmitting(true)
    setError(null)
    try {
      const result = await submitCreatePullRequest(scope, pullRequestFormInput(form))
      if (result.existing) {
        setForm({ ...form, existing: result.pullRequest })
      } else {
        discard()
      }
    } catch (submitError) {
      setError(pullRequestFormError(submitError))
    } finally {
      submittingRef.current = false
      setSubmitting(false)
    }
  }

  const open = scope !== null && form !== null
  return (
    <CardPopover
      open={open}
      anchorRef={anchorRef}
      placement="below-start"
      label="Create pull request"
      className="side-card-git-pr-popover"
      initialFocusRef={titleRef}
      sizeKey={`${error}${form?.existing ? 'existing' : ''}`}
      onClose={close}
    >
      {scope && form && (
        <PullRequestCreateFormBody
          form={form}
          branch={scope.branch}
          baseBranches={baseBranches}
          drafting={drafting}
          submitting={submitting}
          error={error}
          titleRef={titleRef}
          onEdit={(field, value) => setForm((previous) => (previous ? editPullRequestForm(previous, field, value) : previous))}
          onDraftChange={(draft) => setForm((previous) => (previous ? { ...previous, draft } : previous))}
          onDraftAgain={() => void runDraft(scope, form.scopeKey, form.base || undefined, true)}
          onSubmit={() => void submit()}
          onClose={discard}
        />
      )}
    </CardPopover>
  )
}
