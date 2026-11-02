import { CUT_SEARCH_SECONDS, CUT_WINDOW_SECONDS, findQuietCut } from './audio'

/**
 * Cuts audio that arrives while the user speaks into pieces a local model transcribes on its own,
 * so stopping only waits for the last piece. A piece ends at a pause once it holds `minSeconds`;
 * without a pause it ends at `maxSeconds`, at its quietest moment. Pure, so it runs in tests.
 */
export interface LiveChunkOptions {
  sampleRate: number
  /** Audio a piece holds before a pause may end it; shorter pieces lose context the model uses. */
  minSeconds: number
  /** Silence this long counts as a pause. */
  pauseSeconds: number
  /** Longest piece, cut even without a pause. */
  maxSeconds: number
}

/** The pieces dictation uses (issue #513). */
export const LIVE_CHUNKS = { minSeconds: 3, pauseSeconds: 0.3, maxSeconds: 12 } as const

/** Loudness is measured over windows this long. */
const FRAME_SECONDS = 0.02
/** A window quieter than this (RMS) is silence however quiet the speech is. */
const SILENCE_FLOOR = 0.003
/** A window this much quieter than the loudest one of the piece (-20 dB) is silence. */
const SILENCE_RATIO = 0.1

export class LiveChunker {
  private buffer: Float32Array
  private length = 0
  /** Loudness (RMS) of each complete window of the buffer. */
  private frames: number[] = []
  private loudest = 0
  private readonly frameSamples: number
  private readonly minFrames: number
  private readonly pauseFrames: number
  private readonly maxSamples: number

  constructor(private readonly options: LiveChunkOptions) {
    this.frameSamples = Math.max(1, Math.round(FRAME_SECONDS * options.sampleRate))
    this.minFrames = Math.ceil(options.minSeconds / FRAME_SECONDS)
    this.pauseFrames = Math.max(1, Math.ceil(options.pauseSeconds / FRAME_SECONDS))
    this.maxSamples = Math.max(1, Math.floor(options.maxSeconds * options.sampleRate))
    this.buffer = new Float32Array(this.maxSamples * 2)
  }

  /** Audio held that has not been handed out yet. */
  get pendingSamples(): number {
    return this.length
  }

  /** Adds audio; returns the pieces it completes, oldest first. */
  push(samples: Float32Array): Float32Array[] {
    const pieces: Float32Array[] = []
    let offset = 0
    while (offset < samples.length) {
      // Never hold more than one longest piece, so the buffer never grows.
      const room = this.maxSamples - this.length
      const take = Math.min(room, samples.length - offset)
      this.append(samples.subarray(offset, offset + take))
      offset += take
      for (let piece = this.nextPiece(); piece; piece = this.nextPiece()) pieces.push(piece)
    }
    return pieces
  }

  /** Hands out everything left, for when the recording ends. */
  finish(): Float32Array {
    const rest = this.buffer.slice(0, this.length)
    this.length = 0
    this.frames = []
    this.loudest = 0
    return rest
  }

  private append(samples: Float32Array): void {
    this.buffer.set(samples, this.length)
    this.length += samples.length
    this.measureFrames()
  }

  private measureFrames(): void {
    for (let frame = this.frames.length; (frame + 1) * this.frameSamples <= this.length; frame += 1) {
      let energy = 0
      for (let index = frame * this.frameSamples; index < (frame + 1) * this.frameSamples; index += 1) {
        energy += this.buffer[index] * this.buffer[index]
      }
      const rms = Math.sqrt(energy / this.frameSamples)
      this.frames.push(rms)
      if (rms > this.loudest) this.loudest = rms
    }
  }

  private nextPiece(): Float32Array | null {
    const cut = this.pauseCut() ?? (this.length >= this.maxSamples ? this.forcedCut() : null)
    if (cut === null) return null
    const piece = this.buffer.slice(0, cut)
    this.buffer.copyWithin(0, cut, this.length)
    this.length -= cut
    this.frames = []
    this.loudest = 0
    this.measureFrames()
    return piece
  }

  /** The middle of the first pause that ends a piece of at least `minSeconds`, if there is one. */
  private pauseCut(): number | null {
    if (this.frames.length < this.minFrames) return null
    // A piece of nothing but silence is left to grow: there is no speech to send yet.
    if (this.loudest <= SILENCE_FLOOR) return null
    const silence = Math.max(SILENCE_FLOOR, this.loudest * SILENCE_RATIO)
    let quiet = 0
    for (let frame = 0; frame < this.frames.length; frame += 1) {
      quiet = this.frames[frame] < silence ? quiet + 1 : 0
      if (quiet < this.pauseFrames) continue
      const middle = frame + 1 - Math.ceil(this.pauseFrames / 2)
      if (middle >= this.minFrames) return middle * this.frameSamples
    }
    return null
  }

  /** The quietest moment in the last seconds of a piece that reached `maxSeconds`. */
  private forcedCut(): number {
    const search = Math.min(Math.floor(CUT_SEARCH_SECONDS * this.options.sampleRate), Math.floor(this.maxSamples / 2))
    const window = Math.max(1, Math.floor(CUT_WINDOW_SECONDS * this.options.sampleRate))
    return findQuietCut(this.buffer, this.maxSamples - search, this.maxSamples, window)
  }
}
