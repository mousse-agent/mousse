import type { PlatformRequestApi } from '../../shared/platform'

/** The two ways to act on a run paused by a usage limit. Stopping the thread goes through the usual Stop. */
export interface PausedRunClient {
  /**
   * Continue the run now instead of at the reset time. Refused when the run is no longer paused.
   * `threadId` names the run's thread; a thread on another computer needs it.
   */
  resumeNow(runId: string, threadId?: string): Promise<void>
  /** End the pause without continuing: the run is cancelled and the thread's held messages go on. */
  cancel(runId: string, threadId?: string): Promise<void>
}

export function createPausedRunClient(api: PlatformRequestApi): PausedRunClient {
  return {
    async resumeNow(runId, threadId) { await api.request('runs.resumeNow', { runId, ...(threadId ? { threadId } : {}) }) },
    async cancel(runId, threadId) { await api.request('runs.cancelPause', { runId, ...(threadId ? { threadId } : {}) }) }
  }
}
