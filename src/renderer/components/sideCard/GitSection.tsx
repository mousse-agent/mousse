import { useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed
} from '../../lib/icons'
import { openSurface } from '../../lib/surfaces'
import { useActiveThreadPullRequest } from '../../hooks/useActiveThreadPullRequest'
import { useTransientError } from '../../hooks/useTransientError'
import { abortGitInProgress, continueGitInProgress, initGitRepository, pullGit, pushGitBranch, type GitStatusView } from '../../stores/gitStatusStore'
import { cancelGitOperation, useGitOperation } from '../../stores/gitOperationStore'
import { useUpstreamCheck } from '../../stores/upstreamCheckStore'
import { isActive } from '../git/gitOperationLogic'
import { pullResultNotice } from '../git/gitSyncLogic'
import type { PullRequestDetail, ThreadPullRequestLink } from '../../../shared/pullRequests'
import { useRetiredWorktreeNote } from './useRetiredWorktreeNote'
import { gitScopeFor } from '../../lib/activeProject'
import type { GitInProgress, GitPullRequestLookup, GitPullStrategy, GitUpstreamCheck } from '../../../shared/types'
import { useGitActionRunner } from '../git/useGitActionRunner'
import { BranchPicker } from './BranchPicker'
import { NextStepButton, type NextStepChoice } from './NextStepButton'
import {
  PullRequestConfirm,
  pullRequestActions,
  type PullRequestChange,
  type PullRequestMergeMethodRead
} from './PullRequestConfirm'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import {
  branchActionState,
  branchTag,
  canInitRepository,
  continueNotice,
  changedFileCount,
  diffStatLabel,
  GIT_BUSY_REASON,
  GIT_CHECKING_LABEL,
  gitActionLock,
  gitCollapsedLabel,
  gitErrorMessage,
  isGitCancelled,
  nextStep,
  pullFailureMessage,
  pullRequestList,
  pullRequestReadThreadId,
  pullRequestRow,
  pullRequestRows,
  THREAD_BRANCH_SWITCH_REASON,
  untrackedFileCount,
  upstreamFigures,
  type AbortableKind,
  type GitAction,
  type PullRequestFoundRow
} from './gitSectionLogic'
import './gitSection.css'

/** Where the Git section's collapse choice is kept: one for a repository, one for a folder without one. */
const GIT_KEY = 'Git'
const GIT_NO_REPOSITORY_KEY = 'Git.noRepository'

/** How long a notice stays: it carries something to act on, like a kept stash. */
const NOTICE_MS = 15_000

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
  /** When set, the section shows only this muted line, and starts collapsed once the folder is known to have no repository. */
  collapsedLabel: string | null
  /** The folder is not a repository, so the collapsed section offers to make it one. */
  canInitialize?: boolean
  /** "Worktree removed by cleanup on …" while a cleanup rule's retirement of the thread's worktree stands. */
  retiredNote?: string | null
  /** The last quiet look at the remote, which says Pull before anything else when it has new commits. */
  upstreamCheck?: GitUpstreamCheck | null
  /** Clock for "checked 3m ago"; tests pin it. */
  now?: number
}

/**
 * The section's markup, given its data: a glance at the branch, the number of changed files (which opens the
 * Changes tab, where commits and pushes happen) and the thread's pull requests. `GitSection` supplies the data.
 */
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
  collapsedLabel,
  canInitialize = false,
  retiredNote = null,
  upstreamCheck = null,
  now
}: GitSectionViewProps) {
  const retired = retiredNote ? <p className="side-card-git-quiet side-card-git-retired">{retiredNote}</p> : null
  const scope = useMemo(() => gitScopeFor({ projectId, workspaceThreadId }), [projectId, workspaceThreadId])
  const { running, begin, end } = useGitActionRunner()
  const [actionError, setActionError] = useTransientError()
  // Said once and left for long enough to read, unlike an error it is not a failure.
  const [notice, setNotice] = useTransientError(NOTICE_MS)
  // Which of Pull and Abort holds the section's `sync` action, for the busy label.
  const [syncing, setSyncing] = useState<'pull' | 'abort' | 'continue' | null>(null)
  const operation = useGitOperation(path)

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
  const fileCount = changedFileCount(git.status)
  // The counts arrive after the status; until then the row names the files alone rather than a false +0 −0.
  const stat = git.diffStats ? diffStatLabel(git.diffStats, untrackedFileCount(git.status)) : null
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
  const files = fileCount === 1 ? '1 file' : `${fileCount} files`
  const figures = upstreamFigures(git.status, git.commits[0]?.hash ?? null, upstreamCheck)
  const step = nextStep({ status: git.status, figures, scope, commitCount: git.commits.length, pullRequest })
  const tag = branchTag(git.status, figures, step, now ?? Date.now())
  const stepRunning = running === 'push' || running === 'sync'
  const canCancel = stepRunning && operation !== null && isActive(operation) && operation.cancellable && !operation.cancelling
  const busy = !stepRunning ? null : {
    label: running === 'push' ? 'Pushing…' : syncing === 'abort' ? 'Aborting…' : syncing === 'continue' ? 'Continuing…' : 'Pulling…',
    onCancel: canCancel ? () => void cancelGitOperation(path) : null
  }

  const pull = async (strategy: GitPullStrategy) => {
    if (!begin('sync')) return
    setSyncing('pull')
    setActionError(null)
    try {
      const { result } = await pullGit(path, scope, { strategy })
      setNotice(pullResultNotice(result))
    } catch (error) {
      if (!isGitCancelled(error)) setActionError(pullFailureMessage(error))
    } finally {
      setSyncing(null)
      end()
    }
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
  const abort = async (what: AbortableKind) => {
    if (!begin('sync')) return
    setSyncing('abort')
    setActionError(null)
    try {
      setNotice(await abortGitInProgress(path, what, scope) ?? `${what === 'merge' ? 'Merge' : 'Rebase'} aborted`)
    } catch (error) {
      setActionError(gitErrorMessage(error))
    } finally {
      setSyncing(null)
      end()
    }
  }
  const carryOn = async (what: GitInProgress) => {
    if (!begin('sync')) return
    setSyncing('continue')
    setActionError(null)
    try {
      setNotice(continueNotice(what, (await continueGitInProgress(path, what, scope)).result))
    } catch (error) {
      setActionError(gitErrorMessage(error))
    } finally {
      setSyncing(null)
      end()
    }
  }
  const choose = (choice: NextStepChoice) => {
    if (choice.kind === 'open-changes') openSurface('git')
    else if (choice.kind === 'open-pull-request') openSurface('pullRequest')
    else if (choice.kind === 'pull') void pull(choice.strategy)
    else if (choice.kind === 'push') void push()
    else if (choice.kind === 'continue') void carryOn(choice.what)
    else void abort(choice.what)
  }

  return (
    <SideCardSection title="Git" threadId={threadId} collapseKey={GIT_KEY}>
      {retired}
      <div className="side-card-git-glance">
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
          tag={tag}
        />
        {step && (
          <NextStepButton
            step={step}
            busy={busy}
            blockedReason={running !== null && !stepRunning ? GIT_BUSY_REASON : null}
            onChoose={choose}
          />
        )}
        {fileCount > 0 && (
          <div className="side-card-git-changes-row">
            <button
              type="button"
              className="side-card-git-changes"
              title={stat ? `${stat.text}. Open Changes` : 'Open Changes'}
              aria-label={stat ? `${files}, ${stat.text}. Open Changes` : `${files}. Open Changes`}
              onClick={() => openSurface('git')}
            >
              <span className="side-card-git-summary">{files}</span>
              {stat && (
                <span className="side-card-git-stat" aria-hidden="true">
                  <span className="side-card-git-added" data-zero={stat.addedZero || undefined}>{stat.added}</span>
                  <span className="side-card-git-removed" data-zero={stat.removedZero || undefined}>{stat.removed}</span>
                </span>
              )}
            </button>
            <button type="button" className="side-card-git-commit-open" title="Write the commit in Changes" onClick={() => openSurface('git')}>
              Commit
            </button>
          </div>
        )}
      </div>
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
    </SideCardSection>
  )
}

/** The branch, how many files changed and the thread's pull requests, for the folder the thread works on. */
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
  const retiredNote = useRetiredWorktreeNote(ownThreadId, !loading)
  const upstreamCheck = useUpstreamCheck(path, gitScopeFor({ projectId, workspaceThreadId: location.workspaceThreadId }), git.status?.tracking === 'tracked')
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
      collapsedLabel={collapsedLabel}
      canInitialize={canInitRepository(collapse)}
      retiredNote={retiredNote}
      upstreamCheck={upstreamCheck}
    />
  )
}
