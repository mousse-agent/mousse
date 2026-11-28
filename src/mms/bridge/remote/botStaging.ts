import { randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { NetError } from '../../../shared/net'
import {
  BOT_STAGE_CALLER_BYTES,
  BOT_STAGE_CALLER_FILES,
  BOT_STAGE_PART_BYTES,
  BOT_STAGE_TOTAL_BYTES,
  BOT_STAGE_TTL_MS,
  REMOTE_BOT_FILE_BYTES
} from '../../../shared/bots/personal/remoteFiles'
import { SVG_SNIFF_BYTES, looksLikeSvg } from './botFiles'

export interface BotStagingLimits {
  /** One file. Default `REMOTE_BOT_FILE_BYTES`. */
  file?: number
  /** Files one device holds at once. Default `BOT_STAGE_CALLER_FILES`. */
  callerFiles?: number
  /** Bytes one device holds at once. Default `BOT_STAGE_CALLER_BYTES`. */
  callerBytes?: number
  /** Bytes all devices hold. Default `BOT_STAGE_TOTAL_BYTES`. */
  totalBytes?: number
  /** How long an unused file is kept. Default `BOT_STAGE_TTL_MS`. */
  ttlMs?: number
  sweepMs?: number
  /** How long after `start` what earlier runs left is tidied (`tidy`). Default `BOT_STAGE_TIDY_DELAY_MS`. */
  tidyDelayMs?: number
}

/** What earlier runs left in the staging area is tidied this long after the Bridge starts, in the background. */
export const BOT_STAGE_TIDY_DELAY_MS = 30_000

export interface BotStagingOptions {
  /** The staging area: `<profileHome>/bots/staging`. Each run keeps its files in a folder of its own there. */
  folder: string
  clock?: { now(): number }
  limits?: BotStagingLimits
}

interface Staged {
  id: string
  botId: string
  caller: string
  name: string
  size: number
  received: number
  path: string
  createdAt: number
  /** Open while parts arrive; closed when the last one is in, or when the file is dropped. */
  handle?: FileHandle
  /** A part is being written, or a message is using it. */
  busy: boolean
  /** Dropped: nothing more is written to it. */
  dropped: boolean
}

/** A staged file a message takes: the name the device gave it and where its bytes are, for the bot's files folder. */
export interface TakenStage {
  name: string
  path: string
}

/** What another device reads for a staged file that is not its own, not this bot's, used, expired or never there. */
const missing = (): never => {
  throw new NetError('stream_unknown', 'That file is no longer held. Send it again.', { details: { reason: 'stage_not_found' } })
}

/**
 * Whether a device's staged file for a bot goes: the bot is gone (`bots`, when known), the device no longer reaches it
 * (its level Off, left out of the bot's Devices), the device is blocked here, or it left the account (`present`, when
 * the account's devices can be read).
 */
export function stagedFileLost(where: {
  bots?: readonly string[]
  canReach(botId: string, node: string): boolean
  blocked(node: string): boolean
  present?: readonly string[]
}): (botId: string, node: string) => boolean {
  return (botId, node) =>
    (where.bots !== undefined && !where.bots.includes(botId)) ||
    where.blocked(node) ||
    (where.present !== undefined && !where.present.includes(node)) ||
    !where.canReach(botId, node)
}

/**
 * Files the user's other devices send a bot ahead of the message that carries them (`bots.stage`), apart from the
 * routed thread staging: admitted by the bot gate, bound to one bot and one device, and kept only until a message
 * uses them. They are written in the staging area here, never in the bot's files folder; the message copies each into
 * that folder (`copyBotAttachments`) and the staged file goes.
 *
 * Limits are named defaults: one file `REMOTE_BOT_FILE_BYTES`; per device `BOT_STAGE_CALLER_FILES` files and
 * `BOT_STAGE_CALLER_BYTES`; in all `BOT_STAGE_TOTAL_BYTES`; an unused file goes after `BOT_STAGE_TTL_MS`. A file
 * counts its whole declared size from its first part. Kept in memory: a restart forgets them, and a device sends
 * again. Each run writes in a folder of its own; what earlier runs left is removed in the background after the start
 * (`start`, `tidy`), so a start never waits on the disk.
 *
 * A file's parts are written through its open handle, which a drop closes: a part still being written when its file is
 * dropped never makes the file again. Any failure of a part drops its file.
 */
export class BotStaging {
  private readonly files = new Map<string, Staged>()
  private readonly now: () => number
  private readonly run = `run-${randomUUID()}`
  private readonly removing = new Set<Promise<void>>()

  constructor(private readonly options: BotStagingOptions) {
    this.now = () => options.clock?.now() ?? Date.now()
  }

  /** This run's folder in the staging area. */
  get area(): string {
    return join(this.options.folder, this.run)
  }

  private get limits(): Required<Omit<BotStagingLimits, 'sweepMs' | 'tidyDelayMs'>> {
    const given = this.options.limits ?? {}
    return {
      file: given.file ?? REMOTE_BOT_FILE_BYTES,
      callerFiles: given.callerFiles ?? BOT_STAGE_CALLER_FILES,
      callerBytes: given.callerBytes ?? BOT_STAGE_CALLER_BYTES,
      totalBytes: given.totalBytes ?? BOT_STAGE_TOTAL_BYTES,
      ttlMs: given.ttlMs ?? BOT_STAGE_TTL_MS
    }
  }

  /**
   * Refuses a first part `begin` would refuse (its size, the device's and the area's limits) without keeping anything,
   * so a refusal can be given before the call is taken (`bots.stage`'s check for a new call): a refusal then is certain.
   */
  checkBegin(caller: string, name: string, size: number): void {
    this.sweep()
    const limits = this.limits
    if (size > limits.file)
      throw new NetError('too_large', `${name} is larger than ${limits.file / 1024 / 1024} MB.`, { details: { reason: 'stage_too_large' } })
    const mine = [...this.files.values()].filter((file) => file.caller === caller)
    if (mine.length >= limits.callerFiles || mine.reduce((sum, file) => sum + file.size, 0) + size > limits.callerBytes)
      throw new NetError('conflict', 'Too many files are on their way. Send again when these are sent.', { details: { reason: 'stage_full' } })
    if (this.used() + size > limits.totalBytes)
      throw new NetError('conflict', 'The computer is holding as many files as it may. Try again shortly.', { details: { reason: 'stage_full' } })
  }

  /** Refuses a next part `append` would refuse, without writing it (see `checkBegin`). */
  checkAppend(caller: string, botId: string, id: string, offset: number, length: number): void {
    this.sweep()
    this.nextPart(this.own(caller, botId, id), offset, length)
  }

  private nextPart(file: Staged, offset: number, length: number): void {
    if (file.busy) throw new NetError('conflict', 'That file is busy.', { details: { reason: 'stage_busy' } })
    if (offset !== file.received)
      throw new NetError('conflict', 'That part is not the next one.', { details: { reason: 'stage_offset', received: file.received } })
    if (length < 1 || length > BOT_STAGE_PART_BYTES || file.received + length > file.size) throw new NetError('bad_request')
  }

  /** The first part of a file: checked against the limits, kept for `caller` and `botId` alone. Answers its id. */
  async begin(caller: string, botId: string, name: string, size: number, first: Buffer): Promise<{ stage: string; received: number; size: number }> {
    this.checkBegin(caller, name, size)
    const id = `bst_${randomUUID().replaceAll('-', '')}`
    const file: Staged = { id, botId, caller, name, size, received: 0, path: join(this.area, id), createdAt: this.now(), busy: true, dropped: false }
    this.files.set(id, file)
    try {
      await mkdir(this.area, { recursive: true, mode: 0o700 })
      // Read back too: the whole file's start is looked at when its last part is in.
      const handle = await open(file.path, 'wx+', 0o600)
      if (file.dropped) {
        await handle.close()
        await rm(file.path, { force: true })
        return missing()
      }
      file.handle = handle
    } catch (error) {
      this.remove([file])
      throw error instanceof NetError ? error : storageError(error)
    }
    file.busy = false
    return this.append(caller, botId, id, 0, first)
  }

  /**
   * The next part of a file `caller` began for `botId`, at exactly the bytes received so far. A part that can't be
   * taken drops the file; the device sends it again from the start. The whole file's start is looked at again when its
   * last part is in: an SVG is never kept.
   */
  async append(caller: string, botId: string, id: string, offset: number, part: Buffer): Promise<{ stage: string; received: number; size: number }> {
    const file = this.own(caller, botId, id)
    try {
      this.nextPart(file, offset, part.length)
    } catch (error) {
      this.remove([file])
      throw error
    }
    file.busy = true
    try {
      const handle = file.handle
      if (!handle) return missing()
      for (let written = 0; written < part.length;) {
        const { bytesWritten } = await handle.write(part, written, part.length - written, offset + written)
        if (file.dropped) return missing()
        written += bytesWritten
      }
      file.received += part.length
      if (file.received === file.size) {
        file.handle = undefined
        try {
          await this.checkWhole(file, handle)
        } finally {
          await handle.close()
        }
      }
    } catch (error) {
      this.remove([file])
      throw error instanceof NetError ? error : storageError(error)
    } finally {
      file.busy = false
    }
    return { stage: id, received: file.received, size: file.size }
  }

  /** Refuses a whole file whose start is SVG, whatever its first part looked like. */
  private async checkWhole(file: Staged, handle: FileHandle): Promise<void> {
    const head = Buffer.alloc(Math.min(SVG_SNIFF_BYTES, file.size))
    const { bytesRead } = await handle.read(head, 0, head.length, 0)
    if (looksLikeSvg(head.subarray(0, bytesRead), bytesRead === file.size))
      throw new NetError('conflict', 'SVG files can’t be sent to another computer.', { details: { reason: 'svg' } })
  }

  /**
   * Checks that every id names a whole file `caller` staged for `botId`, unused by another message, and claims them
   * all for one message. A file of another bot or another device answers as one that is not there.
   */
  take(caller: string, botId: string, ids: readonly string[]): TakenStage[] {
    const files = this.ready(caller, botId, ids)
    for (const file of files) file.busy = true
    return files.map((file) => ({ name: file.name, path: file.path }))
  }

  /** Checks without claiming: what `take` would refuse is refused here. */
  check(caller: string, botId: string, ids: readonly string[]): void {
    this.ready(caller, botId, ids)
  }

  private ready(caller: string, botId: string, ids: readonly string[]): Staged[] {
    this.sweep()
    if (new Set(ids).size !== ids.length) throw new NetError('bad_request')
    const files = ids.map((id) => this.own(caller, botId, id))
    for (const file of files) {
      if (file.busy) throw new NetError('conflict', 'That file is busy.', { details: { reason: 'stage_busy' } })
      if (file.received !== file.size) throw new NetError('conflict', 'That file has not all arrived. Send it again.', { details: { reason: 'stage_incomplete' } })
    }
    return files
  }

  /** The files a message used, or one that failed, are done with. */
  drop(ids: readonly string[]): void {
    this.remove(ids.flatMap((id) => this.files.get(id) ?? []))
  }

  /** Drops every file whose device no longer reaches its bot (`stagedFileLost`). */
  dropWhere(lost: (botId: string, caller: string) => boolean): number {
    const gone = [...this.files.values()].filter((file) => lost(file.botId, file.caller))
    this.remove(gone)
    return gone.length
  }

  /** Drops files held longer than their hour. */
  sweep(): number {
    const cutoff = this.now() - this.limits.ttlMs
    const expired = [...this.files.values()].filter((file) => file.createdAt <= cutoff && !file.busy)
    this.remove(expired)
    return expired.length
  }

  /** Bytes held (declared sizes), for `caller` or in all. */
  used(caller?: string): number {
    let total = 0
    for (const file of this.files.values()) if (caller === undefined || file.caller === caller) total += file.size
    return total
  }

  count(caller?: string): number {
    return [...this.files.values()].filter((file) => caller === undefined || file.caller === caller).length
  }

  /**
   * Looks for expired files every `sweepMs`, and tidies what earlier runs left a while after the start (`tidyDelayMs`),
   * in the background. Returns what stops both.
   */
  start(): () => void {
    const timer = setInterval(() => {
      try {
        this.sweep()
      } catch {
        // The next interval tries again.
      }
    }, this.options.limits?.sweepMs ?? 60_000)
    timer.unref?.()
    const tidy = setTimeout(() => void this.tidy().catch(() => 0), this.options.limits?.tidyDelayMs ?? BOT_STAGE_TIDY_DELAY_MS)
    tidy.unref?.()
    return () => {
      clearInterval(timer)
      clearTimeout(tidy)
    }
  }

  /** Removes what earlier runs left in the staging area (never this run's folder). Answers how many entries went. */
  async tidy(): Promise<number> {
    let entries: string[]
    try {
      entries = await readdir(this.options.folder)
    } catch {
      return 0
    }
    let removed = 0
    for (const entry of entries) {
      if (entry === this.run) continue
      try {
        await rm(join(this.options.folder, entry), { recursive: true, force: true })
        removed += 1
      } catch {
        // Tried again at the next start.
      }
    }
    return removed
  }

  /** Everything staged goes. */
  close(): void {
    this.remove([...this.files.values()])
  }

  /** Waits until the files dropped so far are off the disk. */
  async settled(): Promise<void> {
    while (this.removing.size) await Promise.all([...this.removing])
  }

  private own(caller: string, botId: string, id: string): Staged {
    const file = this.files.get(id)
    if (!file || file.caller !== caller || file.botId !== botId) return missing()
    if (file.createdAt <= this.now() - this.limits.ttlMs && !file.busy) {
      this.remove([file])
      return missing()
    }
    return file
  }

  /** Forgets the files at once; their handles close (after a write still running) and the files go, in the background. */
  private remove(files: readonly Staged[]): void {
    for (const file of files) {
      if (file.dropped) continue
      file.dropped = true
      this.files.delete(file.id)
      const handle = file.handle
      file.handle = undefined
      const work = (async () => {
        await handle?.close().catch(() => undefined)
        await rm(file.path, { force: true }).catch(() => undefined)
      })()
      this.removing.add(work)
      void work.finally(() => this.removing.delete(work))
    }
  }
}

function storageError(error: unknown): NetError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return new NetError('conflict', 'The computer has no room for this file.', { details: { reason: 'storage_full' } })
  return new NetError('conflict', 'The computer could not keep this file.')
}
