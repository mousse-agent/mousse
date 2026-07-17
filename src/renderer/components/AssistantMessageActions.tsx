import { useEffect, useId, useRef, useState } from 'react'
import { Check, Clipboard, Info, X } from 'lucide-react'
import type { ChatMessage } from '../../shared/types'
import { formatResponseTime, formatTokens, formatTokensPerSecond } from '../utils/assistantMessageActions'

interface AssistantMessageActionsProps {
  content: string
  metadata?: ChatMessage['responseMetadata']
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('Copy is unavailable')
}

export function AssistantMessageActions({ content, metadata }: AssistantMessageActionsProps) {
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const metadataId = useId()

  useEffect(() => {
    if (!metadataOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMetadataOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMetadataOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [metadataOpen])

  const handleCopy = async () => {
    try {
      await copyText(content)
      setCopied(true)
      setCopyFailed(false)
      window.setTimeout(() => setCopied(false), 2_000)
    } catch {
      setCopyFailed(true)
      window.setTimeout(() => setCopyFailed(false), 3_000)
    }
  }

  return (
    <div className="assistant-message-actions" ref={rootRef}>
      <button
        type="button"
        className="assistant-message-action"
        onClick={() => void handleCopy()}
        aria-label={copied ? 'Response copied' : 'Copy response'}
        title={copied ? 'Copied' : 'Copy response'}
      >
        {copied ? <Check size={15} aria-hidden="true" /> : <Clipboard size={15} aria-hidden="true" />}
      </button>
      <button
        type="button"
        className="assistant-message-action"
        onClick={() => setMetadataOpen((open) => !open)}
        aria-expanded={metadataOpen}
        aria-haspopup="dialog"
        aria-controls={metadataId}
        title="Response metadata"
      >
        <Info size={15} aria-hidden="true" />
      </button>
      <span className="sr-only" aria-live="polite">
        {copied ? 'Response copied to clipboard.' : copyFailed ? 'Unable to copy response.' : ''}
      </span>
      {metadataOpen && (
        <div id={metadataId} className="assistant-response-metadata" role="dialog" aria-label="Response metadata">
          <div className="assistant-response-metadata-header">
            <span>Response metadata</span>
            <button type="button" onClick={() => setMetadataOpen(false)} aria-label="Close response metadata">
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <dl>
            <div><dt>Model</dt><dd>{metadata?.modelName || 'Unavailable'}</dd></div>
            <div><dt>Total response time</dt><dd>{formatResponseTime(metadata?.totalResponseTimeMs)}</dd></div>
            <div><dt>Tokens used</dt><dd>{formatTokens(metadata?.tokensUsed)}</dd></div>
            <div><dt>TPS</dt><dd>{formatTokensPerSecond(metadata?.tokensPerSecond)}</dd></div>
          </dl>
        </div>
      )}
    </div>
  )
}
