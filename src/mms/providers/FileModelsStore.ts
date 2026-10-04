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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isModel(value: unknown, providerId: string): boolean {
  if (!isRecord(value) || value.provider !== providerId) return false
  if (!['id', 'name', 'api', 'baseUrl'].every((key) => typeof value[key] === 'string' && value[key].length > 0)) return false
  if (typeof value.reasoning !== 'boolean') return false
  if (!Array.isArray(value.input) || value.input.length === 0 || !value.input.every((kind) => kind === 'text' || kind === 'image')) return false
  const cost = value.cost
  return isRecord(cost) && ['input', 'output', 'cacheRead', 'cacheWrite'].every((key) => isFiniteNumber(cost[key])) &&
    isFiniteNumber(value.contextWindow) && value.contextWindow > 0 &&
    isFiniteNumber(value.maxTokens) && value.maxTokens > 0
}

function isEntry(value: unknown, providerId: string): value is ModelsStoreEntry {
  return (
    isRecord(value) && Array.isArray(value.models) &&
    value.models.every((model) => isModel(model, providerId)) &&
    (value.checkedAt === undefined || isFiniteNumber(value.checkedAt)) &&
    (value.lastModified === undefined || isFiniteNumber(value.lastModified)) &&
    (value.etag === undefined || typeof value.etag === 'string')
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
          // Reject a malformed provider independently; other cached catalogs survive.
          if (isEntry(entry, id)) entries.set(id, entry)
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
