import { isPermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import { int, str, type Row } from '../db/rows'
import type { RunStore } from '../RunStore'

/**
 * The binding of a remote subagent's task (issue #469) to the run that does it on another of the user's
 * computers: table `remote_subagents`. The task's child run here is a stand-in that stays `queued` (it
 * has no `turn.start`), so nothing on this computer starts a turn for it; `RemoteSubagents` reads these
 * rows to start, follow and stop the far run, and writes the stand-in's terminal status from it.
 */

/** See the migration (version 17) for what each state means. */
export type RemoteSubagentState = 'starting' | 'running' | 'stopping' | 'done'

export interface RemoteSubagentRecord {
  delegationId: string
  childThreadId: string
  childRunId: string
  /** The computer that runs it (its Net node id). */
  node: string
  /** The task as the far thread receives it. Kept so a start cut off by a restart can be finished. */
  prompt: string
  /**
   * The most the task may run in there: no looser than the run that sent it. That computer narrows it further
   * to the limit it set for this one (`RemoteSubagents.advanceStart`), so Full access is used only when both allow it.
   */
  permissionMode: PermissionMode
  /**
   * A task an older version started read-only (its row's `chat_mode` is `plan`). That computer can no longer hold a
   * thread read-only, so such a task is never started or continued again; every new task is an agent's.
   */
  readOnly: boolean
  /** The far thread works in a worktree of its own (`workspace: 'isolated'`). */
  worktree: boolean
  /** The far project that is the same repository as the parent's; null for a thread with no project. */
  projectId: string | null
  instanceId: string | null
  model: string | null
  /** The far thread's id there (unqualified); null until that computer created it. */
  remoteThreadId: string | null
  /** The far run's id; null until that computer accepted the send. */
  remoteRunId: string | null
  /**
   * When this computer stops the task if the far run has not ended (`maxMinutes` of wall time); null for no limit, and
   * cleared once that computer took the limit as running time (`limitMinutes`) and stops the run itself.
   */
  deadlineAt: string | null
  /** The minutes of running time the task may use (`maxMinutes`); null for no limit. */
  limitMinutes: number | null
  state: RemoteSubagentState
  /** The far thread is waiting for an answer to a question or an approval. */
  waitingInput: boolean
  /** Why the latest call to that computer failed; cleared by the next one that works. */
  lastError: string | null
  /** When that computer last answered about this task. */
  lastSeenAt: string | null
  /**
   * Whether the task's calls carry the agent mark (`ROUTED_AGENT_KEY`): true where that computer knows it, false for an
   * older computer, null until the first call. Fixed once set, and the same for every task of one subagent.
   */
  marked: boolean | null
  /**
   * The `hidden` the far thread's create sends: true, so that computer keeps it out of its sidebar. Null for a task
   * from before it, whose create sends none, as it did then, so a retry repeats the very same create.
   */
  hidden: boolean | null
  /**
   * The `subagent` the far thread's create sends: true, so that computer records the thread as this one's subagent
   * (`ThreadStartedFrom.agent.subagent`). Null for a task from before it, or once that computer did not take it on the
   * first attempt: its create sends none, so a retry repeats the very same create.
   */
  subagent: boolean | null
  createdAt: string
  updatedAt: string
}

/** What a remote subagent's stand-in shows beside its own runs (`RemoteSubagents.overlay`). */
export interface RemoteSubagentOverlay {
  node: string
  computerName: string
  online: boolean
  /** The far thread, qualified, once it exists. */
  ref?: string
  /** What the far run of the latest open task is doing, as a subagent's activity; undefined until read. */
  activity?: 'starting' | 'working' | 'paused' | 'needs_input'
  /** A Stop of the subagent has not reached that computer yet; it is sent when that computer answers. */
  stopRequested?: true
  /** Why the latest call there failed. */
  lastError?: string
}

const STATES: ReadonlySet<string> = new Set(['starting', 'running', 'stopping', 'done'])

function fromRow(row: Row): RemoteSubagentRecord {
  const mode = String(row.permission_mode)
  const state = String(row.state)
  return {
    delegationId: String(row.delegation_id),
    childThreadId: String(row.child_thread_id),
    childRunId: String(row.child_run_id),
    node: String(row.node),
    prompt: String(row.prompt),
    permissionMode: isPermissionMode(mode) ? mode : 'ask',
    readOnly: row.chat_mode === 'plan',
    worktree: int(row.worktree) === 1,
    projectId: str(row.project_id),
    instanceId: str(row.instance_id),
    model: str(row.model),
    remoteThreadId: str(row.remote_thread_id),
    remoteRunId: str(row.remote_run_id),
    deadlineAt: str(row.deadline_at),
    limitMinutes: row.limit_minutes === null || row.limit_minutes === undefined ? null : int(row.limit_minutes),
    state: (STATES.has(state) ? state : 'done') as RemoteSubagentState,
    waitingInput: int(row.waiting_input) === 1,
    lastError: str(row.last_error),
    lastSeenAt: str(row.last_seen_at),
    marked: row.marked === null || row.marked === undefined ? null : int(row.marked) === 1,
    hidden: row.hidden === null || row.hidden === undefined ? null : int(row.hidden) === 1,
    subagent: row.subagent === null || row.subagent === undefined ? null : int(row.subagent) === 1,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

/** What a caller may change on a row; `undefined` keeps a field, `null` clears a nullable one. */
export type RemoteSubagentPatch = Partial<
  Pick<RemoteSubagentRecord, 'remoteThreadId' | 'remoteRunId' | 'deadlineAt' | 'state' | 'waitingInput' | 'lastError' | 'lastSeenAt' | 'marked' | 'hidden' | 'subagent'>
>

const COLUMNS: Record<keyof RemoteSubagentPatch, string> = {
  remoteThreadId: 'remote_thread_id',
  remoteRunId: 'remote_run_id',
  deadlineAt: 'deadline_at',
  state: 'state',
  waitingInput: 'waiting_input',
  lastError: 'last_error',
  lastSeenAt: 'last_seen_at',
  marked: 'marked',
  hidden: 'hidden',
  subagent: 'subagent'
}

/** The rows of `remote_subagents`. Synchronous; every write joins the caller's transaction. */
export class RemoteSubagentRecords {
  constructor(private readonly store: RunStore) {}

  create(input: Omit<RemoteSubagentRecord, 'readOnly' | 'remoteThreadId' | 'remoteRunId' | 'limitMinutes' | 'state' | 'waitingInput' | 'lastError' | 'lastSeenAt' | 'marked' | 'hidden' | 'subagent' | 'createdAt' | 'updatedAt'> & {
    limitMinutes?: number | null
    /** A follow-up on a subagent whose far thread already exists. */
    remoteThreadId?: string | null
  }): RemoteSubagentRecord {
    const now = this.now()
    this.store.db
      .statement(
        `INSERT INTO remote_subagents(delegation_id, child_thread_id, child_run_id, node, prompt, permission_mode,
           chat_mode, worktree, project_id, instance_id, model, remote_thread_id, deadline_at, limit_minutes, hidden, subagent, state, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'starting', ?, ?)`
      )
      .run(
        input.delegationId,
        input.childThreadId,
        input.childRunId,
        input.node,
        input.prompt,
        input.permissionMode,
        // The column is retired: every new task runs as an agent there.
        'agent',
        input.worktree ? 1 : 0,
        input.projectId,
        input.instanceId,
        input.model,
        input.remoteThreadId ?? null,
        input.deadlineAt,
        input.limitMinutes ?? null,
        now,
        now
      )
    return this.get(input.delegationId)!
  }

  get(delegationId: string): RemoteSubagentRecord | null {
    const row = this.store.db.statement('SELECT * FROM remote_subagents WHERE delegation_id = ?').get(delegationId)
    return row ? fromRow(row) : null
  }

  getByChildRun(childRunId: string): RemoteSubagentRecord | null {
    const row = this.store.db.statement('SELECT * FROM remote_subagents WHERE child_run_id = ?').get(childRunId)
    return row ? fromRow(row) : null
  }

  /** The tasks of one remote subagent, oldest first. */
  listForChildThread(childThreadId: string): RemoteSubagentRecord[] {
    return this.store.db
      .statement('SELECT * FROM remote_subagents WHERE child_thread_id = ? ORDER BY created_at, rowid')
      .all(childThreadId)
      .map(fromRow)
  }

  /** Every task with something left to do on its computer, oldest first. */
  listOpen(): RemoteSubagentRecord[] {
    return this.store.db
      .statement(`SELECT * FROM remote_subagents WHERE state <> 'done' ORDER BY created_at, rowid`)
      .all()
      .map(fromRow)
  }

  hasOpen(): boolean {
    return Boolean(this.store.db.statement(`SELECT 1 FROM remote_subagents WHERE state <> 'done' LIMIT 1`).get())
  }

  update(delegationId: string, patch: RemoteSubagentPatch): RemoteSubagentRecord | null {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof RemoteSubagentPatch, string]>) {
      const value = patch[key]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (sets.length === 0) return this.get(delegationId)
    sets.push('updated_at = ?')
    values.push(this.now())
    this.store.db.statement(`UPDATE remote_subagents SET ${sets.join(', ')} WHERE delegation_id = ?`).run(...values, delegationId)
    return this.get(delegationId)
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }
}
