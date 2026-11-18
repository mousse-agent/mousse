import { useEffect, useId, useRef, useState } from 'react'
import { ExternalLink, Eye, EyeOff, Lock } from '../../lib/icons'
import { DEFAULT_SECRET_KEEP, SECRET_KEEPS, secretKeepLabel, secretKeepLine, secretValueProblem, type SecretKeep, type SecretRequestView } from '../../../shared/secretRequests'

export interface SecretRequestCardProps {
  request: SecretRequestView
  /** In the transcript, in the turn that asked (rather than over the composer). */
  inline?: boolean
  botName?: string
  /** Save securely. Rejects with a message to show; the typed value is cleared once it resolves. */
  onSave(value: string, keep: SecretKeep): Promise<void>
  onUseSaved(): Promise<void>
  onDecline(): Promise<void>
}

/**
 * The private card an agent's `secret_request` puts in the thread (#595). The value is typed into a masked field and
 * sent once, to this computer's daemon; it is never put in the composer, the thread or a notice, and the field is
 * cleared as soon as it is saved.
 */
export function SecretRequestCard({ request, inline, botName, onSave, onUseSaved, onDecline }: SecretRequestCardProps) {
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(false)
  const [keep, setKeep] = useState<SecretKeep>(DEFAULT_SECRET_KEEP)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const ids = useId()
  const titleId = `${ids}-title`
  const reasonId = `${ids}-reason`
  const keepLineId = `${ids}-keep`

  // The field takes the focus when the request arrives, unless the person is typing somewhere else (the composer).
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null
    const typing = active && active !== document.body && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
    if (!typing) inputRef.current?.focus({ preventScroll: true })
  }, [request.requestId])

  // The value lives only in this card's state: it is gone when the card closes.
  useEffect(() => () => setValue(''), [])

  const act = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await work()
      setValue('')
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : 'That did not work. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const save = (): void => {
    const problem = secretValueProblem(value)
    if (problem) {
      setError(problem)
      return
    }
    void act(() => onSave(value, keep))
  }

  return (
    <div className={`composer-question-modal secret-request-card${inline ? ' is-inline' : ''}`} role={inline ? 'group' : 'dialog'} aria-labelledby={titleId} aria-describedby={reasonId}>
      <div className="composer-question-modal-header">
        <h3 className="composer-question-modal-title" id={titleId}>
          <Lock size={15} aria-hidden="true" />
          {request.label}
        </h3>
      </div>
      <div className="composer-question-modal-body">
        <p className="composer-question-prompt" id={reasonId}>{request.reason}</p>
        {request.binding && <p className="composer-question-reason">
          For {request.binding.service ?? request.binding.host}, read only. {botName ?? 'The bot'} can't see it or send it anywhere else.
          {!request.binding.service && <> Mousse can't tell what this service's reads do.</>}
        </p>}
        {(request.link || request.format) && (
          <p className="secret-request-meta">
            {request.format && <span>Expected: {request.format}</span>}
            {request.link && (
              <a href={request.link} target="_blank" rel="noopener noreferrer" className="secret-request-link">
                Create one <ExternalLink size={12} aria-hidden="true" />
              </a>
            )}
          </p>
        )}
        <form
          className="secret-request-field"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <input
            ref={inputRef}
            className="secret-request-input"
            type={shown ? 'text' : 'password'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label={request.label}
            placeholder="Paste or type the secret"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-private="true"
            disabled={busy}
          />
          <button
            type="button"
            className="secret-request-reveal"
            onClick={() => setShown((current) => !current)}
            aria-label={shown ? 'Hide the secret' : 'Show the secret'}
            aria-pressed={shown}
            title={shown ? 'Hide' : 'Show'}
          >
            {shown ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
          </button>
        </form>
        <div className="secret-request-keep" role="radiogroup" aria-label="Keep it for" aria-describedby={keepLineId}>
          {SECRET_KEEPS.map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={keep === option}
              className={`secret-request-keep-option${keep === option ? ' is-selected' : ''}`}
              onClick={() => setKeep(option)}
              disabled={busy}
            >
              {secretKeepLabel(option)}
            </button>
          ))}
        </div>
        <p className="composer-question-reason secret-request-keep-line" id={keepLineId}>{request.binding ? secretKeepLine(keep).replace('The agent can use it but never shows it in the chat.', `${botName ?? 'The bot'} never sees it.`) : secretKeepLine(keep)}</p>
        {error && <p className="secret-request-error" role="alert">{error}</p>}
      </div>
      <div className="composer-question-modal-footer" data-mousse-decision="">
        <button type="button" className="composer-question-btn is-quiet" disabled={busy} onClick={() => void act(onDecline)}>
          Decline
        </button>
        <span className="composer-question-footer-end">
          {request.savedExists && (
            <button type="button" className="composer-question-btn" disabled={busy} onClick={() => void act(onUseSaved)}>
              Use saved {request.name}
            </button>
          )}
          <button type="button" className="composer-question-btn is-primary" disabled={busy || value.length === 0} onClick={save}>
            Save securely
          </button>
        </span>
      </div>
    </div>
  )
}
