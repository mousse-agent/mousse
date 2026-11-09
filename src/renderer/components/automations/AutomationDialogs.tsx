// The Automations dialogs: Pause… (until a time or until the person resumes it), and Delete.
import { useState } from 'react'
import { Modal } from '../ui/Modal'
import { pauseUntil, type PauseChoice } from './automationList'

const PAUSE_CHOICES: Array<{ value: PauseChoice; label: string }> = [
  { value: 'resume', label: 'Until I resume' },
  { value: 'tomorrow', label: 'Until tomorrow' },
  { value: 'monday', label: 'Until Monday' },
  { value: 'date', label: 'Until a date…' }
]

/** Pause…: one picker for one row, many rows, and a vacation. Until I resume is the default. */
export function PausePicker({ count, onCancel, onPause }: { count: number; onCancel: () => void; onPause: (until: string | undefined) => Promise<void> }) {
  const [choice, setChoice] = useState<PauseChoice>('resume')
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const now = new Date()
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const min = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  const until = pauseUntil(choice, new Date(), date)
  const ready = choice !== 'date' || Boolean(until && Date.parse(until) > Date.now())
  const pause = async () => {
    setBusy(true)
    setError(null)
    try {
      await onPause(until)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={count === 1 ? 'Pause' : `Pause ${count} automations`}
      onClose={onCancel}
      closeDisabled={busy}
      className="automation-pause-modal"
      footer={
        <>
          <button type="button" className="settings-btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="settings-btn primary" data-testid="automation-pause-confirm" disabled={busy || !ready} onClick={() => void pause()}>Pause</button>
        </>
      }
    >
      <div className="automation-pause-picker" data-testid="automation-pause-picker" role="radiogroup" aria-label="Pause until">
        {PAUSE_CHOICES.map((option) => (
          <label key={option.value} className="automation-pause-choice">
            <input type="radio" name="pause-until" value={option.value} checked={choice === option.value} onChange={() => setChoice(option.value)} />
            {option.label}
          </label>
        ))}
        {choice === 'date' ? (
          <input type="date" className="scheduled-input narrow" aria-label="Resume on" min={min} value={date} onChange={(event) => setDate(event.target.value)} />
        ) : null}
        {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
      </div>
    </Modal>
  )
}

/** Delete, after a confirm: its run history goes; the threads its runs used stay. */
export function DeleteConfirm({ names, onCancel, onDelete }: { names: string[]; onCancel: () => void; onDelete: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    setBusy(true)
    setError(null)
    try {
      await onDelete()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={names.length === 1 ? `Delete “${names[0]}”?` : `Delete ${names.length} automations?`}
      onClose={() => { if (!busy) onCancel() }}
      closeDisabled={busy}
      footer={
        <>
          <button type="button" className="settings-btn" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="settings-btn danger" data-testid="automation-delete-confirm" disabled={busy} onClick={() => void remove()}>Delete</button>
        </>
      }
    >
      <p className="scheduled-note">Its runs stay in the inbox, and their threads stay too.</p>
      {error ? <p className="scheduled-item-error" role="alert">{error}</p> : null}
    </Modal>
  )
}
