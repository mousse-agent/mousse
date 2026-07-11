import { useMemo } from 'react'
import {
  highlightToolCallResponse,
  resolveToolCallResponse
} from '../utils/highlightToolCallResponse'
import type { ChatMessage } from '../../shared/types'

interface ToolCallResponseProps {
  toolCall: NonNullable<ChatMessage['toolCall']>
  label?: string
}

export function ToolCallResponse({ toolCall, label }: ToolCallResponseProps) {
  const responseText = resolveToolCallResponse(toolCall)
  const highlighted = useMemo(
    () => (responseText ? highlightToolCallResponse(responseText) : null),
    [responseText]
  )

  if (!highlighted?.html) return null

  return (
    <div className="tool-call-response">
      {label && <div className="tool-call-response-label">{label}</div>}
      <pre>
        <code
          className={`hljs language-${highlighted.language}`}
          dangerouslySetInnerHTML={{ __html: highlighted.html }}
        />
      </pre>
    </div>
  )
}
