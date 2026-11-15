import { useEffect, useRef, useState } from 'react'
import { useMotionScale } from '../lib/motion'
import type { AudioLevels } from './audioLevels'
import '../styles/speech.css'

/** A new bar every SAMPLE_MS; the wave moves one bar to the left per sample. */
export const SAMPLE_MS = 50
/** With motion off the bars stay in place and change height this often. */
export const STILL_SAMPLE_MS = 250
/** Width of one bar plus its gap, in px; matches `.speech-history-bar` in speech.css. */
const PITCH = 5
/** Height of a bar at silence, as a share of the full height. */
const REST = 0.12
/** Bars kept; enough for a 2000px wide wave. */
export const HISTORY_SIZE = 400
/** Bars drawn until the wave's width is known. */
const DEFAULT_BARS = 96

/** One loudness for the moment: the loudest band, so a voice in any pitch shows. */
export function loudness(levels: readonly number[]): number {
  let loudest = 0
  for (const level of levels) if (level > loudest) loudest = level
  return Math.min(1, loudest)
}

/** The last `size` loudness values. Silence until filled. */
export function createLevelHistory(size: number) {
  const values = new Float32Array(size)
  let next = 0
  return {
    push(value: number): void {
      values[next] = value
      next = (next + 1) % size
    },
    /** The value `age` samples ago; 0 is the newest. */
    at(age: number): number {
      return age >= size ? 0 : values[(next - 1 - age + size) % size]!
    }
  }
}

/** The still wave's shape: a hump with some ripple, so it reads as sound rather than a bar chart. */
function stillShape(index: number, bars: number): number {
  const hump = Math.sin((Math.PI * (index + 0.5)) / bars)
  const ripple = 0.75 + 0.25 * Math.sin(index * 1.7) * Math.cos(index * 0.6)
  return hump * ripple
}

/**
 * The composer's recording wave: the loudness of the last few seconds, newest on the right, scrolling
 * smoothly to the left. With motion off (Animation speed Off or the OS setting) it does not scroll: the
 * bars keep one shape and rise and fall with the voice a few times a second.
 */
export function SpeechHistoryWave({ levels, className }: { levels: AudioLevels | null; className?: string }) {
  const still = useMotionScale() === 0
  const boxRef = useRef<HTMLSpanElement>(null)
  const stripRef = useRef<HTMLSpanElement>(null)
  const barsRef = useRef<(HTMLSpanElement | null)[]>([])
  const historyRef = useRef(createLevelHistory(HISTORY_SIZE))
  const [bars, setBars] = useState(DEFAULT_BARS)

  // As many bars as fill the width, plus the one sliding in at the right.
  useEffect(() => {
    const box = boxRef.current
    if (!box || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const width = box.clientWidth
      if (width > 0) setBars(Math.min(HISTORY_SIZE, Math.ceil(width / PITCH) + 1))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const nodes = barsRef.current
    const strip = stripRef.current
    const history = historyRef.current
    const setBar = (index: number, value: number) => {
      const node = nodes[index]
      if (node) node.style.transform = `scaleY(${(REST + (1 - REST) * value).toFixed(3)})`
    }
    const drawHistory = () => {
      for (let index = 0; index < bars; index += 1) setBar(index, history.at(bars - 1 - index))
    }
    const drawStill = (level: number) => {
      for (let index = 0; index < bars; index += 1) setBar(index, level * stillShape(index, bars))
    }
    if (strip) strip.style.transform = ''
    if (still) drawStill(0)
    else drawHistory()
    if (!levels) return

    let last = performance.now()
    /** The loudest moment since the still bars last changed, so a short quiet gap does not flatten them. */
    let peak = 0
    let frame = requestAnimationFrame(function tick(now) {
      if (still) {
        peak = Math.max(peak, loudness(levels()))
        if (now - last >= STILL_SAMPLE_MS) {
          last = now
          drawStill(peak)
          peak = 0
        }
      } else {
        const due = Math.floor((now - last) / SAMPLE_MS)
        if (due > 0) {
          // After a slow frame the missed samples repeat the current level, so the scroll keeps its pace.
          const value = loudness(levels())
          for (let step = 0; step < Math.min(due, bars); step += 1) history.push(value)
          last += due * SAMPLE_MS
          drawHistory()
        }
        // The newest bar starts one bar beyond the right edge and slides in until the next sample.
        const phase = Math.min(1, (now - last) / SAMPLE_MS)
        if (strip) strip.style.transform = `translateX(${((1 - phase) * PITCH).toFixed(2)}px)`
      }
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [levels, bars, still])

  return (
    <span ref={boxRef} className={`speech-history-wave${still ? ' still' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      <span ref={stripRef} className="speech-history-strip">
        {Array.from({ length: bars }, (_, index) => (
          <span
            key={index}
            ref={(node) => {
              barsRef.current[index] = node
            }}
            className="speech-history-bar"
          />
        ))}
      </span>
    </span>
  )
}
