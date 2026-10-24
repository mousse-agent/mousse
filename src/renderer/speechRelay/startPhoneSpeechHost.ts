import type { SpeechHostMethod, SpeechJobInput, SpeechJobNotice } from '../../shared/speechRelay'
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

/**
 * Serves phone speech requests from this window until `stop` is called: waits for jobs, claims
 * each one, runs it with this window's models and sends the answer back. Jobs run concurrently;
 * a job the phone cancelled is aborted.
 */
export function startPhoneSpeechHost(request: SpeechHostRequest, deps: PhoneSpeechDeps): () => void {
  let stopped = false
  let retryMs = FIRST_RETRY_MS
  let retryTimer: ReturnType<typeof setTimeout> | null = null
  const running = new Map<string, AbortController>()

  const run = async (notice: SpeechJobNotice): Promise<void> => {
    if (running.has(notice.id)) return
    const controller = new AbortController()
    running.set(notice.id, controller)
    try {
      const { job } = await request<{ job: SpeechJobInput | null }>('speech.host.take', { id: notice.id })
      if (!job || stopped) return
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
      if (!controller.signal.aborted && !stopped) await request('speech.host.finish', { id: job.id, result })
    } catch (error) {
      console.warn('A phone speech request failed', error)
    } finally {
      running.delete(notice.id)
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
      for (const id of result.cancelled ?? []) running.get(id)?.abort()
      for (const notice of result.jobs ?? []) void run(notice)
    }
  }
  void loop()

  return () => {
    stopped = true
    if (retryTimer) clearTimeout(retryTimer)
    for (const controller of running.values()) controller.abort()
    running.clear()
  }
}
