import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/** `<profileHome>/unseen-done.json`: the threads that finished and that nobody has looked at since. */
export const UNSEEN_DONE_FILE = 'unseen-done.json'

interface UnseenDoneFile {
  version: 1
  threads: string[]
}

/**
 * The threads whose status is Done: their work finished while no focused window showed them, and no window has
 * opened them since. Kept in a file of its own beside the profile's other state, so a service restart or an update
 * keeps every Done, and setting or clearing one touches no thread record (its updated time and the list stay as
 * they are). Written only when the set changes.
 */
export class UnseenDoneStore {
  private readonly path: string
  private readonly ids: Set<string>

  constructor(profileHome: string) {
    this.path = join(profileHome, UNSEEN_DONE_FILE)
    this.ids = new Set(this.read())
  }

  private read(): string[] {
    try {
      if (!existsSync(this.path)) return []
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<UnseenDoneFile>
      return Array.isArray(parsed?.threads) ? parsed.threads.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
    } catch {
      // A damaged file loses only which threads showed Done.
      return []
    }
  }

  private write(): void {
    try {
      atomicWriteJsonSync(this.path, { version: 1, threads: [...this.ids] } satisfies UnseenDoneFile)
    } catch (error) {
      console.warn('the unseen Done threads could not be saved', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  list(): string[] {
    return [...this.ids]
  }

  has(threadId: string): boolean {
    return this.ids.has(threadId)
  }

  /** True when the thread was not marked before. */
  add(threadId: string): boolean {
    if (this.ids.has(threadId)) return false
    this.ids.add(threadId)
    this.write()
    return true
  }

  /** True when the thread was marked. */
  delete(threadId: string): boolean {
    if (!this.ids.delete(threadId)) return false
    this.write()
    return true
  }
}
