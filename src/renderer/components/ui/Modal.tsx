import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
import { X } from '../../lib/icons'

/**
 * The shared dialog: a lit surface with a close button, then content. `title` always names the
 * dialog for assistive tech; set `hideTitle` when the content already says what the dialog is
 * for (a choice of actions, a list), so the content leads.
 */
export function Modal({
  open,
  title,
  hideTitle = false,
  onClose,
  children,
  footer
}: {
  open: boolean
  title: string
  hideTitle?: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useDialogFocus(panelRef, open, onClose)
  if (!open) return null
  return (
    <div
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby={hideTitle ? undefined : titleId}
      aria-label={hideTitle ? title : undefined}
      onClick={onClose}
    >
      <div ref={panelRef} tabIndex={-1} className={`modal${hideTitle ? ' untitled' : ''}`} onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          {!hideTitle && <h3 id={titleId}>{title}</h3>}
          <ModalClose onClose={onClose} />
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

/** The dialog close button: a 28px icon button with a tooltip. Shared with the integrations dialog. */
export function ModalClose({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="settings-icon-btn modal-close" title="Close" aria-label="Close" onClick={onClose}>
      <X size={16} />
    </button>
  )
}

const FIELDS = 'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]'
const FOCUSABLE = `${FIELDS}, button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])`

const focusables = (root: HTMLElement, selector: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].filter((item) => item.getClientRects().length > 0)

/**
 * Where focus lands when a dialog opens: the first form field in the body, else its first control,
 * else the dialog itself (give it tabIndex={-1}). Never the header's close button, and never a
 * footer action, so Enter cannot confirm a destructive footer button by accident.
 */
export function initialDialogFocus(dialog: HTMLElement): HTMLElement {
  const body = dialog.querySelector<HTMLElement>(':scope > .modal-body') ?? dialog
  const inBody = (selector: string) => focusables(body, selector).find((item) => !item.closest('.modal-header'))
  return inBody(FIELDS) ?? inBody(FOCUSABLE) ?? dialog
}

/**
 * Dialog keyboard behaviour shared by ui/Modal and the integrations dialog: initial focus in the
 * body, Tab kept inside the dialog, Escape closes, focus returns to the opener on close.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useEffect(() => {
    const dialog = ref.current
    if (!active || !dialog) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    initialDialogFocus(dialog).focus({ preventScroll: true })
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = focusables(dialog, FOCUSABLE)
      if (!items.length) { event.preventDefault(); return }
      const index = items.indexOf(document.activeElement as HTMLElement)
      const outside = index === -1 && !dialog.contains(document.activeElement)
      if (outside || (event.shiftKey && index <= 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0]?.focus()
      }
    }
    document.addEventListener('keydown', keyDown)
    return () => { document.removeEventListener('keydown', keyDown); if (previous?.isConnected) previous.focus() }
  }, [ref, active])
}
