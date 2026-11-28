/** The crescent drawn over a face whose bot's computer is away, in a 24-unit box. */
export const BOT_FACE_MOON_PATH = 'M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'

/** The mark over a sleeping live face: its z, or the moon of a bot whose computer is away (`face.css`). */
export function BotFaceSleepMark({ size, away }: { size: number; away?: boolean }) {
  if (away) {
    const side = Math.max(8, Math.round(size * 0.24))
    return (
      <svg className="bot-face-moon" width={side} height={side} viewBox="0 0 24 24" aria-hidden>
        <path d={BOT_FACE_MOON_PATH} fill="currentColor" />
      </svg>
    )
  }
  return (
    <span className="bot-face-z" style={{ fontSize: Math.max(8, Math.round(size * 0.18)) }} aria-hidden>
      z
    </span>
  )
}
