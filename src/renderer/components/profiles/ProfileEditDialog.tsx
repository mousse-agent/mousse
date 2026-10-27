import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import type { ProfilePublicDto } from '../../../shared/profiles/types'
import { Check } from '../../lib/icons'
import { PROFILE_SWATCHES } from '../../lib/profilePalette'
import { Modal } from '../ui/Modal'

export const PROFILE_NAME_MAX = 64

/** The trimmed name when it can be saved (not empty, at most 64 characters), otherwise undefined. */
export function checkedProfileName(raw: string): string | undefined {
  const name = raw.trim()
  return name && Array.from(name).length <= PROFILE_NAME_MAX ? name : undefined
}

export type ProfileEditMode =
  | { kind: 'create'; color: string }
  | { kind: 'edit'; profile: ProfilePublicDto; focus?: 'name' | 'color' }

export interface ProfileEditValues {
  displayName: string
  /** Set only when the colour was chosen or changed. */
  color?: string
}

interface ProfileEditDialogProps {
  mode: ProfileEditMode
  /** Edit mode on a profile that may be archived (not the default, not the only one). */
  canArchive?: boolean
  busy?: boolean
  error?: string | null
  onSubmit: (values: ProfileEditValues) => void
  onArchive?: () => void
  onClose: () => void
}

/** Creates a profile, or renames and recolours one. Archiving is offered in edit mode for non-default profiles. */
export function ProfileEditDialog({ mode, canArchive = false, busy = false, error, onSubmit, onArchive, onClose }: ProfileEditDialogProps) {
  const creating = mode.kind === 'create'
  const profile = mode.kind === 'edit' ? mode.profile : undefined
  const [name, setName] = useState(profile?.displayName ?? '')
  const [color, setColor] = useState<string | undefined>(mode.kind === 'create' ? mode.color : profile?.color)
  const formId = useId()
  const swatchesRef = useRef<HTMLDivElement>(null)
  const focusColor = mode.kind === 'edit' && mode.focus === 'color'

  // The dialog's own focus lands on the name; "Colour" moves it on to the chosen swatch once that has run.
  useEffect(() => {
    if (!focusColor) return
    const frame = requestAnimationFrame(() => {
      const group = swatchesRef.current
      const target = group?.querySelector<HTMLElement>('[aria-checked="true"]') ?? group?.querySelector<HTMLElement>('[role="radio"]')
      target?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusColor])

  const checked = checkedProfileName(name)
  const changed = creating || checked !== profile?.displayName || color !== profile?.color
  const canSave = !busy && !!checked && changed

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSave || !checked) return
    onSubmit({ displayName: checked, ...(color && (creating || color !== profile?.color) ? { color } : {}) })
  }

  return (
    <Modal
      open
      title={creating ? 'New profile' : 'Edit profile'}
      className="profile-edit-overlay"
      onClose={onClose}
      footer={<>
        {profile && canArchive && onArchive && (
          <button type="button" className="settings-btn danger profile-edit-archive" disabled={busy} onClick={onArchive}>Archive</button>
        )}
        <button type="submit" form={formId} className="settings-btn" disabled={!canSave}
          aria-label={creating ? 'Create profile' : 'Save profile name'}>{creating ? 'Create' : 'Save'}</button>
      </>}
    >
      <form id={formId} className="profile-edit-form" onSubmit={submit}>
        <input className="profile-edit-input" aria-label="Profile name" maxLength={PROFILE_NAME_MAX} autoComplete="off"
          spellCheck={false} placeholder="Profile name" value={name} onChange={(event) => setName(event.target.value)} />
        <div ref={swatchesRef} className="profile-edit-swatches" role="radiogroup" aria-label="Profile colour">
          {PROFILE_SWATCHES.map((swatch) => {
            const selected = color?.toLowerCase() === swatch.color
            return (
              <button key={swatch.color} type="button" role="radio" aria-checked={selected} aria-label={swatch.name} title={swatch.name}
                className="profile-edit-swatch" style={{ background: swatch.color }} onClick={() => setColor(swatch.color)}>
                {selected && <Check size={14} aria-hidden="true" />}
              </button>
            )
          })}
        </div>
        {error && <div className="profile-switcher-error" role="alert">{error}</div>}
      </form>
    </Modal>
  )
}
