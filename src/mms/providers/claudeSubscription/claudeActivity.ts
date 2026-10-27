import {
  ACTIVITY_DESCRIPTION_CHARS,
  ACTIVITY_DIFF_CAP_BYTES,
  BACKGROUND_SUMMARY,
  capHead,
  capRecord,
  fileChangeFromTexts,
  type ActivityFileChange,
  type ActivityKind,
  type ActivityPatch,
  type ActivityTodoItem
} from '../../../shared/agentActivity'
import { subagentToolName } from '../../../shared/subagentTools'

/**
 * What Claude Code's tool calls say about the work, as typed activity fields. `claudeActivityStart`
 * reads a call's arguments; `claudeActivityComplete` reads its `tool_use_result` (the tool's own
 * output object), with the result text as the fallback. Every reader is optional: a shape this
 * Claude Code version does not send leaves the call a plain row, never a wrong one.
 */

const ERROR_CHARS = 2000
const MAX_SEARCH_RESULTS = 20

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

function lineCount(text: string): number {
  if (!text) return 0
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines.length
}

function serverOf(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const split = toolName.indexOf('__', 'mcp__'.length)
  return split === -1 ? undefined : toolName.slice('mcp__'.length, split)
}

function todosOf(value: unknown): ActivityTodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry): ActivityTodoItem[] => {
    const todo = record(entry)
    const content = todo && (str(todo.content) ?? str(todo.activeForm))
    if (!todo || !content) return []
    const status = todo.status === 'completed' || todo.status === 'in_progress' ? todo.status : 'pending'
    return [{ content, status }]
  })
}

/** `Bash` results come as an object, or (older Claude Code) as JSON text with the same two streams. */
function bashOutput(result: Record<string, unknown> | undefined, text: string | undefined): string {
  let stdout = str(result?.stdout)
  let stderr = str(result?.stderr)
  if (stdout === undefined && stderr === undefined && !result) {
    const trimmed = text?.trim() ?? ''
    if (trimmed.startsWith('{')) {
      try {
        const parsed = record(JSON.parse(trimmed))
        if (parsed && (typeof parsed.stdout === 'string' || typeof parsed.stderr === 'string')) {
          stdout = str(parsed.stdout)
          stderr = str(parsed.stderr)
          return joinStreams(stdout, stderr)
        }
      } catch {
        // Not the legacy shape: the text is the output.
      }
    }
    return text ?? ''
  }
  return joinStreams(stdout, stderr)
}

function joinStreams(stdout: string | undefined, stderr: string | undefined): string {
  if (!stdout) return stderr ?? ''
  if (!stderr) return stdout
  return `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}`
}

/** A unified diff from the hunks Claude Code reports (`structuredPatch`), with the lines it added and removed. */
function hunksDiff(path: string, hunks: unknown): { diff: string; added: number; removed: number } | undefined {
  if (!Array.isArray(hunks) || hunks.length === 0) return undefined
  const out = [`--- a/${path}`, `+++ b/${path}`]
  let added = 0
  let removed = 0
  for (const entry of hunks) {
    const hunk = record(entry)
    const oldStart = num(hunk?.oldStart)
    const oldLines = num(hunk?.oldLines)
    const newStart = num(hunk?.newStart)
    const newLines = num(hunk?.newLines)
    if (!hunk || oldStart === undefined || oldLines === undefined || newStart === undefined || newLines === undefined || !Array.isArray(hunk.lines)) {
      return undefined
    }
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`)
    for (const line of hunk.lines) {
      if (typeof line !== 'string') return undefined
      out.push(line)
      if (line.startsWith('+')) added += 1
      else if (line.startsWith('-')) removed += 1
    }
  }
  return { diff: `${out.join('\n')}\n`, added, removed }
}

function changeFromHunks(path: string, change: ActivityFileChange['change'], built: { diff: string; added: number; removed: number }): ActivityFileChange {
  const capped = capHead(built.diff, ACTIVITY_DIFF_CAP_BYTES)
  return {
    path,
    change,
    diff: capped.text,
    ...(capped.truncated ? { diffTruncated: true } : {}),
    added: built.added,
    removed: built.removed
  }
}

function joinedEdits(edits: unknown): { oldText: string; newText: string } | undefined {
  if (!Array.isArray(edits)) return undefined
  const list = edits.map(record).filter((edit): edit is Record<string, unknown> => Boolean(edit))
  if (list.length === 0) return undefined
  return {
    oldText: list.map((edit) => str(edit.old_string) ?? str(edit.oldText) ?? '').join('\n'),
    newText: list.map((edit) => str(edit.new_string) ?? str(edit.newText) ?? '').join('\n')
  }
}

function fileChangePatch(name: string, args: Record<string, unknown>): ActivityPatch | undefined {
  switch (name) {
    case 'Edit':
    case 'MultiEdit': {
      const path = str(args.file_path)
      if (!path) return undefined
      const texts =
        typeof args.old_string === 'string' && typeof args.new_string === 'string'
          ? { oldText: args.old_string, newText: args.new_string }
          : joinedEdits(args.edits)
      if (!texts) return undefined
      // Provisional: the result's own patch replaces it.
      return { kind: 'file_change', changes: [fileChangeFromTexts(path, texts.oldText, texts.newText)] }
    }
    case 'Write': {
      const path = str(args.file_path)
      if (!path || typeof args.content !== 'string') return undefined
      // Until the result says whether the file existed, nothing is known of its prior contents.
      return { kind: 'file_change', changes: [{ path, change: 'update', diffUnavailable: true, linesWritten: lineCount(args.content) }] }
    }
    case 'NotebookEdit': {
      const path = str(args.notebook_path)
      if (!path || typeof args.new_source !== 'string') return undefined
      return { kind: 'file_change', changes: [{ path, change: 'update', diffUnavailable: true, linesWritten: lineCount(args.new_source) }] }
    }
    default:
      return undefined
  }
}

/**
 * The typed fields of a call that has started, or undefined when nothing typed is known yet (the
 * arguments are not in) or for a Mousse subagent tool, which keeps its bounded record instead.
 * `isRoot` is false for a call a subagent made: a subagent's to-do list is only a nested row.
 */
export function claudeActivityStart(name: string, input: unknown, isRoot: boolean): ActivityPatch | undefined {
  if (subagentToolName(name)) return undefined
  const args = record(input)
  const isAgent = name === 'Agent' || name === 'Task'
  if (!args) return isAgent ? { kind: 'subagent' } : undefined
  switch (name) {
    case 'Bash': {
      const command = str(args.command)
      if (command !== undefined) return { kind: 'command', command }
      break
    }
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const patch = fileChangePatch(name, args)
      if (patch) return patch
      break
    }
    case 'Grep': {
      const query = str(args.pattern)
      if (query) return { kind: 'search', scope: 'code', query, ...(str(args.path) ? { path: str(args.path) } : {}) }
      break
    }
    case 'Glob': {
      const query = str(args.pattern)
      if (query) return { kind: 'search', scope: 'files', query, ...(str(args.path) ? { path: str(args.path) } : {}) }
      break
    }
    case 'WebSearch': {
      const query = str(args.query)
      if (query) return { kind: 'web_search', query }
      break
    }
    case 'WebFetch': {
      const url = str(args.url)
      if (url) return { kind: 'web_search', query: url }
      break
    }
    case 'TodoWrite': {
      const items = todosOf(args.todos)
      if (items && isRoot) return { kind: 'todo', items }
      break
    }
    case 'ExitPlanMode': {
      const text = str(args.plan)
      if (text) return { kind: 'plan', text }
      break
    }
    case 'Agent':
    case 'Task': {
      const agentType = str(args.subagent_type)
      const description = str(args.description)
      return {
        kind: 'subagent',
        ...(agentType ? { agentType } : {}),
        ...(description ? { description: clip(description.replace(/\s+/g, ' ').trim(), ACTIVITY_DESCRIPTION_CHARS) } : {}),
        ...(args.run_in_background === true ? { background: true } : {})
      }
    }
    default:
      break
  }
  const server = serverOf(name)
  const kept = capRecord(args)
  return { kind: 'generic', ...(server ? { server } : {}), ...(kept ? { input: kept } : {}) }
}

/** What a finished call adds to its item. `handedOff`: the call returned a placeholder and the work goes on. */
export interface ClaudeCompletion {
  activity?: ActivityPatch
  handedOff: boolean
}

function failedChanges(started: ActivityPatch | undefined, error: string): ActivityFileChange[] | undefined {
  const changes = started?.kind === 'file_change' ? started.changes : undefined
  const first = changes?.[0]
  if (!first) return undefined
  // The edit did not happen: its provisional diff is not shown.
  return [{ path: first.path, change: first.change, error: clip(error, ERROR_CHARS) }]
}

function fileChangeResult(
  name: string,
  args: Record<string, unknown> | undefined,
  result: Record<string, unknown> | undefined
): ActivityFileChange[] | undefined {
  if (!result) return undefined
  if (name === 'Edit' || name === 'MultiEdit') {
    const path = str(result.filePath) ?? str(args?.file_path)
    if (!path) return undefined
    const built = hunksDiff(path, result.structuredPatch)
    if (built) return [changeFromHunks(path, 'update', built)]
    if (typeof result.oldString === 'string' && typeof result.newString === 'string') {
      return [fileChangeFromTexts(path, result.oldString, result.newString)]
    }
    return undefined
  }
  if (name === 'Write') {
    const path = str(result.filePath) ?? str(args?.file_path)
    const content = typeof result.content === 'string' ? result.content : undefined
    if (!path || content === undefined) return undefined
    if (result.type === 'create') return [fileChangeFromTexts(path, '', content, 'add')]
    if (result.type !== 'update') return undefined
    const built = hunksDiff(path, result.structuredPatch)
    if (built) return [changeFromHunks(path, 'update', built)]
    if (typeof result.originalFile === 'string') return [fileChangeFromTexts(path, result.originalFile, content)]
    // The patch is empty and the prior contents were not sent: no diff, never all additions.
    return [{ path, change: 'update', diffUnavailable: true, linesWritten: lineCount(content) }]
  }
  if (name === 'NotebookEdit') {
    const path = str(args?.notebook_path)
    if (!path || typeof result.new_source !== 'string') return undefined
    const mode = str(result.edit_mode) ?? str(args?.edit_mode)
    const oldText = typeof result.old_source === 'string' ? result.old_source : mode === 'insert' ? '' : undefined
    if (oldText === undefined) return undefined
    return [fileChangeFromTexts(path, oldText, mode === 'delete' ? '' : result.new_source)]
  }
  return undefined
}

function searchResultCount(result: Record<string, unknown> | undefined): number | undefined {
  return num(result?.numFiles) ?? (Array.isArray(result?.filenames) ? result.filenames.length : undefined)
}

function searchOutput(result: Record<string, unknown> | undefined, text: string | undefined): string | undefined {
  if (text !== undefined) return text
  if (typeof result?.content === 'string') return result.content
  return Array.isArray(result?.filenames) ? result.filenames.filter((file) => typeof file === 'string').join('\n') : undefined
}

function webResults(result: Record<string, unknown> | undefined): Array<{ title: string; url: string }> | undefined {
  if (!Array.isArray(result?.results)) return undefined
  const hits = result.results.flatMap((entry) => {
    const group = record(entry)
    return Array.isArray(group?.content) ? group.content : []
  })
  const results = hits.flatMap((hit): Array<{ title: string; url: string }> => {
    const item = record(hit)
    const url = str(item?.url)
    return url ? [{ title: str(item?.title) ?? url, url }] : []
  })
  return results.length > 0 ? results.slice(0, MAX_SEARCH_RESULTS) : undefined
}

/**
 * What a finished call adds to its item. A Mousse subagent tool adds nothing (its record carries the
 * result). `toolUseResult` is the tool's own output object when it is known to belong to this call.
 */
export function claudeActivityComplete(
  name: string,
  input: unknown,
  toolUseResult: unknown,
  resultText: string | undefined,
  isError: boolean,
  isRoot: boolean
): ClaudeCompletion {
  if (subagentToolName(name)) return { handedOff: false }
  const args = record(input)
  const result = record(toolUseResult)
  const started = claudeActivityStart(name, input, isRoot)
  const kind: ActivityKind | undefined = started?.kind
  const detached = result?.detachedToolCall === true
  const status = isError ? ({ status: 'failed' } as const) : {}

  switch (kind) {
    case 'command': {
      const output = bashOutput(result, resultText)
      const interrupted = result?.interrupted === true
      const taskId = str(result?.backgroundTaskId)
      return {
        handedOff: detached,
        activity: {
          kind: 'command',
          output,
          ...(taskId ? { nativeId: taskId, summary: BACKGROUND_SUMMARY } : {}),
          ...(interrupted ? { status: 'interrupted', interruptedBy: 'stop' } : status)
        } as ActivityPatch
      }
    }
    case 'file_change': {
      if (isError) {
        const changes = failedChanges(started, resultText ?? 'The edit failed.')
        return { handedOff: detached, activity: { status: 'failed', ...(changes ? { kind: 'file_change', changes } : {}) } as ActivityPatch }
      }
      const changes = fileChangeResult(name, args, result)
      const notebookError = name === 'NotebookEdit' ? str(result?.error) : undefined
      if (notebookError) {
        const failed = failedChanges(started, notebookError)
        return { handedOff: detached, activity: { status: 'failed', ...(failed ? { kind: 'file_change', changes: failed } : {}) } as ActivityPatch }
      }
      return { handedOff: detached, ...(changes ? { activity: { kind: 'file_change', changes } as ActivityPatch } : {}) }
    }
    case 'search': {
      const output = searchOutput(result, resultText)
      const resultCount = searchResultCount(result)
      return {
        handedOff: detached,
        activity: {
          kind: 'search',
          ...(output !== undefined ? { output } : {}),
          ...(resultCount !== undefined ? { resultCount } : {}),
          ...status
        } as ActivityPatch
      }
    }
    case 'web_search': {
      const results = name === 'WebSearch' ? webResults(result) : undefined
      return {
        handedOff: detached,
        activity: { kind: 'web_search', query: (started as { query?: string }).query ?? '',...(results ? { results } : {}), ...status } as ActivityPatch
      }
    }
    case 'todo': {
      const items = todosOf(result?.newTodos)
      return { handedOff: detached, activity: { ...(items ? { kind: 'todo', items } : {}), ...status } as ActivityPatch }
    }
    case 'subagent': {
      const launched = result?.status === 'async_launched' || result?.status === 'remote_launched'
      const agentId = str(result?.agentId) ?? str(result?.taskId)
      const duration = num(result?.totalDurationMs)
      const agentType = str(result?.agentType)
      return {
        // A launch placeholder is not the agent's result: the row stays open for its notification.
        handedOff: !isError && (launched || detached),
        activity: {
          kind: 'subagent',
          ...(launched || detached ? { background: true } : {}),
          ...(agentId ? { nativeId: agentId } : {}),
          ...(duration !== undefined ? { durationMs: duration } : {}),
          ...(agentType ? { agentType } : {}),
          ...status
        } as ActivityPatch
      }
    }
    case 'generic':
      return {
        handedOff: detached,
        activity: { kind: 'generic', ...(resultText !== undefined ? { output: resultText } : {}), ...status } as ActivityPatch
      }
    default: {
      // A plan, or a call whose arguments never arrived: the result text and the outcome.
      const activity = { ...(resultText !== undefined ? { output: resultText } : {}), ...status }
      return { handedOff: detached, ...(Object.keys(activity).length > 0 ? { activity: activity as ActivityPatch } : {}) }
    }
  }
}
