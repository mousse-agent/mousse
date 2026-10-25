import type { PhoneSpeechRefusal, SpeechHostMethod, SpeechJobInput, SpeechJobNotice } from '../../shared/speechRelay'
import { runPhoneSpeechJob, type PhoneSpeechDeps } from './phoneSpeechJobs'

/** The window's request bridge to the daemon, narrowed to the speech host methods. */
export type SpeechHostRequest = <T>(method: SpeechHostMethod, params?: Record<string, unknown>) => Promise<T>

interface WaitResult {
  jobs: SpeechJobNotice[]
  cancelled: string[]
}

/** Waits after a failed wait grow to this, so a daemon restart does not spin the loop. */
const MAX_RETRY_MS = 30_000
const FIRST_RETRY_MS = 1_000

interface RunningJob {
  controller: AbortController
  /** Set once this window has claimed the job. */
  jobId: string | null
  /** True once the daemon has the answer, or was told there will be none. */
  ended: boolean
}

const STOPPED_RESULT: PhoneSpeechRefusal = {
  ok: false,
  code: 'failed',
  error: 'Mousse on the computer stopped before it finished.'
}

/**
 * Serves phone speech requests from this window until `stop` is called: waits for jobs, claims
 * each one, runs it with this window's models and sends the answer back. Jobs run concurrently;
 * a job the phone cancelled is aborted.
 */
export function startPhoneSpeechHost(request: SpeechHostRequest, deps: PhoneSpeechDeps): () => void {
  let stopped = false
  let retryMs = FIRST_RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const running = new Map<string, RunningJob>()

  /** Tells the daemon a job this window took will not be answered; a job it already ended ignores it. */
  const abandon = (entry: RunningJob): void => {
    if (!entry.jobId || entry.ended) return
    entry.ended = true
    void request('speech.host.finish', { id: entry.jobId, result: STOPPED_RESULT }).catch(() => undefined)
  }

  const run = async (notice: SpeechJobNotice): Promise<void> => {
    if (running.has(notice.id)) return
    const entry: RunningJob = { controller: new AbortController(), jobId: null, ended: false }
    const { controller } = entry
    running.set(notice.id, entry)
    try {
      const { job } = await request<{ job: SpeechJobInput | null }>('speech.host.take', { id: notice.id })
      if (!job) return
      entry.jobId = job.id
      // The phone may have cancelled, or the window stopped, while the claim was on its way.
      if (stopped || controller.signal.aborted) return
      const result = await runPhoneSpeechJob(job, deps, {
        signal: controller.signal,
        progress: async (data) => {
          if (controller.signal.aborted || stopped) return false
          try {
            const { active } = await request<{ active: boolean }>('speech.host.progress', { id: job.id, data })
            if (!active) controller.abort()
            return active
          } catch {
            controller.abort()
            return false
          }
        }
      })
      if (!controller.signal.aborted && !stopped) {
        await request('speech.host.finish', { id: job.id, result })
        entry.ended = true
      }
    } catch (error) {
      console.warn('A phone speech request failed', error)
    } finally {
      running.delete(notice.id)
      // Whatever ended the run without an answer, the phone should not wait for one.
      abandon(entry)
    }
  }

  const loop = async (): Promise<void> => {
    while (!stopped) {
      let result: WaitResult
      try {
        result = await request<WaitResult>('speech.host.wait')
        retryMs = FIRST_RETRY_MS
      } catch {
        if (stopped) return
        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(resolve, retryMs)
        })
        retryMs = Math.min(MAX_RETRY_MS, retryMs * 2)
        continue
      }
      if (stopped) return
      for (const id of result.cancelled ?? []) running.get(id)?.controller.abort()
      for (const notice of result.jobs ?? []) void run(notice)
    }
  }
  void loop()

  return () => {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    // The connection outlives a profile switch, so the daemon would keep these jobs waiting.
    for (const entry of running.values()) {
      entry.controller.abort()
      abandon(entry)
    }
    running.clear()
  }
}
