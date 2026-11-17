import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'

interface KeepMountedProps {
  active: boolean
  children: ReactNode
  className?: string
  /** Retain the last viewport for live browser guests while excluding human input. */
  preserveLayout?: boolean
  as?: 'div' | 'main'
  style?: CSSProperties
}

/** Renders children always but hides inactive panes to avoid mount/unmount flicker. */
export function KeepMounted({ active, children, className, preserveLayout = false, as: Tag = 'div', style }: KeepMountedProps) {
  const ref = useRef<HTMLDivElement & HTMLElement>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !preserveLayout) return
    if (!active) {
      const focused = document.activeElement
      if (focused instanceof HTMLElement && element.contains(focused)) focused.blur()
      return
    }
    const rememberSize = () => {
      const { width, height } = element.getBoundingClientRect()
      if (width > 0 && height > 0) {
        element.style.setProperty('--keep-mounted-width', `${width}px`)
        element.style.setProperty('--keep-mounted-height', `${height}px`)
      }
    }
    rememberSize()
    const observer = new ResizeObserver(rememberSize)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, preserveLayout])
  return (
    <Tag ref={ref} className={[className, preserveLayout && !active ? 'keep-mounted-layout-inactive' : ''].filter(Boolean).join(' ')}
      style={style} hidden={!preserveLayout && !active} inert={!active} aria-hidden={!active}>
      {children}
    </Tag>
  )
}

interface KeepMountedStackProps {
  children: ReactNode
  className?: string
}

export function KeepMountedStack({ children, className }: KeepMountedStackProps) {
  return <div className={className ?? 'keep-mounted-stack'}>{children}</div>
}
