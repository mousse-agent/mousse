import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { NodeId } from '../../../shared/net'
import { appletJsonBytes, validateAppletSubmission, type AppletReference, type AppletSubmission } from '../../../shared/applets'
import {
  REMOTE_APPLET_PAGE_BYTES,
  REMOTE_APPLET_SAVE_BYTES,
  REMOTE_APPLET_SOURCE_BYTES,
  REMOTE_APPLET_STATE_BYTES,
  REMOTE_BOT_APPLETS_BYTES,
  REMOTE_BOT_APPLETS_COUNT,
  isAppletId,
  type RemoteAppletPage,
  type RemoteAppletStatePage
} from '../../../shared/bots/personal/remoteApplets'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { Lanes } from './lanes'

/** Which applet of a bot of another computer: the message of that bot that shows it, and its id and revision. */
export interface RemoteAppletIds {
  messageId: string
  appletId: string
  revisionId: string
}

/** An applet of another computer's bot, as a window runs it: its reference and source, and its saved state. */
export interface RemoteAppletOpened {
  bundle: AppletReference & { source: AppletSubmission }
  state: unknown
  /** Shown from the copy kept here while its computer is away: what changes in it is not saved. */
  readOnly?: true
}

export interface RemoteBotAppletsOptions {
  /** Where the copies are kept: `<profileHome>/bots/remote-applets`. */
  folder: string
  /** A call to a bot's computer (`bots.applets.*`); `write` for a save. */
  call(node: NodeId, method: 'bots.applets.get' | 'bots.applets.state.get' | 'bots.applets.state.save', params: Record<string, unknown>, options: { write: boolean; signal?: AbortSignal }): Promise<unknown>
  /** Whether the bot's computer is reached now; while it is not, a copy kept here opens read-only. */
  online(node: NodeId): boolean
  /** Reads at once to one computer; the rest wait. Default 2. */
  readsPerComputer?: number
  /** The bytes all copies may take. Default `REMOTE_BOT_APPLETS_BYTES`. */
  maxBytes?: number
  /** How many copies are kept. Default `REMOTE_BOT_APPLETS_COUNT`. */
  maxCount?: number
}

/** A copy on disk: what the applet was when last opened or saved from here. */
interface Copy {
  node: string
  botId: string
  ids: RemoteAppletIds
  bundle: RemoteAppletOpened['bundle']
  state: unknown
}

const unreadable = (): DomainRpcError => new DomainRpcError('bad_reply', 'The other computer sent an unreadable applet.')
const dropped = (): DomainRpcError => new DomainRpcError('bot_not_found', 'This bot is gone.')
/**
 * A page read fits: within the size, and full (`REMOTE_APPLET_PAGE_BYTES`) unless it is the last, so a read takes at
 * most `ceil(size / REMOTE_APPLET_PAGE_BYTES)` calls whatever the other computer sends.
 */
const pageFits = (bytes: Buffer, offset: number, size: number): boolean => {
  const end = offset + bytes.length
  return bytes.length > 0 && end <= size && (end === size || bytes.length === REMOTE_APPLET_PAGE_BYTES)
}
const TEMP = '.tmp-'
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
/** The computer is away (not a refusal): a copy kept here may show instead. */
const away = (error: unknown): boolean => {
  const code = error instanceof DomainRpcError ? error.code : undefined
  return code === 'computer_offline' || code === 'deadline_exceeded'
}

/**
 * The applets of other computers' bots that this computer's windows open. Each is read from the bot's computer when a
 * window opens it (`bots.applets.get` for its source, a page at a time, and `bots.applets.state.get` for its saved
 * state), checked here as untrusted (its source validated as any applet's, and hashed to the revision it names), and
 * saved back there, which owns its state (`bots.applets.state.save`). A window runs it in the same sandboxed applet
 * frame as any applet; nothing here gives it more.
 *
 * A copy of each one opened is kept (`bots/remote-applets`), within `maxBytes` and `maxCount` (least recently opened go
 * first), so it still opens while its computer is away, read-only: nothing changed in it then is saved, and nothing is
 * queued. A bot lost here (`dropBots`, `dropComputer`, `keepComputers`) takes its copies with it, and a read under way
 * for it writes nothing.
 *
 * Reads have their own small pool per computer, apart from bot calls and thread reads, so a chat never waits behind an
 * applet. Saves of one applet go one at a time and only the newest waiting one is sent. Nothing here runs at start.
 */
export class RemoteBotApplets {
  private readonly reads: Lanes
  private readonly drops = new Map<string, number>()
  private readonly running = new Set<{ node: string; botId: string; stop: AbortController }>()
  /** The newest state waiting to be saved, per copy, and who waits on it. */
  private readonly pending = new Map<string, { state: unknown; waiters: Array<{ resolve(): void; reject(error: unknown): void }> }>()
  private readonly saving = new Set<string>()
  private listed?: Promise<Map<string, { size: number; used: number }>>
  private last = 0
  private readonly temp = `${TEMP}${randomUUID().slice(0, 8)}-`

  constructor(private readonly options: RemoteBotAppletsOptions) {
    this.reads = new Lanes(options.readsPerComputer ?? 2)
  }

  /** The copy of one applet revision as one message of one bot shows it. */
  private placeOf(node: string, botId: string, ids: RemoteAppletIds): string {
    return join(this.options.folder, node, botId, `${sha(`${ids.messageId}\n${ids.appletId}\n${ids.revisionId}`).slice(0, 32)}.json`)
  }

  private stamp(node: string, botId: string): string {
    return `${this.drops.get(node) ?? 0}|${this.drops.get(`${node}\n${botId}`) ?? 0}`
  }

  private now(): number {
    this.last = Math.max(Date.now(), this.last + 1)
    return this.last
  }

  /**
   * The applet, read from the bot's computer: its source (from the copy here when there is one, as a revision never
   * changes) and its saved state now. While that computer is away, the copy kept here, read-only; a refusal there (the
   * bot or the applet gone, this device's access lowered) never falls back to the copy.
   */
  async open(node: NodeId, botId: string, ids: RemoteAppletIds, signal?: AbortSignal): Promise<RemoteAppletOpened> {
    if (!ids.messageId || ids.messageId.length > 200 || !isAppletId(ids.appletId) || !isAppletId(ids.revisionId))
      throw new DomainRpcError('invalid_params', 'That is not an applet of the bot.')
    const stamp = this.stamp(node, botId)
    const place = this.placeOf(node, botId, ids)
    const copy = await this.copyAt(place, node, botId, ids)
    if (copy && !this.options.online(node)) return this.fromCopy(place, copy)
    const run = { node, botId, stop: new AbortController() }
    this.running.add(run)
    const stop = signal ? AbortSignal.any([signal, run.stop.signal]) : run.stop.signal
    try {
      const release = await this.reads.enter(node, stop)
      try {
        let state: unknown
        try {
          // The state first: it is read every time, so a bot or applet no longer reached is refused before any copy shows.
          state = await this.readState(node, botId, ids, stop)
        } catch (error) {
          if (this.stamp(node, botId) !== stamp) throw dropped()
          if (copy && away(error)) return this.fromCopy(place, copy)
          throw error
        }
        const bundle = copy?.bundle ?? (await this.readSource(node, botId, ids, stop))
        if (this.stamp(node, botId) !== stamp) throw dropped()
        await this.keep(place, { node, botId, ids, bundle, state }, stamp)
        return { bundle, state }
      } finally {
        release()
      }
    } finally {
      this.running.delete(run)
    }
  }

  /**
   * Saves the applet's state on the bot's computer. Saves of one applet go one at a time; while one is on its way, only
   * the newest after it waits, and is sent next. A computer away refuses at once; nothing is kept to send later. The
   * copy here takes each state saved there.
   */
  save(node: NodeId, botId: string, ids: RemoteAppletIds, state: unknown): Promise<void> {
    let size: number
    try {
      size = appletJsonBytes(state)
    } catch {
      return Promise.reject(new DomainRpcError('invalid_params', 'Applet state must be JSON.'))
    }
    if (size > REMOTE_APPLET_SAVE_BYTES)
      return Promise.reject(new DomainRpcError('applet_state_too_large', 'This applet’s state is too large to save on another computer.'))
    const place = this.placeOf(node, botId, ids)
    return new Promise<void>((resolve, reject) => {
      const waiting = this.pending.get(place)
      if (waiting) {
        waiting.state = state
        waiting.waiters.push({ resolve, reject })
      } else this.pending.set(place, { state, waiters: [{ resolve, reject }] })
      if (!this.saving.has(place)) void this.drain(place, node, botId, ids)
    })
  }

  private async drain(place: string, node: NodeId, botId: string, ids: RemoteAppletIds): Promise<void> {
    this.saving.add(place)
    try {
      for (let next = this.pending.get(place); next; next = this.pending.get(place)) {
        this.pending.delete(place)
        const stamp = this.stamp(node, botId)
        try {
          await this.options.call(node, 'bots.applets.state.save', { botId, ...ids, state: next.state }, { write: true })
          // The copy here shows what was saved there, when it next opens without that computer.
          const copy = this.stamp(node, botId) === stamp ? await this.copyAt(place, node, botId, ids) : undefined
          if (copy) await this.keep(place, { ...copy, state: next.state }, stamp).catch(() => undefined)
          for (const waiter of next.waiters) waiter.resolve()
        } catch (error) {
          for (const waiter of next.waiters) waiter.reject(error)
        }
      }
    } finally {
      this.saving.delete(place)
    }
  }

  private async readSource(node: NodeId, botId: string, ids: RemoteAppletIds, signal: AbortSignal): Promise<RemoteAppletOpened['bundle']> {
    const parts: Buffer[] = []
    let first: RemoteAppletPage | undefined
    let offset = 0
    do {
      const page = (await this.options.call(node, 'bots.applets.get', { botId, ...ids, ...(offset ? { offset } : {}) }, { write: false, signal })) as RemoteAppletPage | null
      if (!page || typeof page.dataB64 !== 'string' || page.offset !== offset || !Number.isSafeInteger(page.size) || page.size < 1 || page.size > REMOTE_APPLET_SOURCE_BYTES)
        throw unreadable()
      // Every page is of the applet and revision asked for, and of one size.
      if (page.appletId !== ids.appletId || page.revisionId !== ids.revisionId || (first && (page.size !== first.size || page.sourceHash !== first.sourceHash)))
        throw unreadable()
      first ??= page
      const bytes = Buffer.from(page.dataB64, 'base64')
      if (!pageFits(bytes, offset, page.size)) throw unreadable()
      parts.push(bytes)
      offset += bytes.length
    } while (offset < first.size)
    let source: AppletSubmission
    try {
      // From another computer: checked as any applet a model hands in, and hashed to the revision it names.
      source = validateAppletSubmission(JSON.parse(Buffer.concat(parts).toString('utf8')))
    } catch {
      throw unreadable()
    }
    if (sha(JSON.stringify(source)) !== first.sourceHash || typeof first.title !== 'string' || typeof first.description !== 'string') throw unreadable()
    return { appletId: ids.appletId, revisionId: ids.revisionId, sourceHash: first.sourceHash, title: source.title, description: source.description, source }
  }

  /** The saved state, in pages; read again (twice at most) when it was saved there between two pages. */
  private async readState(node: NodeId, botId: string, ids: RemoteAppletIds, signal: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const parts: Buffer[] = []
      let first: RemoteAppletStatePage | undefined
      let offset = 0
      let changed = false
      do {
        const page = (await this.options.call(node, 'bots.applets.state.get', { botId, ...ids, ...(offset ? { offset } : {}) }, { write: false, signal })) as RemoteAppletStatePage | null
        if (!page || typeof page.dataB64 !== 'string' || typeof page.hash !== 'string' || page.offset !== offset || !Number.isSafeInteger(page.size) || page.size < 1 || page.size > REMOTE_APPLET_STATE_BYTES)
          throw unreadable()
        if (first && (page.hash !== first.hash || page.size !== first.size)) {
          changed = true
          break
        }
        first ??= page
        const bytes = Buffer.from(page.dataB64, 'base64')
        if (!pageFits(bytes, offset, page.size)) throw unreadable()
        parts.push(bytes)
        offset += bytes.length
      } while (offset < first.size)
      if (changed) continue
      const json = Buffer.concat(parts)
      if (sha(json).slice(0, 32) !== first!.hash) throw unreadable()
      try {
        const parsed = JSON.parse(json.toString('utf8')) as { state?: unknown }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw unreadable()
        return parsed.state ?? null
      } catch {
        throw unreadable()
      }
    }
    throw new DomainRpcError('conflict', 'The applet kept changing while it was read. Try again.')
  }

  private async fromCopy(place: string, copy: Copy): Promise<RemoteAppletOpened> {
    const at = this.now()
    void utimes(place, at / 1000, at / 1000).catch(() => undefined)
    const kept = await this.kept()
    const entry = kept.get(place)
    if (entry) entry.used = at
    return { bundle: copy.bundle, state: copy.state, readOnly: true }
  }

  /** The copy at `place`, when it is whole, of that applet, and its source still checks out. */
  private async copyAt(place: string, node: string, botId: string, ids: RemoteAppletIds): Promise<Copy | undefined> {
    try {
      const copy = JSON.parse(await readFile(place, 'utf8')) as Copy
      if (copy.node !== node || copy.botId !== botId || copy.ids?.messageId !== ids.messageId || copy.ids.appletId !== ids.appletId || copy.ids.revisionId !== ids.revisionId)
        return undefined
      const source = validateAppletSubmission(copy.bundle.source)
      if (sha(JSON.stringify(source)) !== copy.bundle.sourceHash) return undefined
      return { ...copy, bundle: { ...copy.bundle, source } }
    } catch {
      return undefined
    }
  }

  /** Writes the copy, unless its bot was dropped meanwhile, and keeps all copies within their limits. */
  private async keep(place: string, copy: Copy, stamp: string): Promise<void> {
    if (this.stamp(copy.node, copy.botId) !== stamp) return
    const folder = join(place, '..')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const temp = join(folder, `${this.temp}${randomUUID()}`)
    const body = JSON.stringify(copy)
    await writeFile(temp, body, { mode: 0o600 })
    if (this.stamp(copy.node, copy.botId) !== stamp) {
      await rm(temp, { force: true })
      return
    }
    await rename(temp, place)
    const kept = await this.kept()
    if (this.stamp(copy.node, copy.botId) !== stamp) {
      await rm(place, { force: true })
      return
    }
    kept.set(place, { size: Buffer.byteLength(body), used: this.now() })
    await this.trim(place)
  }

  /** The copies kept here, listed from the disk once; copies left half written by an earlier run go. */
  private kept(): Promise<Map<string, { size: number; used: number }>> {
    this.listed ??= (async () => {
      const kept = new Map<string, { size: number; used: number }>()
      const list = async (folder: string): Promise<string[]> => readdir(folder).catch(() => [])
      for (const node of await list(this.options.folder))
        for (const botId of await list(join(this.options.folder, node)))
          for (const entry of await list(join(this.options.folder, node, botId))) {
            const path = join(this.options.folder, node, botId, entry)
            if (entry.startsWith(TEMP)) {
              if (!entry.startsWith(this.temp)) await rm(path, { force: true }).catch(() => undefined)
              continue
            }
            const found = await stat(path).catch(() => undefined)
            if (found?.isFile()) kept.set(path, { size: found.size, used: found.mtimeMs })
          }
      return kept
    })()
    return this.listed
  }

  /** The least recently opened copies go until the rest fit; `keep` (just written) stays. */
  private async trim(keep: string): Promise<void> {
    const kept = await this.kept()
    const maxBytes = this.options.maxBytes ?? REMOTE_BOT_APPLETS_BYTES
    const maxCount = this.options.maxCount ?? REMOTE_BOT_APPLETS_COUNT
    let bytes = [...kept.values()].reduce((sum, entry) => sum + entry.size, 0)
    for (const [place, entry] of [...kept.entries()].sort((a, b) => a[1].used - b[1].used)) {
      if (bytes <= maxBytes && kept.size <= maxCount) break
      if (place === keep) continue
      kept.delete(place)
      bytes -= entry.size
      await rm(place, { force: true }).catch(() => undefined)
    }
  }

  private stop(matches: (node: string, botId: string) => boolean, under: string): void {
    for (const run of this.running) if (matches(run.node, run.botId)) run.stop.abort(dropped())
    for (const place of this.pending.keys()) {
      if (!place.startsWith(under)) continue
      for (const waiter of this.pending.get(place)!.waiters) waiter.reject(dropped())
      this.pending.delete(place)
    }
    void this.listed?.then((kept) => {
      for (const place of kept.keys()) if (place.startsWith(under)) kept.delete(place)
    })
  }

  /** The copies of bots lost here go; a read under way for them writes nothing, and a save waiting is not sent. */
  dropBots(node: NodeId, botIds: Iterable<string>): void {
    for (const botId of botIds) {
      const key = `${node}\n${botId}`
      this.drops.set(key, (this.drops.get(key) ?? 0) + 1)
      const folder = join(this.options.folder, node, botId)
      this.stop((runNode, runBot) => runNode === node && runBot === botId, folder + sep)
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /** Every copy of a computer's bots goes. */
  dropComputer(node: NodeId): void {
    this.drops.set(node, (this.drops.get(node) ?? 0) + 1)
    const folder = join(this.options.folder, node)
    this.stop((runNode) => runNode === node, folder + sep)
    rmSync(folder, { recursive: true, force: true })
  }

  /** Keeps the copies of the computers `keep` names; the rest go. */
  keepComputers(keep: (node: string) => boolean): void {
    if (!existsSync(this.options.folder)) return
    for (const node of readdirSync(this.options.folder)) if (!keep(node)) this.dropComputer(node as NodeId)
  }
}
