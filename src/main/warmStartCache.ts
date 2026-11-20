import { promises as fsp } from 'node:fs'
import type { ProfilePublicDto } from '../shared/profiles/types'
import type { WarmStartView } from '../shared/warmStart'

/**
 * The warm start: what each profile's window last showed (its thread list, projects, the open thread and that thread's
 * newest messages), so the next launch shows it before the background service answers.
 *
 * Everything here is noted from what main already sends to a window; nothing asks the service. The file is read once
 * at startup and written in the background: a write waits for updates to settle (`WARM_START_WRITE_DELAY_MS`, at most
 * `WARM_START_MAX_WRITE_DELAY_MS` while they keep coming), goes to a temporary file that then replaces the old one, and
 * is skipped rather than grown past `WARM_START_MAX_BYTES`.
 */

const FILE_VERSION = 1
/** Messages kept of the open thread: enough to fill a window. */
export const WARM_START_MAX_MESSAGES = 40
/** The file never grows past this; messages, then other profiles, go first. */
export const WARM_START_MAX_BYTES = 2 * 1024 * 1024
/** Profiles kept, the most recently shown first. */
export const WARM_START_MAX_PROFILES = 4
export const WARM_START_WRITE_DELAY_MS = 2_000
export const WARM_START_MAX_WRITE_DELAY_MS = 20_000
/** A profile picture larger than this is left out; the button shows the initial instead. */
const MAX_AVATAR_CHARS = 64 * 1024

interface ProfileEntry {
  profile?: ProfilePublicDto
  threads?: unknown[]
  projects?: unknown[]
  activeThreadId?: string | null
  transcript?: { threadId: string; messages: Array<{ id?: unknown }> } | null
}

interface WarmStartFile {
  version: number
  lastProfileId: string | null
  /** Most recently shown first. */
  profiles: Array<[string, ProfileEntry]>
}

export interface WarmStartFs {
  readFile: (path: string, encoding: 'utf8') => Promise<string>
  writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  rm: (path: string, options: { force: boolean }) => Promise<void>
}

export interface WarmStartCacheOptions {
  fs?: WarmStartFs
  writeDelayMs?: number
  maxWriteDelayMs?: number
  maxBytes?: number
  maxMessages?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: (message: string) => void
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The rows of a list as a channel carries it: a bare array, or `{ threads }` / `{ projects }` (a versioned list). */
function rowsOf(data: unknown, key: 'threads' | 'projects'): unknown[] | undefined {
  if (Array.isArray(data)) return data
  if (isRecord(data) && Array.isArray(data[key])) return data[key] as unknown[]
  return undefined
}

export class WarmStartCache {
  private readonly fs: WarmStartFs
  private readonly writeDelayMs: number
  private readonly maxWriteDelayMs: number
  private readonly maxBytes: number
  private readonly maxMessages: number
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly log: (message: string) => void
  private readonly entries = new Map<string, ProfileEntry>()
  /** Profiles forgotten before the file was read: the file's copy is not taken back. */
  private readonly forgotten = new Set<string>()
  private lastProfileId: string | null = null
  private loading: Promise<void> | null = null
  private timer: unknown = null
  private firstPendingAt: number | null = null
  private writing: Promise<void> | null = null
  private dirtyWhileWriting = false

  constructor(private readonly file: string, options: WarmStartCacheOptions = {}) {
    this.fs = options.fs ?? {
      readFile: (path, encoding) => fsp.readFile(path, encoding),
      writeFile: (path, data, encoding) => fsp.writeFile(path, data, encoding),
      rename: (from, to) => fsp.rename(from, to),
      rm: (path, opts) => fsp.rm(path, opts)
    }
    this.writeDelayMs = options.writeDelayMs ?? WARM_START_WRITE_DELAY_MS
    this.maxWriteDelayMs = options.maxWriteDelayMs ?? WARM_START_MAX_WRITE_DELAY_MS
    this.maxBytes = options.maxBytes ?? WARM_START_MAX_BYTES
    this.maxMessages = options.maxMessages ?? WARM_START_MAX_MESSAGES
    this.setTimer = options.setTimer ?? ((fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle })
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
    this.log = options.log ?? ((message) => console.warn(message))
  }

  /** Reads the file once; later calls share that read. A missing or unreadable file starts empty. */
  load(): Promise<void> {
    this.loading ??= this.fs.readFile(this.file, 'utf8').then((text) => {
      const parsed = JSON.parse(text) as Partial<WarmStartFile>
      if (!isRecord(parsed) || parsed.version !== FILE_VERSION || !Array.isArray(parsed.profiles)) return
      // What was noted while the file was being read is newer than the file.
      for (const item of parsed.profiles) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || !isRecord(item[1]) || this.forgotten.has(item[0])) continue
        const noted = this.entries.get(item[0])
        this.entries.set(item[0], noted ? { ...(item[1] as ProfileEntry), ...noted } : item[1] as ProfileEntry)
      }
      if (this.lastProfileId === null && typeof parsed.lastProfileId === 'string' && !this.forgotten.has(parsed.lastProfileId)) this.lastProfileId = parsed.lastProfileId
    }).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') this.log(`Warm start cache could not be read: ${error instanceof Error ? error.message : String(error)}`)
    })
    return this.loading
  }

  /** What the last bound window showed, for a new window to show until its own profile is known. */
  async view(): Promise<WarmStartView | null> {
    await this.load()
    const profileId = this.lastProfileId
    const entry = profileId ? this.entries.get(profileId) : undefined
    if (!profileId || !entry?.threads) return null
    const activeThreadId = typeof entry.activeThreadId === 'string' ? entry.activeThreadId : null
    const transcript = entry.transcript && entry.transcript.threadId === activeThreadId ? entry.transcript.messages : []
    return {
      profileId,
      ...(entry.profile ? { profile: entry.profile } : {}),
      threads: entry.threads as WarmStartView['threads'],
      projects: (entry.projects ?? []) as WarmStartView['projects'],
      activeThreadId,
      messages: transcript as WarmStartView['messages']
    }
  }

  /** The thread a profile's window showed last, to open again at launch. */
  lastActiveThread(profileId: string): string | null {
    const id = this.entries.get(profileId)?.activeThreadId
    return typeof id === 'string' ? id : null
  }

  /** A window was bound to `profileId`; `profile` is its public entry when known. */
  noteProfile(profileId: string, profile?: ProfilePublicDto): void {
    this.forgotten.delete(profileId)
    const entry = this.entry(profileId)
    if (profile && profile.id === profileId) {
      entry.profile = typeof profile.avatar === 'string' && profile.avatar.length > MAX_AVATAR_CHARS
        ? { ...profile, avatar: undefined }
        : profile
    }
    this.lastProfileId = profileId
    this.schedule()
  }

  /**
   * Something main sent to a window bound to `profileId`. Lists and the open thread's transcript are noted; the rest is
   * ignored. Cheap: no copying beyond the open thread's newest messages, and no write until updates settle.
   */
  observe(profileId: string | undefined, channel: string, data: unknown): void {
    if (!profileId || this.forgotten.has(profileId)) return
    switch (channel) {
      case 'threads:updated': {
        const rows = rowsOf(data, 'threads')
        if (!rows) return
        this.entry(profileId).threads = rows
        break
      }
      case 'projects:updated': {
        const rows = rowsOf(data, 'projects')
        if (!rows) return
        this.entry(profileId).projects = rows
        break
      }
      case 'thread:selected': {
        const id = isRecord(data) ? data.id : undefined
        if (typeof id !== 'string' && id !== null) return
        const entry = this.entry(profileId)
        entry.activeThreadId = id
        if (entry.transcript?.threadId !== id) entry.transcript = null
        break
      }
      case 'thread:view':
      case 'orchestrator:thread-messages': {
        if (!isRecord(data) || !Array.isArray(data.messages)) return
        const entry = this.entries.get(profileId)
        if (!entry || typeof data.threadId !== 'string' || data.threadId !== entry.activeThreadId) return
        entry.transcript = { threadId: data.threadId, messages: (data.messages as Array<{ id?: unknown }>).slice(-this.maxMessages) }
        break
      }
      case 'orchestrator:thread-message':
      case 'orchestrator:thread-message-updated': {
        if (!isRecord(data) || !isRecord(data.message)) return
        const transcript = this.entries.get(profileId)?.transcript
        if (!transcript || transcript.threadId !== data.threadId) return
        const message = data.message as { id?: unknown }
        const messages = transcript.messages
        let index = -1
        for (let at = messages.length - 1; at >= 0; at -= 1) {
          if (messages[at]?.id === message.id) { index = at; break }
        }
        if (index >= 0) messages[index] = message
        else {
          messages.push(message)
          if (messages.length > this.maxMessages) messages.splice(0, messages.length - this.maxMessages)
        }
        break
      }
      default:
        return
    }
    this.schedule()
  }

  /** A profile that was archived or removed: what its windows showed is not kept. */
  forget(profileId: string): void {
    this.forgotten.add(profileId)
    this.entries.delete(profileId)
    if (this.lastProfileId === profileId) this.lastProfileId = null
    this.schedule()
  }

  /** Writes now what is pending (the app is quitting, a window closed). */
  flush(): Promise<void> {
    if (this.timer !== null) {
      this.clearTimer(this.timer)
      this.timer = null
      this.firstPendingAt = null
      return this.write()
    }
    return this.writing ?? Promise.resolve()
  }

  private entry(profileId: string): ProfileEntry {
    let entry = this.entries.get(profileId)
    if (!entry) {
      entry = {}
      this.entries.set(profileId, entry)
    }
    return entry
  }

  private schedule(): void {
    const now = Date.now()
    this.firstPendingAt ??= now
    if (this.timer !== null) this.clearTimer(this.timer)
    const delay = Math.max(0, Math.min(this.writeDelayMs, this.firstPendingAt + this.maxWriteDelayMs - now))
    this.timer = this.setTimer(() => {
      this.timer = null
      this.firstPendingAt = null
      void this.write()
    }, delay)
  }

  private write(): Promise<void> {
    if (this.writing) {
      this.dirtyWhileWriting = true
      return this.writing
    }
    this.writing = (async () => {
      // A write never replaces a file not read yet: what it held is merged in first.
      await this.load()
      const text = this.serialize()
      if (text === null) return
      const temp = `${this.file}.${process.pid}.tmp`
      try {
        await this.fs.writeFile(temp, text, 'utf8')
        await this.fs.rename(temp, this.file)
      } catch (error) {
        this.log(`Warm start cache could not be written: ${error instanceof Error ? error.message : String(error)}`)
        await this.fs.rm(temp, { force: true }).catch(() => undefined)
      }
    })().finally(() => {
      this.writing = null
      if (this.dirtyWhileWriting) {
        this.dirtyWhileWriting = false
        void this.write()
      }
    })
    return this.writing
  }

  /** The file's text within `maxBytes`, or null when even the last profile's lists do not fit. */
  private serialize(): string | null {
    const ordered = [...this.entries].sort(([a], [b]) => (a === this.lastProfileId ? -1 : b === this.lastProfileId ? 1 : 0))
    let profiles = ordered.slice(0, WARM_START_MAX_PROFILES).map(([id, entry]) => [id, { ...entry }] as [string, ProfileEntry])
    const text = (): string => JSON.stringify({ version: FILE_VERSION, lastProfileId: this.lastProfileId, profiles } satisfies WarmStartFile)
    let out = text()
    // Too large: fewer messages first (halving), then fewer profiles, the least recent first.
    let keep = this.maxMessages
    while (Buffer.byteLength(out, 'utf8') > this.maxBytes && keep > 0) {
      keep = Math.floor(keep / 2)
      profiles = profiles.map(([id, entry]) => [id, entry.transcript
        ? { ...entry, transcript: { threadId: entry.transcript.threadId, messages: keep > 0 ? entry.transcript.messages.slice(-keep) : [] } }
        : entry])
      out = text()
    }
    while (Buffer.byteLength(out, 'utf8') > this.maxBytes && profiles.length > 1) {
      profiles = profiles.slice(0, -1)
      out = text()
    }
    if (Buffer.byteLength(out, 'utf8') > this.maxBytes) {
      this.log('Warm start cache skipped: the thread list is larger than its limit')
      return null
    }
    return out
  }
}
