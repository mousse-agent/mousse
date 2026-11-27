import { NetError, isId } from '../../../shared/net'
import type { NodeId } from '../../../shared/net'
import { isPermissionMode, type PermissionMode } from '../../../shared/permissionMode'
import type { Clock } from '../contracts'
import type { NetDatabase } from './database'
import { AGENT_REACHES, isAgentReach, isBotLevel, type AgentReach, type BotLevel } from '../../../shared/net/local'

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
  /**
   * What the device may do with this computer's personal bots (`BotLevel`; each bot's own Devices choice still
   * applies). Off, it reaches none of them: they are in none of its lists and every bot call from it is refused. Apart
   * from thread access: neither changes the other.
   */
  bots: BotLevel
  /**
   * Which threads here the device's agents may change with calls marked as an agent's (`ROUTED_AGENT_KEY`): `none`,
   * the threads its agents started here (`launched`, the default), or `all`. Decided at each call from this computer's
   * own record of who started a thread (`startedFrom`), so a change applies at once. A policy for honest callers, not a
   * boundary: a person's calls from the device are not marked and are held to the other fields only.
   */
  agentReach: AgentReach
  /**
   * A person or an agent on the device may work on threads here: start, send, steer, stop, queue, change settings and
   * files, and run Git (the `work` class of `shared/net/accessClasses.ts`). Off, it still reads threads, every family
   * alike, checked on every call and every saved result. Bots follow `bots` alone.
   */
  work: boolean
  createdAt: number
}
export type NodePolicyChange = Partial<
  Pick<
    NodePolicy,
    'blocked' | 'maxPermissionMode' | 'terminal' | 'editor' | 'bots' | 'agentReach' | 'work'
  >
>

export { AGENT_REACHES, isAgentReach, type AgentReach }
/** A device's agents change only the threads they started here, until a person on this computer allows more. */
export const DEFAULT_AGENT_REACH: AgentReach = 'launched'

/** A new computer starts at Auto-accept edits; the owner raises it to Full access per device. */
export const DEFAULT_MAX_PERMISSION_MODE: PermissionMode = 'accept_edits'
/** Terminals from another device are off until the owner turns them on for that device. */
export const DEFAULT_TERMINAL_ACCESS = false
/** Editor connections from another device are off until the owner turns them on for that device. */
export const DEFAULT_EDITOR_ACCESS = false
/**
 * A new device uses this computer's bots until the owner changes its level. Each bot's Devices starts at this computer
 * alone, so it still reaches no bot until the owner adds it to one.
 */
export const DEFAULT_BOT_LEVEL: BotLevel = 'use'
/** Every device works on threads here until the owner makes it view only (as before the switch existed). */
export const DEFAULT_WORK_ACCESS = true

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
  bots: string
  agent_reach: string
  work: number
  created_at: number
}

const COLUMNS = 'node,blocked,max_permission_mode,terminal,editor,bots,agent_reach,work,created_at'

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
      (change.bots !== undefined && !isBotLevel(change.bots)) ||
      (change.work !== undefined && typeof change.work !== 'boolean') ||
      (change.maxPermissionMode !== undefined && !isPermissionMode(change.maxPermissionMode)) ||
      (change.agentReach !== undefined && !isAgentReach(change.agentReach))
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
          ...(change.bots === undefined ? {} : { bots: change.bots }),
          ...(change.work === undefined ? {} : { work: change.work }),
          ...(change.agentReach === undefined ? {} : { agentReach: change.agentReach }),
          ...(change.maxPermissionMode === undefined
            ? {}
            : { maxPermissionMode: change.maxPermissionMode })
        }
      this.db.charge(1)
      this.db.database
        .prepare(
          'INSERT INTO net_node_policy(node,blocked,max_permission_mode,terminal,editor,bots,agent_reach,work,created_at) VALUES(?,?,?,?,?,?,?,?,?) ' +
            'ON CONFLICT(node) DO UPDATE SET blocked=excluded.blocked,max_permission_mode=excluded.max_permission_mode,terminal=excluded.terminal,editor=excluded.editor,bots=excluded.bots,agent_reach=excluded.agent_reach,work=excluded.work'
        )
        .run(
          node,
          after.blocked ? 1 : 0,
          after.maxPermissionMode,
          after.terminal ? 1 : 0,
          after.editor ? 1 : 0,
          after.bots,
          after.agentReach,
          after.work ? 1 : 0,
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
      bots: DEFAULT_BOT_LEVEL,
      agentReach: DEFAULT_AGENT_REACH,
      work: DEFAULT_WORK_ACCESS,
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
      // A value this version does not know never lets a device reach a bot.
      bots: isBotLevel(row.bots) ? row.bots : 'off',
      // A value this version does not know reaches nothing.
      agentReach: isAgentReach(row.agent_reach) ? row.agent_reach : 'none',
      // Only a stored 1 is on: a value this version does not know leaves the device to view threads.
      work: row.work === 1,
      createdAt: row.created_at
    }
  }
}
