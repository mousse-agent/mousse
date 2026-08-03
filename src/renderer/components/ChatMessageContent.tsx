import { memo, useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { ChatImageAttachment, ChatMessage, PlanCardMetadata } from '../../shared/types'
import { isToolTimelineMessage } from '../../shared/types'
import { extractToolCallsFromContent } from '../../shared/toolCallDisplay'
import { resolveToolCallResponse } from '../utils/highlightToolCallResponse'
import { BrowserElementPill } from './BrowserElementPill'
import { FileAttachmentPill } from './FileAttachmentPill'
import { ToolCallResponse } from './ToolCallResponse'
import { filterImageAttachmentNames, parseUserMessageContent } from '../utils/messageAttachments'
import { imagePayloadToDataUrl } from '../utils/imageAttachments'
import { PlanCard } from './PlanCard'
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
  /** Retained for callers that render response controls alongside this body. */
  responseMetadata?: ChatMessage['responseMetadata']
  incomplete?: boolean
}

/** Short thinking updates read better as status text than as a collapsible section. */
export const INLINE_THINKING_WORD_LIMIT = 10

export function shouldRenderThinkingInline(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  return trimmed.split(/\s+/).length <= INLINE_THINKING_WORD_LIMIT
}

/** Resolve plan-card metadata for rendering; fall back to message content when needed. */
export function resolvePlanCard(
  kind: ChatMessage['kind'],
  planCard: PlanCardMetadata | undefined,
  content: string
): PlanCardMetadata | null {
  if (kind !== 'plan_card' && !planCard) return null
  const planMarkdown = (planCard?.planMarkdown ?? '').trim() || content.trim()
  if (!planMarkdown && !planCard) return null
  return {
    originalRequest: planCard?.originalRequest ?? '',
    planMarkdown: planMarkdown || 'No plan generated.'
  }
}

function ChatMessageContentImpl({
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
  incomplete
}: ChatMessageContentProps) {
  const resolvedPlan = resolvePlanCard(kind, planCard, content)
  if (resolvedPlan && (kind === 'plan_card' || planCard)) {
    return (
      <div className="message-body message-body-plan-card">
        <PlanCard
          plan={resolvedPlan}
          onImplementPlan={onImplementPlan}
          loading={implementPlanLoading}
        />
      </div>
    )
  }

  if (kind === 'thinking' && thinking) {
    return <ThinkingBlock thinking={thinking} />
  }

  if (kind === 'context_compaction') {
    return (
      <div className="thinking-body context-compaction-note" role="status">
        <span className="tool-call-label">Context Automatically Compacted</span>
      </div>
    )
  }

  if (groupedToolCalls) {
    return <ToolCallGroupBlock toolCalls={groupedToolCalls} />
  }

  if (isToolTimelineMessage({ kind }) && toolCall) {
    return <ToolCallBlock toolCall={toolCall} />
  }

  if (role !== 'assistant') {
    const { text, attachedFiles, browserElements } = parseUserMessageContent(content)
    const imagePreviews = images ?? []
    // Image payloads already produce a preview pill. The generic attached-file
    // marker is retained for non-image files, but must not render the image a
    // second time (including for messages saved before this fix).
    const otherAttachedFiles = filterImageAttachmentNames(
      attachedFiles,
      imagePreviews.map((image) => image.name)
    )
    const hasAttachments =
      otherAttachedFiles.length > 0 || imagePreviews.length > 0 || browserElements.length > 0

    return (
      <div className="message-body">
        {text && <div className="message-text">{text}</div>}
        {hasAttachments && (
          <div className="message-attachments">
            {imagePreviews.map((img, index) => (
              <FileAttachmentPill
                key={`${img.name}-${index}`}
                name={img.name}
                previewUrl={imagePayloadToDataUrl(img)}
              />
            ))}
            {otherAttachedFiles.map((fileName, index) => (
              <FileAttachmentPill key={`${fileName}-${index}`} name={fileName} />
            ))}
            {browserElements.map((element, index) => (
              <BrowserElementPill
                key={`${element.selector}-${element.tagName}-${index}`}
                element={element}
              />
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

/** Memoized so parent chat re-renders (input, loading, sticky) do not re-parse markdown. */
export const ChatMessageContent = memo(ChatMessageContentImpl)

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

  if (shouldRenderThinkingInline(thinking.content)) {
    return (
      <div
        className={`thinking-body thinking-inline${isProcessing ? ' thinking-inline-processing' : ''}`}
        aria-live={isProcessing ? 'polite' : undefined}
      >
        <div className="chat-markdown thinking-markdown">
          <ThinkingMarkdown content={thinking.content} />
        </div>
      </div>
    )
  }

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

