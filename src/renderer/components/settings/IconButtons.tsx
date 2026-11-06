import { useEffect, useState } from 'react'
import { Check, Copy, Trash2 } from '../../lib/icons'

/** A trash icon; the first click turns it into a "Confirm remove" text button for a few seconds. */
export function ConfirmRemoveButton({
  label = 'Remove',
  confirmLabel = 'Confirm remove',
  disabled,
  onRemove
}: {
  label?: string
  confirmLabel?: string
  disabled?: boolean
  onRemove: () => void
}) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return
    const timer = setTimeout(() => setConfirming(false), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  return confirming ? (
    <button type="button" className="settings-btn danger confirm" disabled={disabled} autoFocus onClick={onRemove}>
      {confirmLabel}
    </button>
  ) : (
    <button type="button" className="settings-icon-btn danger" title={label} aria-label={label} disabled={disabled} onClick={() => setConfirming(true)}>
      <Trash2 size={14} />
    </button>
  )
}

export const COPY_FAILED = "Couldn't copy. Try again."
export const COPY_FAILED_SELECTED = "Couldn't copy. Copy the selected text instead."

/**
 * Icon-only copy; the glyph turns into a green check for a moment once copied. With `announce`,
 * a "Copied" word also shows beside it and is read out, for copies that matter (an invitation).
 * A refused copy says so until the next try; `onFailed` can select the text so it can be copied by hand.
 */
export function CopyButton({ text, label = 'Copy', announce = false, onFailed }: {
  text: string
  label?: string
  announce?: boolean
  onFailed?: () => void
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(timer)
  }, [state])
  const copy = async () => {
    setState('idle')
    try {
      if (!navigator.clipboard) throw new Error('No clipboard')
      await navigator.clipboard.writeText(text)
      setState('copied')
    } catch {
      setState('failed')
      onFailed?.()
    }
  }
  const failedText = onFailed ? COPY_FAILED_SELECTED : COPY_FAILED
  const name = state === 'copied' ? 'Copied' : state === 'failed' && !announce ? failedText : label
  const button = (
    <button type="button" className="settings-icon-btn primary" title={name} aria-label={name} onClick={() => void copy()}>
      {state === 'copied' ? <Check size={14} className="settings-status-ok" /> : <Copy size={14} />}
    </button>
  )
  if (!announce) return button
  return (
    <span className="copy-announce">
      <span className={`copy-announce-status${state === 'failed' ? ' failed' : ''}`} role="status">
        {state === 'copied' ? 'Copied' : state === 'failed' ? failedText : ''}
      </span>
      {button}
    </span>
  )
}
