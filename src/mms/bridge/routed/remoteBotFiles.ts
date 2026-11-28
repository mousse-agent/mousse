import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { open, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { NodeId } from '../../../shared/net'
import { attachmentFileName } from '../../../shared/bots/personal/attachments'
import { REMOTE_BOT_FILE_BYTES, isBotFileRef, isSvgName } from '../../../shared/bots/personal/remoteFiles'
import { DomainRpcError } from '../../protocol/domainRegistry'
import { looksLikeSvg } from '../remote/botFiles'
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

export interface RemoteBotFilesOptions {
  /** Where the copies are kept: `<profileHome>/bots/remote-files`. */
  folder: string
  /** Reads one page of `ref` from the bot's computer (`bots.chat.file`). */
  read(node: NodeId, botId: string, ref: string, offset: number, signal?: AbortSignal): Promise<RemoteFilePage>
  /** Whether the bot's computer is reached now; while it is not, a copy kept here is answered as it is. */
  online(node: NodeId): boolean
  /** Reads at once to one computer; the rest wait. Default 2. */
  readsPerComputer?: number
}

const isPage = (value: unknown): value is RemoteFilePage => {
  const page = value as Partial<RemoteFilePage> | null
  return !!page && typeof page.name === 'string' && typeof page.mime === 'string' && Number.isSafeInteger(page.size) &&
    Number.isSafeInteger(page.offset) && typeof page.dataB64 === 'string'
}
const unreadable = (): DomainRpcError => new DomainRpcError('bad_reply', 'The other computer sent an unreadable file.')

/**
 * The files of other computers' bots that this computer's windows show (pictures in their chats), each copied here
 * once from the bot's files folder there, a page at a time (`bots.chat.file`), so the window shows it as it shows a
 * file of this computer. The copy is checked again on each look: its size and first page against the bot's file now.
 * While that computer is away a copy kept here still shows. A bot lost here (`dropBots`, `dropComputer`) takes its
 * copies with it.
 *
 * Reads have their own small pool per computer (`readsPerComputer`), apart from routed large reads and from bot
 * calls, so a chat never waits behind pictures, and pictures never wait behind threads. Nothing here runs at start.
 */
export class RemoteBotFiles {
  private readonly loading = new Map<string, Promise<RemoteBotFile>>()
  private readonly reads: Lanes

  constructor(private readonly options: RemoteBotFilesOptions) {
    this.reads = new Lanes(options.readsPerComputer ?? 2)
  }

  /** Where the copy of `ref` of `node`'s bot `botId` goes; the folder holds only that file. */
  private placeOf(node: NodeId, botId: string, ref: string): string {
    return join(this.options.folder, node, botId, createHash('sha256').update(ref).digest('hex').slice(0, 32))
  }

  /** The copy of `ref`, read from the bot's computer when there is none here or the file there changed. */
  async fetch(node: NodeId, botId: string, ref: string, signal?: AbortSignal): Promise<RemoteBotFile> {
    if (!isBotFileRef(ref)) throw new DomainRpcError('invalid_params', 'path is not a file of the bot.')
    const place = this.placeOf(node, botId, ref)
    const known = this.loading.get(place)
    if (known) return known
    const work = this.load(node, botId, ref, place, signal).finally(() => this.loading.delete(place))
    this.loading.set(place, work)
    return work
  }

  /**
   * A file this computer just sent the bot, kept as the copy of the place it got there, so it shows without being read
   * back. Best effort.
   */
  seed(node: NodeId, botId: string, ref: string, name: string, from: string): void {
    if (!isBotFileRef(ref) || isSvgName(name)) return
    try {
      const place = this.placeOf(node, botId, ref)
      rmSync(place, { recursive: true, force: true })
      mkdirSync(place, { recursive: true, mode: 0o700 })
      copyFileSync(from, join(place, attachmentFileName(name)))
    } catch {
      // Read from the bot's computer when it is shown.
    }
  }

  private kept(place: string): string | undefined {
    try {
      const name = readdirSync(place).find((entry) => !entry.endsWith('.part'))
      return name ? join(place, name) : undefined
    } catch {
      return undefined
    }
  }

  private async load(node: NodeId, botId: string, ref: string, place: string, signal?: AbortSignal): Promise<RemoteBotFile> {
    const kept = this.kept(place)
    if (kept && !this.options.online(node)) {
      const size = (await stat(kept)).size
      return { path: kept, name: basename(kept), size }
    }
    const release = await this.reads.enter(node, signal)
    try {
      let first: RemoteFilePage
      try {
        first = await this.page(node, botId, ref, 0, signal)
      } catch (error) {
        // The computer went away meanwhile: the copy here still shows. A refusal (the bot lost, the file gone) does not.
        const code = error instanceof DomainRpcError ? error.code : undefined
        if (kept && (code === 'computer_offline' || code === 'deadline_exceeded')) return { path: kept, name: basename(kept), size: (await stat(kept)).size }
        throw error
      }
      const head = Buffer.from(first.dataB64, 'base64')
      if (isSvgName(first.name) || looksLikeSvg(head.subarray(0, 1024))) throw new DomainRpcError('conflict', 'SVG files don’t open on another device.')
      if (kept && (await this.same(kept, first.size, head))) return { path: kept, name: basename(kept), size: first.size }
      const name = attachmentFileName(first.name)
      mkdirSync(place, { recursive: true, mode: 0o700 })
      const target = join(place, name)
      const partial = `${target}.part`
      const handle = await open(partial, 'w', 0o600)
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
        await rm(partial, { force: true })
        throw error
      }
      await handle.close()
      // One file per place: an older copy under another name goes.
      for (const entry of readdirSync(place)) if (entry !== `${name}.part`) rmSync(join(place, entry), { force: true })
      await rename(partial, target)
      return { path: target, name, size: first.size }
    } finally {
      release()
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

  /** The copies of bots lost here go. */
  dropBots(node: NodeId, botIds: Iterable<string>): void {
    for (const botId of botIds) rmSync(join(this.options.folder, node, botId), { recursive: true, force: true })
  }

  /** Every copy of a computer's bots goes. */
  dropComputer(node: NodeId): void {
    rmSync(join(this.options.folder, node), { recursive: true, force: true })
  }

  /** Keeps the copies of the computers `keep` names; the rest go. */
  keepComputers(keep: (node: string) => boolean): void {
    if (!existsSync(this.options.folder)) return
    for (const node of readdirSync(this.options.folder)) if (!keep(node)) rmSync(join(this.options.folder, node), { recursive: true, force: true })
  }
}
