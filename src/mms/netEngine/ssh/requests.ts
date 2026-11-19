import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { sqliteFilePath } from '../../data/sqliteFilePath'

/**
 * B's record of one SSH add request (1b §3.4 step 4), daemon-wide so it outlives the profile it names. The
 * immutable fields are written first; each later step records its result, so a repeated `prepare` resumes at the
 * first unrecorded one.
 */
export interface SshRequest {
  requestId: string
  /** When A issued it, in seconds since 1970 (A's clock). */
  issuedAt: number
  /** A's helper identity, and the name it gave. */
  joiner: string
  joinerName: string
  /** The profile A picked, by selector, or the label of the one B makes. */
  selector?: string
  newLabel?: string
  /** The selector of the profile the request serves (step 2), once known. */
  profile?: string
  state: 'open' | 'done' | 'removed'
  /** Step 4: B wrote its own row for A, or kept an existing one (and that row's id). */
  row?: 'own' | 'existing'
  rowKey?: string
  /** Step 5 (or the existing row's grant for `existing`). */
  grantId?: string
  /** Step 6: the reply, kept to answer a repeat. */
  reply?: Record<string, unknown>
  /** When B first stored it, in seconds since 1970 (B's clock): the retention rule counts from here. */
  storedAt: number
}

/** The fields a repeat must match exactly (§3.4 step 4.1). */
export type SshRequestImmutable = Pick<
  SshRequest,
  'requestId' | 'issuedAt' | 'joiner' | 'joinerName' | 'selector' | 'newLabel'
>

type Row = Record<string, string | number | null>

/** `net_engine_ssh_requests`, in `<MOUSSE_HOME>/net-engine/ssh-requests.db` (owner-only). */
export class SshRequestStore {
  private readonly db: DatabaseSync

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(sqliteFilePath(path))
    try {
      chmodSync(path, 0o600)
    } catch {
      // Windows: the profile folder's own rights hold.
    }
    this.db.exec(
      'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS net_engine_ssh_requests(request_id TEXT PRIMARY KEY,issued_at INTEGER NOT NULL,joiner TEXT NOT NULL,joiner_name TEXT NOT NULL,selector TEXT,new_label TEXT,profile TEXT,state TEXT NOT NULL,row TEXT,row_key TEXT,grant_id TEXT,reply TEXT,stored_at INTEGER NOT NULL) STRICT'
    )
  }

  close(): void {
    this.db.close()
  }

  get(requestId: string): SshRequest | undefined {
    const row = this.db
      .prepare('SELECT * FROM net_engine_ssh_requests WHERE request_id=?')
      .get(requestId) as Row | undefined
    return row ? toRequest(row) : undefined
  }

  /** Step 1: the immutable fields, before anything else is done for the request. */
  add(request: SshRequestImmutable, now: number): SshRequest {
    this.db
      .prepare(
        'INSERT INTO net_engine_ssh_requests(request_id,issued_at,joiner,joiner_name,selector,new_label,state,stored_at) VALUES(?,?,?,?,?,?,?,?)'
      )
      .run(
        request.requestId,
        request.issuedAt,
        request.joiner,
        request.joinerName,
        request.selector ?? null,
        request.newLabel ?? null,
        'open',
        Math.floor(now)
      )
    return this.get(request.requestId)!
  }

  /** Records a step's result. */
  update(
    requestId: string,
    change: Partial<Pick<SshRequest, 'profile' | 'state' | 'row' | 'rowKey' | 'grantId' | 'reply'>>
  ): SshRequest {
    const columns: Record<string, string> = {
      profile: 'profile',
      state: 'state',
      row: 'row',
      rowKey: 'row_key',
      grantId: 'grant_id',
      reply: 'reply'
    }
    const keys = Object.keys(change).filter((key) => key in columns) as Array<keyof typeof change>
    if (keys.length)
      this.db
        .prepare(
          `UPDATE net_engine_ssh_requests SET ${keys.map((key) => `${columns[key]}=?`).join(',')} WHERE request_id=?`
        )
        .run(
          ...keys.map((key) => {
            const value = change[key]
            return value === undefined
              ? null
              : typeof value === 'object'
                ? JSON.stringify(value)
                : String(value)
          }),
          requestId
        )
    return this.get(requestId)!
  }

  /** Every request of `joiner` for the profile `profile` that is open or done (a removal marks them `removed`). */
  live(joiner: string, profile: string): SshRequest[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM net_engine_ssh_requests WHERE joiner=? AND profile=? AND state IN ('open','done')"
        )
        .all(joiner, profile) as Row[]
    ).map(toRequest)
  }

  /** Whether a grant's receipt names a request this store knows (host recovery leaves such grants alone). */
  knows(requestId: string): boolean {
    return !!this.get(requestId)
  }

  /** Requests stored before `before` (seconds since 1970) go: the retention rule (`SSH_REQUEST_KEEP_SECS`). */
  prune(before: number): number {
    return Number(
      this.db.prepare('DELETE FROM net_engine_ssh_requests WHERE stored_at<?').run(Math.floor(before))
        .changes
    )
  }
}

function toRequest(row: Row): SshRequest {
  const text = (key: string): string | undefined =>
    typeof row[key] === 'string' && row[key] !== '' ? (row[key] as string) : undefined
  let reply: Record<string, unknown> | undefined
  try {
    reply = text('reply') ? (JSON.parse(text('reply')!) as Record<string, unknown>) : undefined
  } catch {
    reply = undefined
  }
  return {
    requestId: String(row.request_id),
    issuedAt: Number(row.issued_at),
    joiner: String(row.joiner),
    joinerName: String(row.joiner_name),
    ...(text('selector') ? { selector: text('selector') } : {}),
    ...(text('new_label') ? { newLabel: text('new_label') } : {}),
    ...(text('profile') ? { profile: text('profile') } : {}),
    state: (text('state') as SshRequest['state']) ?? 'open',
    ...(text('row') ? { row: text('row') as SshRequest['row'] } : {}),
    ...(text('row_key') ? { rowKey: text('row_key') } : {}),
    ...(text('grant_id') ? { grantId: text('grant_id') } : {}),
    ...(reply ? { reply } : {}),
    storedAt: Number(row.stored_at)
  }
}
