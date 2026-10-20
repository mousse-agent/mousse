/**
 * Audio preparation for local dictation: recordings are decoded, mixed down to mono, resampled to
 * the rate the model expects and cut into pieces the model can take in one pass. The math helpers
 * are pure; `decodeRecording` needs the Web Audio API.
 */

/** Longest stretch at the end of a segment searched for a quiet place to cut. */
export const CUT_SEARCH_SECONDS = 3
/** Length of the quiet window the cut is placed in. */
export const CUT_WINDOW_SECONDS = 0.1
/** Segments shorter than this carry no speech worth transcribing. */
export const MIN_SEGMENT_SECONDS = 0.1

/** Averages all channels into one. A single channel is returned as is. */
export function downmixToMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0)
  if (channels.length === 1) return channels[0]
  const length = Math.min(...channels.map((channel) => channel.length))
  const mono = new Float32Array(length)
  for (const channel of channels) {
    for (let index = 0; index < length; index += 1) mono[index] += channel[index]
  }
  const scale = 1 / channels.length
  for (let index = 0; index < length; index += 1) mono[index] *= scale
  return mono
}

/**
 * Start of the quietest `windowSamples`-long window that fits in `[from, to)`, returned as the
 * sample index to cut at (the middle of that window). Later windows win ties so segments stay long.
 */
export function findQuietCut(samples: Float32Array, from: number, to: number, windowSamples: number): number {
  const size = Math.max(1, Math.min(windowSamples, to - from))
  const energy = new Float64Array(to - from + 1)
  for (let index = from; index < to; index += 1) energy[index - from + 1] = energy[index - from] + samples[index] * samples[index]
  const step = Math.max(1, Math.floor(size / 4))
  let bestStart = to - size
  let bestEnergy = Number.POSITIVE_INFINITY
  for (let start = from; start + size <= to; start += step) {
    const total = energy[start - from + size] - energy[start - from]
    if (total <= bestEnergy) {
      bestEnergy = total
      bestStart = start
    }
  }
  // The final window may fall between steps.
  const tail = energy[to - from] - energy[to - from - size]
  if (tail <= bestEnergy) bestStart = to - size
  return bestStart + Math.floor(size / 2)
}

/**
 * Splits `samples` into consecutive pieces of at most `maxSeconds`. Each cut goes at the quietest
 * 100 ms window within the last three seconds of its piece, so words are rarely split. The pieces
 * are views of `samples` and together cover every sample.
 */
export function splitIntoSegments(samples: Float32Array, sampleRate: number, maxSeconds: number): Float32Array[] {
  const maxSamples = Math.max(1, Math.floor(maxSeconds * sampleRate))
  const searchSamples = Math.min(Math.floor(CUT_SEARCH_SECONDS * sampleRate), Math.floor(maxSamples / 2))
  const windowSamples = Math.max(1, Math.floor(CUT_WINDOW_SECONDS * sampleRate))
  const segments: Float32Array[] = []
  let start = 0
  while (samples.length - start > maxSamples) {
    const end = start + maxSamples
    const cut = searchSamples > 0 ? findQuietCut(samples, end - searchSamples, end, windowSamples) : end
    segments.push(samples.subarray(start, cut))
    start = cut
  }
  if (start < samples.length) segments.push(samples.subarray(start))
  return segments
}

/** Decodes a recorded Blob into mono PCM at `targetRate`. */
export async function decodeRecording(blob: Blob, targetRate: number): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer()
  const context = new AudioContext()
  let decoded: AudioBuffer
  try {
    decoded = await context.decodeAudioData(bytes)
  } catch (error) {
    throw new Error('The recording could not be decoded', { cause: error })
  } finally {
    void context.close().catch(() => undefined)
  }
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index))
  const mono = downmixToMono(channels)
  if (decoded.sampleRate === targetRate || mono.length === 0) return mono
  const length = Math.max(1, Math.ceil((mono.length * targetRate) / decoded.sampleRate))
  const offline = new OfflineAudioContext(1, length, targetRate)
  const buffer = offline.createBuffer(1, mono.length, decoded.sampleRate)
  buffer.copyToChannel(mono as Float32Array<ArrayBuffer>, 0)
  const source = offline.createBufferSource()
  source.buffer = buffer
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  return rendered.getChannelData(0).slice()
}
