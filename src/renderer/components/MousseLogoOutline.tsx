import type { ReactNode } from 'react'
import logoOutlineSvg from '../assets/mousse_logo_icon_outline.svg?raw'

// One object for every render: React sets the inner HTML again whenever it gets a new one.
const logoHtml = { __html: logoOutlineSvg }

interface MousseLogoOutlineProps {
  className?: string
  label?: string
  /** Drawn over the logo (the art then sits in its own `.mousse-logo-outline-art` box). */
  children?: ReactNode
}

export function MousseLogoOutline({ className, label = 'Mousse', children }: MousseLogoOutlineProps) {
  if (children === undefined) {
    return <div className={className} role="img" aria-label={label} dangerouslySetInnerHTML={logoHtml} />
  }
  return (
    <div className={className} role="img" aria-label={label}>
      <span className="mousse-logo-outline-art" dangerouslySetInnerHTML={logoHtml} />
      {children}
    </div>
  )
}
