import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { atomicWriteJsonSync } from '../data/AtomicFs'

/**
 * Worktrees a finished dispatch left in place because their ignored files could not be kept before the removal (over
 * the copy limit, say), or because the cleanup stopped part way. Nothing else owns such a worktree: no thread's
 * resources name it, so deleting a thread never removes it. Storage lists each one, and removes it only when the person
 * confirms a plan that names it. One file per dispatch, in the profile's lifecycle folder.
 */
export interface KeptWorktree {
  schemaVersion: 1
  dispatchId: string
  /** The dispatch's thread, when it has one. */
  threadId?: string
  path: string
  branch: string
  repositoryRoot: string
  ignoredFiles: number
  /** Why it was kept; starts "Kept, N ignored files". */
  reason: string
  keptAt: string
}

const DISPATCH_ID = /^dsp_[0-9a-z]{26}$/

export function keptWorktreesFolder(profileHome: string): string {
  return join(profileHome, 'lifecycle', 'kept-worktrees')
}

export function recordKeptWorktree(profileHome: string, value: Omit<KeptWorktree, 'schemaVersion'>): void {
  if (!DISPATCH_ID.test(value.dispatchId)) throw new Error('A kept worktree is named by its dispatch.')
  atomicWriteJsonSync(join(keptWorktreesFolder(profileHome), `${value.dispatchId}.json`), { schemaVersion: 1, ...value } satisfies KeptWorktree)
}

export function forgetKeptWorktree(profileHome: string, dispatchId: string): void {
  if (DISPATCH_ID.test(dispatchId)) rmSync(join(keptWorktreesFolder(profileHome), `${dispatchId}.json`), { force: true })
}

/** Every kept worktree with a readable record. A damaged record is left as it is and not listed. */
export function listKeptWorktrees(profileHome: string): KeptWorktree[] {
  let names: string[]
  try { names = readdirSync(keptWorktreesFolder(profileHome)) } catch { return [] }
  const kept: KeptWorktree[] = []
  for (const name of names.sort()) {
    const dispatchId = name.replace(/\.json$/, '')
    if (!DISPATCH_ID.test(dispatchId) || name !== `${dispatchId}.json`) continue
    try {
      const value = JSON.parse(readFileSync(join(keptWorktreesFolder(profileHome), name), 'utf8')) as Partial<KeptWorktree>
      if (value.schemaVersion !== 1 || value.dispatchId !== dispatchId || typeof value.path !== 'string' || !isAbsolute(value.path)
        || typeof value.branch !== 'string' || typeof value.repositoryRoot !== 'string' || !isAbsolute(value.repositoryRoot)
        || typeof value.ignoredFiles !== 'number' || typeof value.reason !== 'string' || typeof value.keptAt !== 'string'
        || (value.threadId !== undefined && typeof value.threadId !== 'string')) continue
      kept.push(value as KeptWorktree)
    } catch { /* Unreadable: not listed. */ }
  }
  return kept
}
