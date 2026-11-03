import * as ort from 'onnxruntime-web'
import { localModelFileUrl } from '../../shared/localModels'
import { loadNemoRecognizer, recognizeNemo, type NemoRecognizer } from './nemoRecognizer'
import { serveSttWorker } from './sttWorkerHost'

/** One second of a faint tone, quieter than any speech the model would transcribe. */
function warmUpAudio(sampleRate: number): Float32Array {
  return Float32Array.from({ length: sampleRate }, (_, index) => 0.001 * Math.sin(index * 0.3))
}

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

  return {
    // One pass over a second of near-silence after loading: the first run of each ONNX session
    // allocates its buffers, and on silence the decoder emits only blanks, so the pass is short.
    warm: async () => {
      const recognizer = await load()
      await recognizeNemo(recognizer, warmUpAudio(model.sampleRate))
    },
    transcribe: async (samples, vocabulary) => recognizeNemo(await load(), samples, vocabulary)
  }
})
