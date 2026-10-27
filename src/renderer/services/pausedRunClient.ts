import type { PlatformRequestApi } from '../../shared/platform'

/** The two ways to act on a run paused by a usage limit. Stopping the thread goes through the usual Stop. */
export interface PausedRunClient {
  /** Continue the run now instead of at the reset time. Refused when the run is no longer paused. */
  resumeNow(runId: string): Promise<void>
  /** End the pause without continuing: the run is cancelled and the thread's held messages go on. */
  cancel(runId: string): Promise<void>
}

export function createPausedRunClient(api: PlatformRequestApi): PausedRunClient {
  return {
    async resumeNow(runId) { await api.request('runs.resumeNow', { runId }) },
    async cancel(runId) { await api.request('runs.cancelPause', { runId }) }
  }
}
