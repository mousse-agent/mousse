import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { normalizeBotLook, type BotLook } from '../../../../shared/bots/personal/look'
import { useMotionScale } from '../../../lib/motion'
import { BotFace } from '../../bots/face/BotFace'
import { sharedFaceRendererStatus, subscribeSharedFaceRenderer } from '../../bots/face/faceRenderer'
import { HybridFace } from '../../bots/face/HybridFace'
import './mascot.css'

const MASCOT_LOOK: BotLook = { colour: 'coral', accessory: 'bow_tie', kind: 'mousse' }
const CHEER_MS = 1400
const HOP_MS = 620
const HOP_FRAMES: Keyframe[] = [
  { transform: 'translateY(0) scale(1, 1) rotate(0deg)', easing: 'ease-out' },
  { transform: 'translateY(2px) scale(1.07, 0.92) rotate(0deg)', offset: 0.18, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' },
  { transform: 'translateY(-18px) scale(0.96, 1.05) rotate(-4deg)', offset: 0.48, easing: 'cubic-bezier(0.6, 0, 0.8, 0.4)' },
  { transform: 'translateY(1px) scale(1.05, 0.95) rotate(0deg)', offset: 0.78, easing: 'ease-out' },
  { transform: 'translateY(0) scale(1, 1) rotate(0deg)' },
]

/**
 * The Mousse mascot: the clay Mousse on an accent glow. Its body is one picture and its eyes are
 * flat shapes over it (`HybridFace`), which blink and follow the pointer anywhere in the window. A
 * click makes it hop and cheer for a moment. The float never stops or restarts: the hop runs on its
 * own layer inside it and ends where it began, so the mascot lands back in the float. Clicks during
 * a hop keep the cheer going and let the hop finish. Reduced motion, and a window with no face
 * renderer, show the still pose.
 */
export function Mascot({ size = 96, look = MASCOT_LOOK, className }: { size?: number; look?: BotLook; className?: string }) {
  const [cheering, setCheering] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hopper = useRef<HTMLSpanElement>(null)
  const hop = useRef<Animation | null>(null)
  const renderer = useSyncExternalStore(subscribeSharedFaceRenderer, sharedFaceRendererStatus, () => 'unavailable' as const)
  const moving = useMotionScale() !== 0
  useEffect(() => () => { clearTimeout(timer.current); hop.current?.cancel() }, [])
  const poke = () => {
    clearTimeout(timer.current)
    setCheering(true)
    timer.current = setTimeout(() => setCheering(false), CHEER_MS)
    if (!moving || hop.current?.playState === 'running' || typeof hopper.current?.animate !== 'function') return
    hop.current = hopper.current.animate(HOP_FRAMES, { duration: HOP_MS })
  }
  const state = cheering ? 'happy' : 'idle'
  return <button type="button" className={`mascot${className ? ` ${className}` : ''}`} aria-label="Mousse mascot" onClick={poke}>
    <span className="mascot-body">
      <span ref={hopper} className="mascot-hopper">
        {renderer === 'ready' && moving
          ? <HybridFace look={normalizeBotLook(look)} state={state} size={size} view="full" followPointer />
          : <BotFace look={look} state={state} size={size} view="full" />}
      </span>
    </span>
  </button>
}
