import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJsonSync, fsyncDirectorySync } from '../data/AtomicFs'
import type { RepositoryIdentity } from '../git/RepositoryIdentity'
import { readDirectLifecycleRefAsync } from '../lifecycle/lifecycleGit'

interface PendingRelease { operationId: string; retryAfter?: number }

// One record for the receipt's two immutable refs, in the same repository-wide metadata as the lease.
function pendingPath(repository: RepositoryIdentity, receiptId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(receiptId)) throw new Error('Invalid Undo receipt identity.')
  return join(repository.metadataDir, 'undo-ref-releases', `${receiptId.toLowerCase()}.json`)
}

export function pendingUndoRefRelease(repository: RepositoryIdentity, receiptId: string): PendingRelease | undefined {
  const path = pendingPath(repository, receiptId)
  try {
    if (!lstatSync(path).isFile()) throw new Error('Pending Undo ref release is unreadable.')
    const value = JSON.parse(readFileSync(path, 'utf8')) as PendingRelease
    if (!value?.operationId || typeof value.operationId !== 'string' || value.retryAfter !== undefined && !Number.isSafeInteger(value.retryAfter)) throw new Error('Pending Undo ref release is unreadable.')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Call while holding the repository lease, through the publication of the new claim. */
export function assertUndoRefMayBeClaimed(repository: RepositoryIdentity, receiptId: string): void {
  if (pendingUndoRefRelease(repository, receiptId)) throw new Error('This Undo checkpoint has a pending release.')
}

export async function requireLiveUndoRef(repository: RepositoryIdentity, cwd: string, receiptId: string, side: 'before' | 'after', expected: string): Promise<void> {
  assertUndoRefMayBeClaimed(repository, receiptId)
  if (await readDirectLifecycleRefAsync(cwd, `refs/mousse/changes/${receiptId}/${side}`) !== expected) throw new Error('This Undo checkpoint is no longer available.')
}

/** The journal is prepared first. No ref may be removed until this record is durable. */
export function prepareUndoRefRelease(repository: RepositoryIdentity, receiptId: string, operationId: string, retryAfter?: number): void {
  const pending = pendingUndoRefRelease(repository, receiptId)
  if (pending && pending.operationId !== operationId) throw new Error('Another task owns this pending Undo ref release.')
  if (!pending || retryAfter !== undefined) atomicWriteJsonSync(pendingPath(repository, receiptId), { operationId, retryAfter })
}

/** Call only after exact Git reads prove both refs absent. A claimant also checks that the refs exist. */
export function finishUndoRefRelease(repository: RepositoryIdentity, receiptId: string, operationId: string): void {
  if (pendingUndoRefRelease(repository, receiptId)?.operationId !== operationId) throw new Error('Pending Undo ref release ownership changed.')
  removePendingRelease(repository, receiptId)
}

/** A permanent purge discards the release journal. Cancel its reservation under the lease without altering the refs. */
export function cancelUndoRefRelease(repository: RepositoryIdentity, receiptId: string, operationId: string): void {
  if (pendingUndoRefRelease(repository, receiptId)?.operationId === operationId) removePendingRelease(repository, receiptId)
}

function removePendingRelease(repository: RepositoryIdentity, receiptId: string): void {
  unlinkSync(pendingPath(repository, receiptId))
  fsyncDirectorySync(join(repository.metadataDir, 'undo-ref-releases'))
}
