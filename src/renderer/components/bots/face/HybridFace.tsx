import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { botEyeColourOf, botEyesOf, botKindOf, type BotEyes, type KnownBotLook } from '../../../../shared/bots/personal/look'
import type { BotFaceState } from './BotFace'
import { BotFaceSleepMark } from './BotFaceSleepMark'
import { EYELESS, FEATURES_ONLY, FRONT_ONLY, hop } from './facePoses'
import { sharedFaceRenderer, type FaceSpec } from './faceRenderer'
import { EYE_BOX, eyeColour, eyeGeometry, eyeShapeOf, lidClip, mouseArcPath, mouseEyePath, pointerLook, type EyeGeometry } from './hybridEyes'
import './hybridFace.css'

/**
 * A hybrid face, used by the mascot (`Mascot.tsx`): the clay body is drawn by the shader once per state,
 * with no eyes, and kept as a picture; the eyes are flat shapes over it, moved with CSS transforms.
 * Nothing is ray-marched while it moves, and between moves (a blink, a glance, a hop) nothing is
 * animating at all: each move is one short transition started by a timer.
 *
 * The states read as they do live: idle glances about and blinks; working reads across its laptop;
 * needs you has wide eyes and hops twice; stuck has worried lids, looks side to side and shudders;
 * paused sleeps; happy shuts its eyes into arcs and hops.
 */

export interface HybridFaceProps {
  look: KnownBotLook
  state: BotFaceState
  size: number
  view: 'head' | 'full'
  className?: string
  label?: string
  resting?: boolean
  /** The bot's computer is away: its moon instead of the z (`BotFaceSleepMark`). */
  away?: boolean
  /** The eyes glance towards the pointer, anywhere in the window, instead of wandering while idle. */
  followPointer?: boolean
}

/** The eyes go back to the middle this long after the pointer last moved. */
const FOLLOW_REST_MS = 1800

interface Layer {
  id: number
  key: string
  spec: FaceSpec
  /** The accessory's parts in front of the eyes, drawn over them; none when it never covers them. */
  front?: FaceSpec
  /** The mouse's nose and whiskers, apart from its body so they turn with the eyes. */
  features?: FaceSpec
}

/**
 * Whether the accessory can cover the eyes: on the mouse everything at its head (a brim, goggles, a hood, glasses'
 * frames, headphones); on the Mousse only glasses, the one thing in front of its glass.
 */
function coversEyes(look: KnownBotLook): boolean {
  if (botKindOf(look) === 'mousse') return look.accessory === 'glasses'
  return look.accessory !== 'none' && look.accessory !== 'bow_tie' && look.accessory !== 'scarf'
}

/** How long an old body stays under the new one before it is dropped (its fade is in the CSS). */
const LAYER_DROP_MS = 420

let nextLayer = 1

function layerOf(key: string, look: KnownBotLook, state: BotFaceState, size: number, view: 'head' | 'full'): Layer {
  // One eyeless body serves every eye shape.
  const body = { ...look, eyes: EYELESS as unknown as BotEyes }
  const front = coversEyes(look) ? { look: { ...look, eyes: FRONT_ONLY as unknown as BotEyes }, state, size, view, still: true } : undefined
  const features = botKindOf(look) === 'mousse' ? undefined : { look: { ...look, eyes: FEATURES_ONLY as unknown as BotEyes }, state, size, view, still: true }
  return { id: nextLayer++, key, spec: { look: body, state, size, view, still: true }, ...(front ? { front } : {}), ...(features ? { features } : {}) }
}

export function HybridFace({ look, state, size, view, className, label, resting, away, followPointer }: HybridFaceProps) {
  const key = `${look.colour}|${look.accessory}|${botKindOf(look)}|${state}|${view}|${size}`
  const [layers, setLayers] = useState<Layer[]>(() => [layerOf(key, look, state, size, view)])
  /** The newest layer whose picture is on its canvas. */
  const [drawn, setDrawn] = useState(0)
  let current = layers[layers.length - 1]!
  if (current.key !== key) {
    current = layerOf(key, look, state, size, view)
    setLayers([...layers, current])
  }
  const ready = drawn === current.id

  // Once the new body shows, the ones under it fade and go.
  useEffect(() => {
    if (!ready || layers.length < 2) return
    const timer = setTimeout(() => setLayers((list) => list.filter((layer) => layer.id >= drawn)), LAYER_DROP_MS)
    return () => clearTimeout(timer)
  }, [ready, drawn, layers.length])

  const geometry = useMemo(() => eyeGeometry(look, state, view, size), [look.colour, look.accessory, look.kind, look.eyes, state, view, size]) // eslint-disable-line react-hooks/exhaustive-deps
  const shape = eyeShapeOf(look)
  const colour = eyeColour(look)
  const closed = geometry.closed > 0.5
  const stage = useRef<HTMLSpanElement>(null)
  const looks = useRef<(HTMLSpanElement | null)[]>([null, null])
  const blinks = useRef<(HTMLSpanElement | null)[]>([null, null])
  const halves = useRef<(HTMLSpanElement | null)[]>([null, null])
  const live = useRef(geometry)
  live.current = geometry

  useEffect(() => direct(state, () => live.current, stage, looks, blinks, halves, followPointer === true), [state, followPointer])

  // Following the pointer: one listener, read once a frame, moving only the eyes' transforms. The eyes ease
  // towards it and drift back to the middle when it stops or leaves the window.
  useEffect(() => {
    if (!followPointer) return
    let frame = 0
    let rest: ReturnType<typeof setTimeout> | undefined
    let at: { x: number; y: number } | null = null
    const turn = (x: number, y: number, ms: number): void => {
      const g = live.current
      looks.current.forEach((element, index) => {
        if (!element) return
        element.style.transition = `transform ${ms}ms cubic-bezier(0.25, 0.6, 0.3, 1)`
        element.style.transform = g.move(index, x, y)
      })
      turnFeatures(halves.current, g, x, y, `${ms}ms cubic-bezier(0.25, 0.6, 0.3, 1)`)
    }
    const centre = (): void => {
      at = null
      clearTimeout(rest)
      turn(0, 0, 700)
    }
    const apply = (): void => {
      frame = 0
      const box = stage.current?.getBoundingClientRect()
      if (!at || !box || box.width === 0) return
      const look = pointerLook(box, at.x, at.y)
      turn(look.x, look.y, 220)
    }
    const moved = (event: PointerEvent): void => {
      at = { x: event.clientX, y: event.clientY }
      if (!frame) frame = requestAnimationFrame(apply)
      clearTimeout(rest)
      rest = setTimeout(centre, FOLLOW_REST_MS)
    }
    window.addEventListener('pointermove', moved, { passive: true })
    document.documentElement.addEventListener('pointerleave', centre)
    window.addEventListener('blur', centre)
    return () => {
      window.removeEventListener('pointermove', moved)
      document.documentElement.removeEventListener('pointerleave', centre)
      window.removeEventListener('blur', centre)
      if (frame) cancelAnimationFrame(frame)
      clearTimeout(rest)
    }
  }, [followPointer])

  const mouse = botKindOf(look) !== 'mousse'
  // A soft shadow under each of the Mousse's eyes where there are pixels to show it. The mouse's 3D eyes have none.
  const shadow = !mouse && size >= 56 ? `drop-shadow(0 ${(size * 0.011).toFixed(2)}px ${(size * 0.012).toFixed(2)}px rgba(0, 0, 0, ${colour === '#ffffff' ? 0.28 : 0.38}))` : undefined

  return (
    <span
      className={`bot-face bot-face-live bot-face-hybrid${className ? ` ${className}` : ''}`}
      style={{ width: size, height: size }}
      data-state={state}
      data-view={view}
      data-colour={look.colour}
      data-accessory={look.accessory}
      data-kind={botKindOf(look)}
      data-eyes={botEyesOf(look)}
      data-resting={resting ? 'true' : undefined}
      {...(label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const))}
    >
      <span className="hf-stage" ref={stage}>
        {layers.map((layer) => (
          <Body
            key={layer.id}
            spec={layer.spec}
            shown={layer.id === current.id ? ready : !ready && layer.id === drawn}
            old={ready && layer.id !== current.id}
            onDrawn={() => setDrawn((id) => Math.max(id, layer.id))}
          />
        ))}
        {mouse && (
          // The nose and whiskers, in two halves split at the nose so each side turns round the head on its own.
          <span className="hf-features">
            {[0, 1].map((half) => (
              <span
                key={half}
                className="hf-half"
                ref={(element) => { halves.current[half] = element }}
                style={{ clipPath: half === 0 ? `inset(0 ${(size - geometry.seam - 0.5).toFixed(2)}px 0 0)` : `inset(0 0 0 ${(geometry.seam - 0.5).toFixed(2)}px)` }}
              >
                {layers.map((layer) =>
                  layer.features ? (
                    <Body
                      key={`features${layer.id}`}
                      spec={layer.features}
                      shown={layer.id === current.id ? ready : !ready && layer.id === drawn}
                      old={ready && layer.id !== current.id}
                      onDrawn={() => {}}
                    />
                  ) : null
                )}
              </span>
            ))}
          </span>
        )}
        <span className="hf-eyes" data-shown={drawn ? '' : undefined}>
          {geometry.eyes.map((place, index) => {
            const side = index === 0 ? -1 : 1
            const width = 2 * EYE_BOX * place.sx
            const height = 2 * EYE_BOX * place.sy
            const arcCut = closed ? mouseArcPath(look, side, geometry.es, geometry.arc) : mouse ? '' : undefined
            return (
              <span
                key={index}
                className="hf-eye"
                style={{
                  width,
                  height,
                  left: -width / 2,
                  top: -height / 2,
                  transform: `translate(${place.x.toFixed(2)}px, ${place.y.toFixed(2)}px) rotate(${place.angle.toFixed(4)}rad) scale(${geometry.es})`,
                  filter: shadow
                }}
              >
                <span className="hf-look" ref={(element) => { looks.current[index] = element }}>
                  <span className="hf-lid" style={{ clipPath: lidClip(shape, side, geometry.open, geometry.worried) }}>
                    <span className="hf-open" style={{ transform: `scaleY(${closed ? 0.08 : geometry.open})`, opacity: closed ? 0 : 1 }}>
                      <span className="hf-blink" ref={(element) => { blinks.current[index] = element }}>
                        <EyeShape shape={shape} side={side} colour={colour} cut={mouseEyePath(look, side, geometry.es)} />
                      </span>
                    </span>
                  </span>
                  {arcCut !== undefined ? (
                    // A mouse's arc is drawn as the part of it the head leaves showing (`mouseArcPath`).
                    <svg className="hf-arc" viewBox={VIEW_BOX} style={{ opacity: closed ? 1 : 0 }} aria-hidden>
                      <path d={arcCut} fill={botEyeColourOf(look) === 'white' ? colour : '#19191b'} />
                    </svg>
                  ) : (
                    <svg className="hf-arc" viewBox={VIEW_BOX} style={{ opacity: closed ? 1 : 0, transform: geometry.arc > 0 ? undefined : 'scaleY(-1)' }} aria-hidden>
                      <path d="M -0.1515 0.0529 A 0.17 0.17 0 0 1 0.1515 0.0529" fill="none" stroke={colour} strokeWidth={0.09} strokeLinecap="round" />
                    </svg>
                  )}
                </span>
              </span>
            )
          })}
        </span>
        {layers.map((layer) =>
          layer.front ? (
            <Body
              key={`front${layer.id}`}
              spec={layer.front}
              shown={layer.id === current.id ? ready : !ready && layer.id === drawn}
              old={ready && layer.id !== current.id}
              onDrawn={() => {}}
            />
          ) : null
        )}
      </span>
      {state === 'paused' && <BotFaceSleepMark size={size} away={away} />}
    </span>
  )
}

/** One body picture: a canvas the shared renderer draws the eyeless still pose into, once. */
function Body({ spec, shown, old, onDrawn }: { spec: FaceSpec; shown: boolean; old: boolean; onDrawn(): void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const drawn = useRef(onDrawn)
  drawn.current = onDrawn
  useLayoutEffect(() => {
    const handle = canvas.current ? sharedFaceRenderer()?.register(canvas.current, spec, { onDrawn: () => drawn.current() }) ?? null : null
    if (!handle) drawn.current()
    return () => handle?.dispose()
    // Registered once: a layer's spec never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <span className="hf-layer" data-shown={shown && !old ? '' : undefined} data-old={old ? '' : undefined}>
      <canvas ref={canvas} className="bot-face-canvas" aria-hidden />
    </span>
  )
}

const VIEW_BOX = `${-EYE_BOX} ${-EYE_BOX} ${2 * EYE_BOX} ${2 * EYE_BOX}`

const STAR = Array.from({ length: 10 }, (_, index) => {
  const radius = index % 2 === 0 ? 0.26 : 0.117
  const angle = -Math.PI / 2 + (index * Math.PI) / 5
  return `${(Math.cos(angle) * radius).toFixed(4)},${(Math.sin(angle) * radius).toFixed(4)}`
}).join(' ')

/** The open eye of each shape, as the shader's `eye2` draws it (y down here). */
function EyeShape({ shape, side, colour, cut }: { shape: BotEyes; side: number; colour: string; cut?: string }) {
  let drawing
  // A mouse's eye is drawn as the part of it the head leaves showing (`mouseEyePath`).
  if (cut !== undefined) {
    drawing = (
      <>
        <path d={cut} fill={colour} />
        {/* The pill is a rounded bead in 3D, with the light's glint on its upper left. */}
        {shape === 'pill' && <ellipse cx={-0.05} cy={-0.07} rx={0.035} ry={0.085} fill="#ffffff" opacity={0.22} />}
      </>
    )
  }
  else if (shape === 'round') drawing = <circle r={0.2} fill={colour} />
  else if (shape === 'dot') drawing = <circle r={0.105} fill={colour} />
  else if (shape === 'tall') drawing = <ellipse rx={0.115} ry={0.3} fill={colour} />
  else if (shape === 'square') drawing = <rect x={-0.175} y={-0.175} width={0.35} height={0.35} rx={0.06} fill={colour} />
  else if (shape === 'heart') drawing = <path d="M 0 0.1815 L 0.165 0.0165 A 0.1167 0.1167 0 0 0 0 -0.1485 A 0.1167 0.1167 0 0 0 -0.165 0.0165 Z" fill={colour} />
  else if (shape === 'star') drawing = <polygon points={STAR} fill={colour} stroke={colour} strokeWidth={0.05} strokeLinejoin="round" />
  else if (shape === 'code') {
    drawing = (
      <polyline
        points={`${-side * 0.09},-0.15 ${side * 0.11},0 ${-side * 0.09},0.15`}
        fill="none"
        stroke={colour}
        strokeWidth={0.096}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    )
  } else drawing = <ellipse rx={0.155} ry={0.225} fill={colour} />
  return (
    <svg viewBox={VIEW_BOX} aria-hidden>
      {drawing}
    </svg>
  )
}

type Elements = { current: (HTMLSpanElement | null)[] }

/** Turns the halves of the mouse's nose and whiskers with the eyes (`EyeGeometry.features`), over the same `transition`. */
function turnFeatures(halves: (HTMLElement | null)[], g: EyeGeometry, x: number, y: number, transition: string): void {
  const moves = g.features(x, y)
  halves.forEach((element, index) => {
    if (!element) return
    element.style.transition = `transform ${transition}`
    element.style.transform = moves[index]!
  })
}

/**
 * Plays a state's moves until the state changes: each is one short transition or animation started by a
 * timer, so nothing runs between them. Returns the stop function.
 */
function direct(state: BotFaceState, geometry: () => EyeGeometry, stage: { current: HTMLSpanElement | null }, looks: Elements, blinks: Elements, halves: Elements, follows = false): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let stopped = false
  const later = (ms: number, run: () => void): void => {
    const id = setTimeout(() => {
      timers.delete(id)
      if (!stopped) run()
    }, ms)
    timers.add(id)
  }
  const between = (a: number, b: number): number => a + Math.random() * (b - a)
  /** A window nobody sees gets no moves; the timers keep their rhythm. */
  const unseen = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'
  const play = (element: HTMLElement | null, frames: Keyframe[], duration: number): void => {
    if (!element || typeof element.animate !== 'function' || unseen()) return
    element.animate(frames, { duration, easing: 'linear' })
  }
  const glance = (x: number, y: number, ms: number): void => {
    const g = geometry()
    looks.current.forEach((element, index) => {
      if (!element) return
      element.style.transition = `transform ${ms}ms cubic-bezier(0.3, 0.7, 0.3, 1)`
      element.style.transform = g.move(index, x, y)
    })
    turnFeatures(halves.current, g, x, y, `${ms}ms cubic-bezier(0.3, 0.7, 0.3, 1)`)
  }
  const blink = (): void => {
    for (const element of blinks.current) play(element, [{ transform: 'scaleY(1)' }, { transform: 'scaleY(0.06)', offset: 0.45 }, { transform: 'scaleY(1)' }], 170)
  }
  const blinking = (): void =>
    later(between(2200, 5000), () => {
      blink()
      if (Math.random() < 0.2) later(260, blink)
      blinking()
    })
  /** One hop of the whole face: the live face's crouch, flight and landing squash, `height` world units high. */
  const jump = (height: number, seconds: number, sway = 0): void => {
    const steps = 13
    const px = height * geometry().unit
    const frames = Array.from({ length: steps + 1 }, (_, index) => {
      const [h, squash] = hop((index / steps) * 1.3)
      const turn = sway * Math.sin((2 * Math.PI * index) / steps)
      return { transform: `translateY(${(-h * px).toFixed(2)}px) rotate(${turn.toFixed(2)}deg) scaleY(${squash.toFixed(3)})`, offset: index / steps }
    })
    play(stage.current, frames, seconds * 1300)
  }

  if (state === 'idle') {
    // Eyes that follow the pointer keep where they look; the rest wander.
    if (!follows) glance(0, 0, 240)
    const wander = (): void =>
      later(between(1600, 3600), () => {
        if (!unseen()) glance(Math.random() < 0.3 ? 0 : between(-0.7, 0.7), between(-0.1, 0.12), 260)
        wander()
      })
    if (!follows) wander()
    blinking()
  } else if (state === 'working') {
    // Reading: five short glances across, then back to the start of the line.
    let step = 0
    const read = (): void => {
      if (!unseen()) glance(-0.55 + (1.1 * step) / 4, -0.045, step === 0 ? 180 : 110)
      step = (step + 1) % 5
      later(step === 0 ? 420 : 340, read)
    }
    read()
    blinking()
  } else if (state === 'needs_you') {
    glance(0, 0.02, 240)
    const call = (): void => {
      jump(0.32, 0.42)
      later(600, () => jump(0.32, 0.42))
      later(3000, call)
    }
    later(200, call)
    blinking()
  } else if (state === 'stuck') {
    let way = 1
    const dart = (): void => {
      if (!unseen()) glance(0.3 * way, 0, 300)
      way = -way
      later(between(3400, 4400), dart)
    }
    dart()
    const shudder = (): void =>
      later(4500, () => {
        play(stage.current, [0, 2, -2, 1.6, -1.6, 1, -1, 0].map((turn) => ({ transform: `rotate(${turn}deg)` })), 450)
        shudder()
      })
    shudder()
    blinking()
  } else if (state === 'paused') {
    glance(0, -0.03, 300)
  } else {
    glance(0, 0, 200)
    const cheer = (): void => {
      jump(0.2, 0.4, 4)
      later(1500, cheer)
    }
    cheer()
  }

  return () => {
    stopped = true
    // A move under way runs out; only its follow-ups are dropped, so a state change never snaps the face.
    for (const id of timers) clearTimeout(id)
  }
}
