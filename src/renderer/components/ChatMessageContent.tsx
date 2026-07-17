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
import { AssistantMessageActions } from './AssistantMessageActions'
import { canShowAssistantMessageActions } from '../utils/assistantMessageActions'
import '../styles/chat-markdown.css'

interface ChatMessageContentProps {
  role: ChatMessage['role']
  content: string
  kind?: ChatMessage['kind']
  planCard?: PlanCardMetadata
  toolCall?: ChatMessage['toolCall']
  toolCalls?: NonNullable<ChatMessage['toolCall']>[]
  thinking?: ChatMessage['thinking']
  onImplementPlan?: (plan: PlanCardMetadata) => void
  implementPlanLoading?: boolean
  streaming?: boolean
  images?: ChatImageAttachment[]
  responseMetadata?: ChatMessage['responseMetadata']
  incomplete?: boolean
  /** The timeline decides which single assistant reply is the final response. */
  showResponseActions?: boolean
}

export function ChatMessageContent({
  role,
  content,
  kind,
  planCard,
  toolCall,
  toolCalls: groupedToolCalls,
  thinking,
  onImplementPlan,
  implementPlanLoading,
  streaming,
  images,
  responseMetadata,
  incomplete,
  showResponseActions = false
}: ChatMessageContentProps) {
  if (kind === 'plan_card' && planCard) {
    return (
      <div className="message-body">
        <PlanCard
          plan={planCard}
          onImplementPlan={onImplementPlan}
          loading={implementPlanLoading}
        />
        {showResponseActions && canShowAssistantMessageActions({ role, kind, streaming, incomplete }) && (
          <AssistantMessageActions content={planCard.planMarkdown} metadata={responseMetadata} />
        )}
      </div>
    )
  }

  if (kind === 'thinking' && thinking) {
    return <ThinkingBlock thinking={thinking} />
  }

  if (groupedToolCalls) {
    return <ToolCallGroupBlock toolCalls={groupedToolCalls} />
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
      {showResponseActions && canShowAssistantMessageActions({ role, kind, streaming, incomplete }) && (
        <AssistantMessageActions content={visibleContent} metadata={responseMetadata} />
      )}
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
          <div className="thinking-scroll chat-markdown thinking-markdown" ref={scrollRef} aria-live="polite">
            <ThinkingMarkdown content={thinking.content} />
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
        <div className="tool-call-details chat-markdown thinking-markdown">
          <ThinkingMarkdown content={thinking.content} />
        </div>
      )}
    </div>
  )
}

export function ThinkingMarkdown({ content }: { content: string }) {
  if (!content) return '\u00a0'

  return (
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
      {content}
    </ReactMarkdown>
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

function ToolCallGroupBlock({ toolCalls }: { toolCalls: NonNullable<ChatMessage['toolCall']>[] }) {
  const [expanded, setExpanded] = useState(false)

  if (toolCalls.length === 1) {
    return <ToolCallBlock toolCall={toolCalls[0]} />
  }

  return (
    <div className="tool-call-body tool-call-group">
      <button
        type="button"
        className="tool-call-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
      >
        <span className="tool-call-caret" aria-hidden="true">
          {expanded ? <ChevronDown size={14} strokeWidth={2} /> : <ChevronRight size={14} strokeWidth={2} />}
        </span>
        <span className="tool-call-label">Used Tools ({toolCalls.length})</span>
      </button>
      {expanded && (
        <div className="tool-call-details tool-call-group-details">
          {toolCalls.map((toolCall, index) => (
            <ToolCallBlock key={`${toolCall.title}-${index}`} toolCall={toolCall} />
          ))}
        </div>
      )}
    </div>
  )
}

