import { useEffect, useRef, type KeyboardEvent } from 'react'
import { ChevronLeft, ChevronRight } from '../lib/icons'
import type { AudioLevels } from './audioLevels'
import { voiceOrb } from './voiceOrbs'

export interface VoiceOption {
  id: string
  name: string
  /** Accent and voice, e.g. "American female"; empty when the provider does not say. */
  detail: string
  /** Place in a local model's catalog, which picks the voice's own orb. */
  index?: number
}

interface VoiceCarouselProps {
  voices: readonly VoiceOption[]
  value: string | undefined
  onSelect: (voiceId: string) => void
  label: string
  /** Loudness of the sample that is playing; the chosen orb swells with it. */
  levels?: AudioLevels | null
}

/** A row of glass orbs, one per voice, that scrolls sideways. */
export function VoiceCarousel({ voices, value, onSelect, label, levels }: VoiceCarouselProps) {
  const trackRef = useRef<HTMLDivElement>(null)
  const selectedOrbRef = useRef<HTMLImageElement | null>(null)

  // Keep the chosen voice in view, including when it changes from the keyboard.
  useEffect(() => {
    const track = trackRef.current
    const selected = track?.querySelector<HTMLElement>('[aria-checked="true"]')
    if (!track || !selected) return
    const left = selected.offsetLeft - (track.clientWidth - selected.offsetWidth) / 2
    track.scrollTo({ left, behavior: 'smooth' })
  }, [value])

  useEffect(() => {
    const orb = selectedOrbRef.current
    if (!orb || !levels) return
    let frame = requestAnimationFrame(function tick() {
      const values = levels()
      const loudness = values.reduce((sum, level) => sum + level, 0) / Math.max(1, values.length)
      orb.style.transform = `scale(${1 + 0.14 * loudness})`
      frame = requestAnimationFrame(tick)
    })
    return () => {
      cancelAnimationFrame(frame)
      orb.style.transform = ''
    }
  }, [levels, value])

  const scrollBy = (direction: number): void => {
    const track = trackRef.current
    track?.scrollBy({ left: direction * track.clientWidth * 0.8, behavior: 'smooth' })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (!step || voices.length === 0) return
    event.preventDefault()
    const current = voices.findIndex((voice) => voice.id === value)
    const next = voices[(current + step + voices.length) % voices.length]
    onSelect(next.id)
    trackRef.current?.querySelector<HTMLElement>(`[data-voice="${CSS.escape(next.id)}"]`)?.focus()
  }

  return (
    <div className="voice-carousel">
      <button
        type="button"
        className="voice-carousel-arrow"
        aria-label="Previous voices"
        onClick={() => scrollBy(-1)}
      >
        <ChevronLeft size={14} strokeWidth={2} aria-hidden="true" />
      </button>
      <div
        ref={trackRef}
        className="voice-carousel-track"
        role="radiogroup"
        aria-label={label}
        onKeyDown={onKeyDown}
      >
        {voices.map((voice) => {
          const selected = voice.id === value
          const orb = voiceOrb(voice.id, voice.index)
          return (
            <button
              key={voice.id}
              type="button"
              role="radio"
              aria-checked={selected}
              tabIndex={selected || (value === undefined && voice === voices[0]) ? 0 : -1}
              data-voice={voice.id}
              className={`voice-card${selected ? ' selected' : ''}`}
              title={voice.detail ? `${voice.name}, ${voice.detail}` : voice.name}
              onClick={() => onSelect(voice.id)}
            >
              <span className="voice-card-orb">
                {orb && (
                  <img
                    ref={selected ? selectedOrbRef : undefined}
                    src={orb}
                    alt=""
                    draggable={false}
                    loading="lazy"
                  />
                )}
              </span>
              <span className="voice-card-name">{voice.name}</span>
              {voice.detail && <span className="voice-card-detail">{voice.detail}</span>}
            </button>
          )
        })}
      </div>
      <button
        type="button"
        className="voice-carousel-arrow"
        aria-label="Next voices"
        onClick={() => scrollBy(1)}
      >
        <ChevronRight size={14} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  )
}
