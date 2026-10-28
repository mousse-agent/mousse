import { NetError, isId } from '../../../shared/net'
import type { NodeId } from '../../../shared/net'
import { isPermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import type { Clock } from '../contracts'
import type { NetDatabase } from './database'

/**
 * What this computer lets one other device do here, set on this computer alone. It never travels
 * in a signed document and needs no authority: any computer can protect itself.
 */
export interface NodePolicy {
  node: NodeId
  /** Every Bridge call, stream and routed call from the device is refused. */
  blocked: boolean
  /** The most permissive permission mode a person on the device can run a turn or rule in. */
  maxPermissionMode: PermissionMode
  /** The device may open terminals on this computer. */
  terminal: boolean
  /** The device may open its editor on a folder of this computer, over SSH to this computer's own SSH server. */
  editor: boolean
  createdAt: number
}
export type NodePolicyChange = Partial<
  Pick<NodePolicy, 'blocked' | 'maxPermissionMode' | 'terminal' | 'editor'>
>

/** A new computer starts at Auto-accept edits; the owner raises it to Full access per device. */
export const DEFAULT_MAX_PERMISSION_MODE: PermissionMode = 'accept_edits'
/** Terminals from another device are off until the owner turns them on for that device. */
export const DEFAULT_TERMINAL_ACCESS = false
/** Editor connections from another device are off until the owner turns them on for that device. */
export const DEFAULT_EDITOR_ACCESS = false

export interface NodePolicyEvent {
  node: NodeId
  before: NodePolicy
  after: NodePolicy
}

interface Row {
  node: string
  blocked: number
  max_permission_mode: string
  terminal: number
  editor: number
  created_at: number
}

const COLUMNS = 'node,blocked,max_permission_mode,terminal,editor,created_at'

/** `net_node_policy`, in the Net database. A node without a row has the defaults. */
export class SqliteNodePolicy {
  private readonly listeners = new Set<(event: NodePolicyEvent) => void>()
  /**
   * The blocked nodes, kept in memory: the check runs for every record pushed to every
   * subscriber, so it cannot be a query. This class is the only writer of the table, and the set
   * changes only once a write is committed.
   */
  private readonly blocked = new Set<string>()
  constructor(
    private readonly db: NetDatabase,
    private readonly clock: Clock
  ) {
    for (const row of this.db.database
      .prepare('SELECT node FROM net_node_policy WHERE blocked=1')
      .all())
      this.blocked.add(String(row.node))
  }

  get(node: NodeId): NodePolicy {
    const row = this.db.database
      .prepare(`SELECT ${COLUMNS} FROM net_node_policy WHERE node=?`)
      .get(node) as Row | undefined
    return row ? this.read(row) : this.defaults(node)
  }
  /** Read on every Bridge call and record push; answered from memory. */
  isBlocked(node: NodeId): boolean {
    return this.blocked.has(node)
  }
  list(): NodePolicy[] {
    return (
      this.db.database
        .prepare(`SELECT ${COLUMNS} FROM net_node_policy ORDER BY created_at,node`)
        .all() as unknown as Row[]
    ).map((row) => this.read(row))
  }
  set(node: NodeId, change: NodePolicyChange): NodePolicy {
    if (!isId('node', node)) throw new NetError('bad_request')
    if (
      (change.blocked !== undefined && typeof change.blocked !== 'boolean') ||
      (change.terminal !== undefined && typeof change.terminal !== 'boolean') ||
      (change.editor !== undefined && typeof change.editor !== 'boolean') ||
      (change.maxPermissionMode !== undefined && !isPermissionMode(change.maxPermissionMode))
    )
      throw new NetError('bad_request')
    let event: NodePolicyEvent | undefined
    this.db.transaction(() => {
      const before = this.get(node),
        after: NodePolicy = {
          ...before,
          ...(change.blocked === undefined ? {} : { blocked: change.blocked }),
          ...(change.terminal === undefined ? {} : { terminal: change.terminal }),
          ...(change.editor === undefined ? {} : { editor: change.editor }),
          ...(change.maxPermissionMode === undefined
            ? {}
            : { maxPermissionMode: change.maxPermissionMode })
        }
      this.db.charge(1)
      this.db.database
        .prepare(
          'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,editor,created_at) VALUES(?,?,?,?,?,?) ' +
            'ON CONFLICT(node) DO UPDATE SET blocked=excluded.blocked,max_permission_mode=excluded.max_permission_mode,terminal=excluded.terminal,editor=excluded.editor'
        )
        .run(
          node,
          after.blocked ? 1 : 0,
          after.maxPermissionMode,
          after.terminal ? 1 : 0,
          after.editor ? 1 : 0,
          after.createdAt || this.clock.now()
        )
      event = { node, before, after: this.get(node) }
      // Listeners end live work, so they run only once the row is durable.
      this.db.afterCommit(() => {
        if (event!.after.blocked) this.blocked.add(node)
        else this.blocked.delete(node)
        this.notify(event!)
      })
    })
    return event!.after
  }
  onChange(listener: (event: NodePolicyEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(event: NodePolicyEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        // One listener failing cannot keep a block from taking effect in the others.
      }
    }
  }
  private defaults(node: NodeId): NodePolicy {
    return {
      node,
      blocked: false,
      maxPermissionMode: DEFAULT_MAX_PERMISSION_MODE,
      terminal: DEFAULT_TERMINAL_ACCESS,
      editor: DEFAULT_EDITOR_ACCESS,
      createdAt: 0
    }
  }
  private read(row: Row): NodePolicy {
    return {
      node: row.node as NodeId,
      blocked: row.blocked === 1,
      // A mode this version does not know reads as the strictest one.
      maxPermissionMode: isPermissionMode(row.max_permission_mode)
        ? row.max_permission_mode
        : 'ask',
      terminal: row.terminal === 1,
      // Anything but a stored 1 reads as off, so a value this version does not know never grants shell access.
      editor: row.editor === 1,
      createdAt: row.created_at
    }
  }
}
