import { forwardRef, type ButtonHTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon
  label: string
  variant?: 'ghost' | 'primary' | 'titlebar'
  size?: number
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    icon: Icon,
    label,
    variant = 'ghost',
    size = 16,
    className = '',
    ...props
  },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      className={`icon-btn icon-btn-${variant} ${className}`.trim()}
      title={label}
      aria-label={label}
      {...props}
    >
      <Icon size={size} strokeWidth={2} />
    </button>
  )
})
