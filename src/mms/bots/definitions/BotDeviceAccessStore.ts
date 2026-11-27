import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isId } from '../../../shared/net/ids'
import {
  DEFAULT_BOT_DEVICE_ACCESS,
  MAX_BOT_DEVICES,
  UNREADABLE_BOT_DEVICE_ACCESS,
  botDeviceAccessProblem,
  type BotDeviceAccess,
  type StoredBotDeviceAccess
} from '../../../shared/bots/personal/deviceAccess'
import { atomicWriteJsonSync } from '../../data/AtomicFs'

/**
 * Which devices reach each personal bot (`BotDeviceAccess`), kept on the bot's home computer in
 * `<profile>/bots/device-access.json`, beside the bot definitions and apart from `bots.db`, so no database version moves:
 *
 *     { "version": 2, "bots": { "<botId>": { "mode": "chosen", "nodes": ["nod_…"] } } }
 *
 * - Version 2: each list is explicit. A bot without an entry reaches this computer alone, so a new bot starts there and a
 *   device linked later reaches no bot until the owner ticks it.
 * - No file, or version 1 (an earlier build's, where "All my devices" and a bot without an entry meant every device):
 *   read as it was until the one-time snapshot (`snapshot`), which writes version 2 with every such bot's list set to
 *   the devices linked at that moment, so nobody loses a bot they reached. It runs once, as soon as the account's
 *   devices can be read, before Bridge serves any device; a file at version 2 is never snapshotted again.
 * - A file or an entry that can't be read (not JSON, a version this build does not know, a value it does not know): this
 *   computer alone for the bots it covers. A file that can't be read at all covers every bot, and the first change after
 *   it (the snapshot too) puts it aside (`device-access.json.corrupt-<time>`) and writes version 2, so the other bots
 *   stay there until the owner picks for them.
 *
 * Only this computer's own window (About) and its command line change it, through `bots.devices.set`; a new bot's choice
 * (New bot, or the device that made it) is saved before the bot is published, so no device outside it ever lists the
 * bot. Mousse's own data is closed to a bot's file tools.
 */
export const BOT_DEVICE_ACCESS_FILE = 'device-access.json'

interface StoredFile {
  version: 1 | 2
  bots: Record<string, StoredBotDeviceAccess>
  /** Version 1 only: what a bot without an entry means; absent, every device. Written only after a file that could not be read. */
  missing?: 'this_computer'
}

interface State {
  /** The stat the state was read at, so a file changed by hand is read again. */
  key: string
  /** The file could not be read: every bot is this computer alone. */
  broken: boolean
  /** 1 (or no file): the snapshot has not run yet. 2: every list is explicit. */
  version: 1 | 2
  bots: Map<string, { access: StoredBotDeviceAccess; unreadable: boolean }>
  missing: StoredBotDeviceAccess
}

const EVERY_DEVICE: StoredBotDeviceAccess = Object.freeze({ mode: 'all' }) as StoredBotDeviceAccess

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** A copy of a choice, with its devices in a stable order. */
function copyOf<T extends StoredBotDeviceAccess>(access: T): T {
  return (access.mode === 'chosen' ? { mode: 'chosen', nodes: [...access.nodes] } : { mode: access.mode }) as T
}

/** A version 1 entry: what version 2 knows, or every device. */
function legacyProblem(value: unknown): string | undefined {
  if (plain(value) && value.mode === 'all' && Object.keys(value).length === 1) return undefined
  return botDeviceAccessProblem(value)
}

export class BotDeviceAccessStore {
  private state?: State
  private readonly listeners = new Set<() => void>()
  readonly path: string

  constructor(
    /** `<profile>/bots`. */
    private readonly folder: string,
    private readonly now: () => number = () => Date.now()
  ) {
    this.path = join(folder, BOT_DEVICE_ACCESS_FILE)
  }

  /**
   * The bot's choice; `unreadable` when it stands at this computer alone because what is stored can't be read. Before
   * the snapshot, an older file's every device reads as `{ mode: 'all' }`.
   */
  get(botId: string): { access: StoredBotDeviceAccess; unreadable: boolean } {
    const state = this.read()
    const entry = state.bots.get(botId)
    if (entry) return { access: copyOf(entry.access), unreadable: entry.unreadable }
    return { access: copyOf(state.missing), unreadable: state.broken }
  }

  /**
   * Whether the bot has a choice of its own stored (one that can't be read counts): a choice made on New bot, in About,
   * or for the device that made it. A bot without one has what every such bot has.
   */
  saved(botId: string): boolean {
    return this.read().bots.has(botId)
  }

  /** Every stored choice, and what a bot without one has: enough to tell quickly that no bot is held from anyone. */
  choices(): { others: StoredBotDeviceAccess; bots: StoredBotDeviceAccess[] } {
    const state = this.read()
    return { others: copyOf(state.missing), bots: [...state.bots.values()].map((entry) => copyOf(entry.access)) }
  }

  /** Whether the one-time snapshot is still to run: no file yet, or an earlier build's (version 1). */
  needsSnapshot(): boolean {
    const state = this.read()
    return state.broken || state.version === 1
  }

  /**
   * The one-time move to explicit lists, on the first start after an update. Each bot of `bots` (every bot this profile
   * has made) whose choice is every device ("All my devices", or none stored) gets the list of `devices`, the owner's
   * other devices linked now; one with no devices gets this computer alone. Every other choice is kept as it is, and one
   * that can't be read stays at this computer alone. A file that can't be read is put aside and every bot stays at this
   * computer alone. Written at version 2, so it never runs again: true when it ran now.
   */
  snapshot(bots: Iterable<string>, devices: readonly string[]): boolean {
    const state = this.read()
    if (!state.broken && state.version === 2) return false
    const linked = [...new Set(devices)].filter((node) => isId('node', node)).slice(0, MAX_BOT_DEVICES)
    const every: BotDeviceAccess = linked.length ? { mode: 'chosen', nodes: linked } : { mode: 'this_computer' }
    const out: Record<string, BotDeviceAccess> = {}
    if (state.broken) this.putAside()
    else {
      const resolve = (access: StoredBotDeviceAccess, unreadable: boolean): BotDeviceAccess =>
        unreadable ? { mode: 'this_computer' } : access.mode === 'all' ? copyOf(every) : copyOf(access)
      for (const [id, entry] of state.bots) out[id] = resolve(entry.access, entry.unreadable)
      for (const id of bots) if (!(id in out)) out[id] = resolve(state.missing, false)
    }
    this.write({ version: 2, bots: out })
    return true
  }

  /** Saves the bot's choice (validated), over what is stored; every other bot keeps its own. */
  set(botId: string, access: BotDeviceAccess): void {
    const problem = botDeviceAccessProblem(access)
    if (problem) throw new Error(problem)
    const state = this.read()
    if (state.broken) {
      // Nothing of what was stored can be trusted: every other bot stays at this computer alone.
      this.putAside()
      this.write({ version: 2, bots: { [botId]: copyOf(access) } })
      return
    }
    const bots: Record<string, StoredBotDeviceAccess> = {}
    for (const [id, entry] of state.bots) bots[id] = copyOf(entry.access)
    bots[botId] = copyOf(access)
    this.write(this.fileLike(state, bots))
  }

  /**
   * Takes devices that are no longer on the account off every bot's list (`present` says which are). A device removed
   * from the account and added again starts with no bot picked for it. Nothing is written when nothing changes, nor
   * while the file can't be read.
   */
  dropDevices(present: (node: string) => boolean): boolean {
    const state = this.read()
    if (state.broken) return false
    let changed = false
    const bots: Record<string, StoredBotDeviceAccess> = {}
    for (const [id, entry] of state.bots) {
      const access = entry.access
      if (access.mode === 'chosen' && !entry.unreadable) {
        const nodes = access.nodes.filter(present)
        if (nodes.length !== access.nodes.length) changed = true
        bots[id] = { mode: 'chosen', nodes }
      } else bots[id] = copyOf(access)
    }
    if (!changed) return false
    this.write(this.fileLike(state, bots))
    return true
  }

  /**
   * Takes the choices of bots that were never made off the file (`known` says which bots exist, deleted ones too): a
   * new bot's choice is saved before the bot itself, so a crash between the two leaves one behind. Nothing is written when
   * nothing changes, nor while the file can't be read.
   */
  dropBots(known: (botId: string) => boolean): boolean {
    const state = this.read()
    if (state.broken) return false
    const bots: Record<string, StoredBotDeviceAccess> = {}
    for (const [id, entry] of state.bots) if (known(id)) bots[id] = copyOf(entry.access)
    if (Object.keys(bots).length === state.bots.size) return false
    this.write(this.fileLike(state, bots))
    return true
  }

  /** Takes one bot's choice off the file: a new bot whose choice was saved but which could not be made. */
  forget(botId: string): void {
    const state = this.read()
    if (state.broken || !state.bots.has(botId)) return
    const bots: Record<string, StoredBotDeviceAccess> = {}
    for (const [id, entry] of state.bots) if (id !== botId) bots[id] = copyOf(entry.access)
    this.write(this.fileLike(state, bots))
  }

  /** Called after every change this store makes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** The file as it is, with these choices: before the snapshot, still version 1 with its default. */
  private fileLike(state: State, bots: Record<string, StoredBotDeviceAccess>): StoredFile {
    if (state.version === 2) return { version: 2, bots }
    return { version: 1, bots, ...(state.missing.mode !== 'all' ? { missing: 'this_computer' as const } : {}) }
  }

  private write(file: StoredFile): void {
    mkdirSync(this.folder, { recursive: true })
    atomicWriteJsonSync(this.path, file)
    this.state = undefined
    this.read()
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One listener failing does not keep the others from hearing of the change.
      }
    }
  }

  private putAside(): void {
    try {
      renameSync(this.path, `${this.path}.corrupt-${this.now()}`)
    } catch {
      // Nothing to keep (it went away meanwhile): the new file replaces nothing.
    }
  }

  private read(): State {
    let key: string
    try {
      const stat = statSync(this.path)
      key = `${stat.mtimeMs}:${stat.size}:${stat.ino}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
        // Never written: an earlier build's every device, until the snapshot.
        if (this.state?.key !== 'none') this.state = { key: 'none', broken: false, version: 1, bots: new Map(), missing: EVERY_DEVICE }
        return this.state!
      }
      return { key: 'error', broken: true, version: 2, bots: new Map(), missing: UNREADABLE_BOT_DEVICE_ACCESS }
    }
    if (this.state?.key === key) return this.state
    this.state = this.parse(key)
    return this.state
  }

  private parse(key: string): State {
    const broken: State = { key, broken: true, version: 2, bots: new Map(), missing: UNREADABLE_BOT_DEVICE_ACCESS }
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return broken
    }
    if (!plain(value) || !plain(value.bots)) return broken
    const version = value.version
    if (version === 2 ? value.missing !== undefined : version !== 1 || (value.missing !== undefined && value.missing !== 'this_computer'))
      return broken
    const problem = version === 2 ? botDeviceAccessProblem : legacyProblem
    const bots = new Map<string, { access: StoredBotDeviceAccess; unreadable: boolean }>()
    for (const [botId, access] of Object.entries(value.bots))
      bots.set(
        botId,
        problem(access)
          ? { access: UNREADABLE_BOT_DEVICE_ACCESS, unreadable: true }
          : { access: copyOf(access as StoredBotDeviceAccess), unreadable: false }
      )
    const missing = version === 2 || value.missing === 'this_computer' ? DEFAULT_BOT_DEVICE_ACCESS : EVERY_DEVICE
    return { key, broken: false, version: version === 2 ? 2 : 1, bots, missing }
  }
}
