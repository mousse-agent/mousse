import { acquireRepositoryLease } from '../git/RepositoryLease'
import { resolveRepositoryIdentity } from '../git/RepositoryIdentity'
import {
  releaseExecutionLeaseHandle,
  waitAcquireExecutionLease
} from '../queue/ThreadExecutionLease'

/** Enforces the global lock order: thread execution lease, then repository lease. */
export async function withGitMutationLocks<T>(
  threadDirectory: string,
  repositoryPath: string,
  source: string,
  operation: () => Promise<T> | T,
  signal?: AbortSignal
): Promise<T> {
  const threadLease = await waitAcquireExecutionLease(threadDirectory, { source, signal })
  try {
    const repository = resolveRepositoryIdentity(repositoryPath, { requireMutationCapability: true })
    const repositoryLease = await acquireRepositoryLease(repository, { signal })
    try {
      return await operation()
    } finally {
      repositoryLease.release()
    }
  } finally {
    releaseExecutionLeaseHandle(threadLease)
  }
}
