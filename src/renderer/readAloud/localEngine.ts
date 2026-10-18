import { KOKORO_82M } from '../../shared/readAloud'
import type { KokoroWorkerEvent, KokoroWorkerRequest } from './kokoroWorker'
import type { SpeakOptions } from './providerEngine'
import { splitSpeechChunks } from './speechText'

/**
 * Kokoro runs on single-threaded WebAssembly (the window is not cross-origin isolated), where one
 * worker produces audio at about 0.7x real time. Two workers synthesizing consecutive segments in
 * parallel stay ahead of playback.
 */
const POOL_SIZE = 2
/** Short segments keep the wait before the first audio low. */
const SEGMENT_CHARS = 120

let pool: Worker[] = []
let lastRequestId = 0

function send(target: Worker, message: KokoroWorkerRequest, transfer: Transferable[] = []): void {
  target.postMessage(message, transfer)
}

async function answerFileRequest(target: Worker, reqId: number, path: string): Promise<void> {
  try {
    const bytes = await window.mousse.readAloud.readLocalModelFile(KOKORO_82M.id, path)
    const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    const buffer = (exact ? bytes.buffer : bytes.slice().buffer) as ArrayBuffer
    send(target, { type: 'file-response', reqId, bytes: buffer }, [buffer])
  } catch (error) {
    send(target, { type: 'file-response', reqId, error: error instanceof Error ? error.message : String(error) })
  }
}

function createWorker(): Worker {
  const created = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' })
  created.addEventListener('message', (event: MessageEvent<KokoroWorkerEvent>) => {
    if (event.data.type === 'file-request') void answerFileRequest(created, event.data.reqId, event.data.path)
  })
  return created
}

function ensurePool(): Worker[] {
  if (pool.length === 0) pool = Array.from({ length: POOL_SIZE }, createWorker)
  return pool
}

/** Drops the loaded model, e.g. after its files were deleted. */
export function disposeLocalEngine(): void {
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
    const workers = ensurePool()
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
