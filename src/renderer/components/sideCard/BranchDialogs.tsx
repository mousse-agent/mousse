import { useRef, useState, type RefObject } from 'react'
import { CardPopover } from './CardPopover'
import {
  branchNameError,
  deleteBranchPrompt,
  dirtySwitchChoices,
  dirtySwitchMessage
} from './gitSectionLogic'
import type { CreateBranchInput } from './branchActions'

interface DialogProps {
  open: boolean
  /** The branch button the dialog hangs from. */
  anchorRef: RefObject<HTMLElement | null>
  /** An action runs (this one or another): nothing may be submitted. */
  disabled: boolean
  /** Why the last attempt failed; shown in the dialog. */
  error: string | null
  onClose: () => void
}

function DialogError({ error }: { error: string | null }) {
  if (!error) return null
  return (
    <p className="side-card-git-error" role="alert" title={error}>
      {error}
    </p>
  )
}

interface CreateBranchDialogProps extends DialogProps {
  /** The checked-out branch; null on a detached HEAD. */
  current: string | null
  /** Where the branch can start from. */
  fromChoices: readonly string[]
  /** Local branch names the new name must not collide with. */
  existing: readonly string[]
  /** The running action is this dialog's own. */
  working: boolean
  onSubmit: (input: CreateBranchInput) => void
}

function CreateBranchForm({ current, fromChoices, existing, disabled, working, error, inputRef, onSubmit }: Omit<CreateBranchDialogProps, 'open' | 'anchorRef' | 'onClose'> & { inputRef: RefObject<HTMLInputElement | null> }) {
  const [name, setName] = useState('')
  const [from, setFrom] = useState(current ?? '')
  const trimmed = name.trim()
  const nameError = branchNameError(name, existing)
  const canSubmit = trimmed !== '' && nameError === null && !disabled
  const submit = (checkout: boolean) => {
    // Starting from the checked-out branch is starting from HEAD, which is what Git does when told nothing.
    if (canSubmit) onSubmit({ name: trimmed, from: from === '' || from === current ? null : from, checkout })
  }
  return (
    <form
      className="side-card-git-branch-form"
      onSubmit={(event) => {
        event.preventDefault()
        submit(true)
      }}
    >
      <input
        ref={inputRef}
        className="side-card-git-branch-input"
        type="text"
        value={name}
        placeholder="New branch name"
        aria-label="New branch name"
        aria-invalid={nameError !== null}
        spellCheck={false}
        autoComplete="off"
        disabled={working}
        onChange={(event) => setName(event.target.value)}
      />
      <label className="side-card-git-branch-from">
        <span>From</span>
        <select value={from} aria-label="Start from" disabled={working} onChange={(event) => setFrom(event.target.value)}>
          {current === null && <option value="">Current commit</option>}
          {fromChoices.map((choice) => (
            <option key={choice} value={choice}>{choice}</option>
          ))}
        </select>
      </label>
      <DialogError error={nameError ?? error} />
      <div className="side-card-git-popover-actions">
        <button type="button" className="side-card-git-submit side-card-git-submit-quiet" disabled={!canSubmit} onClick={() => submit(false)}>
          Create
        </button>
        <button type="submit" className="side-card-git-submit" disabled={!canSubmit}>
          {working ? 'Creating…' : 'Create and switch'}
        </button>
      </div>
    </form>
  )
}

/** Name, start point and whether to switch. Enter creates and switches. */
export function CreateBranchDialog({ open, anchorRef, onClose, ...form }: CreateBranchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <CardPopover open={open} anchorRef={anchorRef} placement="below-start" label="New branch" className="side-card-git-branch-popover" initialFocusRef={inputRef} sizeKey={form.error} onClose={onClose}>
      <CreateBranchForm {...form} inputRef={inputRef} />
    </CardPopover>
  )
}

interface RenameBranchDialogProps extends DialogProps {
  name: string
  existing: readonly string[]
  working: boolean
  onSubmit: (newName: string) => void
}

function RenameBranchForm({ name, existing, disabled, working, error, inputRef, onSubmit }: Omit<RenameBranchDialogProps, 'open' | 'anchorRef' | 'onClose'> & { inputRef: RefObject<HTMLInputElement | null> }) {
  const [value, setValue] = useState(name)
  const trimmed = value.trim()
  // The branch's own name is not a collision; leaving it unchanged is simply nothing to do.
  const nameError = branchNameError(value, existing.filter((other) => other !== name))
  const canSubmit = trimmed !== '' && trimmed !== name && nameError === null && !disabled
  return (
    <form
      className="side-card-git-branch-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSubmit) onSubmit(trimmed)
      }}
    >
      <input
        ref={inputRef}
        className="side-card-git-branch-input"
        type="text"
        value={value}
        aria-label={`New name for ${name}`}
        aria-invalid={nameError !== null}
        spellCheck={false}
        autoComplete="off"
        disabled={working}
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setValue(event.target.value)}
      />
      <DialogError error={nameError ?? error} />
      <div className="side-card-git-popover-actions">
        <button type="submit" className="side-card-git-submit" disabled={!canSubmit}>
          {working ? 'Renaming…' : 'Rename'}
        </button>
      </div>
    </form>
  )
}

export function RenameBranchDialog({ open, anchorRef, onClose, ...form }: RenameBranchDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <CardPopover open={open} anchorRef={anchorRef} placement="below-start" label={`Rename ${form.name}`} className="side-card-git-branch-popover" initialFocusRef={inputRef} sizeKey={form.error} onClose={onClose}>
      <RenameBranchForm {...form} inputRef={inputRef} />
    </CardPopover>
  )
}

interface DeleteBranchDialogProps extends DialogProps {
  name: string
  /** `unmerged` after Git refused a plain delete: the same question again, worded for the lost commits. */
  stage: 'confirm' | 'unmerged'
  working: boolean
  onConfirm: () => void
}

export function DeleteBranchDialog({ open, anchorRef, name, stage, disabled, working, error, onConfirm, onClose }: DeleteBranchDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null)
  const prompt = deleteBranchPrompt(name, stage)
  return (
    <CardPopover open={open} anchorRef={anchorRef} placement="below-start" label={`Delete ${name}`} className="side-card-git-branch-popover" initialFocusRef={cancelRef} sizeKey={`${stage}${error}`} onClose={onClose}>
      <p className="side-card-git-branch-message">{prompt.message}</p>
      <DialogError error={error} />
      <div className="side-card-git-popover-actions">
        <button ref={cancelRef} type="button" className="side-card-git-submit side-card-git-submit-quiet" disabled={working} onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="side-card-git-submit" disabled={disabled} onClick={onConfirm}>
          {working ? 'Deleting…' : prompt.confirmLabel}
        </button>
      </div>
    </CardPopover>
  )
}

interface DirtySwitchDialogProps extends DialogProps {
  branch: string
  fileCount: number
  /** The choice being carried out; null while the prompt waits. */
  working: 'carry' | 'stash' | null
  onChoose: (choice: 'carry' | 'stash' | 'cancel') => void
}

export function DirtySwitchDialog({ open, anchorRef, branch, fileCount, disabled, working, error, onChoose, onClose }: DirtySwitchDialogProps) {
  const primaryRef = useRef<HTMLButtonElement>(null)
  const choices = dirtySwitchChoices(fileCount)
  return (
    <CardPopover open={open} anchorRef={anchorRef} placement="below-start" label={`Switch to ${branch}`} className="side-card-git-branch-popover" initialFocusRef={primaryRef} sizeKey={error} onClose={onClose}>
      <p className="side-card-git-branch-message">{dirtySwitchMessage(fileCount, branch)}</p>
      <DialogError error={error} />
      <div className="side-card-git-branch-choices">
        {choices.map((choice) => (
          <button
            key={choice.id}
            ref={choice.primary ? primaryRef : undefined}
            type="button"
            className={`side-card-git-submit${choice.primary ? '' : ' side-card-git-submit-quiet'}`}
            disabled={choice.id === 'cancel' ? working !== null : disabled}
            onClick={() => onChoose(choice.id)}
          >
            {working === choice.id ? (choice.id === 'stash' ? 'Stashing…' : 'Switching…') : choice.label}
          </button>
        ))}
      </div>
    </CardPopover>
  )
}
