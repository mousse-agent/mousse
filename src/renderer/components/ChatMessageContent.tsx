import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatImageAttachment, ChatMessage, PlanCardMetadata } from '../../shared/types'
import { isToolTimelineMessage } from '../../shared/types'
import { extractToolCallsFromContent } from '../../shared/toolCallDisplay'
import { resolveToolCallResponse } from '../utils/highlightToolCallResponse'
import { FileAttachmentPill } from './FileAttachmentPill'
import { ToolCallResponse } from './ToolCallResponse'
import { parseUserMessageContent } from '../utils/messageAttachments'
import { imagePayloadToDataUrl } from '../utils/imageAttachments'
import { PlanCard } from './PlanCard'
import '../styles/chat-markdown.css'

interface ChatMessageContentProps {
  role: ChatMessage['role']
  content: string
  kind?: ChatMessage['kind']
  planCard?: PlanCardMetadata
  toolCall?: ChatMessage['toolCall']
  thinking?: ChatMessage['thinking']
  onImplementPlan?: (plan: PlanCardMetadata) => void
  implementPlanLoading?: boolean
  streaming?: boolean
  images?: ChatImageAttachment[]
}

export function ChatMessageContent({
  role,
  content,
  kind,
  planCard,
  toolCall,
  thinking,
  onImplementPlan,
  implementPlanLoading,
  streaming,
  images
}: ChatMessageContentProps) {
  if (kind === 'plan_card' && planCard) {
    return (
      <PlanCard
        plan={planCard}
        onImplementPlan={onImplementPlan}
        loading={implementPlanLoading}
      />
    )
  }

  if (kind === 'thinking' && thinking) {
    return <ThinkingBlock thinking={thinking} />
  }

  if (isToolTimelineMessage({ kind }) && toolCall) {
    return <ToolCallBlock toolCall={toolCall} />
  }

  if (role !== 'assistant') {
    const { text, attachedFiles } = parseUserMessageContent(content)
    const imagePreviews = images ?? []

    return (
      <div className="message-body">
        {text && <div className="message-text">{text}</div>}
        {(attachedFiles.length > 0 || imagePreviews.length > 0) && (
          <div className="message-attachments">
            {imagePreviews.map((img, index) => (
              <FileAttachmentPill
                key={`${img.name}-${index}`}
                name={img.name}
                previewUrl={imagePayloadToDataUrl(img)}
              />
            ))}
            {attachedFiles.map((fileName) => (
              <FileAttachmentPill key={fileName} name={fileName} />
            ))}
          </div>
        )}
      </div>
    )
  }

  const { visibleContent, toolCalls } = extractToolCallsFromContent(content)

  if (streaming) {
    return (
      <div className="message-body">
        <div className="message-text message-streaming">{content || '\u00a0'}</div>
      </div>
    )
  }

  return (
    <div className="message-body chat-markdown">
      {visibleContent && (
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            a: ({ href, children }) => (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            )
          }}
        >
          {visibleContent}
        </ReactMarkdown>
      )}
      {toolCalls.map((display, index) => (
        <ToolCallBlock key={`${display.title}-${index}`} toolCall={display} />
      ))}
    </div>
  )
}

function ThinkingBlock({ thinking }: { thinking: NonNullable<ChatMessage['thinking']> }) {
  const [expanded, setExpanded] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const isProcessing = thinking.status === 'processing'

  useEffect(() => {
    if (!isProcessing) return
    const container = scrollRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [thinking.content, isProcessing])

  if (isProcessing) {
    return (
      <div className="thinking-body">
        <div className="thinking-box">
          <div className="thinking-heading shimmer-text">Thinking</div>
          <div className="thinking-scroll" ref={scrollRef} aria-live="polite">
            <pre>{thinking.content || '\u00a0'}</pre>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="thinking-body">
      <button
        type="button"
        className="tool-call-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="tool-call-caret" aria-hidden="true">
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2} />
          ) : (
            <ChevronRight size={14} strokeWidth={2} />
          )}
        </span>
        <span className="tool-call-label">Thinking</span>
      </button>
      {expanded && (
        <div className="tool-call-details">
          <pre className="thinking-content">{thinking.content}</pre>
        </div>
      )}
    </div>
  )
}

function ToolCallBlock({ toolCall }: { toolCall: NonNullable<ChatMessage['toolCall']> }) {
  const [expanded, setExpanded] = useState(false)
  const isProcessing = toolCall.status === 'processing'
  const responseText = resolveToolCallResponse(toolCall)
  const metadataDetails = responseText
    ? toolCall.details.filter((detail) => !detail.startsWith('Arguments:'))
    : toolCall.details

  return (
    <div className="tool-call-body">
      <button
        type="button"
        className="tool-call-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="tool-call-caret" aria-hidden="true">
          {expanded ? (
            <ChevronDown size={14} strokeWidth={2} />
          ) : (
            <ChevronRight size={14} strokeWidth={2} />
          )}
        </span>
        <span className={isProcessing ? 'shimmer-text' : 'tool-call-label'}>{toolCall.title}</span>
      </button>
      {expanded && (
        <div className="tool-call-details">
          <p>{toolCall.summary}</p>
          {metadataDetails.length > 0 && (
            <ul>
              {metadataDetails.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          <ToolCallResponse
            toolCall={toolCall}
            label={isProcessing ? 'Arguments' : 'Response'}
          />
        </div>
      )}
    </div>
  )
}

