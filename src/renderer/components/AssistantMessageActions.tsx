import { useEffect, useId, useRef, useState } from 'react'
import { Check, Clipboard, GitBranch, Info, RotateCcw, Undo2, X } from 'lucide-react'
import type { ChatMessage } from '../../shared/types'
import type { ThreadAction } from '../../shared/threadActions'
import type { UndoRetentionEligibility } from '../../shared/undoRetention'
import { invalidateThreadActionHistory, readThreadActionHistory } from '../utils/threadActionHistory'
import { useAppStore } from '../stores/appStore'
import { formatResponseTime, formatTokens, formatTokensPerSecond } from '../utils/assistantMessageActions'

interface AssistantMessageActionsProps {
  content: string
  metadata?: ChatMessage['responseMetadata']
  threadId?: string | null
  actionId?: string
  isLatestAction?: boolean
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

export function AssistantMessageActions({ content, metadata, threadId, actionId, isLatestAction }: AssistantMessageActionsProps) {
  const profileId = useAppStore((state) => state.profileId)
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [metadataOpen, setMetadataOpen] = useState(false)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [operationBusy, setOperationBusy] = useState(false)
  const [retention, setRetention] = useState<UndoRetentionEligibility>()
  useEffect(() => {
    setRetention(undefined)
    if (!threadId || !actionId) return
    let current = true
    void readThreadActionHistory(threadId, operationBusy).then((result) => {
      if (current) setRetention((result as { actions: ThreadAction[] }).actions.find((action) => action.id === actionId)?.retention)
    }).catch(() => undefined)
    return () => { current = false }
  }, [profileId, threadId, actionId, operationBusy])
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

  const runActionOperation = async (kind: 'undo' | 'revert' | 'fork' | 'conversation') => {
    if (!threadId || !actionId) return
    setOperationBusy(true); setOperationError(null)
    try {
      const status = await window.mousse.workspace.getStatus(threadId) as { journalGeneration?: number }
      const generation = status.journalGeneration ?? 0
      if (kind === 'undo') await window.mousse.actions.undoLatest(threadId, generation)
      else if (kind === 'revert') await window.mousse.actions.revertCode({ threadId, actionId, expectedJournalGeneration: generation })
      else await window.mousse.actions.fork({ threadId, actionId, expectedJournalGeneration: generation, ...(kind === 'conversation' ? { codeMode: 'current', name: 'Conversation continuation (current code)' } : {}) })
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : String(error))
    } finally {
      invalidateThreadActionHistory(threadId)
      setOperationBusy(false)
    }
  }

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
      {actionId && threadId && (
        <>
          <button type="button" className="assistant-message-action" disabled={operationBusy || !isLatestAction || retention?.state === 'expired' || retention?.state === 'blocked'}
            onClick={() => void runActionOperation('undo')} title={retention?.reason ?? (isLatestAction ? 'Undo latest thread turn' : 'Only the latest turn can rewind conversation')}>
            <Undo2 size={15} aria-hidden="true" />
          </button>
          <button type="button" className="assistant-message-action" disabled={operationBusy || Boolean(isLatestAction) || retention?.state === 'expired' || retention?.state === 'blocked'}
            onClick={() => void runActionOperation('revert')} title={isLatestAction ? 'Use Undo Latest Turn for the latest action' : 'Revert code changes only'}>
            <RotateCcw size={15} aria-hidden="true" />
          </button>
          <button type="button" className="assistant-message-action" disabled={operationBusy || retention?.state === 'expired' || retention?.state === 'blocked'}
            onClick={() => void runActionOperation('fork')} title="Continue from here on an alternate branch">
            <GitBranch size={15} aria-hidden="true" />
          </button>
          {retention?.state === 'expired' && <button type="button" disabled={operationBusy} onClick={() => void runActionOperation('conversation')} title="Continue this conversation using current code; historical code will not be restored">Continue on current code</button>}
          {retention && <span title={retention.reason}>Undo {retention.state}</span>}
        </>
      )}
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
        {copied ? 'Response copied to clipboard.' : copyFailed ? 'Unable to copy response.' : operationError ?? ''}
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
