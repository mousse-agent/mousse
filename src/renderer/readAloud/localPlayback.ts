/**
 * Timing for local read aloud. The local models pad every clip with silence (Kokoro about 0.3 s
 * before the speech and 0.45 s after it; Kitten, Supertonic and Pocket 0.3 to 0.6 s on each side),
 * which sounds like a long pause wherever two clips meet. Clips are trimmed to the speech and
 * joined with a short gap, close to the pause Kokoro leaves between sentences inside one clip. The
 * pure helpers here are tested without audio.
 */

/** Samples quieter than this count as silence. Kokoro's padding stays far below it. */
export const SILENCE_THRESHOLD = 0.005
/** Silence kept before the first and after the last loud sample, so onsets and decays stay whole. */
export const LEAD_SECONDS = 0.02
export const TRAIL_SECONDS = 0.06
/** Pause added between two clips. */
export const CLIP_GAP_SECONDS = 0.1
/** Longest wait for synthesis to get ahead before the first clip plays anyway. */
export const MAX_START_DELAY_SECONDS = 5

/** Returns the part of `samples` that holds speech, with a little silence kept on each side. */
export function trimSilence(samples: Float32Array, sampleRate: number): Float32Array {
  let first = 0
  while (first < samples.length && Math.abs(samples[first]) < SILENCE_THRESHOLD) first += 1
  if (first === samples.length) return samples.subarray(0, 0)
  let last = samples.length - 1
  while (last > first && Math.abs(samples[last]) < SILENCE_THRESHOLD) last -= 1
  const start = Math.max(0, first - Math.round(LEAD_SECONDS * sampleRate))
  const end = Math.min(samples.length, last + 1 + Math.round(TRAIL_SECONDS * sampleRate))
  return samples.subarray(start, end)
}

/** What is known about one segment while the first one waits to play. Times are in seconds. */
export interface SegmentTiming {
  chars: number
  /** When a worker started voicing it. */
  startedAt?: number
  /** When its audio arrived, and how long that audio plays (gap included). */
  finishedAt?: number
  seconds?: number
}

/**
 * How long to hold back the first clip so that every later segment is ready before the one ahead
 * of it finishes playing. Synthesis speed and seconds per character are measured from the finished
 * segments; segments not started yet go to whichever of the `workers` frees first. Returns 0 when
 * nothing has finished yet, or when playing now leaves no gap.
 */
export function startDelaySeconds(segments: readonly SegmentTiming[], workers: number, now: number): number {
  let doneChars = 0
  let doneSeconds = 0
  let busySeconds = 0
  for (const segment of segments) {
    if (segment.finishedAt === undefined || segment.startedAt === undefined || segment.seconds === undefined) continue
    doneChars += segment.chars
    doneSeconds += segment.seconds
    busySeconds += segment.finishedAt - segment.startedAt
  }
  if (doneChars === 0 || doneSeconds === 0) return 0
  const secondsPerChar = doneSeconds / doneChars
  const workPerSecond = busySeconds / doneSeconds

  const free: number[] = []
  for (const segment of segments) {
    if (segment.startedAt !== undefined && segment.finishedAt === undefined) {
      free.push(segment.startedAt + segment.chars * secondsPerChar * workPerSecond)
    }
  }
  while (free.length < workers) free.push(now)

  let start = now
  let offset = 0
  for (const segment of segments) {
    const seconds = segment.seconds ?? segment.chars * secondsPerChar
    let ready: number
    if (segment.finishedAt !== undefined) {
      ready = segment.finishedAt
    } else if (segment.startedAt !== undefined) {
      ready = segment.startedAt + segment.chars * secondsPerChar * workPerSecond
    } else {
      free.sort((a, b) => a - b)
      ready = Math.max(now, free[0]) + seconds * workPerSecond
      free[0] = ready
    }
    start = Math.max(start, ready - offset)
    offset += seconds
  }
  return Math.max(0, start - now)
}
