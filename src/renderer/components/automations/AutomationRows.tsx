import { useState, type MouseEvent } from 'react'
import type { AutomationItem } from '../../../shared/automations'
import { RowMenu, type RowMenuItem } from '../integrations/RowMenu'
import { Modal } from '../ui/Modal'
import { BotFaceStill } from '../bots/face/BotFace'
import { metaParts, primaryOf, pauseUntil, type MetaContext, type PauseChoice } from './automationList'

/** The glyph column: what state the automation is in, always. */
export function glyphOf(item: AutomationItem): { glyph: string; kind: string; title: string } {
  if (item.attention && (!item.paused || item.attention.kind === 'ask')) {
    return item.attention.kind === 'failed'
      ? { glyph: '✕', kind: 'failed', title: 'Failed' }
      : { glyph: '⚠', kind: 'needs', title: 'Needs you' }
  }
  if (item.paused) return { glyph: '⏸', kind: 'paused', title: 'Paused' }
  if (item.trigger === 'thread_event') return { glyph: '◉', kind: 'watching', title: 'Watching' }
  if (item.trigger === 'request') return { glyph: '↯', kind: 'request', title: 'On request' }
  if (item.trigger === 'on_demand' || !item.next) return { glyph: '○', kind: 'on_demand', title: 'On demand' }
  return { glyph: '◷', kind: 'scheduled', title: 'Scheduled' }
}

/**
 * One automation: the glyph, its name, one meta line (a bot's face beside its name there), one primary action and
 * "…". A selected row is tinted; nothing marks its edge. An ask Needs you answers in place is the ask card's row
 * (`AskCard`), not this.
 */
export function AutomationRow({ item, selected, ctx, menu, onOpen, onSelect, onPrimary }: {
  item: AutomationItem
  selected: boolean
  ctx: MetaContext
  menu: RowMenuItem[]
  onOpen: () => void
  /** ⇧ or ⌘/Ctrl click: extend or toggle the selection. */
  onSelect: (mode: 'range' | 'toggle') => void
  onPrimary: () => void
}) {
  const glyph = glyphOf(item)
  const parts = metaParts(item, ctx)
  const primary = primaryOf(item)
  const click = (event: MouseEvent) => {
    if (event.shiftKey) { event.preventDefault(); onSelect('range'); return }
    if (event.metaKey || event.ctrlKey) { event.preventDefault(); onSelect('toggle'); return }
    onOpen()
  }
  return (
    <div
      className="automation-row"
      data-testid="automation-row"
      data-key={item.key}
      data-kind={item.kind}
      data-selected={selected ? 'true' : undefined}
      role="option"
      aria-selected={selected}
    >
      <span className={`automation-glyph ${glyph.kind}`} data-glyph={glyph.kind} title={glyph.title} role="img" aria-label={glyph.title}>{glyph.glyph}</span>
      <button type="button" className="automation-row-main" data-row-button="" onClick={click}>
        <span className="automation-row-name">{item.name}</span>
        <span className="automation-row-meta">
          {parts.map((part) => (
            <span key={part.key} className={`automation-row-seg${part.tone ? ` tone-${part.tone}` : ''}`} data-meta={part.key}>
              {part.key === 'bot' && item.who.kind === 'bot' ? (
                <span className="automation-bot-face" aria-hidden="true" data-testid="automation-bot-face"><BotFaceStill look={item.who.look} state="idle" size={16} view="head" /></span>
              ) : null}
              {part.text}
            </span>
          ))}
        </span>
      </button>
      <button
        type="button"
        className="settings-btn automation-primary"
        data-primary={primary.kind}
        onClick={onPrimary}
        aria-label={`${primary.label}: ${item.name}`}
      >
        {primary.label}
      </button>
      <RowMenu label={`More actions for ${item.name}`} items={menu} />
    </div>
  )
}

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
