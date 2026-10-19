import type { ModelFileRequest, ModelFileResponse } from '../speechModels/workerSupport'

/** Messages from the page to a local speech-to-text worker. */
export type LocalSttWorkerRequest = { type: 'transcribe'; id: number; samples: Float32Array } | ModelFileResponse

/** Messages from a local speech-to-text worker to the page. */
export type LocalSttWorkerEvent =
  | ModelFileRequest
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string }
