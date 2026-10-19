import { findLocalSttModel, type LocalSttModel, type LocalSttModelId } from '../../shared/dictation'
import { serveModelFiles } from '../speechModels/pageSupport'
import { MIN_SEGMENT_SECONDS, decodeRecording, splitIntoSegments } from './audio'
import type { LocalSttWorkerEvent, LocalSttWorkerRequest } from './workerProtocol'

interface Pending {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

/**
 * The loaded model holds WebAssembly memory that is only returned when the worker ends, so the
 * worker is shut down when dictation has been idle for a while. Loading it again takes about a second.
 */
const IDLE_DISPOSE_MS = 30_000

/** One worker at a time, for the model that was used last. */
let worker: { modelId: LocalSttModelId; worker: Worker } | null = null
let lastRequestId = 0
let activeTranscriptions = 0
let idleTimer: ReturnType<typeof setTimeout> | null = null
const pending = new Map<number, Pending>()

function failAll(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function createWorker(model: LocalSttModel): Worker {
  return model.runtime === 'nemo-transducer'
    ? new Worker(new URL('./parakeetWorker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('./moonshineWorker.ts', import.meta.url), { type: 'module' })
}

function ensureWorker(model: LocalSttModel): Worker {
  if (worker?.modelId === model.id) return worker.worker
  disposeLocalEngine()
  const created = createWorker(model)
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
  worker = { modelId: model.id, worker: created }
  return created
}

function cancelIdleDispose(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleDispose(): void {
  cancelIdleDispose()
  idleTimer = setTimeout(() => {
    idleTimer = null
    if (activeTranscriptions === 0) disposeLocalEngine()
  }, IDLE_DISPOSE_MS)
}

/** Drops the loaded model, e.g. after its files were deleted or when it has been idle. */
export function disposeLocalEngine(): void {
  cancelIdleDispose()
  worker?.worker.terminate()
  worker = null
  failAll(new Error('The local speech engine was stopped'))
}

function transcribeSegment(model: LocalSttModel, samples: Float32Array): Promise<string> {
  return new Promise((resolve, reject) => {
    // Before the request is registered: switching models stops the old worker and fails its requests.
    const target = ensureWorker(model)
    const id = ++lastRequestId
    pending.set(id, { resolve, reject })
    // Copy: segments are views of one large buffer, and transferring would detach all of it.
    const copy = samples.slice()
    const request: LocalSttWorkerRequest = { type: 'transcribe', id, samples: copy }
    target.postMessage(request, [copy.buffer])
  })
}

/** Transcribes a recording with a local model, one segment at a time. */
export async function transcribeWithLocalModel(modelId: LocalSttModelId, recording: Blob): Promise<string> {
  const model = findLocalSttModel(modelId)
  if (!model) throw new Error(`Unknown local dictation model: ${modelId}`)
  cancelIdleDispose()
  activeTranscriptions++
  try {
    const samples = await decodeRecording(recording, model.sampleRate)
    const minSamples = Math.ceil(MIN_SEGMENT_SECONDS * model.sampleRate)
    const parts: string[] = []
    for (const segment of splitIntoSegments(samples, model.sampleRate, model.maxSegmentSeconds)) {
      if (segment.length < minSamples) continue
      const text = await transcribeSegment(model, segment)
      if (text) parts.push(text)
    }
    return parts.join(' ')
  } finally {
    activeTranscriptions--
    if (activeTranscriptions === 0) scheduleIdleDispose()
  }
}
