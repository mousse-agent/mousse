import type { UIMessage } from 'ai'
import type { SubagentState, SubagentSummary, SubagentTaskSummary, SubagentWaitingOn } from '../../../shared/subagents'
import { isRefusedSubagentResult, isSubagentStartTool, readSubagentResult, type SubagentStartTool } from '../../../shared/subagentTools'

/**
 * A subagent card is one task a subagent was given, shown where the parent started it. The row that
 * starts a task (`delegate_task`, `continue_subagent`) says when it ran; the daemon's subagent list
 * (`subagents.list`) says what became of it. This joins the two.
 */

/** One start-a-task call in the parent's transcript. */
export interface SubagentCall {
  toolCallId: string
  tool: SubagentStartTool
  /** When the row was written, in ms; null when it has no usable timestamp. */
  startedAt: number | null
  /** The call has not returned yet. */
  pending: boolean
  /** The row carries the daemon's record of the call (even if empty so far), so it joins only by what the record names. */
  recorded: boolean
  /** The call errored or was refused, so no task came of it and its raw row stays. */
  failed: boolean
  input: Record<string, unknown>
  output: unknown
}

export interface SubagentCardModel {
  toolCallId: string
  /** No task is known for the call yet: it is still starting, or the subagent list has not loaded. */
  pending: boolean
  childThreadId: string | null
  delegationId: string | null
  title: string
  /** What the card shows: the subagent's state for its latest task, the task's own outcome for an older one. */
  state: SubagentState
  provider: string | null
  model: string | null
  /** The subagent has newer work than this task. */
  continued: boolean
  /** This is the subagent's latest task, so its state is the subagent's current one. */
  latest: boolean
  waitingOn: SubagentWaitingOn[]
  createdAt: number | null
  completedAt: number | null
  error?: string
}

type Part = { type?: unknown; toolCallId?: unknown; state?: unknown; input?: unknown; output?: unknown; subagentTool?: unknown }

function timeOf(value: unknown): number | null {
  if (!value) return null
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value))
  return Number.isFinite(ms) ? ms : null
}

/** The start-a-task calls in `messages`, in transcript order. */
export function collectSubagentCalls(messages: readonly UIMessage[]): SubagentCall[] {
  const calls: SubagentCall[] = []
  for (const message of messages) {
    for (const raw of message.parts ?? []) {
      const part = raw as Part
      if (part.type !== 'tool-Subagent' || !isSubagentStartTool(part.subagentTool)) continue
      if (typeof part.toolCallId !== 'string') continue
      const state = part.state
      const input = part.input && typeof part.input === 'object' && !Array.isArray(part.input) ? (part.input as Record<string, unknown>) : {}
      calls.push({
        toolCallId: part.toolCallId,
        tool: part.subagentTool,
        startedAt: timeOf((message as { createdAt?: unknown }).createdAt),
        pending: state !== 'output-available' && state !== 'output-error',
        recorded: typeof input.recordVersion === 'number',
        failed: state === 'output-error' || isRefusedSubagentResult(part.output),
        input,
        output: part.output
      })
    }
  }
  return calls
}

/** A task starts after its row is written; a little slack absorbs rounding in the two timestamps. */
const START_SLACK_MS = 250

interface TaskEntry {
  subagent: SubagentSummary
  task: SubagentTaskSummary
  index: number
  at: number
}

function normalizedTitle(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.replace(/\s+/g, ' ').trim().toLowerCase() : null
}

/** The subagent a call names: `delegate_task` by `title`, `continue_subagent` by its `subagent` reference. */
function namesSubagent(call: SubagentCall, entry: TaskEntry): boolean | null {
  if (call.tool === 'delegate_task') {
    const title = normalizedTitle(call.input.title)
    return title === null ? null : normalizedTitle(entry.subagent.title) === title
  }
  const ref = typeof call.input.subagent === 'string' ? call.input.subagent.trim() : ''
  if (!ref) return null
  return ref === entry.subagent.childThreadId || ref === entry.task.delegationId || normalizedTitle(ref) === normalizedTitle(entry.subagent.title)
}

/** The call's recorded input says which subagent it is for. */
function namesAnySubagent(call: SubagentCall): boolean {
  return normalizedTitle(call.tool === 'delegate_task' ? call.input.title : call.input.subagent) !== null
}

function taskState(subagent: SubagentSummary, task: SubagentTaskSummary, latest: boolean): SubagentState {
  if (latest) return subagent.state === 'idle' ? 'done' : subagent.state
  switch (task.outcome) {
    case 'running':
      return 'working'
    case 'waiting_for_subagents':
      return 'waiting'
    default:
      return task.outcome
  }
}

function modelOf(call: SubagentCall, entry: TaskEntry): SubagentCardModel {
  const { subagent, task } = entry
  const latest = entry.index === subagent.tasks.length - 1
  return {
    toolCallId: call.toolCallId,
    pending: false,
    childThreadId: subagent.childThreadId,
    delegationId: task.delegationId,
    title: subagent.title,
    state: taskState(subagent, task, latest),
    provider: subagent.provider,
    model: subagent.model,
    continued: task.continued,
    latest,
    waitingOn: latest ? subagent.waitingOn : [],
    createdAt: timeOf(task.createdAt),
    completedAt: timeOf(task.completedAt),
    ...(task.error ? { error: task.error } : {})
  }
}

function pendingModel(call: SubagentCall): SubagentCardModel {
  return {
    toolCallId: call.toolCallId,
    pending: true,
    childThreadId: null,
    delegationId: null,
    title: (call.tool === 'delegate_task' && typeof call.input.title === 'string' && call.input.title.trim()) || (typeof call.input.subagent === 'string' && call.input.subagent.trim()) || 'Subagent',
    state: 'starting',
    provider: null,
    model: null,
    continued: false,
    latest: true,
    waitingOn: [],
    createdAt: call.startedAt,
    completedAt: null
  }
}

export interface JoinOptions {
  /** The daemon has answered `subagents.list` for this thread. Until then a finished call may still gain a card. */
  loaded: boolean
  /** Cards joined last time: one whose subagent has dropped out of the list (a trashed thread) stays. */
  previous?: ReadonlyMap<string, SubagentCardModel>
}

/**
 * The card of each start-a-task call that became a task, by tool call id.
 *
 * A call joins the task the daemon recorded for it, in this order: by the delegation id in its
 * recorded result; else by the subagent its recorded input names (a title, or the `subagent` a
 * follow-up addresses); else, only for rows that record neither (written before the daemon kept
 * them), by order and time, the earliest task no other call has taken. `delegate_task` starts a
 * subagent's first task and `continue_subagent` a later one. A call that errored or was refused
 * keeps its raw row; so does a finished call no task matches once the list has loaded.
 */
export function joinSubagentCards(calls: readonly SubagentCall[], subagents: readonly SubagentSummary[], options: JoinOptions): Map<string, SubagentCardModel> {
  const entries: TaskEntry[] = subagents
    .flatMap((subagent) => subagent.tasks.map((task, index) => ({ subagent, task, index, at: timeOf(task.createdAt) ?? 0 })))
    .sort((a, b) => a.at - b.at)
  const byDelegation = new Map(entries.map((entry) => [entry.task.delegationId, entry]))
  const claimed = new Set<string>()
  const assigned = new Map<string, TaskEntry>()

  const take = (call: SubagentCall, entry: TaskEntry | undefined): boolean => {
    if (!entry || claimed.has(entry.task.delegationId)) return false
    claimed.add(entry.task.delegationId)
    assigned.set(call.toolCallId, entry)
    return true
  }
  const recordedId = (call: SubagentCall): string | null => {
    const id = readSubagentResult(call.output)?.delegationId
    return typeof id === 'string' && id ? id : null
  }
  const live = calls.filter((call) => !call.failed)

  // 0. A call that already has a card keeps its task, listed or not, before any other call is
  //    matched: a task that dropped out of the list must not be handed to a neighbour.
  const reserved = new Set<string>()
  for (const call of live) {
    const before = options.previous?.get(call.toolCallId)
    if (!before || before.pending || !before.delegationId) continue
    reserved.add(call.toolCallId)
    take(call, byDelegation.get(before.delegationId))
  }

  // 1. A recorded result names its task outright.
  for (const call of live) {
    const id = recordedId(call)
    if (id && !reserved.has(call.toolCallId)) take(call, byDelegation.get(id))
  }

  // 2. A recorded input names the subagent: a started subagent by its title, a follow-up by the
  //    subagent it names, taking that subagent's earliest later task no other call has taken. A
  //    recorded follow-up with several candidate tasks waits for its result rather than guess.
  for (const call of live) {
    if (assigned.has(call.toolCallId) || reserved.has(call.toolCallId) || recordedId(call)) continue
    const named = entries.filter((entry) => namesSubagent(call, entry) === true && !claimed.has(entry.task.delegationId))
    if (call.tool === 'delegate_task') {
      take(call, named.find((entry) => entry.index === 0))
      continue
    }
    const later = named.filter((entry) => entry.index >= 1 && (call.startedAt === null || entry.at >= call.startedAt - START_SLACK_MS))
    if (later.length === 1 || (later.length > 1 && !call.recorded)) take(call, later[0])
  }

  // 3. Rows written before the daemon kept a record join by order and time. A recorded row never
  //    does, whatever it has named so far: until its result or title arrives it stays pending, so two
  //    calls started together cannot swap children. A row that names its task or subagent is
  //    not matched this way either, so it cannot take another call's task.
  for (const call of live) {
    if (assigned.has(call.toolCallId) || reserved.has(call.toolCallId) || call.recorded || recordedId(call) || namesAnySubagent(call)) continue
    take(
      call,
      entries.find(
        (entry) =>
          !claimed.has(entry.task.delegationId) &&
          (call.tool === 'delegate_task' ? entry.index === 0 : entry.index >= 1) &&
          (call.startedAt === null || entry.at >= call.startedAt - START_SLACK_MS)
      )
    )
  }

  const cards = new Map<string, SubagentCardModel>()
  for (const call of calls) {
    const entry = assigned.get(call.toolCallId)
    if (entry) {
      cards.set(call.toolCallId, modelOf(call, entry))
      continue
    }
    if (call.failed) continue
    const kept = options.previous?.get(call.toolCallId)
    if (kept && !kept.pending) cards.set(call.toolCallId, kept)
    else if (call.pending || !options.loaded) cards.set(call.toolCallId, pendingModel(call))
  }
  return cards
}
