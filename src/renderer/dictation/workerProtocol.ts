import type { ModelFileRequest, ModelFileResponse } from '../speechModels/workerSupport'

/**
 * Messages from the page to a local speech-to-text worker. `init` comes first and names the model
 * the worker serves; a worker never switches models. `warm` loads the model ahead of the first
 * `transcribe` and is answered with an empty `result`.
 */
export type LocalSttWorkerRequest =
  | { type: 'init'; modelId: string }
  | { type: 'warm'; id: number }
  | { type: 'transcribe'; id: number; samples: Float32Array }
  | ModelFileResponse

/** Messages from a local speech-to-text worker to the page. */
export type LocalSttWorkerEvent =
  | ModelFileRequest
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }
