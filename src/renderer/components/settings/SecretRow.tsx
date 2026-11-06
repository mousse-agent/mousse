import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Loader2, Pencil, X } from '../../lib/icons'
import { ipcErrorMessage } from '../../utils/voiceErrors'
import { SettingsRow } from './SettingsRow'

/** How long "Saved" stays in the row after a key is saved. */
export const SAVED_NOTICE_MS = 2500

function failureText(error: unknown): string {
  return ipcErrorMessage(error) || (error instanceof Error ? error.message : String(error))
}

/**
 * One saved secret (an API key) in a settings row, the same way everywhere. A saved value is never
 * read back or shown: the row says whether one is saved, and Replace opens an empty password field
 * with Save and Cancel. Enter saves, Escape cancels. A failed save keeps what was typed and says why
 * in the row; a successful one closes the field and says "Saved", also to screen readers.
 */
export function SecretRow({
  title,
  anchor,
  inputId,
  fieldLabel,
  placeholder,
  description,
  editingHint,
  configured,
  allowBlank = false,
  replaceLabel = 'Replace key',
  onReplace,
  onSave,
  actions,
  busy = false
}: {
  title: ReactNode
  /** The settings search anchor (`anchor` on SettingsRow). */
  anchor?: string
  inputId: string
  /** The field's accessible name: "OpenRouter API key". */
  fieldLabel: string
  placeholder?: string
  /** What the row says while the field is closed: the saved state. */
  description: ReactNode
  /** What the row says while the field is open. */
  editingHint?: ReactNode
  /** A key is saved. Without one the field stays open and there is nothing to cancel. */
  configured: boolean
  /** Saving an empty field is a choice of its own (a guided sign-in), not a mistake. */
  allowBlank?: boolean
  replaceLabel?: string
  /** Replace runs this instead of opening the field (the key comes from a guided sign-in). */
  onReplace?: () => Promise<void>
  /** Rejects with the reason; the field and what was typed stay. */
  onSave: (value: string) => Promise<void>
  /** More buttons beside Replace while the field is closed (Remove). */
  actions?: ReactNode
  /** Another action of the same row is running. */
  busy?: boolean
}) {
  const [replacing, setReplacing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const replaceRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Where focus goes once the field closes, so the keyboard stays on this row. */
  const refocus = useRef(false)
  const editing = !configured || replacing

  useEffect(() => {
    if (!saved) return
    const timer = setTimeout(() => setSaved(false), SAVED_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [saved])

  useEffect(() => {
    if (!refocus.current) return
    refocus.current = false
    if (editing) inputRef.current?.focus()
    else replaceRef.current?.focus()
  }, [editing])

  const close = () => {
    refocus.current = true
    setReplacing(false)
    setDraft('')
  }
  const cancel = () => {
    setError(null)
    if (configured) close()
    else setDraft('')
  }
  const run = async (task: () => Promise<void>, after: () => void) => {
    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      await task()
      after()
      setSaved(true)
    } catch (failure) {
      setError(failureText(failure))
    } finally {
      setSaving(false)
    }
  }
  const value = draft.trim()
  const canSave = !saving && !busy && (allowBlank || value.length > 0)
  const save = () => {
    if (canSave) void run(() => onSave(value), close)
  }
  const replace = () => {
    setSaved(false)
    setError(null)
    if (onReplace) void run(onReplace, () => {})
    else {
      refocus.current = true
      setReplacing(true)
    }
  }

  const status = error ? (
    <span className="settings-status-bad">{error}</span>
  ) : saved ? (
    <span className="settings-status-ok">Saved</span>
  ) : editing && editingHint ? (
    editingHint
  ) : (
    description
  )

  return (
    <SettingsRow
      anchor={anchor}
      title={title}
      htmlFor={editing ? inputId : undefined}
      description={
        <>
          {status}
          {/* Always in the document, so the change is announced. */}
          <span className="sr-only" role="status">
            {saved ? 'Saved' : ''}
          </span>
          {error && (
            <span className="sr-only" role="alert">
              {error}
            </span>
          )}
        </>
      }
      control={
        editing ? (
          <span className="settings-icon-actions">
            <input
              ref={inputRef}
              id={inputId}
              className="settings-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              placeholder={placeholder}
              aria-label={fieldLabel}
              aria-invalid={error ? true : undefined}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  save()
                }
                if (event.key === 'Escape' && (configured || draft)) {
                  // The field's own Escape: it must not also close the dialog or page around it.
                  event.preventDefault()
                  event.stopPropagation()
                  cancel()
                }
              }}
            />
            {configured && (
              <button type="button" className="settings-icon-btn" title="Cancel" aria-label="Cancel" disabled={saving} onClick={cancel}>
                <X size={14} />
              </button>
            )}
            <button type="button" className="settings-icon-btn primary" title="Save" aria-label={`Save ${fieldLabel}`} disabled={!canSave} onClick={save}>
              {saving ? <Loader2 size={14} className="icon-spin" /> : <Check size={14} />}
            </button>
          </span>
        ) : (
          <span className="settings-icon-actions">
            <button
              ref={replaceRef}
              type="button"
              className="settings-icon-btn"
              title={replaceLabel}
              aria-label={replaceLabel}
              disabled={saving || busy}
              onClick={replace}
            >
              {saving ? <Loader2 size={14} className="icon-spin" /> : <Pencil size={14} />}
            </button>
            {actions}
          </span>
        )
      }
    />
  )
}
