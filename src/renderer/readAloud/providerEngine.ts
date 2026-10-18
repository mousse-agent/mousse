import { PROVIDER_TTS_MAX_CHARS, type ProviderSpeechResult } from '../../shared/readAloud'
import { splitSpeechChunks } from './speechText'

export interface SpeakOptions {
  signal: AbortSignal
  /** Called once when audio starts coming out of the speakers. */
  onPlaying: () => void
}

type Synthesize = (text: string) => Promise<ProviderSpeechResult>

function playAudio(result: ProviderSpeechResult, signal: AbortSignal, onStart: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve()
    const url = URL.createObjectURL(new Blob([result.audio as Uint8Array<ArrayBuffer>], { type: result.mimeType }))
    const audio = new Audio(url)
    const finish = (error?: Error): void => {
      signal.removeEventListener('abort', onAbort)
      audio.onended = null
      audio.onerror = null
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      URL.revokeObjectURL(url)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = (): void => finish()
    signal.addEventListener('abort', onAbort)
    audio.onended = () => finish()
    audio.onerror = () => finish(new Error('The audio returned by the provider could not be played'))
    audio.play().then(onStart, (error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}

/** Plays `chunks` in order, requesting the next one while the current one plays. */
export async function playChunks(
  chunks: readonly string[],
  synthesize: Synthesize,
  { signal, onPlaying }: SpeakOptions
): Promise<void> {
  const request = (index: number): Promise<ProviderSpeechResult> | null => {
    if (index >= chunks.length) return null
    const pending = synthesize(chunks[index])
    pending.catch(() => undefined)
    return pending
  }
  let started = false
  let current = request(0)
  for (let index = 0; current; index += 1) {
    const result = await Promise.race([
      current,
      new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }))
    ])
    if (!result || signal.aborted) return
    current = request(index + 1)
    await playAudio(result, signal, () => {
      if (started) return
      started = true
      onPlaying()
    })
    if (signal.aborted) return
  }
}

export function speakWithProvider(providerId: string, modelId: string, text: string, options: SpeakOptions): Promise<void> {
  return playChunks(
    splitSpeechChunks(text, PROVIDER_TTS_MAX_CHARS),
    (chunk) => window.mousse.readAloud.synthesizeWithProvider({ providerId, modelId, text: chunk }),
    options
  )
}
