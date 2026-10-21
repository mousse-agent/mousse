import { randomBytes } from 'node:crypto'
import {
  PHONE_SPEECH_MAX_JOBS,
  PHONE_SPEECH_MAX_RECORDING_BYTES,
  PHONE_SPEECH_MAX_UPLOADS,
  PHONE_SPEECH_UPLOAD_TTL_MS,
  SPEECH_HOST_FRESH_MS,
  SPEECH_HOST_WAIT_MS,
  SPEECH_JOB_TAKE_TIMEOUT_MS,
  type PhoneSpeechErrorCode,
  type PhoneSpeechKind,
  type PhoneSpeechRefusal,
  type SpeechJobInput,
  type SpeechJobNotice,
  type SpeechJobOp
} from '../../shared/speechRelay'

/** The parts of the Net clock the relay uses; tests pass a manual one. */
export interface SpeechRelayClock {
  now(): number
  setTimeout(callback: () => void, ms: number): { cancel(): void }
}

export function refusal(code: PhoneSpeechErrorCode, error: string): PhoneSpeechRefusal {
  return { ok: false, code, error }
}

export const NO_HOST_MESSAGE =
  'Mousse is not open on this computer. Open it there to use its speech models from your phone.'

interface Job {
  notice: SpeechJobNotice
  params: Record<string, unknown>
  audio?: Buffer
  /** Connection of the window working on it, once taken. */
  host?: string
  /** Windows already told about it; each hears of a job once. */
  announced: Set<string>
  progress(data: unknown): void
  settle(value: unknown): void
  takeTimer?: { cancel(): void }
}

interface Waiter {
  resolve(value: SpeechWaitResult): void
  timer: { cancel(): void }
}

interface Upload {
  node: string
  parts: Buffer[]
  bytes: number
  expiry: { cancel(): void }
}

export interface SpeechWaitResult {
  jobs: SpeechJobNotice[]
  /** Jobs this window took whose phone request ended; stop working on them. */
  cancelled: string[]
}

export interface SpeechSubmitOptions {
  signal: AbortSignal
  progress(data: unknown): void
  audio?: Buffer
}

const EMPTY_WAIT: SpeechWaitResult = { jobs: [], cancelled: [] }

/**
 * Hands phone speech requests to an open Mousse window of the same profile and carries the
 * window's answers back. The window long-polls `wait`, claims a job with `take`, streams
 * `progress` and ends it with `finish`. A phone request settles with the window's answer, or with
 * a refusal when no window is open, none picks the job up in time, or the window closes.
 */
export class SpeechRelay {
  private readonly jobs = new Map<string, Job>()
  private readonly waiters = new Map<string, Waiter>()
  private readonly cancelNotices = new Map<string, Set<string>>()
  private readonly uploads = new Map<string, Upload>()
  private lastWaitAt = Number.NEGATIVE_INFINITY

  constructor(private readonly clock: SpeechRelayClock) {}

  /** True while a window waits for work or waited moments ago. */
  hostAttached(): boolean {
    return this.waiters.size > 0 || this.clock.now() - this.lastWaitAt < SPEECH_HOST_FRESH_MS
  }

  /** Runs one request in a window; resolves with the window's answer or a refusal. Never rejects. */
  submit(
    op: SpeechJobOp,
    kind: PhoneSpeechKind,
    params: Record<string, unknown>,
    options: SpeechSubmitOptions
  ): Promise<unknown> {
    if (options.signal.aborted)
      return Promise.resolve(refusal('failed', 'The request was cancelled.'))
    if (this.jobs.size >= PHONE_SPEECH_MAX_JOBS)
      return Promise.resolve(
        refusal('busy', 'The computer is busy with other speech requests. Try again in a moment.')
      )
    if (!this.hostAttached()) return Promise.resolve(refusal('no_host', NO_HOST_MESSAGE))
    return new Promise((resolve) => {
      const id = `sj_${randomBytes(12).toString('base64url')}`
      const onAbort = (): void => {
        const current = this.jobs.get(id)
        if (!current) return
        if (current.host) this.notifyCancel(current.host, id)
        current.settle(refusal('failed', 'The request was cancelled.'))
      }
      const job: Job = {
        notice: { id, op, kind },
        params,
        announced: new Set(),
        ...(options.audio ? { audio: options.audio } : {}),
        progress: options.progress,
        settle: (value) => {
          if (this.jobs.get(id) !== job) return
          this.jobs.delete(id)
          job.takeTimer?.cancel()
          options.signal.removeEventListener('abort', onAbort)
          resolve(value)
        }
      }
      this.jobs.set(id, job)
      job.takeTimer = this.clock.setTimeout(() => {
        if (!job.host) job.settle(refusal('no_host', NO_HOST_MESSAGE))
      }, SPEECH_JOB_TAKE_TIMEOUT_MS)
      options.signal.addEventListener('abort', onAbort, { once: true })
      this.wakeAll()
    })
  }

  // -------------------------------------------------------------------------------------------
  // Window side
  // -------------------------------------------------------------------------------------------

  /** Resolves with queued jobs and cancellations at once, or when one arrives, or after a while. */
  wait(connection: string): Promise<SpeechWaitResult> {
    this.lastWaitAt = this.clock.now()
    this.waiters.get(connection)?.resolve(EMPTY_WAIT)
    const ready = this.collect(connection)
    if (ready.jobs.length || ready.cancelled.length) return Promise.resolve(ready)
    return new Promise((resolve) => {
      const waiter: Waiter = {
        timer: this.clock.setTimeout(() => waiter.resolve(EMPTY_WAIT), SPEECH_HOST_WAIT_MS),
        resolve: (value) => {
          if (this.waiters.get(connection) !== waiter) return
          this.waiters.delete(connection)
          waiter.timer.cancel()
          this.lastWaitAt = this.clock.now()
          resolve(value)
        }
      }
      this.waiters.set(connection, waiter)
    })
  }

  /** Claims a queued job for this window; null when another window took it or it ended. */
  take(connection: string, id: string): SpeechJobInput | null {
    const job = this.jobs.get(id)
    if (!job || job.host) return null
    job.host = connection
    job.takeTimer?.cancel()
    return {
      ...job.notice,
      params: job.params,
      ...(job.audio ? { audioBase64: job.audio.toString('base64') } : {})
    }
  }

  /** Forwards progress to the phone; `active: false` tells the window to stop. */
  progress(connection: string, id: string, data: unknown): { active: boolean } {
    const job = this.jobs.get(id)
    if (!job || job.host !== connection) return { active: false }
    job.progress(data)
    return { active: true }
  }

  finish(connection: string, id: string, result: unknown): void {
    const job = this.jobs.get(id)
    if (job && job.host === connection) job.settle(result)
  }

  /** A window's connection closed: its wait ends and the jobs it took fail. */
  connectionClosed(connection: string): void {
    this.waiters.get(connection)?.resolve(EMPTY_WAIT)
    this.cancelNotices.delete(connection)
    for (const job of [...this.jobs.values()]) {
      if (job.host === connection)
        job.settle(refusal('failed', 'Mousse on the computer stopped before it finished.'))
    }
  }

  // -------------------------------------------------------------------------------------------
  // Recordings
  // -------------------------------------------------------------------------------------------

  /** Adds piece `index` of a recording. A piece sent again is accepted again without change. */
  appendUpload(
    node: string,
    upload: string,
    index: number,
    data: Buffer
  ): { ok: true; bytes: number } | PhoneSpeechRefusal {
    const key = uploadKey(node, upload)
    let entry = this.uploads.get(key)
    if (!entry) {
      if (index !== 0)
        return refusal('invalid', 'This recording is no longer on the computer. Record it again.')
      if ([...this.uploads.values()].filter((value) => value.node === node).length >= PHONE_SPEECH_MAX_UPLOADS)
        return refusal('busy', 'Too many recordings are being sent at once.')
      entry = { node, parts: [], bytes: 0, expiry: { cancel: () => undefined } }
      this.uploads.set(key, entry)
    }
    if (index < entry.parts.length) return { ok: true, bytes: entry.bytes }
    if (index > entry.parts.length)
      return refusal('invalid', 'A piece of the recording went missing. Record it again.')
    if (entry.bytes + data.byteLength > PHONE_SPEECH_MAX_RECORDING_BYTES) {
      this.dropUpload(node, upload)
      return refusal('invalid', 'The recording is too long. Record a shorter message.')
    }
    entry.parts.push(data)
    entry.bytes += data.byteLength
    this.touchUpload(key, entry)
    return { ok: true, bytes: entry.bytes }
  }

  /** The whole recording when exactly `parts` pieces arrived. */
  recording(node: string, upload: string, parts: number): Buffer | PhoneSpeechRefusal {
    const key = uploadKey(node, upload)
    const entry = this.uploads.get(key)
    if (!entry)
      return refusal('invalid', 'This recording is no longer on the computer. Record it again.')
    if (entry.parts.length !== parts)
      return refusal('invalid', 'The recording did not arrive completely. Record it again.')
    if (entry.bytes === 0) return refusal('invalid', 'The recording is empty.')
    this.touchUpload(key, entry)
    return Buffer.concat(entry.parts)
  }

  dropUpload(node: string, upload: string): void {
    const key = uploadKey(node, upload)
    this.uploads.get(key)?.expiry.cancel()
    this.uploads.delete(key)
  }

  close(): void {
    for (const waiter of [...this.waiters.values()]) waiter.resolve(EMPTY_WAIT)
    for (const job of [...this.jobs.values()])
      job.settle(refusal('failed', 'Mousse on the computer is shutting down.'))
    for (const entry of this.uploads.values()) entry.expiry.cancel()
    this.uploads.clear()
  }

  private touchUpload(key: string, entry: Upload): void {
    entry.expiry.cancel()
    entry.expiry = this.clock.setTimeout(() => {
      if (this.uploads.get(key) === entry) this.uploads.delete(key)
    }, PHONE_SPEECH_UPLOAD_TTL_MS)
  }

  private collect(connection: string): SpeechWaitResult {
    const jobs: SpeechJobNotice[] = []
    for (const job of this.jobs.values()) {
      if (job.host || job.announced.has(connection)) continue
      job.announced.add(connection)
      jobs.push(job.notice)
    }
    const cancelled = [...(this.cancelNotices.get(connection) ?? [])]
    this.cancelNotices.delete(connection)
    return { jobs, cancelled }
  }

  private notifyCancel(connection: string, id: string): void {
    const set = this.cancelNotices.get(connection) ?? new Set<string>()
    set.add(id)
    this.cancelNotices.set(connection, set)
    this.waiters.get(connection)?.resolve(this.collect(connection))
  }

  private wakeAll(): void {
    for (const [connection, waiter] of [...this.waiters]) waiter.resolve(this.collect(connection))
  }
}

function uploadKey(node: string, upload: string): string {
  return `${node}\u0000${upload}`
}
