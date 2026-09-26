import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import {
  readLeaseOwner,
  releaseExecutionLeaseHandle,
  waitAcquireExecutionLease,
  type ThreadLeaseHandle
} from '../queue/ThreadExecutionLease'
import { resolve } from 'node:path'

export function assertHeldThreadLease(threadDirectory: string, lease: ThreadLeaseHandle): void {
  if (resolve(lease.threadDir) !== resolve(threadDirectory) ||
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
  const threadLease = heldThreadLease ?? await waitAcquireExecutionLease(threadDirectory, { source, signal })
  try {
    const repository = resolveRepositoryIdentity(repositoryPath, { requireMutationCapability: true })
    const repositoryLease = await acquireRepositoryLease(repository, { signal })
    try {
      return await operation()
    } finally {
      repositoryLease.release()
    }
  } finally {
    if (!heldThreadLease) releaseExecutionLeaseHandle(threadLease)
  }
}
