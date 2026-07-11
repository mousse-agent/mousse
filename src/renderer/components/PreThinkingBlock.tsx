import { useEffect, useState } from 'react'

const PRE_THINKING_PHRASES = [
  'Stirring',
  'Sweetening',
  'Chocolating',
  'Icing',
  'Garnishing',
  'Whisking',
  'Folding',
  'Setting'
] as const

const PHRASE_INTERVAL_MS = 2200

export function PreThinkingBlock() {
  const [phraseIndex, setPhraseIndex] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => {
      setPhraseIndex((current) => (current + 1) % PRE_THINKING_PHRASES.length)
    }, PHRASE_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [])

  const phrase = PRE_THINKING_PHRASES[phraseIndex]

  return (
    <div className="thinking-body">
      <div className="thinking-box pre-thinking-box">
        <div key={phrase} className="thinking-heading shimmer-text pre-thinking-phrase">
          {phrase}
        </div>
      </div>
    </div>
  )
}
