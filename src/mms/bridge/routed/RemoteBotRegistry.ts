import { NetError, newId, type NodeId, type StreamDescriptor } from '../../../shared/net'
import { qualifyId } from '../../../shared/threadRef'
import { isBotId } from '../../bots/definitions/BotDefinitionStore'
import { DomainRpcError } from '../../protocol/domainRegistry'
import type { BridgeHub } from '../hub'
import type { BridgeClient } from '../peers'
import type { BotFeedRow, BotsFeedSnapshot } from '../remote/BotStreamSources'
import { PRIVATE_BOTS_SUBJECT } from '../remote/privateStreams'
import type { ComputerRef } from './computerErrors'
import { PASSING_END_CODES, RemoteBotChats, askOwner, ownerSaid } from './RemoteBotChats'
import type { SqliteRemoteBots } from './remoteBotStore'

type Json = Record<string, unknown>
const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** How often the computers whose bots are listed are looked at again. */
const RECONCILE_MS = 5_000
const RETRY_MIN_MS = 5_000
const RETRY_MAX_MS = 5 * 60_000
/** A changed feed is written to disk at most this often; a feed that lost a bot is written at once. */
const SAVE_SETTLE_MS = 5_000

const codeOf = (error: unknown): string =>
  error instanceof NetError || error instanceof DomainRpcError ? error.code : error instanceof Error ? error.name : 'internal'

/** A bot of another computer as this one lists it. */
export type RemoteBotRow = Omit<BotFeedRow, 'id'> & {
  /** `<node>:<botId>`: how this computer names the bot. */
  id: string
  /** Its id on its own computer. */
  botId: string
  /** The computer it lives on, and the name it goes by. */
  node: NodeId
  computerName: string
  /** Its computer can't be reached now: the row is the last copy, and its chat opens read-only. */
  offline?: true
}

/** The user's other computers whose bots are listed, as `RemoteBotRegistryOptions.computers` gives them. */
export interface RemoteBotComputers {
  computers: ComputerRef[]
  /**
   * A computer that is not listed but can't be told gone now (a v1 device while the v1 roster can't be read): what is
   * kept of its bots stays as it is.
   */
  unsure?(node: NodeId): boolean
}

interface Computer {
  node: NodeId
  name: string
  /** Its bots as its feed last listed them, by their ids there, in the feed's order. */
  bots: Map<string, BotFeedRow>
  online: boolean
  /** A snapshot of the current feed stream has arrived. */
  live: boolean
  attached?: { close(): void }
  attaching?: Promise<void>
  retryAt: number
  failures: number
  /** Why its feed can't be read now (an error code), until it can. */
  error?: string
  /** The feed as last received, to be written to disk; undefined once written. */
  unsaved?: string
  saveTimer?: ReturnType<typeof setTimeout>
  /** The Bridge's copy of its feed stream was reset in this run of failures; a feed snapshot ends the run. */
  copyDropped?: boolean
}

/** What is still to be dropped of a computer's bots, after a drop that did not go through. */
interface PendingDrop {
  /** Everything of the computer: its feed, its chats and the Bridge's copies of their streams. */
  all: boolean
  /** Bots lost: their chat copies and the Bridge's copies of their streams. Never listed while pending. */
  lost: Set<string>
  /** Bots whose chat stream's copy in the Bridge is to be reset; they stay listed. */
  resets: Set<string>
  /** Each new request counts, so a drop that ends after a newer request leaves that one pending. */
  version: number
  running: boolean
}

export interface RemoteBotRegistryOptions {
  hub: Pick<BridgeHub, 'attach' | 'dropCopy'>
  /**
   * A client for calls to `node`, on the transport the threads of that computer use (`PeerDirectory.client`): an
   * engine pairing when it is one, else the v1 session.
   */
  client(node: NodeId): Pick<BridgeClient, 'rpc'>
  store: SqliteRemoteBots
  /**
   * The other computers of the user whose bots are listed (`PeerDirectory.botComputers`): those away included, a
   * pairing that no longer accepts this one left out. `undefined` when they can't be known now (the engine is still
   * starting, the roster can't be read): nothing is forgotten on a bad moment.
   */
  computers(): RemoteBotComputers | undefined
  /** Whether a session with the computer is open. */
  online(node: NodeId): boolean
  /**
   * Whether Bridge is on here. While it is off nothing is attached, the rows stay listed as offline, and the copy is
   * not opened unless it is on disk already.
   */
  enabled(): boolean
  clock?: { now(): number }
  reconcileMs?: number
  saveSettleMs?: number
}

/**
 * The bots of the user's other computers, as the viewing computer lists them: for each computer, its bots feed
 * (`bridge.bots.open`) gives the bots it lets this one reach, kept here under qualified ids (`<node>:<botId>`) with a
 * copy on disk, so they stay listed while that computer is out of reach and after a restart, marked offline.
 *
 * Offline is not a no. When the bot's computer refuses to open the feed (this one's bot level there is Off, it
 * blocked this one), when its feed drops a bot, when it refuses a bot's chat, when the computer leaves the user's
 * computers or its pairing no longer accepts this one, those bots go at once: their rows, their chat copies
 * (`RemoteBotChats`) and the Bridge's copy of their streams. A drop that fails is tried again on each pass, and what it
 * holds is never listed meanwhile. A stream that ends is opened again: the computer's answer decides, never the bare
 * code of the end, which this computer's own checks raise too.
 *
 * Nothing here runs on a thread's or a turn's start, and a start never waits for it: the copy is read from disk on
 * first use or on the first look at the computers, which runs in the background.
 */
export class RemoteBotRegistry {
  readonly chats: RemoteBotChats
  private readonly computersByNode = new Map<NodeId, Computer>()
  private readonly listeners = new Set<() => void>()
  private readonly failing = new Set<string>()
  private readonly pendingDrops = new Map<NodeId, PendingDrop>()
  private loaded = false
  /** The computers the copy on disk was last cut to; undefined until it was. */
  private presentKey?: string
  private timer?: ReturnType<typeof setInterval>
  private firstLook?: ReturnType<typeof setTimeout>
  private closed = false

  constructor(private readonly options: RemoteBotRegistryOptions) {
    this.chats = new RemoteBotChats({
      hub: options.hub,
      client: options.client,
      store: options.store,
      openable: (node, botId) => {
        const c = this.computersByNode.get(node)
        return !!c && c.online && c.bots.has(botId) && this.options.enabled()
      },
      lost: (node, botId) => this.loseBots(node, [botId]),
      online: (node) => this.options.online(node),
      resetStreamCopies: (node, botIds) => this.drop(node, { resets: botIds }),
      safely: (what, work) => this.safely(what, work)
    })
  }

  private now(): number {
    return (this.options.clock ?? Date).now()
  }

  // ------------------------------------------------------------------ lifecycle

  /** Starts looking at the computers, in the background: the first look runs after the current work, not in it. */
  start(): void {
    const reconcile = (): void => void this.reconcile()
    this.timer = setInterval(reconcile, this.options.reconcileMs ?? RECONCILE_MS)
    this.timer.unref?.()
    this.firstLook = setTimeout(reconcile, 0)
    this.firstLook.unref?.()
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.firstLook) clearTimeout(this.firstLook)
    for (const c of this.computersByNode.values()) this.detach(c)
    this.chats.close()
    this.options.store.close()
  }

  /** Hears when the rows change: a feed arrived, a computer went out of reach or came back, bots were lost. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One listener's failure does not keep the others from hearing.
      }
    }
  }

  // ------------------------------------------------------------------ reads

  /** Every bot of the other computers this one lists: each computer's in its feed's order. */
  rows(): RemoteBotRow[] {
    this.load()
    const out: RemoteBotRow[] = []
    for (const c of this.computersByNode.values()) for (const bot of c.bots.values()) out.push(this.rowOf(c, bot))
    return out
  }

  /** One bot by its qualified id. */
  row(node: NodeId, botId: string): RemoteBotRow | undefined {
    this.load()
    const c = this.computersByNode.get(node)
    const bot = c?.bots.get(botId)
    return c && bot ? this.rowOf(c, bot) : undefined
  }

  /** The file the copy is kept in. */
  get copyPath(): string {
    return this.options.store.path
  }

  /** The computers whose bots are listed, for the tests and the Devices screens. */
  state(): Array<{ node: NodeId; online: boolean; live: boolean; bots: number; error?: string }> {
    return [...this.computersByNode.values()].map((c) => ({
      node: c.node,
      online: c.online,
      live: c.live,
      bots: c.bots.size,
      ...(c.error ? { error: c.error } : {})
    }))
  }

  /** The computers with a drop still to go through, for the tests. */
  pendingDropNodes(): NodeId[] {
    return [...this.pendingDrops.keys()]
  }

  private rowOf(c: Computer, bot: BotFeedRow): RemoteBotRow {
    return { ...bot, id: qualifyId(c.node, bot.id), botId: bot.id, node: c.node, computerName: c.name, ...(c.online ? {} : { offline: true as const }) }
  }

  // ------------------------------------------------------------------ the copy on disk

  /**
   * Reads the copy on disk once it can be read: every computer it holds is listed, offline, until its feed says
   * otherwise; what a drop still to go through holds is left out. While Bridge is off a copy not on disk yet is not
   * made.
   */
  private load(): void {
    if (this.loaded || this.closed) return
    if (!this.options.enabled() && !this.options.store.exists()) return
    const cached = this.safely('read the copy of other computers’ bots', () => this.options.store.feeds())
    if (!cached) return
    this.loaded = true
    if (!cached.length) return
    const names = new Map((this.safelyListed()?.computers ?? []).map((ref) => [ref.node, ref.name]))
    for (const entry of cached) {
      if (this.computersByNode.has(entry.node)) continue
      const pending = this.pendingDrops.get(entry.node)
      if (pending?.all) continue
      let feed: BotsFeedSnapshot | undefined
      try {
        feed = this.feedOf(JSON.parse(entry.snapshot))
      } catch {
        feed = undefined
      }
      if (!feed) continue
      const c = this.computerOf({ node: entry.node, name: names.get(entry.node) ?? 'the other computer' })
      c.bots = new Map(feed.bots.filter((bot) => !pending?.lost.has(bot.id)).map((bot) => [bot.id, bot]))
    }
  }

  private safelyListed(): RemoteBotComputers | undefined {
    try {
      return this.options.computers()
    } catch {
      return undefined
    }
  }

  private save(c: Computer, now: boolean): void {
    if (c.unsaved === undefined) return
    if (!now) {
      if (c.saveTimer) return
      c.saveTimer = setTimeout(() => {
        c.saveTimer = undefined
        this.save(c, true)
      }, this.options.saveSettleMs ?? SAVE_SETTLE_MS)
      c.saveTimer.unref?.()
      return
    }
    if (c.saveTimer) clearTimeout(c.saveTimer)
    c.saveTimer = undefined
    const snapshot = c.unsaved
    c.unsaved = undefined
    if (this.computersByNode.get(c.node) !== c) return
    this.safely('keep the copy of a computer’s bots', () => this.options.store.saveFeed(c.node, snapshot, new Set(c.bots.keys())))
  }

  /** A failed write or read is said once, until one works again; what is in memory stays as it is. */
  private safely<T>(what: string, work: () => T): T | undefined {
    try {
      const out = work()
      this.failing.delete(what)
      return out
    } catch (error) {
      this.failedOnce(what, error)
      return undefined
    }
  }

  private failedOnce(what: string, error: unknown): void {
    if (this.failing.has(what)) return
    this.failing.add(what)
    console.warn(`[bots] could not ${what}`, { code: codeOf(error) })
  }

  // ------------------------------------------------------------------ drops

  /**
   * Drops what is kept of `node`'s bots: everything (`all`), the bots `lost`, or only the Bridge's copy of some chat
   * streams (`resets`). The disk goes at once; what fails, here or in the Bridge, is tried again on the next pass.
   */
  private drop(node: NodeId, what: { all?: boolean; lost?: Iterable<string>; resets?: Iterable<string> }): void {
    let pending = this.pendingDrops.get(node)
    if (!pending) {
      pending = { all: false, lost: new Set(), resets: new Set(), version: 0, running: false }
      this.pendingDrops.set(node, pending)
    }
    if (what.all) pending.all = true
    for (const bot of what.lost ?? []) pending.lost.add(bot)
    for (const bot of what.resets ?? []) pending.resets.add(bot)
    pending.version += 1
    this.runDrop(node, pending)
  }

  private runDrop(node: NodeId, pending: PendingDrop): void {
    const version = pending.version
    const all = pending.all
    const lost = [...pending.lost]
    // A chat open again since is read fresh already; its copy in the Bridge is not taken from under it.
    const resets = [...pending.resets].filter((bot) => !this.chats.openChats().some((chat) => chat.node === node && chat.botId === bot))
    const wrote =
      this.safely('drop the copy of a computer’s bots', () => {
        if (all) this.options.store.dropComputer(node)
        for (const bot of lost) this.options.store.dropChat(node, bot)
        return true
      }) === true
    // The Bridge's part of a drop still under way is not asked twice; it is tried again once it ends.
    if (pending.running) return
    const copies: Array<Promise<unknown>> = [...new Set([...lost, ...resets])].map((bot) => this.chats.dropStreamCopy(node, bot))
    if (all) copies.push(this.options.hub.dropCopy({ nodeId: node, entityId: PRIVATE_BOTS_SUBJECT }, this.feedStream({ node })))
    pending.running = true
    void Promise.allSettled(copies).then((results) => {
      pending.running = false
      const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failed) this.failedOnce('drop the Bridge’s copy of a computer’s bots', failed.reason)
      if (!wrote || failed) return
      this.failing.delete('drop the Bridge’s copy of a computer’s bots')
      if (this.pendingDrops.get(node) === pending && pending.version === version) this.pendingDrops.delete(node)
    })
  }

  /** Drops that did not go through are tried again. */
  private retryDrops(): void {
    for (const [node, pending] of this.pendingDrops) this.runDrop(node, pending)
  }

  /** The computer's feed lists bots again: what it lists is no longer to be dropped. */
  private relisted(c: Computer): void {
    const pending = this.pendingDrops.get(c.node)
    if (!pending) return
    pending.all = false
    for (const bot of c.bots.keys()) pending.lost.delete(bot)
    pending.version += 1
    if (!pending.lost.size && !pending.resets.size && !pending.running) this.pendingDrops.delete(c.node)
  }

  // ------------------------------------------------------------------ computers

  private computerOf(ref: ComputerRef): Computer {
    let c = this.computersByNode.get(ref.node)
    if (!c) {
      c = { node: ref.node, name: ref.name, bots: new Map(), online: false, live: false, retryAt: 0, failures: 0 }
      this.computersByNode.set(ref.node, c)
    }
    c.name = ref.name
    return c
  }

  /** Looks at which computers there are and which are reachable: attaches, marks offline, forgets removed ones. */
  async reconcile(): Promise<void> {
    if (this.closed) return
    this.load()
    this.retryDrops()
    if (!this.options.enabled()) {
      this.pause()
      return
    }
    const listed = this.safelyListed()
    // Computers that can't be known now change nothing: a bad moment must not forget one.
    if (!listed) return
    const present = new Map(listed.computers.map((ref) => [ref.node, ref]))
    const kept = (node: NodeId): boolean => present.has(node) || listed.unsure?.(node) === true
    for (const node of [...this.computersByNode.keys()]) if (!kept(node)) this.forget(node)
    // What is kept on disk for a computer no longer listed (it left the user's computers, was blocked, or its pairing
    // no longer accepts this one) goes too, also when it left while this computer was not running.
    const key = `${[...present.keys()].sort().join(',')}${listed.unsure ? ' unsure' : ''}`
    if (key !== this.presentKey && this.options.store.exists()) {
      const dropped = this.safely('drop the copy of other computers’ bots', () => this.options.store.dropOthers(kept))
      if (dropped) {
        this.presentKey = key
        for (const node of dropped) if (!this.pendingDrops.has(node)) this.drop(node, { all: true })
      }
    }
    let moved = false
    for (const ref of present.values()) {
      const c = this.computerOf(ref)
      const online = this.options.online(c.node)
      if (online !== c.online) {
        c.online = online
        moved = true
      }
      if (!online) {
        c.live = false
        continue
      }
      if (!c.attached && !c.attaching && this.now() >= c.retryAt) void this.attach(c)
    }
    if (moved) this.changed()
  }

  /** Bridge went off here: nothing stays attached, and the rows stay listed as offline. It is not a no. */
  private pause(): void {
    let moved = false
    for (const c of this.computersByNode.values()) {
      this.detach(c)
      this.chats.detachComputer(c.node)
      if (c.online) moved = true
      c.online = false
    }
    if (moved) this.changed()
  }

  /** A session with `node` opened: its feed is read again now. */
  nodeOnline(node: NodeId): void {
    const c = this.computersByNode.get(node)
    if (c) {
      c.retryAt = 0
      c.failures = 0
    }
    void this.reconcile()
  }

  /** A session with `node` ended; if it was the last, its bots stay listed from the copy, marked offline. */
  nodeOffline(node: NodeId): void {
    const c = this.computersByNode.get(node)
    if (!c || this.options.online(node)) return
    // What it last sent is written now, so a restart while it is away lists it.
    this.save(c, true)
    c.live = false
    if (!c.online) return
    c.online = false
    this.changed()
  }

  /** The computer left the user's computers (or was blocked here): everything of its bots goes. */
  private forget(node: NodeId): void {
    const c = this.computersByNode.get(node)
    if (!c) return
    this.detach(c)
    this.computersByNode.delete(node)
    this.dropEverything(c)
    this.changed()
  }

  /**
   * The computer said no to this one's feed: its bot level here is Off, or it blocked this one. Every bot of it goes,
   * with its copies on disk; the feed is asked again later, as the level may be raised again.
   */
  private refuse(c: Computer): void {
    this.detach(c)
    const had = c.bots.size > 0
    this.dropEverything(c)
    c.bots = new Map()
    this.backOff(c)
    if (had) this.changed()
  }

  private dropEverything(c: Computer): void {
    if (c.saveTimer) clearTimeout(c.saveTimer)
    c.saveTimer = undefined
    c.unsaved = undefined
    this.chats.lose(c.node, c.bots.keys())
    this.drop(c.node, { all: true, lost: c.bots.keys() })
  }

  /** Bots this computer no longer reaches on `node`: their rows and chat copies go at once, on disk too. */
  private loseBots(node: NodeId, botIds: readonly string[]): void {
    const c = this.computersByNode.get(node)
    this.chats.lose(node, botIds)
    this.drop(node, { lost: botIds })
    if (!c) return
    const gone = botIds.filter((id) => c.bots.has(id))
    for (const id of gone) c.bots.delete(id)
    if (!gone.length) return
    this.writeNow(c)
    this.changed()
  }

  /** Writes the feed as it is now, dropping on disk what it no longer has. */
  private writeNow(c: Computer): void {
    const feed: BotsFeedSnapshot = { kind: 'mousse.bots', version: 1, bots: [...c.bots.values()] }
    c.unsaved = JSON.stringify(feed)
    this.save(c, true)
  }

  private detach(c: Computer): void {
    this.save(c, true)
    const held = c.attached
    c.attached = undefined
    c.live = false
    held?.close()
  }

  private backOff(c: Computer): void {
    c.failures += 1
    c.retryAt = this.now() + Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(c.failures - 1, 5))
  }

  // ------------------------------------------------------------------ the feed

  /** How a computer's bots feed is attached: in the bots' own room, opened by asking that computer. */
  private feedStream(c: Pick<Computer, 'node'>) {
    return {
      room: 'bots' as const,
      open: async () => {
        const opened = await askOwner(() => this.options.client(c.node).rpc('bridge.bots.open', {}, { id: newId('rpc'), deadlineMs: 30_000 }))
        const { descriptor, head } = (isRecord(opened) ? opened : {}) as { descriptor?: StreamDescriptor; head?: { epoch: number; seq: number } }
        return { descriptor: descriptor as StreamDescriptor, head: head as { epoch: number; seq: number } }
      }
    }
  }

  private async attach(c: Computer): Promise<void> {
    if (c.attached || c.attaching) return c.attaching
    c.attaching = (async () => {
      try {
        const handle = await this.options.hub.attach(
          { nodeId: c.node, entityId: PRIVATE_BOTS_SUBJECT },
          (update) => {
            if (update.kind === 'snapshot') this.ingest(c, update.value)
          },
          (code) => {
            c.attached = undefined
            c.live = false
            this.ended(c, code)
          },
          this.feedStream(c)
        )
        if (this.closed || this.computersByNode.get(c.node) !== c || !this.options.enabled()) {
          handle.close()
          return
        }
        c.attached = handle
        c.failures = 0
      } catch (error) {
        if (this.closed || this.computersByNode.get(c.node) !== c) return
        this.unopened(c, error)
      }
    })().finally(() => {
      c.attaching = undefined
    })
    return c.attaching
  }

  /**
   * The feed of `c` could not be opened. The computer's no (`forbidden`: its bot level for this one is Off, it blocked
   * this one) drops its bots; this computer's own failures keep them, and reset the Bridge's copy of the feed once.
   */
  private unopened(c: Computer, error: unknown): void {
    const code = codeOf(error)
    this.failed(c, code)
    const said = ownerSaid(error)
    if (said === 'refused') return this.refuse(c)
    if (!this.options.online(c.node)) return this.away(c)
    if (!said && !PASSING_END_CODES.has(code) && !c.copyDropped) return this.reopenFresh(c)
    this.backOff(c)
  }

  /**
   * The feed of `c` ended. Its rows stay: while the computer is reached, the Bridge's copy of the feed is reset once
   * and the feed opened again at once, and the computer's answer to that open decides.
   */
  private ended(c: Computer, code: string): void {
    this.failed(c, code)
    if (!this.options.online(c.node)) return this.away(c)
    if (!PASSING_END_CODES.has(code) && !c.copyDropped) return this.reopenFresh(c)
    this.backOff(c)
  }

  private away(c: Computer): void {
    this.backOff(c)
    if (!c.online) return
    c.online = false
    this.changed()
  }

  /** Resets the Bridge's copy of the feed of `c` and opens it again now. */
  private reopenFresh(c: Computer): void {
    c.copyDropped = true
    void this.options.hub
      .dropCopy({ nodeId: c.node, entityId: PRIVATE_BOTS_SUBJECT }, this.feedStream(c))
      .catch(() => false)
      .then(async () => {
        await c.attaching?.catch(() => undefined)
        if (this.closed || this.computersByNode.get(c.node) !== c || !this.options.enabled()) return
        c.retryAt = 0
        void this.attach(c)
      })
  }

  /** The feed of `c` can't be read: said once per reason. */
  private failed(c: Computer, code: string): void {
    if (c.error === code) return
    c.error = code
    console.warn('[bots] cannot read the bots of a computer', { node: c.node, code, online: this.options.online(c.node) })
  }

  /** The shape every feed snapshot is checked against before a row is made from it; rows past `feedRows` are cut. */
  private feedOf(value: unknown): BotsFeedSnapshot | undefined {
    if (!isRecord(value) || value.kind !== 'mousse.bots' || !Array.isArray(value.bots)) return undefined
    const seen = new Set<string>()
    const bots = value.bots
      .filter((bot): bot is BotFeedRow => {
        if (!isRecord(bot) || !isBotId(bot.id) || seen.has(bot.id)) return false
        seen.add(bot.id)
        return true
      })
      .slice(0, this.options.store.limits.feedRows)
    return { kind: 'mousse.bots', version: 1, bots }
  }

  /** A feed snapshot from the computer: its bots now. A bot it no longer lists is lost here, row and copy. */
  private ingest(c: Computer, value: unknown): void {
    const feed = this.feedOf(value)
    if (!feed) return
    if (this.computersByNode.get(c.node) !== c) return
    const gone = [...c.bots.keys()].filter((id) => !feed.bots.some((bot) => bot.id === id))
    c.bots = new Map(feed.bots.map((bot) => [bot.id, bot]))
    c.live = true
    c.online = true
    c.copyDropped = false
    this.relisted(c)
    if (c.error) {
      console.info('[bots] reading the bots of a computer again', { node: c.node, after: c.error })
      c.error = undefined
    }
    c.unsaved = JSON.stringify(feed)
    if (gone.length) {
      // Written at once: a restart must not bring a lost bot back.
      this.save(c, true)
      this.chats.lose(c.node, gone)
      this.drop(c.node, { lost: gone })
    } else this.save(c, false)
    this.changed()
  }
}
