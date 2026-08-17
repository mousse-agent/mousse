import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

export function Collapsible({ trigger, defaultOpen = false, children }: { trigger: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="collapsible">
      <button type="button" className="collapsible-trigger" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="collapsible-caret" aria-hidden="true">
          {open ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
        </span>
        <span className="collapsible-label">{trigger}</span>
      </button>
      {open ? <div className="collapsible-body">{children}</div> : null}
    </div>
  )
}
