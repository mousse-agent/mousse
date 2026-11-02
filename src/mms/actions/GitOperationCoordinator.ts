import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentityAsync, type RepositoryIdentity } from '../git/RepositoryIdentity'
import { hiddenStoreIdentity, inHiddenStore } from '../git/hiddenStore'
import { threadSnapshotStore } from '../workspace/SnapshotWorkspace'
import {
  getExecutionLeasePath,
  readLeaseOwner,
  releaseExecutionLeaseHandle,
  waitAcquireExecutionLease,
  type ThreadLeaseHandle
} from '../queue/ThreadExecutionLease'
import { resolve } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'

const mutationContext = new AsyncLocalStorage<Set<string>>()

/** Whether the current async operation already holds this repository's mutation lease. */
export function holdsRepositoryMutation(key: string): boolean {
  return mutationContext.getStore()?.has(key) ?? false
}

export function assertHeldThreadLease(threadDirectory: string, lease: ThreadLeaseHandle): void {
  if (resolve(lease.threadDir) !== resolve(threadDirectory) ||
      resolve(lease.lockPath) !== resolve(getExecutionLeasePath(threadDirectory)) ||
      lease.owner.pid !== process.pid || readLeaseOwner(lease.lockPath)?.token !== lease.owner.token) {
    throw new Error('The supplied execution lease does not own this task.')
  }
}

/** The last caller in line for each thread folder; see {@link inCallOrder}. */
const callOrder = new Map<string, Promise<void>>()

/** Runs `step` after the step of every earlier caller for `key` has finished, so callers take turns in call order. */
function inCallOrder<T>(key: string, step: () => Promise<T>): Promise<T> {
  const mine = (callOrder.get(key) ?? Promise.resolve()).then(step)
  const settled = mine.then(() => undefined, () => undefined)
  callOrder.set(key, settled)
  void settled.then(() => { if (callOrder.get(key) === settled) callOrder.delete(key) })
  return mine
}

/**
 * Enforces the global lock order: thread execution lease, then repository lease. A folder whose snapshots live in a
 * hidden store is locked by the store, so the threads that share the folder take turns; the operation then runs with
 * Git going through the store.
 */
export async function withGitMutationLocks<T>(
  threadDirectory: string,
  repositoryPath: string,
  source: string,
  operation: () => Promise<T> | T,
  signal?: AbortSignal,
  heldThreadLease?: ThreadLeaseHandle
): Promise<T> {
  if (heldThreadLease) assertHeldThreadLease(threadDirectory, heldThreadLease)
  // The thread's own store, read from its record: the same folder may also be a person's repository now.
  const store = threadSnapshotStore(threadDirectory, repositoryPath)
  const heldRepositories = mutationContext.getStore()
  const start = async (): Promise<{ repository: RepositoryIdentity; threadLease: Promise<ThreadLeaseHandle> }> => {
    const repository = store ? hiddenStoreIdentity(store) : await resolveRepositoryIdentityAsync(repositoryPath, { requireMutationCapability: true })
    if (heldRepositories?.has(repository.key)) throw new Error('Nested repository mutation is not allowed; finish the owning operation first.')
    // Its first attempt runs now, so a free lease goes to the first caller.
    return { repository, threadLease: heldThreadLease ? Promise.resolve(heldThreadLease) : waitAcquireExecutionLease(threadDirectory, { source, signal }) }
  }
  // Callers for one thread start waiting for its lease in the order they called, as when the repository was found synchronously.
  const started = heldThreadLease ? await start() : await inCallOrder(resolve(threadDirectory), start)
  const repository = started.repository
  const threadLease = await started.threadLease
  try {
    const repositoryLease = await acquireRepositoryLease(repository, { signal })
    try {
      const held = new Set([...(heldRepositories ?? []), repository.key])
      return await mutationContext.run(held, () => store ? inHiddenStore(store, operation) : operation())
    } finally {
      repositoryLease.release()
    }
  } finally {
    if (!heldThreadLease) releaseExecutionLeaseHandle(threadLease)
  }
}
