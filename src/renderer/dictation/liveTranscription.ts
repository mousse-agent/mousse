import { findLocalSttModel, type LocalSttModelId } from '../../shared/dictation'
import { joinTranscriptSegments } from '../../shared/dictationPostProcess'
import { MIN_SEGMENT_SECONDS } from './audio'
import { LIVE_CHUNKS, LiveChunker } from './liveChunker'
import { transcribeLocalSamples } from './localEngine'
import { capturePcm, type PcmCapture } from './pcmCapture'

/**
 * Local dictation that transcribes while the user speaks: the microphone's raw audio is cut into
 * pieces at pauses (`liveChunker.ts`) and each piece goes to the model as soon as it ends, so
 * stopping only waits for the audio since the last pause.
 */
export interface LiveTranscription {
  /**
   * Stops listening. `captured` settles once the audio up to the stop is in, after which the
   * microphone can be released; `text` is the whole transcript.
   */
  finish: () => { captured: Promise<void>; text: Promise<string> }
  /** Stops listening and drops the transcript. */
  cancel: () => void
}

export interface LiveTranscriptionOptions {
  /** Receives the text of the pieces done so far after each one. */
  onPartial?: (text: string) => void
  /** Tests replace the Web Audio capture. */
  capture?: typeof capturePcm
}

/** A piece whose loudest sample is below this holds no speech; it is not sent to the model. */
const SILENT_PEAK = 0.002

function isSilent(samples: Float32Array): boolean {
  for (let index = 0; index < samples.length; index += 1) {
    if (Math.abs(samples[index]) >= SILENT_PEAK) return false
  }
  return true
}

export async function startLiveTranscription(
  modelId: LocalSttModelId,
  stream: MediaStream,
  { onPartial, capture = capturePcm }: LiveTranscriptionOptions = {}
): Promise<LiveTranscription> {
  const model = findLocalSttModel(modelId)
  if (!model) throw new Error(`Unknown local dictation model: ${modelId}`)
  const chunker = new LiveChunker({ sampleRate: model.sampleRate, ...LIVE_CHUNKS })
  const minSamples = Math.ceil(MIN_SEGMENT_SECONDS * model.sampleRate)
  const parts: string[] = []
  let queue: Promise<void> = Promise.resolve()
  let failure: Error | null = null
  let listening = true
  let cancelled = false
  let recordedSamples = 0
  let pieces = 0

  /** Queues a piece; pieces are transcribed one at a time, in order. */
  const send = (piece: Float32Array): void => {
    if (piece.length < minSamples || isSilent(piece)) return
    pieces++
    queue = queue.then(async () => {
      if (cancelled || failure) return
      try {
        const text = await transcribeLocalSamples(model.id, piece)
        if (cancelled || !text) return
        parts.push(text)
        onPartial?.(joinTranscriptSegments(parts))
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
      }
    })
  }

  const pcm: PcmCapture = await capture(stream, model.sampleRate, (samples) => {
    if (!listening) return
    recordedSamples += samples.length
    for (const piece of chunker.push(samples)) send(piece)
  })

  return {
    finish: () => {
      const stopped = performance.now()
      const captured = pcm.flush().then(() => {
        listening = false
        pcm.close()
      })
      const text = captured.then(async () => {
        const tail = chunker.finish()
        send(tail)
        await queue
        if (failure) throw failure
        console.info(
          `[dictation] ${model.label} live: ${(recordedSamples / model.sampleRate).toFixed(1)} s of audio in ${pieces} piece(s), ` +
            `the last ${(tail.length / model.sampleRate).toFixed(1)} s done ${Math.round(performance.now() - stopped)} ms after the stop`
        )
        return joinTranscriptSegments(parts)
      })
      return { captured, text }
    },
    cancel: () => {
      listening = false
      cancelled = true
      pcm.close()
    }
  }
}
