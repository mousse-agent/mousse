import { SecretBindings, UNAVAILABLE_BINDING } from './SecretBindings'
import { sameSecretBinding, secretBindingView, type SecretBinding } from '../../shared/secretServices'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isKeyName } from '../../shared/automationKeys'
import { SECRET_DAY_MS, type SecretEntryView, type SecretKeep } from '../../shared/secretRequests'
import { atomicWriteJsonSync } from '../data/AtomicFs'
import { ensurePrivateDirectory } from '../data/privateAcl'
import { createProfileSecretAdapter, deleteProfileSecret, listProfileKeyNames, writeProfileSecret } from '../profiles/secrets'
import { secretMasker, type SecretMasker } from './secretMasking'

/** What the vault keeps about a secret given in a thread, next to the value in the secret store. Never the value. */
interface SecretMeta {
  label?: string
  keep: SecretKeep
  /** A `day` secret's end. */
  expiresAt?: string
  /** The thread that asked for it. */
  threadId?: string
  createdAt: string
  lastUsedAt?: string
  /** The threads whose agents may use it by name: the one that asked, and any thread the person gave it to later. */
  threads: string[]
}

type MetaFile = Record<string, SecretMeta>

/**
 * How long a value that was removed or changed still masks a thread that had it, after that thread's turn ended: the
 * turn's last output and its final save can arrive just after it stops counting as running.
 */
export const RETIRED_SECRET_GRACE_MS = 60_000

/**
 * How long a retired value is remembered after the last thread that used it was seen running. A subagent of the thread
 * that had it may first ask for its masker long after that thread settled, so the value outlives the owner's grace.
 */
export const RETIRED_SECRET_KEEP_MS = 24 * 60 * 60 * 1000

/** Values retired from a thread's masker, and when each thread that may use them (it, or a subagent) was last running. */
interface RetiredSecrets {
  secrets: Array<{ name: string; value: string }>
  seen: Map<string, number>
}

/** A readable copy of a thread's secret could not be removed before a turn on a runtime that keeps its tools' results. */
export class SecretCopyRemovalError extends Error {
  constructor(readonly path: string) {
    super(`This turn did not start: Mousse could not remove a readable copy of this thread's secrets (${path}), and this runtime keeps what its commands print. Close whatever has the file open, then try again.`)
    this.name = 'SecretCopyRemovalError'
  }
}

/**
 * Whether a thread has a turn running, in this process or in the run engine. A lookup that fails (a run conflict) counts
 * as running: masking a removed value a little longer is safe, and a throw here would break every masker of the thread.
 */
export function secretThreadBusy(
  threadId: string,
  turns: { isTurnActive(threadId: string): boolean },
  runs: { getActiveRun(threadId: string): unknown }
): boolean {
  try {
    return turns.isTurnActive(threadId) || runs.getActiveRun(threadId) !== null
  } catch {
    return true
  }
}

/** A thread id that can name a folder; any other thread gets no files. */
const FOLDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export interface SecretVaultOptions {
  profileRoot: string
  /** Whether a thread still exists and is not archived; a thread-only secret is deleted with its thread. */
  threadAlive(threadId: string): boolean
  threadTitle?(threadId: string): string | undefined
  /** The threads a subagent's thread descends from (its parents up to the root); it is masked with their secrets too. */
  ancestorsOf?(threadId: string): string[]
  /** Whether the thread has a turn or run going: a value removed or changed meanwhile still masks it until it settles. */
  threadBusy?(threadId: string): boolean
  now?(): number
  /** Removes a file or folder (default `rmSync`, recursive); tests make it fail as a locked file would. */
  removePath?(path: string): void
  /** The store changed (a secret added, used, deleted or expired). */
  changed?(): void
}

/**
 * The secrets agents asked for in threads, over the profile's secret store (`secrets/refs.json`, the store saved keys
 * use). `secrets/meta.json` beside it keeps how long each is kept, which threads may use it and when it was last used.
 * Each thread may use its secrets directly: `secrets/threads/<thread>/<NAME>` holds a copy only this account can open,
 * which its agents read and use in commands, settings and logins. The copies follow the store: a secret deleted,
 * expired or no longer given to a thread loses its file, and an archived thread loses its folder.
 */
export class SecretVault {
  private readonly bindings: SecretBindings
  private readonly metaPath: string
  private readonly filesRoot: string
  private readonly now: () => number
  /** Each thread's masker, built when first needed and dropped on any change. */
  private readonly maskers = new Map<string, SecretMasker | null>()
  /** The values each built masker covers, so a change can keep them masking a thread whose turn is still running. */
  private readonly known = new Map<string, Array<{ name: string; value: string }>>()
  /** Values removed or changed while a thread's turn ran: they mask it, and its running subagents, until each settles. */
  private readonly retired = new Map<string, RetiredSecrets>()
  /**
   * The threads whose agents may have readable copies: those whose turns run on a runtime that hides secrets in its own
   * tools' results before it keeps them (Claude Code). Other runtimes keep those results as they are, so their threads
   * get no copy and use secret_run. Kept in memory: after a restart no thread has copies until its next turn starts.
   */
  private readonly copyThreads = new Set<string>()
  /**
   * Threads whose copies stay off whatever `copyThreads` says, and how many turns hold them so: a turn on a runtime
   * that keeps its tools' results holds its own thread and every thread above it until it settles, so a parent's
   * Claude Code turn cannot bring a copy back while a subagent that may have been handed its path still runs.
   */
  private readonly holds = new Map<string, number>()
  private readonly values: ReturnType<typeof createProfileSecretAdapter>

  constructor(private readonly options: SecretVaultOptions) {
    this.bindings = new SecretBindings(options.profileRoot)
    this.metaPath = join(options.profileRoot, 'secrets', 'meta.json')
    this.filesRoot = join(options.profileRoot, 'secrets', 'threads')
    this.now = options.now ?? Date.now
    this.values = createProfileSecretAdapter({ profileRoot: options.profileRoot, inheritProcessEnv: false })
  }

  /** Whether a value or leftover binding reserves this name for the owner's card. */
  has(name: string): boolean {
    return this.hasValue(name) || Boolean(this.bindingFor(name))
  }

  private hasValue(name: string): boolean {
    return listProfileKeyNames(this.options.profileRoot).includes(name)
  }

  /** A fresh value must never inherit authority approved for a deleted value. Existing bound values stay refused. */
  private prepareUnbound(name: string): void {
    // A deleted guard cannot identify a stale entry in unreadable JSON, so new stores wait until it can be read.
    this.bindings.requireReadable()
    if (!this.bindingFor(name)) return
    // listProfileKeyNames deliberately hides read failures. Authority removal needs proof of absence instead.
    let entries: unknown
    try { entries = JSON.parse(readFileSync(join(this.options.profileRoot, 'secrets/refs.json'), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (entries !== undefined) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('The secret store could not be read.')
      if (Object.hasOwn(entries, name)) throw new Error(`${name} is bound to a service and cannot be replaced as an ordinary key.`)
    }
    this.bindings.delete(name)
  }

  setKey(name: string, value: string): void {
    if (!isKeyName(name)) throw new Error('A key name is a word like GITHUB_TOKEN')
    this.prepareUnbound(name)
    writeProfileSecret(this.options.profileRoot, name, value)
    this.refresh()
  }

  /** A saved secret (Settings or an automation's key field) the person may give to another thread. */
  isSaved(name: string, binding?: SecretBinding): boolean {
    if (!this.hasValue(name)) return false
    const meta = this.readMeta()[name]
    return (!meta || meta.keep === 'saved') && sameSecretBinding(this.bindingFor(name), binding)
  }

  /** `base`, or `base_2`, `base_3`… when the store already holds `base`. */
  freeName(base: string): string {
    const taken = new Set(listProfileKeyNames(this.options.profileRoot))
    if (!taken.has(base) && !this.bindingFor(base)) return base
    for (let n = 2; n < 1000; n++) {
      const suffix = `_${n}`
      const name = `${base.slice(0, 64 - suffix.length)}${suffix}`
      if (!taken.has(name) && !this.bindingFor(name)) return name
    }
    throw new Error('Too many secrets share this name.')
  }

  /** Keeps a value the person typed, for the thread that asked. The name must be free (`freeName`). */
  store(name: string, value: string, input: { keep: SecretKeep; threadId: string; label?: string; binding?: SecretBinding }): void {
    if (!isKeyName(name)) throw new Error('A secret name is a word like GITHUB_TOKEN.')
    if (this.hasValue(name)) throw new Error(`A secret named ${name} already exists.`)
    const now = this.now()
    if (input.binding) this.bindings.set(name, input.binding)
    else this.prepareUnbound(name)
    writeProfileSecret(this.options.profileRoot, name, value)
    this.writeMeta({
      ...this.readMeta(),
      [name]: {
        ...(input.label ? { label: input.label.slice(0, 200) } : {}),
        keep: input.keep,
        ...(input.keep === 'day' ? { expiresAt: new Date(now + SECRET_DAY_MS).toISOString() } : {}),
        threadId: input.threadId,
        createdAt: new Date(now).toISOString(),
        threads: [input.threadId]
      }
    })
    this.didChange()
  }

  /** Lets a thread's agents use a saved secret by name (the person chose "Use saved" on its card). */
  grant(name: string, threadId: string, binding?: SecretBinding): void {
    if (!this.isSaved(name, binding)) throw new Error(`No saved secret is named ${name}.`)
    const meta = this.readMeta()
    const current = meta[name] ?? { keep: 'saved' as const, createdAt: new Date(this.now()).toISOString(), threads: [] }
    if (current.threads.includes(threadId)) return
    this.writeMeta({ ...meta, [name]: { ...current, threads: [...current.threads, threadId] } })
    this.didChange()
  }

  /** Whether the thread's agents may use the secret by name. */
  usableIn(name: string, threadId: string): boolean {
    if (!this.hasValue(name)) return false
    return this.readMeta()[name]?.threads.includes(threadId) ?? false
  }

  /**
   * Whether the thread's agents may have readable copies, as each of its turns starts: yes on a runtime that hides
   * secrets in its own tools' results, no on any other, whose turn then starts with the copies already removed.
   */
  allowCopies(threadId: string, allowed: boolean): void {
    const had = this.copyThreads.has(threadId)
    if (allowed) this.copyThreads.add(threadId)
    else this.copyThreads.delete(threadId)
    // Removing is checked every time: a copy left by an earlier daemon is gone before the turn runs.
    if (!allowed || !had) this.syncFiles()
  }

  /**
   * As a turn on a runtime that keeps its own tools' results starts (Codex, an ACP agent): its thread loses its copies
   * until a later Claude Code turn, and it and every thread above it (`threadIds`, its own first) keep none until the
   * returned release is called, when the turn has settled. Fails closed: when a copy cannot be removed (a locked file,
   * a permission error) the hold is dropped and this throws, and the turn must not start.
   */
  holdCopies(threadIds: readonly string[]): () => void {
    const [own] = threadIds
    if (own) this.copyThreads.delete(own)
    for (const id of threadIds) this.holds.set(id, (this.holds.get(id) ?? 0) + 1)
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      for (const id of threadIds) {
        const left = (this.holds.get(id) ?? 1) - 1
        if (left > 0) this.holds.set(id, left)
        else this.holds.delete(id)
      }
      this.syncFiles()
    }
    this.syncFiles()
    // Checked on disk, not taken from the sync: a removal that failed must not let the turn start.
    const left = threadIds.filter((id) => FOLDER_ID.test(id) && existsSync(join(this.filesRoot, id)) && (this.remove(join(this.filesRoot, id)), existsSync(join(this.filesRoot, id))))
    if (left.length) {
      release()
      throw new SecretCopyRemovalError(join(this.filesRoot, left[0]!))
    }
    return release
  }

  /** The private file that holds the secret for the thread's agents to read; undefined when the thread may not use it. */
  fileFor(name: string, threadId: string): string | undefined {
    if (!isKeyName(name) || !FOLDER_ID.test(threadId) || !this.usableIn(name, threadId) || this.bindingFor(name)) return undefined
    const path = join(this.filesRoot, threadId, name)
    return existsSync(path) ? path : undefined
  }

  /** The value for a command or a tool's settings; undefined when it is gone. */
  value(name: string): string | undefined {
    return isKeyName(name) ? this.values.resolveSecretRef?.(name) : undefined
  }

  bindingFor(name: string): SecretBinding | undefined {
    return this.bindings.get(name)
  }

  markUsed(name: string): void {
    const meta = this.readMeta()
    if (!meta[name]) return
    this.writeMeta({ ...meta, [name]: { ...meta[name], lastUsedAt: new Date(this.now()).toISOString() } })
    this.options.changed?.()
  }

  /**
   * What masks a thread's text: every secret its agents may use, and its parents' when it is a subagent's, in
   * every form it can take; while a turn that had a removed or changed value settles, that value too. Undefined when
   * the thread has none, which is every thread that never asked for a secret.
   */
  maskerFor(threadId: string): SecretMasker | undefined {
    const ancestors = this.options.ancestorsOf?.(threadId) ?? []
    const retired = this.retiredFor(threadId, ancestors)
    const cached = this.maskers.get(threadId)
    if (cached !== undefined && !retired.length) return cached ?? undefined
    const owners = new Set([threadId, ...ancestors])
    const meta = this.readMeta()
    const secrets = Object.entries(meta).flatMap(([name, entry]) => {
      if (!entry.threads.some((owner) => owners.has(owner))) return []
      const value = this.value(name)
      return value ? [{ name, value }] : []
    })
    this.remember(threadId, secrets)
    const masker = secretMasker([...secrets, ...retired]) ?? null
    // Built with retired values it is rebuilt on each call, so it drops them once the turn has settled.
    if (!retired.length) this.maskers.set(threadId, masker)
    return masker ?? undefined
  }

  /**
   * What masks text that may hold any secret of the profile, whatever thread it was given in: a terminal's output, which
   * shows whatever the person typed or a command printed. Every secret in the store, saved keys included. Read from the
   * store at every call (keys saved elsewhere don't pass through the vault), so it is never stale. With `threadId`, also
   * the values that thread (or a thread above it) had and that were removed or changed while it ran: a terminal's
   * scrollback may still show an old value, so one masker covers both before the output is cut into pages.
   */
  maskerForStore(threadId?: string): SecretMasker | undefined {
    const secrets = listProfileKeyNames(this.options.profileRoot).flatMap((name) => {
      const value = this.value(name)
      return value ? [{ name, value }] : []
    })
    if (!threadId) return secretMasker(secrets)
    // Remembered for the thread, so a saved key it was never given but whose old value its terminal shows retires too.
    this.remember(threadId, secrets)
    return secretMasker([...secrets, ...this.retiredFor(threadId, this.options.ancestorsOf?.(threadId) ?? [])])
  }

  /** Adds to the values a thread's maskers covered since the last change; a change retires them while it runs. */
  private remember(threadId: string, secrets: ReadonlyArray<{ name: string; value: string }>): void {
    const known = this.known.get(threadId) ?? []
    for (const secret of secrets) if (!known.some((other) => other.value === secret.value)) known.push(secret)
    this.known.set(threadId, known)
  }

  /**
   * The retired values of the thread and of the threads above it, while its turn (or the one that had them) runs or has
   * just ended. Each thread gets its own grace: a parent that settled stops being masked with them, while a subagent
   * of it that is still running (or that first asks only now) keeps them. An entry no thread has used for
   * `RETIRED_SECRET_KEEP_MS` is forgotten.
   */
  private retiredFor(threadId: string, ancestors: readonly string[]): Array<{ name: string; value: string }> {
    const out: Array<{ name: string; value: string }> = []
    const now = this.now()
    const fresh = (at: number | undefined): boolean => at !== undefined && now - at < RETIRED_SECRET_GRACE_MS
    let busy: boolean | undefined
    for (const id of [threadId, ...ancestors]) {
      const entry = this.retired.get(id)
      if (!entry) continue
      busy ??= this.options.threadBusy?.(threadId) ?? false
      if (busy) entry.seen.set(threadId, now)
      if (id !== threadId && this.options.threadBusy?.(id)) entry.seen.set(id, now)
      if (fresh(entry.seen.get(threadId)) || fresh(entry.seen.get(id))) {
        for (const secret of entry.secrets) if (!out.some((other) => other.value === secret.value)) out.push(secret)
      } else if (now - Math.max(0, ...entry.seen.values()) >= RETIRED_SECRET_KEEP_MS) {
        this.retired.delete(id)
        this.maskers.delete(id)
      }
    }
    return out
  }

  /** Every secret in the store, for Settings: saved keys and the ones given in threads. Never values. */
  list(): SecretEntryView[] {
    const meta = this.readMeta()
    return listProfileKeyNames(this.options.profileRoot).map((name): SecretEntryView => {
      const entry = meta[name]
      const binding = this.bindingFor(name)
      const bindingView = binding ? {binding: binding === UNAVAILABLE_BINDING ? {host: '', readOnly: true as const, unavailable: true as const} : secretBindingView(binding)} : {}
      if (!entry) return { name, keep: 'key', ...bindingView }
      const title = entry.threadId ? this.options.threadTitle?.(entry.threadId) : undefined
      return {
        name,
        ...bindingView,
        keep: entry.keep,
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
        ...(entry.threadId ? { threadId: entry.threadId } : {}),
        ...(title ? { threadTitle: title } : {}),
        createdAt: entry.createdAt,
        ...(entry.lastUsedAt ? { lastUsedAt: entry.lastUsedAt } : {})
      }
    })
  }

  /** The names a saved key list shows: secrets given in a thread for a while are not saved keys. */
  savedKeyNames(): string[] {
    const meta = this.readMeta()
    return listProfileKeyNames(this.options.profileRoot).filter((name) => !this.bindingFor(name) && (!meta[name] || meta[name].keep === 'saved'))
  }

  /** Removes a secret and its record; false when there was none. */
  delete(name: string): boolean {
    if (!isKeyName(name)) return false
    const existed = this.has(name)
    deleteProfileSecret(this.options.profileRoot, name)
    this.bindings.delete(name)
    const meta = this.readMeta()
    if (meta[name]) {
      delete meta[name]
      this.writeMeta(meta)
    }
    if (existed) this.didChange()
    return existed
  }

  /** Deletes expired 24-hour secrets, and thread-only ones whose thread is gone. Returns the names deleted. */
  sweep(): string[] {
    const meta = this.readMeta()
    const now = this.now()
    const gone = Object.entries(meta).filter(([name, entry]) => {
      if (!this.hasValue(name)) return true
      if (entry.keep === 'day') return !entry.expiresAt || Date.parse(entry.expiresAt) <= now
      if (entry.keep === 'thread') return !entry.threadId || !this.options.threadAlive(entry.threadId)
      return false
    }).map(([name]) => name)
    for (const name of gone) {
      deleteProfileSecret(this.options.profileRoot, name)
      this.bindings.delete(name)
      delete meta[name]
    }
    if (gone.length) {
      this.writeMeta(meta)
      this.didChange()
    } else {
      // Nothing expired, but a thread may have been archived since: its copies go.
      this.syncFiles()
    }
    return gone
  }

  /** The store changed outside the vault (an automation's key was set): masks are rebuilt from the file. */
  refresh(): void {
    this.didChange()
  }

  /** Removes a file or folder; a failure is left to the caller to find on disk (`holdCopies` checks). */
  private remove(path: string): void {
    try {
      if (this.options.removePath) this.options.removePath(path)
      else rmSync(path, { recursive: true, force: true })
    } catch {
      // A locked file or a permission error: what was not removed is still there, and that is what is checked.
    }
  }

  private didChange(): void {
    // A thread whose turn runs keeps masking every value it had: output still on its way may hold one just removed.
    const now = this.now()
    for (const [threadId, secrets] of this.known) {
      const entry = this.retired.get(threadId)
      const busy = this.options.threadBusy?.(threadId) ?? false
      if (!busy && (entry === undefined || ![...entry.seen.values()].some((at) => now - at < RETIRED_SECRET_GRACE_MS))) continue
      const kept = entry?.secrets ?? []
      for (const secret of secrets) if (!kept.some((other) => other.value === secret.value)) kept.push(secret)
      const seen = entry?.seen ?? new Map<string, number>()
      if (busy) seen.set(threadId, now)
      this.retired.set(threadId, { secrets: kept, seen })
    }
    this.known.clear()
    this.maskers.clear()
    this.syncFiles()
    this.options.changed?.()
  }

  /** Makes the thread folders hold exactly the secrets each live thread may use, with their current values. */
  private syncFiles(): void {
    try {
      const wanted = new Map<string, Map<string, string>>()
      for (const [name, entry] of Object.entries(this.readMeta())) {
        if (this.bindingFor(name)) continue
        const threads = entry.threads.filter((threadId) => FOLDER_ID.test(threadId) && this.copyThreads.has(threadId) && !this.holds.has(threadId) && this.options.threadAlive(threadId))
        const value = threads.length ? this.value(name) : undefined
        if (!value) continue
        for (const threadId of threads) {
          const files = wanted.get(threadId) ?? new Map<string, string>()
          files.set(name, value)
          wanted.set(threadId, files)
        }
      }
      const root = this.filesRoot
      if (existsSync(root)) {
        for (const folder of readdirSync(root)) {
          const files = wanted.get(folder)
          const path = join(root, folder)
          // Anything but a real folder (a file, a link) where a thread's folder goes is removed, and made again below:
          // a copy is never written through a link to somewhere else.
          if (!files || !lstatSync(path).isDirectory()) {
            this.remove(path)
            continue
          }
          for (const file of readdirSync(path)) {
            if (!files.has(file) || !lstatSync(join(path, file)).isFile()) this.remove(join(path, file))
          }
        }
      }
      if (!wanted.size) return
      // The root is private and its folders and files inherit that (on Windows through its access list).
      ensurePrivateDirectory(root)
      for (const [threadId, files] of wanted) {
        const folder = join(root, threadId)
        mkdirSync(folder, { recursive: true, mode: 0o700 })
        for (const [name, value] of files) {
          const path = join(folder, name)
          if (existsSync(path) && readFileSync(path, 'utf8') === value) continue
          writeFileSync(path, value, { mode: 0o600 })
          if (process.platform !== 'win32') chmodSync(path, 0o600)
        }
      }
    } catch (error) {
      // The store stays right; an agent without its file still has secret_run.
      console.warn('Secret files could not be updated', { error: error instanceof Error ? error.name : 'unknown' })
    }
  }

  private readMeta(): MetaFile {
    if (!existsSync(this.metaPath)) return {}
    try {
      const parsed = JSON.parse(readFileSync(this.metaPath, 'utf8')) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      const out: MetaFile = {}
      for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
        if (!isKeyName(name) || !raw || typeof raw !== 'object') continue
        const entry = raw as Partial<SecretMeta>
        if (entry.keep !== 'thread' && entry.keep !== 'day' && entry.keep !== 'saved') continue
        out[name] = {
          ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
          keep: entry.keep,
          ...(typeof entry.expiresAt === 'string' ? { expiresAt: entry.expiresAt } : {}),
          ...(typeof entry.threadId === 'string' ? { threadId: entry.threadId } : {}),
          createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date(0).toISOString(),
          ...(typeof entry.lastUsedAt === 'string' ? { lastUsedAt: entry.lastUsedAt } : {}),
          threads: Array.isArray(entry.threads) ? entry.threads.filter((id): id is string => typeof id === 'string') : []
        }
      }
      return out
    } catch {
      return {}
    }
  }

  private writeMeta(meta: MetaFile): void {
    ensurePrivateDirectory(join(this.options.profileRoot, 'secrets'))
    atomicWriteJsonSync(this.metaPath, meta, { mode: 0o600 })
  }
}
