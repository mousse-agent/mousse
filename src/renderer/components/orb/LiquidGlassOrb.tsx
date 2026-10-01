import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { normalizeOrbAppearance } from './orbAppearance'
import './orb.css'

export interface LiquidGlassOrbProps {
  appearance?: unknown
  label?: string
  className?: string
  /** Library thumbnails are static; large editor instances can animate. */
  compact?: boolean
  active?: boolean
}

export function LiquidGlassOrb({ appearance, label, className = '', compact = false, active = true }: LiquidGlassOrbProps) {
  const value = normalizeOrbAppearance(appearance)
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const [visible, setVisible] = useState(false)
  const [foreground, setForeground] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(true)

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const motion = () => setReducedMotion(media.matches)
    const visibility = () => setForeground(document.visibilityState === 'visible')
    motion()
    visibility()
    media.addEventListener('change', motion)
    document.addEventListener('visibilitychange', visibility)
    const host = hostRef.current
    const observer = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { threshold: 0.01 })
      : null
    if (host && observer) observer.observe(host)
    else setVisible(true)
    return () => {
      media.removeEventListener('change', motion)
      document.removeEventListener('visibilitychange', visibility)
      observer?.disconnect()
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const moving = active && visible && foreground && !reducedMotion && !compact && value.motion > 0
  const canParallax = moving && value.parallax
  function resetParallax() {
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    hostRef.current?.style.setProperty('--orb-pointer-x', '0deg')
    hostRef.current?.style.setProperty('--orb-pointer-y', '0deg')
  }
  useEffect(() => {
    if (!canParallax) resetParallax()
  }, [canParallax])

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!canParallax || event.pointerType === 'touch') return
    const bounds = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - bounds.left) / bounds.width - 0.5
    const y = (event.clientY - bounds.top) / bounds.height - 0.5
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
    frameRef.current = requestAnimationFrame(() => {
      hostRef.current?.style.setProperty('--orb-pointer-x', (-y * 9).toFixed(2) + 'deg')
      hostRef.current?.style.setProperty('--orb-pointer-y', (x * 9).toFixed(2) + 'deg')
      frameRef.current = null
    })
  }

  const colors = value.colors
  const style = {
    '--orb-color-1': colors[0],
    '--orb-color-2': colors[1],
    '--orb-color-3': colors[2] ?? colors[0],
    '--orb-color-4': colors[3] ?? colors[1],
    '--orb-light': 0.7 + value.luminance * 0.6,
    '--orb-density': 0.96 - value.translucency * 0.36,
    '--orb-period': (32 - value.motion * 20) + 's',
    '--orb-travel': (2 + value.motion * 8) + '%',
    '--orb-seed': value.seed + 'deg',
    '--orb-phase': -(value.seed / 360 * 20) + 's'
  } as CSSProperties

  return (
    <div ref={hostRef} className={'liquid-orb ' + className} style={style}
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}
      data-compact={compact} data-moving={moving}
      onPointerMove={onPointerMove} onPointerLeave={resetParallax}>
      <div className="liquid-orb__ambient" />
      <div className="liquid-orb__shadow" />
      <div className="liquid-orb__body">
        <div className="liquid-orb__depth" />
        <div className="liquid-orb__flow">
          <i className="liquid-orb__ribbon liquid-orb__ribbon--one" />
          <i className="liquid-orb__ribbon liquid-orb__ribbon--two" />
          <i className="liquid-orb__ribbon liquid-orb__ribbon--three" />
        </div>
        <div className="liquid-orb__lens" />
        <div className="liquid-orb__caustic" />
        <div className="liquid-orb__rim" />
        <div className="liquid-orb__highlight" />
      </div>
    </div>
  )
}
