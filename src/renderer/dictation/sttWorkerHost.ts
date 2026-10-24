import type { LocalSttModel } from '../../shared/dictation'
import { setupLocalModelWorker } from '../speechModels/workerSupport'
import { resolveWorkerModel } from './workerModel'
import type { LocalSttWorkerEvent, LocalSttWorkerRequest } from './workerProtocol'

/**
 * Message handling shared by the local speech-to-text workers. The page's `init` message names the
 * model; the host checks it belongs to this worker's runtime, points the ONNX runtime and file
 * requests at the downloaded copy, and asks the worker for its `transcribe` function. Transcriptions
 * then run one at a time, and a failure of any step is answered on the request that needed it.
 */
export function serveSttWorker<Runtime extends LocalSttModel['runtime']>(
  runtimes: readonly Runtime[],
  start: (model: Extract<LocalSttModel, { runtime: Runtime }>) => (samples: Float32Array) => Promise<string>
): void {
  const post = (event: LocalSttWorkerEvent): void => {
    ;(self as unknown as Worker).postMessage(event)
  }

  let transcribe: ((samples: Float32Array) => Promise<string>) | null = null
  let handleFileResponse: ((message: { type: string }) => boolean) | null = null
  let startError: Error = new Error('The speech engine was not started with a model')
  let queue: Promise<void> = Promise.resolve()

  const init = (modelId: string): void => {
    try {
      const model = resolveWorkerModel(modelId, runtimes)
      // Also points onnxruntime-web, which transformers.js shares, at the bundled WebAssembly files.
      handleFileResponse = setupLocalModelWorker({ repo: model.repo, files: model.files, post }).handleMessage
      transcribe = start(model)
    } catch (error) {
      startError = error instanceof Error ? error : new Error(String(error))
    }
  }

  const run = async (id: number, samples: Float32Array): Promise<void> => {
    try {
      if (!transcribe) throw startError
      post({ type: 'result', id, text: (await transcribe(samples)).trim() })
    } catch (error) {
      post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
    }
  }

  self.addEventListener('message', (event: MessageEvent<LocalSttWorkerRequest>) => {
    const message = event.data
    if (message.type === 'init') init(message.modelId)
    else if (message.type === 'transcribe') queue = queue.then(() => run(message.id, message.samples))
    else handleFileResponse?.(message)
  })
}
