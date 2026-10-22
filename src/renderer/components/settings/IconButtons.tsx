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

/** Icon-only copy; the glyph turns into a green check for a moment once copied. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button
      type="button"
      className="settings-icon-btn primary"
      title={copied ? 'Copied' : label}
      aria-label={copied ? 'Copied' : label}
      onClick={() => void navigator.clipboard?.writeText(text).then(() => setCopied(true)).catch(() => undefined)}
    >
      {copied ? <Check size={14} className="settings-status-ok" /> : <Copy size={14} />}
    </button>
  )
}
