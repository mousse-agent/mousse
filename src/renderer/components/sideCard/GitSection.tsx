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
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MoreHorizontal,
  Plus,
  Search
} from '../../lib/icons'
import { openSurface } from '../../lib/surfaces'
import { useActiveThreadPullRequest } from '../../hooks/useActiveThreadPullRequest'
import { useTransientError } from '../../hooks/useTransientError'
import { initGitRepository, type GitStatusView } from '../../stores/gitStatusStore'
import type { PullRequestDetail, PullRequestPushTarget, ThreadPullRequestLink } from '../../../shared/pullRequests'
import { usePullRequestPushTarget } from './usePullRequestPushTarget'
import { useRetiredWorktreeNote } from './useRetiredWorktreeNote'
import { gitScopeFor } from '../../lib/activeProject'
import type { GitPullRequestLookup, GitScope } from '../../../shared/types'
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
import { GitActionButtons, useGitActionRunner } from '../git/GitActionButtons'
import { GitOperationStatus } from '../git/GitOperationStatus'
import { CardPopover } from './CardPopover'
import {
  PullRequestConfirm,
  pullRequestActions,
  type PullRequestChange,
  type PullRequestMergeMethodRead
} from './PullRequestConfirm'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import {
  branchActionState,
  branchChoices,
  branchLabel,
  branchRowMenu,
  branchSearchAria,
  canInitRepository,
  changesSummary,
  diffStatLabel,
  dirtySwitchChoices,
  GIT_BUSY_REASON,
  GIT_CHECKING_LABEL,
  gitActionLock,
  gitActionRowModel,
  gitCollapsedLabel,
  gitErrorMessage,
  localBranchNames,
  pullRequestList,
  pullRequestReadThreadId,
  pullRequestRow,
  pullRequestRows,
  THREAD_BRANCH_SWITCH_REASON,
  untrackedFileCount,
  type DirtySwitchChoiceId,
  type GitAction,
  type GitActionLock,
  type PullRequestFoundRow
} from './gitSectionLogic'
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

function openWeb(url: string) {
  window.open(url, '_blank', 'noopener,noreferrer')
}

const PULL_REQUEST_ICONS = {
  open: GitPullRequest,
  draft: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed
} as const

export type { PullRequestChange, PullRequestMergeMethodRead }

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
  const mergeRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const merge = row.merge
  const working = confirm !== null && running === confirm
  const busy = running !== null && !working
  // The row's buttons come back once the prompt is gone; focus returns to the one that opened it.
  const dismiss = () => {
    if (!confirm) return
    const back = confirm === 'close' ? closeRef : mergeRef
    setConfirm(null)
    requestAnimationFrame(() => back.current?.focus())
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
              onClick={() => { if (!busy) setConfirm('close') }}
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
              onClick={() => { if (merge.enabled && !busy) setConfirm('merge') }}
            >
              <GitMerge size={13} strokeWidth={1.8} aria-hidden="true" />
              <span>Merge</span>
            </button>
          </span>
        )}
      </div>
      {confirm && (
        <PullRequestConfirm
          key={confirm}
          row={row}
          action={confirm}
          running={running}
          onChange={onChange}
          readMergeMethod={readMergeMethod}
          onDone={() => setConfirm(null)}
          onDismiss={dismiss}
        />
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
      {shown.map((row) => <PullRequestLink key={row.url || row.number} row={row} running={running} onChange={onChange} readMergeMethod={readMergeMethod} />)}
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
  /** "Worktree removed by cleanup on …" while a cleanup rule's retirement of the thread's worktree stands. */
  retiredNote?: string | null
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
  canInitialize = false,
  retiredNote = null
}: GitSectionViewProps) {
  const retired = retiredNote ? <p className="side-card-git-quiet side-card-git-retired">{retiredNote}</p> : null
  const scope = useMemo(() => gitScopeFor({ projectId, workspaceThreadId }), [projectId, workspaceThreadId])
  const { running, begin, end } = useGitActionRunner()
  const [actionError, setActionError] = useTransientError()
  // Said once and left for long enough to read, unlike an error it is not a failure.
  const [notice, setNotice] = useTransientError(NOTICE_MS)

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
        {retired}
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

  const branch = git.status?.branch ?? null
  const stat = diffStatLabel(git.diffStats, untrackedFileCount(git.status))
  const model = gitActionRowModel({
    path,
    scope,
    projectId,
    ownThreadId,
    status: git.status,
    commitCount: git.commits.length,
    pullRequest,
    pullRequestPushTarget
  })
  const prRow = pullRequestRow(pullRequest, git.status, pullRequestDetail, pullRequestLink, workspaceThreadId !== null)
  const branchActions = branchActionState(scope.workspaceThreadId)
  const rows = pullRequestRows(pullRequest, git.status, pullRequestDetail, pullRequestLink, workspaceThreadId !== null)
  // Read as the same thread or project the section's lookup was, so a thread on another computer merges there.
  const readThreadId = pullRequestReadThreadId(ownThreadId, workspaceThreadId)
  const { change: changePullRequest, readMergeMethod } = pullRequestActions({
    path,
    branch,
    projectId,
    threadId: readThreadId,
    begin,
    end,
    onNotice: setNotice
  })

  return (
    <SideCardSection title="Git" threadId={threadId} collapseKey={GIT_KEY}>
      {retired}
      <BranchPicker
        path={path}
        scope={scope}
        status={git.status}
        branches={git.branches}
        fileCount={model.fileCount}
        busyLabel={running === 'checkout' ? 'Switching…' : running === 'branch' ? 'Updating branches…' : null}
        lock={gitActionLock(running, running === 'branch' ? 'branch' : 'checkout')}
        disabledReason={branchActions.enabled ? null : THREAD_BRANCH_SWITCH_REASON}
        onBegin={begin}
        onEnd={end}
        onActionError={setActionError}
        onNotice={setNotice}
      />
      <GitActionButtons
        host="side-card"
        path={path}
        scope={scope}
        git={git}
        model={model}
        running={running}
        begin={begin}
        end={end}
        onActionError={setActionError}
        onNotice={setNotice}
      />
      {model.pushButton?.note && <p className="side-card-git-quiet">{model.pushButton.note}</p>}
      <GitOperationStatus path={path} />
      {/* An open Merge or Close question ends with the thread, folder or branch it was asked in. */}
      <PullRequestList key={JSON.stringify([threadId, projectId, readThreadId, path, branch])} rows={rows} running={running} onChange={changePullRequest} readMergeMethod={readMergeMethod} />
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
  const retiredNote = useRetiredWorktreeNote(ownThreadId, !loading)
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
      retiredNote={retiredNote}
    />
  )
}
