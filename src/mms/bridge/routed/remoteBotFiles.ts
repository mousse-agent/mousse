import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { copyFile, mkdir, open, readdir, rename, rm, stat, utimes } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type { NodeId } from '../../../shared/net'
import { attachmentFileName } from '../../../shared/bots/personal/attachments'
import { REMOTE_BOT_FILE_BYTES, isBotFileRef, isSvgName } from '../../../shared/bots/personal/remoteFiles'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { looksLikeSvg, remoteFileType, sniffImage } from '../remote/botFiles'
import { Lanes } from './lanes'

/** One page of a file, as the bot's computer answers `bots.chat.file`. */
export interface RemoteFilePage {
  name: string
  mime: string
  size: number
  offset: number
  dataB64: string
  image?: true
}

/** A file of another computer's bot, kept here: where it is on this computer, and what it is. */
export interface RemoteBotFile {
  path: string
  name: string
  size: number
}

/** The bytes the copies of other computers' bots' files may take here, all together. */
export const REMOTE_BOT_FILES_BYTES = 512 * 1024 * 1024
/** The copies of other computers' bots' files kept here at most. */
export const REMOTE_BOT_FILES_COUNT = 2000

export interface RemoteBotFilesOptions {
  /** Where the copies are kept: `<profileHome>/bots/remote-files`. */
  folder: string
  /** Reads one page of `ref` from the bot's computer (`bots.chat.file`). */
  read(node: NodeId, botId: string, ref: string, offset: number, signal?: AbortSignal): Promise<RemoteFilePage>
  /** Whether the bot's computer is reached now; while it is not, a copy kept here is answered as it is. */
  online(node: NodeId): boolean
  /** Reads at once to one computer; the rest wait. Default 2. */
  readsPerComputer?: number
  /** The bytes all copies may take. Default `REMOTE_BOT_FILES_BYTES`. */
  maxBytes?: number
  /** How many copies are kept. Default `REMOTE_BOT_FILES_COUNT`. */
  maxFiles?: number
}

const isPage = (value: unknown): value is RemoteFilePage => {
  const page = value as Partial<RemoteFilePage> | null
  return !!page && typeof page.name === 'string' && typeof page.mime === 'string' && Number.isSafeInteger(page.size) &&
    Number.isSafeInteger(page.offset) && typeof page.dataB64 === 'string'
}
const unreadable = (): DomainRpcError => new DomainRpcError('bad_reply', 'The other computer sent an unreadable file.')
const dropped = (): DomainRpcError => new DomainRpcError('bot_not_found', 'This bot is gone.')
/**
 * A copy being written goes under a name of its own until it is whole: `.tmp-<run>-<uuid>`, `<run>` naming the
 * `RemoteBotFiles` that writes it, so only what earlier runs left half written is ever taken for litter. No kept name
 * starts with a dot (`attachmentFileName` takes them off), so this one is never taken for a copy.
 */
const TEMP = '.tmp-'

/** A copy kept here: how large it is, and when it was last shown (for the least recently used to go first). */
interface Kept {
  size: number
  used: number
}

/**
 * The files of other computers' bots that this computer's windows show (pictures in their chats), each copied here
 * once from the bot's files folder there, a page at a time (`bots.chat.file`), so the window shows it as it shows a
 * file of this computer. The copy is checked again on each look: its size and first page against the bot's file now.
 * While that computer is away a copy kept here still shows. A bot lost here (`dropBots`, `dropComputer`) takes its
 * copies with it, and a read or a copy still under way for it stops and writes nothing.
 *
 * The copies take at most `maxBytes` and `maxFiles` in all (named defaults); past either, the least recently shown go.
 * A picture is kept only if its bytes are one (PNG, JPEG, GIF or WebP), whatever the other computer says; an SVG never.
 *
 * Reads have their own small pool per computer (`readsPerComputer`), apart from routed large reads and from bot
 * calls, so a chat never waits behind pictures, and pictures never wait behind threads. Nothing here runs at start:
 * what is kept is listed the first time a file is asked for.
 */
export class RemoteBotFiles {
  private readonly loading = new Map<string, Promise<RemoteBotFile>>()
  /** Files just sent, being copied in as their copies (`seed`); never fails. */
  private readonly seeding = new Map<string, Promise<void>>()
  private readonly reads: Lanes
  /** Bumped when a computer's or a bot's copies are dropped: work begun before writes nothing. */
  private readonly drops = new Map<string, number>()
  /** Reads under way, so a drop stops them. */
  private readonly running = new Set<{ node: string; botId: string; stop: AbortController }>()
  private listed?: Promise<Map<string, Kept>>
  private last = 0
  /** This run's copies being written start so (`TEMP`); a temp file named otherwise was left by an earlier run. */
  private readonly temp = `${TEMP}${randomUUID().slice(0, 8)}-`

  constructor(private readonly options: RemoteBotFilesOptions) {
    this.reads = new Lanes(options.readsPerComputer ?? 2)
  }

  /** Where the copy of `ref` of `node`'s bot `botId` goes; the folder holds only that file. */
  private placeOf(node: NodeId, botId: string, ref: string): string {
    return join(this.options.folder, node, botId, createHash('sha256').update(ref).digest('hex').slice(0, 32))
  }

  private stamp(node: string, botId: string): string {
    return `${this.drops.get(node) ?? 0}|${this.drops.get(`${node}\n${botId}`) ?? 0}`
  }

  private now(): number {
    this.last = Math.max(Date.now(), this.last + 1)
    return this.last
  }

  /** The copy of `ref`, read from the bot's computer when there is none here or the file there changed. */
  async fetch(node: NodeId, botId: string, ref: string, signal?: AbortSignal): Promise<RemoteBotFile> {
    if (!isBotFileRef(ref)) throw new DomainRpcError('invalid_params', 'path is not a file of the bot.')
    const place = this.placeOf(node, botId, ref)
    // A file just sent is being copied in: it is the copy.
    await this.seeding.get(place)
    const known = this.loading.get(place)
    if (known) return known
    const work = this.load(node, botId, ref, place, signal).finally(() => {
      if (this.loading.get(place) === work) this.loading.delete(place)
    })
    this.loading.set(place, work)
    return work
  }

  /**
   * A file this computer just sent the bot, kept as the copy of the place it got there, so it shows without being read
   * back. Copied in the background; best effort.
   */
  seed(node: NodeId, botId: string, ref: string, name: string, from: string): Promise<void> {
    if (!isBotFileRef(ref) || isSvgName(name)) return Promise.resolve()
    const stamp = this.stamp(node, botId)
    const place = this.placeOf(node, botId, ref)
    const before = [this.loading.get(place)?.catch(() => undefined), this.seeding.get(place)]
    const work = (async () => {
      // One copy into a place at a time: a read of it, or a copy, begun before finishes first.
      await Promise.all(before)
      if (this.stamp(node, botId) !== stamp) return
      try {
        await mkdir(place, { recursive: true, mode: 0o700 })
        const temp = join(place, `${this.temp}${randomUUID()}`)
        await copyFile(from, temp)
        await this.settle(node, botId, stamp, place, temp, attachmentFileName(name))
      } catch {
        // Read from the bot's computer when it is shown.
      }
    })()
    this.seeding.set(place, work)
    void work.finally(() => {
      if (this.seeding.get(place) === work) this.seeding.delete(place)
    })
    return work
  }

  /**
   * Makes the copy written at `temp` the copy of `place`, unless its bot was dropped meanwhile (then nothing stays),
   * and keeps the copies within their limits.
   */
  private async settle(node: string, botId: string, stamp: string, place: string, temp: string, name: string): Promise<RemoteBotFile> {
    if (this.stamp(node, botId) !== stamp) {
      await rm(place, { recursive: true, force: true })
      throw dropped()
    }
    const target = join(place, name)
    // One file per place: an older copy under another name goes.
    for (const entry of await readdir(place)) if (entry !== basename(temp)) await rm(join(place, entry), { force: true, recursive: true })
    await rename(temp, target)
    const gone = async (): Promise<never> => {
      await rm(place, { recursive: true, force: true })
      throw dropped()
    }
    if (this.stamp(node, botId) !== stamp) return gone()
    const size = (await stat(target)).size
    const kept = await this.kept()
    // Dropped while it was listed: no entry, and no path to a copy that went.
    if (this.stamp(node, botId) !== stamp) return gone()
    kept.set(place, { size, used: this.now() })
    await this.trim(place)
    return { path: target, name, size }
  }

  /** The copies kept here, listed from the disk once; copies left half written go. */
  private kept(): Promise<Map<string, Kept>> {
    this.listed ??= (async () => {
      const kept = new Map<string, Kept>()
      const list = async (folder: string): Promise<string[]> => readdir(folder).catch(() => [])
      for (const node of await list(this.options.folder)) {
        for (const botId of await list(join(this.options.folder, node))) {
          for (const hash of await list(join(this.options.folder, node, botId))) {
            const place = join(this.options.folder, node, botId, hash)
            for (const entry of await list(place)) {
              const path = join(place, entry)
              if (entry.startsWith(TEMP)) {
                // Half written by an earlier run; this run's are being written now.
                if (!entry.startsWith(this.temp)) await rm(path, { force: true }).catch(() => undefined)
                continue
              }
              const found = await stat(path).catch(() => undefined)
              if (found?.isFile()) kept.set(place, { size: found.size, used: found.mtimeMs })
            }
          }
        }
      }
      return kept
    })()
    return this.listed
  }

  /** The least recently shown copies go until the rest fit; `keep` (just written) and copies being read or copied in stay. */
  private async trim(keep: string): Promise<void> {
    const kept = await this.kept()
    const maxBytes = this.options.maxBytes ?? REMOTE_BOT_FILES_BYTES
    const maxFiles = this.options.maxFiles ?? REMOTE_BOT_FILES_COUNT
    let bytes = [...kept.values()].reduce((sum, entry) => sum + entry.size, 0)
    const oldest = [...kept.entries()].sort((a, b) => a[1].used - b[1].used)
    for (const [place, entry] of oldest) {
      if (bytes <= maxBytes && kept.size <= maxFiles) break
      if (place === keep || this.loading.has(place) || this.seeding.has(place)) continue
      kept.delete(place)
      bytes -= entry.size
      await rm(place, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /** The copy at `place`, if there is one. */
  private async copyAt(place: string): Promise<string | undefined> {
    try {
      const name = (await readdir(place)).find((entry) => !entry.startsWith(TEMP))
      return name ? join(place, name) : undefined
    } catch {
      return undefined
    }
  }

  /** A copy shown: it goes last when copies must go. */
  private async shown(place: string, path: string, size: number): Promise<RemoteBotFile> {
    const at = this.now()
    ;(await this.kept()).set(place, { size, used: at })
    void utimes(path, at / 1000, at / 1000).catch(() => undefined)
    return { path, name: basename(path), size }
  }

  private async load(node: NodeId, botId: string, ref: string, place: string, given?: AbortSignal): Promise<RemoteBotFile> {
    const stamp = this.stamp(node, botId)
    const run = { node, botId, stop: new AbortController() }
    this.running.add(run)
    const signal = given ? AbortSignal.any([given, run.stop.signal]) : run.stop.signal
    try {
      const kept = await this.copyAt(place)
      if (kept && !this.options.online(node)) return await this.shown(place, kept, (await stat(kept)).size)
      const release = await this.reads.enter(node, signal)
      try {
        let first: RemoteFilePage
        try {
          first = await this.page(node, botId, ref, 0, signal)
        } catch (error) {
          if (this.stamp(node, botId) !== stamp) throw dropped()
          // The computer went away meanwhile: the copy here still shows. A refusal (the bot lost, the file gone) does not.
          const code = error instanceof DomainRpcError ? error.code : undefined
          if (kept && (code === 'computer_offline' || code === 'deadline_exceeded')) return await this.shown(place, kept, (await stat(kept)).size)
          throw error
        }
        const head = Buffer.from(first.dataB64, 'base64')
        if (isSvgName(first.name) || looksLikeSvg(head, head.length === first.size)) throw new DomainRpcError('conflict', 'SVG files don’t open on another device.')
        // A picture is one by its bytes, whatever its name or the other computer says.
        if (remoteFileType(first.name).image && !sniffImage(head)) throw new DomainRpcError('conflict', 'This picture can’t be shown here.')
        if (kept && (await this.same(kept, first.size, head))) return await this.shown(place, kept, first.size)
        if (this.stamp(node, botId) !== stamp) throw dropped()
        await mkdir(place, { recursive: true, mode: 0o700 })
        const temp = join(place, `${this.temp}${randomUUID()}`)
        const handle = await open(temp, 'w', 0o600)
        try {
          await handle.write(head, 0, head.length, 0)
          let offset = head.length
          while (offset < first.size) {
            const page = await this.page(node, botId, ref, offset, signal)
            // The file changed while it was read: read again on the next look.
            if (page.size !== first.size || page.offset !== offset) throw new DomainRpcError('conflict', 'The file changed while it was read. Try again.')
            const bytes = Buffer.from(page.dataB64, 'base64')
            if (!bytes.length) throw unreadable()
            await handle.write(bytes, 0, bytes.length, offset)
            offset += bytes.length
          }
          if (offset !== first.size) throw unreadable()
        } catch (error) {
          await handle.close()
          await rm(temp, { force: true })
          throw this.stamp(node, botId) !== stamp ? dropped() : error
        }
        await handle.close()
        return await this.settle(node, botId, stamp, place, temp, attachmentFileName(first.name))
      } finally {
        release()
      }
    } finally {
      this.running.delete(run)
    }
  }

  private async page(node: NodeId, botId: string, ref: string, offset: number, signal?: AbortSignal): Promise<RemoteFilePage> {
    const page = await this.options.read(node, botId, ref, offset, signal)
    if (!isPage(page) || page.offset !== offset || page.size < 0 || page.size > REMOTE_BOT_FILE_BYTES) throw unreadable()
    return page
  }

  /** Whether the copy here is the file there now: the same size and the same first page. */
  private async same(path: string, size: number, head: Buffer): Promise<boolean> {
    try {
      const handle = await open(path, 'r')
      try {
        if ((await handle.stat()).size !== size) return false
        const mine = Buffer.alloc(head.length)
        await handle.read(mine, 0, mine.length, 0)
        return mine.equals(head)
      } finally {
        await handle.close()
      }
    } catch {
      return false
    }
  }

  /** Stops what is under way for the bots `matches` names, and forgets their copies. */
  private stop(matches: (node: string, botId: string) => boolean, under: string): void {
    for (const run of this.running) if (matches(run.node, run.botId)) run.stop.abort(dropped())
    for (const place of this.loading.keys()) if (place.startsWith(under)) this.loading.delete(place)
    void this.listed?.then((kept) => {
      for (const place of kept.keys()) if (place.startsWith(under)) kept.delete(place)
    })
  }

  /** The copies of bots lost here go; a read or copy under way for them writes nothing. */
  dropBots(node: NodeId, botIds: Iterable<string>): void {
    for (const botId of botIds) {
      const key = `${node}\n${botId}`
      this.drops.set(key, (this.drops.get(key) ?? 0) + 1)
      const folder = join(this.options.folder, node, botId)
      this.stop((runNode, runBot) => runNode === node && runBot === botId, folder + sep)
      rmSync(folder, { recursive: true, force: true })
    }
  }

  /** Every copy of a computer's bots goes; a read or copy under way for them writes nothing. */
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
