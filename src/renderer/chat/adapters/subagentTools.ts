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
