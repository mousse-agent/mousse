import { recordSubagentCall, subagentToolName } from './subagentTools'

/**
 * What an agent did, as typed items saved on the timeline (`ChatMessage.activity`) and drawn as the
 * rich tool cards. Every provider fills the same shapes; the renderer reads them instead of
 * string-matching titles. Large fields are capped when they are stored (see the caps below).
 */

export type ActivityStatus = 'running' | 'done' | 'failed' | 'interrupted'

/** Why an item ended `interrupted`. Separate from the Run Engine's `interruptedBy` on purpose. */
export type ActivityInterruptedBy = 'stop' | 'no_result' | 'daemon_restart'

interface ActivityBase {
  /** The timeline message id. */
  id: string
  /** The provider's id for the call. */
  callId: string
  /** The parent item's message id (never the provider's call id). */
  parentId?: string
  toolName: string
  status: ActivityStatus
  summary?: string
  startedAt: string
  endedAt?: string
  runId?: string
  interruptedBy?: ActivityInterruptedBy
}

export interface ActivityFileChange {
  path: string
  change: 'add' | 'update' | 'delete' | 'move'
  movePath?: string
  /** Unified diff, capped at `ACTIVITY_DIFF_CAP_BYTES`. */
  diff?: string
  diffTruncated?: boolean
  /** The prior contents are unknown, so there is no diff to show. */
  diffUnavailable?: boolean
  added?: number
  removed?: number
  linesWritten?: number
  error?: string
}

export interface ActivityTodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export type AgentActivityItem = ActivityBase &
  (
    | {
        kind: 'command'
        command: string
        cwd?: string
        output?: string
        outputTruncated?: boolean
        /** Full size of the output, before it was cut to its tail. */
        outputBytes?: number
        /** Display only: the status follows the provider, not the exit code. */
        exitCode?: number | null
        durationMs?: number
        nativeId?: string
      }
    | { kind: 'file_change'; changes: ActivityFileChange[] }
    | { kind: 'search'; scope: 'code' | 'files'; query: string; path?: string; resultCount?: number; output?: string }
    | { kind: 'web_search'; query: string; results?: Array<{ title: string; url: string }> }
    | { kind: 'todo'; items: ActivityTodoItem[] }
    | { kind: 'plan'; steps?: Array<{ step: string; status: string }>; text?: string }
    | {
        kind: 'subagent'
        agentType?: string
        description?: string
        nativeId?: string
        background?: boolean
        durationMs?: number
      }
    | { kind: 'generic'; server?: string; input?: Record<string, unknown>; output?: string }
  )

export type ActivityKind = AgentActivityItem['kind']

/**
 * What a provider knows about a call. The assembler fills `id`, `callId`, `status` and the
 * timestamps; a provider's closer sends `{ status: 'interrupted', interruptedBy, summary }`.
 */
export type ActivityPatch = Partial<AgentActivityItem> & {
  kind?: AgentActivityItem['kind']
  /** Streamed text for a command, search or generic item; on `update` a command appends it. */
  output?: string
  input?: Record<string, unknown>
}

/** A Mousse subagent call's bounded record (`recordSubagentCall`). */
export type SubagentCallRecord = NonNullable<ReturnType<typeof recordSubagentCall>>

/**
 * A vendor runtime's tool event as its provider reports it to the adapter. `update` carries a
 * running call's streamed output or changed fields and never starts or ends the call.
 */
export interface ProviderToolEvent {
  phase: 'start' | 'update' | 'complete'
  callId: string
  title: string
  toolName?: string
  /** A Mousse subagent call's bounded record, set when the call completes. */
  record?: SubagentCallRecord
  /** The typed fields the provider has. */
  activity?: ActivityPatch
  /** The provider's id of the call this one ran under (a subagent's child). */
  parentCallId?: string
}

export const ACTIVITY_OUTPUT_CAP_BYTES = 64 * 1024
export const ACTIVITY_DIFF_CAP_BYTES = 32 * 1024
export const ACTIVITY_GENERIC_CAP_BYTES = 16 * 1024
export const ACTIVITY_CHECKPOINT_MS = 5000
/** Longest subagent `description` an item keeps. */
export const ACTIVITY_DESCRIPTION_CHARS = 200
const ACTIVITY_ERROR_CHARS = 2000

export const INTERRUPTED_SUMMARY: Readonly<Record<ActivityInterruptedBy, string>> = {
  stop: 'Stopped',
  no_result: 'No result reported',
  daemon_restart: 'Cut off by a Mousse restart'
}

export const BACKGROUND_SUMMARY = 'Running in the background'

// ---------------------------------------------------------------------------------------------
// Capping
// ---------------------------------------------------------------------------------------------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

const ANSI_PATTERN = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g

/** Terminal output without colour and cursor sequences or NUL bytes. */
export function stripControlSequences(text: string): string {
  return text.replace(ANSI_PATTERN, '').split('\0').join('')
}

export interface CappedText {
  text: string
  truncated: boolean
  /** Size of the text before it was cut (after control sequences were stripped). */
  bytes: number
}

/**
 * Keeps the last `cap` bytes of `text`, cut at a line start (after a `\r\n`, never between its
 * two characters) so the tail does not begin mid-line. ANSI sequences and NUL bytes are stripped.
 */
export function capTail(text: string, cap: number): CappedText {
  const clean = stripControlSequences(text)
  const encoded = encoder.encode(clean)
  const bytes = encoded.length
  if (bytes <= cap) return { text: clean, truncated: false, bytes }
  let start = bytes - cap
  while (start < bytes && (encoded[start]! & 0xc0) === 0x80) start += 1
  let tail = decoder.decode(encoded.subarray(start))
  // Already at a line start when the byte before the cut ends a line.
  if (encoded[start - 1] !== 0x0a) {
    const newline = tail.indexOf('\n')
    if (newline !== -1 && newline < tail.length - 1) tail = tail.slice(newline + 1)
  }
  return { text: tail, truncated: true, bytes }
}

/** Keeps the first `cap` bytes of `text`, cut at a character boundary. */
export function capHead(text: string, cap: number): CappedText {
  const encoded = encoder.encode(text)
  const bytes = encoded.length
  if (bytes <= cap) return { text, truncated: false, bytes }
  let end = cap
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1
  return { text: decoder.decode(encoded.subarray(0, end)), truncated: true, bytes }
}

/** Adds streamed output to what an item already holds, keeping the tail and the full size. */
export function appendTail(
  previous: { text?: string; bytes?: number; truncated?: boolean },
  delta: string,
  cap: number = ACTIVITY_OUTPUT_CAP_BYTES
): CappedText {
  const clean = stripControlSequences(delta)
  const previousText = previous.text ?? ''
  const previousBytes = previous.bytes ?? byteLength(previousText)
  const capped = capTail(previousText + clean, cap)
  const bytes = previousBytes + byteLength(clean)
  return { text: capped.text, truncated: Boolean(previous.truncated) || capped.truncated, bytes }
}

/** A record kept whole when it fits `cap`, else a clipped JSON preview of it. */
export function capRecord(
  input: Record<string, unknown> | undefined,
  cap: number = ACTIVITY_GENERIC_CAP_BYTES
): Record<string, unknown> | undefined {
  if (!input) return undefined
  let json: string
  try {
    json = JSON.stringify(input)
  } catch {
    return undefined
  }
  if (byteLength(json) <= cap) return input
  return { truncated: true, preview: capHead(json, cap).text }
}

// ---------------------------------------------------------------------------------------------
// Diffs
// ---------------------------------------------------------------------------------------------

/** Lines a unified diff added and removed (the Codex `editedLines` rules: `+++` and `---` are not lines). */
export function diffLineCounts(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  return { added, removed }
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

const DIFF_CONTEXT_LINES = 3

/** A one-hunk unified diff of two texts, with the counts of what changed. Empty when they are equal. */
export function buildUnifiedDiff(
  path: string,
  oldText: string,
  newText: string
): { diff: string; added: number; removed: number } {
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  let prefix = 0
  const shared = Math.min(oldLines.length, newLines.length)
  while (prefix < shared && oldLines[prefix] === newLines[prefix]) prefix += 1
  let suffix = 0
  while (suffix < shared - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1
  const removedLines = oldLines.slice(prefix, oldLines.length - suffix)
  const addedLines = newLines.slice(prefix, newLines.length - suffix)
  if (removedLines.length === 0 && addedLines.length === 0) return { diff: '', added: 0, removed: 0 }
  const before = Math.min(DIFF_CONTEXT_LINES, prefix)
  const after = Math.min(DIFF_CONTEXT_LINES, suffix)
  const oldCount = before + removedLines.length + after
  const newCount = before + addedLines.length + after
  const start = prefix - before + 1
  const body = [
    ...oldLines.slice(prefix - before, prefix).map((line) => ` ${line}`),
    ...removedLines.map((line) => `-${line}`),
    ...addedLines.map((line) => `+${line}`),
    ...oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + after).map((line) => ` ${line}`)
  ]
  const header = `@@ -${oldCount === 0 ? 0 : start},${oldCount} +${newCount === 0 ? 0 : start},${newCount} @@`
  const diff = [`--- a/${path}`, `+++ b/${path}`, header, ...body].join('\n') + '\n'
  return { diff, added: addedLines.length, removed: removedLines.length }
}

export function unifiedDiff(path: string, oldText: string, newText: string): string {
  return buildUnifiedDiff(path, oldText, newText).diff
}

/**
 * The old and new text a stored diff describes, for a viewer that draws two texts. Hunks are joined
 * in order; a diff without hunk headers (Codex gives an added or deleted file's text as it is) is
 * the new text of an `add` and the old text of a `delete`.
 */
export function diffSides(diff: string, change: ActivityFileChange['change'] = 'update'): { oldText: string; newText: string } {
  if (!diff.includes('@@')) {
    if (change === 'add') return { oldText: '', newText: diff }
    if (change === 'delete') return { oldText: diff, newText: '' }
  }
  const oldLines: string[] = []
  const newLines: string[] = []
  let inHunk = !diff.includes('@@')
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('+')) newLines.push(line.slice(1))
    else if (line.startsWith('-')) oldLines.push(line.slice(1))
    else if (line.startsWith(' ')) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') }
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/

/**
 * A stored diff as a patch a diff viewer can parse, so hunks keep the line numbers they came
 * with and separate hunks stay separate. A diff whose hunks do not all have real `@@ -a,b +c,d @@`
 * headers (or that has none) returns `undefined`: draw its two sides instead (`diffSides`).
 */
export function diffAsPatch(path: string, diff: string): string | undefined {
  const lines = diff.split('\n')
  const hunks = lines.filter((line) => line.startsWith('@@'))
  if (hunks.length === 0 || !hunks.every((line) => HUNK_HEADER.test(line))) return undefined
  const hasFileHeader = lines.some((line, index) => line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ '))
  const body = diff.endsWith('\n') ? diff : `${diff}\n`
  return hasFileHeader ? body : `--- a/${path}\n+++ b/${path}\n${body}`
}

/** A file change whose old and new text are both known: a real diff with its counts. */
export function fileChangeFromTexts(
  path: string,
  oldText: string,
  newText: string,
  change: ActivityFileChange['change'] = 'update'
): ActivityFileChange {
  const built = buildUnifiedDiff(path, oldText, newText)
  const capped = capHead(built.diff, ACTIVITY_DIFF_CAP_BYTES)
  return {
    path,
    change,
    ...(capped.text ? { diff: capped.text } : {}),
    ...(capped.truncated ? { diffTruncated: true } : {}),
    added: built.added,
    removed: built.removed
  }
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

function unquote(text: string): string {
  const trimmed = text.trim()
  const quote = trimmed[0]
  if ((quote === '"' || quote === "'") && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1)
    return quote === '"' ? inner.replace(/\\(["\\$`])/g, '$1') : inner
  }
  return trimmed
}

const SHELL_WRAPPER = /^(?:\S*[\\/])?(?:bash|sh|zsh|dash|fish|ksh)(?:\.exe)?\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*c\s+([\s\S]+)$/
const CMD_WRAPPER = /^(?:\S*[\\/])?cmd(?:\.exe)?\s+(?:\/[a-zA-Z]\s+)*\/[ck]\s+([\s\S]+)$/i
const POWERSHELL_WRAPPER =
  /^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-(?:NoProfile|NoLogo|NonInteractive|NoExit|Login)\s+|-(?:ExecutionPolicy|ep|WindowStyle)\s+\S+\s+)*-(?:Command|c)\s+([\s\S]+)$/i
const ENV_WRAPPER = /^env\s+(?:(?:-\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*([\s\S]+)$/
const SUDO_WRAPPER = /^sudo\s+(?:-\S+\s+)*([\s\S]+)$/

/**
 * The command a shell invocation runs, for a one-line label: `bash -lc 'npm test'`, `sh -c`,
 * `env FOO=1 …`, `sudo …`, `cmd /c …` and `powershell -NoProfile -Command …` are unwrapped.
 * Derived from the command line only, never from output.
 */
export function commandLabel(command: string): string {
  let current = command.trim()
  for (let depth = 0; depth < 5; depth += 1) {
    const match =
      SHELL_WRAPPER.exec(current) ??
      POWERSHELL_WRAPPER.exec(current) ??
      CMD_WRAPPER.exec(current) ??
      ENV_WRAPPER.exec(current) ??
      SUDO_WRAPPER.exec(current)
    if (!match) break
    const inner = unquote(match[1]!)
    if (!inner || inner === current) break
    current = inner
  }
  return current.replace(/\s+/g, ' ').trim()
}

// ---------------------------------------------------------------------------------------------
// Tool names
// ---------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------
// Normalizer for pi and other runtimes that report a tool's name and arguments
// ---------------------------------------------------------------------------------------------

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** An item before the assembler gives it an identity. */
export type ActivityDraft = DistributiveOmit<AgentActivityItem, 'id' | 'callId'>

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

export function filePathOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined
  return str(input.file_path) ?? str(input.path) ?? str(input.filePath) ?? str(input.file)
}

function lineCount(text: string): number {
  return splitLines(text).length
}

function clip(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars - 1)}…` : text
}

function todoStatus(value: unknown): ActivityTodoItem['status'] {
  return value === 'completed' || value === 'in_progress' ? value : 'pending'
}

function todosOf(value: unknown): ActivityTodoItem[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.flatMap((entry): ActivityTodoItem[] => {
    const item = record(entry)
    if (!item) return []
    const content = str(item.content) ?? str(item.title) ?? str(item.text) ?? str(item.step) ?? str(item.activeForm)
    return content ? [{ content, status: todoStatus(item.status) }] : []
  })
}

function serverOf(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined
  const split = toolName.indexOf('__', 'mcp__'.length)
  return split === -1 ? undefined : toolName.slice('mcp__'.length, split)
}

/**
 * The item for a tool call a runtime reports by name and arguments (pi, and the fallback for a
 * runtime that sends nothing typed). A call whose arguments do not have the fields a kind needs is
 * a `generic` item. Pass `response` only for a call's result, never its arguments JSON.
 */
export function activityFromToolCall(args: {
  toolName?: string
  input?: Record<string, unknown>
  response?: string
  status?: ActivityStatus
  failed?: boolean
  startedAt: string
  server?: string
}): ActivityDraft {
  const rawName = args.toolName ?? ''
  const input = args.input
  const base = {
    toolName: rawName,
    status: args.status ?? (args.failed ? ('failed' as const) : ('running' as const)),
    startedAt: args.startedAt
  }
  const draft = typedDraft(rawName, input, base)
  const item = boundActivity(draft ?? genericDraft(rawName, input, base, args.server))
  return args.response !== undefined ? applyToolResult(item, { response: args.response, failed: args.failed }) : item
}

type DraftBase = { toolName: string; status: ActivityStatus; startedAt: string }

function genericDraft(
  rawName: string,
  input: Record<string, unknown> | undefined,
  base: DraftBase,
  server: string | undefined
): ActivityDraft {
  // A Mousse delegation call keeps only its bounded record, never the prompt.
  const delegation = subagentToolName(rawName) ? recordSubagentCall(rawName, input, {}) : null
  const kept = delegation ? delegation.input : capRecord(input)
  const resolvedServer = server ?? serverOf(rawName)
  return {
    ...base,
    kind: 'generic',
    ...(resolvedServer ? { server: resolvedServer } : {}),
    ...(kept ? { input: kept } : {})
  }
}

function typedDraft(
  rawName: string,
  input: Record<string, unknown> | undefined,
  base: DraftBase
): ActivityDraft | undefined {
  if (!input || subagentToolName(rawName)) return undefined
  switch (normalizeToolName(rawName)) {
    case 'Bash': {
      const command = str(input.command)
      if (command === undefined) return undefined
      const cwd = str(input.cwd) ?? str(input.workdir)
      return { ...base, kind: 'command', command, ...(cwd ? { cwd } : {}) }
    }
    case 'Edit': {
      const path = filePathOf(input)
      if (!path) return undefined
      if (Array.isArray(input.edits)) {
        const edits = input.edits.map(record).filter((edit): edit is Record<string, unknown> => Boolean(edit))
        const oldText = edits.map((edit) => str(edit.oldText) ?? str(edit.old_string) ?? '').join('\n')
        const newText = edits.map((edit) => str(edit.newText) ?? str(edit.new_string) ?? '').join('\n')
        return { ...base, kind: 'file_change', changes: [fileChangeFromTexts(path, oldText, newText)] }
      }
      const oldText = typeof input.old_string === 'string' ? input.old_string : undefined
      const newText = typeof input.new_string === 'string' ? input.new_string : undefined
      if (oldText === undefined || newText === undefined) return undefined
      return { ...base, kind: 'file_change', changes: [fileChangeFromTexts(path, oldText, newText)] }
    }
    case 'Write': {
      const path = filePathOf(input)
      if (!path || typeof input.content !== 'string') return undefined
      // The file's prior contents are not known, so there is no diff to show.
      return {
        ...base,
        kind: 'file_change',
        changes: [{ path, change: 'update', diffUnavailable: true, linesWritten: lineCount(input.content) }]
      }
    }
    case 'Grep': {
      const query = str(input.pattern) ?? str(input.query)
      if (!query) return undefined
      const path = str(input.path)
      return { ...base, kind: 'search', scope: 'code', query, ...(path ? { path } : {}) }
    }
    case 'Glob': {
      const path = str(input.path)
      const query = str(input.pattern) ?? str(input.query) ?? path
      if (!query) return undefined
      return { ...base, kind: 'search', scope: 'files', query, ...(path ? { path } : {}) }
    }
    case 'WebSearch': {
      const query = str(input.query) ?? str(input.q)
      return query ? { ...base, kind: 'web_search', query } : undefined
    }
    case 'TodoWrite': {
      const items = todosOf(input.todos)
      return items ? { ...base, kind: 'todo', items } : undefined
    }
    case 'PlanWrite':
    case 'ExitPlanMode': {
      const text = str(input.markdown) ?? str(input.plan) ?? str(input.text)
      return text ? { ...base, kind: 'plan', text: capHead(text, ACTIVITY_GENERIC_CAP_BYTES).text } : undefined
    }
    case 'Agent':
    case 'Task': {
      const agentType = str(input.subagent_type)
      const description = str(input.description)
      return {
        ...base,
        kind: 'subagent',
        ...(agentType ? { agentType } : {}),
        ...(description ? { description: clip(description.replace(/\s+/g, ' ').trim(), ACTIVITY_DESCRIPTION_CHARS) } : {}),
        ...(input.run_in_background === true ? { background: true } : {})
      }
    }
    default:
      return undefined
  }
}

/** Puts a call's result text on an item: output for a command, search or generic item, the error for a failed file change. */
export function applyToolResult<T extends ActivityDraft | AgentActivityItem>(
  item: T,
  result: { response: string; failed?: boolean }
): T {
  const next = { ...item } as ActivityDraft | AgentActivityItem
  switch (next.kind) {
    case 'command': {
      const capped = capTail(result.response, ACTIVITY_OUTPUT_CAP_BYTES)
      next.output = capped.text
      next.outputBytes = capped.bytes
      if (capped.truncated) next.outputTruncated = true
      else delete next.outputTruncated
      break
    }
    case 'file_change':
      if (result.failed && result.response) {
        const error = clip(result.response, ACTIVITY_ERROR_CHARS)
        next.changes = next.changes.map((change, index) => (index === 0 ? { ...change, error } : change))
      }
      break
    case 'search':
    case 'generic':
      next.output = capHead(result.response, ACTIVITY_GENERIC_CAP_BYTES).text
      break
    default:
      break
  }
  return next as T
}

const COMMAND_TRUNCATED = '\n… [command truncated]'

/**
 * An item with every field a provider supplies held to its cap, so a provider that forgets one
 * (a heredoc that writes a whole file, a huge patch) cannot put a multi-megabyte row in
 * `messages.json`. Safe to apply again to an item it already bounded.
 */
export function boundActivity<T extends ActivityDraft | AgentActivityItem>(item: T): T {
  const next = item as ActivityDraft | AgentActivityItem
  switch (next.kind) {
    case 'command': {
      if (next.command.endsWith(COMMAND_TRUNCATED)) return item
      const capped = capHead(next.command, ACTIVITY_GENERIC_CAP_BYTES)
      return capped.truncated ? ({ ...next, command: capped.text + COMMAND_TRUNCATED } as T) : item
    }
    case 'file_change': {
      if (!next.changes.some((change) => change.diff !== undefined && byteLength(change.diff) > ACTIVITY_DIFF_CAP_BYTES)) return item
      const changes = next.changes.map((change) => {
        if (change.diff === undefined) return change
        const capped = capHead(change.diff, ACTIVITY_DIFF_CAP_BYTES)
        return capped.truncated ? { ...change, diff: capped.text, diffTruncated: true } : change
      })
      return { ...next, changes } as T
    }
    case 'plan': {
      if (next.text === undefined) return item
      const capped = capHead(next.text, ACTIVITY_GENERIC_CAP_BYTES)
      return capped.truncated ? ({ ...next, text: capped.text } as T) : item
    }
    case 'subagent':
      return next.description !== undefined && next.description.length > ACTIVITY_DESCRIPTION_CHARS
        ? ({ ...next, description: clip(next.description, ACTIVITY_DESCRIPTION_CHARS) } as T)
        : item
    case 'generic':
      return next.input ? ({ ...next, input: capRecord(next.input) } as T) : item
    default:
      return item
  }
}

/**
 * Folds what a provider sent about a call into the item it already has. A patch of another kind
 * replaces the typed fields (a runtime that learns the kind after the call started); `output` of a
 * command is appended and re-capped to its tail.
 */
export function mergeActivityPatch(
  existing: AgentActivityItem,
  patch: ActivityPatch,
  outputMode: 'append' | 'replace' = 'replace'
): AgentActivityItem {
  const { kind, output, ...rest } = patch as ActivityPatch & { output?: string }
  const definedRest = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined))
  if (kind && kind !== existing.kind) {
    const { id, callId, parentId, toolName, status, summary, startedAt, endedAt, runId, interruptedBy } = existing
    const common = { id, callId, parentId, toolName, status, summary, startedAt, endedAt, runId, interruptedBy }
    const carried = Object.fromEntries(Object.entries(common).filter(([, value]) => value !== undefined))
    const replaced = { ...carried, ...definedRest, kind } as AgentActivityItem
    return boundActivity(output !== undefined ? setOutput(replaced, output, 'replace') : replaced)
  }
  const merged = { ...existing, ...definedRest } as AgentActivityItem
  return boundActivity(output !== undefined ? setOutput(merged, output, outputMode) : merged)
}

function setOutput(item: AgentActivityItem, output: string, mode: 'append' | 'replace'): AgentActivityItem {
  if (item.kind === 'command') {
    const { outputTruncated, outputBytes, ...withoutSizes } = item
    if (mode === 'append') {
      const capped = appendTail({ text: item.output, bytes: outputBytes, truncated: outputTruncated }, output)
      return { ...withoutSizes, output: capped.text, outputBytes: capped.bytes, ...(capped.truncated ? { outputTruncated: true } : {}) }
    }
    // A provider that sends the whole output also says how big it was, when it cut it itself.
    const capped = capTail(output, ACTIVITY_OUTPUT_CAP_BYTES)
    return {
      ...withoutSizes,
      output: capped.text,
      outputBytes: Math.max(capped.bytes, outputBytes ?? 0),
      ...(capped.truncated || outputTruncated ? { outputTruncated: true } : {})
    }
  }
  if (item.kind === 'search' || item.kind === 'generic') {
    return { ...item, output: capHead(output, ACTIVITY_GENERIC_CAP_BYTES).text }
  }
  return item
}
