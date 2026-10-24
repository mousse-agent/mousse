import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject
} from 'react'
import { Check, ChevronDown, GitBranch, Search, X } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition, type FloatingPlacement } from '../../lib/floatingLayer'
import { openSurface } from '../../lib/surfaces'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useActiveProjectLocation } from '../../hooks/useActiveProjectPath'
import {
  CommitPushError,
  checkoutGitBranch,
  commitGitChanges,
  pushGitBranch,
  useGitStatus,
  type GitStatusView
} from '../../stores/gitStatusStore'
import { createPullRequestForBranch, usePullRequest } from '../../stores/pullRequestStore'
import type { GitCommit, GitPullRequestLookup } from '../../../shared/types'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import {
  EMPTY_COMMIT_DRAFT,
  branchChoices,
  branchLabel,
  branchSearchAria,
  changedFileCount,
  changesSummary,
  clearAmendPrefill,
  commitButtonLabels,
  commitHint,
  commitMenuState,
  diffStatLabel,
  formatCommitLine,
  gitCollapsedLabel,
  gitErrorMessage,
  prefillAmendDraft,
  pullRequestRow,
  pushButtonModel,
  pushFailedMessage,
  untrackedFileCount,
  type CommitDraft,
  type PullRequestFoundRow,
  type PushButtonModel
} from './gitSectionLogic'
import './gitSection.css'

/** How long an inline action error stays before it clears itself. */
const ERROR_VISIBLE_MS = 6000

interface CardPopoverProps {
  open: boolean
  anchorRef: RefObject<HTMLElement | null>
  placement: FloatingPlacement
  label: string
  className?: string
  /** Focused once the popover has been positioned. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Recompute the position when the content's size changes. */
  sizeKey?: unknown
  onClose: () => void
  children: ReactNode
}

/** A popover sized to the side card, closed by Escape or a click outside it. */
function CardPopover({
  open,
  anchorRef,
  placement,
  label,
  className,
  initialFocusRef,
  sizeKey,
  onClose,
  children
}: CardPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const style = useFloatingPosition({
    open,
    anchorRef,
    contentRef: popoverRef,
    placement,
    gap: 4,
    deps: [sizeKey]
  })
  const dismissRefs = useMemo(() => [anchorRef, popoverRef], [anchorRef])
  useOutsideDismiss(open, dismissRefs, onClose)

  useEffect(() => {
    if (open && style.visibility === 'visible') initialFocusRef?.current?.focus()
  }, [open, style.visibility, initialFocusRef])

  if (!open) return null
  return (
    <FloatingPortal>
      <div
        ref={popoverRef}
        className={`side-card-git-popover${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-label={label}
        style={style}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          onClose()
          anchorRef.current?.focus()
        }}
      >
        {children}
      </div>
    </FloatingPortal>
  )
}

interface BranchPickerProps {
  status: GitStatusView['status']
  branches: GitStatusView['branches']
  busy: boolean
  onPick: (branch: string) => void
}

function BranchPicker({ status, branches, busy, onPick }: BranchPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const listId = useId()
  const current = status?.branch ?? null
  const choices = useMemo(() => branchChoices(branches, query), [branches, query])
  const label = branchLabel(status)

  const close = useCallback(() => setOpen(false), [])
  const toggle = () => {
    if (open) return close()
    setQuery('')
    setActive(Math.max(0, branchChoices(branches, '').indexOf(current ?? '')))
    setOpen(true)
  }
  const pick = (branch: string) => {
    close()
    triggerRef.current?.focus()
    if (branch !== current) onPick(branch)
  }

  useEffect(() => {
    if (open) optionRefs.current[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="side-card-git-branch"
        title={busy ? 'Switching branch…' : undefined}
        aria-label={`Branch ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busy}
        disabled={busy || !status?.isRepo}
        onClick={toggle}
      >
        <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
        <span className="side-card-git-branch-name">{busy ? 'Switching…' : label}</span>
        <ChevronDown size={11} aria-hidden="true" />
      </button>
      <CardPopover
        open={open}
        anchorRef={triggerRef}
        placement="below-start"
        label="Switch branch"
        initialFocusRef={searchRef}
        sizeKey={choices.length}
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
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                if (choices.length === 0) return
                const step = event.key === 'ArrowDown' ? 1 : -1
                setActive((index) => (index + step + choices.length) % choices.length)
              } else if (event.key === 'Enter') {
                event.preventDefault()
                const choice = choices[active]
                if (choice) pick(choice)
              }
            }}
          />
        </label>
        <div id={listId} className="side-card-git-list scrollbar-ultra-thin" role="listbox" aria-label="Branches">
          {choices.length === 0 ? (
            <p className="side-card-git-empty">No matching branches</p>
          ) : (
            choices.map((name, index) => (
              <button
                key={name}
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
            ))
          )}
        </div>
      </CardPopover>
    </>
  )
}

interface CommitButtonProps {
  path: string
  projectId: string | null
  fileCount: number
  commits: GitCommit[]
  onActionError: (message: string) => void
}

/** What a running commit is doing, and whether it goes on to push. */
interface CommitWork {
  push: boolean
  phase: 'committing' | 'pushing'
}

function CommitButton({ path, projectId, fileCount, commits, onActionError }: CommitButtonProps) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<CommitDraft>(EMPTY_COMMIT_DRAFT)
  const [amendChecked, setAmendChecked] = useState(false)
  const [work, setWork] = useState<CommitWork | null>(null)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const menu = commitMenuState(commits, fileCount, amendChecked)
  const { amend } = menu
  const trimmed = draft.message.trim()
  const labels = commitButtonLabels(amend)
  const canSubmit = Boolean(trimmed) && !work
  // Amend with an empty message starts from the last commit's message, once: clearing it by hand sticks.
  const needsPrefill = amend && open && !trimmed && draft.prefilled === null

  // The changes may be committed elsewhere while the popover is open.
  useEffect(() => {
    if (!menu.triggerEnabled) setOpen(false)
  }, [menu.triggerEnabled])

  useEffect(() => {
    if (!needsPrefill) return
    let current = true
    window.mousse.git.lastCommitMessage(projectId ?? undefined, path).then(
      (last) => { if (current) setDraft((value) => prefillAmendDraft(value, last)) },
      () => undefined
    )
    return () => { current = false }
  }, [needsPrefill, path, projectId])

  useEffect(() => {
    if (!amend) setDraft(clearAmendPrefill)
  }, [amend])

  const submit = async (push: boolean) => {
    if (!canSubmit) return
    setWork({ push, phase: 'committing' })
    setError(null)
    const finish = () => {
      setDraft(EMPTY_COMMIT_DRAFT)
      setAmendChecked(false)
      setOpen(false)
    }
    try {
      await commitGitChanges(path, trimmed, projectId ?? undefined, {
        amend,
        push,
        onPhase: (phase) => setWork({ push, phase })
      })
      finish()
    } catch (commitError) {
      if (commitError instanceof CommitPushError) {
        finish()
        onActionError(pushFailedMessage(commitError.pushError))
      } else {
        setError(gitErrorMessage(commitError))
      }
    } finally {
      setWork(null)
    }
  }

  const label = (push: boolean, idle: string) =>
    work && work.push === push ? (work.phase === 'committing' ? 'Committing…' : 'Pushing…') : idle

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="side-card-git-commit-button"
        title={menu.triggerTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!menu.triggerEnabled}
        onClick={() => {
          setError(null)
          setOpen((value) => !value)
        }}
      >
        Commit
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
          onChange={(event) => setDraft({ message: event.target.value, prefilled: draft.prefilled })}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit(false)
            }
          }}
        />
        <label className="side-card-git-amend" data-disabled={menu.amendDisabled} title={menu.amendTitle ?? undefined}>
          <input
            type="checkbox"
            checked={amend}
            disabled={menu.amendDisabled || Boolean(work)}
            onChange={(event) => setAmendChecked(event.target.checked)}
          />
          <span>Amend last commit</span>
        </label>
        {error && (
          <p className="side-card-git-error" role="alert" title={error}>
            {error}
          </p>
        )}
        <div className="side-card-git-popover-footer">
          <span className="side-card-git-hint">{commitHint(amend, menu.shortHash, fileCount)}</span>
          <div className="side-card-git-popover-actions">
            <button
              type="button"
              className="side-card-git-submit side-card-git-submit-quiet"
              disabled={!canSubmit}
              onClick={() => void submit(true)}
            >
              {label(true, labels.commitAndPush)}
            </button>
            <button
              type="button"
              className="side-card-git-submit"
              disabled={!canSubmit}
              onClick={() => void submit(false)}
            >
              {label(false, labels.commit)}
            </button>
          </div>
        </div>
      </CardPopover>
    </>
  )
}

interface PushButtonProps {
  model: PushButtonModel
  busy: boolean
  onPush: () => void
}

function PushButton({ model, busy, onPush }: PushButtonProps) {
  return (
    <button
      type="button"
      className="side-card-git-push"
      title={model.title}
      aria-label={model.count === null ? undefined : model.title}
      aria-busy={busy}
      disabled={busy}
      onClick={onPush}
    >
      {busy ? 'Pushing…' : model.label}
      {!busy && model.count !== null && (
        <span className="side-card-git-push-count" aria-hidden="true">↑{model.count}</span>
      )}
    </button>
  )
}

function PullRequestLink({ row }: { row: PullRequestFoundRow }) {
  return (
    <button
      type="button"
      className="side-card-git-pr"
      title={row.tooltip}
      aria-label={row.ariaLabel}
      onClick={() => window.open(row.url, '_blank', 'noopener,noreferrer')}
    >
      {row.checks === 'passing' && <Check className="side-card-git-pr-check" data-checks="passing" size={13} strokeWidth={2} aria-hidden="true" />}
      {row.checks === 'failing' && <X className="side-card-git-pr-check" data-checks="failing" size={13} strokeWidth={2} aria-hidden="true" />}
      {row.checks === 'pending' && <span className="side-card-git-pr-pending" aria-hidden="true" />}
      <span className="side-card-git-pr-number">{row.number}</span>
      <span className="side-card-git-pr-title">{row.title}</span>
      {row.suffix && <span className="side-card-git-pr-suffix">{row.suffix}</span>}
    </button>
  )
}

interface GitSectionViewProps {
  threadId: string | null
  projectId: string | null
  /** Folder Git runs in; null when there is none. */
  path: string | null
  git: GitStatusView
  /** The current branch's pull request lookup; null until it has loaded or when there is no branch. */
  pullRequest?: GitPullRequestLookup | null
  /** When set, the section collapses to this one muted line. */
  collapsedLabel: string | null
  /** Clock for commit ages; tests pin it. */
  now?: number
}

/** The section's markup, given its data. `GitSection` supplies the data. */
export function GitSectionView({ threadId, projectId, path, git, pullRequest = null, collapsedLabel, now }: GitSectionViewProps) {
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [pushBusy, setPushBusy] = useState(false)
  const [creatingPullRequest, setCreatingPullRequest] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => {
    if (!actionError) return
    const timer = window.setTimeout(() => setActionError(null), ERROR_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [actionError])

  if (collapsedLabel !== null || !path) {
    return (
      <div className="side-card-section side-card-git-collapsed" data-thread-id={threadId ?? undefined}>
        <p className="side-card-git-quiet">{collapsedLabel ?? 'Git: no project folder'}</p>
      </div>
    )
  }

  const checkout = async (branch: string) => {
    setCheckoutBusy(true)
    setActionError(null)
    try {
      await checkoutGitBranch(path, branch, projectId ?? undefined)
    } catch (error) {
      setActionError(gitErrorMessage(error))
    } finally {
      setCheckoutBusy(false)
    }
  }

  const push = async () => {
    setPushBusy(true)
    setActionError(null)
    try {
      await pushGitBranch(path, projectId ?? undefined)
    } catch (error) {
      setActionError(gitErrorMessage(error))
    } finally {
      setPushBusy(false)
    }
  }

  const branch = git.status?.branch ?? null
  const createPullRequest = async () => {
    if (!branch) return
    setCreatingPullRequest(true)
    setActionError(null)
    try {
      await createPullRequestForBranch(path, branch, projectId ?? undefined)
    } catch (error) {
      setActionError(gitErrorMessage(error))
    } finally {
      setCreatingPullRequest(false)
    }
  }

  const stat = diffStatLabel(git.diffStats, untrackedFileCount(git.status))
  const latest = git.commits[0] ? formatCommitLine(git.commits[0], now ?? Date.now()) : null
  const fileCount = changedFileCount(git.status)
  const pushButton = pushButtonModel(git.status, git.commits.length)
  const prRow = pullRequestRow(pullRequest, git.status)

  return (
    <SideCardSection title="Git" threadId={threadId}>
      <div className="side-card-git-row">
        <BranchPicker status={git.status} branches={git.branches} busy={checkoutBusy} onPick={(name) => void checkout(name)} />
        {pushButton && <PushButton model={pushButton} busy={pushBusy} onPush={() => void push()} />}
        <CommitButton path={path} projectId={projectId} fileCount={fileCount} commits={git.commits} onActionError={setActionError} />
      </div>
      {prRow?.kind === 'found' && <PullRequestLink row={prRow} />}
      {prRow?.kind === 'create' && (
        <button
          type="button"
          className="side-card-git-pr-create"
          title={prRow.hint ?? undefined}
          aria-disabled={!prRow.enabled || creatingPullRequest}
          onClick={() => {
            if (prRow.enabled && !creatingPullRequest) void createPullRequest()
          }}
        >
          {creatingPullRequest ? 'Opening…' : 'Create PR'}
        </button>
      )}
      {actionError && (
        <p className="side-card-git-error" role="alert" title={actionError}>
          {actionError}
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
      {latest && (
        <div className="side-card-git-latest" title={latest.title} aria-label="Latest commit">
          <span className="side-card-git-subject">{latest.subject}</span>
          <span className="side-card-git-hash">{latest.shortHash}</span>
          {latest.when && <span className="side-card-git-when">{latest.when}</span>}
        </div>
      )}
    </SideCardSection>
  )
}

/** Branch, pull request, latest commit, commit button and change counts for the folder the thread works on. */
export function GitSection({ threadId }: SideCardSectionContext) {
  // The same project the Git panel opens on, including a new chat's composer pick.
  const { projectId, path: projectPath, loading } = useActiveProjectLocation()
  // A project-less thread has no folder of its own to show Git state for.
  const path = projectId ? projectPath : null
  const git = useGitStatus(path, projectId)
  const collapsedLabel = gitCollapsedLabel({
    hasProject: projectId !== null,
    pathPending: loading,
    hasPath: path !== null,
    loaded: git.loaded,
    status: git.status
  })
  // No branch, or not a repository: nothing to look up.
  const pullRequest = usePullRequest(path, git.status?.isRepo ? git.status.branch : null, projectId)
  return (
    <GitSectionView
      threadId={threadId}
      projectId={projectId}
      path={path}
      git={git}
      pullRequest={pullRequest}
      collapsedLabel={collapsedLabel}
    />
  )
}
