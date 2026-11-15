import { useLayoutEffect, useRef, useState } from 'react'
import { Loader2, Pencil } from '../../lib/icons'
import type { BotSummary } from '../../../shared/bots/personal/chat'
import { MAX_BOT_DESCRIPTION_CHARS } from '../../../shared/bots/personal/definition'
import { useBotsStore } from '../../stores/botsStore'

/** About's prompt section. */
export const BOT_PROMPT_ID = 'bot-about-prompt'

/**
 * The bot's prompt in About: the owner's words on what it does and how it talks (its description), read as a profile
 * section: line breaks kept, a long prompt folded to a few lines with Show more. Edit opens it in place, in the same card:
 * Save applies from its next message, Cancel (or Escape) leaves it as it was, Reset to default puts back the words from
 * before the owner's first edit (offered once they edited it). A failed save keeps the editor open with why.
 */
export function BotPrompt({ bot }: { bot: BotSummary }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [busy, setBusy] = useState<'save' | 'reset' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [folds, setFolds] = useState(false)
  const body = useRef<HTMLParagraphElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const editing = draft !== null

  // Show more only when the folded text is cut: measured, so a short prompt never offers it.
  useLayoutEffect(() => {
    const element = body.current
    if (!element || open) return
    const measure = () => setFolds(element.scrollHeight > element.clientHeight + 1)
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure)
    observer?.observe(element)
    return () => observer?.disconnect()
  }, [bot.description, open, editing])

  // The field grows with what is in it, up to the card's limit (then it scrolls).
  useLayoutEffect(() => {
    const element = field.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${element.scrollHeight}px`
  }, [draft])

  const start = () => {
    setError(null)
    setDraft(bot.description)
    requestAnimationFrame(() => {
      const element = field.current
      if (!element) return
      element.focus()
      element.setSelectionRange(element.value.length, element.value.length)
    })
  }
  const close = () => { setDraft(null); setError(null); setBusy(null) }
  const send = async (description: string | null, kind: 'save' | 'reset') => {
    setBusy(kind)
    setError(null)
    const failed = await useBotsStore.getState().setPrompt(bot.id, description)
    if (failed) {
      setBusy(null)
      setError(failed)
      return
    }
    close()
  }

  const text = draft?.trim() ?? ''
  const tooLong = (draft?.length ?? 0) > MAX_BOT_DESCRIPTION_CHARS
  const canSave = editing && !busy && text.length > 0 && !tooLong && text !== bot.description.trim()

  return <section className="bot-prompt" id={BOT_PROMPT_ID} aria-labelledby={`${BOT_PROMPT_ID}-label`}>
    <div className="bot-prompt-head">
      <h3 id={`${BOT_PROMPT_ID}-label`}>PROMPT</h3>
      {bot.promptEdited && !editing ? <span className="bot-prompt-mark" title="You changed it. Edit to reset it.">Edited</span> : null}
      {!editing
        ? <button type="button" className="bot-prompt-edit" aria-label={`Edit ${bot.name}'s prompt`} title="What it does and how it talks" onClick={start}>
          <Pencil size={12} aria-hidden />Edit
        </button>
        : null}
    </div>
    <div className={`bot-prompt-card settings-scope${editing ? ' is-editing' : ''}`}>
      {editing
        ? <>
          <textarea
            ref={field}
            className="bot-prompt-field"
            aria-label={`${bot.name}'s prompt`}
            value={draft}
            rows={3}
            disabled={busy !== null}
            aria-invalid={tooLong || undefined}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canSave) { event.preventDefault(); void send(text, 'save') }
            }}
          />
          <div className={`bot-prompt-count${tooLong ? ' is-over' : ''}`} aria-live="polite">{draft.length} / {MAX_BOT_DESCRIPTION_CHARS}</div>
        </>
        : <>
          <p ref={body} className={`bot-prompt-body${open ? '' : ' is-folded'}${folds && !open ? ' is-cut' : ''}`}>{bot.description}</p>
          {folds || open
            ? <button type="button" className="bot-prompt-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Show less' : 'Show more'}</button>
            : null}
        </>}
    </div>
    {editing
      ? <div className="bot-prompt-actions">
        <button type="button" className="bot-prompt-reset" disabled={!bot.promptEdited || busy !== null}
          title={bot.promptEdited ? 'Back to the words from before your first edit' : 'Already the default'}
          onClick={() => void send(null, 'reset')}>
          {busy === 'reset' ? <Loader2 size={12} className="chat-spin" aria-hidden /> : null}Reset to default
        </button>
        <span className="bot-prompt-spacer" />
        <button type="button" className="bot-ghost-button" disabled={busy !== null} onClick={close}>Cancel</button>
        <button type="button" className="chat-primary-button" disabled={!canSave} title="Applies from its next message" onClick={() => void send(text, 'save')}>
          {busy === 'save' ? <><Loader2 size={12} className="chat-spin" aria-hidden />Saving…</> : 'Save'}
        </button>
      </div>
      : null}
    {error ? <p className="bot-about-empty bot-prompt-error" role="alert">{error}</p> : null}
  </section>
}
