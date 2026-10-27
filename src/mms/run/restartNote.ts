import { commandLabel, INTERRUPTED_SUMMARY } from '../../shared/agentActivity'
import { redactSecrets } from '../../shared/errors'
import type { ChatMessage } from '../../shared/types'

/** One piece of saved work a restart cut off, as the note names it. Never carries output, a working directory or a result; a Codex helper's label is the capped start of its prompt, redacted like every label. */
export interface CutOffActivity {
  runId?: string
  kind: 'command' | 'subagent' | 'other'
  label: string
  /** The provider's id for a subagent, so the agent can find it again. */
  nativeId?: string
}

/** Payload of a `restart.note` thread event (SPEC §12.5 step 5), written by `reconcileOnBoot`. */
export interface RestartNote {
  /** Runs the restart cut off: active at boot, or interrupted by the previous daemon's shutdown. */
  runIds: string[]
  uncertainRunIds: string[]
  cutOffTools: Array<{ runId: string; invocationId: string; tool: string; idempotent: boolean }>
  /** Queued runs whose `turn.start` died before they began (reconciler rule 5 restarts them). */
  queuedRunIds?: string[]
  /** Saved activity items the restart cut off. Filled from the thread's messages when the note is delivered, never stored in the event. */
  cutOffActivity?: CutOffActivity[]
  epoch: number
}

/** Longest label, in characters, and the most entries a note lists before "and N more". */
export const RESTART_NOTE_LABEL_CHARS = 160
export const RESTART_NOTE_MAX_ENTRIES = 10
const RESTART_NOTE_ID_CHARS = 64
/** Text read from an item before it is cleaned, so a huge command cannot slow the note down. */
const RAW_LABEL_CHARS = 4000

/** `NAME=value`, and PowerShell `$env:NAME = 'value'` (spaces around the equals sign allowed). */
const ENV_SECRET = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi
const FLAG_SECRET = /(--?(?:api-?key|token|secret|password|passwd|auth)[ =])("[^"]*"|'[^']*'|\S+)/gi
/** `Authorization: …`, `x-api-key: …` and similar header or JSON fields, also inside quotes as in `-H "X-Api-Key: …"`. */
const HEADER_SECRET = /((?:authorization|[a-z0-9_-]*(?:api[-_]?key|token|secret|password|passwd)[a-z0-9_-]*)["']?\s*:\s*)(?:(?:bearer|basic|token)\s+)?["']?[^\s"',;]+/gi

/** A one-line label without credentials, whitespace runs or anything past the label limit. */
function noteLabel(text: string): string {
  const redacted = redactSecrets(
    text.slice(0, RAW_LABEL_CHARS).replace(ENV_SECRET, '$1=[redacted]').replace(FLAG_SECRET, '$1[redacted]').replace(HEADER_SECRET, '$1[redacted]')
  )
  const line = redacted.replace(/\s+/g, ' ').trim()
  return line.length > RESTART_NOTE_LABEL_CHARS ? `${line.slice(0, RESTART_NOTE_LABEL_CHARS - 1).trimEnd()}…` : line
}

const KIND_ORDER: Record<CutOffActivity['kind'], number> = { command: 0, subagent: 1, other: 2 }

/**
 * The saved items a restart cut off on `runIds`: every `interrupted` item of those runs. Every run
 * in the note was cut off by the restart, so the item's own tag is not needed (a graceful restart
 * leaves Claude and Codex rows tagged `stop`, the orchestrator's safety net tags `daemon_restart`).
 * Rows without a `runId` predate activity items. Commands come first, then subagents, then the rest.
 */
export function cutOffActivityOf(messages: readonly ChatMessage[], runIds: readonly string[]): CutOffActivity[] {
  const runs = new Set(runIds)
  const entries: CutOffActivity[] = []
  for (const message of messages) {
    const item = message.activity
    if (!item || item.status !== 'interrupted' || !item.runId || !runs.has(item.runId)) continue
    switch (item.kind) {
      case 'command':
        entries.push({ runId: item.runId, kind: 'command', label: commandLabel(item.command) })
        break
      case 'subagent':
        entries.push({
          runId: item.runId,
          kind: 'subagent',
          label: item.description ?? item.agentType ?? 'subagent',
          ...(item.nativeId ? { nativeId: item.nativeId } : {})
        })
        break
      case 'file_change':
        entries.push({ runId: item.runId, kind: 'other', label: [item.toolName, item.changes[0]?.path].filter(Boolean).join(' ') })
        break
      default:
        entries.push({ runId: item.runId, kind: 'other', label: item.toolName })
    }
  }
  return entries.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
}

/**
 * Ends the items a previous daemon left `running`: they can never report back. Returns the changed
 * rows by message id, and leaves `messages` alone. Call it only for a session with no live turn
 * (a `running` item there is always stale). Items already ended are untouched, so a second sweep
 * changes nothing.
 */
export function closeStaleActivity(messages: readonly ChatMessage[], endedAt: string): Map<string, ChatMessage> {
  const closed = new Map<string, ChatMessage>()
  for (const message of messages) {
    const item = message.activity
    if (!item || item.status !== 'running') continue
    const { interruptedBy: _by, ...rest } = item
    closed.set(message.id, {
      ...message,
      activity: { ...rest, status: 'interrupted', interruptedBy: 'daemon_restart', summary: INTERRUPTED_SUMMARY.daemon_restart, endedAt } as typeof item,
      ...(message.toolCall ? { toolCall: { ...message.toolCall, status: 'complete' as const } } : {})
    })
  }
  return closed
}

function noteLine(entry: CutOffActivity): string {
  const label = noteLabel(entry.label) || entry.kind
  const id = entry.nativeId ? noteLabel(entry.nativeId).slice(0, RESTART_NOTE_ID_CHARS) : ''
  if (entry.kind === 'command') return `command: ${label}`
  if (entry.kind === 'subagent') return `subagent: ${label}${id ? ` (id ${id})` : ''}`
  return label
}

/** The system note the next turn on the thread shows once after a daemon restart. */
export function formatRestartNote(note: RestartNote): string {
  const count = note.runIds.length
  const queued = note.queuedRunIds?.length ?? 0
  let text = count
    ? `The Mousse daemon restarted during the previous turn. Interrupted: ${count} run(s).`
    : 'The Mousse daemon restarted before this turn started.'
  if (queued) text += ` Queued before the restart: ${queued} run(s).`

  if (note.uncertainRunIds.length) {
    const uncertain = new Set(note.uncertainRunIds)
    const inUncertainRuns = note.cutOffTools.filter((tool) => uncertain.has(tool.runId))
    const unsafe = inUncertainRuns.filter((tool) => !tool.idempotent)
    const tools = [...new Set((unsafe.length ? unsafe : inUncertainRuns).map((tool) => tool.tool))]
    text += ` These tool calls may have run without a recorded result; verify before repeating: ${
      tools.length ? tools.join(', ') : 'unknown'
    }.`
  }

  const lines = [...new Set((note.cutOffActivity ?? []).map(noteLine))]
  if (lines.length) {
    text += ' This work was cut off and will not report back on its own; resume or restart what you still need:'
    for (const line of lines.slice(0, RESTART_NOTE_MAX_ENTRIES)) text += `\n- ${line}`
    if (lines.length > RESTART_NOTE_MAX_ENTRIES) text += `\n- and ${lines.length - RESTART_NOTE_MAX_ENTRIES} more`
  }
  return text
}
