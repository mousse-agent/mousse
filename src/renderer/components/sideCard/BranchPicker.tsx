import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, GitBranch, MoreHorizontal, Plus, Search } from '../../lib/icons'
import type { GitStatusView } from '../../stores/gitStatusStore'
import type { GitScope } from '../../../shared/types'
import { CreateBranchDialog, DeleteBranchDialog, DirtySwitchDialog, RenameBranchDialog } from './BranchDialogs'
import { createBranch, deleteBranch, renameBranch, switchBranch, type BranchResult, type CreateBranchInput } from './branchActions'
import { CardPopover } from './CardPopover'
import {
  branchChoices,
  branchLabel,
  branchRowMenu,
  branchSearchAria,
  dirtySwitchChoices,
  localBranchNames,
  type DirtySwitchChoiceId,
  type GitAction,
  type GitActionLock
} from './gitSectionLogic'
import './gitSection.css'

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
  /** Draws the button another way (the Changes tab's sync chip); it then stays usable while branch actions are locked. */
  trigger?: { className: string; content: ReactNode; title: string }
  /** More at the bottom of the popover, such as Pull, Fetch and Abort. */
  footer?: ReactNode
}

type BranchWork = 'carry' | 'stash' | 'branch'

export function BranchPicker({ path, scope, status, branches, fileCount, busyLabel, lock, disabledReason, onBegin, onEnd, onActionError, onNotice, trigger, footer }: BranchPickerProps) {
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
          className={trigger?.className ?? 'side-card-git-branch'}
          title={trigger?.title ?? label}
          aria-label={trigger?.title ?? `Branch ${label}`}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {trigger?.content ?? (
            <>
              <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
              <span className="side-card-git-branch-name">{label}</span>
              <ChevronDown className="side-card-git-branch-chevron" size={11} aria-hidden="true" />
            </>
          )}
        </button>
        <CardPopover open={open} anchorRef={triggerRef} placement={trigger ? 'below-end' : 'below-start'} label="Branch" sizeKey={footer ? 'footer' : undefined} onClose={close}>
          <p className="side-card-git-branch-fixed-name">{label}</p>
          <p className="side-card-git-branch-fixed-reason">{disabledReason}</p>
          {footer}
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
        className={trigger?.className ?? 'side-card-git-branch'}
        title={trigger?.title ?? lock.reason ?? busyLabel ?? undefined}
        aria-label={trigger?.title ?? `Branch ${label}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={busyLabel !== null}
        disabled={trigger ? !status?.isRepo : lock.disabled || !status?.isRepo}
        onClick={toggle}
      >
        {trigger?.content ?? (
          <>
            <GitBranch size={13} strokeWidth={1.8} aria-hidden="true" />
            <span className="side-card-git-branch-name">{busyLabel ?? label}</span>
            <ChevronDown className="side-card-git-branch-chevron" size={11} aria-hidden="true" />
          </>
        )}
      </button>
      <CardPopover
        open={open}
        anchorRef={triggerRef}
        placement={trigger ? 'below-end' : 'below-start'}
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
        {footer}
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
