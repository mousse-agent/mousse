import { PROVIDER_TTS_MAX_CHARS, type ProviderSpeechResult } from '../../shared/readAloud'
import type { SpeakOptions } from './playback'
import { createLevelMeter } from '../speech/audioLevels'
import { splitSpeechChunks } from './speechText'

export type { SpeakOptions } from './playback'

type Synthesize = (text: string) => Promise<ProviderSpeechResult>

function playAudio(
  result: ProviderSpeechResult,
  { signal, speed, pause }: SpeakOptions,
  output: { context: AudioContext; node: AudioNode },
  onStart: () => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve()
    const url = URL.createObjectURL(
      new Blob([result.audio as Uint8Array<ArrayBuffer>], { type: result.mimeType })
    )
    const audio = new Audio(url)
    // The element keeps the pitch while it changes the pace.
    audio.preservesPitch = true
    audio.playbackRate = speed()
    // The element plays through the level meter, so the wave follows what is heard.
    output.context.createMediaElementSource(audio).connect(output.node)
    let unsubscribe = (): void => undefined
    const finish = (error?: Error): void => {
      unsubscribe()
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
    const play = (): void => {
      audio
        .play()
        .then(onStart, (error: unknown) =>
          finish(error instanceof Error ? error : new Error(String(error)))
        )
    }
    signal.addEventListener('abort', onAbort)
    audio.onended = () => finish()
    audio.onerror = () =>
      finish(new Error('The audio returned by the provider could not be played'))
    unsubscribe = pause.subscribe((paused) => {
      if (paused) audio.pause()
      else play()
    })
    if (!pause.paused) play()
  })
}

/** Plays `chunks` in order, requesting the next one while the current one plays. */
export async function playChunks(
  chunks: readonly string[],
  synthesize: Synthesize,
  options: SpeakOptions
): Promise<void> {
  const { signal, onPlaying } = options
  const request = (index: number): Promise<ProviderSpeechResult> | null => {
    if (index >= chunks.length) return null
    const pending = synthesize(chunks[index])
    pending.catch(() => undefined)
    return pending
  }
  let started = false
  const context = new AudioContext()
  const meter = createLevelMeter(context)
  meter.analyser.connect(context.destination)
  options.onLevels(meter.levels)
  try {
    await playAll()
  } finally {
    void context.close().catch(() => undefined)
  }

  async function playAll(): Promise<void> {
    let current = request(0)
    for (let index = 0; current; index += 1) {
      const result = await Promise.race([
        current,
        new Promise<null>((resolve) =>
          signal.addEventListener('abort', () => resolve(null), { once: true })
        )
      ])
      if (!result || signal.aborted) return
      current = request(index + 1)
      await options.pause.whenPlaying(signal)
      await playAudio(result, options, { context, node: meter.analyser }, () => {
        if (started) return
        started = true
        onPlaying()
      })
      if (signal.aborted) return
    }
  }
}

export function speakWithProvider(
  providerId: string,
  modelId: string,
  text: string,
  options: SpeakOptions
): Promise<void> {
  return playChunks(
    splitSpeechChunks(text, PROVIDER_TTS_MAX_CHARS),
    (chunk) =>
      window.mousse.readAloud.synthesizeWithProvider({
        providerId,
        modelId,
        text: chunk,
        voice: options.voice
      }),
    options
  )
}
