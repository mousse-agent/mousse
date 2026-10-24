import { createContext, useContext, useEffect, useId, useRef, type ReactNode, type RefObject } from 'react'
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
  footer,
  className
}: {
  open: boolean
  title: string
  hideTitle?: boolean
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  /** Extra class on the overlay, for dialogs that need their own stacking or layout. */
  className?: string
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  useDialogFocus(panelRef, open, onClose)
  if (!open) return null
  return (
    <div
      className={className ? `modal-overlay ${className}` : 'modal-overlay'}
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
        <DialogParent.Provider value={panelRef}>
          <div className="modal-body">{children}</div>
          {footer ? <footer className="modal-footer">{footer}</footer> : null}
        </DialogParent.Provider>
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

const openDialogs: HTMLElement[] = []
const parentDialogs = new WeakMap<HTMLElement, HTMLElement>()

/** The dialog a nested dialog is rendered inside (even through a portal), so it can register above it. */
const DialogParent = createContext<RefObject<HTMLElement | null> | null>(null)

const isInside = (dialog: HTMLElement, ancestor: HTMLElement): boolean => {
  for (let parent = parentDialogs.get(dialog); parent; parent = parentDialogs.get(parent)) if (parent === ancestor) return true
  return false
}

/** The page control a dialog closed under another one came from, kept for the dialog above it. */
const inheritedOpeners = new WeakMap<HTMLElement, HTMLElement>()

/**
 * Registers an open dialog; returns what unregisters it. Dialogs opened later sit above earlier
 * ones, and a dialog nested in another always sits above it, even when its effect ran first
 * because both mounted in the same commit. `opener` is the control focused before it opened: if
 * the dialog closes under another one, the dialog above inherits it as a place to return to.
 */
export function registerDialog(dialog: HTMLElement, parent?: HTMLElement | null, opener?: HTMLElement | null): () => void {
  if (parent && parent !== dialog) parentDialogs.set(dialog, parent)
  const nested = openDialogs.findIndex((other) => isInside(other, dialog))
  openDialogs.splice(nested === -1 ? openDialogs.length : nested, 0, dialog)
  return () => {
    const index = openDialogs.indexOf(dialog)
    if (index !== -1) {
      openDialogs.splice(index, 1)
      const above = openDialogs[index]
      const handoff = opener?.isConnected ? opener : inheritedOpeners.get(dialog)
      if (above && handoff) inheritedOpeners.set(above, handoff)
    }
    parentDialogs.delete(dialog)
    inheritedOpeners.delete(dialog)
  }
}

/** The opener of a dialog that closed under this one, if any. */
export const inheritedOpener = (dialog: HTMLElement): HTMLElement | undefined => inheritedOpeners.get(dialog)

const topDialog = (): HTMLElement | undefined => openDialogs[openDialogs.length - 1]

/** Only the top dialog answers Tab and Escape, so one stacked above another does not fight it for focus. */
export const isTopDialog = (dialog: HTMLElement): boolean => topDialog() === dialog

/**
 * Where focus goes when a dialog closes. Nowhere if another dialog sits above it: focus is already
 * there. Otherwise its opener, or, when the opener is outside the dialog now on top, that dialog.
 * With no opener left and no dialog under it, the opener of a dialog that closed beneath it.
 */
export function focusAfterClose(
  wasTop: boolean,
  previous: HTMLElement | null,
  next: HTMLElement | undefined,
  inherited?: HTMLElement
): HTMLElement | null {
  if (!wasTop) return null
  const target = next && !(previous && next.contains(previous)) ? initialDialogFocus(next) : previous
  if (target?.isConnected) return target
  return !next && inherited?.isConnected ? inherited : null
}

/** Escape presses a dialog already answered, so the dialog uncovered by its close does not close too. */
const answeredEscapes = new WeakSet<Event>()

/**
 * Dialog keyboard behaviour shared by ui/Modal and the integrations dialog: initial focus in the
 * body, Tab kept inside the dialog, Escape closes, focus returns to the opener on close. With
 * dialogs stacked, only the top one handles the keys.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, active: boolean, onClose: () => void) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const parentRef = useContext(DialogParent)
  useEffect(() => {
    const dialog = ref.current
    if (!active || !dialog) return
    // Nothing focused reads as body, which is always connected: it would win over a real opener handed along.
    const active = document.activeElement
    const previous = active instanceof HTMLElement && active !== document.body ? active : null
    const unregister = registerDialog(dialog, parentRef?.current, previous)
    if (isTopDialog(dialog)) initialDialogFocus(dialog).focus({ preventScroll: true })
    const keyDown = (event: KeyboardEvent) => {
      if (!isTopDialog(dialog) || answeredEscapes.has(event)) return
      if (event.key === 'Escape') { event.preventDefault(); answeredEscapes.add(event); closeRef.current(); return }
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
    return () => {
      document.removeEventListener('keydown', keyDown)
      const wasTop = isTopDialog(dialog)
      const inherited = inheritedOpener(dialog)
      unregister()
      focusAfterClose(wasTop, previous, topDialog(), inherited)?.focus()
    }
  }, [ref, active, parentRef])
}
