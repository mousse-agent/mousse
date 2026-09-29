/**
 * Disk-backed pi-ai `ModelsStore`. Dynamic provider catalogs (OpenAI-compatible
 * `/models`, Claude SDK, Cursor, …) survive daemon restarts, so startup can
 * restore them without network access and refresh in the background.
 */
import { readFileSync } from 'node:fs'
import type { ModelsStore, ModelsStoreEntry } from '@earendil-works/pi-ai'
import { atomicWriteJsonSync } from '../data/AtomicFs'

const FILE_VERSION = 1

interface ModelsStoreFile {
  version: typeof FILE_VERSION
  providers: Record<string, ModelsStoreEntry>
}

function isEntry(value: unknown): value is ModelsStoreEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { models?: unknown }).models)
  )
}

export class FileModelsStore implements ModelsStore {
  private entries: Map<string, ModelsStoreEntry> | null = null

  constructor(private readonly path: string) {}

  private load(): Map<string, ModelsStoreEntry> {
    if (this.entries) return this.entries
    const entries = new Map<string, ModelsStoreEntry>()
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<ModelsStoreFile>
      if (parsed.version === FILE_VERSION && parsed.providers && typeof parsed.providers === 'object') {
        for (const [id, entry] of Object.entries(parsed.providers)) {
          if (isEntry(entry)) entries.set(id, entry)
        }
      }
    } catch {
      // Missing or corrupt cache: start empty; the next network refresh rewrites it.
    }
    this.entries = entries
    return entries
  }

  private save(): void {
    const file: ModelsStoreFile = {
      version: FILE_VERSION,
      providers: Object.fromEntries(this.load())
    }
    try {
      atomicWriteJsonSync(this.path, file)
    } catch {
      // Best-effort cache; the in-memory copy stays authoritative for this run.
    }
  }

  async read(providerId: string): Promise<ModelsStoreEntry | undefined> {
    const entry = this.load().get(providerId)
    return entry ? structuredClone(entry) : undefined
  }

  async write(providerId: string, entry: ModelsStoreEntry): Promise<void> {
    this.load().set(providerId, structuredClone(entry))
    this.save()
  }

  async delete(providerId: string): Promise<void> {
    if (this.load().delete(providerId)) this.save()
  }
}
