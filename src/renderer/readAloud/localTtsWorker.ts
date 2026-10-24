import { findLocalTtsModel, type LocalTtsModel, type LocalTtsModelId } from '../../shared/readAloud'
import { localModelFileUrl } from '../../shared/localModels'
import { setupLocalModelWorker, type ModelFileRequest, type ModelFileResponse } from '../speechModels/workerSupport'

/**
 * What every local read aloud worker shares: the messages it exchanges with the page, and a host
 * that tells it which model to run, loads that model on first use, and voices requests one at a
 * time. Each model family (`runtime`) has its own worker file that supplies only `load`.
 */

/** Messages from the page to a worker. `init` comes first and names the model. */
export type LocalTtsWorkerRequest =
  | { type: 'init'; modelId: LocalTtsModelId }
  | { type: 'speak'; id: number; text: string; voice: string; speed: number }
  | { type: 'cancel'; id: number }
  | ModelFileResponse

/** Messages from a worker to the page. */
export type LocalTtsWorkerEvent =
  | ModelFileRequest
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string }

export interface TtsAudio {
  /** Mono samples in -1..1. */
  samples: Float32Array
  sampleRate: number
}

/** A loaded model. */
export interface TtsSynthesizer {
  /** Voices one segment of text. */
  synthesize: (text: string, voice: string, speed: number) => Promise<TtsAudio>
}

export interface TtsWorkerContext<Model extends LocalTtsModel> {
  model: Model
  /** The bytes of a file of the model, from the copy the app downloaded and verified. */
  readFile: (path: string) => Promise<Uint8Array>
}

export interface TtsWorkerOptions<Model extends LocalTtsModel> {
  /** True for the models this worker runs. */
  accepts: (model: LocalTtsModel) => model is Model
  load: (context: TtsWorkerContext<Model>) => Promise<TtsSynthesizer>
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Wires a dedicated worker's `self` to the model that `load` builds. */
export function runLocalTtsWorker<Model extends LocalTtsModel>({ accepts, load }: TtsWorkerOptions<Model>): void {
  const post = (event: LocalTtsWorkerEvent, transfer: Transferable[] = []): void => {
    ;(self as unknown as Worker).postMessage(event, transfer)
  }

  let model: Model | null = null
  let support: ReturnType<typeof setupLocalModelWorker> | null = null
  let synthesizer: Promise<TtsSynthesizer> | null = null

  const loadSynthesizer = (): Promise<TtsSynthesizer> => {
    if (!model) return Promise.reject(new Error('The voice model was not chosen'))
    if (!synthesizer) {
      const chosen = model
      const readFile = async (path: string): Promise<Uint8Array> => {
        const response = await fetch(localModelFileUrl(chosen, path))
        if (!response.ok) throw new Error(`${chosen.label} file ${path} is unavailable`)
        return new Uint8Array(await response.arrayBuffer())
      }
      const loading = load({ model: chosen, readFile })
      loading.catch(() => {
        if (synthesizer === loading) synthesizer = null
      })
      synthesizer = loading
    }
    return synthesizer
  }

  const cancelled = new Set<number>()
  let queue: Promise<void> = Promise.resolve()

  const speak = async (id: number, text: string, voice: string, speed: number): Promise<void> => {
    try {
      if (cancelled.has(id)) return
      const loaded = await loadSynthesizer()
      if (cancelled.has(id) || !model) return
      const known = model.voices.some((entry) => entry.id === voice)
      const audio = await loaded.synthesize(text, known ? voice : model.defaultVoice, speed)
      if (cancelled.has(id)) return
      post({ type: 'audio', id, samples: audio.samples, sampleRate: audio.sampleRate }, [audio.samples.buffer])
    } catch (error) {
      if (!cancelled.has(id)) post({ type: 'error', id, message: errorMessage(error) })
    } finally {
      cancelled.delete(id)
    }
  }

  self.addEventListener('message', (event: MessageEvent<LocalTtsWorkerRequest>) => {
    const message = event.data
    if (support?.handleMessage(message)) return
    if (message.type === 'init') {
      const chosen = findLocalTtsModel(message.modelId)
      if (!chosen || !accepts(chosen) || model) return
      model = chosen
      support = setupLocalModelWorker({ repo: chosen.repo, files: chosen.files, post })
    } else if (message.type === 'speak') {
      queue = queue.then(() => speak(message.id, message.text, message.voice, message.speed))
    } else if (message.type === 'cancel') {
      cancelled.add(message.id)
    }
  })
}
