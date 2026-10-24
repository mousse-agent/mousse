import * as ort from 'onnxruntime-web'
import { localModelFileUrl } from '../../shared/localModels'
import { loadNemoRecognizer, recognizeNemo, type NemoRecognizer } from './nemoRecognizer'
import { serveSttWorker } from './sttWorkerHost'

/** Serves the Parakeet (NeMo transducer) model named in the page's `init` message. */
serveSttWorker(['nemo-transducer'], (model) => {
  let recognizer: Promise<NemoRecognizer> | null = null

  const readModelFile = async (path: string): Promise<Uint8Array> => {
    const response = await fetch(localModelFileUrl(model, path))
    if (!response.ok) throw new Error(`${model.label} file ${path} is unavailable`)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** Loads the model on the first request and keeps it for the life of the worker. */
  const load = (): Promise<NemoRecognizer> => {
    if (!recognizer) {
      const loading = loadNemoRecognizer(model, ort, readModelFile)
      loading.catch(() => {
        if (recognizer === loading) recognizer = null
      })
      recognizer = loading
    }
    return recognizer
  }

  return async (samples) => recognizeNemo(await load(), samples)
})
