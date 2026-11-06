import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { WORKTREE_CONFIG_NOTICE, type PullRequestListItem, type ResolvedPullRequestSummary } from '../../shared/pullRequests'
import { useProjectComputerName } from '../hooks/useProjectComputerName'
import { openThreadFromPullRequest, selectThread } from '../lib/threadActions'
import { Spinner } from './ui/Spinner'
import { Modal } from './ui/Modal'
import {
  SIGNED_OUT_LIST,
  SIGNED_OUT_READ,
  enterAction,
  filterPullRequests,
  readFailure,
  rovingIndex,
  signInHint,
  startButtonModel,
  startErrorCode,
  startErrorMessage,
  startReference
} from './startFromPullRequestLogic'
import './startFromPullRequestDialog.css'

type ListState =
  | { status: 'loading' }
  | { status: 'ready'; items: PullRequestListItem[] }
  | { status: 'error'; message: string }
  /** GitHub CLI is not signed in: one muted line, without the CLI's text or the folder's path. */
  | { status: 'signed-out' }

type ResolvedState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; resolved: ResolvedPullRequestSummary }
  | { status: 'error'; message: string }
  | { status: 'signed-out' }

/** A failed read as a state of the list or of the typed pull request. */
function failed(error: unknown): { status: 'error'; message: string } | { status: 'signed-out' } {
  const failure = readFailure(error)
  return failure.signedOut ? { status: 'signed-out' } : { status: 'error', message: failure.message }
}

interface StartFromPullRequestDialogProps {
  projectId: string
  projectName: string
  onClose: () => void
}

/**
 * Starts a thread from a pull request of the project's repository: pick one of its open pull requests or paste a
 * URL, a number or a `gh pr checkout` command. The new thread's worktree starts at the pull request's head and its
 * composer holds the pull request's title, description and review comments. The arrows move through the results from
 * the field or the list; Enter on words picks the highlighted result, and only a second Enter (or Start) starts it.
 */
export function StartFromPullRequestDialog({ projectId, projectName, onClose }: StartFromPullRequestDialogProps) {
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<number | null>(null)
  const [list, setList] = useState<ListState>({ status: 'loading' })
  const [resolved, setResolved] = useState<ResolvedState>({ status: 'idle' })
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  // The highlighted result, moved by the arrows from the field or within the list.
  const [active, setActive] = useState(0)
  const listId = useId()
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])

  useEffect(() => {
    let current = true
    window.mousse.pullRequests.list(projectId).then(
      (items) => {
        if (current) setList({ status: 'ready', items })
      },
      (error: unknown) => {
        if (current) setList(failed(error))
      }
    )
    return () => {
      current = false
    }
  }, [projectId])

  const reference = startReference(query, picked)
  useEffect(() => {
    if (!reference) {
      setResolved({ status: 'idle' })
      return
    }
    let current = true
    setResolved({ status: 'loading' })
    // Typed text settles first, so a URL is not read at every keystroke.
    const timer = setTimeout(() => {
      window.mousse.pullRequests.resolve(projectId, reference).then(
        (answer) => {
          if (current) setResolved({ status: 'ready', resolved: answer })
        },
        (error: unknown) => {
          if (current) setResolved(failed(error))
        }
      )
    }, 300)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [projectId, reference])

  const visible = useMemo(() => (list.status === 'ready' ? filterPullRequests(list.items, query) : []), [list, query])
  const summary = resolved.status === 'ready' ? resolved.resolved.pullRequest : null
  const existing = resolved.status === 'ready' ? resolved.resolved.threads : []
  const button = startButtonModel(summary, existing, starting)
  const activeIndex = visible.length === 0 ? -1 : Math.min(active, visible.length - 1)
  const activeItem = activeIndex >= 0 ? visible[activeIndex] : null
  const computerName = useProjectComputerName(projectId)
  // The list already says to sign in; a typed pull request that fails the same way adds nothing to it.
  const signedOut = list.status === 'signed-out'
  const hint = signInHint(computerName)

  useEffect(() => {
    if (activeIndex >= 0) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' })
  }, [activeIndex])

  const start = async () => {
    if (!reference || starting || resolved.status !== 'ready') return
    setStarting(true)
    setStartError(null)
    try {
      // The notice was on screen when the person chose Start, so the start may turn the setting on.
      const allowWorktreeConfig = resolved.resolved.enablesWorktreeConfig
      await openThreadFromPullRequest({ projectId, reference, allowClosed: button.allowClosed, allowDuplicate: button.allowDuplicate, ...(allowWorktreeConfig ? { allowWorktreeConfig } : {}) })
      onClose()
    } catch (error) {
      // Another thread appeared since the pull request was read: the dialog shows it on the next read.
      if (startErrorCode(error) === 'pull_request_thread_exists') setResolved({ status: 'idle' })
      setStartError(startErrorMessage(error))
    } finally {
      setStarting(false)
    }
  }

  // In the document's body: the sidebar slides, and a transformed ancestor would pin a fixed overlay to itself.
  return createPortal(
    <Modal
      open
      title="Start from pull request"
      onClose={onClose}
      className="start-from-pr-overlay"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!reference || resolved.status !== 'ready' || starting}
            aria-busy={starting}
            onClick={() => void start()}
          >
            {button.label}
          </button>
        </>
      }
    >
      <p className="start-from-pr-lead" title="The new thread starts at the pull request's head commit">
        {computerName ? `${projectName} on ${computerName}` : projectName} · Starts in its own worktree
      </p>
      <input
        className="start-from-pr-input"
        role="combobox"
        aria-label={signedOut ? 'Pull request URL or number' : 'Pull request URL, number or gh pr checkout command, or search the list'}
        aria-controls={listId}
        aria-expanded={visible.length > 0}
        aria-autocomplete="list"
        aria-activedescendant={activeItem ? `${listId}-${activeItem.number}` : undefined}
        // Signed out there is no list to search: only a pull request named outright can be read once the CLI is signed in.
        placeholder={signedOut ? 'PR URL or number' : 'URL, number or `gh pr checkout` command — or search below'}
        value={query}
        autoFocus
        onChange={(event) => {
          setQuery(event.target.value)
          setPicked(null)
          setActive(0)
          setStartError(null)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const next = rovingIndex(Math.max(0, activeIndex), event.key, visible.length)
            if (next !== null) setActive(next)
          } else if (event.key === 'Enter') {
            event.preventDefault()
            const action = enterAction({ query, active: activeItem?.number ?? null, picked })
            if (action === 'pick' && activeItem) setPicked(activeItem.number)
            else if (action === 'start') void start()
          }
        }}
      />
      <div className="start-from-pr-status" role="status" aria-live="polite">
        {resolved.status === 'loading' && (
          <span className="start-from-pr-quiet">
            <Spinner size={12} /> Reading the pull request…
          </span>
        )}
        {summary && (
          <span className="start-from-pr-resolved">
            <strong>#{summary.number}</strong> {summary.title}
            {summary.state !== 'open' ? ` (${summary.state})` : summary.isDraft ? ' (draft)' : ''}
          </span>
        )}
        {resolved.status === 'error' && <span className="start-from-pr-error">{resolved.message}</span>}
        {resolved.status === 'signed-out' && !signedOut && <span className="start-from-pr-quiet" title={hint}>{SIGNED_OUT_READ}</span>}
      </div>
      {existing.length > 0 && (
        <p className="start-from-pr-note">
          &ldquo;{existing[0].name}&rdquo; already works on this pull request.{' '}
          <button
            type="button"
            className="start-from-pr-link"
            onClick={() => {
              void selectThread(existing[0].id)
              onClose()
            }}
          >
            Open it
          </button>
        </p>
      )}
      {summary && summary.state !== 'open' && (
        <p className="start-from-pr-note">This pull request is {summary.state}; the thread starts from its last head commit.</p>
      )}
      {resolved.status === 'ready' && resolved.resolved.enablesWorktreeConfig && <p className="start-from-pr-note">{WORKTREE_CONFIG_NOTICE}</p>}
      {startError && (
        <p className="start-from-pr-error" role="alert">
          {startError}
        </p>
      )}
      <div id={listId} className="start-from-pr-list" role="listbox" aria-label="Open pull requests">
        {list.status === 'loading' && (
          <p className="start-from-pr-quiet">
            <Spinner size={12} /> Loading open pull requests…
          </p>
        )}
        {list.status === 'error' && <p className="start-from-pr-error">{list.message}</p>}
        {list.status === 'signed-out' && <p className="start-from-pr-quiet" title={hint}>{SIGNED_OUT_LIST}</p>}
        {list.status === 'ready' && list.items.length === 0 && <p className="start-from-pr-quiet">No open pull requests.</p>}
        {list.status === 'ready' && list.items.length > 0 && visible.length === 0 && <p className="start-from-pr-quiet">No open pull request matches.</p>}
        {visible.map((item, index) => (
          <button
            key={item.number}
            ref={(element) => { optionRefs.current[index] = element }}
            id={`${listId}-${item.number}`}
            type="button"
            role="option"
            // One stop in the tab order: the highlighted result; the arrows move between the rest.
            tabIndex={index === activeIndex ? 0 : -1}
            aria-selected={picked === item.number}
            data-active={index === activeIndex || undefined}
            className={`start-from-pr-row${picked === item.number ? ' selected' : ''}`}
            onFocus={() => setActive(index)}
            onClick={() => setPicked(item.number)}
            onKeyDown={(event) => {
              const next = rovingIndex(index, event.key, visible.length)
              if (next === null) return
              event.preventDefault()
              setActive(next)
              optionRefs.current[next]?.focus()
            }}
          >
            <span className="start-from-pr-row-title">
              <span className="start-from-pr-row-number">#{item.number}</span> {item.title}
            </span>
            <span className="start-from-pr-row-meta">
              {item.author} · {item.headRefName}
              {item.isCrossRepository ? ' · fork' : ''}
              {item.isDraft ? ' · draft' : ''}
            </span>
          </button>
        ))}
      </div>
    </Modal>,
    document.body
  )
}
