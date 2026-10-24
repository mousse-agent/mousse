import { pipeline } from '@huggingface/transformers'
import { serveSttWorker } from './sttWorkerHost'

type Recognizer = (audio: Float32Array) => Promise<{ text: string } | Array<{ text: string }>>

/** Serves the Moonshine model named in the page's `init` message. */
serveSttWorker(['moonshine'], (model) => {
  let recognizer: Promise<Recognizer> | null = null

  /** Loads the model on the first request and keeps it for the life of the worker. */
  const load = (): Promise<Recognizer> => {
    if (!recognizer) {
      const loading = pipeline('automatic-speech-recognition', model.repo, {
        dtype: model.dtype,
        device: 'wasm'
      }) as unknown as Promise<Recognizer>
      loading.catch(() => {
        if (recognizer === loading) recognizer = null
      })
      recognizer = loading
    }
    return recognizer
  }

  return async (samples) => {
    const output = await (await load())(samples)
    return Array.isArray(output) ? output.map((part) => part.text).join(' ') : output.text
  }
})
