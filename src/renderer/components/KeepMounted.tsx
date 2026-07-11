import type { ReactNode } from 'react'

interface KeepMountedProps {
  active: boolean
  children: ReactNode
  className?: string
}

/** Renders children always but hides inactive panes to avoid mount/unmount flicker. */
export function KeepMounted({ active, children, className }: KeepMountedProps) {
  return (
    <div className={className} hidden={!active} aria-hidden={!active}>
      {children}
    </div>
  )
}

interface KeepMountedStackProps {
  children: ReactNode
  className?: string
}

export function KeepMountedStack({ children, className }: KeepMountedStackProps) {
  return <div className={className ?? 'keep-mounted-stack'}>{children}</div>
}
