/**
 * Speeds speech up or slows it down without changing its pitch, by waveform-similarity overlap-add
 * (WSOLA): short Hann-windowed frames are taken from the input at a different pace than they are
 * laid down in the output, and each frame is shifted a little to the place where it continues the
 * previous one most smoothly. Used for models that have no speed control of their own.
 */

/** Frame length and the largest shift searched for a better join, in seconds. */
const FRAME_SECONDS = 0.03
const SEARCH_SECONDS = 0.012

/** `samples` played `speed` times as fast (`speed` above 1 shortens it), at the same pitch. */
export function stretchSpeech(samples: Float32Array, sampleRate: number, speed: number): Float32Array {
  if (!(speed > 0) || Math.abs(speed - 1) < 0.01) return samples
  const frame = Math.max(16, 2 * Math.round((FRAME_SECONDS * sampleRate) / 2))
  const half = frame / 2
  const search = Math.round(SEARCH_SECONDS * sampleRate)
  if (samples.length < frame + 2 * search) return samples

  const window = Float32Array.from({ length: frame }, (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * (index + 0.5)) / frame))
  const outLength = Math.floor(samples.length / speed)
  const out = new Float32Array(outLength + frame)
  const weight = new Float32Array(outLength + frame)

  // The first frame is copied as it is; each later one is placed `half` after the one before it.
  let previous = 0
  let outPosition = 0
  for (let index = 0; outPosition < outLength; index += 1) {
    let start = previous
    if (index > 0) {
      const wanted = Math.round(index * half * speed)
      // What the previous frame would have played next, to be matched over the overlap.
      const reference = previous + half
      let bestScore = -Infinity
      start = Math.min(Math.max(wanted, 0), samples.length - frame)
      for (let candidate = Math.max(0, wanted - search); candidate <= Math.min(samples.length - frame, wanted + search); candidate += 1) {
        let score = 0
        for (let offset = 0; offset < half; offset += 2) score += samples[candidate + offset] * samples[reference + offset]
        if (score > bestScore) {
          bestScore = score
          start = candidate
        }
      }
    }
    for (let offset = 0; offset < frame && start + offset < samples.length; offset += 1) {
      out[outPosition + offset] += samples[start + offset] * window[offset]
      weight[outPosition + offset] += window[offset]
    }
    previous = start
    outPosition += half
  }
  const result = new Float32Array(outLength)
  for (let index = 0; index < outLength; index += 1) result[index] = weight[index] > 1e-3 ? out[index] / weight[index] : out[index]
  return result
}
