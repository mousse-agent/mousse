import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync } from 'node:fs'
import { appendFile, writeFile } from 'node:fs/promises'
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
}

export interface BotStagingOptions {
  /** The staging area: `<profileHome>/bots/staging`. Emptied when the service starts. */
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
  /** A part is being written, or a message is using it. */
  busy: boolean
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
 * Files the user's other devices send a bot ahead of the message that carries them (`bots.stage`), apart from the
 * routed thread staging: admitted by the bot gate, bound to one bot and one device, and kept only until a message
 * uses them. They are written in the staging area here, never in the bot's files folder; the message copies each into
 * that folder (`copyBotAttachments`) and the staged file goes.
 *
 * Limits are named defaults: one file `REMOTE_BOT_FILE_BYTES`; per device `BOT_STAGE_CALLER_FILES` files and
 * `BOT_STAGE_CALLER_BYTES`; in all `BOT_STAGE_TOTAL_BYTES`; an unused file goes after `BOT_STAGE_TTL_MS`. A file
 * counts its whole declared size from its first part. Kept in memory: a restart empties the area, and a device sends
 * again.
 */
export class BotStaging {
  private readonly files = new Map<string, Staged>()
  private readonly now: () => number

  constructor(private readonly options: BotStagingOptions) {
    this.now = () => options.clock?.now() ?? Date.now()
    try {
      rmSync(options.folder, { recursive: true, force: true })
    } catch {
      // What is left is never named again; the next start tries again.
    }
  }

  private get limits(): Required<Omit<BotStagingLimits, 'sweepMs'>> {
    const given = this.options.limits ?? {}
    return {
      file: given.file ?? REMOTE_BOT_FILE_BYTES,
      callerFiles: given.callerFiles ?? BOT_STAGE_CALLER_FILES,
      callerBytes: given.callerBytes ?? BOT_STAGE_CALLER_BYTES,
      totalBytes: given.totalBytes ?? BOT_STAGE_TOTAL_BYTES,
      ttlMs: given.ttlMs ?? BOT_STAGE_TTL_MS
    }
  }

  /** The first part of a file: checked against the limits, kept for `caller` and `botId` alone. Answers its id. */
  async begin(caller: string, botId: string, name: string, size: number, first: Buffer): Promise<{ stage: string; received: number; size: number }> {
    this.sweep()
    const limits = this.limits
    if (size > limits.file)
      throw new NetError('too_large', `${name} is larger than ${limits.file / 1024 / 1024} MB.`, { details: { reason: 'stage_too_large' } })
    const mine = [...this.files.values()].filter((file) => file.caller === caller)
    if (mine.length >= limits.callerFiles || mine.reduce((sum, file) => sum + file.size, 0) + size > limits.callerBytes)
      throw new NetError('conflict', 'Too many files are on their way. Send again when these are sent.', { details: { reason: 'stage_full' } })
    if (this.used() + size > limits.totalBytes)
      throw new NetError('conflict', 'The computer is holding as many files as it may. Try again shortly.', { details: { reason: 'stage_full' } })
    const id = `bst_${randomUUID().replaceAll('-', '')}`
    const path = join(this.options.folder, id)
    const file: Staged = { id, botId, caller, name, size, received: 0, path, createdAt: this.now(), busy: true }
    this.files.set(id, file)
    try {
      mkdirSync(this.options.folder, { recursive: true, mode: 0o700 })
      await writeFile(path, Buffer.alloc(0), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      this.remove([file])
      throw storageError(error)
    }
    file.busy = false
    return this.append(caller, botId, id, 0, first)
  }

  /** The next part of a file `caller` began for `botId`, at exactly the bytes received so far. */
  async append(caller: string, botId: string, id: string, offset: number, part: Buffer): Promise<{ stage: string; received: number; size: number }> {
    const file = this.own(caller, botId, id)
    if (file.busy) throw new NetError('conflict', 'That file is busy.', { details: { reason: 'stage_busy' } })
    if (offset !== file.received)
      throw new NetError('conflict', 'That part is not the next one.', { details: { reason: 'stage_offset', received: file.received } })
    if (part.length > BOT_STAGE_PART_BYTES || file.received + part.length > file.size || (!part.length && file.received < file.size))
      throw new NetError('bad_request')
    file.busy = true
    try {
      if (part.length) await appendFile(file.path, part)
      file.received += part.length
    } catch (error) {
      this.remove([file])
      throw storageError(error)
    } finally {
      file.busy = false
    }
    return { stage: id, received: file.received, size: file.size }
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

  /** Gives back the claims of a message that did not go. */
  release(ids: readonly string[]): void {
    for (const id of ids) {
      const file = this.files.get(id)
      if (file) file.busy = false
    }
  }

  /** The files a message used, or one that failed, are done with. */
  drop(ids: readonly string[]): void {
    this.remove(ids.flatMap((id) => this.files.get(id) ?? []))
  }

  /** Drops every file whose device no longer reaches its bot (its level went to Off, it left the bot's Devices). */
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

  /** Looks for expired files every `sweepMs`; returns what stops it. */
  start(): () => void {
    const timer = setInterval(() => {
      try {
        this.sweep()
      } catch {
        // The next interval tries again.
      }
    }, this.options.limits?.sweepMs ?? 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }

  /** Everything staged goes. */
  close(): void {
    this.remove([...this.files.values()])
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

  private remove(files: readonly Staged[]): void {
    for (const file of files) {
      this.files.delete(file.id)
      try {
        rmSync(file.path, { force: true })
      } catch {
        // Emptied with the area at the next start.
      }
    }
  }
}

function storageError(error: unknown): NetError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'ENOSPC' || code === 'EDQUOT') return new NetError('conflict', 'The computer has no room for this file.', { details: { reason: 'storage_full' } })
  return new NetError('conflict', 'The computer could not keep this file.')
}
