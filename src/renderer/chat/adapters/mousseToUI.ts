import { streamingAppletPresentation } from '../../components/applets/streamPresentation'
import type { ChatMessage } from '../../../shared/types'
import type { UIMessage } from 'ai'
import { isToolTimelineMessage } from '../../../shared/types'
import {
  filterImageAttachmentNames,
  guessMimeTypeFromFilename,
  parseUserMessageContent,
} from '../../utils/messageAttachments'
import { commandLabel, normalizeToolName, type AgentActivityItem } from '../../../shared/agentActivity'
import { subagentToolOfRecord } from '../../../shared/subagentTools'

// Provider (ChatMessage.toolCall) -> standardize (UIMessage parts) -> 21st Agent Elements.

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

// Moved to the shared activity module; re-exported for in-flight branches.
export { normalizeToolName }

function toolState(status?: string, streaming?: boolean): string {
  if (status === 'processing' || streaming) return 'input-available'
  return 'output-available'
}

/** The part state of a typed item: running calls are in flight, failed ones show their error. */
function activityState(status: AgentActivityItem['status']): string {
  if (status === 'failed') return 'output-error'
  return status === 'running' ? 'input-available' : 'output-available'
}

/**
 * LlmClient marks failed tool results in the summary
 * ("The tool returned an error.", "The MCP tool returned an error.", ...).
 * Summaries are static provider strings (never user content), so matching
 * them is safe and backfills error state for old transcripts too. A row with a typed
 * item says so itself.
 */
function isErrorToolCall(msg: ChatMessage): boolean {
  if (msg.activity) return msg.activity.status === 'failed'
  return /returned an error/i.test(msg.toolCall?.summary ?? '')
}

type PartShape = { type: string; input: Record<string, unknown>; output: unknown }

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)) as T
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** An interrupted item says so in its output, whatever the card, so every reader can tell it did not finish. */
function withInterruption(activity: AgentActivityItem, output: unknown): unknown {
  if (activity.status !== 'interrupted') return output
  const base = isRecordValue(output) ? output : output === undefined ? {} : { text: output }
  return compact({ ...base, interrupted: true, summary: activity.summary })
}

function urlHost(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

function planTitle(text: string | undefined): string {
  const heading = text?.split('\n').find((line) => /^#{1,6}\s+\S/.test(line))?.replace(/^#{1,6}\s+/, '').trim()
  return heading && heading.length > 0 ? (heading.length > 90 ? `${heading.slice(0, 87)}…` : heading) : 'Implementation plan'
}

/** The card a typed item draws as, with the input and output that card reads; undefined for a generic or unknown kind. */
function activityPart(msg: ChatMessage, activity: AgentActivityItem): PartShape | undefined {
  const running = activity.status === 'running'
  switch (activity.kind) {
    case 'command': {
      const output = running
        ? activity.output
          ? compact({ stdout: activity.output, truncated: activity.outputTruncated, bytes: activity.outputBytes })
          : undefined
        : compact({
            stdout: activity.output ?? '',
            exitCode: activity.exitCode,
            durationMs: activity.durationMs,
            truncated: activity.outputTruncated,
            bytes: activity.outputBytes,
            interrupted: activity.status === 'interrupted' ? true : undefined,
            summary: activity.summary,
          })
      return {
        type: 'tool-Bash',
        input: compact({ command: activity.command, cwd: activity.cwd, label: commandLabel(activity.command) }),
        output,
      }
    }
    case 'file_change': {
      const isWrite = activity.changes.length > 0 && activity.changes.every((change) => change.change === 'add')
      return {
        type: isWrite ? 'tool-Write' : 'tool-Edit',
        input: compact({ file_path: activity.changes[0]?.path }),
        output: withInterruption(activity, { changes: activity.changes }),
      }
    }
    case 'search': {
      const isCode = activity.scope === 'code'
      const output = running
        ? undefined
        : compact({ numFiles: activity.resultCount, text: activity.output })
      return {
        type: isCode ? 'tool-Grep' : 'tool-Glob',
        input: compact({ pattern: activity.query, query: activity.query, path: activity.path }),
        output: withInterruption(activity, Object.keys(output ?? {}).length > 0 ? output : undefined),
      }
    }
    case 'web_search': {
      // The search card lists `{ source, title, date }`; a saved result has a title and a url, so the
      // host stands in for the date column.
      const results = activity.results?.map((result) => ({
        source: 'google',
        title: result.title,
        date: urlHost(result.url),
      }))
      return {
        type: 'tool-WebSearch',
        input: { query: activity.query },
        output: withInterruption(activity, running || !results?.length ? undefined : { results }),
      }
    }
    case 'todo':
      return {
        type: 'tool-TodoWrite',
        input: { todos: activity.items, action: 'update' },
        output: withInterruption(activity, undefined),
      }
    case 'plan': {
      const summary =
        activity.text ?? activity.steps?.map((step) => `- [${step.status === 'completed' ? 'x' : ' '}] ${step.step}`).join('\n') ?? ''
      return {
        type: 'tool-PlanWrite',
        input: { action: 'create', plan: { id: msg.id.slice(0, 8), title: planTitle(activity.text), summary } },
        output: running ? undefined : withInterruption(activity, summary || undefined),
      }
    }
    case 'subagent': {
      const isTask = normalizeToolName(activity.toolName) === 'Task'
      return {
        type: isTask ? 'tool-Task' : 'tool-Agent',
        input: compact({ subagent_type: activity.agentType, description: activity.description }),
        output: running
          ? undefined
          : withInterruption(activity, compact({ totalDurationMs: activity.durationMs, summary: activity.summary })),
      }
    }
    default:
      // `generic`, and a kind a newer app wrote that this one does not know.
      return undefined
  }
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

/** The root subagent message an item with this parent nests under, found by walking up the parents. */
function nestingRoot(
  parentId: string | undefined,
  parentOf: ReadonlyMap<string, string | undefined>,
  subagentRoots: ReadonlyMap<string, UIMessage>
): UIMessage | undefined {
  let current = parentId
  for (let depth = 0; current && depth < 32; depth += 1) {
    const root = subagentRoots.get(current)
    if (root) return root
    current = parentOf.get(current)
  }
  return undefined
}

/** The tool part of a timeline tool row. */
function toolPart(msg: ChatMessage, toolCallId: string): Record<string, unknown> {
  const toolCall = msg.toolCall!
  const activity = msg.activity

  // A typed item names its card; a generic or unknown kind goes the way an untyped row does.
  const typed = activity ? activityPart(msg, activity) : undefined
  // Mousse's own subagent tools get one row type whatever runtime called them; whether a row
  // becomes a card is decided where the subagent list is known (the renderer shell).
  const subagentTool = subagentToolOfRecord({
    toolName: toolCall.toolName,
    title: toolCall.title,
    summary: toolCall.summary,
    details: toolCall.details,
  })
  if (typed && !subagentTool) {
    return {
      type: typed.type,
      toolCallId,
      state: activity!.status === 'failed' ? 'output-error' : activityState(activity!.status),
      input: typed.input,
      output: typed.output,
    }
  }

  // Structured first (provider boundary parses once), legacy string fields as fallback.
  const genericItem = activity?.kind === 'generic' ? activity : undefined
  const rawName = toolCall.toolName ?? fallbackToolName(msg)
  const toolName = normalizeToolName(rawName, msg.kind)
  const structuredInput = toolCall.input ?? genericItem?.input ?? tryParseArgsJson(toolCall.response)

  let type: string
  if (subagentTool) {
    type = 'tool-Subagent'
  } else if (msg.kind === 'mcp_tool_call' || msg.kind === 'mcp_tool_result') {
    const server = extractServer(toolCall.details)
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
  if (!structuredInput && !subagentTool) {
    if (toolName === 'Bash') {
      // Never synthesize a command from the summary: provider summaries
      // are static sentences, not commands. Unknown stays empty so the
      // card shows a bare Ran/Failed label instead of a fake command.
      const cmd = toolCall.details.find((d) => d.startsWith('Command:'))?.replace('Command:', '').trim() ?? ''
      input = { command: cmd }
    } else if (toolName === 'Read' || toolName === 'Edit' || toolName === 'Write') {
      const file = toolCall.details.find((d) => d.startsWith('File:'))?.replace('File:', '').trim()
        ?? (toolCall.summary.match(/[^\s]+\.[a-z]{1,4}/i)?.[0] ?? '')
      input = { file_path: file, ...(toolName === 'Edit' ? { old_string: '', new_string: '' } : {}) }
    } else if (toolName === 'Grep' || toolName === 'Glob' || toolName === 'WebSearch') {
      input = { pattern: toolCall.summary, query: toolCall.summary }
    } else if (toolName === 'TodoWrite') {
      input = { todos: [], action: 'update' }
    } else {
      input = { summary: toolCall.summary, details: toolCall.details }
    }
  }

  let output: unknown
  let state: string
  if (activity) {
    // The item holds the result text; a running call has none yet.
    const text = (activity as { output?: unknown }).output
    output = activity.status === 'running' ? undefined : withInterruption(activity, typeof text === 'string' ? text : undefined)
    state = isErrorToolCall(msg) ? 'output-error' : activityState(activity.status)
  } else {
    // Complete-phase response is result text; start-phase response is args JSON.
    // Never render args JSON as output.
    const isArgsJson = structuredInput && toolCall.status === 'processing'
    output = isArgsJson ? undefined : toolCall.response
    state = isErrorToolCall(msg) ? 'output-error' : toolState(toolCall.status, msg.streaming)
  }

  return {
    type,
    toolCallId,
    state,
    input,
    output,
    ...(subagentTool ? { subagentTool } : {}),
  }
}

export function mousseToUIMessages(messages: ChatMessage[]): UIMessage[] {
  const out: UIMessage[] = []
  // Typed items: each item's parent, and the message a subagent's nested work belongs to.
  const parentOf = new Map<string, string | undefined>()
  const subagentRoots = new Map<string, UIMessage>()
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
      // The turn a user message started, for the row that opens that turn in Review.
      ...(msg.turnId ? { turnId: msg.turnId } : {}),
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
      const planMarkdown = msg.presentationParts ? msg.presentationParts.filter(part => part.type === 'text').map(part => part.text).join('\n').trim() || 'Interactive plan' : msg.planCard.planMarkdown?.trim() || msg.content?.trim() || 'No plan generated.'
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
      if (!msg.streaming && !msg.incomplete) for (const part of msg.presentationParts ?? []) {
        if (part.type === 'applet') base.parts.push({type:'data-applet',data:part.reference} as unknown as UIMessage['parts'][number])
      }
      out.push(base)
      lastAssistantText = null
      continue
    }

    if (isToolTimelineMessage(msg) && msg.toolCall) {
      const activity = msg.activity
      const part = toolPart(msg, msg.id)
      lastAssistantText = null

      // Work a subagent started renders under its row: the part joins the root subagent's message
      // with the `<parent>:<child>` id the tool group looks for (ids are UUIDs, so the first colon splits them).
      if (activity) {
        parentOf.set(msg.id, activity.parentId)
        const root = nestingRoot(activity.parentId, parentOf, subagentRoots)
        if (root) {
          part.toolCallId = `${root.id}:${msg.id}`
          root.parts.push(part as unknown as UIMessage['parts'][number])
          if (activity.kind === 'subagent') subagentRoots.set(msg.id, root)
          continue
        }
      }

      // MessageList only groups user/assistant turns — system tool messages would vanish.
      base.role = 'assistant'
      base.parts = [part as unknown as UIMessage['parts'][number]]
      out.push(base)
      if (activity?.kind === 'subagent') subagentRoots.set(msg.id, base)
      continue
    }

    if (msg.kind === 'context_handoff' && msg.contextHandoff) {
      base.metadata = { ...base.metadata as object, contextHandoff: msg.contextHandoff }
      base.parts = [{ type: 'text', text: msg.content } as unknown as UIMessage['parts'][number]]
      base.role = 'assistant'
      out.push(base)
      lastAssistantText = null
      continue
    }

    if (msg.kind === 'progress' || msg.kind === 'warning' || msg.kind === 'context_compaction') {
      if (msg.kind === 'context_compaction') base.metadata = { ...base.metadata as object, compaction: true, compacting: msg.streaming === true }
      base.parts = [{ type: 'text', text: msg.content } as unknown as UIMessage['parts'][number]]
      base.role = 'assistant'
      out.push(base)
      lastAssistantText = null
      continue
    }

    if (msg.role === 'assistant' && msg.streaming) {
      const pending = streamingAppletPresentation(msg.content)
      if (pending.some(part => part.type === 'data-applet-pending')) {
        base.parts = pending as UIMessage['parts']
        out.push(base)
        lastAssistantText = null
        continue
      }
    }

    // Only durable, completed assistant references become executable presentation.
    if (msg.role === 'assistant' && !msg.streaming && !msg.incomplete && msg.presentationParts?.length) {
      base.parts = msg.presentationParts.map(part => part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'data-applet', data: part.reference }) as UIMessage['parts']
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
    let displayText = msg.role === 'assistant' ? text.replace(/(?:[ \t]*\r?\n)*[ \t]*\(Stopped\)\s*$/u, '') : text
    let extraFileNames: string[] = []
    let references: ReturnType<typeof parseUserMessageContent>['references'] = []
    if (msg.role === 'user' && text.includes('[')) {
      try {
        const parsed = parseUserMessageContent(text)
        displayText = parsed.text
        const imageNames = msg.images?.map((i) => i.name).filter(Boolean) ?? []
        extraFileNames = filterImageAttachmentNames(parsed.attachedFiles, imageNames)
        references = parsed.references
      } catch {
        displayText = text
      }
    }
    // A message that delivers subagent results carries them structured; the transcript renders
    // those, never the text, which stays what the model reads.
    if (msg.role === 'user' && msg.steered) base.metadata = { ...(base.metadata as object | undefined), steered: true }
    const subagentNotice = msg.role === 'user' && msg.subagentNotice?.length ? msg.subagentNotice : undefined
    if (subagentNotice) base.metadata = { ...(base.metadata as object | undefined), subagentNotice }
    if (!displayText.trim() && !msg.images?.length && extraFileNames.length === 0 && references.length === 0 && !subagentNotice) {
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
    for (const reference of references) {
      parts.push({ type: 'data-mousse-reference', data: reference } as unknown as UIMessage['parts'][number])
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
 *
 * Pending/complete state follows the *latest* segment: a new processing
 * thought re-opens the row, and when that segment finishes the merged row
 * settles again. (Only promoting to pending left completed rows stuck
 * shimmering after the final segment resolved.)
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
      // Latest segment owns the live state (processing → pending, complete → done).
      if (curPart.state) prevPart.state = curPart.state
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
