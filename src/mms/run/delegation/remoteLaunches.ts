import type { RoutedAgentMark } from '../../../shared/bridge/routed'
import { isPermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import { int, str, type Row } from '../db/rows'
import type { RunStore } from '../RunStore'

/**
 * A thread an agent of this computer launched on another of the user's computers (`thread_create` with `computer`,
 * issue #1160): table `remote_launches`. The thread there is that computer's own; this row is this computer's record
 * that a thread here launched it, with everything the launch decided before it made anything, so a launch cut off by a
 * lost link or a restart is finished from the row (`RemoteThreadLaunches`) and never from what the caller says by then.
 *
 * Reading, waiting on, messaging and stopping a launched thread look it up here by launcher, or by computer and far id.
 */

/** See the migration for what each state means. */
export type RemoteLaunchState = 'starting' | 'created' | 'launched' | 'abandoned'

/** What became of the first message there. `none`: the launch has none. */
export type RemoteLaunchFirstMessage = 'none' | 'pending' | 'sent' | 'failed' | 'uncertain'

export interface RemoteLaunchRecord {
  /** The launch's own key, the `thread_create` receipt's: `thread_create:<launcher>:<clientRequestId>`. */
  creationKey: string
  launcherThreadId: string
  launcherRunId: string
  /** The computer that runs the thread (its Net node id), and its name when it was launched. */
  node: string
  computerName: string
  /** The thread's name there. */
  title: string
  /** The project there that is the same repository as the launcher's. */
  remoteProjectId: string
  worktree: boolean
  /**
   * The `hidden` the create sends that computer: whether it keeps the thread out of its sidebar. Null sends none (a
   * launch from before it, or a bot's), which that computer takes as shown, as it always did.
   */
  hidden: boolean | null
  instanceId: string | null
  model: string | null
  /** The most the thread may run in there, before that computer's limit narrows it: the launcher's own mode. */
  permissionMode: PermissionMode
  /** The mode it was set to there, once set. */
  remoteMode: PermissionMode | null
  firstMessage: { content: string; mode: 'agent' | 'plan' } | null
  /** The agent mark every write of the launch carries, fixed at launch (the launcher's run, title, hops and mode). */
  mark: RoutedAgentMark
  /** The thread's id there (unqualified); null until that computer created it. */
  remoteThreadId: string | null
  /** The run the first message started there; null before, or when it was queued or refused. */
  remoteRunId: string | null
  state: RemoteLaunchState
  firstMessageState: RemoteLaunchFirstMessage
  /** Why the latest call there failed; cleared by the next one that works. */
  lastError: string | null
  /** A Stop of the launcher sent (or still to send) there; null when none was asked for. */
  stop: RemoteLaunchStop | null
  createdAt: string
  updatedAt: string
}

/** The launcher was stopped, deleted or expired: what reaches the thread there (migration 22). */
export interface RemoteLaunchStop {
  state: 'pending' | 'sent' | 'expired'
  /** The idempotency key of every attempt, so the Stop acts once there. */
  key: string
  reason: 'stopped' | 'deleted' | 'expired'
  /** Given up after this, if not delivered by then. */
  deadline: string
  /** What that computer said: what it stopped, or why it left the run. */
  result: string | null
}

const STATES: ReadonlySet<string> = new Set(['starting', 'created', 'launched', 'abandoned'])
const FIRST: ReadonlySet<string> = new Set(['none', 'pending', 'sent', 'failed', 'uncertain'])

function parseMark(raw: unknown): RoutedAgentMark {
  try {
    const value = JSON.parse(String(raw)) as Partial<RoutedAgentMark>
    return {
      thread: String(value.thread ?? ''),
      run: String(value.run ?? ''),
      title: String(value.title ?? ''),
      hops: Number.isSafeInteger(value.hops) ? value.hops! : 1,
      // A mark that cannot be read narrows to the strictest mode.
      mode: isPermissionMode(value.mode) ? value.mode : 'ask'
    }
  } catch {
    return { thread: '', run: '', title: '', hops: 1, mode: 'ask' }
  }
}

function stopOf(row: Row): RemoteLaunchStop | null {
  const state = str(row.stop_state)
  const key = str(row.stop_key)
  if (!state || !key) return null
  const reason = str(row.stop_reason)
  return {
    state: state === 'sent' || state === 'expired' ? state : 'pending',
    key,
    reason: reason === 'deleted' || reason === 'expired' ? reason : 'stopped',
    deadline: str(row.stop_deadline) ?? new Date(0).toISOString(),
    result: str(row.stop_result)
  }
}

function fromRow(row: Row): RemoteLaunchRecord {
  const mode = String(row.permission_mode)
  const remoteMode = str(row.remote_mode)
  const state = String(row.state)
  const first = String(row.first_message_state)
  const content = str(row.first_message)
  return {
    creationKey: String(row.creation_key),
    launcherThreadId: String(row.launcher_thread_id),
    launcherRunId: String(row.launcher_run_id),
    node: String(row.node),
    computerName: String(row.computer_name),
    title: String(row.title),
    remoteProjectId: String(row.remote_project_id),
    worktree: int(row.worktree) === 1,
    hidden: row.hidden === null || row.hidden === undefined ? null : int(row.hidden) === 1,
    instanceId: str(row.instance_id),
    model: str(row.model),
    permissionMode: isPermissionMode(mode) ? mode : 'ask',
    remoteMode: remoteMode && isPermissionMode(remoteMode) ? remoteMode : null,
    firstMessage: content === null ? null : { content, mode: row.first_message_mode === 'plan' ? 'plan' : 'agent' },
    mark: parseMark(row.mark),
    remoteThreadId: str(row.remote_thread_id),
    remoteRunId: str(row.remote_run_id),
    state: (STATES.has(state) ? state : 'abandoned') as RemoteLaunchState,
    firstMessageState: (FIRST.has(first) ? first : 'uncertain') as RemoteLaunchFirstMessage,
    lastError: str(row.last_error),
    stop: stopOf(row),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  }
}

/** What a caller may change on a row; `undefined` keeps a field, `null` clears a nullable one. */
export type RemoteLaunchPatch = Partial<Pick<RemoteLaunchRecord, 'remoteThreadId' | 'remoteRunId' | 'remoteMode' | 'state' | 'firstMessageState' | 'lastError' | 'hidden'>>

const COLUMNS: Record<keyof RemoteLaunchPatch, string> = {
  remoteThreadId: 'remote_thread_id',
  remoteRunId: 'remote_run_id',
  remoteMode: 'remote_mode',
  state: 'state',
  firstMessageState: 'first_message_state',
  lastError: 'last_error',
  hidden: 'hidden'
}

export type NewRemoteLaunch = Omit<RemoteLaunchRecord, 'remoteThreadId' | 'remoteRunId' | 'remoteMode' | 'state' | 'firstMessageState' | 'lastError' | 'stop' | 'createdAt' | 'updatedAt'>

/** The rows of `remote_launches`. Synchronous; every write joins the caller's transaction. */
export class RemoteLaunchRecords {
  constructor(private readonly store: RunStore) {}

  create(input: NewRemoteLaunch): RemoteLaunchRecord {
    const now = this.now()
    this.store.db
      .statement(
        `INSERT INTO remote_launches(creation_key, launcher_thread_id, launcher_run_id, node, computer_name, title,
           remote_project_id, worktree, hidden, instance_id, model, permission_mode, first_message, first_message_mode, mark,
           state, first_message_state, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?, ?)`
      )
      .run(
        input.creationKey,
        input.launcherThreadId,
        input.launcherRunId,
        input.node,
        input.computerName,
        input.title,
        input.remoteProjectId,
        input.worktree ? 1 : 0,
        input.hidden === null ? null : input.hidden ? 1 : 0,
        input.instanceId,
        input.model,
        input.permissionMode,
        input.firstMessage?.content ?? null,
        input.firstMessage?.mode ?? null,
        JSON.stringify(input.mark),
        input.firstMessage ? 'pending' : 'none',
        now,
        now
      )
    return this.get(input.creationKey)!
  }

  get(creationKey: string): RemoteLaunchRecord | null {
    const row = this.store.db.statement('SELECT * FROM remote_launches WHERE creation_key = ?').get(creationKey)
    return row ? fromRow(row) : null
  }

  /** The launch that made thread `remoteThreadId` on `node`, if a thread here launched it. */
  getByRemoteThread(node: string, remoteThreadId: string): RemoteLaunchRecord | null {
    const row = this.store.db.statement('SELECT * FROM remote_launches WHERE node = ? AND remote_thread_id = ?').get(node, remoteThreadId)
    return row ? fromRow(row) : null
  }

  /** The threads one thread launched on other computers, oldest first. */
  listForLauncher(launcherThreadId: string): RemoteLaunchRecord[] {
    return this.store.db
      .statement('SELECT * FROM remote_launches WHERE launcher_thread_id = ? ORDER BY created_at, rowid')
      .all(launcherThreadId)
      .map(fromRow)
  }

  /** Every launch nobody has finished yet, oldest first. */
  listOpen(): RemoteLaunchRecord[] {
    return this.store.db
      .statement(`SELECT * FROM remote_launches WHERE state IN ('starting', 'created') OR first_message_state IN ('pending', 'uncertain') ORDER BY created_at, rowid`)
      .all()
      .map(fromRow)
  }

  hasOpen(): boolean {
    return Boolean(
      this.store.db
        .statement(`SELECT 1 FROM remote_launches WHERE state IN ('starting', 'created') OR first_message_state IN ('pending', 'uncertain') LIMIT 1`)
        .get()
    )
  }

  /**
   * Keeps a Stop for the launch: a new one with `stop.key`, or the one already pending (its key is kept, so it still acts
   * once there). Returns the row as it is now.
   */
  requestStop(creationKey: string, stop: { key: string; reason: RemoteLaunchStop['reason']; deadline: string }): RemoteLaunchRecord | null {
    this.store.db
      .statement(
        `UPDATE remote_launches SET stop_state = 'pending', stop_key = ?, stop_reason = ?, stop_deadline = ?, stop_result = NULL, updated_at = ?
         WHERE creation_key = ? AND (stop_state IS NULL OR stop_state != 'pending')`
      )
      .run(stop.key, stop.reason, stop.deadline, this.now(), creationKey)
    return this.get(creationKey)
  }

  /** Records what became of a kept Stop: `sent` with what that computer said, or `expired`. */
  settleStop(creationKey: string, key: string, state: 'sent' | 'expired', result: string | null): RemoteLaunchRecord | null {
    this.store.db
      .statement(`UPDATE remote_launches SET stop_state = ?, stop_result = ?, updated_at = ? WHERE creation_key = ? AND stop_key = ? AND stop_state = 'pending'`)
      .run(state, result, this.now(), creationKey, key)
    return this.get(creationKey)
  }

  /** Notes why a kept Stop is still pending (it stays pending). */
  updateStopResult(creationKey: string, key: string, result: string): void {
    this.store.db
      .statement(`UPDATE remote_launches SET stop_result = ?, updated_at = ? WHERE creation_key = ? AND stop_key = ? AND stop_state = 'pending'`)
      .run(result, this.now(), creationKey, key)
  }

  /** Every Stop not delivered yet, oldest first. */
  listPendingStops(): RemoteLaunchRecord[] {
    return this.store.db
      .statement(`SELECT * FROM remote_launches WHERE stop_state = 'pending' ORDER BY updated_at, rowid`)
      .all()
      .map(fromRow)
  }

  update(creationKey: string, patch: RemoteLaunchPatch): RemoteLaunchRecord | null {
    const sets: string[] = []
    const values: Array<string | number | null> = []
    for (const [key, column] of Object.entries(COLUMNS) as Array<[keyof RemoteLaunchPatch, string]>) {
      const value = patch[key]
      if (value === undefined) continue
      sets.push(`${column} = ?`)
      values.push(typeof value === 'boolean' ? (value ? 1 : 0) : value)
    }
    if (sets.length === 0) return this.get(creationKey)
    sets.push('updated_at = ?')
    values.push(this.now())
    this.store.db.statement(`UPDATE remote_launches SET ${sets.join(', ')} WHERE creation_key = ?`).run(...values, creationKey)
    return this.get(creationKey)
  }

  private now(): string {
    return new Date(this.store.db.clock()).toISOString()
  }
}
