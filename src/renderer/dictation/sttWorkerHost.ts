import type { LocalSttModel } from '../../shared/dictation'
import type { DictationVocabularyTerm } from '../../shared/dictationVocabulary'
import { speechModelThreads } from '../speechModels/threads'
import { setupLocalModelWorker } from '../speechModels/workerSupport'
import { resolveWorkerModel } from './workerModel'
import type { LocalSttWorkerEvent, LocalSttWorkerRequest } from './workerProtocol'

/** What a speech-to-text worker does with its model. */
export interface SttEngine {
  /** Loads the model, and may run it once so the first real transcription starts quickly. */
  warm: () => Promise<void>
  /** `vocabulary` is the user's terms; models that cannot use it ignore it. */
  transcribe: (samples: Float32Array, vocabulary: readonly DictationVocabularyTerm[]) => Promise<string>
}

/**
 * Message handling shared by the local speech-to-text workers. The page's `init` message names the
 * model; the host checks it belongs to this worker's runtime, points the ONNX runtime and file
 * requests at the downloaded copy, and asks the worker for its engine. Warm-ups and transcriptions
 * then run one at a time, and a failure of any step is answered on the request that needed it.
 */
export function serveSttWorker<Runtime extends LocalSttModel['runtime']>(
  runtimes: readonly Runtime[],
  start: (model: Extract<LocalSttModel, { runtime: Runtime }>) => SttEngine
): void {
  const post = (event: LocalSttWorkerEvent): void => {
    ;(self as unknown as Worker).postMessage(event)
  }

  let engine: SttEngine | null = null
  let handleFileResponse: ((message: { type: string }) => boolean) | null = null
  let startError: Error = new Error('The speech engine was not started with a model')
  let queue: Promise<void> = Promise.resolve()

  const init = (modelId: string): void => {
    try {
      const model = resolveWorkerModel(modelId, runtimes)
      // Also points onnxruntime-web, which transformers.js shares, at the bundled WebAssembly files,
      // with as many threads as the window allows (see `enableBlinkFeatures` in src/main/index.ts).
      const threads = speechModelThreads(navigator.hardwareConcurrency, typeof SharedArrayBuffer === 'function')
      handleFileResponse = setupLocalModelWorker({ repo: model.repo, files: model.files, post, threads }).handleMessage
      engine = start(model)
    } catch (error) {
      startError = error instanceof Error ? error : new Error(String(error))
    }
  }

  const run = async (id: number, work: (engine: SttEngine) => Promise<string>): Promise<void> => {
    try {
      if (!engine) throw startError
      post({ type: 'result', id, text: (await work(engine)).trim() })
    } catch (error) {
      post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
    }
  }

  self.addEventListener('message', (event: MessageEvent<LocalSttWorkerRequest>) => {
    const message = event.data
    if (message.type === 'init') init(message.modelId)
    else if (message.type === 'warm') {
      queue = queue.then(() =>
        run(message.id, async (ready) => {
          await ready.warm()
          return ''
        })
      )
    }
    else if (message.type === 'transcribe') queue = queue.then(() => run(message.id, (ready) => ready.transcribe(message.samples, message.vocabulary ?? [])))
    else handleFileResponse?.(message)
  })
}
