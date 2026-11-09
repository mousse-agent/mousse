import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/**
 * The provider settings files shared with the user's terminal (Claude's `~/.claude/settings.json`)
 * that the user agreed Mousse may edit, kept in `<profileHome>/harness/shared-settings-consent.json`
 * so the question is asked once per file, whichever window asks. The service refuses an edit of a
 * shared file that is not listed here and does not carry the agreement itself.
 */
export class SharedSettingsConsentStore {
  private readonly file: string
  private cache?: Set<string>

  constructor(profileHome: string, private readonly platform: NodeJS.Platform = process.platform) {
    this.file = join(profileHome, 'harness', 'shared-settings-consent.json')
  }

  private key(path: string): string {
    const full = resolve(path)
    return this.platform === 'win32' || this.platform === 'darwin' ? full.toLowerCase() : full
  }

  private read(): Set<string> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { paths?: unknown }
      const paths = Array.isArray(parsed?.paths) ? parsed.paths.filter((entry): entry is string => typeof entry === 'string') : []
      return (this.cache = new Set(paths))
    } catch {
      // Missing or unreadable: nothing agreed yet, so the next edit asks again.
      return (this.cache = new Set())
    }
  }

  has(path: string): boolean {
    return this.read().has(this.key(path))
  }

  add(path: string): void {
    const paths = this.read()
    const key = this.key(path)
    if (paths.has(key)) return
    const next = new Set(paths).add(key)
    atomicWriteJsonSync(this.file, { version: 1, paths: [...next].sort() })
    this.cache = next
  }
}
