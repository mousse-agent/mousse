import { useEffect, useRef, type ReactNode } from 'react'
import { registerNavigationGuard } from '../../services/navigationGuards'
import { ChevronRight } from '../../lib/icons'
import { ModalClose, useDialogFocus } from '../ui/Modal'

export function useIntegrationBoundary(...identity: unknown[]) {
  const state = useRef({ identity, epoch: 0, mounted: true })
  if (identity.length !== state.current.identity.length || identity.some((item, index) => item !== state.current.identity[index])) {
    state.current.identity = identity
    state.current.epoch += 1
  }
  useEffect(() => {
    state.current.mounted = true
    return () => { state.current.mounted = false; state.current.epoch += 1 }
  }, [])
  return {
    capture: () => state.current.epoch,
    current: (epoch: number) => state.current.mounted && state.current.epoch === epoch
  }
}

export function useIntegrationDirtyGuard(dirty: boolean, message: string): () => boolean {
  const latest = useRef({ dirty, message })
  latest.current = { dirty, message }
  useEffect(() => registerNavigationGuard(() => !latest.current.dirty || window.confirm(latest.current.message), 'integrations'), [])
  useEffect(() => {
    if (!dirty) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [dirty])
  return () => !latest.current.dirty || window.confirm(latest.current.message)
}

export function IntegrationField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="integration-field"><span>{label}</span>{children}</label>
}

/** Shares ui/Modal's surface, header, close button and keyboard behaviour. `hideTitle` keeps the title for assistive tech only. */
export function IntegrationModal({ title, hideTitle = false, onClose, children, wide = false }: { title: string; hideTitle?: boolean; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const dialogRef = useRef<HTMLElement>(null)
  useDialogFocus(dialogRef, true, onClose)
  return <div className="integration-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} tabIndex={-1} className={`integration-modal${wide ? ' wide' : ''}${hideTitle ? ' untitled' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-header">{hideTitle ? null : <h2>{title}</h2>}<ModalClose onClose={onClose} /></header>
      {children}
    </section>
  </div>
}

/** The app's disclosure: a chevron and a quiet label, no native triangle. Pass `open`/`onOpenChange` to control it. */
export function IntegrationDisclosure({ label, open, onOpenChange, children }: { label: string; open?: boolean; onOpenChange?: (open: boolean) => void; children: ReactNode }) {
  return <details className="integration-disclosure" open={open} onToggle={onOpenChange ? (event) => onOpenChange(event.currentTarget.open) : undefined}>
    <summary><ChevronRight size={14} aria-hidden="true" className="integration-disclosure-chevron" />{label}</summary>
    <div className="integration-disclosure-body">{children}</div>
  </details>
}
