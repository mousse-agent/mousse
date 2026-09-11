import { useEffect, useRef, type ReactNode } from 'react'
import { registerNavigationGuard } from '../../services/navigationGuards'

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

export function IntegrationModal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  const dialogRef = useRef<HTMLElement>(null)
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const first = dialogRef.current?.querySelector<HTMLElement>('input, button, select, textarea, [tabindex="0"]')
    first?.focus()
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
      if (event.key !== 'Tab') return
      const items = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]') ?? [])].filter((item) => item.getClientRects().length > 0)
      const index = items.indexOf(document.activeElement as HTMLElement)
      if (!items.length) { event.preventDefault(); return }
      if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === items.length - 1)) {
        event.preventDefault(); items[event.shiftKey ? items.length - 1 : 0]?.focus()
      }
    }
    document.addEventListener('keydown', keyDown)
    return () => { document.removeEventListener('keydown', keyDown); if (previous?.isConnected) previous.focus() }
  }, [])
  return <div className="integration-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={dialogRef} className={`integration-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
      <header><h2>{title}</h2><button type="button" className="btn btn-sm" aria-label="Close" onClick={onClose}>×</button></header>
      {children}
    </section>
  </div>
}
