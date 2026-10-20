import { KOKORO_82M } from '../../shared/readAloud'
import { setupLocalModelWorker, type ModelFileRequest, type ModelFileResponse } from '../speechModels/workerSupport'

/** Messages from the page to the worker. */
export type KokoroWorkerRequest =
  | { type: 'speak'; id: number; text: string; voice: string; speed: number }
  | { type: 'cancel'; id: number }
  | ModelFileResponse

/** Messages from the worker to the page. */
export type KokoroWorkerEvent =
  | ModelFileRequest
  | { type: 'audio'; id: number; samples: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string }

type KokoroModule = typeof import('kokoro-js')
type KokoroInstance = Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>
type KokoroVoice = NonNullable<Parameters<KokoroInstance['generate']>[1]>['voice']

const post = (event: KokoroWorkerEvent, transfer: Transferable[] = []): void => {
  ;(self as unknown as Worker).postMessage(event, transfer)
}

const support = setupLocalModelWorker({ repo: KOKORO_82M.repo, files: KOKORO_82M.files, post })

// kokoro-js keeps a copy of each voice file in Cache Storage. This cache keeps nothing, so the
// app's verified download stays the only copy and deleting the model removes every voice.
const noCache = { match: async () => undefined, put: async () => undefined }
Object.defineProperty(self, 'caches', { configurable: true, value: { open: async () => noCache } })

let kokoro: Promise<KokoroInstance> | null = null

function loadKokoro(): Promise<KokoroInstance> {
  if (!kokoro) {
    const loading = import('kokoro-js').then((module) =>
      module.KokoroTTS.from_pretrained(KOKORO_82M.repo, { dtype: KOKORO_82M.dtype, device: 'wasm' })
    )
    loading.catch(() => {
      if (kokoro === loading) kokoro = null
    })
    kokoro = loading
  }
  return kokoro
}

const cancelled = new Set<number>()
let queue: Promise<void> = Promise.resolve()

/** Voices one segment in a single pass, which keeps Kokoro's own short pauses between its sentences. */
async function speak(id: number, text: string, voice: string, speed: number): Promise<void> {
  try {
    if (cancelled.has(id)) return
    const tts = await loadKokoro()
    if (cancelled.has(id)) return
    const known = KOKORO_82M.voices.some((entry) => entry.id === voice)
    const audio = await tts.generate(text, { voice: (known ? voice : KOKORO_82M.defaultVoice) as KokoroVoice, speed })
    if (cancelled.has(id)) return
    const samples = audio.audio
    post({ type: 'audio', id, samples, sampleRate: audio.sampling_rate }, [samples.buffer])
  } catch (error) {
    if (!cancelled.has(id)) post({ type: 'error', id, message: error instanceof Error ? error.message : String(error) })
  } finally {
    cancelled.delete(id)
  }
}

self.addEventListener('message', (event: MessageEvent<KokoroWorkerRequest>) => {
  const message = event.data
  if (support.handleMessage(message)) return
  if (message.type === 'speak') {
    queue = queue.then(() => speak(message.id, message.text, message.voice, message.speed))
  } else if (message.type === 'cancel') {
    cancelled.add(message.id)
  }
})
