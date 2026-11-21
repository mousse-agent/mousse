import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { forgetRepositoryFacts } from '../git/repositoryFacts'
import { heartbeatExecutionLease, releaseExecutionLeaseHandle, tryAcquireExecutionLease } from '../queue/ThreadExecutionLease'
import type { OwnedWorkBarrier } from '../execution/OwnedWorkBarrier'
import { threadScope } from '../execution/workScope'
import { ThreadWorkspaceManager } from './ThreadWorkspaceManager'

/**
 * A new thread's worktree, made while the person is still typing its first message.
 *
 * When a window shows an empty thread of a local project whose new worktree is chosen (New thread, or the worktree
 * picked in its composer), the worktree is made at once, for that thread: the thread's id is the draft's durable id, and
 * its record says the worktree is prepared (`ThreadWorkspaceMetadata.prepared`). The first message claims it
 * (`ThreadWorkspaceManager.claimPrepared`): its turn waits only for what is left of the checkout. A worktree nobody
 * claimed is removed when the thread switches to its project's folder, or after a day if no window shows it, only while it is untouched (`releasePrepared`); deleting the thread removes it
 * as any thread's worktree.
 *
 * A preparation holds the thread's lease from start to end, so nothing else writes the thread meanwhile, and a turn
 * of the thread waits for it here ({@link settledPreparation}) before it takes the lease. Preparations run in this
 * process only; one a quit interrupted is finished by the first turn (`resumeInterruptedProvision`).
 */

/** A prepared worktree that no message claimed for this long is eligible for removal. */
export const PREPARED_WORKTREE_MAX_AGE_MS = 24 * 60 * 60_000

const running = new Map<string, Promise<void>>()

function keyOf(threadDirectory: string): string {
  const path = resolve(threadDirectory)
  return process.platform === 'win32' || process.platform === 'darwin' ? path.toLowerCase() : path
}

export type PreparationStart = 'started' | 'running' | 'made' | 'busy'

/** Reads the start note if its project status scan finished by the time the checkout was ready. */
export function startNoteWhenReady(read: Promise<string | undefined> | undefined): () => string | undefined {
  let note: string | undefined
  void read?.then((value) => { note = value }).catch(() => {})
  return () => note
}

/**
 * Starts making the thread's worktree in the background, unless one is being made or is there already ('running',
 * 'made'), or something else holds the thread ('busy'). The caller has decided the thread is an empty one whose new
 * worktree is chosen. Never throws: a preparation that fails leaves the worktree to be made at Send, as before.
 */
export function prepareThreadWorkspace(input: { threadId: string; threadDirectory: string; projectPath: string; startNote?: () => Promise<string | undefined> }, lifecycle?: OwnedWorkBarrier): PreparationStart {
  const key = keyOf(input.threadDirectory)
  if (running.has(key)) return 'running'
  const manager = new ThreadWorkspaceManager(input.threadDirectory)
  const existing = manager.load()
  if (existing && !(existing.prepared && existing.lifecycle === 'provisioning')) return 'made'
  // Taken now, before anything is awaited, so a turn that starts next finds the preparation and waits for it.
  const lease = tryAcquireExecutionLease(input.threadDirectory, { source: 'workspace-prepare' })
  if (!lease) return 'busy'
  const startedAt = performance.now()
  const signal = lifecycle?.signal
  const work = async () => {
    const heartbeat = setInterval(() => heartbeatExecutionLease(lease), 10_000)
    heartbeat.unref()
    try {
      const current = manager.load()
      if (current && !(current.prepared && current.lifecycle === 'provisioning')) return
      if (current && !await manager.reconcileFailedProvision(input.projectPath, signal) &&
          !await manager.resumeInterruptedProvision(input.projectPath, lease, signal)) return
      if (!manager.load()) {
        const startNote = startNoteWhenReady(input.startNote?.())
        await manager.provision(input.threadId, 'main', input.projectPath, signal, lease, undefined, { prepared: { startNote } })
      }
      forgetRepositoryFacts()
      console.info('[worktree-prep] ready', { threadId: input.threadId, ms: Math.round(performance.now() - startedAt) })
    } catch (error) {
      console.warn('[worktree-prep] the worktree is made at Send instead', { threadId: input.threadId, error: error instanceof Error ? error.message.split('\n')[0] : String(error) })
    } finally {
      clearInterval(heartbeat)
      releaseExecutionLeaseHandle(lease)
      running.delete(key)
    }
  }
  const start = () => Promise.resolve().then(work)
  const promise = lifecycle ? lifecycle.run('workspace-prepare', start, threadScope(input.threadId)) : start()
  running.set(key, promise)
  return 'started'
}

/** Whether the thread's worktree is being prepared now. */
export function isPreparing(threadDirectory: string): boolean {
  return running.has(keyOf(threadDirectory))
}

/**
 * Waits for the thread's preparation, if one is running, and says how long that took (`waitedMs`). Undefined when none
 * was running. A turn calls it before it takes the thread's lease; `signal` ends the wait (a Stop), not the preparation.
 */
export async function settledPreparation(threadDirectory: string, signal?: AbortSignal): Promise<{ waitedMs: number } | undefined> {
  const entry = running.get(keyOf(threadDirectory))
  if (!entry) return undefined
  const began = performance.now()
  if (!signal) await entry
  else if (!signal.aborted) {
    await new Promise<void>((done) => {
      const stop = (): void => done()
      signal.addEventListener('abort', stop, { once: true })
      void entry.finally(() => { signal.removeEventListener('abort', stop); done() })
    })
  }
  return { waitedMs: Math.round(performance.now() - began) }
}

/**
 * Removes the thread's prepared worktree that no message claimed, when it is untouched (`releasePrepared`), after any
 * preparation of it ends. 'busy' when something else holds the thread.
 */
export async function releasePreparedWorkspace(threadDirectory: string, eligible: () => boolean = () => true, signal?: AbortSignal): Promise<'released' | 'kept' | 'none' | 'busy'> {
  await settledPreparation(threadDirectory, signal)
  if (signal?.aborted) return 'busy'
  const manager = new ThreadWorkspaceManager(threadDirectory)
  if (!manager.load()?.prepared) return 'none'
  const lease = tryAcquireExecutionLease(threadDirectory, { source: 'workspace-prepare' })
  if (!lease) return 'busy'
  try {
    if (!eligible()) return 'busy'
    return await manager.releasePrepared(lease, eligible, signal)
  } catch (error) {
    console.warn('[worktree-prep] a prepared worktree could not be removed', { threadDirectory, error: error instanceof Error ? error.message.split('\n')[0] : String(error) })
    return 'kept'
  } finally {
    releaseExecutionLeaseHandle(lease)
  }
}

/** Measures how much checkout time a draft had before its first turn. */
export function notePreparationClaim(threadId: string, prepared: { at: string; readyAt?: string }): void {
  if (!prepared.readyAt) return
  const readyAt = Date.parse(prepared.readyAt)
  console.info('[worktree-prep] claimed', {
    threadId, prepareMs: readyAt - Date.parse(prepared.at), leadMs: Date.now() - readyAt
  })
}
