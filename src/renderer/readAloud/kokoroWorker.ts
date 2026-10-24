import type { KokoroTtsModel } from '../../shared/readAloud'
import { runLocalTtsWorker, type TtsSynthesizer } from './localTtsWorker'

type KokoroModule = typeof import('kokoro-js')
type KokoroVoice = NonNullable<Parameters<Awaited<ReturnType<KokoroModule['KokoroTTS']['from_pretrained']>>['generate']>[1]>['voice']

// kokoro-js keeps a copy of each voice file in Cache Storage. This cache keeps nothing, so the
// app's verified download stays the only copy and deleting the model removes every voice.
const noCache = { match: async () => undefined, put: async () => undefined }
Object.defineProperty(self, 'caches', { configurable: true, value: { open: async () => noCache } })

/** Voices one segment in a single pass, which keeps Kokoro's own short pauses between its sentences. */
runLocalTtsWorker<KokoroTtsModel>({
  accepts: (model): model is KokoroTtsModel => model.runtime === 'kokoro',
  load: async ({ model }): Promise<TtsSynthesizer> => {
    const { KokoroTTS } = await import('kokoro-js')
    const tts = await KokoroTTS.from_pretrained(model.repo, { dtype: model.dtype, device: 'wasm' })
    return {
      synthesize: async (text, voice, speed) => {
        const audio = await tts.generate(text, { voice: voice as KokoroVoice, speed })
        return { samples: audio.audio, sampleRate: audio.sampling_rate }
      }
    }
  }
})
