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
import { Check, ChevronDown, GitBranch, Search } from '../../lib/icons'
import { FloatingPortal, useFloatingPosition, type FloatingPlacement } from '../../lib/floatingLayer'
import { openSurface } from '../../lib/surfaces'
import { useOutsideDismiss } from '../../hooks/useOutsideDismiss'
import { useActiveProjectLocation } from '../../hooks/useActiveProjectPath'
import {
  checkoutGitBranch,
  commitGitChanges,
  useGitStatus,
  type GitStatusView
} from '../../stores/gitStatusStore'
import { SideCardSection, type SideCardSectionContext } from './SideCardSection'
import {
  branchChoices,
  branchLabel,
  changedFileCount,
  changesSummary,
  diffStatLabel,
  formatCommitLine,
  gitCollapsedLabel,
  gitErrorMessage
} from './gitSectionLogic'
import './gitSection.css'

/** How long an inline checkout error stays before it clears itself. */
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
        title={busy ? 'Switching branch…' : `Branch: ${label}`}
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
            aria-controls={listId}
            aria-activedescendant={choices.length ? `${listId}-${active}` : undefined}
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
}

function CommitButton({ path, projectId, fileCount }: CommitButtonProps) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const messageRef = useRef<HTMLTextAreaElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const trimmed = message.trim()
  const hasChanges = fileCount > 0

  // The changes may be committed elsewhere while the popover is open.
  useEffect(() => {
    if (!hasChanges) setOpen(false)
  }, [hasChanges])

  const submit = async () => {
    if (!trimmed || busy || !hasChanges) return
    setBusy(true)
    setError(null)
    try {
      await commitGitChanges(path, trimmed, projectId ?? undefined)
      setMessage('')
      setOpen(false)
    } catch (commitError) {
      setError(gitErrorMessage(commitError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="side-card-git-commit-button"
        title={hasChanges ? 'Commit all changes' : 'No changes to commit'}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!hasChanges}
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
        label="Commit changes"
        className="side-card-git-commit-popover"
        initialFocusRef={messageRef}
        sizeKey={error}
        onClose={close}
      >
        <textarea
          ref={messageRef}
          className="side-card-git-message"
          value={message}
          rows={3}
          placeholder="Commit message"
          aria-label="Commit message"
          disabled={busy}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        {error && (
          <p className="side-card-git-error" role="alert" title={error}>
            {error}
          </p>
        )}
        <div className="side-card-git-popover-footer">
          <span className="side-card-git-hint">
            {fileCount === 1 ? 'Stages 1 file' : `Stages ${fileCount} files`}
          </span>
          <button
            type="button"
            className="side-card-git-submit"
            disabled={!trimmed || busy}
            onClick={() => void submit()}
          >
            {busy ? 'Committing…' : 'Commit'}
          </button>
        </div>
      </CardPopover>
    </>
  )
}

interface GitSectionViewProps {
  threadId: string | null
  projectId: string | null
  /** Folder Git runs in; null when there is none. */
  path: string | null
  git: GitStatusView
  /** When set, the section collapses to this one muted line. */
  collapsedLabel: string | null
  /** Clock for commit ages; tests pin it. */
  now?: number
}

/** The section's markup, given its data. `GitSection` supplies the data. */
export function GitSectionView({ threadId, projectId, path, git, collapsedLabel, now }: GitSectionViewProps) {
  const [checkoutBusy, setCheckoutBusy] = useState(false)
  const [checkoutError, setCheckoutError] = useState<string | null>(null)

  useEffect(() => {
    if (!checkoutError) return
    const timer = window.setTimeout(() => setCheckoutError(null), ERROR_VISIBLE_MS)
    return () => window.clearTimeout(timer)
  }, [checkoutError])

  if (collapsedLabel !== null || !path) {
    return (
      <div className="side-card-section side-card-git-collapsed" data-thread-id={threadId ?? undefined}>
        <p className="side-card-git-quiet">{collapsedLabel ?? 'Git: no project folder'}</p>
      </div>
    )
  }

  const checkout = async (branch: string) => {
    setCheckoutBusy(true)
    setCheckoutError(null)
    try {
      await checkoutGitBranch(path, branch, projectId ?? undefined)
    } catch (error) {
      setCheckoutError(gitErrorMessage(error))
    } finally {
      setCheckoutBusy(false)
    }
  }

  const stat = diffStatLabel(git.diffStats)
  const latest = git.commits[0] ? formatCommitLine(git.commits[0], now ?? Date.now()) : null
  const fileCount = changedFileCount(git.status)

  return (
    <SideCardSection title="Git" threadId={threadId}>
      <div className="side-card-git-row">
        <BranchPicker status={git.status} branches={git.branches} busy={checkoutBusy} onPick={(branch) => void checkout(branch)} />
        <CommitButton path={path} projectId={projectId} fileCount={fileCount} />
      </div>
      {checkoutError && (
        <p className="side-card-git-error" role="alert" title={checkoutError}>
          {checkoutError}
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

/** Branch, latest commit, commit button and change counts for the selected thread's folder. */
export function GitSection({ threadId, projectId }: SideCardSectionContext) {
  const location = useActiveProjectLocation()
  // A thread without a project has nothing of its own to show Git state for.
  const path = projectId ? location.path : null
  const git = useGitStatus(path, projectId)
  const collapsedLabel = gitCollapsedLabel({
    hasProject: projectId !== null,
    pathPending: location.loading,
    hasPath: path !== null,
    loaded: git.loaded,
    status: git.status
  })
  return (
    <GitSectionView
      threadId={threadId}
      projectId={projectId}
      path={path}
      git={git}
      collapsedLabel={collapsedLabel}
    />
  )
}
