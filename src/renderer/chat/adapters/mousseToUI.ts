import type { ChatMessage } from '../../../shared/types'
import type { UIMessage } from 'ai'
import { isToolTimelineMessage } from '../../../shared/types'
import {
  filterImageAttachmentNames,
  guessMimeTypeFromFilename,
  parseUserMessageContent,
} from '../../utils/messageAttachments'

// Provider (ChatMessage.toolCall) -> standardize (UIMessage parts) -> 21st Agent Elements.
// Canonical adapter. src/renderer/lib/chat/agentAdapter.ts re-exports this file.

function tryParseArgsJson(response?: string): Record<string, unknown> | undefined {
  if (!response) return undefined
  const trimmed = response.trim()
  if (!trimmed.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Result text, not args JSON.
  }
  return undefined
}

function extractServer(details: string[]): string | undefined {
  const raw = details.find((d) => d.startsWith('Server:'))
  const name = raw?.replace('Server:', '').trim().split(/\s+/)[0]
  return name || undefined
}

/** Normalize any provider casing ("read", "read_file", "TodoWrite") to 21st PascalCase. */
export function normalizeToolName(rawName: string | undefined, kind?: string): string {
  const lower = (rawName ?? '').toLowerCase().replace(/[^a-z]/g, '')
  switch (lower) {
    case 'read':
    case 'readfile':
      return 'Read'
    case 'edit':
    case 'notebookedit':
      return 'Edit'
    case 'write':
      return 'Write'
    case 'bash':
    case 'bashoutput':
    case 'killshell':
      return 'Bash'
    case 'grep':
      return 'Grep'
    case 'glob':
    case 'find':
    case 'ls':
    case 'listdir':
      return 'Glob'
    case 'todo':
    case 'todowrite':
      return 'TodoWrite'
    case 'plan':
    case 'planwrite':
    case 'presentplan':
    case 'exitplanmode':
      return rawName === 'ExitPlanMode' ? 'ExitPlanMode' : 'PlanWrite'
    case 'websearch':
      return 'WebSearch'
    case 'webfetch':
      return 'WebFetch'
    case 'skill':
    case 'loadskill':
    case 'listskills':
      return 'Skill'
    case 'agent':
      return 'Agent'
    case 'task':
      return 'Task'
    case 'question':
      return 'Question'
    case 'createquickaction':
      return 'QuickAction'
    case 'thinking':
      return 'Thinking'
    case 'declarefiles':
      return 'Edit'
    case 'cloning':
      return 'cloning'
    default:
      if (!rawName) {
        if (kind === 'mcp_tool_call' || kind === 'mcp_tool_result') return 'Mcp'
        return 'Generic'
      }
      // Preserve already-PascalCase names (Bash, Grep, ...), capitalize first letter otherwise.
      if (/^[A-Z][A-Za-z]*$/.test(rawName)) return rawName
      return rawName.charAt(0).toUpperCase() + rawName.slice(1)
  }
}

function toolState(status?: string, streaming?: boolean): string {
  if (status === 'processing' || streaming) return 'input-available'
  return 'output-available'
}

/**
 * LlmClient marks failed tool results in the summary
 * ("The tool returned an error.", "The MCP tool returned an error.", ...).
 * Summaries are static provider strings (never user content), so matching
 * them is safe and backfills error state for old transcripts too.
 */
function isErrorToolCall(msg: ChatMessage): boolean {
  return /returned an error/i.test(msg.toolCall?.summary ?? '')
}

/**
 * First-class tools with rich agent-elements cards (Bash terminal, Edit diff,
 * Search, Todo, ...). Anything else stays a generic MCP row.
 */
const RICH_TOOL_TYPES = new Set([
  'Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob',
  'TodoWrite', 'PlanWrite', 'ExitPlanMode',
  'WebSearch', 'WebFetch', 'Skill', 'Task', 'Agent',
  'Question', 'Thinking', 'cloning', 'QuickAction',
])

function mcpCustomType(rawName: string | undefined): string {
  const name = (rawName ?? 'tool').replace(/\W+/g, '_').toLowerCase() || 'tool'
  return `tool-mcp__custom__${name}`
}

function fallbackToolName(msg: ChatMessage): string | undefined {
  const detailTool = msg.toolCall?.details.find((d) => d.startsWith('Tool:'))
  const name = detailTool?.replace('Tool:', '').trim().split(/\s+/)[0]
  if (name) return name
  const lower = (msg.toolCall?.title ?? '').toLowerCase()
  if (lower.includes('read')) return 'Read'
  if (lower.includes('edit')) return 'Edit'
  if (lower.includes('write') && !lower.includes('plan')) return 'Write'
  if (lower.includes('bash') || lower.includes('command') || lower.includes('terminal')) return 'Bash'
  if (lower.includes('grep')) return 'Grep'
  if (lower.includes('glob') || lower.includes('exploring files')) return 'Glob'
  if (lower.includes('todo')) return 'TodoWrite'
  if (lower.includes('quickaction') || lower.includes('quick action')) return 'QuickAction'
  if (lower.includes('plan')) return 'PlanWrite'
  if (lower.includes('search') || lower.includes('webfetch') || lower.includes('fetch')) return 'WebSearch'
  if (lower.includes('skill')) return 'Skill'
  if (lower.includes('agent') || lower.includes('spawning')) return 'Agent'
  if (lower.includes('task')) return 'Task'
  return undefined
}

export function mousseToUIMessages(messages: ChatMessage[]): UIMessage[] {
  const out: UIMessage[] = []
  // Last emitted assistant text + whether its source was still streaming.
  // Reset by any non-text push so folds only ever span consecutive rows.
  let lastAssistantText: { text: string; streaming: boolean } | null = null
  for (const msg of messages) {
    if (msg.hidden) continue

    // Skip empty streaming placeholders that have no content yet — agent-elements already
    // shows planning shimmer via status='streaming' + no assistant content. Keeping empty
    // text blocks creates duplicate " " bubbles and breaks grouping.
    if (msg.role === 'assistant' && msg.streaming && !msg.content.trim() && !msg.kind && !msg.toolCall) {
      continue
    }

    const base: UIMessage = {
      id: msg.id,
      role: msg.role as UIMessage['role'],
      parts: [],
      // ai SDK UIMessage expects createdAt? agent-elements uses Date|string, so ISO is fine
      // @ts-ignore - allow string for compat with ai 5
      createdAt: msg.timestamp,
      metadata: msg.responseMetadata ? { ...msg.responseMetadata } : undefined,
    } as unknown as UIMessage

    // Thinking -> tool-Thinking so ThinkingTool renders with shimmer
    if (msg.kind === 'thinking' && msg.thinking) {
      const state = msg.thinking.status === 'processing' ? 'input-available' : 'output-available'
      base.role = 'assistant'
      base.parts = [{
        type: 'tool-Thinking',
        toolCallId: msg.id,
        state,
        input: { thought: msg.thinking.content },
        output: msg.thinking.status === 'complete' ? msg.thinking.content : undefined,
      } as unknown as UIMessage['parts'][number]]
      out.push(base)
      lastAssistantText = null
      continue
    }

    if (msg.kind === 'plan_card' && msg.planCard) {
      // Inline approval card: reuse the agent-elements PlanTool
      // (tool-PlanWrite) so plans render with the same chrome as other tool
      // cards. Preview and implement actions live on the card itself — the
      // sidebar document preview no longer auto-opens.
      const planMarkdown = msg.planCard.planMarkdown?.trim() || msg.content?.trim() || 'No plan generated.'
      const request = msg.planCard.originalRequest?.trim() || 'Implementation plan'
      const title = request.length > 90 ? `${request.slice(0, 87)}…` : request
      base.role = 'assistant'
      base.parts = [{
        type: 'tool-PlanWrite',
        toolCallId: msg.id,
        state: 'output-available',
        input: {
          action: 'create',
          plan: { id: msg.id.slice(0, 8), title, summary: planMarkdown },
        },
        output: planMarkdown,
      } as unknown as UIMessage['parts'][number]]
      out.push(base)
      lastAssistantText = null
      continue
    }

    if (isToolTimelineMessage(msg) && msg.toolCall) {
      // Structured first (provider boundary parses once), legacy string fields as fallback.
      const rawName = msg.toolCall.toolName ?? fallbackToolName(msg)
      const toolName = normalizeToolName(rawName, msg.kind)
      const structuredInput = msg.toolCall.input ?? tryParseArgsJson(msg.toolCall.response)

      let type: string
      if (msg.kind === 'mcp_tool_call' || msg.kind === 'mcp_tool_result') {
        const server = extractServer(msg.toolCall.details)
        if (server) {
          // True MCP tool: Server + Tool details identify it.
          const name = (rawName ?? 'tool').replace(/\W+/g, '_').toLowerCase() || 'tool'
          type = `tool-mcp__${server}__${name}`
        } else if (RICH_TOOL_TYPES.has(toolName)) {
          // Pi/build tools arrive with rewritten mcp kinds but no Server
          // detail — render their rich cards (Bash terminal, Edit diff, ...).
          type = `tool-${toolName}`
        } else {
          type = mcpCustomType(rawName)
        }
      } else if (toolName === 'Mcp') {
        type = 'tool-mcp__custom__tool'
      } else if (toolName === 'Generic') {
        type = 'tool-Generic'
      } else {
        type = `tool-${toolName}`
      }

      // Prefer real args JSON. Only synthesize minimal display input when args were
      // already overwritten by complete-phase result text.
      let input: Record<string, unknown> = structuredInput ? { ...structuredInput } : {}
      if (!structuredInput) {
        if (toolName === 'Bash') {
          // Never synthesize a command from the summary: provider summaries
          // are static sentences, not commands. Unknown stays empty so the
          // card shows a bare Ran/Failed label instead of a fake command.
          const cmd = msg.toolCall.details.find((d) => d.startsWith('Command:'))?.replace('Command:', '').trim() ?? ''
          input = { command: cmd }
        } else if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
          const file = msg.toolCall.details.find((d) => d.startsWith('File:'))?.replace('File:', '').trim()
            ?? (msg.toolCall.summary.match(/[^\s]+\.[a-z]{1,4}/i)?.[0] ?? '')
          input = { file_path: file, ...(toolName === 'Edit' ? { old_string: '', new_string: '' } : {}) }
        } else if (toolName === 'Grep' || toolName === 'Glob' || toolName === 'WebSearch') {
          input = { pattern: msg.toolCall.summary, query: msg.toolCall.summary }
        } else if (toolName === 'TodoWrite') {
          input = { todos: [], action: 'update' }
        } else {
          input = { summary: msg.toolCall.summary, details: msg.toolCall.details }
        }
      }

      // Complete-phase response is result text; start-phase response is args JSON.
      // Never render args JSON as output.
      const isArgsJson = structuredInput && msg.toolCall.status === 'processing'
      const output = isArgsJson ? undefined : msg.toolCall.response

      // MessageList only groups user/assistant turns — system tool messages would vanish.
      base.role = 'assistant'
      base.parts = [{
        type,
        toolCallId: msg.id,
        state: isErrorToolCall(msg) ? 'output-error' : toolState(msg.toolCall.status, msg.streaming),
        input,
        output,
      } as unknown as UIMessage['parts'][number]]
      out.push(base)
      lastAssistantText = null
      continue
    }

    if (msg.kind === 'progress' || msg.kind === 'warning' || msg.kind === 'context_compaction') {
      base.parts = [{ type: 'text', text: msg.content } as unknown as UIMessage['parts'][number]]
      base.role = 'assistant'
      out.push(base)
      lastAssistantText = null
      continue
    }

    // Default user / assistant text.
    // User content carries composer markers ([Attached files: ...], voice,
    // browser blocks) that the model needs but the transcript must not show
    // raw — images already render as previews via msg.images, other files
    // become file pills below.
    const text = msg.content ?? ''
    let displayText = text
    let extraFileNames: string[] = []
    if (msg.role === 'user' && text.includes('[')) {
      try {
        const parsed = parseUserMessageContent(text)
        displayText = parsed.text
        const imageNames = msg.images?.map((i) => i.name).filter(Boolean) ?? []
        extraFileNames = filterImageAttachmentNames(parsed.attachedFiles, imageNames)
      } catch {
        displayText = text
      }
    }
    if (!displayText.trim() && !msg.images?.length && extraFileNames.length === 0) {
      continue
    }
    // Fold exact-duplicate consecutive assistant text (provider double-adds,
    // persisted twins). Both sides must be settled: a streaming partial can
    // legitimately equal its predecessor transiently.
    if (
      msg.role === 'assistant' &&
      !msg.streaming &&
      displayText.trim() &&
      !msg.images?.length &&
      lastAssistantText &&
      !lastAssistantText.streaming &&
      lastAssistantText.text === displayText.trim()
    ) {
      continue
    }
    const parts: UIMessage['parts'] = []
    if (displayText.trim()) parts.push({ type: 'text', text: displayText } as unknown as UIMessage['parts'][number])
    if (msg.images?.length) {
      for (const img of msg.images) {
        parts.push({
          type: 'file',
          mediaType: img.mimeType,
          url: `data:${img.mimeType};base64,${img.data}`,
          filename: img.name,
        } as unknown as UIMessage['parts'][number])
      }
    }
    for (const name of extraFileNames) {
      // Guess a mime type from the extension so the renderer can tell
      // image attachments (data lost — e.g. legacy messages saved without
      // image payloads) from generic files. Image-named files without data
      // render as image-icon chips instead of misleading generic pills.
      const mimeType = guessMimeTypeFromFilename(name)
      parts.push({
        type: 'file',
        filename: name,
        ...(mimeType ? { mediaType: mimeType, mimeType } : {}),
      } as unknown as UIMessage['parts'][number])
    }
    base.parts = parts
    out.push(base)
    // Track for exact-duplicate folding; anything else resets the run.
    lastAssistantText =
      msg.role === 'assistant' && parts.length === 1 && displayText.trim() && !msg.images?.length
        ? { text: displayText.trim(), streaming: !!msg.streaming }
        : null
  }
  return mergeConsecutiveThoughts(out)
}

type ThinkingPartShape = {
  type?: unknown
  toolCallId?: string
  state?: string
  input?: { thought?: unknown }
  output?: unknown
}

function asThinkingPart(msg: UIMessage): ThinkingPartShape | null {
  if (msg.role !== 'assistant' || !msg.parts || msg.parts.length !== 1) return null
  const part = msg.parts[0] as unknown as ThinkingPartShape
  if (!part || part.type !== 'tool-Thinking') return null
  return part
}

function thoughtText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/**
 * Coalesce consecutive Thought rows into one: back-to-back thinking messages
 * (often empty) collapse to a single row, joining non-empty contents.
 * Keeps the earliest id so list keys stay stable.
 */
export function mergeConsecutiveThoughts(messages: UIMessage[]): UIMessage[] {
  const merged: UIMessage[] = []
  for (const msg of messages) {
    const prev = merged[merged.length - 1]
    const prevPart = prev ? asThinkingPart(prev) : null
    const curPart = asThinkingPart(msg)
    if (prev && prevPart && curPart) {
      const thought = [thoughtText(prevPart.input?.thought), thoughtText(curPart.input?.thought)]
        .filter((t) => t.trim())
        .join('\n\n')
      prevPart.input = { ...(prevPart.input as object), thought }
      if (thoughtText(curPart.output).trim() || thoughtText(prevPart.output).trim()) {
        prevPart.output = [thoughtText(prevPart.output), thoughtText(curPart.output)]
          .filter((t) => t.trim())
          .join('\n\n')
      }
      if (curPart.state === 'input-available') prevPart.state = 'input-available'
      continue
    }
    merged.push(msg)
  }
  return merged
}

export function chatStatusFromPhase(phase: string): 'ready' | 'submitted' | 'streaming' | 'error' {
  if (phase === 'queued') return 'submitted'
  if (phase === 'thinking' || phase === 'streaming' || phase === 'tool_running' || phase === 'finalizing') return 'streaming'
  if (phase === 'failed') return 'error'
  return 'ready'
}
