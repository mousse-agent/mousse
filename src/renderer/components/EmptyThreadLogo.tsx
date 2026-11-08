import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from 'react'
import logoOutlineSvg from '../assets/mousse_logo_icon_outline.svg?raw'
import { scaleMotionMs, useMotionScale } from '../lib/motion'
import { useAppStore } from '../stores/appStore'
import { IncognitoGlasses } from './IncognitoGlasses'
import '../styles/empty-logo.css'

// The outline logo split into parts, read from the original asset (which stays as it is). In file order:
// stem, swirl, glass (rim and bowl), inner bowl, front of the rim, left eye, right eye.
const PART_OF = ['stem', 'swirl', 'glass', 'inner', 'rim', 'eye', 'eye'] as const
const PATHS = [...logoOutlineSvg.matchAll(/<path d="([^"]+)"[^>]*stroke-width="(\d+)"/g)].map((match, index) => ({
  d: match[1],
  width: Number(match[2]),
  part: PART_OF[index] ?? 'glass'
}))
const INNER_BOWL = PATHS.find((path) => path.part === 'inner')?.d ?? ''

// The liquid: a wavy surface (period 64) from x -128 to 832, with the body hanging below it.
const SURFACE = `M-128 0${' q16 -7 32 0 t32 0'.repeat(15)}`
const BODY = `${SURFACE} V420 H-128 Z`
const BUBBLES = [
  { cx: 214, r: 11, delay: 0 },
  { cx: 262, r: 8, delay: 90 },
  { cx: 300, r: 12, delay: 170 },
  { cx: 238, r: 7, delay: 250 },
  { cx: 284, r: 9, delay: 320 },
  { cx: 194, r: 6, delay: 380 }
]

/** The draft length at which the glass is full. */
export const FULL_GLASS_CHARS = 200
/** How long the outline takes to draw itself; the fill and the swirl's sway wait for it. */
const DRAW_MS = 650
/** How long the pour plays after a send. */
const POUR_MS = 1100

const draftKey = (state: ReturnType<typeof useAppStore.getState>) => state.activeThreadId ?? '__blank__'
const draftLength = (state: ReturnType<typeof useAppStore.getState>) => (state.composerDrafts[draftKey(state)] ?? '').length

/**
 * Plays the pour on a copy of the logo, pinned where the logo was: a send empties the draft and then, a moment
 * later, the empty view (and the logo with it) goes away. If the logo is still on screen after a short wait,
 * the draft was only cleared and nothing plays. Returns a cancel.
 */
function pourAfterSend(logo: HTMLElement): () => void {
  const rect = logo.getBoundingClientRect()
  const copy = logo.cloneNode(true) as HTMLElement
  const timers: ReturnType<typeof setTimeout>[] = []
  const check = (wait: number, last: boolean) => timers.push(setTimeout(() => {
    if (logo.isConnected) { if (last) cancel(); return }
    cancel()
    copy.classList.add('empty-logo-pour-copy')
    copy.setAttribute('data-pouring', '')
    copy.setAttribute('aria-hidden', 'true')
    copy.removeAttribute('role')
    copy.querySelector('[data-tilting]')?.removeAttribute('data-tilting')
    Object.assign(copy.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
    document.body.appendChild(copy)
    // The fill drains as the pour plays.
    requestAnimationFrame(() => copy.querySelector<HTMLElement>('.empty-logo-liquid')?.style.setProperty('--empty-logo-fill', '0'))
    setTimeout(() => copy.remove(), scaleMotionMs(POUR_MS))
  }, wait))
  const cancel = () => timers.splice(0).forEach(clearTimeout)
  check(0, false)
  check(60, false)
  check(200, false)
  check(400, true)
  return cancel
}

/** Starts the swirl's sway at the ambient glow's current point in its loop (ambient-glow.css). Read once. */
function useGlowPhase(ref: RefObject<HTMLElement | null>, start: boolean): void {
  useLayoutEffect(() => {
    const el = ref.current
    const chat = el?.closest('.chat--empty')
    if (!start || !el || !chat || typeof chat.getAnimations !== 'function') return
    const glow = chat.getAnimations({ subtree: true }).find((animation) => (animation as CSSAnimation).animationName === 'ambient-glow-b')
    const time = Number(glow?.currentTime ?? 0)
    if (Number.isFinite(time) && time > 0) el.style.setProperty('--empty-logo-glow-delay', `${-time}ms`)
  }, [ref, start])
}

/**
 * The empty chat's logo. It draws itself in on mount; then the glass fills with accent liquid as the draft
 * grows (full at FULL_GLASS_CHARS) and the swirl sways with the ambient glow. It tilts towards the cursor,
 * and a send pours: liquid surges, bubbles rise and the swirl bobs. Private chats add the sunglasses.
 * With Animation speed Off or reduced motion it is still: no draw-in, a fill level without a wave.
 */
export function EmptyThreadLogo({ label, incognito }: { label: string; incognito: boolean }) {
  const still = useMotionScale() === 0
  const [drawn, setDrawn] = useState(still)
  const length = useAppStore(draftLength)
  const rootRef = useRef<HTMLDivElement>(null)
  const tiltRef = useRef<HTMLDivElement>(null)
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  useGlowPhase(rootRef, drawn)

  useEffect(() => {
    if (drawn) return
    if (still) { setDrawn(true); return }
    const timer = setTimeout(() => setDrawn(true), scaleMotionMs(DRAW_MS))
    return () => clearTimeout(timer)
  }, [drawn, still])

  // A send empties the draft of the chat on screen (a thread switch is not a send).
  useEffect(() => {
    if (still) return
    let cancel: (() => void) | undefined
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (state.activeThreadId !== previous.activeThreadId) return
      if (draftLength(previous) === 0 || draftLength(state) > 0 || !rootRef.current) return
      cancel?.()
      cancel = pourAfterSend(rootRef.current)
    })
    // A pending pour outlives the logo: the send is what unmounts it.
    return unsubscribe
  }, [still])

  const tilt = (event: PointerEvent<HTMLElement>) => {
    const el = tiltRef.current
    if (!el || still) return
    const box = event.currentTarget.getBoundingClientRect()
    el.style.setProperty('--empty-logo-tilt-x', Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1)).toFixed(3))
    el.style.setProperty('--empty-logo-tilt-y', Math.max(-1, Math.min(1, ((event.clientY - box.top) / box.height) * 2 - 1)).toFixed(3))
    el.setAttribute('data-tilting', '')
  }
  const untilt = () => {
    const el = tiltRef.current
    if (!el) return
    el.style.removeProperty('--empty-logo-tilt-x')
    el.style.removeProperty('--empty-logo-tilt-y')
    el.removeAttribute('data-tilting')
  }

  const fill = drawn ? Math.round(Math.min(1, length / FULL_GLASS_CHARS) * 100) / 100 : 0
  const glassPaths = PATHS.filter((path) => path.part !== 'swirl')
  const swirlPaths = PATHS.filter((path) => path.part === 'swirl')
  return (
    <div ref={rootRef} className="chat-empty-logo empty-logo" role="img" aria-label={label} data-drawn={drawn || undefined} onPointerMove={tilt} onPointerLeave={untilt}>
      <div ref={tiltRef} className="empty-logo-tilt">
        <svg className="empty-logo-art" viewBox="0 0 514 514" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <defs>
            <clipPath id={`${id}-bowl`}>
              <path d={INNER_BOWL} />
            </clipPath>
          </defs>
          <g clipPath={`url(#${id}-bowl)`} stroke="none">
            <g className="empty-logo-liquid" data-filled={fill > 0 || undefined} style={{ '--empty-logo-fill': fill } as CSSProperties}>
              <g className="empty-logo-wave">
                <path className="empty-logo-liquid-body" d={BODY} />
                <path className="empty-logo-liquid-surface" d={SURFACE} />
              </g>
            </g>
            <g className="empty-logo-pour">
              <g className="empty-logo-wave">
                <path className="empty-logo-liquid-body" d={BODY} />
                <path className="empty-logo-liquid-surface" d={SURFACE} />
              </g>
            </g>
            {BUBBLES.map((bubble, index) => (
              <circle key={index} className="empty-logo-bubble" cx={bubble.cx} cy={338} r={bubble.r} style={{ animationDelay: `calc(${bubble.delay}ms * var(--ui-motion-scale, 1))` }} />
            ))}
          </g>
          {glassPaths.map((path, index) => <path key={index} d={path.d} className={`empty-logo-path empty-logo-${path.part}`} strokeWidth={path.width} pathLength={1} />)}
          <g className="empty-logo-swirl">
            <g className="empty-logo-swirl-bob">
              {swirlPaths.map((path, index) => <path key={index} d={path.d} className="empty-logo-path empty-logo-swirl-path" strokeWidth={path.width} pathLength={1} />)}
            </g>
          </g>
        </svg>
        <IncognitoGlasses on={incognito} />
      </div>
    </div>
  )
}
