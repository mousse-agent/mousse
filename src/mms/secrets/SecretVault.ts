import { existsSync, readFileSync } from 'node:fs'
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

export interface SecretVaultOptions {
  profileRoot: string
  /** Whether a thread still exists and is not archived; a thread-only secret is deleted with its thread. */
  threadAlive(threadId: string): boolean
  threadTitle?(threadId: string): string | undefined
  now?(): number
  /** The store changed (a secret added, used, deleted or expired). */
  changed?(): void
}

/**
 * The secrets agents asked for in threads, over the profile's secret store (`secrets/refs.json`, the store saved keys
 * use). The values stay in that file; `secrets/meta.json` beside it keeps how long each is kept, which threads may use
 * it and when it was last used. Values are read only to run a command, resolve a tool's settings, and mask a thread.
 */
export class SecretVault {
  private readonly metaPath: string
  private readonly now: () => number
  /** Each thread's masker, built when first needed and dropped on any change. */
  private readonly maskers = new Map<string, SecretMasker | null>()
  private readonly values: ReturnType<typeof createProfileSecretAdapter>

  constructor(private readonly options: SecretVaultOptions) {
    this.metaPath = join(options.profileRoot, 'secrets', 'meta.json')
    this.now = options.now ?? Date.now
    this.values = createProfileSecretAdapter({ profileRoot: options.profileRoot, inheritProcessEnv: false })
  }

  /** Whether the store holds a secret by this name (a saved key or one given in a thread). */
  has(name: string): boolean {
    return listProfileKeyNames(this.options.profileRoot).includes(name)
  }

  /** A saved secret (Settings or an automation's key field) the person may give to another thread. */
  isSaved(name: string): boolean {
    if (!this.has(name)) return false
    const meta = this.readMeta()[name]
    return !meta || meta.keep === 'saved'
  }

  /** `base`, or `base_2`, `base_3`… when the store already holds `base`. */
  freeName(base: string): string {
    const taken = new Set(listProfileKeyNames(this.options.profileRoot))
    if (!taken.has(base)) return base
    for (let n = 2; n < 1000; n++) {
      const suffix = `_${n}`
      const name = `${base.slice(0, 64 - suffix.length)}${suffix}`
      if (!taken.has(name)) return name
    }
    throw new Error('Too many secrets share this name.')
  }

  /** Keeps a value the person typed, for the thread that asked. The name must be free (`freeName`). */
  store(name: string, value: string, input: { keep: SecretKeep; threadId: string; label?: string }): void {
    if (!isKeyName(name)) throw new Error('A secret name is a word like GITHUB_TOKEN.')
    if (this.has(name)) throw new Error(`A secret named ${name} already exists.`)
    const now = this.now()
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
  grant(name: string, threadId: string): void {
    if (!this.isSaved(name)) throw new Error(`No saved secret is named ${name}.`)
    const meta = this.readMeta()
    const current = meta[name] ?? { keep: 'saved' as const, createdAt: new Date(this.now()).toISOString(), threads: [] }
    if (current.threads.includes(threadId)) return
    this.writeMeta({ ...meta, [name]: { ...current, threads: [...current.threads, threadId] } })
    this.didChange()
  }

  /** Whether the thread's agents may use the secret by name. */
  usableIn(name: string, threadId: string): boolean {
    if (!this.has(name)) return false
    return this.readMeta()[name]?.threads.includes(threadId) ?? false
  }

  /** The value for a command or a tool's settings; undefined when it is gone. */
  value(name: string): string | undefined {
    return isKeyName(name) ? this.values.resolveSecretRef?.(name) : undefined
  }

  markUsed(name: string): void {
    const meta = this.readMeta()
    if (!meta[name]) return
    this.writeMeta({ ...meta, [name]: { ...meta[name], lastUsedAt: new Date(this.now()).toISOString() } })
    this.options.changed?.()
  }

  /**
   * What masks a thread's text: every secret its agents may use, in every form it can take. Undefined when the thread
   * has none, which is every thread that never asked for a secret.
   */
  maskerFor(threadId: string): SecretMasker | undefined {
    const cached = this.maskers.get(threadId)
    if (cached !== undefined) return cached ?? undefined
    const meta = this.readMeta()
    const secrets = Object.entries(meta).flatMap(([name, entry]) => {
      if (!entry.threads.includes(threadId)) return []
      const value = this.value(name)
      return value ? [{ name, value }] : []
    })
    const masker = secretMasker(secrets) ?? null
    this.maskers.set(threadId, masker)
    return masker ?? undefined
  }

  /** Every secret in the store, for Settings: saved keys and the ones given in threads. Never values. */
  list(): SecretEntryView[] {
    const meta = this.readMeta()
    return listProfileKeyNames(this.options.profileRoot).map((name): SecretEntryView => {
      const entry = meta[name]
      if (!entry) return { name, keep: 'key' }
      const title = entry.threadId ? this.options.threadTitle?.(entry.threadId) : undefined
      return {
        name,
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
    return listProfileKeyNames(this.options.profileRoot).filter((name) => !meta[name] || meta[name].keep === 'saved')
  }

  /** Removes a secret and its record; false when there was none. */
  delete(name: string): boolean {
    if (!isKeyName(name)) return false
    const existed = this.has(name)
    deleteProfileSecret(this.options.profileRoot, name)
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
      if (!this.has(name)) return true
      if (entry.keep === 'day') return !entry.expiresAt || Date.parse(entry.expiresAt) <= now
      if (entry.keep === 'thread') return !entry.threadId || !this.options.threadAlive(entry.threadId)
      return false
    }).map(([name]) => name)
    for (const name of gone) {
      deleteProfileSecret(this.options.profileRoot, name)
      delete meta[name]
    }
    if (gone.length) {
      this.writeMeta(meta)
      this.didChange()
    }
    return gone
  }

  /** The store changed outside the vault (an automation's key was set): masks are rebuilt from the file. */
  refresh(): void {
    this.didChange()
  }

  private didChange(): void {
    this.maskers.clear()
    this.options.changed?.()
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
