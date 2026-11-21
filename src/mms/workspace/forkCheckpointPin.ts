import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { atomicWriteJsonSync, fsyncDirectorySync } from '../data/AtomicFs'
import { snapshotOriginAsync } from '../actions/snapshots'
import { requireLiveUndoRef } from '../actions/undoRefClaims'
import { resolveRepositoryIdentityAsync } from '../git/RepositoryIdentity'
import { acquireRepositoryLease } from '../git/RepositoryLease'
import { lifecycleGitAsync, readDirectLifecycleRefAsync } from '../lifecycle/lifecycleGit'
import { assertLifecyclePath } from '../lifecycle/ResourceLifecycleStore'

const PIN_FILE = 'fork-checkpoint.json'

export function forkCheckpointRef(threadId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(threadId)) throw new Error('Invalid fork checkpoint owner.')
  return 'refs/mousse/threads/' + threadId + '/fork-checkpoint'
}

interface ForkCheckpointPin {
  version: 1
  repositoryId: string
  checkoutPath: string
  actionId: string
  sha: string
  head?: string
}

export function readForkCheckpointPin(threadDirectory: string): ForkCheckpointPin | undefined {
  const path = join(threadDirectory, PIN_FILE)
  assertLifecyclePath(threadDirectory, path)
  try {
    if (!lstatSync(path).isFile()) throw new Error('Invalid fork checkpoint record.')
    const pin = JSON.parse(readFileSync(path, 'utf8')) as ForkCheckpointPin
    const oid = (value: unknown): boolean => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
    if (pin.version !== 1 || !/^[a-f0-9]{32}$/.test(pin.repositoryId) || !isAbsolute(pin.checkoutPath) || !pin.actionId || !oid(pin.sha) || pin.head !== undefined && !oid(pin.head)) throw new Error('Invalid fork checkpoint record.')
    return pin
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/** Create the fork's own ref before its pending transfer is published. The source receipt can then expire independently. */
export async function pinForkCheckpoint(threadId: string, threadDirectory: string, checkoutPath: string, repositoryId: string, checkpoint: { id: string; endSha: string; receiptId?: string }): Promise<void> {
  const repository = await resolveRepositoryIdentityAsync(checkoutPath, { requireMutationCapability: true })
  if (repository.key !== repositoryId) throw new Error('Fork checkpoint repository changed.')
  // The durable pending fork fence already excludes destination turns. The repository lease serializes the source receipt.
  const lease = await acquireRepositoryLease(repository, { maxWaitMs: 5_000 })
  try {
    if (checkpoint.receiptId) await requireLiveUndoRef(repository, checkoutPath, checkpoint.receiptId, 'after', checkpoint.endSha)
    const { head } = await snapshotOriginAsync(checkoutPath, checkpoint.endSha)
    const pin: ForkCheckpointPin = { version: 1, repositoryId, checkoutPath, actionId: checkpoint.id, sha: checkpoint.endSha, head }
    // A crash between writing and creating the ref leaves a record that cleanup can safely retire.
    atomicWriteJsonSync(join(threadDirectory, PIN_FILE), pin)
    await lifecycleGitAsync(checkoutPath, ['update-ref', '--no-deref', forkCheckpointRef(threadId), pin.sha, '0'.repeat(pin.sha.length)])
  } finally { lease.release() }
}

/** Provisioning checks the fork-owned ref under its own repository lease. */
export async function requireForkCheckpoint(threadId: string, checkoutPath: string, repositoryId: string, pin: ForkCheckpointPin): Promise<void> {
  if (pin.repositoryId !== repositoryId || await readDirectLifecycleRefAsync(checkoutPath, forkCheckpointRef(threadId)) !== pin.sha) throw new Error('The accepted fork checkpoint is no longer available.')
}

/** Idempotent after provisioning or permanent cancellation. Keep evidence if a ref was replaced. */
export async function retireForkCheckpoint(threadId: string, threadDirectory: string): Promise<void> {
  const pin = readForkCheckpointPin(threadDirectory)
  if (!pin) return
  const repository = await resolveRepositoryIdentityAsync(pin.checkoutPath, { requireMutationCapability: true })
  if (repository.key !== pin.repositoryId) throw new Error('Fork checkpoint repository changed.')
  const lease = await acquireRepositoryLease(repository, { maxWaitMs: 5_000 })
  try {
    const ref = forkCheckpointRef(threadId)
    const current = await readDirectLifecycleRefAsync(pin.checkoutPath, ref)
    if (current !== undefined) {
      if (current !== pin.sha) throw new Error('Fork checkpoint ref changed.')
      await lifecycleGitAsync(pin.checkoutPath, ['update-ref', '--no-deref', '-d', ref, pin.sha])
    }
    try { unlinkSync(join(threadDirectory, PIN_FILE)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    fsyncDirectorySync(threadDirectory)
  } finally { lease.release() }
}
