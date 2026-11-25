import type { NodeId } from '../../shared/net'
import { accessPresetOf, type AccessPresetFields } from '../../shared/net/accessPresets'
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

/** A device's level here, as far as its role depends on it. */
export type EngineLevel = AccessPresetFields & { blocked?: boolean }

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

export interface EngineRolesPort {
  peers: EnginePeerStore
  helper(): EngineHelper | undefined
  /** The device's level here now. */
  level(node: NodeId): EngineLevel
  /** Before a grant loses `owner`: what this computer serves the device ends (it connects again under the new role). */
  stopServing(node: NodeId): void
  changed(): void
}

/**
 * Keeps each grant's role following its device's level. The level is the truth: a change of level saves it first,
 * then changes the role (`grant.set_role`); a narrowing stops serving the device first (§8.3). A stop in between, or a
 * grant made as `owner` under a lower level by an older build, is repaired by `followAll` after each helper start.
 * A row added over SSH keeps the `owner` grant the SSH add made. One change at a time per device, each reading the
 * level when it runs; one that fails is shown on the row (`pending`) and tried again after `roleRetryMs`.
 */
export class EngineRoles {
  private readonly runs = new Map<NodeId, Promise<boolean>>()
  /** Devices whose role does not follow their level yet, with the helper's reason. */
  private readonly failed = new Map<NodeId, string>()
  private readonly retries = new Map<NodeId, ReturnType<typeof setTimeout>>()
  private stopped = false

  constructor(private readonly port: EngineRolesPort) {}

  /** Whether `node`'s role could not be made to follow its level (the row says so until it does). */
  pending(node: NodeId): boolean {
    return this.failed.has(node)
  }

  /** Makes `node`'s grant follow its level now: true once it does (or it holds no grant to change). */
  follow(node: NodeId): Promise<boolean> {
    const before = this.runs.get(node) ?? Promise.resolve(true)
    const run = before.catch(() => true).then(() => this.apply(node))
    this.runs.set(node, run)
    void run.finally(() => {
      if (this.runs.get(node) === run) this.runs.delete(node)
    })
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

  stop(): void {
    this.stopped = true
    for (const timer of this.retries.values()) clearTimeout(timer)
    this.retries.clear()
  }

  private async apply(node: NodeId): Promise<boolean> {
    const helper = this.port.helper()
    const row = this.port.peers.serving(node)
    if (this.stopped || !helper || !row?.grant || row.source === 'ssh' || !helper.has('grant-roles'))
      return this.settled(node)
    const want = roleForLevel(this.port.level(node))
    const grant = Number(row.grant)
    for (let attempt = 1; ; attempt++) {
      let held: { role: string; revision: number } | undefined
      try {
        const listed = await helper.request('grants.list')
        const found = (Array.isArray(listed.grants) ? listed.grants : []).find(
          (item: Record<string, unknown>) => Number(item?.grant) === grant
        )
        if (found)
          held = {
            role: typeof found.role === 'string' ? found.role : OWNER_ROLE,
            revision: typeof found.revision === 'number' ? found.revision : 1
          }
      } catch (error) {
        return this.fail(node, error)
      }
      // No such grant: nothing is served under it.
      if (!held || held.role === want) return this.settled(node)
      if (held.role === OWNER_ROLE) this.port.stopServing(node)
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
    this.failed.set(node, helperCode(error) ?? 'helper')
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
