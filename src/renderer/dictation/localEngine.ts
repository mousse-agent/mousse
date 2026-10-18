import { MOONSHINE_BASE } from '../../shared/dictation'
import { serveModelFiles } from '../speechModels/pageSupport'
import { MIN_SEGMENT_SECONDS, decodeRecording, splitIntoSegments } from './audio'
import type { MoonshineWorkerEvent, MoonshineWorkerRequest } from './moonshineWorker'

interface Pending {
  resolve: (text: string) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let lastRequestId = 0
const pending = new Map<number, Pending>()

function failAll(error: Error): void {
  for (const request of pending.values()) request.reject(error)
  pending.clear()
}

function ensureWorker(): Worker {
  if (worker) return worker
  const created = new Worker(new URL('./moonshineWorker.ts', import.meta.url), { type: 'module' })
  serveModelFiles(created, (path) => window.mousse.dictation.readLocalModelFile(MOONSHINE_BASE.id, path))
  created.addEventListener('message', (event: MessageEvent<MoonshineWorkerEvent>) => {
    const message = event.data
    if (message.type !== 'result' && message.type !== 'error') return
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.type === 'result') request.resolve(message.text)
    else request.reject(new Error(message.message))
  })
  created.addEventListener('error', (event) => {
    if (worker === created) worker = null
    created.terminate()
    failAll(new Error(event.message || 'The local speech engine stopped unexpectedly'))
  })
  worker = created
  return created
}

/** Drops the loaded model, e.g. after its files were deleted. */
export function disposeLocalEngine(): void {
  worker?.terminate()
  worker = null
  failAll(new Error('The local speech engine was stopped'))
}

function transcribeSegment(samples: Float32Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = ++lastRequestId
    pending.set(id, { resolve, reject })
    // Copy: segments are views of one large buffer, and transferring would detach all of it.
    const copy = samples.slice()
    const request: MoonshineWorkerRequest = { type: 'transcribe', id, samples: copy }
    ensureWorker().postMessage(request, [copy.buffer])
  })
}

/** Transcribes a recording with the local Moonshine model, one segment at a time. */
export async function transcribeWithLocalModel(recording: Blob): Promise<string> {
  const samples = await decodeRecording(recording, MOONSHINE_BASE.sampleRate)
  const minSamples = Math.ceil(MIN_SEGMENT_SECONDS * MOONSHINE_BASE.sampleRate)
  const parts: string[] = []
  for (const segment of splitIntoSegments(samples, MOONSHINE_BASE.sampleRate, MOONSHINE_BASE.maxSegmentSeconds)) {
    if (segment.length < minSamples) continue
    const text = await transcribeSegment(segment)
    if (text) parts.push(text)
  }
  return parts.join(' ')
}
