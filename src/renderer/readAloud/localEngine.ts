import { KOKORO_82M } from '../../shared/readAloud'
import type { KokoroWorkerEvent, KokoroWorkerRequest } from './kokoroWorker'
import type { SpeakOptions } from './providerEngine'
import { serveModelFiles } from '../speechModels/pageSupport'
import { splitSpeechChunks } from './speechText'

/**
 * Kokoro runs on single-threaded WebAssembly (the window is not cross-origin isolated), where one
 * worker produces audio at about 0.7x real time. Two workers synthesizing consecutive segments in
 * parallel stay ahead of playback.
 */
const POOL_SIZE = 2
/** Short segments keep the wait before the first audio low. */
const SEGMENT_CHARS = 120
/**
 * A loaded worker holds about 500 MB of WebAssembly memory that is only returned when the worker
 * ends, so the pool is shut down shortly after the last playback.
 */
const IDLE_DISPOSE_MS = 15_000

let pool: Worker[] = []
let lastRequestId = 0
let activeSessions = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null

function send(target: Worker, message: KokoroWorkerRequest, transfer: Transferable[] = []): void {
  target.postMessage(message, transfer)
}

function createWorker(): Worker {
  const created = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' })
  serveModelFiles(created, (path) => window.mousse.readAloud.readLocalModelFile(KOKORO_82M.id, path))
  return created
}

/** Starts workers up to `size`; a one-segment message needs only one. */
function ensurePool(size: number): Worker[] {
  while (pool.length < size) pool.push(createWorker())
  return pool.slice(0, size)
}

function cancelIdleDispose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleDispose(): void {
  cancelIdleDispose()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (activeSessions === 0) disposeLocalEngine()
  }, IDLE_DISPOSE_MS)
}

/** Drops the loaded model, e.g. after its files were deleted or when it has been idle. */
export function disposeLocalEngine(): void {
  cancelIdleDispose()
  for (const worker of pool) worker.terminate()
  pool = []
}

interface SegmentState {
  chunks: { samples: Float32Array; sampleRate: number }[]
  scheduled: number
  done: boolean
}

/** Speaks `text` with the local Kokoro model. Resolves when playback ends or is aborted. */
export function speakWithLocalModel(text: string, { signal, onPlaying }: SpeakOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve()
    const segments = splitSpeechChunks(text, SEGMENT_CHARS)
    if (segments.length === 0) return resolve()
    cancelIdleDispose()
    activeSessions++
    const workers = ensurePool(Math.min(POOL_SIZE, segments.length))
    const context = new AudioContext()
    void context.resume().catch(() => undefined)
    const states: SegmentState[] = segments.map(() => ({ chunks: [], scheduled: 0, done: false }))
    const inFlight = new Map<number, { index: number; worker: Worker }>()
    const busy = new Set<Worker>()
    const sources = new Set<AudioBufferSourceNode>()
    let nextDispatch = 0
    let nextPlay = 0
    let nextStart = 0
    let started = false
    let settled = false

    const settle = (error?: Error): void => {
      if (settled) return
      settled = true
      activeSessions--
      if (activeSessions === 0) scheduleIdleDispose()
      for (const worker of workers) {
        worker.removeEventListener('message', onMessage)
        worker.removeEventListener('error', onWorkerError)
      }
      for (const [id, { worker }] of inFlight) send(worker, { type: 'cancel', id })
      inFlight.clear()
      signal.removeEventListener('abort', onAbort)
      for (const source of sources) {
        source.onended = null
        try {
          source.stop()
        } catch {
          /* already stopped */
        }
      }
      sources.clear()
      void context.close().catch(() => undefined)
      if (error) reject(error)
      else resolve()
    }

    // Keep at most one segment per worker waiting beyond the one that is playing.
    const dispatch = (): void => {
      for (const worker of workers) {
        if (nextDispatch >= segments.length || nextDispatch - nextPlay > workers.length) return
        if (busy.has(worker)) continue
        const id = ++lastRequestId
        busy.add(worker)
        inFlight.set(id, { index: nextDispatch, worker })
        send(worker, { type: 'speak', id, text: segments[nextDispatch] })
        nextDispatch++
      }
    }

    const schedule = (chunk: { samples: Float32Array; sampleRate: number }): void => {
      const buffer = context.createBuffer(1, chunk.samples.length, chunk.sampleRate)
      buffer.copyToChannel(chunk.samples as Float32Array<ArrayBuffer>, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      const startAt = Math.max(nextStart, context.currentTime + 0.05)
      nextStart = startAt + buffer.duration
      sources.add(source)
      source.onended = () => {
        sources.delete(source)
        drain()
      }
      source.start(startAt)
      if (!started) {
        started = true
        onPlaying()
      }
    }

    // Schedules finished audio in segment order and ends once the last segment has played.
    const drain = (): void => {
      while (nextPlay < states.length) {
        const state = states[nextPlay]
        while (state.scheduled < state.chunks.length) schedule(state.chunks[state.scheduled++])
        if (!state.done) break
        state.chunks = []
        nextPlay++
        dispatch()
      }
      if (nextPlay >= states.length && sources.size === 0) settle()
    }

    const onMessage = (event: MessageEvent<KokoroWorkerEvent>): void => {
      const message = event.data
      if (message.type === 'file-request') return
      const request = inFlight.get(message.id)
      if (!request) return
      if (message.type === 'error') {
        settle(new Error(message.message))
        return
      }
      const state = states[request.index]
      if (message.type === 'audio') {
        state.chunks.push({ samples: message.samples, sampleRate: message.sampleRate })
      } else {
        state.done = true
        inFlight.delete(message.id)
        busy.delete(request.worker)
        dispatch()
      }
      drain()
    }
    const onWorkerError = (event: ErrorEvent): void => {
      disposeLocalEngine()
      settle(new Error(event.message || 'The local voice engine stopped unexpectedly'))
    }
    const onAbort = (): void => settle()

    for (const worker of workers) {
      worker.addEventListener('message', onMessage)
      worker.addEventListener('error', onWorkerError)
    }
    signal.addEventListener('abort', onAbort)
    dispatch()
  })
}
