import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

export function SectionCard({ icon, title, description, defaultOpen = true, children, className = '' }: { icon?: ReactNode; title: string; description?: string; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className={`section-card channels-section-card ${className}`.trim()}>
      <button type="button" className="section-card-header channels-section-header" onClick={() => setOpen((v) => !v)}>
        {icon ? <span className="section-card-icon channels-section-icon">{icon}</span> : null}
        <span className="section-card-heading channels-section-heading">
          <span className="section-card-title channels-section-title">{title}</span>
          {description ? <span className="section-card-desc channels-section-desc">{description}</span> : null}
        </span>
        {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
      </button>
      {open ? <div className="section-card-body channels-section-body">{children}</div> : null}
    </section>
  )
}
