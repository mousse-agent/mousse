// Historical reader from v0.1.3 (unknown metadata fields are ignored).
import { existsSync, readFileSync } from 'node:fs'
import { isKeyName } from '../../src/shared/automationKeys'
import type { SecretKeep } from '../../src/shared/secretRequests'
interface SecretMeta { label?: string; keep: SecretKeep; expiresAt?: string; threadId?: string; createdAt: string; lastUsedAt?: string; threads: string[] }
type MetaFile = Record<string, SecretMeta>
export class OldMetaReader {
  constructor(private metaPath: string) {}
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

}
