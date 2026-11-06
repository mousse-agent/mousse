import type { BotState } from '../../../../shared/bots/personal/chat'
import { BOT_ACCESSORY_HEX, BOT_ACCESSORY_LABELS, BOT_COLOUR_HEX, normalizeBotLook, type BotLook } from '../../../../shared/bots/personal/look'

/**
 * A bot's face (Bot Phase 1 §5.12, bot-ui §4.3): its clay mouse, whose pose shows the state.
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

/**
 * TODO(WP5): the live WebGL mouse on one shared canvas (`faceRenderer.ts`), falling back to
 * `BotFaceStill` when WebGL is missing or context creation fails.
 */
export function BotFace(props: BotFaceProps) {
  return <BotFaceStill {...props} />
}

/**
 * The still fallback, with no WebGL: a round head in the look's colour, with ears and eyes, and a
 * badge in the accessory's colour. Unknown look values draw as the default.
 */
export function BotFaceStill({ look, state, size, view, label, className }: BotFaceProps) {
  const known = normalizeBotLook(look)
  const body = BOT_COLOUR_HEX[known.colour]
  const accessory = BOT_ACCESSORY_HEX[known.accessory]
  const asleep = state === 'paused'
  return (
    <svg
      className={`bot-face bot-face-still${className ? ` ${className}` : ''}`}
      width={size}
      height={size}
      viewBox="0 0 40 40"
      data-state={state}
      data-view={view}
      data-colour={known.colour}
      data-accessory={known.accessory}
      style={{ flex: 'none', opacity: asleep ? 0.6 : 1 }}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <circle cx="10" cy="11" r="7" fill={body} />
      <circle cx="30" cy="11" r="7" fill={body} />
      <circle cx="20" cy="23" r="14" fill={body} />
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
      <circle cx="20" cy="27" r="1.3" fill="#1c1c1f" />
      {accessory && (
        <circle cx="33" cy="33" r="5" fill={accessory} stroke="#ffffff" strokeWidth="1.5">
          <title>{BOT_ACCESSORY_LABELS[known.accessory]}</title>
        </circle>
      )}
    </svg>
  )
}
