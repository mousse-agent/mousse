import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { GitCommitHorizontal, GitPullRequest, Upload } from '../../lib/icons'
import {
  CommitPushError,
  OpenPullRequestError,
  commitGitChanges,
  pushGitBranch,
  suggestGitCommitMessage,
  type CommitPhase,
  type GitStatusView
} from '../../stores/gitStatusStore'
import { createPullRequestForBranch, useGitPullRequestStore, type PullRequestFormHost } from '../../stores/pullRequestStore'
import type { PullRequestScope } from '../../../shared/pullRequests'
import type { GitCommit, GitScope } from '../../../shared/types'
import { Switch } from '../settings/SettingsRow'
import { CardPopover } from '../sideCard/CardPopover'
import { menuRowLabel } from '../sideCard/deviceMenu'
import { PullRequestCreateForm } from '../sideCard/PullRequestCreateForm'
import { GitOperationStatus } from './GitOperationStatus'
import {
  applySuggestion,
  SUGGEST_NO_MODEL_CODE,
  suggestButtonState,
  type SuggestionRequest
} from '../sideCard/commitSuggestLogic'
import {
  chooseAmend,
  clearAmendPrefill,
  commitFlowButtons,
  commitFormFor,
  commitHint,
  commitMenuState,
  commitPhaseLabel,
  commitScope,
  commitTrigger,
  emptyCommitForm,
  existingPullRequestNotice,
  gitActionLock,
  gitErrorCode,
  gitErrorMessage,
  isGitCancelled,
  openPullRequestFailedMessage,
  prefillAmendDraft,
  pushFailedMessage,
  type CommitAvailability,
  type CommitDraft,
  type CommitFlow,
  type CommitForm,
  type GitAction,
  type GitActionLock,
  type GitActionRowModel,
  type PushButtonModel
} from '../sideCard/gitSectionLogic'
import '../sideCard/gitSection.css'

/**
 * Push, Commit and Create PR for one folder and branch, and the controller behind them. The side card's Git section
 * and the Git panel's diff toolbar both show this row, so a commit or a pull request starts the same way from either;
 * each surface keeps its own one-action-at-a-time lock and shows the Create PR form only when its own button opened it.
 */

/** One Git action at a time on a surface: `begin` claims it (false when another runs), `end` gives it back. */
export function useGitActionRunner(): { running: GitAction | null; begin: (action: GitAction) => boolean; end: () => void } {
  const [running, setRunning] = useState<GitAction | null>(null)
  // The ref answers a second click before the state has rendered.
  const runningRef = useRef<GitAction | null>(null)
  const begin = useCallback((action: GitAction) => {
    if (runningRef.current) return false
    runningRef.current = action
    setRunning(action)
    return true
  }, [])
  const end = useCallback(() => {
    runningRef.current = null
    setRunning(null)
  }, [])
  return { running, begin, end }
}

interface CommitButtonProps {
  path: string
  /** Tells the daemon which folder to commit in, and which rules apply there. */
  scope: GitScope
  branch: string | null
  fileCount: number
  commits: GitCommit[]
  /** The branch has somewhere to push to and is not behind, so the commit can go on to push. */
  pushable: boolean
  /**
   * What "Commit, push and open PR" opens the Create PR form for; null when `gitActionAvailability` does not
   * offer it (behind, diverged, conflicted, a pull request already there, the default branch).
   */
  openPullRequest: PullRequestScope | null
  /** The surface that shows the Create PR form "Commit, push and open PR" opens. */
  formHost: PullRequestFormHost
  /** What a commit would include here, and why none can be made right now. */
  commitAvailability: CommitAvailability
  /** Another Git action is running, so nothing here may start. */
  lock: GitActionLock
  /** Claims the section's one running action; false when another already runs. */
  onBegin: () => boolean
  onEnd: () => void
  onActionError: (message: string) => void
  onNotice: (message: string) => void
}

/** What a running commit is doing: which button started it, and which step it is at. */
interface CommitWork {
  flow: CommitFlow
  phase: CommitPhase
}

export function CommitButton({ path, scope: gitScope, branch, fileCount, commits, pushable, openPullRequest, formHost, commitAvailability, lock, onBegin, onEnd, onActionError, onNotice }: CommitButtonProps) {
  const [open, setOpen] = useState(false)
  const { branch: scopeBranch, head } = commitScope(branch, commits)
  const scope = useMemo(() => ({ branch: scopeBranch, head }), [scopeBranch, head])
  const [storedForm, setForm] = useState<CommitForm>(() => emptyCommitForm(scope))
  const [work, setWork] = useState<CommitWork | null>(null)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const close = useCallback(() => setOpen(false), [])
  // Text belongs to one branch, the amend choice to one HEAD on it. The stored form is replaced as soon
  // as that changes, open or not, so an earlier draft cannot come back with the branch.
  const form = commitFormFor(storedForm, scope)
  if (form !== storedForm) setForm(form)
  const { draft, amendChecked } = form
  const updateForm = useCallback((change: (form: CommitForm) => CommitForm) => {
    setForm((previous) => change(commitFormFor(previous, scope)))
  }, [scope])
  const setDraft = useCallback((change: (draft: CommitDraft) => CommitDraft) => {
    updateForm((value) => {
      const next = change(value.draft)
      return next === value.draft ? value : { ...value, draft: next }
    })
  }, [updateForm])
  const setAmendChecked = useCallback((checked: boolean) => updateForm((value) => chooseAmend(value, checked)), [updateForm])
  const menu = commitMenuState(commits, fileCount, amendChecked, gitScope.workspaceThreadId !== null)
  const trigger = commitTrigger(menu, commitAvailability)
  const { amend } = menu
  const trimmed = draft.message.trim()
  const blocked = lock.reason !== null
  // With nothing to commit, the buttons wait for the user to turn amend on; nothing turns it on for them.
  const canSubmit = Boolean(trimmed) && !work && !blocked && commitAvailability.blockedReason === null && menu.submitReason === null
  // Amend with an empty message starts from the last commit's message, once: clearing it by hand sticks.
  const needsPrefill = amend && open && !work && !trimmed && draft.prefilled === null
  // The suggestion being written, if any. Typing, committing or another branch ends interest in it, so the
  // answer is dropped when it arrives and never replaces text the user wrote.
  const [suggesting, setSuggesting] = useState(false)
  const [noModel, setNoModel] = useState(false)
  const pendingSuggestion = useRef<SuggestionRequest | null>(null)
  const suggest = suggestButtonState({ fileCount, suggesting, committing: Boolean(work), blockedReason: lock.reason, noModel })
  const dropSuggestion = useCallback(() => {
    pendingSuggestion.current = null
    setSuggesting(false)
  }, [])

  // The changes may be committed elsewhere while the popover is open.
  useEffect(() => {
    if (!menu.triggerEnabled) setOpen(false)
  }, [menu.triggerEnabled])

  // The prefill is the message of the HEAD it was read for; a different HEAD cancels the read.
  useEffect(() => {
    if (!needsPrefill) return
    let current = true
    window.mousse.git.lastCommitMessage(gitScope).then(
      (last) => { if (current) setDraft((value) => prefillAmendDraft(value, last)) },
      () => undefined
    )
    return () => { current = false }
  }, [needsPrefill, gitScope, scope, setDraft])

  useEffect(() => {
    if (!amend) setDraft(clearAmendPrefill)
  }, [amend, setDraft])

  const requestSuggestion = async () => {
    if (suggest.disabled) return
    // Only the text in the box now is ever replaced, and only on this branch and HEAD.
    const request: SuggestionRequest = { scope, baseline: draft.message }
    pendingSuggestion.current = request
    setSuggesting(true)
    setError(null)
    try {
      const { message } = await suggestGitCommitMessage(path, gitScope)
      if (pendingSuggestion.current !== request) return
      updateForm((value) => applySuggestion(value, request, message))
    } catch (suggestError) {
      if (pendingSuggestion.current !== request) return
      if (gitErrorCode(suggestError) === SUGGEST_NO_MODEL_CODE) setNoModel(true)
      setError(gitErrorMessage(suggestError))
    } finally {
      if (pendingSuggestion.current === request) dropSuggestion()
    }
  }

  const submit = async (flow: CommitFlow) => {
    if (!canSubmit || !onBegin()) return
    dropSuggestion()
    setWork({ flow, phase: 'committing' })
    setError(null)
    const finish = () => {
      setForm(emptyCommitForm(scope))
      setOpen(false)
    }
    try {
      const result = await commitGitChanges(path, trimmed, gitScope, {
        amend,
        push: flow !== 'commit',
        ...(flow === 'push-pr' && openPullRequest ? { openPullRequest, pullRequestFormHost: formHost } : {}),
        onPhase: (phase) => setWork({ flow, phase })
      })
      finish()
      // The row below shows the pull request the branch already had; a second form would duplicate it.
      if (result.pullRequest?.kind === 'existing') onNotice(existingPullRequestNotice(result.pullRequest))
    } catch (commitError) {
      if (commitError instanceof CommitPushError) {
        finish()
        if (!isGitCancelled(commitError.pushError)) onActionError(pushFailedMessage(commitError.pushError))
      } else if (commitError instanceof OpenPullRequestError) {
        finish()
        onActionError(openPullRequestFailedMessage(commitError))
      } else if (!isGitCancelled(commitError)) {
        setError(gitErrorMessage(commitError))
      }
    } finally {
      setWork(null)
      onEnd()
    }
  }

  const flowButtons = commitFlowButtons({ pushable, openPullRequest: openPullRequest !== null, amend })
  const label = (flow: CommitFlow, idle: string) => (work && work.flow === flow ? commitPhaseLabel(work.phase) : idle)

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="side-card-git-commit-button"
        title={lock.reason ?? trigger.title}
        aria-label={`${trigger.label}: ${lock.reason ?? trigger.title}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!menu.triggerEnabled || blocked}
        onClick={() => {
          setError(null)
          // A title model may have been chosen since the last time.
          setNoModel(false)
          setOpen((value) => !value)
        }}
      >
        <GitCommitHorizontal size={14} strokeWidth={1.8} aria-hidden="true" />
        <span>{trigger.label}</span>
      </button>
      <CardPopover
        open={open}
        anchorRef={triggerRef}
        placement="below-end"
        label={amend ? 'Amend commit' : 'Commit changes'}
        className="side-card-git-commit-popover"
        initialFocusRef={messageRef}
        sizeKey={error}
        onClose={close}
      >
        <textarea
          ref={messageRef}
          className="side-card-git-message"
          value={draft.message}
          rows={3}
          placeholder="Commit message"
          aria-label="Commit message"
          disabled={Boolean(work)}
          onChange={(event) => {
            const message = event.target.value
            // Writing it by hand takes over from a suggestion that has not arrived.
            if (pendingSuggestion.current) dropSuggestion()
            setDraft((value) => ({ message, prefilled: value.prefilled }))
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit('commit')
            }
          }}
        />
        <div className="side-card-git-suggest-row">
          <button
            type="button"
            className="side-card-git-submit side-card-git-submit-quiet side-card-git-suggest"
            title={suggest.title}
            aria-busy={suggesting}
            disabled={suggest.disabled}
            onClick={() => void requestSuggestion()}
          >
            {suggest.label}
          </button>
        </div>
        <label className="side-card-git-amend" data-disabled={menu.amendDisabled} title={menu.amendTitle ?? undefined}>
          <span>Amend last commit</span>
          <Switch
            checked={amend}
            label="Amend last commit"
            disabled={menu.amendDisabled || Boolean(work)}
            onChange={setAmendChecked}
          />
        </label>
        {work && <GitOperationStatus path={path} />}
        {error && (
          <p className="side-card-git-error" role="alert" title={error}>
            {error}
          </p>
        )}
        <div className="side-card-git-popover-footer">
          <span className="side-card-git-hint">{commitHint(amend, menu.shortHash, fileCount, commitAvailability)}</span>
          <div className="side-card-git-popover-actions">
            {flowButtons.map(({ flow, label: idle, quiet }) => (
              <button
                key={flow}
                type="button"
                className={quiet ? 'side-card-git-submit side-card-git-submit-quiet' : 'side-card-git-submit'}
                data-flow={flow}
                title={menu.submitReason ?? undefined}
                disabled={!canSubmit}
                onClick={() => void submit(flow)}
              >
                {label(flow, idle)}
              </button>
            ))}
          </div>
        </div>
      </CardPopover>
    </>
  )
}

interface PushButtonProps {
  model: PushButtonModel
  /** A push is running. */
  busy: boolean
  lock: GitActionLock
  onPush: () => void
}

export function PushButton({ model, busy, lock, onPush }: PushButtonProps) {
  const name = model.count === null ? undefined : model.title
  // The running action's own button has no reason of its own; a branch state that rules a push out does.
  const reason = lock.reason ?? model.disabledReason ?? null
  return (
    <button
      type="button"
      className="side-card-git-push"
      title={reason ?? model.title}
      aria-label={reason ? menuRowLabel(name ?? model.label, reason) : name}
      aria-busy={busy}
      disabled={lock.disabled || model.disabledReason !== undefined}
      onClick={onPush}
    >
      <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
      <span>{busy ? 'Pushing…' : model.label}</span>
      {!busy && model.count !== null && (
        <span className="side-card-git-push-count" aria-hidden="true">↑{model.count}</span>
      )}
    </button>
  )
}

interface GitActionButtonsProps {
  /** The surface showing the row; the Create PR form it opens shows here and nowhere else. */
  host: PullRequestFormHost
  /** Key of the folder Git runs in (`folderKey`). */
  path: string
  scope: GitScope
  git: GitStatusView
  model: GitActionRowModel
  running: GitAction | null
  begin: (action: GitAction) => boolean
  end: () => void
  onActionError: (message: string | null) => void
  onNotice: (message: string) => void
  className?: string
  /** Names the row for assistive tech, for example with the branch it acts on. */
  label?: string
}

/** Push (when there is something to push), Commit, and Create PR (when the branch can get one), with the Create PR form. */
export function GitActionButtons({ host, path, scope, git, model, running, begin, end, onActionError, onNotice, className = 'side-card-git-row', label }: GitActionButtonsProps) {
  const rowRef = useRef<HTMLDivElement>(null)
  const createForm = useGitPullRequestStore((state) => (state.createFormHost === host ? state.createForm : null))
  const { branch, createScope, createRow, pushButton, availability, fileCount } = model

  const push = async () => {
    if (!begin('push')) return
    onActionError(null)
    try {
      await pushGitBranch(path, scope)
    } catch (error) {
      if (!isGitCancelled(error)) onActionError(gitErrorMessage(error))
    } finally {
      end()
    }
  }

  // The folder, thread and branch of this click; the form, its draft and its submit use these, not whatever is active later.
  const createPullRequest = async () => {
    if (!createScope || !begin('pullRequest')) return
    onActionError(null)
    try {
      await createPullRequestForBranch(createScope, host)
    } catch (error) {
      onActionError(gitErrorMessage(error))
    } finally {
      end()
    }
  }

  const createLock = gitActionLock(running, 'pullRequest')
  return (
    <>
      <div ref={rowRef} className={className} role={label ? 'group' : undefined} aria-label={label}>
        {pushButton && (
          <PushButton model={pushButton} busy={running === 'push'} lock={gitActionLock(running, 'push')} onPush={() => void push()} />
        )}
        {/* The popover and its draft belong to one folder: another project, worktree or path starts closed and empty. */}
        <CommitButton
          key={JSON.stringify([path, scope.projectId, scope.workspaceThreadId])}
          path={path}
          scope={scope}
          branch={branch}
          fileCount={fileCount}
          commits={git.commits}
          pushable={availability.offerCommitAndPush}
          openPullRequest={availability.offerCommitPushAndOpenPr ? createScope : null}
          formHost={host}
          commitAvailability={availability.commit}
          lock={gitActionLock(running, 'commit')}
          onBegin={() => begin('commit')}
          onEnd={end}
          onActionError={onActionError}
          onNotice={onNotice}
        />
        {createRow && (
          <button
            type="button"
            className="side-card-git-pr-create"
            title={createLock.reason ?? createRow.hint ?? undefined}
            aria-disabled={!createRow.enabled || createLock.disabled}
            onClick={() => {
              if (createRow.enabled && !createLock.disabled) void createPullRequest()
            }}
          >
            <GitPullRequest size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{running === 'pullRequest' ? 'Opening…' : 'Create PR'}</span>
          </button>
        )}
      </div>
      <PullRequestCreateForm
        scope={createForm && createForm.path === path && createForm.branch === branch ? createForm : null}
        anchorRef={rowRef}
      />
    </>
  )
}
