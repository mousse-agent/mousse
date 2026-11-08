import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, CircleCheck, CircleX, GitPullRequest, Send, Sparkles, Upload } from '../../lib/icons'
import {
  CommitPushError,
  OpenPullRequestError,
  commitGitChanges,
  pushGitBranch,
  suggestGitCommitMessage,
  type CommitPhase
} from '../../stores/gitStatusStore'
import { createPullRequestForBranch, useGitPullRequestStore } from '../../stores/pullRequestStore'
import type { GitCommit, GitScope } from '../../../shared/types'
import { openSurface } from '../../lib/surfaces'
import { requestComposerSend } from '../../lib/composerEvents'
import { PullRequestCreateForm } from '../sideCard/PullRequestCreateForm'
import { GitOperationStatus } from '../git/GitOperationStatus'
import { SUGGEST_NO_MODEL_CODE, suggestButtonState } from '../sideCard/commitSuggestLogic'
import {
  canAmendCommit,
  commitPhaseLabel,
  existingPullRequestNotice,
  gitActionLock,
  gitErrorCode,
  gitErrorMessage,
  isGitCancelled,
  openPullRequestFailedMessage,
  pushFailedMessage,
  type CommitFlow,
  type GitAction,
  type GitActionRowModel
} from '../sideCard/gitSectionLogic'
import { MenuButton, type MenuItem } from './MenuButton'
import { changesErrorText, type CommitSelectionField } from './changesApi'
import { plural, type FooterState } from './changesModel'

interface ChangesFooterProps {
  state: FooterState
  /** Key of the folder Git runs in (`folderKey`). */
  path: string
  scope: GitScope
  commits: GitCommit[]
  model: GitActionRowModel
  /** One Git action at a time on this tab. */
  running: GitAction | null
  begin: (action: GitAction) => boolean
  end: () => void
  onReviewUncommitted: () => void
  onResolveConflicts: () => void
  onRetry: () => void
  /** The selection is really empty: the commit menu offers Include all. */
  onIncludeAll?: () => void
  /** What Commit and Suggest send once the daemon reads selections: everything, or the chosen hunks with their token. */
  commitSelection?: CommitSelectionField
}

/** How long a notice stays: it can carry something to act on. */
const NOTICE_MS = 15_000

/**
 * One line, one next step: Send comments, then Commit (or Review uncommitted when the scope shows something else),
 * then Push, Create PR and the pull request's chip. Push is never implicit; Ctrl/Cmd+Enter commits only from the
 * message field.
 */
export function ChangesFooter({ state, path, scope, commits, model, running, begin, end, onReviewUncommitted, onResolveConflicts, onRetry, onIncludeAll, commitSelection }: ChangesFooterProps) {
  const footerRef = useRef<HTMLDivElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const [message, setMessage] = useState('')
  const [phase, setPhase] = useState<{ flow: CommitFlow; phase: CommitPhase } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [noModel, setNoModel] = useState(false)
  const suggestion = useRef<{ baseline: string } | null>(null)
  const createForm = useGitPullRequestStore((s) => (s.createFormHost === 'changes' ? s.createForm : null))
  const branch = model.branch
  const inThread = scope.workspaceThreadId !== null

  // A draft belongs to one folder and branch.
  useEffect(() => {
    setMessage('')
    setError(null)
    suggestion.current = null
    setSuggesting(false)
  }, [path, branch])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
    return () => window.clearTimeout(timer)
  }, [notice])

  const commitLock = gitActionLock(running, 'commit')
  const suggest = suggestButtonState({ fileCount: model.fileCount, suggesting, committing: phase !== null, blockedReason: commitLock.reason, noModel })

  const requestSuggestion = async () => {
    if (suggest.disabled) return
    const request = { baseline: message }
    suggestion.current = request
    setSuggesting(true)
    setError(null)
    try {
      const result = await suggestGitCommitMessage(path, scope, commitSelection)
      // Typing meanwhile takes over: the answer never replaces text the user wrote.
      if (suggestion.current === request && messageRef.current?.value === request.baseline) setMessage(result.message)
    } catch (suggestError) {
      if (suggestion.current !== request) return
      if (gitErrorCode(suggestError) === SUGGEST_NO_MODEL_CODE) setNoModel(true)
      setError(changesErrorText(suggestError, gitErrorMessage))
    } finally {
      if (suggestion.current === request) {
        suggestion.current = null
        setSuggesting(false)
      }
    }
  }

  const commit = useCallback(async (flow: CommitFlow, amend = false) => {
    let text = message.trim()
    if (!text && amend) text = (await window.mousse.git.lastCommitMessage(scope).catch(() => null))?.trim() ?? ''
    if (!text) {
      messageRef.current?.focus()
      return
    }
    if (!begin('commit')) return
    suggestion.current = null
    setSuggesting(false)
    setPhase({ flow, phase: 'committing' })
    setError(null)
    try {
      const result = await commitGitChanges(path, text, scope, {
        amend,
        push: flow !== 'commit',
        ...(flow === 'push-pr' && model.createScope ? { openPullRequest: model.createScope, pullRequestFormHost: 'changes' as const } : {}),
        onPhase: (next) => setPhase({ flow, phase: next }),
        ...(commitSelection && !amend ? { selection: commitSelection } : {})
      })
      setMessage('')
      if (result.pullRequest?.kind === 'existing') setNotice(existingPullRequestNotice(result.pullRequest))
    } catch (commitError) {
      if (commitError instanceof CommitPushError) {
        setMessage('')
        if (!isGitCancelled(commitError.pushError)) setError(pushFailedMessage(commitError.pushError))
      } else if (commitError instanceof OpenPullRequestError) {
        setMessage('')
        setError(openPullRequestFailedMessage(commitError))
      } else if (!isGitCancelled(commitError)) {
        setError(changesErrorText(commitError, gitErrorMessage))
      }
    } finally {
      setPhase(null)
      end()
    }
  }, [begin, end, message, model.createScope, path, scope, commitSelection])

  const push = async () => {
    if (!begin('push')) return
    setError(null)
    try {
      await pushGitBranch(path, scope)
    } catch (pushError) {
      if (!isGitCancelled(pushError)) setError(gitErrorMessage(pushError))
    } finally {
      end()
    }
  }

  const createPullRequest = async () => {
    if (!model.createScope || !begin('pullRequest')) return
    setError(null)
    try {
      await createPullRequestForBranch(model.createScope, 'changes')
    } catch (createError) {
      setError(gitErrorMessage(createError))
    } finally {
      end()
    }
  }

  const renderStep = () => {
    switch (state.kind) {
      case 'send-comments':
        return (
          <button type="button" className="changes-primary" onClick={requestComposerSend}>
            <Send size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>Send {plural(state.count, 'comment')}</span>
          </button>
        )
      case 'offline':
        return (
          <span className="changes-footer-line">
            <span>{state.computer} offline</span>
            <button type="button" className="changes-link" onClick={onRetry}>Retry</button>
          </span>
        )
      case 'resolve-conflicts':
        return (
          <button type="button" className="changes-primary" title={plural(state.count, 'conflicted file')} onClick={onResolveConflicts}>
            Resolve conflicts
          </button>
        )
      case 'review-uncommitted':
        return (
          <button type="button" className="changes-secondary" onClick={onReviewUncommitted}>
            Review {state.count} uncommitted →
          </button>
        )
      case 'commit': {
        const busy = phase !== null
        const blocked = commitLock.disabled || busy
        const amendAllowed = !inThread && canAmendCommit(commits)
        const items: MenuItem[] = [
          ...(model.availability.offerCommitAndPush ? [{ label: 'Commit and push', disabled: blocked || state.disabled, onSelect: () => void commit('push') }] : []),
          ...(model.availability.offerCommitPushAndOpenPr ? [{ label: 'Commit, push and open PR', disabled: blocked || state.disabled, onSelect: () => void commit('push-pr') }] : []),
          ...(!inThread
            ? [{
              label: 'Amend',
              disabled: blocked || !amendAllowed,
              title: amendAllowed ? 'Add to the last commit' : commits.length === 0 ? 'No commits yet' : 'The last commit is already pushed',
              onSelect: () => void commit('commit', true)
            }]
            : []),
          ...(state.disabled && onIncludeAll ? [{ label: 'Include all', onSelect: onIncludeAll }] : [])
        ]
        return (
          <div className="changes-commit" data-tinted={state.tinted || undefined}>
            <div className="changes-commit-field">
              <textarea
                ref={messageRef}
                className="changes-commit-input"
                rows={1}
                value={message}
                aria-label="Commit message"
                aria-placeholder={state.placeholder}
                title={message ? undefined : state.tinted ? `${state.placeholder} (the default branch)` : state.placeholder}
                disabled={busy}
                onChange={(event) => {
                  if (suggestion.current) {
                    suggestion.current = null
                    setSuggesting(false)
                  }
                  setMessage(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    event.stopPropagation()
                    if (!state.disabled) void commit('commit')
                  }
                }}
              />
              {/* Drawn over the field rather than as its placeholder, which can't end in an ellipsis. */}
              {!message && <span className="changes-commit-placeholder" aria-hidden="true">{state.placeholder}</span>}
              <button
                type="button"
                className="changes-suggest"
                title={suggest.disabled ? suggest.title : 'Suggest a message'}
                aria-label={suggest.disabled ? suggest.title : 'Suggest a message'}
                aria-busy={suggesting}
                disabled={suggest.disabled}
                onClick={() => void requestSuggestion()}
              >
                <Sparkles size={13} strokeWidth={1.8} aria-hidden="true" className={suggesting ? 'icon-pulse' : undefined} />
              </button>
            </div>
            <div className="changes-split">
              <button
                type="button"
                className={`changes-primary${items.length > 0 ? ' changes-split-main' : ''}`}
                disabled={blocked || state.disabled || !message.trim()}
                title={commitLock.reason ?? (message.trim() ? undefined : 'Write a message, or ✦ to suggest one')}
                onClick={() => void commit('commit')}
              >
                {phase ? commitPhaseLabel(phase.phase) : state.label}
              </button>
              {items.length > 0 && (
                <MenuButton label="More ways to commit" className="changes-primary changes-split-more" items={items} disabled={blocked}>
                  <ChevronDown size={13} strokeWidth={2} aria-hidden="true" />
                </MenuButton>
              )}
            </div>
          </div>
        )
      }
      case 'push': {
        const lock = gitActionLock(running, 'push')
        const reason = lock.reason ?? model.pushButton?.disabledReason
        return (
          <button type="button" className="changes-primary" title={reason ?? model.pushButton?.title} disabled={lock.disabled || !state.enabled} onClick={() => void push()}>
            <Upload size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{running === 'push' ? 'Pushing…' : state.label}</span>
          </button>
        )
      }
      case 'create-pr': {
        const lock = gitActionLock(running, 'pullRequest')
        const row = model.createRow
        return (
          <button
            type="button"
            className="changes-primary"
            title={lock.reason ?? row?.hint ?? undefined}
            disabled={lock.disabled || (row ? !row.enabled : false)}
            onClick={() => void createPullRequest()}
          >
            <GitPullRequest size={14} strokeWidth={1.8} aria-hidden="true" />
            <span>{running === 'pullRequest' ? 'Opening…' : 'Create PR'}</span>
          </button>
        )
      }
      case 'pull-request':
        return (
          <button type="button" className="changes-chip" title="Open the pull request" onClick={() => openSurface('pullRequest')}>
            <GitPullRequest size={13} strokeWidth={1.8} aria-hidden="true" />
            <span>#{state.number}</span>
            {state.checks === 'passing' && <CircleCheck size={13} strokeWidth={1.8} className="changes-checks" data-checks="passing" aria-label="Checks passing" />}
            {state.checks === 'failing' && <CircleX size={13} strokeWidth={1.8} className="changes-checks" data-checks="failing" aria-label="Checks failing" />}
            {state.checks === 'pending' && <span className="changes-checks-pending" aria-label="Checks running" />}
          </button>
        )
      default:
        return null
    }
  }

  const step = renderStep()
  if (!step && !error && !notice && running === null) return null
  return (
    <div ref={footerRef} className="changes-footer">
      {error && <p className="changes-footer-message" data-tone="error" role="alert" title={error}>{error}</p>}
      {!error && notice && <p className="changes-footer-message" role="status" title={notice}>{notice}</p>}
      {running !== null && <GitOperationStatus path={path} />}
      <div className="changes-footer-row">{step}</div>
      <PullRequestCreateForm scope={createForm && createForm.path === path && createForm.branch === branch ? createForm : null} anchorRef={footerRef} />
    </div>
  )
}
