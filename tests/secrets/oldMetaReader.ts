// v0.1.3 metadata reader and writer bodies; copy/mask notifications are no-ops in this fixture.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../../src/mms/data/AtomicFs'
import { ensurePrivateDirectory } from '../../src/mms/data/privateAcl'
import { deleteProfileSecret, listProfileKeyNames, writeProfileSecret } from '../../src/mms/profiles/secrets'
import { SECRET_DAY_MS } from '../../src/shared/secretRequests'
import { isKeyName } from '../../src/shared/automationKeys'
import type { SecretKeep } from '../../src/shared/secretRequests'
interface SecretMeta { label?: string; keep: SecretKeep; expiresAt?: string; threadId?: string; createdAt: string; lastUsedAt?: string; threads: string[] }
type MetaFile = Record<string, SecretMeta>
export class OldMetaReader {
  private readonly metaPath: string
  private readonly now = () => this.options.now?.() ?? Date.now()
  constructor(private readonly options: {profileRoot: string; threadAlive(threadId: string): boolean; changed?(): void; now?(): number}) { this.metaPath = join(options.profileRoot, 'secrets/meta.json') }
  private didChange(): void {}
  private syncFiles(): void {}
  readMeta(): MetaFile {
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

  has(name: string): boolean {
    return listProfileKeyNames(this.options.profileRoot).includes(name)
  }

  isSaved(name: string): boolean {
    if (!this.has(name)) return false
    const meta = this.readMeta()[name]
    return !meta || meta.keep === 'saved'
  }

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

  grant(name: string, threadId: string): void {
    if (!this.isSaved(name)) throw new Error(`No saved secret is named ${name}.`)
    const meta = this.readMeta()
    const current = meta[name] ?? { keep: 'saved' as const, createdAt: new Date(this.now()).toISOString(), threads: [] }
    if (current.threads.includes(threadId)) return
    this.writeMeta({ ...meta, [name]: { ...current, threads: [...current.threads, threadId] } })
    this.didChange()
  }

  markUsed(name: string): void {
    const meta = this.readMeta()
    if (!meta[name]) return
    this.writeMeta({ ...meta, [name]: { ...meta[name], lastUsedAt: new Date(this.now()).toISOString() } })
    this.options.changed?.()
  }

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

  private writeMeta(meta: MetaFile): void {
    ensurePrivateDirectory(join(this.options.profileRoot, 'secrets'))
    atomicWriteJsonSync(this.metaPath, meta, { mode: 0o600 })
  }
}
