import '../styles/speech.css'

const BARS = 4

/** A small animated sound wave for audio that is playing or recording. It holds still when paused. */
export function SpeechWave({ paused = false, className }: { paused?: boolean; className?: string }) {
  return (
    <span className={`speech-wave${paused ? ' paused' : ''}${className ? ` ${className}` : ''}`} aria-hidden="true">
      {Array.from({ length: BARS }, (_, index) => (
        <span key={index} className="speech-wave-bar" />
      ))}
    </span>
  )
}
