import { useEffect, useRef } from 'react'
import { WAVE_BARS, type AudioLevels } from './audioLevels'
import '../styles/speech.css'

/** Height of a bar at silence, as a share of the full height. */
const REST = 0.2

/**
 * A small sound wave whose bars follow the live audio from `levels`. It lies flat while there is
 * no audio yet, and holds its last shape while `paused`.
 */
export function SpeechWave({ levels, paused = false, className }: { levels?: AudioLevels | null; paused?: boolean; className?: string }) {
  const barsRef = useRef<(HTMLSpanElement | null)[]>([])

  useEffect(() => {
    const bars = barsRef.current
    const draw = (values: readonly number[]): void => {
      bars.forEach((bar, index) => {
        if (bar) bar.style.transform = `scaleY(${REST + (1 - REST) * (values[index] ?? 0)})`
      })
    }
    if (!levels) {
      draw([])
      return
    }
    if (paused) return
    let frame = requestAnimationFrame(function tick() {
      draw(levels())
      frame = requestAnimationFrame(tick)
    })
    return () => cancelAnimationFrame(frame)
  }, [levels, paused])

  return (
    <span className={`speech-wave${paused ? ' paused' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {Array.from({ length: WAVE_BARS }, (_, index) => (
        <span
          key={index}
          ref={(node) => {
            barsRef.current[index] = node
          }}
          className="speech-wave-bar"
        />
      ))}
    </span>
  )
}
