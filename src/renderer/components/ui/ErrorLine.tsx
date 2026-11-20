import { useEffect, useState } from 'react'
import { splitErrorReference } from '../../lib/errorText'

const COPIED_MS = 1500

/**
 * A failure under a form or a settings row. A generic failure's "Reference: <id>" moves to the tooltip, and Copy
 * copies the whole message with its reference, to paste into a report or a chat; the reference finds its cause in
 * the app's logs.
 */
export function ErrorLine({ message, className = 'chat-error' }: { message: string; className?: string }) {
  const { text, reference } = splitErrorReference(message)
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  useEffect(() => {
    if (state !== 'copied') return
    const timer = setTimeout(() => setState('idle'), COPIED_MS)
    return () => clearTimeout(timer)
  }, [state])
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error('No clipboard')
      await navigator.clipboard.writeText(message)
      setState('copied')
    } catch {
      setState('failed')
    }
  }
  return (
    <p role="alert" className={className}>
      <span title={reference ? `Reference ${reference}` : undefined}>{text}</span>
      {reference && (
        <button type="button" className="error-line-copy" aria-label="Copy error" title={`Copy the error and its reference ${reference}`} onClick={() => void copy()}>
          {state === 'copied' ? 'Copied' : state === 'failed' ? 'Couldn’t copy' : 'Copy'}
        </button>
      )}
    </p>
  )
}
