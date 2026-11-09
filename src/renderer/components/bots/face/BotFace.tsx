import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { BotState } from '../../../../shared/bots/personal/chat'
import { BOT_ACCESSORY_HEX, BOT_ACCESSORY_LABELS, BOT_COLOUR_HEX, botEyesOf, botKindOf, normalizeBotLook, type BotLook, type KnownBotLook } from '../../../../shared/bots/personal/look'
import { useMotionScale } from '../../../lib/motion'
import { sharedFaceRenderer, sharedFaceRendererStatus, subscribeSharedFaceRenderer, type FaceHandle, type FaceSpec } from './faceRenderer'
import './face.css'

/**
 * A bot's face (Bot Phase 1 §5.12, bot-ui §4.3): its clay mouse or Mousse, whose pose shows the state.
 * `happy` is the renderer-only "done" moment. `head` shows the head (lists, header, messages: 34 to
 * 48 px); `full` the whole mouse (About, the empty page: 88 to 104 px). `still` draws the pose
 * without motion; reduced motion does the same.
 */
export type BotFaceState = BotState | 'happy'

export interface BotFaceProps {
  look: BotLook
  state: BotFaceState
  /** CSS pixels, square. */
  size: number
  view: 'head' | 'full'
  still?: boolean
  /** Accessible name; without it the face is decorative. */
  label?: string
  className?: string
}

export const BOT_FACE_STATES: readonly BotFaceState[] = ['idle', 'working', 'needs_you', 'stuck', 'paused', 'happy']
const DEFAULT_SIZE = 40
const MIN_SIZE = 16
const MAX_SIZE = 256

export interface NormalizedFaceProps {
  look: KnownBotLook
  state: BotFaceState
  size: number
  view: 'head' | 'full'
}

/** The face this build draws: unknown looks and states read as the defaults, sizes are whole pixels in range. */
export function normalizeFaceProps(props: Pick<BotFaceProps, 'look' | 'state' | 'size' | 'view'>): NormalizedFaceProps {
  const size = Number.isFinite(props.size) && props.size > 0 ? Math.round(Math.min(MAX_SIZE, Math.max(MIN_SIZE, props.size))) : DEFAULT_SIZE
  return {
    look: normalizeBotLook(props.look),
    state: BOT_FACE_STATES.includes(props.state) ? props.state : 'idle',
    size,
    view: props.view === 'full' ? 'full' : 'head'
  }
}

function a11y(label: string | undefined) {
  return label ? ({ role: 'img', 'aria-label': label } as const) : ({ 'aria-hidden': true } as const)
}

/**
 * The live mouse, drawn by the shared WebGL renderer (`faceRenderer.ts`). Falls back to
 * `BotFaceStill` when WebGL is missing, context creation fails or the shader doesn't compile.
 */
export function BotFace(props: BotFaceProps) {
  const status = useSyncExternalStore(subscribeSharedFaceRenderer, sharedFaceRendererStatus, () => 'unavailable' as const)
  const [broken, setBroken] = useState(false)
  if (broken || status === 'unavailable' || status === 'failed') return <BotFaceStill {...props} />
  return <BotFaceLive {...props} onBroken={() => setBroken(true)} />
}

function BotFaceLive({ onBroken, ...props }: BotFaceProps & { onBroken(): void }) {
  const { look, state, size, view } = normalizeFaceProps(props)
  const motionOff = useMotionScale() === 0
  const still = props.still === true || motionOff
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const handleRef = useRef<FaceHandle | null>(null)
  const spec: FaceSpec = { look, state, size, view, still }
  const specRef = useRef(spec)
  specRef.current = spec

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const handle = canvas ? sharedFaceRenderer()?.register(canvas, specRef.current) ?? null : null
    if (!handle) {
      onBroken()
      return
    }
    handleRef.current = handle
    return () => {
      handle.dispose()
      handleRef.current = null
    }
    // Registered once per mount; changes go through update() below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(() => {
    handleRef.current?.update(specRef.current)
  }, [look.colour, look.accessory, look.kind, look.eyes, state, size, view, still])

  return (
    <span
      className={`bot-face bot-face-live${props.className ? ` ${props.className}` : ''}`}
      style={{ width: size, height: size }}
      data-state={state}
      data-view={view}
      data-colour={look.colour}
      data-accessory={look.accessory}
      data-kind={botKindOf(look)}
      data-eyes={botEyesOf(look)}
      data-still={still ? 'true' : undefined}
      {...a11y(props.label)}
    >
      <canvas ref={canvasRef} className="bot-face-canvas" aria-hidden />
      {state === 'paused' && (
        <span className="bot-face-z" style={{ fontSize: Math.max(8, Math.round(size * 0.18)) }} aria-hidden>
          z
        </span>
      )}
    </span>
  )
}

/**
 * The still fallback, with no WebGL: a round head in the look's colour with eyes (a mouse has ears;
 * a Mousse has its curled whip and a goblet rim), and a badge in the accessory's colour. Unknown
 * look values draw as the default.
 */
export function BotFaceStill(props: BotFaceProps) {
  const { look: known, state, size, view } = normalizeFaceProps(props)
  const body = BOT_COLOUR_HEX[known.colour]
  const accessory = BOT_ACCESSORY_HEX[known.accessory]
  const asleep = state === 'paused'
  const mousse = botKindOf(known) === 'mousse'
  return (
    <svg
      className={`bot-face bot-face-still${props.className ? ` ${props.className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      data-state={state}
      data-view={view}
      data-colour={known.colour}
      data-accessory={known.accessory}
      data-kind={botKindOf(known)}
      style={{ flex: 'none', opacity: asleep ? 0.6 : 1 }}
      {...a11y(props.label)}
    >
      {mousse ? (
        <path d="M20 2C19 7 13 9 9 13C5.5 16.5 6 22 6 25H34C34 19 31 15 26 12C22.5 9.5 21 6 24 3C22.5 2 21 2 20 2Z" fill={body} />
      ) : (
        <>
          <circle cx="10" cy="11" r="7" fill={body} />
          <circle cx="30" cy="11" r="7" fill={body} />
        </>
      )}
      <circle cx="20" cy="23" r="14" fill={body} />
      {mousse && <path d="M5.5 25.5A14.5 13 0 0 0 34.5 25.5Z" fill={body} style={{ filter: 'brightness(0.62)' }} />}
      {asleep ? (
        <g stroke="#1c1c1f" strokeWidth="1.6" strokeLinecap="round">
          <line x1="13.5" y1="22" x2="17" y2="22" />
          <line x1="23" y1="22" x2="26.5" y2="22" />
        </g>
      ) : (
        <g fill="#1c1c1f">
          <ellipse cx="15.5" cy="21.5" rx="1.8" ry={state === 'needs_you' ? 3 : 2.4} />
          <ellipse cx="24.5" cy="21.5" rx="1.8" ry={state === 'needs_you' ? 3 : 2.4} />
        </g>
      )}
      {!mousse && <circle cx="20" cy="27" r="1.3" fill="#1c1c1f" />}
      {accessory && (
        <circle cx="33" cy="33" r="5" fill={accessory} stroke="#ffffff" strokeWidth="1.5">
          <title>{BOT_ACCESSORY_LABELS[known.accessory]}</title>
        </circle>
      )}
    </svg>
  )
}
