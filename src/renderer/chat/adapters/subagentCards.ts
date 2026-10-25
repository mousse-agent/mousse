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
  /** The row belongs to the conversation's last turn, the only one that can still be running. */
  inLastTurn: boolean
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
  /**
   * The task is certain: the call's own result named it, its title named a subagent's first task, or an
   * old row was joined by order. A provisional match (a lone follow-up taking the only candidate) is not.
   */
  exact: boolean
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
  // A steer is a user message inside a running turn, not the start of a new one.
  const startsTurn = (message: UIMessage): boolean => message.role === 'user' && !(message.metadata as { steered?: unknown } | undefined)?.steered
  const lastUser = messages.reduce((found, message, index) => (startsTurn(message) ? index : found), -1)
  for (const [messageIndex, message] of messages.entries()) {
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
        inLastTurn: messageIndex > lastUser,
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

function modelOf(call: SubagentCall, entry: TaskEntry, exact: boolean): SubagentCardModel {
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
    exact,
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
    exact: false,
    createdAt: call.startedAt,
    completedAt: null
  }
}

export interface JoinOptions {
  /** The daemon has answered `subagents.list` for this thread. Until then a finished call may still gain a card. */
  loaded: boolean
  /** Cards joined last time: one whose subagent has dropped out of the list (a trashed thread) stays. */
  previous?: ReadonlyMap<string, SubagentCardModel>
  /**
   * The thread's turn is running. A call that never returned is starting only while its turn is live;
   * a row left unfinished by a crash or a stop is not a pending card and keeps its plain row.
   * Defaults to running.
   */
  turnActive?: boolean
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
  const assigned = new Map<string, { entry: TaskEntry; exact: boolean }>()

  const take = (call: SubagentCall, entry: TaskEntry | undefined, exact: boolean): boolean => {
    if (!entry || claimed.has(entry.task.delegationId)) return false
    claimed.add(entry.task.delegationId)
    assigned.set(call.toolCallId, { entry, exact })
    return true
  }
  const recordedId = (call: SubagentCall): string | null => {
    const id = readSubagentResult(call.output)?.delegationId
    return typeof id === 'string' && id ? id : null
  }
  const turnActive = options.turnActive ?? true
  const starting = (call: SubagentCall): boolean => turnActive && call.inLastTurn
  const live = calls.filter((call) => !call.failed)

  // 1. A recorded result names its task outright. Only this, and an old row joined by order, is
  //    certain; it always wins, and no other card keeps a task it names.
  for (const call of live) {
    const id = recordedId(call)
    if (id) take(call, byDelegation.get(id), true)
  }

  // 2. A call that already has a card for a certain task keeps it, listed or not, before any other
  //    call is matched: a task that dropped out of the list must not be handed to a neighbour. A
  //    provisional match is not kept; it is worked out again from what is known now. A certain task
  //    that another call has claimed is lost to it, so two cards never hold one task.
  const reserved = new Set<string>()
  for (const call of live) {
    if (assigned.has(call.toolCallId)) continue
    const before = options.previous?.get(call.toolCallId)
    if (!before || before.pending || !before.exact || !before.delegationId) continue
    const listed = byDelegation.get(before.delegationId)
    if (!listed) reserved.add(call.toolCallId)
    else if (take(call, listed, true)) reserved.add(call.toolCallId)
  }

  // 3. A recorded input names the subagent. This is provisional, because a title can be reused (a
  //    subagent trashed and started again under its name): a started subagent is found by its title,
  //    a follow-up takes that subagent's later task only when exactly one task is a candidate, and
  //    neither is matched while another unresolved call names the same subagent. Such a call waits for
  //    its own result. A call that never returned and is not running takes nothing.
  const open = (call: SubagentCall): boolean => !(call.pending && !starting(call))
  const unresolved = live.filter((call) => !assigned.has(call.toolCallId) && !reserved.has(call.toolCallId) && !recordedId(call) && open(call))
  const subagentsNamed = (call: SubagentCall): Set<string> =>
    new Set(entries.filter((entry) => namesSubagent(call, entry) === true).map((entry) => entry.subagent.childThreadId))
  for (const call of unresolved) {
    const named = entries.filter((entry) => namesSubagent(call, entry) === true && !claimed.has(entry.task.delegationId))
    const later = call.tool === 'delegate_task' ? named.filter((entry) => entry.index === 0) : named.filter((entry) => entry.index >= 1 && (call.startedAt === null || entry.at >= call.startedAt - START_SLACK_MS))
    if (!call.recorded) {
      take(call, later[0], false)
      continue
    }
    const mine = subagentsNamed(call)
    const rivals = unresolved.some(
      (other) => other !== call && other.recorded && other.tool === call.tool && !assigned.has(other.toolCallId) && namesAnySubagent(other) && [...subagentsNamed(other)].some((id) => mine.has(id))
    )
    if (!rivals && later.length === 1) take(call, later[0], false)
  }

  // 4. Rows written before the daemon kept a record join by order and time. A recorded row never
  //    does, whatever it has named so far: until its result or title arrives it stays pending, so
  //    two calls started together cannot swap children. A row that names its task or subagent is
  //    not matched this way either, so it cannot take another call's task.
  for (const call of live) {
    if (assigned.has(call.toolCallId) || reserved.has(call.toolCallId) || call.recorded || recordedId(call) || namesAnySubagent(call) || !open(call)) continue
    take(
      call,
      entries.find(
        (entry) =>
          !claimed.has(entry.task.delegationId) &&
          (call.tool === 'delegate_task' ? entry.index === 0 : entry.index >= 1) &&
          (call.startedAt === null || entry.at >= call.startedAt - START_SLACK_MS)
      ),
      true
    )
  }

  const cards = new Map<string, SubagentCardModel>()
  for (const call of calls) {
    const match = assigned.get(call.toolCallId)
    if (match) {
      cards.set(call.toolCallId, modelOf(call, match.entry, match.exact))
      continue
    }
    if (call.failed) continue
    const kept = options.previous?.get(call.toolCallId)
    // A kept card never holds a task another call has claimed.
    if (kept && !kept.pending && kept.exact && !(kept.delegationId && claimed.has(kept.delegationId))) cards.set(call.toolCallId, kept)
    else if (call.pending ? starting(call) : !options.loaded) cards.set(call.toolCallId, pendingModel(call))
  }
  return cards
}
