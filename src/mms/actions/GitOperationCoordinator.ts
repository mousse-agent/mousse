import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
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

export function assertHeldThreadLease(threadDirectory: string, lease: ThreadLeaseHandle): void {
  if (resolve(lease.threadDir) !== resolve(threadDirectory) ||
      resolve(lease.lockPath) !== resolve(getExecutionLeasePath(threadDirectory)) ||
      lease.owner.pid !== process.pid || readLeaseOwner(lease.lockPath)?.token !== lease.owner.token) {
    throw new Error('The supplied execution lease does not own this task.')
  }
}

/** Enforces the global lock order: thread execution lease, then repository lease. */
export async function withGitMutationLocks<T>(
  threadDirectory: string,
  repositoryPath: string,
  source: string,
  operation: () => Promise<T> | T,
  signal?: AbortSignal,
  heldThreadLease?: ThreadLeaseHandle
): Promise<T> {
  if (heldThreadLease) assertHeldThreadLease(threadDirectory, heldThreadLease)
  const repository = resolveRepositoryIdentity(repositoryPath, { requireMutationCapability: true })
  const heldRepositories = mutationContext.getStore()
  if (heldRepositories?.has(repository.key)) throw new Error('Nested repository mutation is not allowed; finish the owning operation first.')
  const threadLease = heldThreadLease ?? await waitAcquireExecutionLease(threadDirectory, { source, signal })
  try {
    const repositoryLease = await acquireRepositoryLease(repository, { signal })
    try {
      return await mutationContext.run(new Set([...(heldRepositories ?? []), repository.key]), operation)
    } finally {
      repositoryLease.release()
    }
  } finally {
    if (!heldThreadLease) releaseExecutionLeaseHandle(threadLease)
  }
}
