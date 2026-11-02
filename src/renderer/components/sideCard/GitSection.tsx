import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  Check,
  ChevronDown,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MoreHorizontal,
  Plus,
  Search,
  Upload
} from '../../lib/icons'
import { openSurface } from '../../lib/surfaces'
import { useActiveThreadPullRequest } from '../../hooks/useActiveThreadPullRequest'
import { useTransientError } from '../../hooks/useTransientError'
import {
  CommitPushError,
  OpenPullRequestError,
  commitGitChanges,
  initGitRepository,
  pushGitBranch,
  suggestGitCommitMessage,
  type CommitPhase,
  type GitStatusView
} from '../../stores/gitStatusStore'
import { closePullRequest, createPullRequestForBranch, mergePullRequest, pullRequestMergeMethod, useGitPullRequestStore } from '../../stores/pullRequestStore'
import type { PullRequestDetail, PullRequestMergeMethod, PullRequestPushTarget, PullRequestScope, ThreadPullRequestLink } from '../../../shared/pullRequests'
import { usePullRequestPushTarget } from './usePullRequestPushTarget'
import { gitScopeFor } from '../../lib/activeProject'
import type { GitCommit, GitPullRequestLookup, GitScope } from '../../../shared/types'
import { Switch } from '../settings/SettingsRow'
import {
  CreateBranchDialog,
  DeleteBranchDialog,
  DirtySwitchDialog,
  RenameBranchDialog
} from './BranchDialogs'
import {
  createBranch,
  deleteBranch,
  renameBranch,
  switchBranch,
  type BranchResult,
  type CreateBranchInput
} from './branchActions'
import { GitOperationStatus } from '../git/GitOperationStatus'
import { CardPopover } from './CardPopover'
import { menuRowLabel } from './deviceMenu'
import { PullRequestCreateForm } from './PullRequestCreateForm'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import {
  branchActionState,
  branchChoices,
  branchLabel,
  branchRowMenu,
  branchSearchAria,
  canInitRepository,
  changedFileCount,
  changesSummary,
  chooseAmend,
  clearAmendPrefill,
  commitFlowButtons,
  commitFormFor,
  commitHint,
  commitMenuState,
  commitTrigger,
  commitPhaseLabel,
  commitScope,
  diffStatLabel,
  dirtySwitchChoices,
  emptyCommitForm,
  existingPullRequestNotice,
  forceAmend,
  GIT_BUSY_REASON,
  GIT_CHECKING_LABEL,
  gitActionAvailability,
  gitActionLock,
  gitCollapsedLabel,
  gitErrorCode,
  gitErrorMessage,
  isGitCancelled,
  localBranchNames,
  openPullRequestFailedMessage,
  prefillAmendDraft,
  mergeConfirmation,
  mergedNotice,
  pullRequestList,
  pullRequestReadThreadId,
  pullRequestRow,
  pullRequestRows,
  pullRequestScope,
  pushButtonModel,
  pushFailedMessage,
  releaseForcedAmend,
  THREAD_BRANCH_SWITCH_REASON,
  untrackedFileCount,
  type CommitAvailability,
  type CommitDraft,
  type CommitFlow,
  type CommitForm,
  type DirtySwitchChoiceId,
  type GitAction,
  type GitActionLock,
  type PullRequestFoundRow,
  type PushButtonModel
} from './gitSectionLogic'
import {
  SUGGEST_NO_MODEL_CODE,
  applySuggestion,
  suggestButtonState,
  type SuggestionRequest
} from './commitSuggestLogic'
import './gitSection.css'

/** Where the Git section's collapse choice is kept: one for a repository, one for a folder without one. */
const GIT_KEY = 'Git'
const GIT_NO_REPOSITORY_KEY = 'Git.noRepository'

/** How long a notice stays: it carries something to act on, like a kept stash. */
const NOTICE_MS = 15_000

/** The dialog open under the branch button, if any. */
type BranchDialog =
  | { kind: 'create' }
  | { kind: 'rename'; name: string }
  | { kind: 'delete'; name: string; stage: 'confirm' | 'unmerged' }
  | { kind: 'dirty'; branch: string }

interface BranchPickerProps {
  path: string
  scope: GitScope
  status: GitStatusView['status']
  branches: GitStatusView['branches']
  /** Files with uncommitted changes; a switch asks what to do with them. */
  fileCount: number
  /** Shown on the button while a branch action runs. */
  busyLabel: string | null
  lock: GitActionLock
  /** Why branch actions are unavailable (a thread's own worktree); the branch is then only shown. */
  disabledReason: string | null
  /** Claims the section's one running action; false when another already runs. */
  onBegin: (action: GitAction) => boolean
  onEnd: () => void
  onActionError: (message: string | null) => void
  onNotice: (message: string | null) => void
}

type BranchWork = 'carry' | 'stash' | 'branch'

function BranchPicker({ path, scope, status, branches, fileCount, busyLabel, lock, disabledReason, onBegin, onEnd, onActionError, onNotice }: BranchPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [dialog, setDialog] = useState<BranchDialog | null>(null)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [working, setWorking] = useState<BranchWork | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listId = useId()
  const current = status?.branch ?? null
  const choices = useMemo(() => branchChoices(branches, query), [branches, query])
  const localNames = useMemo(() => localBranchNames(branches), [branches])
  const label = branchLabel(status)
  const dialogDisabled = lock.reason !== null || working !== null

  const close = useCallback(() => {
    setOpen(false)
    setMenuFor(null)
  }, [])
  const closeDialog = useCallback(() => {
    setDialog(null)
    setDialogError(null)
    triggerRef.current?.focus()
  }, [])
  const toggle = () => {
    if (open) return close()
    setQuery('')
    setMenuFor(null)
    setActive(Math.max(0, branchChoices(branches, '').indexOf(current ?? '')))
    setOpen(true)
  }
  const openDialog = (next: BranchDialog) => {
    close()
    setDialogError(null)
    setDialog(next)
  }

  /** Runs one branch action under the section's lock; null when another action holds it. */
  const guarded = async <T,>(action: GitAction, mark: BranchWork | null, run: () => Promise<T>): Promise<T | null> => {
    if (!onBegin(action)) return null
    setWorking(mark)
    setDialogError(null)
    onActionError(null)
    try {
      return await run()
    } finally {
      setWorking(null)
      onEnd()
    }
  }

  const switchTo = async (branch: string, choice: DirtySwitchChoiceId | null) => {
    const outcome = await guarded('checkout', choice === 'carry' || choice === 'stash' ? choice : null, () => switchBranch(path, branch, scope, choice))
    if (!outcome) return
    if (outcome.kind === 'refused') {
      // Git would not carry the changes: the prompt stays, with Stash and switch still on offer.
      setDialogError(outcome.message)
      return
    }
    setDialog(null)
    setDialogError(null)
    if (outcome.kind === 'failed') onActionError(outcome.message)
    if (outcome.kind === 'switched' && outcome.notice) onNotice(outcome.notice)
  }

  const pick = (branch: string) => {
    close()
    triggerRef.current?.focus()
    if (branch === current) return
    if (dirtySwitchChoices(fileCount).length > 0) {
      setDialogError(null)
      setDialog({ kind: 'dirty', branch })
    } else {
      void switchTo(branch, null)
    }
  }

  const finishBranchAction = (result: BranchResult | null) => {
    if (!result) return
    if (result.ok) setDialog(null)
    else setDialogError(result.message)
  }
  const create = async (input: CreateBranchInput) => finishBranchAction(await guarded('branch', 'branch', () => createBranch(path, input, scope)))
  const rename = async (name: string, newName: string) => finishBranchAction(await guarded('branch', 'branch', () => renameBranch(path, name, newName, scope)))
  const remove = async (name: string, stage: 'confirm' | 'unmerged') => {
    const outcome = await guarded('branch', 'branch', () => deleteBranch(path, name, current, scope, stage === 'unmerged'))
    if (!outcome) return
    if (outcome.kind === 'deleted') setDialog(null)
    else if (outcome.kind === 'unmerged') setDialog({ kind: 'delete', name, stage: 'unmerged' })
    else setDialogError(outcome.message)
  }

  useEffect(() => {
    if (open) optionRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  // A thread's own branch cannot be switched; the picker opens on the full name and the reason instead of a list.
  if (disabledReason !== null) {
    return (
      <>
        <button
          ref={triggerRef}
          type="button"
          className="side-card-git-branch"
          title={label}
          aria-label={`Branch ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
          <span className="side-card-git-branch-name">{label}</span>
          <ChevronDown className="side-card-git-branch-chevron" size={11} aria-hidden="true" />
        </button>
        <CardPopover open={open} anchorRef={triggerRef} placement="below-start" label="Branch" onClose={close}>
          <p className="side-card-git-branch-fixed-name">{label}</p>
          <p className="side-card-git-branch-fixed-reason">{disabledReason}</p>
        </CardPopover>
      </>
    )
  }

  const activeName = choices[active]

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="side-card-git-branch"
        title={lock.reason ?? busyLabel ?? undefined}
        aria-label={`Branch ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busyLabel !== null}
        disabled={lock.disabled || !status?.isRepo}
        onClick={toggle}
      >
        <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="side-card-git-branch-name">{busyLabel ?? label}</span>
        <ChevronDown className="side-card-git-branch-chevron" size={11} aria-hidden="true" />
      </button>
      <CardPopover
        open={open}
        anchorRef={triggerRef}
        placement="below-start"
        label="Switch branch"
        initialFocusRef={searchRef}
        sizeKey={`${choices.length}:${menuFor}`}
        onClose={close}
      >
        <label className="side-card-git-search">
          <Search size={13} aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder="Find a branch"
            aria-label="Find a branch"
            {...branchSearchAria(listId, active, choices.length)}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value)
              setActive(0)
              setMenuFor(null)
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (choices.length === 0) return
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActive((index) => (index + step + choices.length) % choices.length)
                setMenuFor(null)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const choice = choices[active]
                if (choice) pick(choice)
              } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                event.preventDefault()
                if (activeName && branchRowMenu(activeName, current).available) setMenuFor((name) => (name === activeName ? null : activeName))
              }
            }}
          />
        </label>
        <div id={listId} className="side-card-git-list scrollbar-ultra-thin" role="listbox" aria-label="Branches">
          {choices.length === 0 ? (
            <p className="side-card-git-empty">No matching branches</p>
          ) : (
            choices.map((name, index) => {
              const menu = branchRowMenu(name, current)
              return (
                <div key={name} role="presentation" className="side-card-git-option-group">
                  <div role="presentation" className="side-card-git-option-row" data-active={index === active} data-menu={menu.available}>
                    <button
                      ref={(element) => { optionRefs.current[index] = element }}
                      id={`${listId}-${index}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={name === current}
                      className="side-card-git-option"
                      data-active={index === active}
                      title={name}
                      onMouseMove={() => setActive(index)}
                      onClick={() => pick(name)}
                    >
                      <span>{name}</span>
                      {name === current && <Check size={12} aria-hidden="true" />}
                    </button>
                    {menu.available && (
                      <button
                        type="button"
                        className="side-card-git-option-more"
                        tabIndex={-1}
                        aria-label={`Actions for ${name}`}
                        aria-expanded={menuFor === name}
                        onClick={() => setMenuFor((value) => (value === name ? null : name))}
                      >
                        <MoreHorizontal size={13} aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {menuFor === name && menu.available && (
                    <div className="side-card-git-option-menu" role="group" aria-label={`Actions for ${name}`}>
                      <button type="button" className="side-card-git-option-action" onClick={() => openDialog({ kind: 'rename', name })}>
                        Rename…
                      </button>
                      <button
                        type="button"
                        className="side-card-git-option-action"
                        disabled={!menu.canDelete}
                        title={menu.deleteReason ?? undefined}
                        onClick={() => openDialog({ kind: 'delete', name, stage: 'confirm' })}
                      >
                        Delete…
                      </button>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
        <div className="side-card-git-picker-footer">
          <button type="button" className="side-card-git-new-branch" onClick={() => openDialog({ kind: 'create' })}>
            <Plus size={12} aria-hidden="true" />
            <span>New branch…</span>
          </button>
        </div>
      </CardPopover>
      <CreateBranchDialog
        open={dialog?.kind === 'create'}
        anchorRef={triggerRef}
        current={current}
        fromChoices={localNames}
        existing={localNames}
        disabled={dialogDisabled}
        working={working === 'branch'}
        error={dialogError}
        onSubmit={(input) => void create(input)}
        onClose={closeDialog}
      />
      {dialog?.kind === 'rename' && (
        <RenameBranchDialog
          open
          anchorRef={triggerRef}
          name={dialog.name}
          existing={localNames}
          disabled={dialogDisabled}
          working={working === 'branch'}
          error={dialogError}
          onSubmit={(newName) => void rename(dialog.name, newName)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteBranchDialog
          open
          anchorRef={triggerRef}
          name={dialog.name}
          stage={dialog.stage}
          disabled={dialogDisabled}
          working={working === 'branch'}
          error={dialogError}
          onConfirm={() => void remove(dialog.name, dialog.stage)}
          onClose={closeDialog}
        />
      )}
      {dialog?.kind === 'dirty' && (
        <DirtySwitchDialog
          open
          anchorRef={triggerRef}
          branch={dialog.branch}
          fileCount={fileCount}
          disabled={dialogDisabled}
          working={working === 'carry' || working === 'stash' ? working : null}
          error={dialogError}
          onChoose={(choice) => {
            if (choice === 'cancel') closeDialog()
            else void switchTo(dialog.branch, choice)
          }}
          onClose={closeDialog}
        />
      )}
    </>
  )
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

function CommitButton({ path, scope: gitScope, branch, fileCount, commits, pushable, openPullRequest, commitAvailability, lock, onBegin, onEnd, onActionError, onNotice }: CommitButtonProps) {
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
  const canSubmit = Boolean(trimmed) && !work && !blocked && commitAvailability.blockedReason === null
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

  // Amend is the only possible commit: keep it on, so files changing under the open popover do not drop it.
  useEffect(() => {
    if (open && menu.forced) updateForm(forceAmend)
  }, [open, menu.forced, updateForm])

  // A forced amend is not the user's choice, so it does not outlive the popover.
  useEffect(() => {
    if (!open) updateForm(releaseForcedAmend)
  }, [open, updateForm])

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
        ...(flow === 'push-pr' && openPullRequest ? { openPullRequest } : {}),
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

function PushButton({ model, busy, lock, onPush }: PushButtonProps) {
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

function openWeb(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

const PULL_REQUEST_ICONS = {
  open: GitPullRequest,
  draft: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed
} as const

/**
 * Merge or close one pull request; resolves with the reason it failed, or null once it is done. `method` is the merge
 * method the confirmation named, which the merge must use; absent when it could not be read.
 */
export type PullRequestChange = (action: 'merge' | 'close', row: PullRequestFoundRow, method?: PullRequestMergeMethod) => Promise<string | null>

/** The method Merge will use for a pull request; null when it cannot be read. */
export type PullRequestMergeMethodRead = (row: PullRequestFoundRow) => Promise<PullRequestMergeMethod | null>

interface PullRequestLinkProps {
  row: PullRequestFoundRow
  /** The Git action running in the section, if any: one at a time. */
  running?: GitAction | null
  onChange?: PullRequestChange
  /** Reads the merge method when the Merge confirmation opens, so it can name it. */
  readMergeMethod?: PullRequestMergeMethodRead
}

/**
 * One of the thread's pull requests: an icon coloured by its state, the title in bold over at most two lines, and the
 * number with its checks on a quiet line. The title opens the pull request panel; the arrow opens it on the host. An open
 * pull request has Merge (the primary action once GitHub would merge it; dimmed with the reason otherwise) and Close,
 * each confirmed first. The Merge confirmation names the merge method it will use.
 */
export function PullRequestLink({ row, running = null, onChange, readMergeMethod }: PullRequestLinkProps) {
  const Icon = PULL_REQUEST_ICONS[row.state]
  const [confirm, setConfirm] = useState<'merge' | 'close' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Undefined while it is read, null when it could not be.
  const [mergeMethod, setMergeMethod] = useState<PullRequestMergeMethod | null | undefined>(undefined)
  const mergeRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const merge = row.merge
  const working = confirm !== null && running === confirm
  const busy = running !== null && !working
  const ask = (action: 'merge' | 'close') => {
    setError(null)
    setMergeMethod(undefined)
    setConfirm(action)
  }
  // The prompt takes focus when it opens, on Cancel: nothing final happens on a stray Enter.
  useEffect(() => {
    if (confirm) cancelRef.current?.focus()
  }, [confirm])
  // The method is read once per confirmation; a refreshed row does not ask again.
  const readRef = useRef({ readMergeMethod, row })
  readRef.current = { readMergeMethod, row }
  useEffect(() => {
    const { readMergeMethod: read, row: asked } = readRef.current
    if (confirm !== 'merge' || !read) return
    let current = true
    read(asked).then((method) => { if (current) setMergeMethod(method) }, () => { if (current) setMergeMethod(null) })
    return () => { current = false }
  }, [confirm])
  const mergePrompt = mergeConfirmation(row.number, row.base, readMergeMethod ? mergeMethod : null)
  // The row's buttons come back once the prompt is gone; focus returns to the one that opened it.
  const dismiss = () => {
    if (working || !confirm) return
    const back = confirm === 'close' ? closeRef : mergeRef
    setConfirm(null)
    setError(null)
    requestAnimationFrame(() => back.current?.focus())
  }
  const run = async () => {
    if (!confirm || !onChange || running !== null) return
    setError(null)
    // The merge uses the method the prompt named, never one read again later.
    const failure = await onChange(confirm, row, confirm === 'merge' ? mergeMethod ?? undefined : undefined)
    if (failure) setError(failure)
    else setConfirm(null)
  }
  return (
    <div className="side-card-git-pr-item">
      <div className="side-card-git-pr-line">
        <button
          type="button"
          className="side-card-git-pr"
          title={row.tooltip}
          aria-label={row.ariaLabel}
          onClick={() => openSurface('pullRequest')}
        >
          <Icon className="side-card-git-pr-icon" data-state={row.state} size={14} strokeWidth={1.8} aria-hidden="true" />
          <span className="side-card-git-pr-title">{row.title || row.number}</span>
        </button>
        <button
          type="button"
          className="side-card-git-pr-external"
          title="Open on GitHub"
          aria-label={`Open pull request ${row.number} on GitHub`}
          onClick={() => openWeb(row.url)}
        >
          <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      </div>
      <div className="side-card-git-pr-meta">
        <span className="side-card-git-pr-number">{row.number}</span>
        {row.checks === 'passing' && <CircleCheck className="side-card-git-pr-check" data-checks="passing" size={13} strokeWidth={1.8} aria-hidden="true" />}
        {row.checks === 'failing' && <CircleX className="side-card-git-pr-check" data-checks="failing" size={13} strokeWidth={1.8} aria-hidden="true" />}
        {row.checks === 'pending' && <span className="side-card-git-pr-pending" aria-hidden="true" />}
        {row.suffix && <span className="side-card-git-pr-suffix">{row.suffix}</span>}
        {/* While a prompt asks, its own buttons stand in for these. */}
        {merge && onChange && !confirm && (
          <span className="side-card-git-pr-actions">
            <button
              ref={closeRef}
              type="button"
              className="side-card-git-pr-close"
              title={busy ? GIT_BUSY_REASON : `Close ${row.number} without merging`}
              aria-label={`Close pull request ${row.number} without merging`}
              aria-disabled={busy || undefined}
              onClick={() => { if (!busy) ask('close') }}
            >
              <GitPullRequestClosed size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>Close</span>
            </button>
            <button
              ref={mergeRef}
              type="button"
              className="side-card-git-pr-merge"
              data-ready={merge.enabled || undefined}
              title={busy ? GIT_BUSY_REASON : merge.reason ?? `Merge ${row.number}`}
              aria-label={merge.reason ? `Merge pull request ${row.number}: ${merge.reason}` : `Merge pull request ${row.number}`}
              aria-disabled={!merge.enabled || busy || undefined}
              onClick={() => { if (merge.enabled && !busy) ask('merge') }}
            >
              <GitMerge size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>Merge</span>
            </button>
          </span>
        )}
      </div>
      {confirm && (
        <div
          className="side-card-git-pr-confirm"
          role="group"
          aria-label={confirm === 'close' ? `Close ${row.number}` : `Merge ${row.number}`}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            event.stopPropagation()
            dismiss()
          }}
        >
          <p className="side-card-git-pr-confirm-text">
            {confirm === 'close' ? `Close ${row.number} without merging? Its branch stays.` : mergePrompt.text}
          </p>
          {error && <p className="side-card-git-error" role="alert" title={error}>{error}</p>}
          <div className="side-card-git-pr-confirm-actions">
            <button ref={cancelRef} type="button" className="side-card-git-submit side-card-git-submit-quiet" disabled={working} onClick={dismiss}>
              Cancel
            </button>
            {confirm === 'merge' ? (
              <button
                type="button"
                className="side-card-git-pr-merge"
                data-ready
                aria-busy={working}
                // Not before the method is known: the button names what it does.
                disabled={running !== null || (readMergeMethod !== undefined && mergeMethod === undefined)}
                onClick={() => void run()}
              >
                <GitMerge size={13} strokeWidth={1.8} aria-hidden="true" />
                <span>{working ? 'Merging…' : mergePrompt.action}</span>
              </button>
            ) : (
              <button type="button" className="side-card-git-submit" aria-busy={working} disabled={running !== null} onClick={() => void run()}>
                {working ? 'Closing…' : 'Close pull request'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** The thread's pull requests, newest first; the rest wait behind "Show N more". */
export function PullRequestList({ rows, running = null, onChange, readMergeMethod }: { rows: readonly PullRequestFoundRow[]; running?: GitAction | null; onChange?: PullRequestChange; readMergeMethod?: PullRequestMergeMethodRead }) {
  const [expanded, setExpanded] = useState(false)
  const { shown, hidden } = pullRequestList(rows, expanded)
  if (shown.length === 0) return null
  return (
    <div className="side-card-git-prs">
      {shown.map((row) => <PullRequestLink key={row.number} row={row} running={running} onChange={onChange} readMergeMethod={readMergeMethod} />)}
      {hidden > 0 && (
        <button type="button" className="side-card-git-pr-more" aria-expanded={false} onClick={() => setExpanded(true)}>
          <ChevronDown size={12} aria-hidden="true" />
          <span>Show {hidden} more</span>
        </button>
      )}
    </div>
  )
}

interface GitSectionViewProps {
  threadId: string | null
  /** The thread whose folder and conversation Git works on; null for a new chat that follows the composer's project pick. */
  ownThreadId?: string | null
  projectId: string | null
  /** The thread whose own worktree `path` is, when it is one; its branch is then fixed. */
  workspaceThreadId?: string | null
  /** Key of the folder Git runs in (`folderKey`, not a path on disk); null when there is none. */
  path: string | null
  git: GitStatusView
  /** The current branch's pull request lookup; null until it has loaded or when there is no branch. */
  pullRequest?: GitPullRequestLookup | null
  /** The same pull request read in full; its reviewers' verdict goes in the row's tooltip. */
  pullRequestDetail?: PullRequestDetail | null
  /** The host's message when that read failed. */
  pullRequestError?: string | null
  /** The pull request the thread is linked to, if any. */
  pullRequestLink?: ThreadPullRequestLink | null
  /** Where Push goes for a thread linked to a pull request; null when it keeps its usual target. */
  pullRequestPushTarget?: PullRequestPushTarget | null
  /** When set, the section shows only this muted line, and starts collapsed once the folder is known to have no repository. */
  collapsedLabel: string | null
  /** The folder is not a repository, so the collapsed section offers to make it one. */
  canInitialize?: boolean
}

/** The section's markup, given its data. `GitSection` supplies the data. */
export function GitSectionView({
  threadId,
  ownThreadId = null,
  projectId,
  workspaceThreadId = null,
  path,
  git,
  pullRequest = null,
  pullRequestDetail = null,
  pullRequestError = null,
  pullRequestLink = null,
  pullRequestPushTarget = null,
  collapsedLabel,
  canInitialize = false
}: GitSectionViewProps) {
  const scope = useMemo(() => gitScopeFor({ projectId, workspaceThreadId }), [projectId, workspaceThreadId])
  const [running, setRunning] = useState<GitAction | null>(null)
  const rowRef = useRef<HTMLDivElement>(null)
  const createForm = useGitPullRequestStore((state) => state.createForm)
  const runningRef = useRef<GitAction | null>(null)
  const [actionError, setActionError] = useTransientError()
  // Said once and left for long enough to read, unlike an error it is not a failure.
  const [notice, setNotice] = useTransientError(NOTICE_MS)

  // One Git action at a time: the ref answers a second click before the state has rendered.
  const begin = (action: GitAction) => {
    if (runningRef.current) return false
    runningRef.current = action
    setRunning(action)
    return true
  }
  const end = () => {
    runningRef.current = null
    setRunning(null)
  }

  if (collapsedLabel !== null || !path) {
    const initialize = async () => {
      if (!path || !begin('init')) return
      setActionError(null)
      try {
        await initGitRepository(path, scope)
      } catch (error) {
        setActionError(gitErrorMessage(error))
      } finally {
        end()
      }
    }
    const initLock = gitActionLock(running, 'init')
    const label = collapsedLabel ?? 'No project folder'
    // Only a settled answer collapses the section; it keeps its own remembered choice, apart from a repository's.
    const settled = label !== GIT_CHECKING_LABEL
    return (
      <SideCardSection
        title="Git"
        threadId={threadId}
        collapseKey={settled ? GIT_NO_REPOSITORY_KEY : GIT_KEY}
        defaultCollapsed={settled}
        collapsedNote={settled ? label : null}
      >
        <p className="side-card-git-quiet side-card-git-collapsed">{label}</p>
        {canInitialize && path && (
          <button
            type="button"
            className="side-card-git-init"
            title={initLock.reason ?? undefined}
            aria-busy={running === 'init'}
            disabled={initLock.disabled}
            onClick={() => void initialize()}
          >
            {running === 'init' ? 'Initializing…' : 'Initialize repository'}
          </button>
        )}
        {actionError && (
          <p className="side-card-git-error" role="alert" title={actionError}>
            {actionError}
          </p>
        )}
      </SideCardSection>
    )
  }

  const push = async () => {
    if (!begin('push')) return
    setActionError(null)
    try {
      await pushGitBranch(path, scope)
    } catch (error) {
      if (!isGitCancelled(error)) setActionError(gitErrorMessage(error))
    } finally {
      end()
    }
  }

  const branch = git.status?.branch ?? null
  // The folder, thread and branch of this click; the form, its draft and its submit use these, not whatever is active later.
  const createScope = pullRequestScope({ path, branch, projectId, ownThreadId })
  const createPullRequest = async () => {
    if (!createScope || !begin('pullRequest')) return
    setActionError(null)
    try {
      await createPullRequestForBranch(createScope)
    } catch (error) {
      setActionError(gitErrorMessage(error))
    } finally {
      end()
    }
  }

  const stat = diffStatLabel(git.diffStats, untrackedFileCount(git.status))
  const fileCount = changedFileCount(git.status)
  const pushButton = pushButtonModel(git.status, git.commits.length, scope, pullRequestPushTarget)
  const availability = gitActionAvailability(git.status, pullRequest, git.commits.length, scope)
  const prRow = pullRequestRow(pullRequest, git.status, pullRequestDetail, pullRequestLink, workspaceThreadId !== null)
  const createLock = gitActionLock(running, 'pullRequest')
  const branchActions = branchActionState(scope.workspaceThreadId)
  const rows = pullRequestRows(pullRequest, git.status, pullRequestDetail, pullRequestLink, workspaceThreadId !== null)
  // Read as the same thread or project the section's lookup was, so a thread on another computer merges there.
  const readThreadId = pullRequestReadThreadId(ownThreadId, workspaceThreadId)
  const changePullRequest: PullRequestChange = async (action, row, method) => {
    if (!begin(action)) return GIT_BUSY_REASON
    const target = { path, branch, number: row.value, ...(readThreadId ? { threadId: readThreadId } : projectId ? { projectId } : {}) }
    try {
      if (action === 'merge') {
        const result = await mergePullRequest(target, row.merge?.headSha ?? undefined, method)
        setNotice(mergedNotice(row.value, result.method))
      } else {
        await closePullRequest(target)
        setNotice(`Closed ${row.number}.`)
      }
      return null
    } catch (error) {
      return gitErrorMessage(error)
    } finally {
      end()
    }
  }

  const readMergeMethod: PullRequestMergeMethodRead = (row) =>
    pullRequestMergeMethod({ path, branch, number: row.value, ...(readThreadId ? { threadId: readThreadId } : projectId ? { projectId } : {}) })

  return (
    <SideCardSection title="Git" threadId={threadId} collapseKey={GIT_KEY}>
      <BranchPicker
        path={path}
        scope={scope}
        status={git.status}
        branches={git.branches}
        fileCount={fileCount}
        busyLabel={running === 'checkout' ? 'Switching…' : running === 'branch' ? 'Updating branches…' : null}
        lock={gitActionLock(running, running === 'branch' ? 'branch' : 'checkout')}
        disabledReason={branchActions.enabled ? null : THREAD_BRANCH_SWITCH_REASON}
        onBegin={begin}
        onEnd={end}
        onActionError={setActionError}
        onNotice={setNotice}
      />
      <div ref={rowRef} className="side-card-git-row">
        {pushButton && (
          <PushButton model={pushButton} busy={running === 'push'} lock={gitActionLock(running, 'push')} onPush={() => void push()} />
        )}
        <CommitButton
          path={path}
          scope={scope}
          branch={branch}
          fileCount={fileCount}
          commits={git.commits}
          pushable={availability.offerCommitAndPush}
          openPullRequest={availability.offerCommitPushAndOpenPr ? createScope : null}
          commitAvailability={availability.commit}
          lock={gitActionLock(running, 'commit')}
          onBegin={() => begin('commit')}
          onEnd={end}
          onActionError={setActionError}
          onNotice={setNotice}
        />
        {prRow?.kind === 'create' && (
          <button
            type="button"
            className="side-card-git-pr-create"
            title={createLock.reason ?? prRow.hint ?? undefined}
            aria-disabled={!prRow.enabled || createLock.disabled}
            onClick={() => {
              if (prRow.enabled && !createLock.disabled) void createPullRequest()
            }}
          >
            <GitPullRequest size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{running === 'pullRequest' ? 'Opening…' : 'Create PR'}</span>
          </button>
        )}
      </div>
      {pushButton?.note && <p className="side-card-git-quiet">{pushButton.note}</p>}
      <GitOperationStatus path={path} />
      <PullRequestCreateForm
        scope={createForm && createForm.path === path && createForm.branch === branch ? createForm : null}
        anchorRef={rowRef}
      />
      <PullRequestList key={`${path}\u0000${branch ?? ''}`} rows={rows} running={running} onChange={changePullRequest} readMergeMethod={readMergeMethod} />
      {prRow?.kind === 'found' && prRow.hint && <p className="side-card-git-pr-hint">{prRow.hint}</p>}
      {pullRequestError && (
        <p className="side-card-git-pr-error" role="alert" title={pullRequestError}>
          {pullRequestError}
        </p>
      )}
      {actionError && (
        <p className="side-card-git-error" role="alert" title={actionError}>
          {actionError}
        </p>
      )}
      {notice && (
        <p className="side-card-git-notice" role="status" title={notice}>
          {notice}
        </p>
      )}
      <button
        type="button"
        className="side-card-git-changes"
        title="Open the Git panel"
        aria-label={`${changesSummary(git.status)}, ${stat.text}. Open the Git panel`}
        onClick={() => openSurface('git')}
      >
        <span className="side-card-git-summary">{changesSummary(git.status)}</span>
        <span className="side-card-git-stat">
          <span className="side-card-git-added" data-zero={stat.addedZero}>{stat.added}</span>
          <span className="side-card-git-removed" data-zero={stat.removedZero}>{stat.removed}</span>
          {stat.untracked && <span className="side-card-git-new">· {stat.untracked}</span>}
        </span>
      </button>
    </SideCardSection>
  )
}

/** Branch, Git actions, the thread's pull requests and change counts for the folder the thread works on. */
export function GitSection({ threadId }: SideCardSectionContext) {
  const { location, git, path, projectId, ownThreadId, link, lookup: pullRequest, detail, detailError } = useActiveThreadPullRequest(threadId)
  const { loading } = location
  const collapse = {
    hasProject: projectId !== null,
    pathPending: loading,
    hasPath: path !== null,
    loaded: git.loaded,
    status: git.status
  }
  const collapsedLabel = gitCollapsedLabel(collapse)
  const pullRequestPushTarget = usePullRequestPushTarget(location.workspaceThreadId, link)
  return (
    <GitSectionView
      threadId={threadId}
      ownThreadId={ownThreadId}
      projectId={projectId}
      workspaceThreadId={location.workspaceThreadId}
      path={path}
      git={git}
      pullRequest={pullRequest}
      pullRequestDetail={detail}
      pullRequestError={detailError}
      pullRequestLink={link}
      pullRequestPushTarget={pullRequestPushTarget}
      collapsedLabel={collapsedLabel}
      canInitialize={canInitRepository(collapse)}
    />
  )
}
