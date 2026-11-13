import { mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_BOT_DEVICE_ACCESS,
  UNREADABLE_BOT_DEVICE_ACCESS,
  botDeviceAccessProblem,
  type BotDeviceAccess
} from '../../../shared/bots/personal/deviceAccess'
import { atomicWriteJsonSync } from '../../data/AtomicFs'

/**
 * Which devices reach each personal bot (`BotDeviceAccess`), kept on the bot's home computer in
 * `<profile>/bots/device-access.json`, beside the bot definitions and apart from `bots.db`, so no database version moves
 * and an older build simply ignores it:
 *
 *     { "version": 1, "bots": { "<botId>": { "mode": "chosen", "nodes": ["nod_…"] } } }
 *
 * - No file, or a bot that has no entry: every device, as before this setting existed. So an update changes nothing,
 *   and a bot made later starts on every device.
 * - A file or an entry that can't be read (not JSON, another version, a value this build does not know): this computer
 *   alone for the bots it covers. A file that can't be read at all covers every bot, and the first change after it puts
 *   it aside (`device-access.json.corrupt-<time>`) and writes `missing: "this_computer"`, so the other bots stay there
 *   until the owner picks for them.
 *
 * Only this computer's own window (About) and its command line change it, through `bots.devices.set`, and the bot that
 * a device makes (so the device that made it can reach it). Mousse's own data is closed to a bot's file tools.
 */
export const BOT_DEVICE_ACCESS_FILE = 'device-access.json'

interface StoredFile {
  version: 1
  bots: Record<string, BotDeviceAccess>
  /** What a bot without an entry means; absent, every device. Written only after a file that could not be read. */
  missing?: 'this_computer'
}

interface State {
  /** The stat the state was read at, so a file changed by hand is read again. */
  key: string
  /** The file could not be read: every bot is this computer alone. */
  broken: boolean
  bots: Map<string, { access: BotDeviceAccess; unreadable: boolean }>
  missing: BotDeviceAccess
}

const plain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

/** A copy of a valid choice, with its devices in a stable order. */
function copyOf(access: BotDeviceAccess): BotDeviceAccess {
  return access.mode === 'chosen' ? { mode: 'chosen', nodes: [...access.nodes] } : { mode: access.mode }
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

  /** The bot's choice; `unreadable` when it stands at this computer alone because what is stored can't be read. */
  get(botId: string): { access: BotDeviceAccess; unreadable: boolean } {
    const state = this.read()
    const entry = state.bots.get(botId)
    if (entry) return { access: copyOf(entry.access), unreadable: entry.unreadable }
    return { access: copyOf(state.missing), unreadable: state.broken }
  }

  /** Every stored choice, and what a bot without one has: enough to tell quickly that no bot is held from anyone. */
  choices(): { others: BotDeviceAccess; bots: BotDeviceAccess[] } {
    const state = this.read()
    return { others: copyOf(state.missing), bots: [...state.bots.values()].map((entry) => copyOf(entry.access)) }
  }

  /** Saves the bot's choice (validated), over what is stored; every other bot keeps its own. */
  set(botId: string, access: BotDeviceAccess): void {
    const problem = botDeviceAccessProblem(access)
    if (problem) throw new Error(problem)
    const state = this.read()
    const bots: Record<string, BotDeviceAccess> = {}
    for (const [id, entry] of state.bots) bots[id] = copyOf(entry.access)
    bots[botId] = copyOf(access)
    if (state.broken) this.putAside()
    this.write({ version: 1, bots, ...(state.broken || state.missing.mode !== 'all' ? { missing: 'this_computer' } : {}) })
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
    const bots: Record<string, BotDeviceAccess> = {}
    for (const [id, entry] of state.bots) {
      const access = entry.access
      if (access.mode === 'chosen' && !entry.unreadable) {
        const nodes = access.nodes.filter(present)
        if (nodes.length !== access.nodes.length) changed = true
        bots[id] = { mode: 'chosen', nodes }
      } else bots[id] = copyOf(access)
    }
    if (!changed) return false
    this.write({ version: 1, bots, ...(state.missing.mode !== 'all' ? { missing: 'this_computer' } : {}) })
    return true
  }

  /** Called after every change this store makes. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
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
        // Never written: every bot reaches every device, as it did before.
        if (this.state?.key !== 'none') this.state = { key: 'none', broken: false, bots: new Map(), missing: DEFAULT_BOT_DEVICE_ACCESS }
        return this.state!
      }
      return { key: 'error', broken: true, bots: new Map(), missing: UNREADABLE_BOT_DEVICE_ACCESS }
    }
    if (this.state?.key === key) return this.state
    this.state = this.parse(key)
    return this.state
  }

  private parse(key: string): State {
    const broken: State = { key, broken: true, bots: new Map(), missing: UNREADABLE_BOT_DEVICE_ACCESS }
    let value: unknown
    try {
      value = JSON.parse(readFileSync(this.path, 'utf8'))
    } catch {
      return broken
    }
    if (!plain(value) || value.version !== 1 || !plain(value.bots) || (value.missing !== undefined && value.missing !== 'this_computer'))
      return broken
    const bots = new Map<string, { access: BotDeviceAccess; unreadable: boolean }>()
    for (const [botId, access] of Object.entries(value.bots))
      bots.set(
        botId,
        botDeviceAccessProblem(access)
          ? { access: UNREADABLE_BOT_DEVICE_ACCESS, unreadable: true }
          : { access: copyOf(access as BotDeviceAccess), unreadable: false }
      )
    return { key, broken: false, bots, missing: value.missing === 'this_computer' ? UNREADABLE_BOT_DEVICE_ACCESS : DEFAULT_BOT_DEVICE_ACCESS }
  }
}
