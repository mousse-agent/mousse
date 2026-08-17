import { ArrowLeft } from 'lucide-react'
import type { ReactNode } from 'react'

export function OverlayPage({ open, title, onClose, children, className = '' }: { open: boolean; title: string; onClose: () => void; children: ReactNode; className?: string }) {
  return (
    <div className={`overlay-page ${className}`.trim()} hidden={!open}>
      <header className="overlay-page-header overlay-page-drag-header">
        <button type="button" className="overlay-page-back" onClick={onClose}>
          <ArrowLeft size={16} />
          Back
        </button>
        <h1>{title}</h1>
      </header>
      <div className="overlay-page-body">{children}</div>
    </div>
  )
}
