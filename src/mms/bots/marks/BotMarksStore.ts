import { mkdirSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { isId } from '../../../shared/net/ids'
import { parseQualifiedId } from '../../../shared/threadRef'
import { noMarks, withMark, type BotMark, type BotMarks, type BotMarksByRef } from '../../../shared/bots/personal/marks'
import { atomicWriteJsonSync } from '../../data/AtomicFs'
import { isBotId } from '../definitions/BotDefinitionStore'

export const BOT_MARKS_FILE = 'bot-marks.json'

interface StoredFile {
  version: 1
  bots: BotMarksByRef
}

const plain = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** A bot ref: this computer's bot id, or `<node>:<botId>` for another computer's. */
export function isBotRef(value: unknown): value is string {
  const ref = parseQualifiedId(value)
  return ref ? isId('node', ref.node) && isBotId(ref.id) : isBotId(value)
}

/** One stored entry as this build reads it; what it does not know is left out. */
function readMarks(value: unknown): BotMarks {
  if (!plain(value)) return {}
  const marks: BotMarks = {}
  if (typeof value.pinnedAt === 'string' && Number.isFinite(Date.parse(value.pinnedAt))) marks.pinnedAt = value.pinnedAt
  if (value.hidden === true) marks.hidden = true
  if (value.muted === true) marks.muted = true
  if (value.unread === true) marks.unread = true
  return marks
}

/**
 * The marks this computer keeps on bots (`BotMarks`), for its own bots and the other computers' alike, in
 * `<profile>/bots/bot-marks.json`:
 *
 *     { "version": 1, "bots": { "b_…": { "pinnedAt": "…" }, "nod_…:b_…": { "hidden": true, "muted": true } } }
 *
 * Read on first use, never on a start. A file that can't be read is no marks; the first change after it puts it aside
 * (`bot-marks.json.corrupt-<time>`). A bot of another computer that this one loses (`RemoteBotRegistry`) takes its marks
 * with it (`dropBots`, `dropComputer`), and a bot of this computer that is gone for good takes its own (`dropLocal`).
 */
export class BotMarksStore {
  private marks?: Map<string, BotMarks>
  private broken = false
  readonly path: string

  constructor(
    /** `<profile>/bots`. */
    private readonly folder: string,
    private readonly now: () => number = () => Date.now()
  ) {
    this.path = join(folder, BOT_MARKS_FILE)
  }

  /** Every bot's marks. */
  list(): BotMarksByRef {
    return Object.fromEntries([...this.read()].map(([ref, marks]) => [ref, { ...marks }]))
  }

  /** The marks of one bot; none when it has none. */
  get(ref: string): BotMarks {
    return { ...this.read().get(ref) }
  }

  /** Sets or clears one mark; every bot's marks as they are now. */
  set(ref: string, mark: BotMark, on: boolean): BotMarksByRef {
    const marks = this.read()
    const before = marks.get(ref)
    const next = withMark(before, mark, on, new Date(this.now()).toISOString())
    if (noMarks(next)) {
      if (before) {
        marks.delete(ref)
        this.write()
      }
    } else if (JSON.stringify(next) !== JSON.stringify(before ?? {})) {
      marks.set(ref, next)
      this.write()
    }
    return this.list()
  }

  /** Drops the marks of `node`'s bots named (by their ids there). True when any went. */
  dropBots(node: string, botIds: Iterable<string>): boolean {
    const refs = new Set([...botIds].map((botId) => `${node}:${botId}`))
    return this.drop((ref) => refs.has(ref))
  }

  /** Drops the marks of every bot of `node`. True when any went. */
  dropComputer(node: string): boolean {
    return this.drop((ref) => parseQualifiedId(ref)?.node === node)
  }

  /** Drops the marks of this computer's bots that `exists` no longer knows. True when any went. */
  dropLocal(exists: (botId: string) => boolean): boolean {
    return this.drop((ref) => !parseQualifiedId(ref) && !exists(ref))
  }

  private drop(matches: (ref: string) => boolean): boolean {
    const marks = this.read()
    const gone = [...marks.keys()].filter(matches)
    if (!gone.length) return false
    for (const ref of gone) marks.delete(ref)
    this.write()
    return true
  }

  private read(): Map<string, BotMarks> {
    if (this.marks) return this.marks
    const marks = new Map<string, BotMarks>()
    let raw: string | undefined
    try {
      raw = readFileSync(this.path, 'utf8')
    } catch {
      // No file yet: no marks.
    }
    if (raw !== undefined) {
      try {
        const file = JSON.parse(raw) as unknown
        if (!plain(file) || file.version !== 1 || !plain(file.bots)) throw new Error('not a marks file this build knows')
        for (const [ref, value] of Object.entries(file.bots)) {
          if (!isBotRef(ref)) continue
          const entry = readMarks(value)
          if (!noMarks(entry)) marks.set(ref, entry)
        }
      } catch (error) {
        this.broken = true
        console.warn('bot marks could not be read', error instanceof Error ? error.message : String(error))
      }
    }
    this.marks = marks
    return marks
  }

  private write(): void {
    mkdirSync(this.folder, { recursive: true })
    if (this.broken) {
      try {
        renameSync(this.path, `${this.path}.corrupt-${this.now()}`)
      } catch {
        // Gone already: nothing to keep.
      }
      this.broken = false
    }
    const file: StoredFile = { version: 1, bots: Object.fromEntries(this.marks ?? []) }
    atomicWriteJsonSync(this.path, file)
  }
}
