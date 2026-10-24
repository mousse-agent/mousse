import { loadWhisper, transcribeWhisper, type WhisperParts } from './whisperRecognizer'
import { serveSttWorker } from './sttWorkerHost'

/** Serves the Whisper model named in the page's `init` message. */
serveSttWorker(['whisper'], (model) => {
  let loaded: Promise<WhisperParts> | null = null

  /** Loads the model on the first request and keeps it for the life of the worker. */
  const load = (): Promise<WhisperParts> => {
    if (!loaded) {
      const loading = loadWhisper(model)
      loading.catch(() => {
        if (loaded === loading) loaded = null
      })
      loaded = loading
    }
    return loaded
  }

  return async (samples) => transcribeWhisper(await load(), samples)
})
