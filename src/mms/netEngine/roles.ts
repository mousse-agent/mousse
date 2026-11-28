import type { NodeId } from '../../shared/net'
import { accessPresetOf, type ControlFields } from '../../shared/net/accessPresets'
import {
  DEFAULT_AGENT_REACH,
  DEFAULT_EDITOR_ACCESS,
  DEFAULT_MAX_PERMISSION_MODE,
  DEFAULT_TERMINAL_ACCESS,
  DEFAULT_WORK_ACCESS
} from '../net/store/nodePolicy'
import { helperCode } from './helper/appChannel'
import type { EngineHelper } from './helper/connections'
import { engineLimits } from './limits'
import type { EnginePeerStore } from './store'

/**
 * The role a grant holds at the helper (pairing flow design §8). The helper reads only `owner`: a caller with it gets
 * this computer's device list (`mousse-grants`) and may remove other devices here with a signed removal. Every
 * other right is the device's level in the app (`net_node_policy`), checked on every call.
 */
export type EngineGrantRole = 'owner' | 'work' | 'view'
export const OWNER_ROLE: EngineGrantRole = 'owner'

/** A device's level here, as far as its role depends on it: the control fields, never its bot level. */
export type EngineLevel = ControlFields & { blocked?: boolean }

/** The level of a device with no saved policy (`SqliteNodePolicy`'s defaults): Work on threads. */
export const DEFAULT_LEVEL: EngineLevel = Object.freeze({
  blocked: false,
  work: DEFAULT_WORK_ACCESS,
  terminal: DEFAULT_TERMINAL_ACCESS,
  editor: DEFAULT_EDITOR_ACCESS,
  maxPermissionMode: DEFAULT_MAX_PERMISSION_MODE,
  agentReach: DEFAULT_AGENT_REACH
})

/** `owner` only for exactly Full control, not blocked; `view` when it may not work on threads, else `work`. */
export function roleForLevel(level: EngineLevel): EngineGrantRole {
  if (!level.blocked && accessPresetOf(level) === 'full') return OWNER_ROLE
  return level.work ? 'work' : 'view'
}

/** `level` with the fields `change` sets, as saving it would make it. */
export function levelAfter<T extends EngineLevel>(level: T, change: Partial<EngineLevel>): T {
  const set = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined))
  return { ...level, ...set }
}

const WIDTH: Record<string, number> = { view: 1, work: 2, owner: 3 }
/** How much a role lets a device do at the helper; one this build does not know counts as the widest. */
const widthOf = (role: string): number => WIDTH[role] ?? 4

/** Why a device's role does not follow its level yet: the helper cannot take roles at all. */
export const ROLES_UNSUPPORTED = 'not_supported'

export interface EngineRolesPort {
  peers: EnginePeerStore
  helper(): EngineHelper | undefined
  /** The device's level here now. */
  level(node: NodeId): EngineLevel
  /** Before a grant narrows: what this computer serves the device ends (it connects again under the new role). */
  stopServing(node: NodeId): void
  changed(): void
}

/**
 * Keeps each grant's role following its device's level (rows added over SSH too). The level is the truth for every
 * right here; the role is never wider than it. A change of level is ordered so a stop between its two writes can
 * only leave the role narrower: a narrowing stops serving the device (§8.3) and moves the role before the level is
 * saved; any other change saves the level first. What is left over (a role an older build made, a write that
 * failed) is moved by `followAll` straight after each helper's hello. A role not applied (no helper, a helper
 * without roles, an edit that failed) is never reported as applied: the row shows it (`pending`) and it is tried
 * again every `roleRetryMs`. One change at a time per device, each reading the level when it runs.
 */
export class EngineRoles {
  private readonly runs = new Map<NodeId, Promise<boolean>>()
  /** Devices whose role does not follow their level yet, with the helper's reason. */
  private readonly failed = new Map<NodeId, string>()
  private readonly retries = new Map<NodeId, ReturnType<typeof setTimeout>>()
  /** The role each device's computer said this one holds there, being recorded. */
  private readonly records = new Map<NodeId, Promise<void>>()
  private stopped = false

  constructor(private readonly port: EngineRolesPort) {}

  /** Whether `node`'s role could not be made to follow its level (the row says so until it does). */
  pending(node: NodeId): boolean {
    return this.failed.has(node)
  }

  /** Why `node`'s role is pending (`ROLES_UNSUPPORTED`, or the helper's code); undefined when it is not. */
  reason(node: NodeId): string | undefined {
    return this.failed.get(node)
  }

  /** Makes `node`'s grant follow its level now: true once it does (or it holds no grant to change). */
  follow(node: NodeId): Promise<boolean> {
    return this.queue(node, () => this.apply(node))
  }

  /**
   * A change of `node`'s level to `next`, which `save` writes. A narrowing of the role stops serving the device and
   * moves the role first, then saves the level (whether or not the role moved: a narrower level is always safe);
   * anything else saves the level first, then moves the role. True once the role follows the saved level.
   */
  change(node: NodeId, next: EngineLevel, save: () => void): Promise<boolean> {
    return this.queue(node, async () => {
      // The role this level needs is the one it has: with no helper there is nothing this change must apply.
      if (!this.port.helper() && !this.pending(node) && roleForLevel(this.port.level(node)) === roleForLevel(next)) {
        save()
        return true
      }
      const narrowing = await this.narrowing(node, roleForLevel(next))
      if (!narrowing) {
        save()
        return this.apply(node)
      }
      const moved = await this.move(node, narrowing.grant, roleForLevel(next))
      try {
        save()
      } catch (error) {
        // Not saved: the role goes back to the level that stays.
        void this.follow(node)
        throw error
      }
      return moved
    })
  }

  private queue(node: NodeId, step: () => Promise<boolean>): Promise<boolean> {
    const before = this.runs.get(node) ?? Promise.resolve(true)
    const run = before.catch(() => true).then(step)
    this.runs.set(node, run)
    const done = () => {
      if (this.runs.get(node) === run) this.runs.delete(node)
    }
    // The caller hears a failure from `run` itself.
    run.then(done, done)
    return run
  }

  /** After a helper start: every grant follows its device's level. */
  async followAll(): Promise<void> {
    await Promise.all(
      this.port.peers
        .all()
        .filter((row) => row.grant)
        .map((row) => this.follow(row.localId))
    )
  }

  /**
   * The other computer's hello said this computer's role there (§8.4): the helper's record of it follows, so
   * "Remove on all my hosts" lists that computer only while this one is an owner there. Display and convenience
   * only: that computer enforces from its own grant. One record at a time per device; a failure waits for the next
   * connection's hello.
   */
  recordThere(node: NodeId, role: string): Promise<void> {
    const before = this.records.get(node) ?? Promise.resolve()
    const run = before.then(() => this.record(node, role)).catch(() => undefined)
    this.records.set(node, run)
    void run.finally(() => {
      if (this.records.get(node) === run) this.records.delete(node)
    })
    return run
  }

  stop(): void {
    this.stopped = true
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
  }

  private async record(node: NodeId, role: string): Promise<void> {
    const helper = this.port.helper()
    const row = this.port.peers.serving(node)
    if (this.stopped || !helper || !row) return
    const listed = await helper.request('peers.list')
    const peer = (Array.isArray(listed.peers) ? listed.peers : []).find(
      (item: Record<string, unknown>) => item?.identity === row.endpoint
    )
    // Not a computer this one uses, or recorded already.
    if (!peer || peer.role === role) return
    await helper.request('peer.add', {
      identity: row.endpoint,
      name: typeof peer.name === 'string' ? peer.name : row.name,
      role
    })
  }

  /** The role `node`'s grant follows its saved level now. */
  private apply(node: NodeId): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    const row = this.port.peers.serving(node)
    // Nothing granted here: nothing to apply.
    if (!row?.grant) return Promise.resolve(this.settled(node))
    return this.move(node, Number(row.grant), roleForLevel(this.port.level(node)))
  }

  /** The grant `node` holds, when moving it to `want` narrows it; undefined otherwise (or when it cannot be read). */
  private async narrowing(node: NodeId, want: string): Promise<{ grant: number } | undefined> {
    const helper = this.port.helper()
    const row = this.port.peers.serving(node)
    if (this.stopped || !helper?.has('grant-roles') || !row?.grant) return undefined
    const grant = Number(row.grant)
    const held = await this.held(helper, grant).catch(() => undefined)
    return held && widthOf(want) < widthOf(held.role) ? { grant } : undefined
  }

  private async held(helper: EngineHelper, grant: number): Promise<{ role: string; revision: number } | undefined> {
    const listed = await helper.request('grants.list')
    const found = (Array.isArray(listed.grants) ? listed.grants : []).find(
      (item: Record<string, unknown>) => Number(item?.grant) === grant
    )
    if (!found) return undefined
    return {
      role: typeof found.role === 'string' ? found.role : OWNER_ROLE,
      revision: typeof found.revision === 'number' ? found.revision : 1
    }
  }

  /**
   * Moves `grant` to `want`. Every narrowing first ends what this computer serves the device (its running calls
   * too), not only one from `owner`. No helper, or one that cannot take roles below `owner`, leaves it pending.
   */
  private async move(node: NodeId, grant: number, want: string): Promise<boolean> {
    const helper = this.port.helper()
    if (!helper) return this.fail(node, 'helper_down')
    // A helper without roles makes every grant `owner`: right only for Full control.
    if (!helper.has('grant-roles')) return want === OWNER_ROLE ? this.settled(node) : this.fail(node, ROLES_UNSUPPORTED)
    for (let attempt = 1; ; attempt++) {
      let held: { role: string; revision: number } | undefined
      try {
        held = await this.held(helper, grant)
      } catch (error) {
        return this.fail(node, error)
      }
      // No such grant: nothing is served under it.
      if (!held || held.role === want) return this.settled(node)
      if (widthOf(want) < widthOf(held.role)) this.port.stopServing(node)
      try {
        await helper.request('grant.set_role', { grant, expected_revision: held.revision, role: want })
        return this.settled(node)
      } catch (error) {
        const code = helperCode(error)
        if (code === 'no_grant') return this.settled(node)
        if (code === 'revision_conflict' && attempt < engineLimits().roleEditTries) continue
        return this.fail(node, error)
      }
    }
  }

  private settled(node: NodeId): boolean {
    clearTimeout(this.retries.get(node))
    this.retries.delete(node)
    if (this.failed.delete(node)) this.port.changed()
    return true
  }

  private fail(node: NodeId, error: unknown): boolean {
    if (this.stopped) return false
    const first = !this.failed.has(node)
    this.failed.set(node, typeof error === 'string' ? error : (helperCode(error) ?? 'helper'))
    if (first) this.port.changed()
    if (!this.retries.has(node)) {
      const timer = setTimeout(() => {
        this.retries.delete(node)
        if (!this.stopped) void this.follow(node)
      }, engineLimits().roleRetryMs)
      timer.unref?.()
      this.retries.set(node, timer)
    }
    return false
  }
}
