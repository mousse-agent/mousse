import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HarnessDriverKind } from '../../shared/harness/types'
import {
  ANTIGRAVITY_INSTANCE_ID,
  CLAUDE_INSTANCE_ID,
  CODEX_INSTANCE_ID
} from '../../shared/providerInstances'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/**
 * Instance identity and counters. Built-in instances keep their ids (`claude`, `codex`,
 * `antigravity`, `pi:<provider>`); an added one gets `<driver>:<slug>`. Each instance has a config
 * revision (bumped when its settings change) and an account generation (bumped when its signed-in
 * account changes), recorded in `<profileHome>/harness/state.json` and copied into every execution
 * binding so a session is resumed only on the account, home and config it was made with.
 */

const BUILT_IN_IDS: Partial<Record<HarnessDriverKind, string>> = {
  claude: CLAUDE_INSTANCE_ID,
  codex: CODEX_INSTANCE_ID,
  antigravity: ANTIGRAVITY_INSTANCE_ID
}

/** The instance on the user's own setup for a driver; removable like any other. Every pi instance comes from its provider's sign-in. */
export function isBuiltInInstance(instanceId: string, driver: HarnessDriverKind): boolean {
  return driver === 'pi' || BUILT_IN_IDS[driver] === instanceId
}

/** The id an instance on the user's own setup takes, when the driver has one. */
export function defaultInstanceId(driver: HarnessDriverKind): string | undefined {
  return BUILT_IN_IDS[driver]
}

/** `<driver>:<slug>` for a new instance, unique among `existing`. */
export function addedInstanceId(driver: HarnessDriverKind, displayName: string | undefined, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const slug = (displayName ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  const base = slug && slug !== 'default' ? `${driver}:${slug}` : `${driver}:2`
  if (!taken.has(base)) return base
  for (let index = 2; ; index += 1) {
    const candidate = slug ? `${driver}:${slug}-${index}` : `${driver}:${index}`
    if (!taken.has(candidate)) return candidate
  }
}

/** `<profileHome>/harness/<instanceId>` with characters a file name cannot hold replaced. */
export function instanceStateDir(profileHome: string, instanceId: string): string {
  return join(profileHome, 'harness', instanceId.replace(/[^A-Za-z0-9._-]/g, '_'))
}

export interface InstanceCounters {
  configRevision: number
  accountGeneration: number
  /** Last account the instance reported, as `accountIdentity()` hashes it (never an email). */
  accountId?: string
}

interface StateFile {
  version: 1
  /** Per-profile salt of account hashes, so the same account reads differently in another profile. */
  salt?: string
  instances: Record<string, InstanceCounters>
}

function counters(value: unknown): InstanceCounters | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const count = (entry: unknown) => (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0 ? entry : 0)
  return {
    configRevision: count(raw.configRevision),
    accountGeneration: count(raw.accountGeneration),
    ...(typeof raw.accountId === 'string' && raw.accountId ? { accountId: raw.accountId } : {})
  }
}

export class InstanceCounterStore {
  private readonly path: string
  private state?: StateFile

  constructor(profileHome: string) {
    this.path = join(profileHome, 'harness', 'state.json')
  }

  get(instanceId: string): InstanceCounters {
    return this.read().instances[instanceId] ?? { configRevision: 0, accountGeneration: 0 }
  }

  /**
   * The account identity of `subject` (the vendor's stable account id, never shown or stored) in
   * the home `homeId`: a salted one-way hash.
   */
  accountIdentity(homeId: string, subject: string): string {
    return createHash('sha256').update(`${this.salt()}|${homeId}|${subject}`).digest('hex').slice(0, 32)
  }

  /**
   * `subject` hashed with the profile's salt but without a home: two instances signed in to the same
   * account read the same, which is how the page tells the user. Kept in memory only, never shown.
   */
  accountFingerprint(subject: string): string {
    return createHash('sha256').update(`${this.salt()}|account|${subject}`).digest('hex').slice(0, 32)
  }

  /** The profile's salt, created and saved on first use. */
  private salt(): string {
    const state = this.read()
    if (state.salt) return state.salt
    const salt = randomBytes(16).toString('hex')
    this.write({ ...state, salt })
    return salt
  }

  bumpConfig(instanceId: string): InstanceCounters {
    return this.update(instanceId, (current) => ({ ...current, configRevision: current.configRevision + 1 }))
  }

  /** The account generation moves on (sign-out, a different account). */
  bumpAccount(instanceId: string, accountId?: string): InstanceCounters {
    return this.update(instanceId, (current) => {
      const next: InstanceCounters = { configRevision: current.configRevision, accountGeneration: current.accountGeneration + 1 }
      if (accountId) next.accountId = accountId
      return next
    })
  }

  /** Records the account a check reported; true when it differs from the last one (generation bumped). */
  noteAccount(instanceId: string, accountId: string): boolean {
    const current = this.get(instanceId)
    if (current.accountId === accountId) return false
    if (current.accountId === undefined) {
      this.update(instanceId, (value) => ({ ...value, accountId }))
      return false
    }
    this.bumpAccount(instanceId, accountId)
    return true
  }

  forget(instanceId: string): void {
    const state = this.read()
    if (!state.instances[instanceId]) return
    const { [instanceId]: _removed, ...rest } = state.instances
    this.write({ ...state, instances: rest })
  }

  private read(): StateFile {
    if (this.state) return this.state
    const state: StateFile = { version: 1, instances: {} }
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { salt?: unknown; instances?: Record<string, unknown> }
      if (typeof raw.salt === 'string' && /^[0-9a-f]{32}$/.test(raw.salt)) state.salt = raw.salt
      for (const [instanceId, value] of Object.entries(raw.instances ?? {})) {
        const entry = counters(value)
        if (entry && instanceId !== '__proto__') state.instances[instanceId] = entry
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        console.warn('[harness] could not read instance state; counting from zero', error instanceof Error ? error.message : String(error))
    }
    return (this.state = state)
  }

  private update(instanceId: string, change: (current: InstanceCounters) => InstanceCounters): InstanceCounters {
    const next = change(this.get(instanceId))
    const state = this.read()
    this.write({ ...state, instances: { ...state.instances, [instanceId]: next } })
    return next
  }

  private write(state: StateFile): void {
    this.state = state
    try {
      atomicWriteJsonSync(this.path, state)
    } catch (error) {
      console.warn('[harness] could not save instance state', error instanceof Error ? error.message : String(error))
    }
  }
}
