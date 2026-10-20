import { pipeline } from '@huggingface/transformers'
import { MOONSHINE_BASE } from '../../shared/dictation'
import { setupLocalModelWorker, type ModelFileRequest, type ModelFileResponse } from '../speechModels/workerSupport'

/** Messages from the page to the worker. */
export type MoonshineWorkerRequest = { type: 'transcribe'; id: number; samples: Float32Array } | ModelFileResponse

/** Messages from the worker to the page. */
export type MoonshineWorkerEvent =
  | ModelFileRequest
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }

type Recognizer = (audio: Float32Array) => Promise<{ text: string } | Array<{ text: string }>>

const post = (event: MoonshineWorkerEvent): void => {
  ;(self as unknown as Worker).postMessage(event)
}

const support = setupLocalModelWorker({ repo: MOONSHINE_BASE.repo, files: MOONSHINE_BASE.files, post })

let recognizer: Promise<Recognizer> | null = null

/** Loads the model on the first request and keeps it for the life of the worker. */
function loadRecognizer(): Promise<Recognizer> {
  if (!recognizer) {
    const loading = pipeline('automatic-speech-recognition', MOONSHINE_BASE.repo, {
      dtype: MOONSHINE_BASE.dtype,
      device: 'wasm'
    }) as unknown as Promise<Recognizer>
    loading.catch(() => {
      if (recognizer === loading) recognizer = null
    })
    recognizer = loading
  }
  return recognizer
}

let queue: Promise<void> = Promise.resolve()

async function transcribe(id: number, samples: Float32Array): Promise<void> {
  try {
    const recognize = await loadRecognizer()
    const output = await recognize(samples)
    const text = Array.isArray(output) ? output.map((part) => part.text).join(' ') : output.text
    post({ type: 'result', id, text: text.trim() })
  } catch (error) {
    post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  }
}

self.addEventListener('message', (event: MessageEvent<MoonshineWorkerRequest>) => {
  const message = event.data
  if (support.handleMessage(message)) return
  if (message.type === 'transcribe') queue = queue.then(() => transcribe(message.id, message.samples))
})
