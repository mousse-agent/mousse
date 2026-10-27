import { str, type Row } from './db/rows'
import { fail } from './db/RunStoreError'
import type { RunStore } from './RunStore'
import { isIdempotentTool } from './tools/idempotency'
import type { ToolInvocationRecord, ToolInvocationStatus } from './types'

/**
 * Tool-invocation ledger (SPEC §12.1, §12.6). `started` is written before a tool runs and
 * `committed|failed` after. A `started` row that outlives its run means the outcome is unknown.
 * Every write appends a `tool.status` event with the full record to the run's thread.
 */
export class ToolInvocations {
  constructor(readonly store: RunStore) {}

  start(input: {
    invocationId: string
    runId: string
    attemptId: string
    tool: string
    argsDigest: string
    now: string
    mcpAnnotations?: { readOnlyHint?: boolean }
    /**
     * The call's idempotency when its gate knows it from the tool's class (PR 6 §3: a bot gate
     * writes built-ins by their neutral class); absent, the name decides as before.
     */
    idempotent?: boolean
  }): ToolInvocationRecord {
    return this.store.db.transaction(() => {
      const threadId = this.threadOf(input.runId)
      const record: ToolInvocationRecord = {
        invocationId: input.invocationId,
        runId: input.runId,
        attemptId: input.attemptId,
        tool: input.tool,
        idempotent: input.idempotent ?? isIdempotentTool(input.tool, input.mcpAnnotations),
        status: 'started',
        argsDigest: input.argsDigest,
        startedAt: input.now,
        completedAt: null
      }
      this.store.db
        .statement(
          `INSERT INTO tool_invocations(invocation_id, run_id, attempt_id, tool, idempotent, status,
             args_digest, started_at, completed_at)
           VALUES(?, ?, ?, ?, ?, 'started', ?, ?, NULL)`
        )
        .run(
          record.invocationId,
          record.runId,
          record.attemptId,
          record.tool,
          record.idempotent ? 1 : 0,
          record.argsDigest,
          record.startedAt
        )
      return this.recorded(threadId, record)
    })
  }

  /** `started -> committed`. Null (and no write) when the row is not `started`. */
  commit(invocationId: string, now: string): ToolInvocationRecord | null {
    return this.settle(invocationId, 'committed', now)
  }

  /** `started -> failed`. Null (and no write) when the row is not `started`. */
  failed(invocationId: string, now: string): ToolInvocationRecord | null {
    return this.settle(invocationId, 'failed', now)
  }

  /** `started -> outcome_unknown`. Null (and no write) when the row is not `started`. */
  markOutcomeUnknown(invocationId: string, now: string): ToolInvocationRecord | null {
    return this.settle(invocationId, 'outcome_unknown', now)
  }

  get(invocationId: string): ToolInvocationRecord | null {
    const row = this.store.db
      .statement('SELECT * FROM tool_invocations WHERE invocation_id = ?')
      .get(invocationId)
    return row ? toInvocation(row) : null
  }

  listForRun(runId: string): ToolInvocationRecord[] {
    return this.store.db
      .statement('SELECT * FROM tool_invocations WHERE run_id = ? ORDER BY rowid')
      .all(runId)
      .map(toInvocation)
  }

  listStarted(runId: string): ToolInvocationRecord[] {
    return this.store.db
      .statement(
        `SELECT * FROM tool_invocations WHERE run_id = ? AND status = 'started' ORDER BY rowid`
      )
      .all(runId)
      .map(toInvocation)
  }

  listStartedNonIdempotentForRuns(runIds: readonly string[]): ToolInvocationRecord[] {
    if (!runIds.length) return []
    return this.store.db
      .statement(
        `SELECT * FROM tool_invocations
         WHERE status = 'started' AND idempotent = 0 AND run_id IN (${runIds.map(() => '?').join(',')})
         ORDER BY rowid`
      )
      .all(...runIds)
      .map(toInvocation)
  }

  private settle(
    invocationId: string,
    status: Exclude<ToolInvocationStatus, 'started'>,
    now: string
  ): ToolInvocationRecord | null {
    return this.store.db.transaction(() => {
      const current = this.get(invocationId)
      if (!current || current.status !== 'started') return null
      const result = this.store.db
        .statement(
          `UPDATE tool_invocations SET status = ?, completed_at = ?
           WHERE invocation_id = ? AND status = 'started'`
        )
        .run(status, now, invocationId)
      if (Number(result.changes) !== 1) return null
      return this.recorded(this.threadOf(current.runId), {
        ...current,
        status,
        completedAt: now
      })
    })
  }

  private threadOf(runId: string): string {
    const run = this.store.getRun(runId)
    if (!run) fail('bad_request', `Unknown run ${runId}.`)
    return run.threadId
  }

  private recorded(threadId: string, record: ToolInvocationRecord): ToolInvocationRecord {
    this.store.appendEvent({ threadId, runId: record.runId, type: 'tool.status', payload: record })
    return record
  }
}

function toInvocation(row: Row): ToolInvocationRecord {
  return {
    invocationId: String(row.invocation_id),
    runId: String(row.run_id),
    attemptId: String(row.attempt_id),
    tool: String(row.tool),
    idempotent: Number(row.idempotent) === 1,
    status: row.status as ToolInvocationStatus,
    argsDigest: String(row.args_digest),
    startedAt: String(row.started_at),
    completedAt: str(row.completed_at)
  }
}
