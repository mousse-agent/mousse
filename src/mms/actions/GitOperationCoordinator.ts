import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import { hiddenStoreFor, hiddenStoreIdentity, inHiddenStore } from '../git/hiddenStore'
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
  const store = hiddenStoreFor(repositoryPath)
  const repository = store ? hiddenStoreIdentity(store) : resolveRepositoryIdentity(repositoryPath, { requireMutationCapability: true })
  const heldRepositories = mutationContext.getStore()
  if (heldRepositories?.has(repository.key)) throw new Error('Nested repository mutation is not allowed; finish the owning operation first.')
  const threadLease = heldThreadLease ?? await waitAcquireExecutionLease(threadDirectory, { source, signal })
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
