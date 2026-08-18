import type { ButtonHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'ghost' | 'danger' | 'success'
type Size = 'sm' | 'md'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  icon?: ReactNode
}

export function Button({ variant = 'ghost', size = 'md', icon, children, className = '', ...props }: ButtonProps) {
  const v = variant === 'ghost' ? '' : `btn-${variant}`
  const s = size === 'sm' ? 'btn-sm' : ''
  return (
    <button type="button" className={`btn ${v} ${s} ${className}`.trim().replace(/\s+/g, ' ')} {...props}>
      {icon}
      {children}
    </button>
  )
}
