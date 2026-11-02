import { findLocalSttModel, type LocalSttModel, type LocalSttModelId } from '../../shared/dictation'
import { joinTranscriptSegments } from '../../shared/dictationPostProcess'
import { serveModelFiles } from '../speechModels/pageSupport'
import { MIN_SEGMENT_SECONDS, decodeRecording, splitIntoSegments } from './audio'
import type { LocalSttWorkerEvent, LocalSttWorkerRequest } from './workerProtocol'

interface Pending {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

/**
 * The loaded model holds WebAssembly memory that is only returned when the worker ends, so the
 * worker is shut down when dictation has been idle for a while. Loading it again takes a second or
 * more (several for the larger models), so the wait covers a run of dictations, as for read aloud.
 */
export const IDLE_DISPOSE_MS = 5 * 60_000

/** How far the model of the current worker has got. */
export type LocalEngineState = 'cold' | 'loading' | 'ready'

/** One worker at a time, for the model that was used last. */
let worker: { modelId: LocalSttModelId; worker: Worker; warming: Promise<void> | null; ready: boolean } | null = null
let lastRequestId = 0
/** Warm-ups and transcriptions in flight; the worker is never disposed under them. */
let busy = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
const pending = new Map<number, Pending>()

function failAll(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function createWorker(model: LocalSttModel): Worker {
  switch (model.runtime) {
    case 'nemo-transducer':
      return new Worker(new URL('./parakeetWorker.ts', import.meta.url), { type: 'module' })
    case 'whisper':
      return new Worker(new URL('./whisperWorker.ts', import.meta.url), { type: 'module' })
    case 'moonshine':
      return new Worker(new URL('./moonshineWorker.ts', import.meta.url), { type: 'module' })
  }
}

function ensureWorker(model: LocalSttModel): NonNullable<typeof worker> {
  if (worker?.modelId === model.id) return worker
  disposeLocalEngine()
  const created = createWorker(model)
  const init: LocalSttWorkerRequest = { type: 'init', modelId: model.id }
  created.postMessage(init)
  serveModelFiles(created, (path) => window.mousse.dictation.readLocalModelFile(model.id, path))
  created.addEventListener('message', (event: MessageEvent<LocalSttWorkerEvent>) => {
    const message = event.data
    if (message.type !== 'result' && message.type !== 'error') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.type === 'result') request.resolve(message.text)
    else request.reject(new Error(message.message))
  })
  created.addEventListener('error', (event) => {
    if (worker?.worker === created) worker = null
    created.terminate()
    failAll(new Error(event.message || 'The local speech engine stopped unexpectedly'))
  })
  worker = { modelId: model.id, worker: created, warming: null, ready: false }
  return worker
}

function cancelIdleDispose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleDispose(): void {
  cancelIdleDispose()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (busy === 0) disposeLocalEngine()
  }, IDLE_DISPOSE_MS)
}

/** Marks the start of work that must keep the worker alive; the returned function marks its end. */
function hold(): () => void {
  cancelIdleDispose()
  busy++
  return () => {
    busy--
    if (busy === 0) scheduleIdleDispose()
  }
}

/** Drops the loaded model, e.g. after its files were deleted or when it has been idle. */
export function disposeLocalEngine(): void {
  cancelIdleDispose()
  worker?.worker.terminate()
  worker = null
  failAll(new Error('The local speech engine was stopped'))
}

/** Sends one request to the worker of `model`, starting it if needed, and waits for the answer. */
function ask(model: LocalSttModel, message: (id: number) => LocalSttWorkerRequest, transfer: Transferable[] = []): Promise<string> {
  return new Promise((resolve, reject) => {
    // Before the request is registered: switching models stops the old worker and fails its requests.
    const target = ensureWorker(model)
    const id = ++lastRequestId
    pending.set(id, { resolve, reject })
    target.worker.postMessage(message(id), transfer)
  })
}

/** Whether the worker for `modelId` has its model loaded, is loading it, or has none. */
export function localEngineState(modelId: LocalSttModelId): LocalEngineState {
  if (worker?.modelId !== modelId) return 'cold'
  return worker.ready ? 'ready' : worker.warming ? 'loading' : 'cold'
}

/**
 * Starts the worker for `modelId` and loads its model, so a recording that starts now does not wait
 * for loading when it stops. Does nothing more when that model is loaded or loading. A failure is
 * left for the transcription that follows to report.
 */
export function warmLocalEngine(modelId: LocalSttModelId): void {
  const model = findLocalSttModel(modelId)
  if (!model) return
  const release = hold()
  const current = ensureWorker(model)
  if (current.warming || current.ready) {
    release()
    return
  }
  const started = performance.now()
  current.warming = ask(model, (id) => ({ type: 'warm', id }))
    .then(() => {
      current.ready = true
      console.info(`[dictation] ${model.label} ready in ${Math.round(performance.now() - started)} ms`)
    })
    .catch(() => {
      // Let the next recording try again; the transcription reports the error.
      current.warming = null
    })
    .finally(release)
}

function transcribeSegment(model: LocalSttModel, samples: Float32Array): Promise<string> {
  // Copy: segments are views of one large buffer, and transferring would detach all of it.
  const copy = samples.slice()
  return ask(model, (id) => ({ type: 'transcribe', id, samples: copy }), [copy.buffer])
}

/**
 * Transcribes one piece of 16 kHz audio (at most the model's longest segment) with a local model.
 * Live dictation sends each piece as the user pauses (`liveTranscription.ts`).
 */
export async function transcribeLocalSamples(modelId: LocalSttModelId, samples: Float32Array): Promise<string> {
  const model = findLocalSttModel(modelId)
  if (!model) throw new Error(`Unknown local dictation model: ${modelId}`)
  const release = hold()
  try {
    const text = await transcribeSegment(model, samples)
    if (worker?.modelId === model.id) worker.ready = true
    return text
  } finally {
    release()
  }
}

/**
 * Transcribes a recording with a local model, one segment at a time. `onPartial` receives the
 * text of the segments done so far after each one. Aborting `signal` stops before the next
 * segment goes to the worker and rejects; the segment the worker is already on finishes unseen.
 */
export async function transcribeWithLocalModel(
  modelId: LocalSttModelId,
  recording: Blob,
  onPartial?: (text: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const model = findLocalSttModel(modelId)
  if (!model) throw new Error(`Unknown local dictation model: ${modelId}`)
  const release = hold()
  try {
    signal?.throwIfAborted()
    const state = localEngineState(model.id)
    const started = performance.now()
    const samples = await decodeRecording(recording, model.sampleRate)
    const decoded = performance.now()
    const minSamples = Math.ceil(MIN_SEGMENT_SECONDS * model.sampleRate)
    const parts: string[] = []
    let segments = 0
    for (const segment of splitIntoSegments(samples, model.sampleRate, model.maxSegmentSeconds)) {
      signal?.throwIfAborted()
      if (segment.length < minSamples) continue
      segments++
      const text = await transcribeSegment(model, segment)
      if (text) {
        parts.push(text)
        if (!signal?.aborted) onPartial?.(joinTranscriptSegments(parts))
      }
    }
    signal?.throwIfAborted()
    if (worker?.modelId === model.id) worker.ready = true
    const seconds = (samples.length / model.sampleRate).toFixed(1)
    console.info(
      `[dictation] ${model.label}: ${seconds} s of audio, decoded in ${Math.round(decoded - started)} ms, ` +
        `${segments} segment(s) in ${Math.round(performance.now() - decoded)} ms, model was ${state}`
    )
    return joinTranscriptSegments(parts)
  } finally {
    release()
  }
}
