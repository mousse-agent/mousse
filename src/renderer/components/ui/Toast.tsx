import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { X } from '../../lib/icons'
import { FloatingPortal } from '../../lib/floatingLayer'
import '../../styles/toast.css'

/** How long a toast stays on screen. The timer stops while the pointer or keyboard focus is on it. */
export const TOAST_MS = 8_000

export interface ToastAction {
  label: string
  onClick: () => void
  ariaLabel?: string
  /** For tests and styling hooks: `undo`, `retry`, `dismiss`. */
  dataAction?: string
  disabled?: boolean
}

/**
 * One line at the bottom of the window with up to two text actions ("Deleted · Undo",
 * "Could not archive · offline · Retry"). Presentational: callers own its lifetime.
 */
export function ToastView({
  message,
  actions = [],
  tone = 'neutral',
  onDismiss,
  onHoldChange
}: {
  message: string
  actions?: readonly ToastAction[]
  tone?: 'neutral' | 'error'
  /** Shows a close button. */
  onDismiss?: () => void
  /** The pointer or focus entered (true) or left (false) the toast, so a timer can wait. */
  onHoldChange?: (held: boolean) => void
}) {
  return (
    <FloatingPortal>
      <div
        className={`ui-toast${tone === 'error' ? ' ui-toast-error' : ''}`}
        role={tone === 'error' ? 'alert' : 'status'}
        onPointerEnter={() => onHoldChange?.(true)}
        onPointerLeave={() => onHoldChange?.(false)}
        onFocus={() => onHoldChange?.(true)}
        onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHoldChange?.(false) }}
      >
        <span className="ui-toast-message">{message}</span>
        {actions.map((action) => (
          <button
            key={action.label}
            type="button"
            className="ui-toast-action"
            data-action={action.dataAction}
            aria-label={action.ariaLabel}
            disabled={action.disabled}
            onClick={action.onClick}
          >{action.label}</button>
        ))}
        {onDismiss && (
          <button type="button" className="ui-toast-close" data-action="dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>
    </FloatingPortal>
  )
}

export interface ToastInput {
  message: string
  /** One action, such as Undo or Retry. Running it closes the toast. */
  action?: { label: string; run: () => void }
  tone?: 'neutral' | 'error'
  durationMs?: number
}

interface ToastEntry extends ToastInput { id: number }

const useToastStore = create<{ toast: ToastEntry | null }>(() => ({ toast: null }))
let nextToastId = 0

/** Shows a toast in the window's one toast slot; a newer toast replaces the one on screen. Returns its id. */
export function showToast(input: ToastInput): number {
  const id = ++nextToastId
  useToastStore.setState({ toast: { ...input, id } })
  return id
}

/** Closes the toast on screen, or only the toast `id` when that one is still on screen. */
export function dismissToast(id?: number): void {
  const current = useToastStore.getState().toast
  if (current && (id === undefined || current.id === id)) useToastStore.setState({ toast: null })
}

/** The window's toast slot. Mounted once, at the app root. */
export function ToastHost() {
  const toast = useToastStore((state) => state.toast)
  // The toast the pointer or focus is on; a newer toast is not held and starts its own full time.
  const [heldId, setHeldId] = useState<number | null>(null)
  const id = toast?.id
  const held = id !== undefined && heldId === id
  const duration = toast?.durationMs ?? TOAST_MS

  useEffect(() => {
    if (id === undefined || held) return
    const timer = setTimeout(() => dismissToast(id), duration)
    return () => clearTimeout(timer)
  }, [id, held, duration])

  if (!toast) return null
  const { action } = toast
  return (
    <ToastView
      key={toast.id}
      message={toast.message}
      tone={toast.tone}
      actions={action ? [{
        label: action.label,
        dataAction: action.label.toLowerCase(),
        onClick: () => { dismissToast(toast.id); action.run() }
      }] : []}
      onDismiss={() => dismissToast(toast.id)}
      onHoldChange={(isHeld) => setHeldId(isHeld ? toast.id : null)}
    />
  )
}
