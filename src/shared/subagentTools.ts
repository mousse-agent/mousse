/**
 * The Mousse subagent tools as a transcript row records them. A row can name its tool four ways:
 * bare (`delegate_task`, the pi loop), as an MCP tool (`mcp__mousse__delegate_task`, Claude and
 * Codex), as `mousse.delegate_task` (a Codex row title) or as `Called mousse.delegate_task` (an
 * MCP call event). Older names that still dispatch map to the tool that replaced them.
 */

export type SubagentToolName =
  | 'delegate_task'
  | 'continue_subagent'
  | 'answer_subagent'
  | 'task_status'
  | 'task_cancel'
  | 'list_subagents'
  | 'integrate_delegation'

/** Name of the Mousse server in every runtime's MCP configuration. */
const MOUSSE_SERVER = 'mousse'

const TOOLS: Readonly<Record<string, SubagentToolName>> = {
  delegate_task: 'delegate_task',
  create_subagent: 'delegate_task',
  continue_subagent: 'continue_subagent',
  recall_subagent: 'continue_subagent',
  answer_subagent: 'answer_subagent',
  task_status: 'task_status',
  task_cancel: 'task_cancel',
  list_subagents: 'list_subagents',
  list_delegations: 'list_subagents',
  integrate_delegation: 'integrate_delegation',
  integrate_subagent: 'integrate_delegation'
}

/**
 * The subagent tool a name stands for, or null for any other tool. A name qualified with another
 * server (`mcp__other__delegate_task`) is not Mousse's tool. `create_subagents` (a batch of
 * several tasks) is not one task, so it is not a subagent tool here.
 */
export function subagentToolName(raw: string | null | undefined): SubagentToolName | null {
  if (!raw) return null
  const name = raw.trim().replace(/^Called\s+/i, '').toLowerCase()
  let server: string | null = null
  let tool = name
  if (name.startsWith('mcp__')) {
    const split = name.indexOf('__', 'mcp__'.length)
    if (split === -1) return null
    server = name.slice('mcp__'.length, split)
    tool = name.slice(split + 2)
  } else if (name.includes('.')) {
    const split = name.indexOf('.')
    server = name.slice(0, split)
    tool = name.slice(split + 1)
  }
  if (server !== null && server !== MOUSSE_SERVER) return null
  return TOOLS[tool] ?? null
}

/** The part of a tool row's record the name can come from. */
export interface SubagentToolRecord {
  toolName?: string
  title?: string
  summary?: string
  details?: readonly string[]
}

/**
 * The subagent tool a transcript tool row records. Vendor runtimes (Claude, Codex) put the tool name
 * in the title and summary, the pi loop in `toolName`, and an MCP call event names its server and
 * tool in details; a row whose details name another server is never a Mousse tool.
 */
export function subagentToolOfRecord(record: SubagentToolRecord): SubagentToolName | null {
  const details = record.details ?? []
  const server = details.find((detail) => detail.startsWith('Server:'))?.slice('Server:'.length).trim().split(/\s+/)[0]
  if (server && server.toLowerCase() !== MOUSSE_SERVER) return null
  const detailTool = details.find((detail) => detail.startsWith('Tool:'))?.slice('Tool:'.length).trim().split(/\s+/)[0]
  for (const candidate of [record.toolName, detailTool, record.summary, record.title]) {
    const tool = subagentToolName(candidate)
    if (tool) return tool
  }
  return null
}

/** The tools that start a task on a subagent: each becomes a card. */
export type SubagentStartTool = Extract<SubagentToolName, 'delegate_task' | 'continue_subagent'>

export function isSubagentStartTool(tool: unknown): tool is SubagentStartTool {
  return tool === 'delegate_task' || tool === 'continue_subagent'
}

/** What a subagent tool returned, when the row recorded it as a JSON object (or JSON text). */
export function readSubagentResult(output: unknown): Record<string, unknown> | null {
  if (output && typeof output === 'object' && !Array.isArray(output)) return output as Record<string, unknown>
  if (typeof output !== 'string') return null
  const text = output.trim()
  if (!text.startsWith('{')) return null
  try {
    const parsed = JSON.parse(text) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/**
 * A call the daemon answered with a refusal value (`title_taken`, `parent_stopping`, `no_task`, a
 * question to answer first) instead of an error: it started nothing, so there is no task to show.
 */
export function isRefusedSubagentResult(output: unknown): boolean {
  const result = readSubagentResult(output)
  return result !== null && (result.started === false || result.answered === false)
}

/**
 * Marks a row whose daemon kept the call's record. The app joins such a row to its task only by what
 * the record names, never by order and time, so a call that has not named its task yet stays pending.
 */
export const SUBAGENT_RECORD_VERSION = 1

/** Longest text the app keeps from one field of a subagent tool call. */
const RECORD_TEXT_CHARS = 200

function clip(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > RECORD_TEXT_CHARS ? `${text.slice(0, RECORD_TEXT_CHARS - 1)}…` : text
}

/** The text of a tool result, whether the runtime gave a string or MCP content blocks. */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .join('')
  return text || undefined
}

/**
 * What a transcript row keeps of a Mousse subagent tool call, so the app can tell which task a
 * card is for without guessing. Only the fields that name the subagent or task go in, each
 * clipped, and a version that marks the row as recorded: the call's title, subagent, delegation id and computer, and the result's delegation id, thread,
 * title, status and, for a refusal or error, its code and a short message. The prompt, the answers
 * and the result text never do. Null for any other tool.
 */
export function recordSubagentCall(
  rawName: string | null | undefined,
  input: unknown,
  result: { text?: string; isError?: boolean }
): { input: Record<string, unknown>; response?: string; failed: boolean } | null {
  if (!subagentToolName(rawName)) return null
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
  const keptInput: Record<string, unknown> = { recordVersion: SUBAGENT_RECORD_VERSION }
  for (const key of ['title', 'subagent', 'delegationId', 'computer'] as const) {
    const value = clip(args[key])
    if (value !== undefined) keptInput[key] = value
  }
  const value = readSubagentResult(result.text)
  const kept: Record<string, unknown> = {}
  if (value) {
    for (const key of ['delegationId', 'childThreadId', 'title', 'status', 'code'] as const) {
      const text = clip(value[key])
      if (text !== undefined) kept[key] = text
    }
    for (const key of ['started', 'answered'] as const) if (typeof value[key] === 'boolean') kept[key] = value[key]
    const message = clip(value.message)
    if ((value.started === false || value.answered === false) && message) kept.message = message
  } else if (result.isError) {
    const message = clip(result.text)
    if (message) kept.message = message
  }
  return {
    input: keptInput,
    ...(Object.keys(kept).length > 0 ? { response: JSON.stringify(kept) } : {}),
    failed: result.isError === true
  }
}
