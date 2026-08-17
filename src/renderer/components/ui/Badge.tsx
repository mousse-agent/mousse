import type { ReactNode } from 'react'

export function Badge({ children, tone, className = '' }: { children: ReactNode; tone?: string; className?: string }) {
  return <span className={`badge ${tone ? `badge-${tone}` : ''} ${className}`.trim()}>{children}</span>
}

export function StatusBadge({ label, state }: { label: string; state: string }) {
  return <span className={`status-badge status-${state}`}>{label}</span>
}

export function StatusDot({ active, size = 8 }: { active?: boolean; size?: number }) {
  return <span className={`status-dot ${active ? 'status-dot-active' : ''}`} style={{ width: size, height: size }} />
}
