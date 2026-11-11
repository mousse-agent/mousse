import { streamingAppletPresentation } from '../../components/applets/streamPresentation'
import type { ChatMessage, TurnEnd } from '../../../shared/types'
import type { UIMessage } from 'ai'
import { isToolTimelineMessage, RESTART_INTERRUPTED_TEXT, TURN_STOPPED_TEXT } from '../../../shared/types'
import {
  filterImageAttachmentNames,
  guessMimeTypeFromFilename,
  parseUserMessageContent,
} from '../../utils/messageAttachments'
import { commandLabel, knownToolName, normalizeToolName, type AgentActivityItem } from '../../../shared/agentActivity'
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
 * Failed tool results are marked in the summary
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
        // The task id and the background flag let the card follow a background agent to its end.
        input: compact({
          subagent_type: activity.agentType,
          description: activity.description,
          run_in_background: activity.background ? true : undefined,
          task_id: activity.nativeId,
        }),
        output: running
          ? undefined
          : withInterruption(activity, compact({ totalDurationMs: activity.durationMs, summary: activity.summary, startedAt: activity.startedAt, endedAt: activity.endedAt })),
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
  'Read', 'Edit', 'MultiEdit', 'Write', 'Bash', 'Grep', 'Glob',
  'TodoWrite', 'PlanWrite', 'ExitPlanMode',
  'WebSearch', 'WebFetch', 'Skill', 'Task', 'Agent',
  'Question', 'Thinking', 'cloning', 'QuickAction', 'ToolSearch',
])

function mcpToolSlug(rawName: string | undefined): string {
  return (rawName ?? 'tool').replace(/\W+/g, '_').toLowerCase() || 'tool'
}

function mcpCustomType(rawName: string | undefined): string {
  return `tool-mcp__custom__${mcpToolSlug(rawName)}`
}

/** A runtime's full MCP tool name (`mcp__<server>__<tool>`, as Claude Code and Codex name them), split. */
function splitMcpName(rawName: string | undefined): { server: string; tool: string } | undefined {
  const match = rawName?.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/)
  return match ? { server: match[1]!, tool: match[2]! } : undefined
}

/**
 * Built-in tools a runtime names in camel case, with their own handling in the list (`TaskOutput` rows are hidden,
 * MCP resource tools get their own labels). On an MCP-kind row without a server they keep that name.
 */
const BUILTIN_TOOL_NAMES = new Set([
  'TaskOutput', 'TaskStop',
  'ListMcpResources', 'ListMcpResourcesTool', 'ReadMcpResource', 'ReadMcpResourceTool',
])

/**
 * A title that is a tool's name rather than a sentence: a full MCP name (`mcp__mousse__thread_list`), a camel-case
 * name (`ToolSearch`, `WebFetch`) or a name the cards know (`Read`, `Bash`). A single word such as "Terminal" or
 * "Reading" is not one: it is guessed from below.
 */
function titleIsToolName(title: string): boolean {
  return /^mcp__\w+$/.test(title) || /^[A-Z][a-z]+(?:[A-Z][a-z]*)+$/.test(title) || (/^\w+$/.test(title) && knownToolName(title) !== undefined)
}

function fallbackToolName(msg: ChatMessage): string | undefined {
  const detailTool = msg.toolCall?.details.find((d) => d.startsWith('Tool:'))
  const name = detailTool?.replace('Tool:', '').trim().split(/\s+/)[0]
  if (name) return name
  const title = (msg.toolCall?.title ?? '').trim()
  if (titleIsToolName(title)) return title
  // Older rows named only by a sentence: a guess from its words. A search is not guessed (a web search, a tool
  // search and a code search all say "search"): it stays a generic row rather than a wrong one.
  const lower = title.toLowerCase()
  if (lower.includes('read')) return 'Read'
  if (lower.includes('edit')) return 'Edit'
  if (lower.includes('write') && !lower.includes('plan')) return 'Write'
  if (lower.includes('bash') || lower.includes('command') || lower.includes('terminal')) return 'Bash'
  if (lower.includes('grep')) return 'Grep'
  if (lower.includes('glob') || lower.includes('exploring files')) return 'Glob'
  if (lower.includes('todo')) return 'TodoWrite'
  if (lower.includes('quickaction') || lower.includes('quick action')) return 'QuickAction'
  if (lower.includes('plan')) return 'PlanWrite'
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
  // The provider's own name: on the row (newer rows), else on its item (rows saved before the row kept it). An item
  // named after its title had no name of its own; the fallback reads that title.
  const itemName = activity && activity.toolName !== toolCall.title ? activity.toolName : undefined
  const rawName = toolCall.toolName ?? itemName ?? fallbackToolName(msg)
  const toolName = normalizeToolName(rawName, msg.kind)
  const mcpName = splitMcpName(rawName)
  const structuredInput = toolCall.input ?? genericItem?.input ?? tryParseArgsJson(toolCall.response)

  let type: string
  if (subagentTool) {
    type = 'tool-Subagent'
  } else if (msg.kind === 'mcp_tool_call' || msg.kind === 'mcp_tool_result' || mcpName) {
    // True MCP tool: Server + Tool details identify it, or the full `mcp__<server>__<tool>` name does.
    const server = extractServer(toolCall.details) ?? mcpName?.server
    if (server) {
      type = `tool-mcp__${server}__${mcpToolSlug(mcpName?.tool ?? rawName)}`
    } else if (RICH_TOOL_TYPES.has(toolName)) {
      // Pi/build tools arrive with rewritten mcp kinds but no Server
      // detail — render their rich cards (Bash terminal, Edit diff, ...).
      type = `tool-${toolName}`
    } else if (rawName && BUILTIN_TOOL_NAMES.has(rawName)) {
      type = `tool-${rawName}`
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
      // A runtime that sends no arguments puts the tool's own name in the summary: that is not what it searched for.
      const query = toolCall.summary === rawName ? '' : toolCall.summary
      input = { pattern: query, query }
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

/** Who sent a turn: a person on another of the user's computers. Keyed by run id, which is the `turnId` of the turn's messages. */
export type TurnSenders = Readonly<Record<string, { name: string }>>

/** A reply's text as the transcript shows it: without the "(Stopped)" line a stopped reply ends with. */
export function assistantDisplayText(content: string): string {
  return content.replace(/(?:[ \t]*\r?\n)*[ \t]*\(Stopped\)\s*$/u, '')
}

/**
 * Why a Mousse line says its turn was cut off, or undefined when it says nothing of the kind. Lines written before
 * `turnEnd` existed are read by their exact text: a Stop's (taken as a person's) and a restart's.
 */
function turnEndOf(msg: ChatMessage): TurnEnd | undefined {
  if (msg.turnEnd) return msg.turnEnd
  if (msg.content === TURN_STOPPED_TEXT) return { cause: 'user' }
  if (msg.content === RESTART_INTERRUPTED_TEXT) return { cause: 'daemon_restart' }
  return undefined
}

export function mousseToUIMessages(messages: ChatMessage[], senders?: TurnSenders): UIMessage[] {
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
      // When a reply stopped streaming: a finished turn's saved time runs to it (`createdAt` is when it started).
      ...(msg.completedAt ? { completedAt: msg.completedAt } : {}),
      metadata: msg.responseMetadata ? { ...msg.responseMetadata } : undefined,
    } as unknown as UIMessage

    // A failed turn ends with Mousse's line carrying the error: it shows as the turn's error, where Retry is.
    if (msg.role === 'system' && msg.error) {
      base.role = 'assistant'
      base.parts = [{ type: 'error', title: 'Request failed', message: msg.error.message || msg.content } as unknown as UIMessage['parts'][number]]
      out.push(base)
      lastAssistantText = null
      continue
    }

    // The line a Stop, a restart or a crash wrote as it cut the turn off: a hidden marker that the turn's header reads
    // ("Stopped", "Interrupted"). It shows nothing itself, as Mousse's other lines do not.
    const turnEnd = msg.role === 'system' ? turnEndOf(msg) : undefined
    if (turnEnd) {
      base.parts = []
      base.metadata = { ...(base.metadata as object | undefined), turnEnd }
      out.push(base)
      lastAssistantText = null
      continue
    }

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

    if (msg.kind === 'progress' || msg.kind === 'warning' || msg.kind === 'context_compaction' || msg.kind === 'context_cleared') {
      if (msg.kind === 'context_cleared') base.metadata = { ...base.metadata as object, contextCleared: true }
      if (msg.kind === 'context_compaction') base.metadata = { ...base.metadata as object, compaction: true, compacting: msg.streaming === true,
        ...(msg.compaction?.manual ? { compactionManual: true } : {}), ...(msg.compaction?.kept ? { compactionKept: msg.compaction.kept } : {}) }
      // A line from Mousse itself (uncommitted changes it could not put back), not part of the agent's answer.
      if (msg.kind === 'warning') base.metadata = { ...base.metadata as object, notice: true }
      base.parts = [{ type: 'text', text: msg.content } as unknown as UIMessage['parts'][number]]
      base.role = 'assistant'
      out.push(base)
      lastAssistantText = null
      continue
    }

    // Answers to the agent's questions are a step of the agent's turn (one row that opens to each
    // question and its answer), not a message from the user. Older answers carry only the text and
    // stay a user message: typed text can look the same, so it is not parsed.
    if (msg.role === 'user' && msg.questionAnswers?.length) {
      base.role = 'assistant'
      base.parts = [{
        type: 'tool-QuestionAnswers',
        toolCallId: msg.id,
        state: 'output-available',
        input: { questions: msg.questionAnswers },
      } as unknown as UIMessage['parts'][number]]
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
    let displayText = msg.role === 'assistant' ? assistantDisplayText(text) : text
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
    // The turn a person on another of the user's computers sent says so (the sender is kept on the run, not on the message).
    const sender = msg.role === 'user' && msg.turnId && !msg.steered ? senders?.[msg.turnId] : undefined
    if (sender) base.metadata = { ...(base.metadata as object | undefined), sentFrom: { name: sender.name } }
    const subagentNotice = msg.role === 'user' && msg.subagentNotice?.length ? msg.subagentNotice : undefined
    if (subagentNotice) base.metadata = { ...(base.metadata as object | undefined), subagentNotice }
    // The same for the message a turn the provider started itself opens with: the background tasks it reports.
    const backgroundNotice = msg.role === 'user' && msg.backgroundNotice?.length ? msg.backgroundNotice : undefined
    if (backgroundNotice) base.metadata = { ...(base.metadata as object | undefined), backgroundNotice }
    if (msg.role === 'assistant' && msg.scheduledRun) base.metadata = { ...(base.metadata as object | undefined), scheduledRun: msg.scheduledRun }
    if (!displayText.trim() && !msg.images?.length && extraFileNames.length === 0 && references.length === 0 && !subagentNotice && !backgroundNotice) {
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
        // An image of a long thread of another computer arrives by name first; its bytes are fetched when shown.
        if (!img.data) {
          parts.push({
            type: 'file',
            filename: img.name,
            mediaType: img.mimeType,
            mimeType: img.mimeType,
          } as unknown as UIMessage['parts'][number])
          continue
        }
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
  /** On a row that joins thoughts: the latest one's id, and where its text starts in `input.thought`. */
  liveId?: string
  liveFrom?: number
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
      const latest = thoughtText(curPart.input?.thought)
      const thought = [thoughtText(prevPart.input?.thought), latest]
        .filter((t) => t.trim())
        .join('\n\n')
      prevPart.input = { ...(prevPart.input as object), thought }
      // Only the latest thought can still be written: the row's live text (see liveTextStore) is its, from where it starts.
      prevPart.liveId = curPart.toolCallId
      prevPart.liveFrom = latest.trim() ? thought.length - latest.length : thought.length
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

/**
 * The chat status of a thread's turn. A run that waits for an approval or an answer to a question
 * (`awaiting_input` with the run's id) is still the same reply: it reads as streaming, so the turn
 * keeps one working indicator and its timer runs on. A request with no run behind it (one a restart
 * left, which continues the thread when answered) reads as ready.
 */
export function chatStatusFromTurn(state: { phase: string; turnId?: string | null } | undefined): 'ready' | 'submitted' | 'streaming' | 'error' {
  if (state?.phase === 'awaiting_input') return state.turnId ? 'streaming' : 'ready'
  return chatStatusFromPhase(state?.phase ?? 'idle')
}

/** Structural equality of the plain values a UI message holds; the same reference is equal at once. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!sameValue(a[i], b[i])) return false
    return true
  }
  if (Array.isArray(b)) return false
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false
  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false
    if (!sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false
  }
  return true
}

/**
 * `next` with every message that equals the message of the same id in `previous` replaced by that
 * earlier object, so a streamed delta leaves every other message (and its `parts`) the same object
 * and memoised rows skip rendering. Returns `previous` itself when nothing changed.
 */
export function reuseUIMessages(previous: readonly UIMessage[], next: UIMessage[]): UIMessage[] {
  if (previous.length === 0) return next
  const byId = new Map(previous.map((message) => [message.id, message]))
  let unchanged = previous.length === next.length
  const out = next.map((message, index) => {
    const before = byId.get(message.id)
    const kept = before && sameValue(before, message) ? before : message
    if (kept !== previous[index]) unchanged = false
    return kept
  })
  return unchanged ? (previous as UIMessage[]) : out
}
