import { acquireRepositoryLease } from '../git/RepositoryLease'
import { gitCancellationScope } from '../git/runGitProcess'
import { resolveRepositoryIdentityAsync, type RepositoryIdentity } from '../git/RepositoryIdentity'
import { hiddenStoreIdentity, inHiddenStore, type HiddenStore } from '../git/hiddenStore'
import { threadSnapshotStoreAsync } from '../workspace/SnapshotWorkspace'
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
  heldThreadLease?: ThreadLeaseHandle,
  /**
   * Ends the operation's Git commands too (see `gitCancellationScope`). The repository's lock goes only once nothing they
   * started is left: when a stopped command left processes, the operation still ends, and the lock is kept until they
   * are gone (for good, when they never are).
   */
  workSignal?: AbortSignal
): Promise<T> {
  if (heldThreadLease) assertHeldThreadLease(threadDirectory, heldThreadLease)
  const heldRepositories = mutationContext.getStore()
  const start = async (): Promise<{ store: HiddenStore | undefined; repository: RepositoryIdentity; threadLease: Promise<ThreadLeaseHandle> }> => {
    // The thread's own store, read from its record: the same folder may also be a person's repository now.
    const store = await threadSnapshotStoreAsync(threadDirectory, repositoryPath)
    const repository = store ? hiddenStoreIdentity(store) : await resolveRepositoryIdentityAsync(repositoryPath, { requireMutationCapability: true })
    if (heldRepositories?.has(repository.key)) throw new Error('Nested repository mutation is not allowed; finish the owning operation first.')
    // Its first attempt runs now, so a free lease goes to the first caller.
    return { store, repository, threadLease: heldThreadLease ? Promise.resolve(heldThreadLease) : waitAcquireExecutionLease(threadDirectory, { source, signal }) }
  }
  // Callers for one thread start waiting for its lease in the order they called, as when the repository was found synchronously.
  const started = heldThreadLease ? await start() : await inCallOrder(resolve(threadDirectory), start)
  const { store, repository } = started
  const threadLease = await started.threadLease
  try {
    const repositoryLease = await acquireRepositoryLease(repository, { signal })
    const scope = workSignal ? gitCancellationScope(workSignal) : undefined
    try {
      const held = new Set([...(heldRepositories ?? []), repository.key])
      const work = async (): Promise<T> => store ? inHiddenStore(store, operation) : operation()
      return await mutationContext.run(held, () => scope ? scope.run(work) : work())
    } finally {
      const survivors = scope?.survivorsGone()
      // Processes a stopped command left keep the repository locked until they are gone; never released early.
      if (survivors) void survivors.then((gone) => { if (gone) repositoryLease.release() })
      else repositoryLease.release()
    }
  } finally {
    if (!heldThreadLease) releaseExecutionLeaseHandle(threadLease)
  }
}
