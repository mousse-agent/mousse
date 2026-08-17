import { X, type LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

export function Pill({ icon: Icon, iconNode, label, onRemove, variant }: { icon?: LucideIcon; iconNode?: ReactNode; label: string; onRemove?: () => void; variant?: string }) {
  return (
    <span className={`pill ${variant ? `pill-${variant}` : ''}`.trim()}>
      {Icon ? <Icon size={12} strokeWidth={2} /> : iconNode}
      <span className="pill-label">{label}</span>
      {onRemove ? (
        <button type="button" className="pill-remove" onClick={onRemove} aria-label={`Remove ${label}`}>
          <X size={12} strokeWidth={2} />
        </button>
      ) : null}
    </span>
  )
}
