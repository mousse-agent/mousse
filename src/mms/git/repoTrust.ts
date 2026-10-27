import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getMousseHomeDir } from '../data/paths'

/**
 * The filter drivers a repository's own config defined when the user added it to Mousse (or, for a
 * project added before this existed, when Mousse first started after the upgrade). git-crypt,
 * `git lfs install --local` and nbstripout live there. Mousse's own Git commands run such a filter
 * only while its name and exact command match this record; one added or changed later (by an agent
 * that can write the repository's config, for one) stays emptied, and writes through it are refused.
 *
 * Kept in Mousse's home, outside the repository, keyed by the repository's common Git folder, so a
 * thread's worktree shares it. The user records it again with "Trust Git settings again".
 */
export interface RepoTrustRecord {
  commonDir: string
  trustedAt: string
  /** `filter.<name>.<clean|smudge|process|required>` → the value in the repository's own config. */
  filters: Record<string, string>
}

/** Keys recorded; `required` is kept for the record, it runs nothing. */
export const TRUSTED_FILTER_KEY = /^filter\..+\.(clean|smudge|process|required)$/

function canonical(path: string): string {
  let real = resolve(path)
  try { real = realpathSync.native(real) } catch { /* recorded as given */ }
  return process.platform === 'win32' ? real.toLowerCase() : real
}

/** Where the record for a repository whose common Git folder is `commonDir` is kept. */
export function repoTrustPath(commonDir: string): string {
  const digest = createHash('sha256').update(canonical(commonDir)).digest('hex').slice(0, 32)
  return join(getMousseHomeDir(), 'git-trust', `${digest}.json`)
}

/** The record for `commonDir`, or null when there is none (or it cannot be read). */
export function readRepoTrust(commonDir: string): RepoTrustRecord | null {
  const path = repoTrustPath(commonDir)
  if (!existsSync(path)) return null
  try {
    const record = JSON.parse(readFileSync(path, 'utf8')) as RepoTrustRecord
    return record && typeof record.filters === 'object' && record.filters ? record : null
  } catch {
    return null
  }
}

export function writeRepoTrust(commonDir: string, filters: Record<string, string>): RepoTrustRecord {
  const record: RepoTrustRecord = { commonDir: canonical(commonDir), trustedAt: new Date().toISOString(), filters }
  // Written whole, then renamed into place: a reader sees the old record or the new one.
  const path = repoTrustPath(commonDir)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(temporary, path)
  return record
}

/** Whether a repository-scope entry is the user's own: the same key and the same command as recorded. */
export function isTrustedRepoEntry(record: RepoTrustRecord | null, key: string, value: string | null): boolean {
  return record !== null && value !== null && TRUSTED_FILTER_KEY.test(key) && Object.prototype.hasOwnProperty.call(record.filters, key) && record.filters[key] === value
}
