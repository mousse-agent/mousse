import { ArrowLeft } from '../../lib/icons'
import type { ReactNode } from 'react'

export function OverlayPage({ open, title, onClose, children, className = '' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  return (
    <div className={`overlay-page ${className}`.trim()} hidden={!open}>
      <header className="overlay-titlebar overlay-page-header overlay-page-drag-header">
        <button type="button" className="overlay-titlebar-back" onClick={onClose} aria-label="Back">
          <ArrowLeft size={14} strokeWidth={2} />
        </button>
        <h1>{title}</h1>
      </header>
      <div className="overlay-page-body">{children}</div>
    </div>
  )
}
